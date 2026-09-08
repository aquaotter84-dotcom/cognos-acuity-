#!/usr/bin/env node
// Regressions for latency observability and no-reasoning-loss request tuning.

import assert from "node:assert/strict";
import { bootHarness } from "./harness.mjs";
import { callLLM, describeModelHttpError, getModelRequestPolicy } from "../server/llm.js";
import { buildLatencyReport, percentile, summarizeMetric } from "../server/meta/latency.js";

let passed = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  passed++;
};

assert.equal(percentile([10, 20, 30, 40], 0.5), 25); passed++;
assert.deepEqual(summarizeMetric([]), { samples: 0, min: null, p50: null, p95: null, max: null, mean: null }); passed++;
assert.equal(summarizeMetric([10, 20, 30]).p95, 29); passed++;
const legacyReport = buildLatencyReport({
  runs: [{ id: "legacy", status: "success", latency_ms: 50 }],
  calls: [{ run_id: "legacy", purpose: "observer", latency_ms: 20, tokens_prompt: 100, prompt_cached_tokens: null }]
});
assert.equal(legacyReport.runLatencyMs.postProcessing.samples, 0); passed++;
assert.equal(legacyReport.provider.cacheHitTokenRate, null); passed++;

const originalTier = process.env.COGNOS_LLM_SERVICE_TIER;
const originalCacheKey = process.env.COGNOS_PROMPT_CACHE_KEY;
const originalRetries = process.env.COGNOS_LLM_MAX_RETRIES;
delete process.env.COGNOS_LLM_SERVICE_TIER;
delete process.env.COGNOS_PROMPT_CACHE_KEY;
process.env.COGNOS_LLM_MAX_RETRIES = "1";

const h = await bootHarness();
try {
  const messages = [
    { role: "system", content: "Identical prompt for transport-only tuning test." },
    { role: "user", content: "Return the deterministic test answer." }
  ];
  h.model.state.requests.length = 0;
  const plain = await callLLM({}, { model: "openai/gpt-oss-20b", messages });
  const plainRequest = h.model.state.requests.at(-1);
  check(plainRequest.serviceTier === null && plainRequest.promptCacheKey === null, "request tuning must be opt-in");

  process.env.COGNOS_LLM_SERVICE_TIER = "fast";
  process.env.COGNOS_PROMPT_CACHE_KEY = "cognos-test-v1";
  const tuned = await callLLM({}, { model: "openai/gpt-oss-20b", messages });
  const tunedRequest = h.model.state.requests.at(-1);
  check(tuned === plain, "transport tuning changed the model output");
  check(tunedRequest.content === plainRequest.content, "transport tuning changed prompt content");
  check(tunedRequest.serviceTier === "fast" && tunedRequest.promptCacheKey === "cognos-test-v1", "opt-in tuning fields were not forwarded");

  const proxyHtml = "<html><head><title>504 Gateway Time-out</title></head><body><h1>504 Gateway Time-out</h1><p>openresty</p></body></html>";
  const public504 = describeModelHttpError(504, proxyHtml, 2);
  check(/gateway timed out/i.test(public504) && /after 2 attempts/i.test(public504), "504 errors are not explained clearly");
  check(!/[<>]|openresty|<html/i.test(public504), "raw proxy HTML leaked into the public error");
  check(getModelRequestPolicy().maxRetries === 1, "bounded retry policy did not honor COGNOS_LLM_MAX_RETRIES");

  // First attempt receives exactly the production-style HTML 504 the user saw;
  // the second must resend the byte-identical prompt/model and recover.
  h.model.reset({ failStatus: 504, failCount: 1, failBody: proxyHtml, failContentType: "text/html" });
  h.model.state.requests.length = 0;
  const retryObservations = [];
  const recovered = await callLLM({ telemetry: { observeModelCall: obs => retryObservations.push(obs) } }, {
    model: "openai/gpt-oss-20b",
    messages
  });
  check(recovered === plain, "a transient 504 did not recover on the bounded retry");
  check(h.model.state.requests.length === 2, `expected 2 physical attempts, saw ${h.model.state.requests.length}`);
  check(h.model.state.requests[0].content === h.model.state.requests[1].content, "retry changed the prompt");
  check(h.model.state.requests[0].model === h.model.state.requests[1].model, "retry changed the model");
  check(
    retryObservations.length === 2 && retryObservations[0].status === "http_error" && retryObservations[0].attempt === 1 && retryObservations[1].status === "success" && retryObservations[1].attempt === 2,
    `physical attempts were not attributed correctly: ${JSON.stringify(retryObservations.map(x => ({ status: x.status, attempt: x.attempt })))}`
  );
  check(retryObservations[1].recoveredFromAttempts === 1, "successful retry did not report its recovery");
  check(Boolean(retryObservations[0].requestId) && retryObservations[0].requestId === retryObservations[1].requestId, "retry attempts do not share a logical request id");

  h.model.reset({ failStatus: 504, failBody: proxyHtml, failContentType: "text/html" });
  h.model.state.requests.length = 0;
  const retryAbort = new AbortController();
  const pendingRetry = callLLM({ signal: retryAbort.signal }, { model: "openai/gpt-oss-20b", messages });
  while (h.model.state.requests.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
  await new Promise(resolve => setTimeout(resolve, 20)); // first 504 has entered bounded backoff
  retryAbort.abort(new Error("cancel retry backoff"));
  await assert.rejects(pendingRetry, error => error?.code === "CLIENT_ABORT");
  check(h.model.state.requests.length === 1, "cancellation during backoff allowed another model attempt");

  // A persistent gateway outage remains bounded and still never exposes HTML.
  h.model.reset({ failStatus: 504, failBody: proxyHtml, failContentType: "text/html" });
  h.model.state.requests.length = 0;
  await assert.rejects(
    callLLM({}, { model: "openai/gpt-oss-20b", messages }),
    error => /gateway timed out.*after 2 attempts/i.test(error.message) && !/[<>]|openresty|<html/i.test(error.message)
  );
  check(h.model.state.requests.length === 2, "persistent 504 exceeded or skipped the configured retry bound");

  const echoedSecret = `sk-${"Q".repeat(28)}`;
  h.model.reset({
    failStatus: 400,
    failBody: JSON.stringify({ error: { message: `Invalid prompt content: ${echoedSecret}` } }),
    failContentType: "application/json"
  });
  h.model.state.requests.length = 0;
  await assert.rejects(
    callLLM({}, { model: "openai/gpt-oss-20b", messages }),
    error => /provider rejected the request/i.test(error.message) && !error.message.includes(echoedSecret)
  );
  check(h.model.state.requests.length === 1, "a non-transient HTTP 400 was retried");

  h.model.reset();
  h.model.state.cachedTokens = 32;
  const turn = await h.chat("Measure this governed response without changing its reasoning.");
  check(Boolean(turn.done?.runId), "instrumented chat did not complete");

  const [run] = await h.sql("SELECT * FROM telemetry_runs WHERE id=$1", [turn.done.runId]);
  const calls = await h.sql("SELECT * FROM telemetry_model_calls WHERE run_id=$1 ORDER BY seq", [turn.done.runId]);
  check(run?.performance?.runtime?.requestOrdinal >= 1, "runtime/cold-start timing was not persisted");
  check(run?.performance?.preCouncil?.totalMs >= 0, "pre-council database timing was not persisted");
  check(run?.performance?.orchestration?.strategySelectionMs >= 0, "strategy selection timing was not persisted");
  check(run?.performance?.orchestration?.governedReadyMs >= 0, "governed-ready timing was not persisted");
  check(run?.performance?.orchestration?.postProcessingMs >= 0, "post-processing timing was not persisted");
  check(calls.length > 0 && calls.every(call => call.response_headers_ms >= 0), "model response-header timing was not persisted");
  check(calls.every(call => call.response_decode_ms >= 0), "model response decode timing was not persisted");
  check(calls.every(call => call.prompt_cached_tokens === 32), "provider cache usage was not captured");
  check(calls.every(call => call.requested_service_tier === "fast"), "requested service tier was not captured");
  check(calls.every(call => call.service_tier === "fast"), "returned service tier was not captured");

  const report = buildLatencyReport({ runs: [run], calls });
  check(report.runLatencyMs.total.samples === 1, "latency report omitted the completed run");
  check(report.provider.cachedPromptTokens === calls.length * 32, "latency report miscounted cached prompt tokens");
  check(report.durablePostProcessingDecision.status === "insufficient_evidence", "outbox was recommended without the evidence floor");

  h.model.reset({ failStatus: 504, failCount: 1, failBody: proxyHtml, failContentType: "text/html" });
  const resilientTurn = await h.chat("Recover a governed turn from one transient model gateway timeout.");
  check(Boolean(resilientTurn.done?.runId), "a transient 504 escaped the governed turn after retry");
  const [resilientRun] = await h.sql("SELECT * FROM telemetry_runs WHERE id=$1", [resilientTurn.done.runId]);
  const resilientCalls = await h.sql("SELECT * FROM telemetry_model_calls WHERE run_id=$1 ORDER BY seq", [resilientTurn.done.runId]);
  const observerAttempts = resilientCalls.filter(call => call.stage === "observer");
  check(
    observerAttempts.length === 2 && observerAttempts[0].status === "http_error" && observerAttempts[0].attempt === 1 && observerAttempts[1].status === "success" && observerAttempts[1].attempt === 2 && Boolean(observerAttempts[0].request_id) && observerAttempts[0].request_id === observerAttempts[1].request_id,
    `durable retry attribution was incomplete: ${JSON.stringify(observerAttempts.map(call => ({ status: call.status, attempt: call.attempt })))}`
  );
  check(
    resilientRun.status === "success" && (resilientRun.failures || []).some(failure => failure.kind === "gateway" && failure.recovered === true && failure.recovered_by_attempt === 2),
    `recovered gateway failure was not retained truthfully: ${JSON.stringify(resilientRun.failures || [])}`
  );
  h.model.reset();

  const syntheticRuns = Array.from({ length: 20 }, (_, index) => ({
    id: `run-${index}`,
    status: "success",
    latency_ms: 100,
    time_to_first_token_ms: 65,
    stage_order: [],
    performance: { orchestration: { postProcessingMs: 30 } }
  }));
  const candidate = buildLatencyReport({ runs: syntheticRuns, calls: [] });
  check(candidate.durablePostProcessingDecision.status === "candidate", "measured dominant post tail was not identified");
  check(candidate.durablePostProcessingDecision.measuredPostSharePercent.p50 === 30, "post-tail share was calculated incorrectly");

  const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../server/chatOrchestrate.js", import.meta.url), "utf8"));
  const startSelection = source.indexOf("const selectionPromise = selectStrategy");
  const startContext = source.indexOf('orchestrator.dispatch("contextAssembly"');
  const joinSelection = source.indexOf("selection = await selectionPromise");
  check(startSelection >= 0 && startSelection < startContext && startContext < joinSelection, "observe-only strategy selection no longer overlaps context assembly");

  console.log(`PERFORMANCE RESULT: ${passed} passed, 0 failed`);
} finally {
  if (originalTier === undefined) delete process.env.COGNOS_LLM_SERVICE_TIER;
  else process.env.COGNOS_LLM_SERVICE_TIER = originalTier;
  if (originalCacheKey === undefined) delete process.env.COGNOS_PROMPT_CACHE_KEY;
  else process.env.COGNOS_PROMPT_CACHE_KEY = originalCacheKey;
  if (originalRetries === undefined) delete process.env.COGNOS_LLM_MAX_RETRIES;
  else process.env.COGNOS_LLM_MAX_RETRIES = originalRetries;
  await h.stop();
}
