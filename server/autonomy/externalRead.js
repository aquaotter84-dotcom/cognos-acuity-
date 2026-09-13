// T3 external reads, skill-side — Phase 20.
//
// A T3 skill (web.fetch, web.search) stages an `external_read` effect, the
// Action Governor judges it, and only a live-mode release verdict performs
// anything. This module is the single place where that verdict is interpreted,
// so replay, shadow, and refusal mean the same thing for every read skill.
//
// Idempotency, per op:
//
//   * fetch — keyed by (goal, url, scope hash). Re-asking the same URL replays
//     the prior verdict and re-reads the immutable snapshot the first read
//     created — one fetch, however many steps cite it. The scope hash is part
//     of the key, so a widened authorization re-judges instead of replaying a
//     stale refusal. A `failed` row retries naturally: decideEffect only
//     replays terminal success/refusal states, so a transient DNS blip does
//     not brick a destination for the rest of the goal.
//   * search — keyed by (goal, query, scope hash, step). Provider results are
//     never stored, so there is nothing to replay from; each step's search is
//     judged fresh. A crash between steps may repeat one provider call —
//     bounded, rate-limited, and side-effect-free.
//
// Shadow mode performs nothing: the verdict is recorded, the planner is told
// `shadow: true`, and no socket opens. That is the corpus Rung 4 will be
// judged on.

import { stageEffect, decideEffect } from "./outbox.js";

const EXCERPT_CHARS = 4000;

function rulesOf(verdict) {
  return rulesList(verdict).join(", ") || "refused";
}

/**
 * The rule ids that fired, as a list. The tick reads this to tell a ceiling
 * (park now) from an obstacle (retry, then park on the failure brake).
 */
function rulesList(verdict) {
  return (verdict?.failed || []).map(f => f.rule).filter(Boolean);
}

/**
 * Stage, judge, and (on a live release) perform one external read.
 *
 * @returns {{ok, output?, error?, effectId, effects: {staged, released, refused, shadowed}}}
 */
export async function requestExternalRead({
  db, goal, agentId = null, tickId = null, stepId = null,
  skillId, payload, config, signal = null, nowMs = Date.now()
}) {
  const effects = { staged: 0, released: 0, refused: 0, shadowed: 0 };
  const fresh = (await db.AutonomyGoal.get(goal.id)) || goal;
  const authorization = await db.GoalAuthorization.current(goal.id, nowMs);

  const { row, deduplicated } = await stageEffect({
    db,
    workspaceId: fresh.workspace_id,
    agentId,
    goalId: fresh.id,
    tickId,
    stepId,
    skillId,
    effectType: "external_read",
    tier: "T3",
    payload: { ...payload, scopeSha256: authorization?.scope_sha256 || null },
    mode: config?.outboxMode || "shadow"
  });
  if (!row) return { ok: false, error: "the read could not be staged", effectId: null, effects };
  if (!deduplicated) effects.staged += 1;

  const decision = await decideEffect({
    db, effectId: row.id, goal: fresh, authorization,
    config, nowMs, signal
  });
  if (!decision.ok) {
    return { ok: false, error: decision.error || "the read could not be judged", effectId: row.id, effects };
  }

  // A replayed release re-reads the snapshot the first read created — the
  // excerpt travels from the immutable row, never from a stored verdict.
  if (decision.replayed) {
    const status = decision.row?.status;
    if (status === "released" && payload.op === "fetch") {
      const sourceId = decision.row?.receipt?.sourceId || null;
      const full = sourceId ? await db.Source.get(sourceId, fresh.workspace_id) : null;
      if (!full) {
        return { ok: false, error: "the prior read's snapshot is missing", effectId: row.id, effects };
      }
      const excerpt = String(full.extracted_text || "").slice(0, EXCERPT_CHARS);
      return { ok: true, effectId: row.id, effects, replayed: true, output: {
        sourceId: full.id, name: full.name, excerpt,
        excerptChars: excerpt.length, riskFlags: full.risk_flags || []
      } };
    }
    if (status === "would_release") {
      effects.shadowed += 1;
      return { ok: true, effectId: row.id, effects, replayed: true,
        output: { shadow: true, note: "shadow mode: judged, recorded, not performed" } };
    }
    effects.refused += 1;
    return { ok: false, error: `read refused on replay: ${rulesOf(decision.verdict)}`,
      rules: rulesList(decision.verdict), effectId: row.id, effects };
  }

  if (decision.verdict?.decision === "refuse") {
    effects.refused += 1;
    return { ok: false, error: `read refused: ${rulesOf(decision.verdict)}`,
      rules: rulesList(decision.verdict), effectId: row.id, effects };
  }
  if (decision.wouldRelease) {
    effects.shadowed += 1;
    return { ok: true, effectId: row.id, effects,
      output: { shadow: true, note: "shadow mode: judged, recorded, not performed" } };
  }
  if (decision.executed) {
    effects.released += 1;
    return { ok: true, effectId: row.id, effects,
      output: { ...(decision.output || {}), effectId: row.id } };
  }
  return { ok: false, error: decision.error || decision.row?.error_message || "the read failed", effectId: row.id, effects };
}
