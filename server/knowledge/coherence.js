// Phase 14.5 — the Coherence Monitor.
//
// After the council produces a draft, this compares the draft against the
// beliefs the system already holds. A contradiction is NOT an error and NOT a
// silent overwrite: it is a measurable transition, recorded with both claims,
// their lineage, and the confidence delta it caused.
//
// Two halves, deliberately split:
//   * coherenceMonitorAgent — DETECTS. Runs before the Critic so the Critic and
//     the Governor see the report as data they can act on. Writes nothing.
//   * persistCoherence — RECORDS. Runs after the Governor's verdict, in the
//     post-response batch, inside one transaction. A vetoed draft is never
//     projected into the belief store: the report is stored with
//     draft_shipped = false and the only transition written is veto_raised.
//
// This is a subsystem the council consults. It is registered as a pipeline
// stage, not as a council operator — the six seats stay six.

import { defineAgent } from "../shared/runtime.js";
import { callLLM } from "../llm.js";
import { withCharter } from "../council/charter.js";
import { num, clamp01, int } from "../db/util.js";

export const COHERENCE_VERDICTS = Object.freeze([
  "coherent", "contradiction", "confirmation", "mixed", "unverified", "unchecked", "error"
]);

const COHERENCE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          relation: { type: "string" },
          belief_id: { type: "string" },
          confidence: { type: "number" },
          scope: { type: "string" },
          durable: { type: "boolean" },
          note: { type: "string" }
        }
      }
    },
    note: { type: "string" }
  }
};

const COHERENCE_SYSTEM = withCharter(
  "You are the Coherence Monitor of the COGNOS council. You compare the council's new draft answer against the beliefs the system already stores, and you report what you find as measurements — never as judgments of the user, and never by inventing agreement that is not there.\n\n" +
  "For each claim in the draft that touches a stored belief, emit an entry in `claims` with:\n" +
  "- claim: the claim as the draft states it (short, faithful, no embellishment)\n" +
  "- relation: one of \"supports\", \"contradicts\", \"new\", \"unrelated\"\n" +
  "- belief_id: the id of the stored belief it supports or contradicts (empty string for \"new\" or \"unrelated\")\n" +
  "- confidence: 0.0-1.0, how strongly the draft asserts this claim\n" +
  "- scope: \"user\" (about the user or their preferences), \"world\" (about how things are), or \"conversation\" (only relevant to this exchange)\n" +
  "- durable: true only if the claim is worth holding onto beyond this exchange\n" +
  "- note: one short line of reasoning\n\n" +
  "Set verdict to \"contradiction\" if any claim contradicts a stored belief, \"confirmation\" if claims only support stored beliefs, \"mixed\" if both happen, \"coherent\" if the draft touches nothing stored, and \"unclear\" if you cannot tell. Only report a contradiction when the draft and the belief genuinely cannot both be true — a difference of emphasis, an update over time, or a change of the user's mind stated by the user is a contradiction of the OLD belief and should be reported as one, with the new claim marked durable."
);

function normalizeClaims(raw, knownIds) {
  const claims = Array.isArray(raw?.claims) ? raw.claims : [];
  const out = [];
  for (const c of claims) {
    if (!c || typeof c !== "object") continue;
    const relation = ["supports", "contradicts", "new", "unrelated"].includes(c.relation) ? c.relation : "unrelated";
    const beliefId = typeof c.belief_id === "string" && knownIds.has(c.belief_id) ? c.belief_id : null;
    out.push({
      claim: String(c.claim || "").slice(0, 600),
      relation: beliefId ? relation : (relation === "supports" || relation === "contradicts" ? "new" : relation),
      belief_id: beliefId,
      confidence: clamp01(num(c.confidence, 0.5)),
      scope: ["user", "world", "conversation"].includes(c.scope) ? c.scope : "conversation",
      durable: c.durable === true,
      note: c.note ? String(c.note).slice(0, 300) : null
    });
  }
  return out;
}

function verdictOf(claims, modelVerdict) {
  const contradictions = claims.filter(c => c.relation === "contradicts").length;
  const supports = claims.filter(c => c.relation === "supports").length;
  if (contradictions && supports) return "mixed";
  if (contradictions) return "contradiction";
  if (supports) return "confirmation";
  return COHERENCE_VERDICTS.includes(modelVerdict) ? modelVerdict : "coherent";
}

export const coherenceMonitorAgent = defineAgent({
  name: "coherenceMonitor",
  type: "stage",
  async handle(message, ctx) {
    const content = message.content;
    const cfg = ctx.config.knowledge || {};
    const unchecked = (reason) => ({ ...content, coherence: { checked: false, verdict: "unchecked", reason, claims: [], contradictions: [], confirmations: [], newClaims: [], beliefIds: [], beliefsConsidered: 0 } });

    if (cfg.coherenceEnabled === false) return unchecked("disabled");
    const responseText = content.responseText;
    if (!responseText || !String(responseText).trim()) return unchecked("empty_draft");
    const workspaceId = content.workspaceId;
    if (!workspaceId) return unchecked("no_workspace");

    try {
      const t0 = Date.now();
      const pool = await ctx.db.Belief.pool(workspaceId, cfg.maxBeliefsPerRun || 12);
      if (!pool.length) {
        return { ...content, coherence: { checked: false, verdict: "unverified", reason: "no_stored_beliefs", claims: [], contradictions: [], confirmations: [], newClaims: [], beliefIds: [], beliefsConsidered: 0 } };
      }
      const inventory = pool.map(b => ({
        id: b.id,
        statement: String(b.statement || "").slice(0, 300),
        confidence: num(b.confidence, 0.5),
        status: b.status,
        support: int(b.support_count, 0),
        contradictions: int(b.contradict_count, 0)
      }));
      const knownIds = new Set(inventory.map(b => b.id));
      const result = await callLLM(ctx, {
        model: cfg.coherenceModel || ctx.config.models.memory,
        responseJsonSchema: COHERENCE_SCHEMA,
        purpose: "coherence",
        messages: [
          { role: "system", content: COHERENCE_SYSTEM },
          {
            role: "user",
            content: `User request:\n${content.userMessage || ""}\n\nCouncil draft answer:\n${String(responseText).slice(0, 6000)}\n\nStored beliefs (JSON):\n${JSON.stringify(inventory)}`
          }
        ]
      });
      const claims = normalizeClaims(result, knownIds);
      const contradictions = claims.filter(c => c.relation === "contradicts");
      const confirmations = claims.filter(c => c.relation === "supports");
      const newClaims = claims
        .filter(c => c.relation === "new" && c.durable && c.confidence >= num(cfg.hypothesisConfidenceFloor, 0.6))
        .slice(0, int(cfg.maxNewHypotheses, 2));
      const report = {
        checked: true,
        verdict: verdictOf(claims, result?.verdict),
        claims,
        contradictions,
        confirmations,
        newClaims,
        beliefIds: claims.map(c => c.belief_id).filter(Boolean),
        beliefsConsidered: inventory.length,
        note: result?.note ? String(result.note).slice(0, 400) : null,
        model: cfg.coherenceModel || ctx.config.models.memory,
        latencyMs: Date.now() - t0
      };
      return { ...content, coherence: report };
    } catch (e) {
      ctx.logger.warn("coherence monitor failed", { error: String(e) });
      return { ...content, coherence: { checked: false, verdict: "error", reason: String(e).slice(0, 300), claims: [], contradictions: [], confirmations: [], newClaims: [], beliefIds: [], beliefsConsidered: 0 } };
    }
  }
});

/**
 * Record the report. Called after the Governor's verdict, inside one
 * transaction, on the transaction-bound store.
 *
 * @returns {{persisted:boolean, events:number, report:object, detail:object}}
 */
export async function persistCoherence(store, {
  report, workspaceId, conversationId, runId, messageId = null, vetoed = false, config = {}, finalText = null
}) {
  const cfg = config.knowledge || config || {};
  if (!report) {
    return { persisted: false, events: 0, report: null, detail: { skipped: "no_report" } };
  }

  // A vetoed draft never reaches the belief store. The measurement is kept —
  // marked as not shipped — so the run is still observable, but no conclusion
  // the Governor rejected becomes knowledge.
  if (vetoed) {
    const row = await store.CoherenceReport.create({
      run_id: runId,
      workspace_id: workspaceId,
      conversation_id: conversationId,
      message_id: messageId,
      checked: report.checked !== false,
      verdict: report.verdict || "unchecked",
      draft_shipped: false,
      persisted: false,
      skip_reason: "governor_veto",
      claims: (report.claims || []).map(c => ({ claim: c.claim, relation: c.relation, belief_id: c.belief_id })),
      belief_ids: report.beliefIds || [],
      model_used: report.model ?? null,
      latency_ms: report.latencyMs ?? null,
      note: report.note ?? null
    });
    return { persisted: false, events: 0, report: row, detail: { skipped: "governor_veto" } };
  }

  if (!report.checked) {
    const row = await store.CoherenceReport.create({
      run_id: runId, workspace_id: workspaceId, conversation_id: conversationId, message_id: messageId,
      checked: false, verdict: report.verdict || "unchecked", draft_shipped: true, persisted: false,
      skip_reason: report.reason || "not_checked", belief_ids: report.beliefIds || [],
      model_used: report.model ?? null, latency_ms: report.latencyMs ?? null, note: report.note ?? null
    });
    return { persisted: false, events: 0, report: row, detail: { skipped: report.reason || "not_checked" } };
  }

  const source = { runId, messageId, kind: "run" };
  const events = [];
  let confidenceDelta = 0;
  const created = [];
  const weakened = [];
  const retired = [];
  const confirmed = [];

  // New durable claims first: a contradicting claim can then name its successor,
  // so the retired belief's relationships have somewhere to go.
  const successors = new Map();
  for (const claim of (report.newClaims || []).slice(0, int(cfg.maxNewHypotheses, 2))) {
    const proposed = await store.Belief.proposeHypothesis({ claim, workspaceId, source, config: cfg });
    events.push(...(proposed.events || []));
    if (proposed.belief) {
      created.push({ id: proposed.belief.id, statement: claim.claim, confidence: num(proposed.belief.confidence) });
      successors.set(claim.claim, proposed.belief.id);
    }
  }

  for (const claim of (report.contradictions || [])) {
    const belief = claim.belief_id ? await store.Belief.get(claim.belief_id) : null;
    if (!belief || belief.workspace_id !== workspaceId) continue;
    // The claim that contradicts a belief is itself a candidate successor.
    let successorId = successors.get(claim.claim) ?? null;
    if (!successorId && claim.confidence >= num(cfg.hypothesisConfidenceFloor, 0.6)) {
      const proposed = await store.Belief.proposeHypothesis({
        claim: { ...claim, relation: "new", durable: true }, workspaceId, source, config: cfg
      });
      events.push(...(proposed.events || []));
      if (proposed.belief && !proposed.existing) {
        successorId = proposed.belief.id;
        created.push({ id: proposed.belief.id, statement: claim.claim, confidence: num(proposed.belief.confidence), supersedes: belief.id });
      }
    }
    const out = await store.Belief.applyContradiction({ belief, claim, source, config: cfg, successorId });
    events.push(...(out.events || []));
    confidenceDelta += out.confidenceDelta || 0;
    weakened.push({ id: belief.id, statement: String(belief.statement).slice(0, 200), delta: out.confidenceDelta, confidence: num(out.belief?.confidence), retired: out.retired, abandoned: out.abandoned, successor_id: successorId });
    if (out.retired) retired.push({ id: belief.id, abandoned: out.abandoned, successor_id: successorId });
  }

  for (const claim of (report.confirmations || [])) {
    const belief = claim.belief_id ? await store.Belief.get(claim.belief_id) : null;
    if (!belief || belief.workspace_id !== workspaceId || belief.status === "retired") continue;
    const out = await store.Belief.applyConfirmation({ belief, claim, source, config: cfg });
    events.push(...(out.events || []));
    confidenceDelta += out.confidenceDelta || 0;
    confirmed.push({ id: belief.id, statement: String(belief.statement).slice(0, 200), delta: out.confidenceDelta, confidence: num(out.belief?.confidence) });
  }

  const row = await store.CoherenceReport.create({
    run_id: runId,
    workspace_id: workspaceId,
    conversation_id: conversationId,
    message_id: messageId,
    checked: true,
    verdict: report.verdict,
    draft_shipped: true,
    persisted: true,
    claims: report.claims || [],
    contradictions: (report.contradictions || []).map(c => ({ claim: c.claim, belief_id: c.belief_id, confidence: c.confidence, note: c.note })),
    confirmations: (report.confirmations || []).map(c => ({ claim: c.claim, belief_id: c.belief_id, confidence: c.confidence })),
    belief_ids: report.beliefIds || [],
    confidence_delta: Number(confidenceDelta.toFixed(4)),
    model_used: report.model ?? null,
    latency_ms: report.latencyMs ?? null,
    note: report.note ?? null
  });

  return {
    persisted: true,
    events: events.length,
    report: row,
    detail: {
      verdict: report.verdict,
      contradictions: weakened.length,
      confirmations: confirmed.length,
      hypotheses: created.length,
      retired: retired.length,
      confidenceDelta: Number(confidenceDelta.toFixed(4)),
      created, weakened, retired, confirmed,
      finalTextChars: finalText ? String(finalText).length : null
    }
  };
}

/**
 * The compact brief appended to the Critic's input. Empty string when there is
 * nothing to say, so the Critic's prompt is byte-identical to before Phase 14
 * whenever the monitor is off or found nothing.
 */
export function coherenceBrief(coherence, temporal = null) {
  if (!coherence || coherence.checked === false) return "";
  const lines = [];
  const contradictions = coherence.contradictions || [];
  const confirmations = coherence.confirmations || [];
  if (!contradictions.length && !confirmations.length && !(coherence.newClaims || []).length) return "";
  lines.push(`\n\n[Coherence data — measured against the beliefs the system already stores; treat it as evidence, not as a verdict on you]`);
  lines.push(`Verdict: ${coherence.verdict}.`);
  for (const c of contradictions) {
    lines.push(`- CONTRADICTS stored belief ${c.belief_id || "?"} (confidence ${(c.confidence ?? 0).toFixed(2)}): "${c.claim}"${c.note ? ` — ${c.note}` : ""}`);
  }
  for (const c of confirmations) {
    lines.push(`- SUPPORTS stored belief ${c.belief_id || "?"}: "${c.claim}"`);
  }
  for (const c of (coherence.newClaims || [])) {
    lines.push(`- NEW durable claim (would be recorded as a hypothesis): "${c.claim}"`);
  }
  if (temporal?.beliefs?.length) {
    lines.push(`Temporal context for those beliefs:`);
    for (const b of temporal.beliefs) {
      // Report the movement honestly: a per-day rate over a span of seconds is an
    // extrapolation, so say what actually changed over what window instead.
    const movement = b.velocity_reliable === false
      ? `moved ${b.velocity_change >= 0 ? "+" : ""}${Number(b.velocity_change ?? 0).toFixed(3)} over ${((b.velocity_span_ms ?? 0) / 1000).toFixed(1)}s (too short for a per-day rate)`
      : `moving ${b.velocity_per_day >= 0 ? "+" : ""}${b.velocity_per_day.toFixed(3)}/day`;
    lines.push(`- ${b.id}: confidence ${b.confidence.toFixed(2)}, ${movement}, uncertainty ${b.uncertainty?.direction || "unknown"}, stability ${(b.stability?.index ?? 0).toFixed(2)}, ${b.contradictions} prior contradiction(s), last confirmed ${b.age_days} day(s) ago`);
    }
    if (temporal.summary?.reading) lines.push(`Reading: ${temporal.summary.reading}.`);
  }
  return lines.join("\n");
}
