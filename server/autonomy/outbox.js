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

/** Stable hash: key order in the payload must not change the key. */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

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
    return { delivered: true, noticeId: row.id, templateId: row.template_id };
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
export async function decideEffect({ db, effectId, goal, authorization = null, config, mode = null, nowMs = Date.now() }) {
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
    const receipt = await executor({ db, effect });
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
      detail: { receipt: receipt.noticeId ? { noticeId: receipt.noticeId } : receipt }
    });
    return { ok: true, row, verdict, executed: true, receipt };
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
