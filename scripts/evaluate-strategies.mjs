#!/usr/bin/env node
/**
 * scripts/evaluate-strategies.mjs — the Phase 15.3 offline evaluation harness.
 *
 *     node scripts/evaluate-strategies.mjs --prompt "Summarize the risks of X"
 *     node scripts/evaluate-strategies.mjs --prompt "..." --trials 5 --style concise
 *     node scripts/evaluate-strategies.mjs --prompt "..." --arm-a council_pipeline --arm-b council_pipeline
 *     node scripts/evaluate-strategies.mjs --prompt "..." --json > eval.json
 *
 * OFFLINE AND OPERATOR-INVOKED. There is no HTTP route that runs an evaluation
 * on a user's turn: this script is how the system studies itself, and a human
 * decides when that study happens. Each trial creates a fresh, archived
 * conversation so trials cannot contaminate each other.
 *
 * Scoring (server/meta/evaluate.js): latency .40, cost .20, veto rate .25
 * (a quality proxy — the Governor refusing a draft is a signal, not a bug),
 * coherence .15. Budgets: 60s and $0.05 per trial.
 *
 * v1 seeds exactly ONE strategy (the canonical council pipeline), so arm A and
 * arm B are the same strategy unless a second row exists. That is deliberate:
 * the harness measures the strategy that actually runs, rigorously, instead of
 * inventing speculative diversity. With identical arms the spread between them
 * is run-to-run variance — the script says so rather than declaring a winner
 * that means nothing.
 *
 * Requires DATABASE_URL and a model key. Nothing here is user-facing and
 * nothing here switches a strategy (pin.observe_only): the adaptive
 * orchestrator records what it would do and why.
 */
import { runStrategyEvaluation } from "../server/meta/evaluate.js";
import { CANONICAL_STRATEGY_ID } from "../server/meta/strategies.js";
import { SWITCH_THRESHOLDS, evaluateSwitch } from "../server/meta/adaptive.js";
import { SCORE_WEIGHTS, SCORE_BUDGETS } from "../server/meta/evaluate.js";
import { createLogger } from "../server/shared/logging.js";
import { num, int } from "../server/db/util.js";

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const asJson = argv.includes("--json");

const prompt = flag("prompt", "In two sentences, what is the difference between a belief and a hypothesis?");
const trials = Math.max(1, int(flag("trials", 3), 3));
const style = flag("style", "balanced");
const armA = flag("arm-a", CANONICAL_STRATEGY_ID);
const armB = flag("arm-b", CANONICAL_STRATEGY_ID);
const logger = createLogger("evaluate");

const money = (v) => (v === null || v === undefined ? "n/a" : `$${Number(v).toFixed(5)}`);
const ms = (v) => (v === null || v === undefined ? "n/a" : `${Math.round(v)}ms`);

if (!asJson) {
  console.log("Phase 15.3 — offline strategy evaluation harness");
  console.log(`prompt : ${prompt}`);
  console.log(`arms   : A=${armA}  B=${armB}   trials per arm: ${trials}   style: ${style}`);
  console.log(`weights: latency ${SCORE_WEIGHTS.latency}, cost ${SCORE_WEIGHTS.cost}, veto ${SCORE_WEIGHTS.veto}, coherence ${SCORE_WEIGHTS.coherence}`);
  console.log(`budgets: ${SCORE_BUDGETS.latencyMs}ms, ${money(SCORE_BUDGETS.costUsd)} per trial\n`);
}

const started = Date.now();
const result = await runStrategyEvaluation({
  prompt,
  trials,
  style,
  arms: [{ name: "A", strategyId: armA }, { name: "B", strategyId: armB }],
  logger,
  onProgress: ({ arm, trial, record }) => {
    if (asJson) return;
    console.log(`  [${arm}#${trial}] ${record.status.padEnd(7)} score=${num(record.score, 0).toFixed(3)} latency=${ms(record.latency_ms)} ttft=${ms(record.time_to_first_token_ms)} cost=${money(record.cost_usd)} vetoed=${record.vetoed} coherence=${record.coherence_verdict ?? "n/a"} failures=${record.failures.length}`);
  }
});

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\ncompleted ${result.trials.length} trial(s) in ${Date.now() - started}ms  (evaluation ${result.evaluation_id})\n`);
  for (const arm of result.arms) {
    console.log(`arm ${arm.arm} (${arm.strategy_id})`);
    console.log(`   trials ${arm.trials}  ok ${arm.successes}  avg score ${num(arm.avg_score, 0).toFixed(3)}  p50 latency ${ms(arm.p50_latency_ms)}  avg latency ${ms(arm.avg_latency_ms)}`);
    const errorRate = arm.trials ? arm.errors / arm.trials : 0;
    console.log(`   avg cost ${money(arm.avg_cost_usd)}  veto rate ${num(arm.veto_rate, 0).toFixed(2)}  contradictions ${int(arm.contradictions, 0)}  errors ${arm.errors} (${errorRate.toFixed(2)})  tokens measured=${arm.tokens_measured}`);
  }
  if (result.identical_arms) {
    console.log(`\nnote: ${result.note}`);
  }
  console.log(`\nswitch analysis (observe mode — nothing is switched in v1):`);
  console.log(`   ${JSON.stringify(result.switch_analysis ?? evaluateSwitch({ baseline: result.arms[0], candidate: result.arms[1] }))}`);
  console.log(`   thresholds: minRunsPerArm=${SWITCH_THRESHOLDS.minRunsPerArm}, minEvalTrials=${SWITCH_THRESHOLDS.minEvalTrials}, latencyImprovementPct=${SWITCH_THRESHOLDS.latencyImprovementPct}`);
  console.log(`   winner by score: ${result.winner ? `${result.winner.arm} (${num(result.winner.avg_score, 0).toFixed(3)})` : "none"}`);
  console.log(`   action taken: none. The adaptive orchestrator records the decision; a human changes the code.`);
}

process.exit(result.trials.some(t => t.status !== "success") && result.arms.every(a => a.successes === 0) ? 1 : 0);
