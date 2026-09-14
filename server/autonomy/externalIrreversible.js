// T5 irreversible effects, skill-side — Phase 22 (autonomy row, second slice).
//
// The mirror of externalWrite.js, and the difference is the release rule. A T4
// write releases on a rung flag plus a recorded shadow corpus; a T5 effect
// releases on a rung flag plus a HUMAN APPROVAL ROW naming this exact outbox id
// (pin.irreversible_human_approval). The stage-and-judge machinery is the same,
// so replay, shadow and refusal mean the same thing:
//
//   * the idempotency key is (goal, url, body) and NOTHING else, exactly as it
//     is for a webhook — a re-authorization or a reworded reason cannot make
//     the same publish stageable twice;
//   * a replayed `released` row returns the prior receipt and publishes nothing
//     again;
//   * a replayed `would_release` row is still a shadow: nothing was performed;
//   * a `failed` row is re-judged and may be retried;
//   * in shadow, a T5 effect is refused with T5_NEEDS_HUMAN because no approval
//     names it — the loop stages and judges, and only the human decides whether
//     the publish actually happens.

import { stageEffect, decideEffect } from "./outbox.js";

function rulesOf(verdict) {
  return (verdict?.failed || []).map(f => f.rule).filter(Boolean).join(", ") || "refused";
}

/**
 * Stage, judge, and — only on a live verdict that a human approval released —
 * perform one irreversible publish.
 *
 * @returns {{ok, output?, error?, effectId, released?, replayed?, effects}}
 */
export async function requestIrreversible({
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
    effectType: "irreversible",
    tier: "T5",
    payload,
    keyPayload,
    destination: destination || (typeof payload?.url === "string" ? payload.url : null),
    scopeSha256: authorization?.scope_sha256 || null,
    mode: config?.outboxMode || "shadow"
  });
  if (!row) return { ok: false, error: "the publish could not be staged", effectId: null, effects };
  if (!deduplicated) effects.staged += 1;

  const decision = await decideEffect({
    db, effectId: row.id, goal: fresh, authorization,
    config, nowMs, signal, transport, resolve
  });
  if (!decision.ok) {
    return { ok: false, error: decision.error || "the publish could not be judged", effectId: row.id, effects };
  }

  // --- replay ----------------------------------------------------------------
  if (decision.replayed) {
    const status = decision.row?.status;
    if (status === "released") {
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
          note: "this publish already happened; the recorded receipt is returned instead of publishing again"
        },
        error: receipt.accepted === false
          ? `the earlier publish was released and the receiver answered ${receipt.status}`
          : null
      };
    }
    if (status === "would_release") {
      effects.shadowed += 1;
      return { ok: true, effectId: row.id, effects, replayed: true, shadow: true,
        output: { shadow: true, note: "shadow mode: judged, recorded, not published" } };
    }
    effects.refused += 1;
    return { ok: false, error: `publish refused on replay: ${rulesOf(decision.verdict)}`, effectId: row.id, effects };
  }

  // --- fresh decision --------------------------------------------------------
  if (decision.verdict?.decision === "refuse") {
    effects.refused += 1;
    return {
      ok: false,
      error: `publish refused: ${rulesOf(decision.verdict)}`,
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
          ? "dry run: the exact request was built and recorded, and nothing was published"
          : "shadow mode: judged, recorded, not published"
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
      error: accepted ? null
        : `published, but the receiver answered ${receipt.status ?? "an unknown status"}`
    };
  }

  return {
    ok: false,
    released: false,
    error: decision.error || decision.row?.error_message || "the publish failed",
    effectId: row.id,
    effects
  };
}
