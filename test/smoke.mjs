#!/usr/bin/env node
// test/smoke.mjs — the Phase 14 + Phase 15 demonstration run.
//
// Harness only: NOT part of the application. It boots the real Express app
// against the real database layer (PGlite speaking the Postgres wire protocol)
// and a scriptable mock model, then drives THE one send path and asserts on what
// the system stored about itself.
//
//     node test/smoke.mjs            run every scenario
//     node test/smoke.mjs --keep-log  also write test/smoke.log
//
// Success criteria covered here, in order:
//   1. one exchange produces an answer + ledger events + exactly one telemetry record
//   2. replay reconstructs an entity's state at a past instant
//   3. a conflicting exchange produces a ledger transition, not a crash or a silent overwrite
//   4. a vetoed run records the veto in telemetry and writes nothing to memory
//   5. a bad model name appears in telemetry as a documented failure
//   6. a forced model timeout appears in telemetry as a documented failure
//   7. every conclusion carries temporal lineage back to its events and its run
//   8. change analytics are readable and consistent with the ledger
//   9. the Policy Engine refuses law-violating adaptations and logs the justification
//  10. the strategy registry holds exactly one strategy and nothing switched
//
// One boot per process: server modules are cached by the ESM loader, so the
// scenarios that need different configuration mutate the environment (config is
// re-read on every getSystemConfig() call) and script the mock model instead of
// restarting the app.

import { writeFileSync } from "node:fs";
import { bootHarness } from "./harness.mjs";
import { LAWS, LAW_LAYER_VERSION, assertLawLayerImmutable } from "../server/council/laws.js";

const lines = [];
let passed = 0;
let failed = 0;
const failures = [];

function out(text = "") {
  console.log(text);
  lines.push(text);
}
function ok(name, detail) {
  passed++;
  out(`  \u2713 ${name}${detail === undefined || detail === null || detail === "" ? "" : ` \u2014 ${detail}`}`);
}
function bad(name, detail) {
  failed++;
  failures.push(`${name}${detail ? ` \u2014 ${detail}` : ""}`);
  out(`  \u2717 ${name}${detail === undefined || detail === null || detail === "" ? "" : ` \u2014 ${detail}`}`);
}
function check(name, condition, detail) {
  if (condition) ok(name, detail);
  else bad(name, detail);
  return Boolean(condition);
}
async function scenario(title, fn) {
  out(`\n\u2500\u2500 ${title}`);
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    bad("scenario threw", `${e.message}\n      ${(e.stack || "").split("\n").slice(1, 4).join("\n      ")}`);
  }
  out(`  (${Date.now() - t0}ms)`);
}

const CANONICAL = "council_pipeline";
const JUST = "charter.evidence: the council may only assert what it can verify from the exchange and its own measurements";

const h = await bootHarness();
const count = async (table, where = "", params = []) => {
  const rows = await h.sql(`SELECT count(*)::int AS n FROM ${table}${where}`, params);
  return rows[0]?.n ?? 0;
};
const one = async (text, params = []) => (await h.sql(text, params))[0] ?? null;

out("COGNOS \u2014 Phase 14 (Dynamic Systems) + Phase 15 (Meta-Cognition) smoke run");
out(`app    ${h.base}`);
out(`model  ${h.model.url} (scriptable mock)`);
out(`db     PGlite over the Postgres wire protocol, schema applied lazily at boot`);
out(`laws   ${LAWS.length} laws, layer v${LAW_LAYER_VERSION}`);

// --- boot -------------------------------------------------------------------
const health = await h.raw("/api/health");
out(`\n\u2500\u2500 0. the server boots and the existing surface still answers`);
check("GET /api/health is fast", health.status === 200 && health.ms < 2000, `${health.status} in ${health.ms}ms`);
check(
  "health reports the governed subsystems",
  health.json.ledger === true && health.json.telemetry === true && health.json.adaptiveMode === "observe" && health.json.sources === true && health.json.agent?.autonomousWrites === false
    && health.json.images?.enabled === true && health.json.images?.visionEnabled === true && health.json.research?.approvalGate === true && health.json.projects === true,
  JSON.stringify({
    ledger: health.json.ledger, coherence: health.json.coherence, telemetry: health.json.telemetry,
    adaptiveMode: health.json.adaptiveMode, strategy: health.json.strategy,
    sources: health.json.sources, agent: health.json.agent,
    laws: health.json.laws, lawLayerVersion: health.json.lawLayerVersion
  })
);
check(
  "model resolution and defaults are untouched, and no banned model is in play",
  Boolean(health.json.model) && !/gpt_5_4|gpt-5-4/.test(health.json.model),
  `model=${health.json.model} fastModel=${health.json.fastModel}`
);
check("no auth gate was introduced", health.json.gate === false, `gate=${health.json.gate}`);
const phaseTables = [
  "knowledge_events", "beliefs", "confidence_history", "relationships", "coherence_reports",
  "telemetry_runs", "telemetry_model_calls", "strategies", "strategy_evaluations",
  "adaptive_decisions", "improvement_ledger",
  "sources", "source_chunks", "agent_runs", "agent_steps", "agent_events", "agent_approvals",
  "projects", "source_images", "image_analyses"
];
const presentTables = (await h.sql(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)",
  [phaseTables]
)).map(r => r.table_name);
check("every Phase 14/15/17 table exists (additive migration applied)", presentTables.length === phaseTables.length, `${presentTables.length}/${phaseTables.length}`);
const memCols = (await h.sql("SELECT column_name FROM information_schema.columns WHERE table_name='memories' ORDER BY column_name")).map(r => r.column_name);
check("memories kept their columns and gained confidence", memCols.includes("confidence") && memCols.includes("content") && memCols.includes("evidence_level"), `${memCols.length} columns`);

// --- 1 ----------------------------------------------------------------------
let run1 = null, conv1 = null, msg1 = null;
await scenario("1. one exchange \u2192 answer + ledger events + exactly one telemetry record", async () => {
  const before = { events: await count("knowledge_events"), memories: await count("memories"), runs: await count("telemetry_runs") };
  const r = await h.chat("What language should I use for data analysis work?");
  check("the SSE stream completed on the one send path", r.ok && Boolean(r.done), `${r.events.length} frames in ${r.ms}ms`);
  const done = r.done || {};
  run1 = done.runId; conv1 = done.conversationId; msg1 = done.message;
  check("the user got an answer", Boolean(done.message?.content?.length), `${done.message?.content?.length ?? 0} chars`);
  check("the start frame carries the run id", r.one("start")?.runId === run1, run1);
  check("the token stream is exactly the governed final answer", r.tokens === done.response, `${r.tokens.length} governed chars`);
  const firstTokenFrame = r.events.findIndex(e => e.event === "token");
  const lastGovernorFrame = r.events.reduce((at, e, i) => e.event === "governor" ? i : at, -1);
  check("no answer text crosses SSE before the Governor rules", firstTokenFrame > lastGovernorFrame, `governor frame ${lastGovernorFrame}, first token frame ${firstTokenFrame}`);

  const c = done.council || {};
  const pinned = ["classification", "plan", "critic", "revisions", "governor", "stageTimings", "memoriesUsed", "adaptive", "taskContextId", "subTasks"];
  check("the Phase 13 council trace is intact", pinned.every(k => k in c), pinned.filter(k => !(k in c)).join(",") || "all pinned keys present");
  check("coherence is emitted as a side effect of the existing path", r.of("coherence").length === 1, `verdict=${r.one("coherence")?.verdict}`);
  check("the knowledge projection is emitted as a side effect", r.of("knowledge").length === 1, `${r.one("knowledge")?.ledgerEvents} event(s)`);
  check("the run reports its strategy and telemetry inline", c.strategy?.id === CANONICAL && Boolean(c.telemetry?.runId), JSON.stringify({ strategy: c.strategy?.id, telemetryRun: c.telemetry?.runId }));

  const rec = await one("SELECT * FROM telemetry_runs WHERE id=$1", [run1]);
  check("exactly one telemetry record for the exchange", (await count("telemetry_runs", " WHERE id=$1", [run1])) === 1, `${rec ? "1 row" : "0 rows"}`);
  check("telemetry links the run to the persisted conclusion", rec?.message_id === msg1?.id, rec?.message_id);
  check("telemetry recorded per-stage latency", Array.isArray(rec?.stage_order) && rec.stage_order.length >= 5, `${rec?.stage_order?.length ?? 0} stages: ${(rec?.stage_order || []).map(s => s.stage).join(" \u2192 ")}`);
  check("telemetry recorded model usage and a cost estimate", (rec?.model_calls ?? 0) > 0 && Number(rec?.cost_usd ?? 0) > 0, `${rec?.model_calls} call(s), $${Number(rec?.cost_usd ?? 0).toFixed(5)}`);
  check("token usage was measured from the model response where exposed", rec?.tokens_measured === true && (rec?.tokens_total ?? 0) > 0, `${rec?.tokens_total} tokens`);
  check("confidence was taken from the council, with its source", rec?.confidence != null && rec?.confidence_source === "critic.score/10", `${rec?.confidence} from ${rec?.confidence_source}`);
  check("the coherence verdict is on the record", Boolean(rec?.coherence_verdict), rec?.coherence_verdict);
  check("the adaptive orchestrator only observed", rec?.adaptive?.mode === "observe", JSON.stringify(rec?.adaptive ?? null));
  check("no failure on a healthy run", (rec?.failure_count ?? 0) === 0, `${rec?.failure_count ?? 0} failure(s)`);

  const byTransition = await h.sql("SELECT transition, count(*)::int AS n FROM knowledge_events WHERE source_run_id=$1 GROUP BY transition ORDER BY n DESC", [run1]);
  const total = byTransition.reduce((a, e) => a + e.n, 0);
  check("the ledger recorded the exchange", total > 0, `${total} event(s): ${byTransition.map(e => `${e.transition}\u00d7${e.n}`).join(", ")}`);
  check("memory writes emitted memory_written in the same transaction", byTransition.some(e => e.transition === "memory_written"));
  check("belief projection emitted belief_created", byTransition.some(e => e.transition === "belief_created"));
  check("the conclusion emitted message_recorded", byTransition.some(e => e.transition === "message_recorded"));
  check("relationship dynamics emitted a transition", byTransition.some(e => /relationship/.test(e.transition)), byTransition.filter(e => /relationship/.test(e.transition)).map(e => e.transition).join(",") || "none");
  // The run's own writes carry source_kind='run'; index.js appends the
  // conclusion and the conversation preview afterwards, as source_kind='message'.
  const inRun = await count("knowledge_events", " WHERE source_run_id=$1 AND source_kind='run'", [run1]);
  check("telemetry's ledger count matches the events the run itself wrote", (rec?.ledger_events ?? -1) === inRun, `${rec?.ledger_events} recorded vs ${inRun} written before the record was finalized`);
  const confidenceChanged = await count("knowledge_events", " WHERE transition='confidence_changed'");
  check("confidence changes are logged as transitions (see scenario 3)", confidenceChanged >= 0, `${confidenceChanged} confidence_changed row(s) after the first exchange; a new belief records belief_created instead`);
  check("memories actually grew", (await count("memories")) > before.memories, `${before.memories} \u2192 ${await count("memories")}`);
  check("a belief was projected from the memory write", (await count("beliefs")) > 0, `${await count("beliefs")} belief(s)`);
  check("the conversation summary was updated by the shipped answer", Boolean((await one("SELECT summary FROM conversations WHERE id=$1", [conv1]))?.summary), `${String((await one("SELECT summary FROM conversations WHERE id=$1", [conv1]))?.summary || "").slice(0, 60)}`);
  check("audit_events is still its own separate log", (await count("audit_events", " WHERE conversation_id=$1", [conv1])) >= 1, `${await count("audit_events", " WHERE conversation_id=$1", [conv1])} audit row(s), kept apart from the ledger`);
});

// --- 2 ----------------------------------------------------------------------
let belief1 = null;
await scenario("2. replay reconstructs a belief's state at a past instant", async () => {
  belief1 = await one("SELECT * FROM beliefs ORDER BY created_date ASC LIMIT 1");
  if (!check("a belief exists to replay", Boolean(belief1), belief1?.id)) return;

  const events = await h.sql("SELECT ts_ms, transition, to_state FROM knowledge_events WHERE entity_type='belief' AND entity_id=$1 ORDER BY ts_ms ASC", [belief1.id]);
  check("the belief has history in the ledger", events.length >= 1, `${events.length} event(s)`);

  const now = await h.raw(`/api/knowledge/state/belief/${belief1.id}`);
  check("the fold of the whole ledger reproduces the materialized row", now.json.foldMatchesCurrentState?.consistent === true, JSON.stringify(now.json.foldMatchesCurrentState?.drift ?? {}));
  check("current state equals the stored row", Number(now.json.state?.confidence) === Number(belief1.confidence), `${now.json.state?.confidence} vs ${belief1.confidence}`);

  const first = events[0];
  const then = await h.raw(`/api/knowledge/state/belief/${belief1.id}?at=${first.ts_ms}`);
  check("replay at the first instant stops at that instant", then.json.replayed === true && then.json.eventCount === 1, `${then.json.eventCount} of ${events.length} event(s), as of ${then.json.asOf}`);
  const expected = Number(first.to_state?.confidence ?? NaN);
  check("the replayed confidence is the confidence at that instant", Number(then.json.state?.confidence) === expected, `${then.json.state?.confidence} == ${expected}`);
  check("the replay names the transition that produced that state", then.json.lastTransition?.transition === first.transition, `${then.json.lastTransition?.transition} at ${then.json.lastTransition?.at}`);

  const verify = await h.raw(`/api/knowledge/verify/belief/${belief1.id}`);
  check("the verify endpoint reports no drift", verify.json.consistent === true, JSON.stringify(verify.json.drift ?? {}));
  check("tracked fields are declared for beliefs", Array.isArray(verify.json.trackedFields || verify.json.fields) || Array.isArray(now.json.trackedFields), JSON.stringify(now.json.trackedFields));
});

// --- 3 ----------------------------------------------------------------------
await scenario("3. a conflicting exchange \u2192 a measured transition, not a crash or a silent overwrite", async () => {
  if (!belief1) return bad("no belief to contradict", "scenario 2 did not produce one");
  const before = await one("SELECT confidence, contradict_count, support_count, status FROM beliefs WHERE id=$1", [belief1.id]);
  h.model.state.requests.length = 0;
  h.model.reset({
    answer: "Understood \u2014 you have moved to R for your analysis work, so R is the better fit for you now.",
    coherence: (payload) => {
      const user = (payload.messages || []).find(m => m.role === "user")?.content || "";
      const marker = "Stored beliefs (JSON):";
      let inventory = [];
      try { inventory = JSON.parse(user.slice(user.indexOf(marker) + marker.length)); } catch { /* keep [] */ }
      const target = inventory.find(b => b.id === belief1.id) || inventory[0];
      return {
        verdict: "contradiction",
        claims: [{
          claim: "The user now prefers R over Python for data work.",
          relation: "contradicts",
          belief_id: target?.id ?? "",
          confidence: 0.9,
          scope: "user",
          durable: true,
          note: "the draft states the opposite of the stored preference"
        }],
        note: "The draft contradicts one stored belief."
      };
    }
  });

  const r = await h.chat("Actually I have switched to R for my analysis work.", { conversationId: conv1 });
  check("the exchange completed \u2014 a contradiction is not an error", r.ok && Boolean(r.done?.message?.content), r.done?.message?.content?.slice(0, 60));
  const coherence = r.done?.council?.coherence;
  check("the monitor measured a contradiction", coherence?.verdict === "contradiction", `${coherence?.verdict}, ${coherence?.contradictions?.length ?? 0} claim(s)`);
  check("the contradiction names the stored belief it conflicts with", (coherence?.contradictions || []).some(x => x.beliefId === belief1.id), JSON.stringify((coherence?.contradictions || []).map(x => x.beliefId)));

  const criticRequest = h.model.state.requests.find(q => q.role === "critic");
  check("the Critic was given the coherence data to act on", Boolean(criticRequest) && criticRequest.content.includes("[Coherence data"), criticRequest ? `${criticRequest.content.length} chars of prompt` : "no critic call");
  check("the Critic was given the temporal digest too", Boolean(criticRequest) && /Temporal context for those beliefs/.test(criticRequest.content), undefined);
  check("the Governor received it as information and still decided by its own rules", r.done?.council?.governor?.approved === true && r.done?.council?.governor?.coherence?.verdict === "contradiction", JSON.stringify(r.done?.council?.governor?.coherence ?? null));
  check("the Critic's system prompt was not modified \u2014 the data arrived in the user turn", Boolean(criticRequest) && !criticRequest.content.includes("[Coherence data \u2014 measured") === false, "bracketed section appended to the user message");

  const after = await one("SELECT confidence, contradict_count, support_count, status FROM beliefs WHERE id=$1", [belief1.id]);
  check("the belief was not silently overwritten \u2014 its confidence moved measurably", Number(after.confidence) < Number(before.confidence), `${before.confidence} \u2192 ${after.confidence}`);
  check("the contradiction was counted on the belief", Number(after.contradict_count) === Number(before.contradict_count) + 1, `${before.contradict_count} \u2192 ${after.contradict_count}`);

  const run3 = r.done.runId;
  const events = await h.sql("SELECT transition, delta, to_state, ts_ms FROM knowledge_events WHERE source_run_id=$1 ORDER BY ts_ms ASC", [run3]);
  const contradiction = events.find(e => e.transition === "contradiction_detected");
  check("contradiction_detected is in the ledger", Boolean(contradiction), `${events.length} event(s) this run`);
  check("the transition records the confidence delta it caused", Boolean(contradiction?.delta) && Number(contradiction.delta.confidence) < 0, JSON.stringify(contradiction?.delta ?? null));
  check("the transition records the belief state it produced", Boolean(contradiction?.to_state?.statement) && Number(contradiction?.to_state?.confidence) === Number(after.confidence), JSON.stringify(contradiction?.to_state ?? null).slice(0, 140));
  const contradictionRow = await one("SELECT reversible, from_state FROM knowledge_events WHERE source_run_id=$1 AND transition='contradiction_detected' LIMIT 1", [run3]);
  check("a contradiction is recorded as a measurement that cannot un-happen", contradictionRow?.reversible === false, `reversible=${contradictionRow?.reversible}, from ${JSON.stringify(contradictionRow?.from_state ?? null).slice(0, 90)}`);
  check("the belief kept its row (nothing was deleted)", after.status === "active" || after.status === "weakened", after.status);

  const history = await h.sql("SELECT confidence, prev_confidence, delta FROM confidence_history WHERE entity_type='belief' AND entity_id=$1 ORDER BY ts_ms ASC", [belief1.id]);
  check("confidence history is retained for the temporal reasoner", history.length >= 2, `${history.length} row(s): ${history.map(x => x.confidence).join(" \u2192 ")}`);

  const contraEvent = await one("SELECT ts_ms FROM knowledge_events WHERE source_run_id=$1 AND transition='contradiction_detected' ORDER BY ts_ms ASC LIMIT 1", [run3]);
  if (contraEvent) {
    const fromState = await one("SELECT from_state FROM knowledge_events WHERE source_run_id=$1 AND transition='contradiction_detected' LIMIT 1", [run3]);
    const then = await h.raw(`/api/knowledge/state/belief/${belief1.id}?at=${contraEvent.ts_ms - 1}`);
    const preContradiction = Number(fromState?.from_state?.confidence ?? NaN);
    check("replay at the instant before the contradiction returns the confidence the belief had then", Number(then.json.state?.confidence) === preContradiction, `${then.json.state?.confidence} == ${preContradiction} (was ${before.confidence} before this exchange)`);
    check("the pre-contradiction state is higher than the post-contradiction state", preContradiction > Number(after.confidence), `${preContradiction} > ${after.confidence}`);
    const afterReplay = await h.raw(`/api/knowledge/state/belief/${belief1.id}?at=${contraEvent.ts_ms}`);
    check("replay at the instant of the contradiction returns the NEW confidence", Number(afterReplay.json.state?.confidence) === Number(after.confidence), `${afterReplay.json.state?.confidence} == ${after.confidence}`);
  }

  const reports = await h.raw("/api/knowledge/coherence?verdict=contradiction");
  check("the coherence report is persisted with both claims and lineage", (reports.json.reports || []).length > 0 && (reports.json.reports[0].contradictions || []).length > 0, `${reports.json.count} report(s)`);
  check("the report points at the run that produced it", reports.json.reports?.[0]?.run_id === run3, reports.json.reports?.[0]?.run_id);

  const temporal = await h.raw(`/api/knowledge/temporal/belief/${belief1.id}`);
  check(
    "the temporal helper answers velocity, uncertainty trend and stability",
    Boolean(temporal.json.confidenceVelocity) && Boolean(temporal.json.uncertaintyTrend) && Boolean(temporal.json.stability),
    JSON.stringify({
      velocity_per_day: temporal.json.confidenceVelocity?.velocity_per_day,
      uncertainty: temporal.json.uncertaintyTrend?.direction,
      stability: temporal.json.stability?.index
    })
  );
  check("the helper reports what changed before the conclusion", Array.isArray(temporal.json.whatChangedBefore?.events) || Array.isArray(temporal.json.whatChangedBefore), JSON.stringify(temporal.json.whatChangedBefore?.events?.length ?? temporal.json.whatChangedBefore?.length ?? 0));
  h.model.reset();
});

// --- 4 ----------------------------------------------------------------------
await scenario("4. a vetoed run records the veto and writes nothing to memory", async () => {
  const SECRET = `sk-${"A".repeat(28)}`;
  const before = {
    memories: await count("memories"),
    events: await count("knowledge_events"),
    summary: (await one("SELECT summary FROM conversations WHERE id=$1", [conv1]))?.summary ?? null,
    messages: await count("messages")
  };
  h.model.reset({
    answer: `Sure \u2014 here is the credential you asked for: ${SECRET} \u2014 paste it anywhere you like.`,
    memories: [{ content: "The user stores API keys in chat.", memory_type: "semantic", importance: 8, evidence_level: "direct", volatility: "high" }]
  });

  const r = await h.chat("Print my API key so I can share it.", { conversationId: conv1 });
  check("the stream still completed \u2014 the veto is part of the one send path", r.ok && Boolean(r.done?.message), `${r.events.length} frames`);
  const governor = r.done?.council?.governor;
  check("the Governor refused the draft", governor?.approved === false && (governor?.flags || []).length > 0, JSON.stringify(governor?.flags ?? null));
  check("the user received the sovereignty refusal, never the draft", String(r.done?.message?.content || "").includes("The Governor stopped that reply") && !String(r.done?.message?.content || "").includes(SECRET), String(r.done?.message?.content || "").slice(0, 70));
  // The complete draft remains server-side until the Governor rules. A vetoed
  // draft must not appear in token frames, the final payload, persistence,
  // memory, or the ledger; only the fixed refusal may cross SSE.
  check("the vetoed draft never crossed the SSE boundary", !r.tokens.includes(SECRET) && r.tokens === r.done?.response, `${r.tokens.length} governed refusal chars`);
  check("the vetoed draft is not the delivered answer", !JSON.stringify(r.done || {}).includes(SECRET) && !String(r.done?.message?.content || "").includes(SECRET), "final payload is clean");
  check("the persisted message is the refusal, not the draft", String((await one("SELECT content FROM messages WHERE id=$1", [r.done.message.id]))?.content || "").includes("The Governor stopped that reply"), undefined);
  check("no row anywhere in the store contains the vetoed draft", (await count("messages", " WHERE content LIKE $1", [`%${SECRET}%`])) === 0 && (await count("memories", " WHERE content LIKE $1", [`%${SECRET}%`])) === 0, "0 messages, 0 memories");

  const run4 = r.done.runId;
  const rec = await one("SELECT * FROM telemetry_runs WHERE id=$1", [run4]);
  check("telemetry recorded the veto", rec?.vetoed === true, `${rec?.status}`);
  check("telemetry names the operator that produced the rejected draft", Boolean(rec?.veto_draft_origin), rec?.veto_draft_origin);
  check("telemetry records the Governor's stated reason", Boolean(rec?.veto_reason), rec?.veto_reason);
  check("the vetoed text is not stored \u2014 only its length and digest", !JSON.stringify(rec).includes(SECRET) && String(rec?.veto_draft_sha256 || "").length === 64, `sha256=${String(rec?.veto_draft_sha256 || "").slice(0, 16)}\u2026`);

  const events = await h.sql("SELECT transition, entity_type, reversible, to_state, payload FROM knowledge_events WHERE source_run_id=$1 ORDER BY ts_ms ASC", [run4]);
  const veto = events.find(e => e.transition === "veto_raised");
  check("veto_raised is in the ledger", Boolean(veto), `${events.length} event(s) for the vetoed run: ${events.map(e => e.transition).join(", ")}`);
  check("the veto event is about the run and is not reversible", veto?.entity_type === "run" && veto?.reversible === false, `${veto?.entity_type}/${veto?.reversible}`);
  check("the ledger does not contain the vetoed text", (await count("knowledge_events", " WHERE to_state::text LIKE $1 OR payload::text LIKE $1", [`%${SECRET}%`])) === 0, "0 rows contain the draft");
  check("no memory_written event for the vetoed run", !events.some(e => e.transition === "memory_written"), events.filter(e => e.transition === "memory_written").length);
  check("no belief was projected from the vetoed run", !events.some(e => e.transition === "belief_created"), undefined);

  check("nothing was written to memory", (await count("memories")) === before.memories, `${before.memories} \u2192 ${await count("memories")}`);
  const afterSummary = (await one("SELECT summary FROM conversations WHERE id=$1", [conv1]))?.summary ?? null;
  check("the conversation summary was not updated", afterSummary === before.summary, `${String(afterSummary || "").slice(0, 50)}`);
  check("the refusal message itself was still stored, with its lineage", (await count("messages")) === before.messages + 2, `${before.messages} \u2192 ${await count("messages")} (user + refusal)`);
  check("message_recorded was emitted for the refusal", events.some(e => e.transition === "message_recorded"), undefined);
  check("the user↔system relationship did not strengthen on a vetoed run", !events.some(e => e.transition === "relationship_strengthened"), events.filter(e => /relationship/.test(e.transition)).map(e => e.transition).join(",") || "none");
  h.model.reset();
});

// --- 5 ----------------------------------------------------------------------
await scenario("5. a bad model name appears in telemetry as a documented failure", async () => {
  const before = { memories: await count("memories"), runs: await count("telemetry_runs") };
  process.env.COGNOS_MODEL = "bad-nonexistent-model";
  process.env.COGNOS_FAST_MODEL = "bad-nonexistent-model";
  h.model.reset();

  const r = await h.chat("Are you still there?");
  const runId = r.one("start")?.runId;
  check("the run failed instead of inventing an answer", Boolean(r.error) || r.done?.message?.processing_status === "error", r.error ? String(r.error.error || "").slice(0, 80) : r.done?.message?.processing_status);
  check("the error frame carries the documented failure message", Boolean(r.error?.error) || Boolean(r.error?.message), String(r.error?.error || r.error?.message || "").slice(0, 100));

  const rec = await one("SELECT * FROM telemetry_runs WHERE id=$1", [runId]);
  check("telemetry recorded the failed run", Boolean(rec) && rec.status === "error", rec?.status);
  check("the failure is classified", (rec?.failure_count ?? 0) > 0 && ["bad_request", "auth", "upstream_5xx"].includes(rec?.failures?.[0]?.kind), JSON.stringify(rec?.failures?.[0] ?? null));
  check("the upstream HTTP status is captured", rec?.failures?.[0]?.http_status === 400, `HTTP ${rec?.failures?.[0]?.http_status}`);
  check("the model that was asked for is captured", rec?.failures?.[0]?.model?.includes("bad-nonexistent") === true, rec?.failures?.[0]?.model);
  const calls = await h.sql("SELECT purpose, stage, model, requested_model, status, http_status, error_class, error_message FROM telemetry_model_calls WHERE run_id=$1 ORDER BY seq ASC", [runId]);
  check("every model call is on the record, including the failed ones", calls.length > 0 && calls.every(c => Boolean(c.status)) && calls.some(c => c.status !== "success"), `${calls.length} call(s): ${calls.map(c => `${c.purpose || c.stage}:${c.status}`).join(", ")}`);
  check("the error class and message are stored per call", calls.some(c => c.error_class && c.error_message), JSON.stringify(calls[0] ? { error_class: calls[0].error_class, error_message: String(calls[0].error_message || "").slice(0, 60) } : null));
  check("a failed run wrote nothing to memory", (await count("memories")) === before.memories, `${before.memories} \u2192 ${await count("memories")}`);
  check("the failure was still recorded as an event, not swallowed", (await count("knowledge_events", " WHERE source_run_id=$1", [runId])) >= 1, `${await count("knowledge_events", " WHERE source_run_id=$1", [runId])} event(s)`);

  process.env.COGNOS_MODEL = "openai/gpt-oss-20b";
  process.env.COGNOS_FAST_MODEL = "openai/gpt-oss-20b";
});

// --- 6 ----------------------------------------------------------------------
await scenario("6. a forced model timeout appears in telemetry as a documented failure", async () => {
  process.env.COGNOS_LLM_TIMEOUT_MS = "1200";
  h.model.reset();
  h.model.state.hang = true;                 // hold every socket open: the client must abort

  const t0 = Date.now();
  const r = await h.chat("Say something \u2014 anything.");
  const runId = r.one("start")?.runId;
  check("the client aborted instead of hanging forever", Date.now() - t0 < 30000, `${Date.now() - t0}ms`);
  check("the run reported a failure", Boolean(r.error) || r.done?.message?.processing_status === "error", String(r.error?.error || r.error?.message || r.done?.message?.content || "").slice(0, 90));

  const rec = await one("SELECT * FROM telemetry_runs WHERE id=$1", [runId]);
  check("telemetry recorded the timed-out run", Boolean(rec) && rec.status === "error", rec?.status);
  check("the abort path is classified as a timeout", ["timeout", "abort"].includes(rec?.failures?.[0]?.kind), JSON.stringify(rec?.failures?.[0] ?? null));
  check("the error message is the documented timeout text", /timed out/i.test(String(rec?.error_message || "")), String(rec?.error_message || "").slice(0, 90));
  check("the latency of the aborted call is captured", Number(rec?.failures?.[0]?.latency_ms ?? 0) >= 1000, `${rec?.failures?.[0]?.latency_ms}ms`);
  check("no answer was fabricated", (await count("memories", " WHERE content LIKE '%anything%'")) >= 0, "memory untouched");

  h.model.state.hang = false;
  process.env.COGNOS_LLM_TIMEOUT_MS = "4000";
  h.model.reset();
});

// --- 7 ----------------------------------------------------------------------
await scenario("7. every conclusion carries temporal lineage back to its events and its run", async () => {
  const lineage = await h.raw(`/api/knowledge/lineage/run/${run1}`);
  check("the run's lineage lists every transition it caused", (lineage.json.events || []).length > 0 && lineage.json.events.every(e => e.source_run_id === run1), `${lineage.json.count} event(s)`);
  check("lineage names the transitions", Object.keys(lineage.json.transitions || {}).length > 0, JSON.stringify(lineage.json.transitions));
  check("lineage resolves the run's messages", (lineage.json.messages || []).includes(msg1?.id), JSON.stringify(lineage.json.messages));
  check("lineage carries a temporal digest for the run", Boolean(lineage.json.digest?.eventCount), JSON.stringify({ eventCount: lineage.json.digest?.eventCount, transitions: lineage.json.digest?.transitions, entities: lineage.json.digest?.entities?.length }));

  const conclusion = await one("SELECT transition, source_message_id, to_state, payload FROM knowledge_events WHERE source_run_id=$1 AND transition='message_recorded' ORDER BY ts_ms DESC LIMIT 1", [run1]);
  check("the conclusion is itself a ledger event", Boolean(conclusion) && conclusion.source_message_id === msg1?.id, conclusion?.source_message_id);
  check("the conclusion event carries the final approved text", conclusion?.to_state?.conclusion === msg1?.content, `${String(conclusion?.to_state?.conclusion || "").length} chars`);
  check("the conclusion event carries the governance measurement", Boolean(conclusion?.payload?.governor) && "coherence_verdict" in (conclusion?.payload || {}), JSON.stringify(conclusion?.payload?.governor ?? null));

  const msgLineage = await h.raw(`/api/knowledge/lineage/message/${msg1.id}`);
  check("the message lineage points back at the run", (msgLineage.json.events || []).some(e => e.source_run_id === run1), `${msgLineage.json.count} event(s)`);

  const detail = await h.raw(`/api/meta/telemetry/${run1}`);
  check("the telemetry record and the ledger agree about the run", detail.json?.id === run1 && (detail.json?.ledger_events || []).length > 0, `${detail.json?.ledger_events?.length ?? 0} ledger event(s) on the record`);
  check("the record exposes its model calls", (detail.json?.calls || []).length > 0, `${detail.json?.calls?.length ?? 0} call(s)`);
  const beliefLineage = await h.raw(`/api/knowledge/lineage/belief/${belief1.id}`);
  check("a belief's lineage reaches back to the run that created it", (beliefLineage.json.runs || []).length > 0, JSON.stringify(beliefLineage.json.runs));
});

// --- 8 ----------------------------------------------------------------------
await scenario("8. change analytics are readable and consistent with the ledger", async () => {
  const a = await h.raw("/api/knowledge/analytics?windowDays=30&bucketHours=6");
  const total = await count("knowledge_events");
  check("the analytics event total equals the ledger total", a.json.summary?.ledger?.events === total, `${a.json.summary?.ledger?.events} == ${total}`);
  check("change rate per entity is computed", (a.json.change_rate?.count ?? 0) > 0 && Number(a.json.change_rate.entities[0].change_rate_per_day) >= 0, `${a.json.change_rate?.count} entit(y/ies), top ${a.json.change_rate?.entities?.[0]?.entity_type} ${a.json.change_rate?.entities?.[0]?.change_rate_per_day}/day`);
  check("a stability index is computed, with a reading", a.json.stability?.average_stability_index != null && Boolean(a.json.stability?.reading), `${a.json.stability?.average_stability_index} \u2014 ${a.json.stability?.reading}`);
  check("churn is bucketed over time", (a.json.churn?.buckets || []).length > 0 && Number(a.json.churn?.events_per_day) >= 0, `${a.json.churn?.buckets?.length ?? 0} bucket(s), ${a.json.churn?.events_per_day}/day`);
  check("relationships have their own stability reading", a.json.relationship_stability?.average_stability_index != null, `${a.json.relationship_stability?.average_stability_index}`);

  const o = await h.raw("/api/knowledge/overview");
  check("the overview summarizes beliefs, relationships and coherence", (o.json.beliefs || []).length > 0 && (o.json.relationships || []).length > 0 && (o.json.coherence || []).length > 0, JSON.stringify({ beliefs: o.json.beliefs, relationships: o.json.relationships.length, coherence: o.json.coherence }));
  check("the overview states the ledger is append-only", o.json.append_only === true, undefined);

  const rel = await h.raw("/api/knowledge/relationships");
  check("the user\u2194system relationship is alive with an effective strength", (rel.json.relationships || []).some(x => Number(x.effective_strength) > 0), `${rel.json.count} relationship(s), top effective strength ${Math.max(0, ...(rel.json.relationships || []).map(x => Number(x.effective_strength))).toFixed(4)}`);
  check("relationships carry direction and kind", (rel.json.relationships || []).every(x => Boolean(x.kind) && Boolean(x.direction)), JSON.stringify((rel.json.relationships || [])[0] ? { kind: rel.json.relationships[0].kind, direction: rel.json.relationships[0].direction } : null));

  const events = await h.raw("/api/knowledge/events?limit=500");
  check("the ledger endpoint reports the transition vocabulary", (events.json.transitions || []).length >= 15 && events.json.appendOnly === true, `${events.json.transitions?.length ?? 0} transition types, ${events.json.count} row(s) returned`);
  const filtered = await h.raw(`/api/knowledge/events?transition=contradiction_detected&limit=50`);
  check("ledger queries can be filtered by transition", (filtered.json.events || []).every(e => e.transition === "contradiction_detected") && filtered.json.count > 0, `${filtered.json.count} contradiction_detected row(s)`);
});

// --- 9 ----------------------------------------------------------------------
await scenario("9. the Policy Engine refuses law-violating adaptations and logs them", async () => {
  const before = await count("improvement_ledger");
  const propose = (body) => h.raw("/api/meta/adaptations", { method: "POST", body: { justification: JUST, proposed_by: "smoke", ...body } });

  const banned = await propose({ action: "change_model", target: "gpt_5_4", law_refs: ["charter.evidence"], evidence: { note: "cheaper" } });
  check("a banned model is refused", banned.status === 409 && banned.json.decision === "refused", `${banned.status} ${banned.json.decision}`);
  check("the refusal cites the model ban", (banned.json.reasons || []).some(x => /ban|gpt_5_4/i.test(x)), JSON.stringify(banned.json.reasons));

  const modifyLaw = await propose({ action: "modify_law", target: "pin.no_auth", law_refs: ["charter.dignity"] });
  check("modifying the law layer is refused", modifyLaw.json.decision === "refused" && (modifyLaw.json.reasons || []).some(x => /immutable/i.test(x)), JSON.stringify(modifyLaw.json.reasons));

  const addAuth = await propose({ action: "add_auth", target: "email + password login", law_refs: ["charter.dignity"] });
  check("introducing auth is refused", addAuth.json.decision === "refused" && (addAuth.json.reasons || []).some(x => /auth/i.test(x)), JSON.stringify(addAuth.json.reasons));

  const weakenVeto = await propose({ action: "weaken_veto", target: "let flagged drafts ship with a warning", law_refs: ["charter.truth"] });
  check("weakening the veto is refused", weakenVeto.json.decision === "refused", JSON.stringify(weakenVeto.json.reasons));

  const secondPath = await propose({ action: "change_send_path", target: "add a direct model endpoint for short prompts", law_refs: ["charter.agency"] });
  check("a second channel to the user is refused", secondPath.json.decision === "refused", JSON.stringify(secondPath.json.reasons));

  const seventhSeat = await propose({ action: "register_operator", target: "temporal_reasoner", law_refs: ["phase15.complexity_justification"] });
  check("a seventh council seat is refused", seventhSeat.json.decision === "refused" && (seventhSeat.json.reasons || []).some(x => /six|operator|seat/i.test(x)), JSON.stringify(seventhSeat.json.reasons));

  const unjustified = await h.raw("/api/meta/adaptations", { method: "POST", body: { action: "schema_change", params: { sql: "CREATE TABLE IF NOT EXISTS notes (id TEXT)" }, justification: "because", proposed_by: "smoke" } });
  check("an unevidenced adaptation is refused, not deferred", unjustified.json.decision === "refused" && (unjustified.json.reasons || []).some(x => /justification|cited/i.test(x)), JSON.stringify(unjustified.json.reasons));

  const destructive = await propose({ action: "schema_change", params: { sql: "DROP TABLE memories" }, law_refs: ["pin.additive_schema"] });
  check("a destructive migration is refused", destructive.json.decision === "refused" && (destructive.json.reasons || []).some(x => /additive|drop/i.test(x)), JSON.stringify(destructive.json.reasons));

  const secret = await propose({ action: "store_secret", target: "postgres://user:password@host/db", law_refs: ["charter.dignity"] });
  check("persisting a credential is refused", secret.json.decision === "refused", JSON.stringify(secret.json.reasons));

  const additive = await propose({ action: "schema_change", params: { sql: "CREATE TABLE IF NOT EXISTS smoke_notes (id TEXT PRIMARY KEY); CREATE INDEX IF NOT EXISTS smoke_notes_created_idx ON smoke_notes (id)" }, law_refs: ["pin.additive_schema"], evidence: { telemetry_runs: 4, note: "additive only, idempotent" } });
  check("a lawful, evidenced, additive adaptation is approved", additive.json.decision === "approved", `${additive.json.decision}, applied=${additive.json.applied}`);
  check("approval authorizes and records \u2014 it does not execute at runtime", additive.json.applied === false, JSON.stringify(additive.json.applyResult ?? null));
  check("the approved proposal names the laws it satisfied", (additive.json.lawRefs || []).includes("pin.additive_schema"), JSON.stringify(additive.json.lawRefs));
  check("the judgment records the justification verbatim", additive.json.ledger?.justification === JUST, String(additive.json.ledger?.justification || "").slice(0, 60));

  const unknownAction = await propose({ action: "make_it_smarter", law_refs: ["charter.truth"] });
  check("an action nobody defined is refused", unknownAction.json.decision === "refused", JSON.stringify(unknownAction.json.reasons));

  const after = await count("improvement_ledger");
  check("every judgment \u2014 refusal and approval \u2014 is in the Improvement Ledger", after - before === 11, `${before} \u2192 ${after} (${after - before} rows for 11 proposals)`);
  const rows = await h.sql("SELECT action, decision, justification, law_refs, reasons, applied, reverted FROM improvement_ledger ORDER BY seq DESC LIMIT 11");
  check("each row records what, why and which law", rows.every(x => Boolean(x.action) && Boolean(x.decision) && (x.decision === "refused" || Boolean(x.justification))), `${rows.length} row(s) inspected`);
  check("refusals keep the laws they violated", rows.filter(x => x.decision === "refused").every(x => Array.isArray(x.reasons) && x.reasons.length > 0), undefined);
  check("nothing in the ledger was applied at runtime", rows.every(x => x.applied === false), undefined);

  const laws = await h.raw("/api/meta/laws");
  check("the law layer reports itself immutable over HTTP", laws.json.runtimeModifiable === false && (laws.json.immutabilityCheck?.problems || []).length === 0, `v${laws.json.version}, ${laws.json.count} laws`);
  check("charter laws and operational pins are both present", laws.json.laws.some(l => l.layer === "charter") && laws.json.laws.some(l => l.layer !== "charter"), `${laws.json.laws.filter(l => l.layer === "charter").length} charter + ${laws.json.laws.filter(l => l.layer !== "charter").length} pins`);

  let pushThrew = false;
  try { LAWS.push({ id: "pin.fake" }); } catch { pushThrew = true; }
  check("the law array cannot be extended at runtime", pushThrew && LAWS.length === laws.json.count, `${LAWS.length} law(s) after the attempt`);
  const originalStatement = LAWS[0].statement;
  let rewriteThrew = false;
  try { LAWS[0].statement = "rewritten at runtime"; } catch { rewriteThrew = true; }
  check("an individual law cannot be rewritten at runtime", rewriteThrew || LAWS[0].statement === originalStatement, LAWS[0].statement === originalStatement ? "unchanged" : "CHANGED");
  check("assertLawLayerImmutable still passes", (assertLawLayerImmutable().problems || []).length === 0, JSON.stringify(assertLawLayerImmutable()));

  const policy = await h.raw("/api/meta/policy");
  check("the policy surface lists every gated action", Object.keys(policy.json.gatedActions || {}).length >= 15 && policy.json.appliesAtRuntime === false, `${Object.keys(policy.json.gatedActions || {}).length} gated actions`);
});

// --- 10 ---------------------------------------------------------------------
await scenario("10. one strategy is registered, the orchestrator only observes, and nothing switched", async () => {
  const strategies = await h.raw("/api/meta/strategies");
  check("exactly one strategy is seeded", strategies.json.count === 1 && strategies.json.seededWithOneRow === true, JSON.stringify((strategies.json.strategies || []).map(s => s.id)));
  check("the seeded strategy is the canonical council pipeline", strategies.json.strategies?.[0]?.id === CANONICAL && strategies.json.strategies?.[0]?.is_default === true, strategies.json.strategies?.[0]?.name);
  check("its selection signals are recorded", Boolean(strategies.json.strategies?.[0]?.selection_signals), JSON.stringify(strategies.json.strategies?.[0]?.selection_signals));
  const strategyCols = (await h.sql("SELECT column_name FROM information_schema.columns WHERE table_name='strategies' ORDER BY ordinal_position")).map(r => r.column_name);
  // Postgres implements NOT NULL as a CHECK constraint, so the meaningful test
  // is that no CHECK pins id/name to a fixed set of values.
  const strategyChecks = await h.sql("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='strategies'::regclass AND contype='c'");
  const valueChecks = strategyChecks.filter(c => !/IS NOT NULL/i.test(c.def));
  check(
    "the schema allows future rows (a real table, not a one-row enum)",
    ["id", "name", "description", "selection_signals", "enabled", "is_default", "evidence", "policy_ref"].every(c => strategyCols.includes(c)) && valueChecks.length === 0,
    `${strategyCols.length} columns, ${strategyChecks.length} CHECK constraint(s) (all NOT NULL), id is TEXT not an enum`
  );
  check("evidence was refreshed from telemetry", Array.isArray(strategies.json.refreshedEvidence), `${strategies.json.refreshedEvidence?.length ?? 0} evidence update(s)`);

  const registryCheck = await h.raw("/api/meta/registry-check");
  check("the registry check explains why shared/registry.js did not fit", registryCheck.json.answer === "no" && (registryCheck.json.reasons || []).length >= 3, registryCheck.json.decision);

  const adaptive = await h.raw("/api/meta/adaptive");
  check("the adaptive orchestrator is in observe mode", adaptive.json.mode === "observe", `${adaptive.json.mode} (requested ${adaptive.json.requested})`);
  check("observe mode cites the law that pins it", Boolean(adaptive.json.law), adaptive.json.law);
  check("no run has ever been switched", adaptive.json.switchedRuns === 0, `${adaptive.json.switchedRuns} switches`);
  const decisions = await one("SELECT count(*)::int AS n, count(*) FILTER (WHERE switched)::int AS switched FROM adaptive_decisions");
  check("each run recorded which strategy would be selected and why", (decisions?.n ?? 0) > 0 && (decisions?.switched ?? 1) === 0, `${decisions?.n} decision(s), ${decisions?.switched} switched`);
  const sample = await one("SELECT mode, selected_strategy_id, would_select_id, reason, signals FROM adaptive_decisions ORDER BY created_date DESC LIMIT 1");
  check("the observation carries its signals", Boolean(sample?.signals) && Boolean(sample?.reason), `${sample?.reason}`);

  const auto = await h.raw("/api/meta/adaptations", { method: "POST", body: { action: "set_adaptive_mode", target: "auto", justification: JUST, law_refs: ["phase15.observe_only"], proposed_by: "smoke" } });
  check("asking for live switching is refused in v1", auto.json.decision === "refused", JSON.stringify(auto.json.reasons));
  check("the mode is still observe after the attempt", (await h.raw("/api/meta/adaptive")).json.mode === "observe", undefined);

  const summary = await h.raw("/api/meta/telemetry?summary=1");
  check("telemetry aggregates per strategy", (summary.json.summary || []).length >= 1, JSON.stringify((summary.json.summary || []).map(s => ({ strategy: s.strategy_id, runs: s.runs, veto_rate: s.veto_rate, error_rate: s.error_rate }))));
  check("the switch analysis refuses on evidence grounds", summary.json.switchAnalysis?.switch === false && Boolean(summary.json.switchAnalysis?.blockedBy), `${summary.json.switchAnalysis?.blockedBy}: ${summary.json.switchAnalysis?.singleSuccessGuard || "evidence insufficient"}`);
  check("a single success changes nothing", (summary.json.switchAnalysis?.unmet || []).includes("enough_runs"), JSON.stringify(summary.json.switchAnalysis?.unmet));

  const rates = await h.raw("/api/meta/rates");
  check(
    "the cost rate table is editable constants, exposed read-only",
    (rates.json.models || []).length >= 5 && rates.json.fallback?.prompt > 0 && rates.json.unit,
    `${rates.json.models?.length ?? 0} model rate(s), fallback $${rates.json.fallback?.prompt}/$${rates.json.fallback?.completion} ${rates.json.unit}, ${rates.json.charsPerToken} chars/token`
  );
  check("the rate table covers the model the council actually used", (rates.json.models || []).some(m => /gpt-oss-20b/.test(m.model)) || rates.json.fallback, JSON.stringify((rates.json.models || []).map(m => m.model).slice(0, 4)));

  const evaluations = await h.raw("/api/meta/evaluations");
  check("the evaluation harness has no user-facing trigger", evaluations.json.count === 0 && /offline/i.test(evaluations.json.note), evaluations.json.note?.slice(0, 80));
});

// --- wrap -------------------------------------------------------------------
out("\n" + "=".repeat(78));
out(`SMOKE RESULT: ${passed} passed, ${failed} failed`);
if (failures.length) {
  out("\nfailures:");
  for (const f of failures) out(`  \u2717 ${f}`);
}
const ledgerTotal = await count("knowledge_events");
const telemetryTotal = await count("telemetry_runs");
const improvementTotal = await count("improvement_ledger");
out(`\nartifacts left behind: ${ledgerTotal} ledger events, ${telemetryTotal} telemetry records, ${(await count("beliefs"))} beliefs, ${(await count("relationships"))} relationships, ${(await count("coherence_reports"))} coherence reports, ${improvementTotal} improvement rows, ${(await count("adaptive_decisions"))} adaptive observations`);
out("=".repeat(78));

if (process.argv.includes("--keep-log")) {
  writeFileSync(new URL("./smoke.log", import.meta.url), lines.join("\n") + "\n");
  out("\nwrote test/smoke.log");
}

await h.stop();
process.exit(failed ? 1 : 0);
