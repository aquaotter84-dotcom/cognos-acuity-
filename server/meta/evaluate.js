// Phase 15.3 — the Evaluation Harness. Offline and operator-invoked: there is no
// route to it, no button in the UI, and it never runs on a user's turn.
//
//     node scripts/evaluate-strategies.mjs --prompt "..." --trials 3
//
// It drives the SAME prompt through two arms and scores each trial on latency,
// cost, veto rate (a quality proxy: a veto means the council produced something
// the Governor would not ship) and coherence. Every trial is a real council run,
// so it produces a real telemetry record, and the results are written to
// strategy_evaluations for the Policy Engine to cite as evidence.
//
// HONEST NOTE ON v1 SCOPE: the registry holds exactly one strategy
// (council_pipeline), so arm A and arm B are the same strategy by default. That
// is not a stub — it measures the run-to-run variance of the pipeline that
// exists, which is the baseline any future strategy has to beat, and it exercises
// the whole comparison path (scoring, persistence, the switch thresholds) so
// adding a second strategy later is a registry row, not a subsystem.

import db from "../db.js";
import { newId, num, int, clamp01 } from "../db/util.js";
import { runCouncilTurn } from "../chatOrchestrate.js";
import { evaluateSwitch, SWITCH_THRESHOLDS } from "./adaptive.js";
import { CANONICAL_STRATEGY_ID, ensureStrategiesSeeded } from "./strategies.js";

export const SCORE_WEIGHTS = Object.freeze({ latency: 0.4, cost: 0.2, veto: 0.25, coherence: 0.15 });
export const SCORE_BUDGETS = Object.freeze({ latencyMs: 60_000, costUsd: 0.05 });
const COHERENCE_SCORE = Object.freeze({
  coherent: 1, confirmation: 1, mixed: 0.6, contradiction: 0.3,
  unverified: 0.7, unchecked: 0.7, error: 0.4
});

export function scoreTrial({ latencyMs = null, costUsd = null, vetoed = false, coherenceVerdict = null, status = "success" } = {}) {
  if (status === "error") {
    return { score: 0, parts: { latency: 0, cost: 0, veto: 0, coherence: 0 }, note: "the run failed; a failure scores zero" };
  }
  const latency = clamp01(1 - num(latencyMs, SCORE_BUDGETS.latencyMs) / SCORE_BUDGETS.latencyMs);
  const cost = clamp01(1 - num(costUsd, SCORE_BUDGETS.costUsd) / SCORE_BUDGETS.costUsd);
  const veto = vetoed ? 0 : 1;
  const coherence = COHERENCE_SCORE[coherenceVerdict] ?? 0.7;
  const score = Number((100 * (SCORE_WEIGHTS.latency * latency + SCORE_WEIGHTS.cost * cost + SCORE_WEIGHTS.veto * veto + SCORE_WEIGHTS.coherence * coherence)).toFixed(2));
  return { score, parts: { latency: Number(latency.toFixed(3)), cost: Number(cost.toFixed(3)), veto, coherence }, weights: SCORE_WEIGHTS };
}

function summarizeArm(arm, trials) {
  const ok = trials.filter(t => t.status === "success");
  const mean = (arr, f) => (arr.length ? Number((arr.reduce((a, t) => a + f(t), 0) / arr.length).toFixed(4)) : null);
  const latencies = ok.map(t => t.latency_ms).filter(v => v != null).sort((a, b) => a - b);
  return {
    arm: arm.name,
    strategy_id: arm.strategyId,
    trials: trials.length,
    successes: ok.length,
    errors: trials.length - ok.length,
    avg_latency_ms: mean(ok, t => num(t.latency_ms, 0)),
    p50_latency_ms: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    min_latency_ms: latencies[0] ?? null,
    max_latency_ms: latencies.at(-1) ?? null,
    avg_time_to_first_token_ms: mean(ok, t => num(t.time_to_first_token_ms, 0)),
    total_cost_usd: Number(trials.reduce((a, t) => a + num(t.cost_usd, 0), 0).toFixed(6)),
    avg_cost_usd: mean(ok, t => num(t.cost_usd, 0)),
    veto_rate: trials.length ? Number((trials.filter(t => t.vetoed).length / trials.length).toFixed(4)) : 0,
    vetoes: trials.filter(t => t.vetoed).length,
    contradictions: trials.reduce((a, t) => a + int(t.coherence_contradictions, 0), 0),
    avg_confidence: mean(ok, t => num(t.confidence, null) ?? 0),
    avg_score: mean(trials, t => num(t.score, 0)),
    tokens_measured: trials.some(t => t.tokens_measured),
    tokens_total: trials.reduce((a, t) => a + int(t.tokens_total, 0), 0),
    failures: trials.flatMap(t => t.failures || [])
  };
}

/**
 * @param {object} opts
 * @param {string} opts.prompt           the prompt every arm receives
 * @param {Array}  [opts.arms]           [{name:'A', strategyId}, {name:'B', strategyId}]
 * @param {number} [opts.trials]         runs per arm (default 3)
 * @param {string} [opts.workspaceId]    defaults to the single workspace
 * @param {boolean}[opts.archive]        archive the evaluation conversations afterwards (default true)
 */
export async function runStrategyEvaluation({
  prompt, arms = null, trials = 3, workspaceId = null, style = "balanced",
  archive = true, logger = null, onProgress = null
} = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error("runStrategyEvaluation needs a prompt");
  const evaluationId = newId("eval");
  const ws = workspaceId ? await db.Workspace.get(workspaceId) : await db.Workspace.ensureDefault();
  await ensureStrategiesSeeded(db, { logger });

  const resolvedArms = (arms && arms.length ? arms : [
    { name: "A", strategyId: CANONICAL_STRATEGY_ID },
    { name: "B", strategyId: CANONICAL_STRATEGY_ID }
  ]).map(a => ({ name: a.name, strategyId: a.strategyId || CANONICAL_STRATEGY_ID }));

  const startedAt = Date.now();
  const perArm = new Map(resolvedArms.map(a => [a.name, []]));
  const conversations = [];

  for (const arm of resolvedArms) {
    for (let trial = 1; trial <= trials; trial++) {
      const conversation = await db.Conversation.create({
        workspace_id: ws.id,
        title: `[eval ${evaluationId}] ${arm.name}#${trial} — ${String(prompt).slice(0, 40)}`,
        last_message_preview: `[evaluation harness] ${String(prompt).slice(0, 80)}`
      });
      conversations.push(conversation.id);

      let runId = null;
      let status = "success";
      let error = null;
      let response = null;
      try {
        const result = await runCouncilTurn(
          { conversationId: conversation.id, workspaceId: ws.id, userMessage: prompt, style },
          { emit: () => {}, onToken: null }
        );
        runId = result?.runId ?? result?.council?.telemetry?.runId ?? null;
        response = result?.response ?? null;
      } catch (e) {
        status = "error";
        error = String(e?.message || e);
        logger?.warn?.("evaluation trial failed", { arm: arm.name, trial, error });
      }

      const rec = runId ? await db.TelemetryRun.get(runId).catch(() => null) : null;
      const scored = scoreTrial({
        latencyMs: rec?.latency_ms ?? null,
        costUsd: rec?.cost_usd ?? null,
        vetoed: rec?.vetoed === true,
        coherenceVerdict: rec?.coherence_verdict ?? null,
        status
      });

      const row = await db.StrategyEvaluation.create({
        evaluation_id: evaluationId,
        strategy_id: arm.strategyId,
        arm: arm.name,
        prompt: String(prompt).slice(0, 4000),
        trial,
        run_id: runId,
        latency_ms: rec?.latency_ms ?? null,
        cost_usd: rec?.cost_usd ?? null,
        vetoed: rec?.vetoed === true,
        coherence_verdict: rec?.coherence_verdict ?? null,
        status,
        score: scored.score,
        detail: {
          parts: scored.parts,
          weights: SCORE_WEIGHTS,
          time_to_first_token_ms: rec?.time_to_first_token_ms ?? null,
          tokens_total: rec?.tokens_total ?? null,
          tokens_measured: rec?.tokens_measured === true,
          confidence: rec?.confidence ?? null,
          contradictions: rec?.coherence_contradictions ?? null,
          failures: rec?.failures ?? [],
          model_calls: rec?.model_calls ?? null,
          ledger_events: rec?.ledger_events ?? null,
          conversation_id: conversation.id,
          response_chars: response ? String(response).length : null,
          error
        }
      }).catch(e => { logger?.warn?.("evaluation row could not be written", { error: String(e) }); return null; });

      const trialRecord = {
        arm: arm.name, trial, run_id: runId, status,
        latency_ms: rec?.latency_ms ?? null,
        time_to_first_token_ms: rec?.time_to_first_token_ms ?? null,
        cost_usd: num(rec?.cost_usd, null),
        tokens_total: int(rec?.tokens_total, 0),
        tokens_measured: rec?.tokens_measured === true,
        vetoed: rec?.vetoed === true,
        coherence_verdict: rec?.coherence_verdict ?? null,
        coherence_contradictions: int(rec?.coherence_contradictions, 0),
        confidence: num(rec?.confidence, null),
        failures: rec?.failures ?? [],
        score: scored.score,
        parts: scored.parts,
        evaluation_row_id: row?.id ?? null,
        error
      };
      perArm.get(arm.name).push(trialRecord);
      onProgress?.({ evaluationId, arm: arm.name, trial, trials, record: trialRecord });
    }
  }

  const arms_summary = resolvedArms.map(a => summarizeArm(a, perArm.get(a.name) || []));
  const [baseline, candidate] = arms_summary;
  const switchAnalysis = baseline && candidate && baseline.arm !== candidate.arm
    ? evaluateSwitch({
      baseline: { ...baseline, eval_trials: baseline.trials, runs: baseline.trials },
      candidate: { ...candidate, eval_trials: candidate.trials, runs: candidate.trials }
    })
    : evaluateSwitch({
      baseline: { ...(baseline || {}), eval_trials: baseline?.trials ?? 0, runs: baseline?.trials ?? 0 },
      candidate: { ...(candidate || baseline || {}), eval_trials: candidate?.trials ?? 0, runs: candidate?.trials ?? 0 }
    });

  if (archive) {
    for (const id of conversations) {
      await db.Conversation.update(id, { is_archived: true }).catch(() => null);
    }
  }

  const winner = arms_summary.slice().sort((a, b) => num(b.avg_score, 0) - num(a.avg_score, 0))[0] || null;
  return {
    evaluation_id: evaluationId,
    prompt: String(prompt),
    trials_per_arm: trials,
    started_at: new Date(startedAt).toISOString(),
    duration_ms: Date.now() - startedAt,
    workspace_id: ws.id,
    arms: arms_summary,
    trials: Array.from(perArm.values()).flat(),
    winner: winner ? { arm: winner.arm, strategy_id: winner.strategy_id, avg_score: winner.avg_score } : null,
    identical_arms: resolvedArms.length === 2 && resolvedArms[0].strategyId === resolvedArms[1].strategyId,
    note: resolvedArms.length === 2 && resolvedArms[0].strategyId === resolvedArms[1].strategyId
      ? "Both arms ran the same strategy: this measures the canonical pipeline's run-to-run variance, which is the baseline a future strategy must beat."
      : null,
    switch_analysis: switchAnalysis,
    thresholds: SWITCH_THRESHOLDS,
    conversations_archived: archive ? conversations.length : 0
  };
}
