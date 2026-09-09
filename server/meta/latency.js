// Read-only latency analysis. It consumes existing telemetry and cannot alter a
// council run. Percentiles are calculated over individual observations rather
// than percentiles-of-averages, keeping p50/p95 meaningful.

import { int } from "../db/util.js";

const finite = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export function percentile(values, p) {
  const sorted = (values || []).map(finite).filter(v => v !== null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = Math.min(1, Math.max(0, Number(p))) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

export function summarizeMetric(values) {
  const clean = (values || []).map(finite).filter(v => v !== null);
  if (!clean.length) return { samples: 0, min: null, p50: null, p95: null, max: null, mean: null };
  const rounded = (value) => Number(value.toFixed(1));
  return {
    samples: clean.length,
    min: rounded(Math.min(...clean)),
    p50: rounded(percentile(clean, 0.5)),
    p95: rounded(percentile(clean, 0.95)),
    max: rounded(Math.max(...clean)),
    mean: rounded(clean.reduce((sum, value) => sum + value, 0) / clean.length)
  };
}

function parseObject(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function groupMetrics(items, keyOf, valueOf) {
  const groups = new Map();
  for (const item of items || []) {
    const key = keyOf(item) || "unattributed";
    const value = valueOf(item);
    if (finite(value) === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort((a, b) => (summarizeMetric(b[1]).p95 || 0) - (summarizeMetric(a[1]).p95 || 0) || a[0].localeCompare(b[0]))
      .map(([key, values]) => [key, summarizeMetric(values)])
  );
}

export function buildLatencyReport({ runs = [], calls = [], minOutboxSamples = 20, postTailThreshold = 0.2 } = {}) {
  const completed = runs.filter(run => ["success", "vetoed"].includes(run.status));
  const runIds = new Set(completed.map(run => run.id));
  const relevantCalls = calls.filter(call => runIds.has(call.run_id));

  const postSamples = completed
    .map(run => finite(parseObject(run.performance, {})?.orchestration?.postProcessingMs))
    .filter(value => value !== null);
  const postShares = completed.map(run => {
    const perf = parseObject(run.performance, {});
    const post = finite(perf?.orchestration?.postProcessingMs);
    const total = finite(run.latency_ms);
    return post !== null && total ? post / total : null;
  }).filter(value => value !== null);
  const postShare = summarizeMetric(postShares.map(value => value * 100));
  const enoughOutboxEvidence = postShares.length >= minOutboxSamples;
  const postTailDominates = enoughOutboxEvidence && (postShare.p50 || 0) >= postTailThreshold * 100;

  const stageRows = [];
  for (const run of completed) {
    const stages = parseObject(run.stage_order, []);
    for (const stage of Array.isArray(stages) ? stages : []) {
      stageRows.push({ stage: stage.stage, totalMs: stage.totalMs });
    }
  }

  const callsReportingCache = relevantCalls.filter(call => call.prompt_cached_tokens != null);
  const totalPromptTokens = relevantCalls.reduce((sum, call) => sum + int(call.tokens_prompt, 0), 0);
  const cacheablePromptTokens = callsReportingCache.reduce((sum, call) => sum + int(call.tokens_prompt, 0), 0);
  const cachedPromptTokens = callsReportingCache.reduce((sum, call) => sum + int(call.prompt_cached_tokens, 0), 0);
  const serviceTiers = {};
  const requestedServiceTiers = {};
  for (const call of relevantCalls) {
    const tier = call.service_tier || "unreported";
    const requested = call.requested_service_tier || "provider-default";
    serviceTiers[tier] = (serviceTiers[tier] || 0) + 1;
    requestedServiceTiers[requested] = (requestedServiceTiers[requested] || 0) + 1;
  }

  const coldRuns = completed.filter(run => parseObject(run.performance, {})?.runtime?.coldInstanceCandidate === true);
  const warmRuns = completed.filter(run => parseObject(run.performance, {})?.runtime?.coldInstanceCandidate === false);

  return {
    generatedAt: new Date().toISOString(),
    sample: {
      requestedRuns: runs.length,
      completedRuns: completed.length,
      modelCalls: relevantCalls.length,
      statuses: runs.reduce((acc, run) => ({ ...acc, [run.status || "unknown"]: (acc[run.status || "unknown"] || 0) + 1 }), {})
    },
    runLatencyMs: {
      total: summarizeMetric(completed.map(run => run.latency_ms)),
      governedFirstChunk: summarizeMetric(completed.map(run => run.time_to_first_token_ms)),
      postProcessing: summarizeMetric(postSamples),
      preCouncil: summarizeMetric(completed.map(run => parseObject(run.performance, {})?.preCouncil?.totalMs)),
      coldCandidates: summarizeMetric(coldRuns.map(run => run.latency_ms)),
      warm: summarizeMetric(warmRuns.map(run => run.latency_ms))
    },
    databaseLatencyMs: {
      workspace: summarizeMetric(completed.map(run => parseObject(run.performance, {})?.preCouncil?.workspaceMs)),
      conversationCreate: summarizeMetric(completed.map(run => parseObject(run.performance, {})?.preCouncil?.conversationMs)),
      userMessageWrite: summarizeMetric(completed.map(run => parseObject(run.performance, {})?.preCouncil?.userMessageMs)),
      contextAssembly: summarizeMetric(stageRows.filter(row => row.stage === "contextAssembly").map(row => row.totalMs))
    },
    orchestrationOverheadMs: {
      strategySelection: summarizeMetric(completed.map(run => parseObject(run.performance, {})?.orchestration?.strategySelectionMs)),
      governedRelease: summarizeMetric(completed.map(run => parseObject(run.performance, {})?.orchestration?.governedReleaseMs))
    },
    stageLatencyMs: groupMetrics(stageRows, row => row.stage, row => row.totalMs),
    modelLatencyMs: groupMetrics(relevantCalls, call => call.purpose || call.stage, call => call.latency_ms),
    modelResponseHeadersMs: groupMetrics(relevantCalls, call => call.purpose || call.stage, call => call.response_headers_ms),
    modelResponseDecodeMs: groupMetrics(relevantCalls, call => call.purpose || call.stage, call => call.response_decode_ms),
    provider: {
      requestedServiceTiers,
      returnedServiceTiers: serviceTiers,
      totalPromptTokens,
      reportedPromptTokens: cacheablePromptTokens,
      cachedPromptTokens,
      cacheHitTokenRate: cacheablePromptTokens ? Number((cachedPromptTokens / cacheablePromptTokens).toFixed(4)) : null,
      callsReportingCache: callsReportingCache.length
    },
    durablePostProcessingDecision: {
      status: !enoughOutboxEvidence ? "insufficient_evidence" : postTailDominates ? "candidate" : "not_justified",
      samples: postShares.length,
      requiredSamples: minOutboxSamples,
      thresholdP50Share: postTailThreshold,
      measuredPostSharePercent: postShare,
      reason: !enoughOutboxEvidence
        ? `Need ${minOutboxSamples} completed runs with post-processing timing before changing consistency semantics.`
        : postTailDominates
          ? `Post-processing is at least ${Math.round(postTailThreshold * 100)}% of p50 run latency; a durable outbox merits a separately reviewed design.`
          : `Post-processing is below ${Math.round(postTailThreshold * 100)}% of p50 run latency; an outbox would add complexity without enough measured benefit.`
    },
    invariants: {
      analysisOnly: true,
      operatorsChanged: false,
      promptsChanged: false,
      governorBoundaryChanged: false
    }
  };
}

const ms = metric => metric?.samples ? `p50 ${metric.p50}ms · p95 ${metric.p95}ms · n=${metric.samples}` : "no samples";

export function formatLatencyReport(report) {
  const lines = [
    "COGNOS latency report",
    `generated ${report.generatedAt}`,
    `completed runs ${report.sample.completedRuns}/${report.sample.requestedRuns}; model calls ${report.sample.modelCalls}`,
    "",
    `orchestration    ${ms(report.runLatencyMs.total)}`,
    `governed answer  ${ms(report.runLatencyMs.governedFirstChunk)}`,
    `post-processing  ${ms(report.runLatencyMs.postProcessing)}`,
    `pre-council DB   ${ms(report.runLatencyMs.preCouncil)}`,
    `cold candidates  ${ms(report.runLatencyMs.coldCandidates)}`,
    `warm runs        ${ms(report.runLatencyMs.warm)}`,
    "",
    "Database path:",
    `  workspace            ${ms(report.databaseLatencyMs.workspace)}`,
    `  conversation create  ${ms(report.databaseLatencyMs.conversationCreate)}`,
    `  user message write   ${ms(report.databaseLatencyMs.userMessageWrite)}`,
    `  context assembly     ${ms(report.databaseLatencyMs.contextAssembly)}`,
    "",
    "Model calls by purpose:"
  ];
  for (const [purpose, metric] of Object.entries(report.modelLatencyMs)) lines.push(`  ${purpose.padEnd(20)} ${ms(metric)}`);
  lines.push("", "Provider response headers by purpose:");
  for (const [purpose, metric] of Object.entries(report.modelResponseHeadersMs)) lines.push(`  ${purpose.padEnd(20)} ${ms(metric)}`);
  lines.push("", "Stages:");
  for (const [stage, metric] of Object.entries(report.stageLatencyMs)) lines.push(`  ${stage.padEnd(20)} ${ms(metric)}`);
  lines.push(
    "",
    `prompt cache     ${report.provider.cacheHitTokenRate != null ? `${report.provider.cachedPromptTokens}/${report.provider.reportedPromptTokens} reported tokens (${(report.provider.cacheHitTokenRate * 100).toFixed(1)}%) across ${report.provider.callsReportingCache} call(s)` : report.provider.callsReportingCache ? `cache metadata reported for ${report.provider.callsReportingCache} call(s), but prompt-token denominator unavailable` : `unreported across ${report.sample.modelCalls} call(s)`}`,
    `tiers requested  ${JSON.stringify(report.provider.requestedServiceTiers)}`,
    `tiers returned   ${JSON.stringify(report.provider.returnedServiceTiers)}`,
    "",
    `outbox decision  ${report.durablePostProcessingDecision.status}: ${report.durablePostProcessingDecision.reason}`
  );
  return lines.join("\n");
}
