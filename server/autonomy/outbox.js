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

export { canonicalize };

export function effectIdempotencyKey({ goalId, effectType, payload }) {
  return createHash("sha256")
    .update(JSON.stringify([goalId || null, effectType, canonicalize(payload || {})]))
    .digest("hex");
}

/**
 * The only executor that exists in Phase 19: a T2 notice, which writes a
 * template id and stored fields — never prose.
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
  }
});

/**
 * Stage an effect. Idempotent by key: a repeat returns the existing row
 * instead of creating a second one, which is what makes a retried tick after a
 * crash safe.
 */
export async function stageEffect({ db, workspaceId, agentId = null, goalId = null,
  tickId = null, stepId = null, skillId, effectType, tier, payload = {}, mode = "shadow" }) {
  // An effect that does not name the skill that produced it is unattributable
  // (pin.autonomy_attributable). Refuse here, with a reason, rather than let it
  // reach the NOT NULL constraint and surface as a driver error three layers
  // down where nobody can tell what went wrong.
  if (!skillId) {
    throw new Error("stageEffect: an effect must name the skill that staged it");
  }
  const idempotency_key = effectIdempotencyKey({ goalId, effectType, payload });

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
    mode
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
    detail: { skillId, effectType, tier, mode, goalId, tickId }
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
  return { keys: Object.keys(receipt).sort() };
}

export async function decideEffect({ db, effectId, goal, authorization = null, config, mode = null, nowMs = Date.now(), signal = null }) {
  const effect = await db.AutonomyOutbox.get(effectId);
  if (!effect) return { ok: false, error: "effect not found" };

  const effectiveMode = mode || effect.mode || "shadow";

  // Replay safety: an effect that already reached a terminal state returns its
  // prior verdict instead of running again. One delivery, not two.
  if (["released", "would_release", "refused", "reverted"].includes(effect.status)) {
    return {
      ok: true,
      replayed: true,
      row: effect,
      verdict: effect.verdict || { decision: "replay", failed: [], passed: [] }
    };
  }

  const verdict = await judgeEffect({ db, effect, goal, authorization, config, nowMs });

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
    return { ok: true, row, verdict, executed: false };
  }

  // Released. In shadow/dry_run the verdict is recorded and nothing is
  // performed — this is the corpus that earns Rung 4.
  if (effectiveMode !== "live") {
    const row = await db.AutonomyOutbox.setVerdict(effect.id, {
      status: "would_release",
      verdict,
      releasedMs: nowMs
    });
    await db.OutboxEvent.append({
      outbox_id: effect.id,
      from_status: effect.status,
      to_status: "would_release",
      detail: { mode: effectiveMode, note: "verdict recorded, nothing performed" }
    });
    return { ok: true, row, verdict, executed: false, wouldRelease: true };
  }

  const executor = EXECUTORS[effect.effect_type];
  if (!executor) {
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
    const settled = await executor({ db, effect, signal });
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
    return { ok: true, row, verdict, executed: true, receipt, output: output || null };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 400);
    const row = await db.AutonomyOutbox.setVerdict(effect.id, {
      status: "failed",
      verdict,
      error: message
    });
    await db.OutboxEvent.append({
      outbox_id: effect.id,
      from_status: effect.status,
      to_status: "failed",
      detail: { error: message }
    });
    return { ok: true, row, verdict, executed: false, error: message };
  }
}

/**
 * Reversal is a NEW ROW. The original is never edited or deleted, so the
 * record keeps both the attempt and the reversal.
 */
export async function revertEffect({ db, effectId, reason = null, nowMs = Date.now() }) {
  const effect = await db.AutonomyOutbox.get(effectId);
  if (!effect) return { ok: false, error: "effect not found" };
  const row = await db.AutonomyOutbox.setVerdict(effect.id, {
    status: "reverted",
    verdict: { decision: "revert", revertedFrom: effect.status },
    receipt: { revertedAtMs: nowMs, reason: String(reason || "").slice(0, 300) }
  });
  await db.OutboxEvent.append({
    outbox_id: effect.id,
    from_status: effect.status,
    to_status: "reverted",
    detail: { reason: String(reason || "").slice(0, 300) }
  });
  return { ok: true, row };
}

/** The evidence gate reads this: how has the Governor actually been ruling? */
export async function shadowCorpus(db, workspaceId, limit = 200) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  const rows = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM autonomy_outbox
      WHERE workspace_id = $1
      GROUP BY status`, [workspaceId]
  );
  const byStatus = Object.fromEntries((rows || []).map(r => [r.status, Number(r.n)]));
  const recent = await db.AutonomyOutbox.list(workspaceId, { limit: safeLimit });
  return {
    byStatus,
    samples: recent.length,
    wouldRelease: byStatus.would_release || 0,
    refused: byStatus.refused || 0,
    released: byStatus.released || 0,
    recent: recent.slice(0, 25)
  };
}
