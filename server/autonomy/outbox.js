// The outbox — Phase 19.
//
// Every consequential effect passes through here. A step STAGES; only a
// deterministic Action Governor verdict RELEASES; and release inside `shadow`
// or `dry_run` records the verdict and performs nothing.
//
//   staging is not acting        (pin.effect_staged)
//   reversal is a new row        (pin.ledger_append_only)
//   refusals are rows, not throws

import { createHash } from "node:crypto";
import { judgeEffect } from "./actionGovernor.js";
import { canonicalize } from "./authorize.js";
// Phase 20 — the T3 executor's tools. Neither module imports the autonomy
// tree, so this edge cannot cycle back.
import { ingestLink } from "../sources/index.js";
import { searchWeb } from "../council/webSearch.js";
// Phase 21 — the T4 adapter. It reads `isPublicAddress` from safeFetch and
// nothing from the autonomy tree, so this edge cannot cycle back either.
import { buildWebhookRequest, deliverWebhook } from "./webhookPost.js";

export { canonicalize };

export function effectIdempotencyKey({ goalId, effectType, payload }) {
  return createHash("sha256")
    .update(JSON.stringify([goalId || null, effectType, canonicalize(payload || {})]))
    .digest("hex");
}

/**
 * The executors that exist. A step STAGES; the Action Governor JUDGES; only a
 * live verdict reaches one of these.
 *
 * An entry is either a function (perform) or `{ perform, prepare }`. `prepare`
 * is what `dry_run` calls: it builds the exact request and records it without
 * opening a socket, so the ledger shows what would have gone out (§4.7.1).
 *
 * Receipts are METADATA ONLY, everywhere. Fetched text, response bodies and
 * header values never sit in an outbox row, so a credential inside a page — or
 * echoed back by a receiver — cannot leak into the effect ledger
 * (AUTONOMY.md §8.1, pin.receipt_metadata_only).
 */
const EXECUTORS = Object.freeze({
  async notify({ db, effect }) {
    const payload = effect.payload || {};
    const row = await db.AutonomyNotice.create({
      workspace_id: effect.workspace_id,
      agent_id: payload.agentId || effect.agent_id || null,
      goal_id: payload.goalId || effect.goal_id || null,
      template_id: payload.templateId,
      fields: payload.fields || {},
      severity: payload.severity || "info"
    });
    return { receipt: { delivered: true, noticeId: row.id, templateId: row.template_id } };
  },

  // Phase 20 — T3 external reads. The SOLE performer: a skill stages the read,
  // the Action Governor judges it, and only a live-mode release verdict reaches
  // this function. Receipts are METADATA ONLY (ids, digests, counts, flags) —
  // fetched text never sits in an outbox row, so a credential inside a fetched
  // page cannot leak into the effect ledger (AUTONOMY.md §8.1). The excerpt the
  // planner reads travels back as non-stored `output`: for a fetch it is re-read
  // from the immutable snapshot the read created; for a search it is the
  // bounded provider text, which persists nowhere unless the planner notes it.
  async external_read({ db, effect, signal = null }) {
    const payload = effect.payload || {};
    if (payload.op === "fetch") {
      const source = await ingestLink(db, {
        workspaceId: effect.workspace_id,
        conversationId: payload.conversationId || null,
        projectId: payload.projectId || null,
        url: payload.url,
        signal,
        attribution: {
          produced_by: "autonomy",
          goal_id: effect.goal_id || null,
          tick_id: effect.tick_id || null,
          effect_id: effect.id
        }
      });
      const full = await db.Source.get(source.id, effect.workspace_id);
      const excerpt = String(full?.extracted_text || "").slice(0, 4000);
      return {
        receipt: {
          sourceId: source.id,
          duplicate: source.duplicate === true,
          sha256: source.content_sha256,
          bytes: source.byte_size,
          chunks: source.extraction?.chunks ?? null,
          riskFlags: source.risk_flags || []
        },
        output: {
          sourceId: source.id,
          name: source.name,
          excerpt,
          excerptChars: excerpt.length,
          riskFlags: source.risk_flags || []
        }
      };
    }
    if (payload.op === "search") {
      if (process.env.COGNOS_SEARCH_ENABLED === "false") {
        throw new Error("web search is disabled (COGNOS_SEARCH_ENABLED)");
      }
      const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(12_000)
        : null;
      const combined = signal && timeout && AbortSignal.any
        ? AbortSignal.any([signal, timeout])
        : (timeout || signal);
      const { raw, provider } = await searchWeb({ query: payload.query, signal: combined });
      const results = String(raw || "").slice(0, 4000);
      return {
        receipt: {
          provider,
          resultChars: results.length,
          digest: createHash("sha256").update(results, "utf8").digest("hex")
        },
        output: { provider, results, resultChars: results.length }
      };
    }
    throw new Error(`unknown external_read op: ${String(payload.op || "(none)")}`);
  },

  // Phase 21 — T4 external writes; Phase 22 (autonomy row) — T5 irreversible
  // publishes. One shared bounded socket for both, because the difference
  // between a trigger and a committed publish is not the bytes — it is the
  // governance that released them, which the Action Governor already applied.
  //
  // Every gate ran before this function was reached (destination grant, https
  // shape, header allowlist, body cap, secret_ref resolution, quiet hours, the
  // shadow-evidence gate for a live T4 release, the per-effect human approval
  // for a T5 release). What is left here is the socket, and the socket is
  // bounded: DNS-pinned, re-checked per redirect, one attempt plus one bounded
  // retry, and a receipt that digests the response instead of keeping it.
  external_write: externalWriteExecutor(),
  irreversible: externalWriteExecutor()
});

/** The T4/T5 socket executor. Shared; see the two keys above. */
function externalWriteExecutor() {
  return {
    prepare({ effect, config }) {
      const built = buildRequest(effect, config);
      return {
        receipt: {
          dryRun: true,
          built: built.ok,
          errors: built.errors,
          // The request as it would be sent — header NAMES, a body digest, and
          // the destination. Never the body, never a header value, never a
          // signature: those exist only for the lifetime of a real send.
          request: built.ok ? {
            url: built.request.url,
            method: built.request.method,
            bodyBytes: built.bodyBytes,
            bodyDigest: built.bodyDigest,
            sentHeaderNames: built.sentHeaderNames
          } : null,
          signed: built.signed,
          secretRef: built.secretRef,
          effectId: effect.id
        }
      };
    },

    async perform({ effect, config, signal = null, transport = null, resolve = null }) {
      const built = buildRequest(effect, config);
      if (!built.ok) {
        throw new Error(`the request could not be built: ${built.errors.join("; ")}`);
      }
      const webhook = config?.webhook || {};
      const receipt = await deliverWebhook(built.request, {
        resolve: resolve || undefined,
        transport: transport || undefined,
        timeoutMs: Number(webhook.timeoutMs ?? 8_000),
        maxRedirects: Number(webhook.maxRedirects ?? 2),
        retryStatuses: Array.isArray(webhook.retryStatuses) ? [...webhook.retryStatuses] : [429, 502, 503, 504],
        maxRetryDelayMs: Number(webhook.maxRetryDelayMs ?? 2_000),
        maxResponseBytes: Number(webhook.maxResponseBytes ?? 65_536),
        digestBytes: Number(webhook.digestBytes ?? 4_096),
        signal
      });
      return {
        receipt: { ...receipt, secretRef: built.secretRef, bodyDigest: built.bodyDigest, effectId: effect.id },
        // The planner reads this; nothing stores it. A receiver that answers
        // 4xx made the delivery real and rejected it — both facts are reported,
        // because "released" must never be mistaken for "accepted".
        output: {
          delivered: receipt.accepted === true,
          accepted: receipt.accepted === true,
          status: receipt.status,
          statusText: receipt.statusText,
          url: receipt.url,
          attempts: receipt.attempts,
          redirects: receipt.redirects,
          latencyMs: receipt.latencyMs,
          effectId: effect.id,
          note: receipt.accepted
            ? "the receiver accepted the delivery"
            : `the delivery was released and the receiver answered ${receipt.status}`
        }
      };
    }
  };
}

/** Build the exact request an external write would send. Pure. */
function buildRequest(effect, config) {
  const payload = effect.payload || {};
  const webhook = config?.webhook || {};
  return buildWebhookRequest({
    url: payload.url,
    method: payload.method || "POST",
    headers: payload.headers || {},
    body: typeof payload.body === "string" ? payload.body : "",
    secretRef: payload.secretRef ?? payload.secret_ref ?? null,
    idempotencyKey: effect.idempotency_key,
    goalId: effect.goal_id,
    agentId: effect.agent_id,
    tickId: effect.tick_id,
    effectId: effect.id,
    maxBodyBytes: Number(webhook.maxBodyBytes ?? 32_768)
  });
}

/** An executor entry is a function, or { perform, prepare }. */
function executorOf(entry) {
  if (!entry) return null;
  if (typeof entry === "function") return { perform: entry, prepare: null };
  return { perform: entry.perform || null, prepare: entry.prepare || null };
}

/**
 * Stage an effect. Idempotent by key: a repeat returns the existing row
 * instead of creating a second one, which is what makes a retried tick after a
 * crash safe.
 */
export async function stageEffect({ db, workspaceId, agentId = null, goalId = null,
  tickId = null, stepId = null, skillId, effectType, tier, payload = {}, mode = "shadow",
  destination = null, scopeSha256 = null, keyPayload = null }) {
  // An effect that does not name the skill that produced it is unattributable
  // (pin.autonomy_attributable). Refuse here, with a reason, rather than let it
  // reach the NOT NULL constraint and surface as a driver error three layers
  // down where nobody can tell what went wrong.
  if (!skillId) {
    throw new Error("stageEffect: an effect must name the skill that staged it");
  }
  // `keyPayload` is what defines the effect's IDENTITY, when that is narrower
  // than what the effect carries. AUTONOMY.md §4.7.1 keys a webhook on
  // (goal, url, body) and nothing else, so a re-authorization, a changed
  // header, or a differently worded reason cannot make the same trigger
  // stageable twice. Defaulting to the whole payload keeps every other effect
  // content-addressed as before.
  const idempotency_key = effectIdempotencyKey({ goalId, effectType, payload: keyPayload || payload });

  const existing = await db.AutonomyOutbox.findByIdempotency(idempotency_key);
  if (existing) {
    return { row: existing, deduplicated: true };
  }

  const row = await db.AutonomyOutbox.stage({
    workspace_id: workspaceId,
    agent_id: agentId,
    goal_id: goalId,
    tick_id: tickId,
    step_id: stepId,
    skill_id: skillId,
    effect_type: effectType,
    tier,
    payload,
    idempotency_key,
    mode,
    // The destination is lifted into its own column because it is the field an
    // operator actually approves, and the scope hash is lifted out of the
    // payload because a WRITE must dedupe on (goal, url, body) alone: putting
    // the hash in the key would let a re-authorization stage a second row for
    // the same delivery, and the same trigger twice is the failure §8.10d
    // exists to prevent.
    destination,
    scope_sha256: scopeSha256
  });

  if (!row) {
    // Lost the race on the unique index — another worker staged the same key.
    const raced = await db.AutonomyOutbox.findByIdempotency(idempotency_key);
    return { row: raced, deduplicated: true };
  }

  await db.OutboxEvent.append({
    outbox_id: row.id,
    from_status: null,
    to_status: "staged",
    detail: { skillId, effectType, tier, mode, goalId, tickId,
      ...(destination ? { destination } : {}) }
  });
  return { row, deduplicated: false };
}

/**
 * Judge, record, and — only in `live` mode — perform.
 * Returns the verdict and the resulting row. Never throws on a refusal.
 */
/**
 * Split an executor's return into the stored receipt and the non-stored
 * output. The receipt column stays metadata-only: fetched text that lands
 * there would put page contents — possibly credentials — into the effect
 * ledger (AUTONOMY.md §8.1). A bare return is tolerated as a legacy receipt.
 */
function splitExecutorResult(settled) {
  if (settled && typeof settled === "object" && !Array.isArray(settled)
      && ("receipt" in settled || "output" in settled)) {
    return { receipt: settled.receipt ?? null, output: settled.output ?? null };
  }
  return { receipt: settled ?? null, output: null };
}

/**
 * The release event names what was recorded without duplicating it into a
 * second row: ids and counts, never the receipt's full body.
 */
function minimizeReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return receipt ?? null;
  if (receipt.noticeId) return { noticeId: receipt.noticeId };
  if (receipt.sourceId) {
    return { sourceId: receipt.sourceId, ...(receipt.duplicate === true ? { duplicate: true } : {}) };
  }
  if (receipt.provider) return { provider: receipt.provider, resultChars: receipt.resultChars ?? null };
  // A webhook receipt is already metadata; what an event row needs is where it
  // went, what came back, and how many tries it took.
  if (typeof receipt.status === "number" || receipt.dryRun === true) {
    return {
      ...(receipt.dryRun === true ? { dryRun: true } : {}),
      ...(receipt.url ? { url: receipt.url } : {}),
      ...(typeof receipt.status === "number" ? { status: receipt.status } : {}),
      ...(typeof receipt.attempts === "number" ? { attempts: receipt.attempts } : {}),
      ...(receipt.accepted !== undefined ? { accepted: receipt.accepted } : {}),
      ...(receipt.signed !== undefined ? { signed: receipt.signed } : {})
    };
  }
  return { keys: Object.keys(receipt).sort() };
}

export async function decideEffect({ db, effectId, goal, authorization = null, config, mode = null,
  nowMs = Date.now(), signal = null, transport = null, resolve = null }) {
  const effect = await db.AutonomyOutbox.get(effectId);
  if (!effect) return { ok: false, error: "effect not found" };

  const effectiveMode = mode || effect.mode || "shadow";

  // Replay safety: an effect that already reached a terminal state returns its
  // prior verdict instead of running again. One delivery, not two.
  if (["released", "would_release", "refused", "reverted"].includes(effect.status)) {
    // The one exception is T5. A T5 effect refused for want of a human approval
    // is not terminal in the way a refused T4 is: the tier's whole point is
    // that the approval arrives AFTER the loop's shadow refusal and re-opens
    // the decision. So a `refused` T5 row whose failures were all
    // T5_NEEDS_HUMAN falls through and is judged again — with the approval
    // row, if one now names it; without one, it refuses again for the same
    // named reason.
    const awaitingApproval = effect.status === "refused" && effect.tier === "T5"
      && Array.isArray(effect.verdict?.failed)
      && effect.verdict.failed.length > 0
      && effect.verdict.failed.every(f => f?.rule === "T5_NEEDS_HUMAN");
    if (!awaitingApproval) {
      return {
        ok: true,
        replayed: true,
        row: effect,
        verdict: effect.verdict || { decision: "replay", failed: [], passed: [] }
      };
    }
  }

  const verdict = await judgeEffect({ db, effect, goal, authorization, config, nowMs, mode: effectiveMode });

  if (verdict.decision === "refuse") {
    const row = await db.AutonomyOutbox.setVerdict(effect.id, {
      status: "refused",
      verdict,
      error: verdict.failed.map(f => f.rule).join(", ")
    });
    await db.OutboxEvent.append({
      outbox_id: effect.id,
      from_status: effect.status,
      to_status: "refused",
      detail: { failed: verdict.failed, mode: effectiveMode }
    });
    await goalEvent(db, effect, "effect_refused", row, { mode: effectiveMode,
      rules: verdict.failed.map(f => f.rule) });
    return { ok: true, row, verdict, executed: false };
  }

  const executor = executorOf(EXECUTORS[effect.effect_type]);

  // Released. In shadow the verdict is recorded and nothing is performed —
  // this is the corpus that earns Rung 4. In dry_run the exact request is
  // BUILT and recorded, and still nothing is performed: the difference between
  // the two modes is whether the ledger can show you the bytes it declined to
  // send.
  if (effectiveMode !== "live") {
    let receipt = null;
    if (effectiveMode === "dry_run" && executor?.prepare) {
      try {
        const prepared = executor.prepare({ db, effect, config });
        receipt = splitExecutorResult(prepared).receipt;
      } catch (error) {
        receipt = { dryRun: true, built: false,
          errors: [String(error?.message || error).slice(0, 300)] };
      }
    }
    const row = await db.AutonomyOutbox.setVerdict(effect.id, {
      status: "would_release",
      verdict,
      receipt,
      releasedMs: nowMs
    });
    await db.OutboxEvent.append({
      outbox_id: effect.id,
      from_status: effect.status,
      to_status: "would_release",
      detail: { mode: effectiveMode, note: "verdict recorded, nothing performed",
        ...(receipt ? { receipt: minimizeReceipt(receipt) } : {}) }
    });
    await goalEvent(db, effect, "effect_shadowed", row, { mode: effectiveMode });
    return { ok: true, row, verdict, executed: false, wouldRelease: true, receipt };
  }

  if (!executor?.perform) {
    const row = await db.AutonomyOutbox.setVerdict(effect.id, {
      status: "failed",
      verdict,
      error: `no executor for effect type: ${effect.effect_type}`
    });
    await db.OutboxEvent.append({
      outbox_id: effect.id,
      from_status: effect.status,
      to_status: "failed",
      detail: { error: `no executor for ${effect.effect_type}` }
    });
    return { ok: true, row, verdict, executed: false };
  }

  try {
    const settled = await executor.perform({ db, effect, signal, config, transport, resolve });
    const { receipt, output } = splitExecutorResult(settled);
    const row = await db.AutonomyOutbox.setVerdict(effect.id, {
      status: "released",
      verdict,
      receipt,
      releasedMs: nowMs
    });
    await db.OutboxEvent.append({
      outbox_id: effect.id,
      from_status: effect.status,
      to_status: "released",
      detail: { effectType: effect.effect_type, receipt: minimizeReceipt(receipt) }
    });
    await goalEvent(db, effect, "effect_released", row, { receipt: minimizeReceipt(receipt) });
    return { ok: true, row, verdict, executed: true, receipt, output: output || null };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 400);
    const row = await db.AutonomyOutbox.setVerdict(effect.id, {
      status: "failed",
      verdict,
      // A transport failure keeps what it learned: how many attempts were made
      // and whether the failure was a redirect or a timeout. The rule id is the
      // part an operator acts on, and it is not in the message text.
      receipt: { failed: true, attempts: Number(error?.attempts || 0),
        redirects: Number(error?.redirects || 0), rule: error?.rule || null },
      error: message
    });
    await db.OutboxEvent.append({
      outbox_id: effect.id,
      from_status: effect.status,
      to_status: "failed",
      detail: { error: message, rule: error?.rule || null, attempts: Number(error?.attempts || 0) }
    });
    await goalEvent(db, effect, "effect_failed", row, { error: message });
    return { ok: true, row, verdict, executed: false, error: message };
  }
}

/**
 * Mirror an effect's outcome into the goal's own event log, so a goal's history
 * reads as one story instead of requiring a join against the outbox to find out
 * what it did. Best-effort: an effect with no goal (or a ledger that refuses the
 * row) must never fail the decision it is reporting on.
 */
async function goalEvent(db, effect, eventType, row, detail = {}) {
  if (!effect?.goal_id || typeof db?.GoalEvent?.append !== "function") return null;
  try {
    return await db.GoalEvent.append({
      goal_id: effect.goal_id,
      agent_id: effect.agent_id || null,
      tick_id: effect.tick_id || null,
      step_id: effect.step_id || null,
      event_type: eventType,
      to_status: row?.status || null,
      detail: {
        effectId: effect.id,
        skillId: effect.skill_id,
        effectType: effect.effect_type,
        tier: effect.tier,
        ...(effect.destination ? { destination: effect.destination } : {}),
        ...detail
      }
    });
  } catch {
    return null;
  }
}

/**
 * An operator's refusal, recorded as its own rule.
 *
 * The obvious implementation — judge the effect with no authorization and let
 * the Governor refuse it — produces a row that says GOAL_NOT_AUTHORIZED when
 * what actually happened is that a human looked at it and said no. Those are
 * different facts and an audit that cannot tell them apart is not an audit.
 */
export async function refuseEffect({ db, effectId, reason = null, decidedBy = "operator", nowMs = Date.now() }) {
  const effect = await db.AutonomyOutbox.get(effectId);
  if (!effect) return { ok: false, error: "effect not found" };
  if (["released", "reverted"].includes(effect.status)) {
    return { ok: false, error: `a ${effect.status} effect cannot be refused; reversal is the only way back`, row: effect };
  }
  const text = String(reason || "").slice(0, 300) || null;
  const verdict = {
    decision: "refuse",
    passed: [],
    failed: [{ rule: "OPERATOR_REFUSED", law: "pin.effect_staged",
      reason: text || "an operator refused this effect by hand" }],
    mode: effect.mode || "shadow",
    tier: effect.tier,
    refusedBy: String(decidedBy || "operator").slice(0, 60),
    judgedAt: new Date(nowMs).toISOString(),
    law: "pin.effect_staged"
  };
  const row = await db.AutonomyOutbox.setVerdict(effect.id, {
    status: "refused",
    verdict,
    error: `OPERATOR_REFUSED${text ? `: ${text}` : ""}`
  });
  await db.OutboxEvent.append({
    outbox_id: effect.id,
    from_status: effect.status,
    to_status: "refused",
    detail: { failed: verdict.failed, decidedBy: verdict.refusedBy, reason: text }
  });
  await goalEvent(db, effect, "effect_refused", row, { rules: ["OPERATOR_REFUSED"], decidedBy: verdict.refusedBy });
  return { ok: true, row, verdict, executed: false, refusedByOperator: true };
}

/**
 * Reversal is a NEW ROW. The original is never edited or deleted, so the
 * record keeps both the attempt and the reversal.
 *
 * And reversal is honest about what it can undo. A staged, shadowed or refused
 * effect is undone by the transition — nothing ever happened. A RELEASED
 * external write is not: the bytes left the building, and no row can recall
 * them. The receipt says so plainly rather than implying an undo that did not
 * happen, which is the difference between a brake and a lie.
 */
export async function revertEffect({ db, effectId, reason = null, nowMs = Date.now() }) {
  const effect = await db.AutonomyOutbox.get(effectId);
  if (!effect) return { ok: false, error: "effect not found" };

  const original = effect.receipt && typeof effect.receipt === "object" && !Array.isArray(effect.receipt)
    ? effect.receipt : null;
  const delivered = effect.status === "released";
  const external = ["external_write", "irreversible"].includes(effect.effect_type);
  const unsendable = delivered && external;

  const receipt = {
    ...(original || {}),
    reversal: {
      revertedAtMs: nowMs,
      revertedFrom: effect.status,
      reason: String(reason || "").slice(0, 300) || null,
      unsendable,
      // Named so the record cannot be read as "the webhook was un-sent".
      note: unsendable
        ? "the delivery already happened; this row records the reversal, not an undo. Anything downstream must be corrected downstream."
        : "nothing was delivered; the transition is the whole reversal"
    }
  };

  const row = await db.AutonomyOutbox.setVerdict(effect.id, {
    status: "reverted",
    verdict: { decision: "revert", revertedFrom: effect.status, unsendable },
    receipt
  });
  await db.OutboxEvent.append({
    outbox_id: effect.id,
    from_status: effect.status,
    to_status: "reverted",
    detail: { reason: String(reason || "").slice(0, 300), unsendable,
      ...(effect.destination ? { destination: effect.destination } : {}) }
  });
  await goalEvent(db, effect, "effect_reverted", row, { unsendable });
  return { ok: true, row, unsendable };
}

/** The evidence gate reads this: how has the Governor actually been ruling? */
export async function shadowCorpus(db, workspaceId, limit = 500) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 500));
  const rows = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM autonomy_outbox
      WHERE workspace_id = $1
      GROUP BY status`, [workspaceId]
  );
  const byStatus = Object.fromEntries((rows || []).map(r => [r.status, Number(r.n)]));

  // The distribution is the part that matters. A corpus of 500 identical
  // refusals proves the gate is closed; a corpus of 500 identical releases
  // proves nothing at all. Rule, tier and destination breakdowns make "neither
  // too loose nor too tight" a thing you can look at rather than assert.
  const recent = await db.AutonomyOutbox.list(workspaceId, { limit: safeLimit });
  const byRule = {};
  const byTier = {};
  const byDestination = {};
  for (const row of recent || []) {
    byTier[row.tier] = (byTier[row.tier] || 0) + 1;
    const destination = row.destination || (row.effect_type === "external_write" ? "(unset)" : null);
    if (destination) byDestination[destination] = (byDestination[destination] || 0) + 1;
    const verdict = row.verdict && typeof row.verdict === "object"
      ? row.verdict
      : (() => { try { return JSON.parse(row.verdict || "{}"); } catch { return {}; } })();
    for (const failure of Array.isArray(verdict?.failed) ? verdict.failed : []) {
      const rule = String(failure?.rule || "unknown");
      byRule[rule] = (byRule[rule] || 0) + 1;
    }
  }

  return {
    byStatus,
    byRule,
    byTier,
    byDestination,
    samples: (recent || []).length,
    wouldRelease: byStatus.would_release || 0,
    refused: byStatus.refused || 0,
    released: byStatus.released || 0,
    failed: byStatus.failed || 0,
    reverted: byStatus.reverted || 0,
    recent: (recent || []).slice(0, 25)
  };
}
