// Phase 15.4 — the Adaptive Orchestrator, in OBSERVE MODE ONLY.
//
// It records which strategy would be selected for a run, and why, together with
// the signals it saw. It makes NO live switches: `switched` is always false, the
// strategy that runs is the strategy that would have run anyway, and the row is
// written after the fact as an observation.
//
// The switching logic does exist (evaluateSwitch, behind explicit evidence
// thresholds) because a threshold nobody wrote down is not a threshold. It is
// dark in v1 and the law phase15.observe_only is what keeps it dark: even if
// COGNOS_ADAPTIVE_MODE=auto is set, resolveAdaptiveMode() refuses it and the
// Policy Engine refuses the adaptation. Nothing changes from a single success —
// SWITCH_THRESHOLDS.minRunsPerArm is 20 runs per arm plus 10 evaluation trials.

import { CANONICAL_STRATEGY_ID, ensureStrategiesSeeded } from "./strategies.js";
import { lawById } from "../council/laws.js";

export const OBSERVE_MODE = "observe";

export const SWITCH_THRESHOLDS = Object.freeze({
  minRunsPerArm: 20,
  minEvalTrials: 10,
  latencyImprovementPct: 20,
  costImprovementPct: 0,
  vetoRateMaxDelta: 0,
  errorRateMaxDelta: 0.02,
  contradictionMaxDelta: 0,
  confidenceMinDelta: -0.05
});

/** v1 refuses any mode but observe, and says which law did the refusing. */
export function resolveAdaptiveMode(requested = process.env.COGNOS_ADAPTIVE_MODE) {
  const law = lawById("phase15.observe_only");
  const want = String(requested || "observe").toLowerCase();
  if (want !== "observe") {
    return {
      mode: OBSERVE_MODE,
      requested: want,
      forced: true,
      law: law?.id ?? "phase15.observe_only",
      reason: `'${want}' is refused in v1: ${law?.statement ?? "observe mode only"}`
    };
  }
  return { mode: OBSERVE_MODE, requested: want, forced: false, law: law?.id ?? "phase15.observe_only", reason: "observe is the v1 default" };
}

/** Deterministic signal match. With one seeded strategy this always selects the
 *  canonical pipeline; the scoring exists so a second row would have to earn it. */
export function scoreStrategy(strategy, signals = {}) {
  const s = strategy?.selection_signals || {};
  const reasons = [];
  let score = 0;

  if (Array.isArray(s.complexity)) {
    if (!signals.complexity || s.complexity.includes(signals.complexity)) { score += 2; reasons.push(`complexity '${signals.complexity || "unknown"}' in [${s.complexity.join(", ")}]`); }
    else reasons.push(`complexity '${signals.complexity}' not covered`);
  }
  if (Array.isArray(s.task_types)) {
    if (!signals.taskType || s.task_types.includes(signals.taskType)) { score += 2; reasons.push(`task_type '${signals.taskType || "unknown"}' in scope`); }
    else reasons.push(`task_type '${signals.taskType}' out of scope`);
  }
  if (Array.isArray(s.needs_decomposition)) {
    if (signals.needsDecomposition === undefined || s.needs_decomposition.includes(signals.needsDecomposition)) { score += 1; reasons.push("decomposition signal covered"); }
  }
  if (Array.isArray(s.needs_web_search)) {
    if (signals.needsWebSearch === undefined || s.needs_web_search.includes(signals.needsWebSearch)) { score += 1; reasons.push("web-search signal covered"); }
  }
  if (typeof s.min_history_messages === "number") {
    if ((signals.historyMessages ?? 0) >= s.min_history_messages) { score += 1; reasons.push(`history ${signals.historyMessages ?? 0} >= ${s.min_history_messages}`); }
    else reasons.push(`history ${signals.historyMessages ?? 0} < ${s.min_history_messages}`);
  }
  if (strategy?.is_default) { score += 3; reasons.push("is the default strategy"); }
  if (strategy?.enabled === false) { score = -1; reasons.push("disabled"); }

  return { strategyId: strategy?.id ?? null, score, reasons };
}

/**
 * The selection. Called before the pipeline runs, with the signals known at that
 * point; the post-run signals are attached when the decision is recorded.
 */
export async function selectStrategy({ db, signals = {}, logger = null }) {
  const mode = resolveAdaptiveMode();
  let strategies = [];
  try {
    await ensureStrategiesSeeded(db, { logger });
    strategies = await db.Strategy.list({ includeDisabled: false });
  } catch (e) {
    logger?.warn?.("strategy selection could not read the registry", { error: String(e) });
  }

  const scored = (strategies.length ? strategies : [{ id: CANONICAL_STRATEGY_ID, selection_signals: {}, is_default: true, enabled: true }])
    .map(s => ({ strategy: s, ...scoreStrategy(s, signals) }))
    .sort((a, b) => b.score - a.score || String(a.strategyId).localeCompare(String(b.strategyId)));

  const chosen = scored[0];
  // There is always a path: if the registry is empty or unreadable the canonical
  // pipeline runs. The council is never left without a strategy.
  const strategyId = chosen?.strategyId || CANONICAL_STRATEGY_ID;
  return {
    mode: mode.mode,
    adaptiveModeResolution: mode,
    strategyId,
    selected: chosen?.strategy ?? { id: strategyId },
    candidates: scored.map(c => ({ strategy_id: c.strategyId, score: c.score, reasons: c.reasons })),
    reason: chosen ? `${chosen.strategy.name || chosen.strategyId} scored ${chosen.score} (${chosen.reasons.join("; ")})` : "registry unreadable — canonical pipeline by law pin.six_operators",
    switched: false,
    thresholds: SWITCH_THRESHOLDS
  };
}

/**
 * Would a switch be justified? Exists so the thresholds are real and testable.
 * In v1 it always returns switch:false and names the law that blocks it, even
 * when every evidence threshold is met.
 */
export function evaluateSwitch({ baseline, candidate, thresholds = SWITCH_THRESHOLDS } = {}) {
  const law = lawById("phase15.observe_only");
  const b = baseline || {};
  const c = candidate || {};
  const pct = (base, cand) => (base ? ((base - cand) / base) * 100 : 0);

  const checks = {
    enough_runs: { met: (c.runs ?? 0) >= thresholds.minRunsPerArm && (b.runs ?? 0) >= thresholds.minRunsPerArm, detail: `candidate runs ${c.runs ?? 0}/${thresholds.minRunsPerArm}, baseline runs ${b.runs ?? 0}/${thresholds.minRunsPerArm}` },
    enough_trials: { met: (c.eval_trials ?? 0) >= thresholds.minEvalTrials, detail: `evaluation trials ${c.eval_trials ?? 0}/${thresholds.minEvalTrials}` },
    latency: { met: pct(b.avg_latency_ms, c.avg_latency_ms) >= thresholds.latencyImprovementPct, detail: `${pct(b.avg_latency_ms, c.avg_latency_ms).toFixed(1)}% faster (needs ${thresholds.latencyImprovementPct}%)` },
    cost: { met: pct(b.avg_cost_usd, c.avg_cost_usd) >= thresholds.costImprovementPct, detail: `${pct(b.avg_cost_usd, c.avg_cost_usd).toFixed(1)}% cheaper (needs ${thresholds.costImprovementPct}%)` },
    veto_rate: { met: (c.veto_rate ?? 0) - (b.veto_rate ?? 0) <= thresholds.vetoRateMaxDelta, detail: `veto rate delta ${((c.veto_rate ?? 0) - (b.veto_rate ?? 0)).toFixed(4)} (max ${thresholds.vetoRateMaxDelta})` },
    error_rate: { met: (c.error_rate ?? 0) - (b.error_rate ?? 0) <= thresholds.errorRateMaxDelta, detail: `error rate delta ${((c.error_rate ?? 0) - (b.error_rate ?? 0)).toFixed(4)} (max ${thresholds.errorRateMaxDelta})` },
    coherence: { met: (c.contradictions ?? 0) - (b.contradictions ?? 0) <= thresholds.contradictionMaxDelta, detail: `contradiction delta ${(c.contradictions ?? 0) - (b.contradictions ?? 0)} (max ${thresholds.contradictionMaxDelta})` },
    confidence: { met: (c.avg_confidence ?? 0) - (b.avg_confidence ?? 0) >= thresholds.confidenceMinDelta, detail: `confidence delta ${((c.avg_confidence ?? 0) - (b.avg_confidence ?? 0)).toFixed(4)} (min ${thresholds.confidenceMinDelta})` }
  };
  const met = Object.entries(checks).filter(([, v]) => v.met).map(([k]) => k);
  const unmet = Object.entries(checks).filter(([, v]) => !v.met).map(([k]) => k);
  const evidenceSufficient = unmet.length === 0;

  return {
    switch: false,                                  // v1: never
    blockedBy: law?.id ?? "phase15.observe_only",
    blockedReason: law?.statement ?? "observe mode only in v1",
    evidenceSufficient,
    met,
    unmet,
    checks,
    thresholds,
    // The single-success guard, stated explicitly: one good run is not evidence.
    singleSuccessGuard: (c.runs ?? 0) < thresholds.minRunsPerArm
      ? `refused: ${c.runs ?? 0} run(s) is below the ${thresholds.minRunsPerArm}-run evidence floor`
      : null
  };
}

/** Append the observation. Best-effort: a telemetry write never fails a turn. */
export async function recordDecision(db, { runId, selection, signals = {}, evidence = null, logger = null }) {
  try {
    return await db.AdaptiveDecision.create({
      run_id: runId,
      mode: selection?.mode || OBSERVE_MODE,
      selected_strategy_id: selection?.strategyId || CANONICAL_STRATEGY_ID,
      would_select_id: selection?.strategyId || CANONICAL_STRATEGY_ID,
      reason: selection?.reason || "canonical pipeline (only strategy registered)",
      signals,
      switched: false,
      switch_blocked_by: lawById("phase15.observe_only")?.id ?? "phase15.observe_only",
      evidence: evidence ?? { candidates: selection?.candidates ?? [], thresholds: SWITCH_THRESHOLDS }
    });
  } catch (e) {
    logger?.warn?.("adaptive decision could not be recorded", { error: String(e) });
    return null;
  }
}
