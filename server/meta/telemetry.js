// Phase 15.1 — Reasoning Telemetry. The capture point.
//
// One record per orchestration run, and nothing is invisible:
//   * per-stage latency, model used and token usage, attributed from the
//     lifecycle events the existing in-memory bus already publishes — the
//     recorder SUBSCRIBES to server/shared/eventBus.js instead of threading new
//     callbacks through every operator (which is what the spec requires, and
//     also why no council operator changed for this phase);
//   * token counts measured from the provider's `usage` where it exposes one,
//     and estimated from characters where it does not, with tokensMeasured
//     saying which happened;
//   * cost from the editable rate table in server/meta/rates.js;
//   * the confidence the council already expresses (the Critic's score);
//   * the Coherence Monitor's consistency verdict;
//   * recovery and failure — timeouts, aborts, upstream HTTP errors, malformed
//     JSON — captured in server/llm.js so an abort becomes a record, not a
//     mystery;
//   * Governor vetoes, including which operator produced the rejected draft and
//     why the Governor refused it. The rejected text itself is never stored:
//     only its length and SHA-256, because a vetoed draft must not leak into
//     stored knowledge (pin.veto_integrity, pin.secrets_env_only).
//
// Telemetry is a side effect (pin.telemetry_side_effect): every write is
// best-effort, wrapped, and logged on failure. A telemetry failure can never
// fail a turn.

import { createHash } from "node:crypto";
import db from "../db.js";
import { newId, num, int } from "../db/util.js";
import { estimateCost, estimateTokensFromChars, rateFor } from "./rates.js";
import { CANONICAL_STRATEGY_ID } from "./strategies.js";
import { recordDecision } from "./adaptive.js";

const VETO_REASONS = Object.freeze({
  empty_response: "the draft was empty — the council would rather be silent than fabricate an answer",
  potential_secret_leak: "the draft matched a credential pattern, so it was stopped before it could leak a secret"
});

export function describeVeto(flags = []) {
  const list = Array.isArray(flags) ? flags : [];
  if (!list.length) return null;
  return list.map(f => VETO_REASONS[f] || `the Governor flagged '${f}'`).join("; ");
}

export function sha256(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex");
}

export function classifyFailure(obs = {}) {
  if (obs.status === "timeout") return "timeout";
  if (obs.status === "abort") return "abort";
  if (obs.status === "network_error") return "network";
  if (obs.status === "parse_error") return "malformed_json";
  const h = int(obs.httpStatus, 0);
  if (h === 429) return "rate_limited";
  if (h === 502 || h === 503 || h === 504) return "gateway";
  if (h >= 500) return "upstream_5xx";
  if (h === 401 || h === 403) return "auth";
  if (h >= 400) return "bad_request";
  return obs.status || "unknown";
}

export function createRunRecorder({
  runId, conversationId = null, workspaceId = null, userMessage = null,
  config = {}, logger = null, selection = null
} = {}) {
  const enabled = config?.telemetry?.enabled !== false;
  const startedMs = Date.now();

  let currentStage = null;
  let busAttached = false;
  let finalized = false;
  let written = null;

  const stageOrder = [];
  const stages = new Map();          // stage -> {runs, totalMs, lastStatus, startedMs, endedMs}
  const modelCalls = [];
  const failures = [];
  const models = new Set();

  let tokens = { prompt: 0, completion: 0, total: 0, measured: false, estimated: 0 };
  let cost = { usd: 0, rateKnown: true };
  let firstTokenMs = null;
  let confidence = null;
  let confidenceSource = null;
  let coherence = null;
  let veto = null;
  let knowledge = null;
  let ledgerEvents = 0;
  let result = null;

  function touchStage(stage, patch = {}) {
    if (!stage) return null;
    if (!stageOrder.includes(stage)) stageOrder.push(stage);
    const prev = stages.get(stage) || { stage, runs: 0, totalMs: 0, lastStatus: null, startedMs: null, endedMs: null };
    const next = { ...prev, ...patch };
    stages.set(stage, next);
    return next;
  }

  const recorder = {
    runId,
    enabled,
    get currentStage() { return currentStage; },

    /** Subscribe to the run's bus. Called once, right after the bus is created. */
    attachBus(eventBus) {
      if (!enabled || busAttached || !eventBus) return;
      busAttached = true;
      eventBus.subscribe("orchestration.stage.start", (e) => {
        currentStage = e?.stage ?? currentStage;
        touchStage(e?.stage, { startedMs: Date.now() });
      });
      eventBus.subscribe("orchestration.stage.complete", (e) => {
        const stage = e?.stage;
        const s = touchStage(stage, {
          runs: (stages.get(stage)?.runs ?? 0) + 1,
          totalMs: (stages.get(stage)?.totalMs ?? 0) + int(e?.ms, 0),
          lastStatus: e?.status || "success",
          endedMs: Date.now()
        });
        if (s && e?.status === "error" && e?.error) {
          failures.push({ kind: "stage_error", stage, message: String(e.error).slice(0, 400), at: Date.now() });
        }
        if (currentStage === stage) currentStage = null;
      });
    },

    /**
     * The single observation hook server/llm.js calls. One call per model
     * request, on every exit path: success, timeout, abort, HTTP error,
     * malformed JSON.
     */
    observeModelCall(obs = {}) {
      if (!enabled) return null;
      const stage = obs.purpose || obs.stage || currentStage || null;
      const status = obs.status || "success";
      const streamed = obs.streamed === true;

      // Tokens: measured when the provider reported usage, estimated from
      // characters when it did not. The record says which one happened.
      const usage = obs.usage || null;
      const measured = Boolean(usage && (usage.prompt_tokens != null || usage.completion_tokens != null || usage.total_tokens != null));
      const promptTokens = measured ? int(usage.prompt_tokens, 0) : estimateTokensFromChars(obs.promptChars);
      const completionTokens = measured
        ? int(usage.completion_tokens, 0)
        : (obs.completionTokens != null ? int(obs.completionTokens, 0) : estimateTokensFromChars(obs.charsOut));
      const totalTokens = measured ? int(usage.total_tokens, promptTokens + completionTokens) : promptTokens + completionTokens;
      const estimated = measured ? 0 : completionTokens;

      const priced = estimateCost({ model: obs.model, promptTokens, completionTokens });
      const call = {
        id: newId("tmc"),
        run_id: runId,
        seq: modelCalls.length + 1,
        stage,
        purpose: stage,
        model: obs.model || null,
        requested_model: obs.requestedModel || null,
        status,
        http_status: obs.httpStatus == null ? null : int(obs.httpStatus, null),
        latency_ms: obs.latencyMs == null ? null : int(obs.latencyMs, null),
        streamed,
        tokens_prompt: promptTokens,
        tokens_completion: completionTokens,
        tokens_total: totalTokens,
        tokens_measured: measured,
        chars_out: obs.charsOut == null ? null : int(obs.charsOut, null),
        cost_usd: priced.usd,
        error_class: status === "success" ? null : classifyFailure(obs),
        error_message: obs.errorMessage ? String(obs.errorMessage).slice(0, 500) : null,
        attempt: int(obs.attempt, 1),
        observed_at: Date.now()
      };
      modelCalls.push(call);
      if (obs.model) models.add(obs.model);

      tokens.prompt += promptTokens;
      tokens.completion += completionTokens;
      tokens.total += totalTokens;
      tokens.estimated += estimated;
      tokens.measured = tokens.measured || measured;
      cost.usd = Number((cost.usd + priced.usd).toFixed(6));
      if (!priced.rateKnown) cost.rateKnown = false;

      if (status !== "success") {
        failures.push({
          kind: classifyFailure(obs),
          status,
          stage,
          model: obs.model || null,
          http_status: call.http_status,
          error_class: call.error_class,
          message: call.error_message,
          latency_ms: call.latency_ms,
          recovered: false,
          at: call.observed_at
        });
      }
      touchStage(stage);
      return call;
    },

    noteFirstToken() {
      if (!enabled || firstTokenMs !== null) return;
      firstTokenMs = Date.now() - startedMs;
    },
    noteLedger(n) { if (enabled) ledgerEvents += int(n, 0); },
    /** Absolute count from the ledger itself, so the total cannot drift if a
     *  stage counted its own writes twice or not at all. */
    setLedgerTotal(n) { if (enabled && n != null) ledgerEvents = int(n, ledgerEvents); },
    setConfidence(value, source = "critic.score") {
      if (!enabled || value == null) return;
      confidence = Number(num(value, 0).toFixed(4));
      confidenceSource = source;
    },
    setCoherence(report) {
      if (!enabled || !report) return;
      coherence = {
        verdict: report.verdict || "unchecked",
        checked: report.checked !== false,
        contradictions: (report.contradictions || []).length,
        confirmations: (report.confirmations || []).length,
        hypotheses: (report.newClaims || []).length,
        beliefs_considered: report.beliefsConsidered ?? 0,
        reason: report.reason || null
      };
    },
    setVeto({ approved, flags = [], draftText = null, draftOrigin = null, finalText = null }) {
      if (!enabled) return;
      veto = {
        vetoed: approved === false,
        flags: Array.isArray(flags) ? flags : [],
        reason: approved === false ? describeVeto(flags) : null,
        draftOrigin: draftOrigin || null,
        draftChars: draftText == null ? null : String(draftText).length,
        draftSha256: draftText == null ? null : sha256(draftText),
        finalTextKind: approved === false
          ? (finalText && String(finalText).trim() ? "sovereignty_refusal" : "empty")
          : "approved_draft"
      };
    },
    setKnowledge(detail) { if (enabled) knowledge = detail; },
    setResult(r) { if (enabled) result = r; },
    setSelection(sel) { if (enabled && sel) selection = sel; },

    /** The record, without touching the database. */
    snapshot() {
      const endedMs = Date.now();
      const stageList = stageOrder.map(name => {
        const s = stages.get(name) || { stage: name, runs: 0, totalMs: 0 };
        const calls = modelCalls.filter(c => c.stage === name);
        const callTokens = calls.reduce((a, c) => a + int(c.tokens_total, 0), 0);
        const callCost = Number(calls.reduce((a, c) => a + num(c.cost_usd, 0), 0).toFixed(6));
        return {
          stage: name,
          runs: int(s.runs, 0),
          totalMs: int(s.totalMs, 0),
          lastStatus: s.lastStatus || "success",
          startedMs: s.startedMs ?? null,
          endedMs: s.endedMs ?? null,
          model: calls.length ? calls[calls.length - 1].model : null,
          model_calls: calls.length,
          tokens: callTokens,
          cost_usd: callCost,
          failures: calls.filter(c => c.status !== "success").map(c => c.error_class)
        };
      });
      return {
        id: runId,
        workspace_id: workspaceId,
        conversation_id: conversationId,
        message_id: null,
        strategy_id: selection?.strategyId || CANONICAL_STRATEGY_ID,
        status: "pending",
        started_ms: startedMs,
        ended_ms: endedMs,
        latency_ms: endedMs - startedMs,
        time_to_first_token_ms: firstTokenMs,
        stages: stageList.reduce((acc, s) => ({ ...acc, [s.stage]: { runs: s.runs, totalMs: s.totalMs, lastStatus: s.lastStatus, model: s.model, model_calls: s.model_calls, tokens: s.tokens, cost_usd: s.cost_usd, failures: s.failures } }), {}),
        stage_order: stageList,
        models: Array.from(models),
        model_calls: modelCalls.length,
        tokens_prompt: tokens.prompt,
        tokens_completion: tokens.completion,
        tokens_total: tokens.total,
        tokens_measured: tokens.measured,
        tokens_estimated: tokens.estimated,
        cost_usd: cost.usd,
        cost_rate_known: cost.rateKnown,
        confidence,
        confidence_source: confidenceSource,
        coherence_verdict: coherence?.verdict ?? null,
        coherence_contradictions: coherence?.contradictions ?? 0,
        vetoed: veto?.vetoed === true,
        // The veto fields describe a refusal. On an approved run they stay null
        // rather than carrying the draft's origin, which would read as if
        // something had been refused.
        veto_flags: veto?.vetoed === true ? (veto?.flags ?? null) : null,
        veto_reason: veto?.reason ?? null,
        veto_draft_origin: veto?.vetoed === true ? (veto?.draftOrigin ?? null) : null,
        veto_draft_sha256: veto?.draftSha256 ?? null,
        retries: modelCalls.filter(c => int(c.attempt, 1) > 1).length,
        failures,
        failure_count: failures.length,
        adaptive: selection ? { mode: selection.mode, strategy_id: selection.strategyId, reason: selection.reason, switched: false, candidates: selection.candidates } : null,
        ledger_events: ledgerEvents,
        knowledge,
        task_type: result?.taskType ?? null,
        complexity: result?.complexity ?? null,
        response_chars: result?.responseChars ?? null,
        error_message: null,
        _calls: modelCalls
      };
    },

    /** A compact view for the council trace and the SSE `done` payload. After
     *  finalize() this reports the record as written, not as pending. */
    summary() {
      const s = written ? { ...recorder.snapshot(), ...written, stages: undefined, stage_order: undefined } : recorder.snapshot();
      return {
        runId: s.id,
        strategyId: s.strategy_id,
        status: s.status,
        latencyMs: s.latency_ms,
        timeToFirstTokenMs: s.time_to_first_token_ms,
        modelCalls: s.model_calls,
        models: s.models,
        tokens: { prompt: s.tokens_prompt, completion: s.tokens_completion, total: s.tokens_total, measured: s.tokens_measured, estimated: s.tokens_estimated },
        costUsd: s.cost_usd,
        costRateKnown: s.cost_rate_known,
        confidence: s.confidence,
        confidenceSource: s.confidence_source,
        coherenceVerdict: s.coherence_verdict,
        contradictions: s.coherence_contradictions,
        vetoed: s.vetoed,
        vetoReason: s.veto_reason,
        vetoDraftOrigin: s.veto_draft_origin,
        failures: s.failures,
        failureCount: s.failure_count,
        retries: s.retries,
        ledgerEvents: s.ledger_events,
        adaptiveMode: s.adaptive?.mode ?? "observe"
      };
    },

    /**
     * Write the record. One transaction: the run row, its per-call rows, and the
     * adaptive-orchestrator observation. Idempotent — the error path and the
     * success path can both call it and only the first write happens.
     */
    async finalize({ status = "success", error = null, messageId = null } = {}) {
      if (finalized) return written || recorder.snapshot();
      finalized = true;
      const record = recorder.snapshot();
      record.status = status;
      record.message_id = messageId || null;
      if (error) {
        record.error_message = String(error.message || error).slice(0, 500);
        failures.push({ kind: "run_failed", stage: currentStage, message: record.error_message, at: Date.now(), recovered: false });
        record.failures = failures;
        record.failure_count = failures.length;
      }
      if (!enabled) { written = record; return record; }
      try {
        await db.withTransaction(async (store) => {
          await store.TelemetryRun.create(record);
          if (modelCalls.length) {
            await store.TelemetryModelCall.bulkCreate(modelCalls.map(c => {
              const { observed_at, ...row } = c;
              return row;
            }));
          }
          if (selection) {
            await recordDecision(store, {
              runId,
              selection,
              signals: {
                complexity: record.complexity,
                taskType: record.task_type,
                preRun: selection.signals || null,
                latencyMs: record.latency_ms,
                costUsd: record.cost_usd,
                vetoed: record.vetoed,
                coherenceVerdict: record.coherence_verdict
              },
              evidence: {
                candidates: selection.candidates || [],
                observed: { latency_ms: record.latency_ms, cost_usd: record.cost_usd, vetoed: record.vetoed, failures: record.failure_count },
                thresholds: selection.thresholds || null
              },
              logger
            });
          }
        });
        written = record;
      } catch (e) {
        // pin.telemetry_side_effect: an observation that cannot be written is
        // logged. It never becomes the user's problem.
        logger?.warn?.("telemetry finalize failed", { runId, error: String(e) });
        written = record;
      }
      return record;
    }
  };

  return recorder;
}

/** Read side, for the endpoints. */
export async function recentRuns(dbRef = db, opts = {}) {
  return dbRef.TelemetryRun.recent(opts);
}

export async function runDetail(dbRef = db, runId) {
  const rec = await dbRef.TelemetryRun.withCalls(runId);
  if (!rec) return null;
  const decision = await dbRef.AdaptiveDecision.forRun(runId).catch(() => null);
  const coherence = await dbRef.CoherenceReport.byRun(runId).catch(() => []);
  const events = await dbRef.KnowledgeEvent.forRun(runId, { limit: 500 }).catch(() => []);
  return { ...rec, adaptive_decision: decision, coherence_reports: coherence, ledger_events: events };
}

export { rateFor, estimateCost, estimateTokensFromChars };
