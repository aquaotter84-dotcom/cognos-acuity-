// Deterministic context-window assembly.
//
// The model provider's context limit is not a reason to keep retrying larger
// prompts. COGNOS builds one bounded, inspectable window before the answer
// seats run: the newest short-term dialogue, the conversation summary,
// structured persistent memory, and citable evidence each have a budget. The
// result is telemetry data, not a model instruction and not a new authority.

import { formatStructuredMemory, memoryLayerLabel } from "./memory/structure.js";

const CHARS_PER_TOKEN = 4;
const DEFAULTS = Object.freeze({
  maxInputTokens: 16_000,
  outputReserveTokens: 2_048,
  maxHistoryMessages: 40,
  historyTokens: 4_500,
  summaryTokens: 500,
  memoryTokens: 2_000,
  sourceTokens: 4_800,
  supplementalTokens: 1_800,
  graphTokens: 1_200,
  workspaceTokens: 450,
  maxUserTokens: 2_600,
  overheadTokens: 1_600
});

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, fallback, min, max) {
  return Math.max(min, Math.min(max, Math.floor(finite(value, fallback))));
}

export function contextWindowDefaults() {
  return { ...DEFAULTS };
}

export function normalizeContextWindowConfig(config = {}) {
  return {
    maxInputTokens: clamp(config.maxInputTokens, DEFAULTS.maxInputTokens, 4_000, 128_000),
    outputReserveTokens: clamp(config.outputReserveTokens, DEFAULTS.outputReserveTokens, 256, 32_000),
    maxHistoryMessages: clamp(config.maxHistoryMessages, DEFAULTS.maxHistoryMessages, 2, 200),
    historyTokens: clamp(config.historyTokens, DEFAULTS.historyTokens, 256, 64_000),
    summaryTokens: clamp(config.summaryTokens, DEFAULTS.summaryTokens, 0, 8_000),
    memoryTokens: clamp(config.memoryTokens, DEFAULTS.memoryTokens, 0, 32_000),
    sourceTokens: clamp(config.sourceTokens, DEFAULTS.sourceTokens, 0, 64_000),
    supplementalTokens: clamp(config.supplementalTokens, DEFAULTS.supplementalTokens, 0, 32_000),
    graphTokens: clamp(config.graphTokens, DEFAULTS.graphTokens, 0, 16_000),
    workspaceTokens: clamp(config.workspaceTokens, DEFAULTS.workspaceTokens, 0, 8_000),
    maxUserTokens: clamp(config.maxUserTokens, DEFAULTS.maxUserTokens, 256, 32_000),
    overheadTokens: clamp(config.overheadTokens, DEFAULTS.overheadTokens, 0, 8_000)
  };
}

/** A conservative, provider-independent estimate used for admission control. */
export function estimateTokens(value) {
  if (value === null || value === undefined) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(String(text || "").length / CHARS_PER_TOKEN);
}

function asText(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Keep both ends of a user request; the end often contains the actual ask. */
export function trimToTokens(value, maxTokens, { preserveEnds = false } = {}) {
  const text = asText(value);
  const limit = Math.max(0, Math.floor(Number(maxTokens) || 0));
  if (!text || limit <= 0) return "";
  if (estimateTokens(text) <= limit) return text;
  const maxChars = Math.max(4, limit * CHARS_PER_TOKEN - 16);
  if (!preserveEnds || maxChars < 80) return `${text.slice(0, maxChars)}…`;
  const head = Math.ceil(maxChars * 0.58);
  const tail = Math.max(1, maxChars - head);
  return `${text.slice(0, head)}\n…[context window clipped]…\n${text.slice(-tail)}`;
}

function selectHistory(history, tokenBudget, maxMessages) {
  const rows = Array.isArray(history) ? history.slice(-maxMessages) : [];
  const selected = [];
  let used = 0;
  // Walk newest-first so a long conversation loses its oldest context first.
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const cost = estimateTokens(`${row?.role || "user"}: ${row?.content || ""}`);
    if (used + cost <= tokenBudget) {
      selected.unshift(row);
      used += cost;
      continue;
    }
    if (selected.length === 0 && tokenBudget > 0) {
      selected.unshift({
        ...row,
        content: trimToTokens(row?.content || "", Math.max(1, tokenBudget - 2), { preserveEnds: true })
      });
      used = estimateTokens(`${row?.role || "user"}: ${selected[0].content}`);
    }
    break;
  }
  return { value: selected, used };
}

function selectMemories(memories, tokenBudget) {
  const selected = [];
  let used = 0;
  for (const memory of Array.isArray(memories) ? memories : []) {
    const rendered = formatStructuredMemory(memory);
    const cost = estimateTokens(rendered);
    if (used + cost <= tokenBudget) {
      selected.push(memory);
      used += cost;
      continue;
    }
    // Keep the relevant record visible even when its free-form text is larger
    // than the remaining slice; its structured value is still bounded at write
    // time and the trace records that the row was selected.
    const remaining = tokenBudget - used;
    if (remaining > 8) {
      selected.push({
        ...memory,
        content: trimToTokens(memory.content || "", Math.max(8, remaining - 4)),
        memory_value: { text: trimToTokens(memory.content || "", Math.max(8, remaining - 4)), truncated: true }
      });
      used = tokenBudget;
    }
    break;
  }
  return { value: selected, used };
}

function selectBlocks(text, tokenBudget) {
  const source = String(text || "");
  if (!source) return { value: "", used: 0, omitted: 0 };
  const blocks = source.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  // A starved slice still measures what it dropped: the Governor audits
  // citations against admitted text only, so an uncounted omission would read
  // as a clean window instead of an empty one.
  if (tokenBudget <= 0) return { value: "", used: 0, omitted: blocks.length };
  const selected = [];
  let used = 0;
  let omitted = 0;
  for (const block of blocks) {
    const cost = estimateTokens(block);
    if (used + cost <= tokenBudget) {
      selected.push(block);
      used += cost;
      continue;
    }
    // The first blocks are the safety header and manifest. If a header is too
    // large, clip it; citable evidence blocks are kept whole so locators never
    // become half a citation.
    if (!selected.length && tokenBudget > 0) {
      const clipped = trimToTokens(block, tokenBudget);
      if (clipped) {
        selected.push(clipped);
        used = estimateTokens(clipped);
      }
    }
    omitted += 1;
  }
  return { value: selected.join("\n\n"), used, omitted };
}

function normalizedWorkspace(workspace, tokenBudget) {
  if (!workspace) return workspace;
  if (!workspace.instructions) return workspace;
  return {
    ...workspace,
    instructions: trimToTokens(workspace.instructions, tokenBudget, { preserveEnds: true })
  };
}

/**
 * Assemble the model-facing context. This function is pure and intentionally
 * does not call a model or write a row, which makes the expansion reviewable and
 * easy to test offline.
 */
export function assembleContextWindow({
  userMessage = "",
  history = [],
  conversationSummary = "",
  memories = [],
  workspace = null,
  sourceContext = "",
  supplementalContext = "",
  graphContext = "",
  config = {}
} = {}) {
  const budget = normalizeContextWindowConfig(config);
  const user = trimToTokens(userMessage, budget.maxUserTokens, { preserveEnds: true });
  let remaining = Math.max(0, budget.maxInputTokens - budget.overheadTokens - estimateTokens(user));

  const take = (requested, ceiling) => {
    const allowance = Math.max(0, Math.min(requested, ceiling, remaining));
    remaining -= allowance;
    return allowance;
  };

  const summaryBudget = take(estimateTokens(conversationSummary), budget.summaryTokens);
  const summary = trimToTokens(conversationSummary, summaryBudget);

  const workspaceBudget = take(estimateTokens(workspace?.instructions), budget.workspaceTokens);
  const promptWorkspace = normalizedWorkspace(workspace, workspaceBudget);

  const historyBudget = take(Math.min(budget.historyTokens, remaining), budget.historyTokens);
  const historyResult = selectHistory(history, historyBudget, budget.maxHistoryMessages);

  const memoryBudget = take(Math.min(budget.memoryTokens, remaining), budget.memoryTokens);
  const memoryResult = selectMemories(memories, memoryBudget);

  const sourceBudget = take(Math.min(budget.sourceTokens, remaining), budget.sourceTokens);
  const sourceResult = selectBlocks(sourceContext, sourceBudget);

  const supplementalBudget = take(Math.min(budget.supplementalTokens, remaining), budget.supplementalTokens);
  const supplemental = trimToTokens(supplementalContext, supplementalBudget);

  // Phase 23 — the trust-annotated atlas rides in its own slice, after the
  // web briefing. Graph rows are kept whole so [graph_id] citations never
  // become half a citation; omissions are measured like source omissions.
  const graphBudget = take(Math.min(budget.graphTokens, remaining), budget.graphTokens);
  const graphResult = selectBlocks(graphContext, graphBudget);

  // The accounting includes the fields that will be placed in the model
  // messages, but not the answer itself. `outputReserveTokens` is reported so
  // operators can compare this window to a provider's total context capacity.
  const selectedContextTokens = estimateTokens(summary)
    + estimateTokens(promptWorkspace?.instructions)
    + historyResult.used
    + memoryResult.used
    + sourceResult.used
    + estimateTokens(supplemental)
    + graphResult.used
    + estimateTokens(user)
    + budget.overheadTokens;

  return {
    userMessage: user,
    history: historyResult.value,
    conversationSummary: summary || null,
    memories: memoryResult.value,
    workspace: promptWorkspace,
    sourceContext: sourceResult.value || null,
    supplementalContext: supplemental || null,
    graphContext: graphResult.value || null,
    metrics: {
      maxInputTokens: budget.maxInputTokens,
      outputReserveTokens: budget.outputReserveTokens,
      overheadTokens: budget.overheadTokens,
      estimatedInputTokens: selectedContextTokens,
      remainingTokens: Math.max(0, budget.maxInputTokens - selectedContextTokens),
      historyMessages: historyResult.value.length,
      historyTokens: historyResult.used,
      memoryRecords: memoryResult.value.length,
      memoryLayers: [...new Set(memoryResult.value.map(memoryLayerLabel))],
      memoryTokens: memoryResult.used,
      summaryTokens: estimateTokens(summary),
      sourceTokens: sourceResult.used,
      sourceBlocksOmitted: sourceResult.omitted,
      supplementalTokens: estimateTokens(supplemental),
      graphTokens: graphResult.used,
      graphBlocksOmitted: graphResult.omitted,
      clipped: selectedContextTokens >= budget.maxInputTokens || sourceResult.omitted > 0 || graphResult.omitted > 0
    }
  };
}
