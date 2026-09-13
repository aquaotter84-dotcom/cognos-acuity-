// T4 external writes, skill-side — Phase 21.
//
// The mirror of externalRead.js, and the asymmetry is the whole point: a read
// that repeats costs a fetch, a write that repeats fires a trigger twice. So
// this module is stricter about replay.
//
//   * the idempotency key is (goal, url, body) and NOTHING else — not the scope
//     hash, not the tick, not the step. The scope hash travels in its own
//     column so the Governor can still detect a stale scope without widening
//     the key. A re-authorization must never make the same delivery stageable
//     twice (AUTONOMY.md §8.10d).
//   * a replayed `released` row returns the PRIOR receipt. It does not deliver
//     again, and it does not pretend to: `replayed: true` is in the result.
//   * a replayed `would_release` row is still a shadow: nothing was performed.
//   * a `failed` row is re-judged and may be retried, because the common
//     failure is a socket that never connected. The receiver dedupes on
//     `X-COGNOS-Idempotency-Key`, which is on every request for exactly this
//     reason.
//   * a delivery the receiver rejected is reported as released-but-not-accepted.
//     The bytes left; the row says `released`; the step says failed. Both are
//     true and neither is allowed to hide the other.

import { stageEffect, decideEffect } from "./outbox.js";

function rulesOf(verdict) {
  return (verdict?.failed || []).map(f => f.rule).filter(Boolean).join(", ") || "refused";
}

/**
 * Stage, judge, and — only on a live verdict that has earned it — perform one
 * external write.
 *
 * @returns {{ok, output?, error?, effectId, released?, replayed?, effects}}
 */
export async function requestExternalWrite({
  db, goal, agentId = null, tickId = null, stepId = null,
  skillId, payload, destination = null, keyPayload = null, config, signal = null,
  nowMs = Date.now(), transport = null, resolve = null
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
    effectType: "external_write",
    tier: "T4",
    payload,
    keyPayload,
    destination: destination || (typeof payload?.url === "string" ? payload.url : null),
    scopeSha256: authorization?.scope_sha256 || null,
    mode: config?.outboxMode || "shadow"
  });
  if (!row) return { ok: false, error: "the write could not be staged", effectId: null, effects };
  if (!deduplicated) effects.staged += 1;

  const decision = await decideEffect({
    db, effectId: row.id, goal: fresh, authorization,
    config, nowMs, signal, transport, resolve
  });
  if (!decision.ok) {
    return { ok: false, error: decision.error || "the write could not be judged", effectId: row.id, effects };
  }

  // --- replay ----------------------------------------------------------------
  if (decision.replayed) {
    const status = decision.row?.status;
    if (status === "released") {
      // Already delivered. The receipt is the record; a second send is the one
      // thing this path must never do.
      effects.released += 1;
      const receipt = decision.row?.receipt || {};
      return {
        ok: receipt.accepted !== false,
        replayed: true,
        effectId: row.id,
        effects,
        released: true,
        output: {
          replayed: true,
          delivered: receipt.accepted !== false,
          accepted: receipt.accepted !== false,
          status: receipt.status ?? null,
          url: receipt.url ?? destination,
          attempts: receipt.attempts ?? null,
          sentAt: receipt.sentAt ?? null,
          note: "this delivery already happened; the recorded receipt is returned instead of sending again"
        },
        error: receipt.accepted === false
          ? `the earlier delivery was released and the receiver answered ${receipt.status}`
          : null
      };
    }
    if (status === "would_release") {
      effects.shadowed += 1;
      return { ok: true, effectId: row.id, effects, replayed: true, shadow: true,
        output: { shadow: true, note: "shadow mode: judged, recorded, not delivered" } };
    }
    effects.refused += 1;
    return { ok: false, error: `write refused on replay: ${rulesOf(decision.verdict)}`, effectId: row.id, effects };
  }

  // --- fresh decision --------------------------------------------------------
  if (decision.verdict?.decision === "refuse") {
    effects.refused += 1;
    return {
      ok: false,
      error: `write refused: ${rulesOf(decision.verdict)}`,
      rules: (decision.verdict.failed || []).map(f => f.rule),
      effectId: row.id,
      effects
    };
  }

  if (decision.wouldRelease) {
    effects.shadowed += 1;
    return {
      ok: true,
      effectId: row.id,
      effects,
      shadow: true,
      output: {
        shadow: true,
        dryRun: (config?.outboxMode || "shadow") === "dry_run",
        request: decision.receipt?.request || null,
        note: decision.receipt?.dryRun
          ? "dry run: the exact request was built and recorded, and nothing was sent"
          : "shadow mode: judged, recorded, not delivered"
      }
    };
  }

  if (decision.executed) {
    effects.released += 1;
    const receipt = decision.receipt || {};
    const accepted = receipt.accepted !== false;
    return {
      ok: accepted,
      effectId: row.id,
      effects,
      released: true,
      output: { ...(decision.output || {}), effectId: row.id },
      // Released and rejected is not a success, but it is not a non-event
      // either: the trigger fired. The step fails so the goal notices, and the
      // outbox row stays `released` so the ledger does not lie.
      error: accepted ? null
        : `released, but the receiver answered ${receipt.status ?? "an unknown status"}`
    };
  }

  return {
    ok: false,
    released: false,
    error: decision.error || decision.row?.error_message || "the delivery failed",
    effectId: row.id,
    effects
  };
}
