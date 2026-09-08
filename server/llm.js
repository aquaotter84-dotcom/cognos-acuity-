// Shared LLM utilities — the model layer.
//
// DIVERGENCE FROM ORIGINAL: the original routed every model call through
// Base44's built-in InvokeLLM integration (platform-managed key, platform meter).
// That is gone. This calls BluesMinds' OpenAI-compatible Chat Completions
// endpoint DIRECTLY with your own key from the environment — no Base44 in the
// path, no metered platform function, no cognosruntime.vercel.app proxy hop.
// (The original's later "external runtime" branch still bounced through a
// deployed middleman; this does not.)
//
// The prompt-shaping helpers below (styleDirective, buildContextSystemPrompt and
// the COGNOS identity base prompt) are preserved VERBATIM from
// base44/shared/llm.ts on the cognos/full-integration branch.

import { withCharter } from "./council/charter.js";
import { clientAbortError, isClientAbort, throwIfAborted } from "./shared/cancellation.js";

// Hard constraint: default gpt-4o-mini, env override allowed, and gpt_5_4 is
// never routed to (503s on this account — it took the previous deploy down).
// Exported (Phase 15.5) so the Policy Engine refuses a proposal naming one of
// these by citing THIS set rather than a copy that could drift. Exporting the
// constant changes nothing about resolution: resolveModel() and the defaults
// below are byte-for-byte what they were.
export const BANNED_MODELS = new Set(["gpt_5_4", "gpt-5-4"]);
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "https://api.bluesminds.com/v1";

export function resolveModel(requested) {
  const envDefault = process.env.COGNOS_MODEL || process.env.OPENAI_MODEL;
  let model = requested || envDefault || DEFAULT_MODEL;
  if (BANNED_MODELS.has(model)) model = envDefault && !BANNED_MODELS.has(envDefault) ? envDefault : DEFAULT_MODEL;
  return model;
}

// The council's operators ask for platform-specific model slugs (gpt_5_mini,
// gemini_3_flash). Those slugs only existed on Base44/BluesMinds. They are
// mapped onto real, reachable models here rather than being passed through
// to fail.
// The council's operators still ask for the slugs the Base44 build used
// (gpt_5_mini, gemini_3_flash). Those were platform identifiers. They are mapped
// onto real BluesMinds model ids here rather than being passed through to 400.
// Override any of these with COGNOS_MODEL / COGNOS_FAST_MODEL.
const MODEL_ALIASES = {
  gpt_5_4: null,          // banned outright — 503s on this account
  gpt_5_mini: process.env.COGNOS_FAST_MODEL || DEFAULT_MODEL,
  gemini_3_flash: process.env.COGNOS_FAST_MODEL || DEFAULT_MODEL
};

function mapModel(requested) {
  if (requested && Object.prototype.hasOwnProperty.call(MODEL_ALIASES, requested)) {
    return resolveModel(MODEL_ALIASES[requested] || undefined);
  }
  return resolveModel(requested);
}

// Key + endpoint. BLUESMINDS_* is the primary name; OPENAI_* is accepted as an
// alias so any OpenAI-compatible gateway still works unchanged.
function apiConfig() {
  const apiKey = process.env.BLUESMINDS_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.BLUESMINDS_API_URL || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL)
    .replace(/\/chat\/completions\/?$/, "")   // tolerate a full endpoint URL
    .replace(/\/$/, "");
  if (!apiKey) throw new Error("BLUESMINDS_API_KEY is not configured");
  return { apiKey, url: `${baseUrl}/chat/completions` };
}

// Attachments: the original passed file_urls to InvokeLLM. The OpenAI-compatible
// shape is multimodal content parts, so image URLs are folded into the last user turn.
function withAttachments(messages, fileUrls) {
  if (!fileUrls || !fileUrls.length) return messages;
  const out = messages.map(m => ({ ...m }));
  let i = out.length - 1;
  while (i >= 0 && out[i].role !== "user") i -= 1;
  const parts = fileUrls.map(url => ({ type: "image_url", image_url: { url } }));
  if (i < 0) { out.push({ role: "user", content: parts }); return out; }
  const text = typeof out[i].content === "string"
    ? [{ type: "text", text: out[i].content }]
    : Array.isArray(out[i].content) ? out[i].content : [];
  out[i] = { ...out[i], content: [...text, ...parts] };
  return out;
}

function schemaEnvelope(responseJsonSchema) {
  // OpenAI requires a named strict schema envelope; the council supplies bare
  // JSON Schema objects, so it is wrapped here.
  return {
    type: "json_schema",
    json_schema: {
      name: "cognos_structured_output",
      schema: { ...responseJsonSchema, additionalProperties: false }
    }
  };
}

export async function callLLM(ctx, { messages, responseJsonSchema = null, model = null, file_urls = null, add_context_from_internet = null, stream = false, onToken = null, purpose = null }) {
  const externalSignal = ctx?.signal || null;
  throwIfAborted(externalSignal);

  const { apiKey, url } = apiConfig();
  const selectedModel = mapModel(model);
  const payload = {
    model: selectedModel,
    messages: withAttachments(messages, file_urls),
    ...(responseJsonSchema ? { response_format: schemaEnvelope(responseJsonSchema) } : {}),
    ...(stream ? { stream: true } : {})
  };

  // Every call has its own timeout, and also cooperates with cancellation of the
  // enclosing chat request. The source is tracked so a user pressing Stop is
  // recorded as an abort, while an unresponsive provider remains a timeout.
  const timeoutMs = Number(process.env.COGNOS_LLM_TIMEOUT_MS || 60_000);
  const ac = new AbortController();
  let abortSource = null;
  const onClientAbort = () => {
    if (abortSource === null) abortSource = "client";
    ac.abort(externalSignal?.reason);
  };
  if (externalSignal) externalSignal.addEventListener("abort", onClientAbort, { once: true });
  const timer = setTimeout(() => {
    if (abortSource === null) abortSource = "timeout";
    ac.abort();
  }, timeoutMs);
  const cleanup = () => {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onClientAbort);
  };

  // --- Phase 15.1 telemetry hook ------------------------------------------
  // One observation per call, on EVERY exit path: success, timeout, client
  // abort, upstream HTTP error, malformed JSON. This remains a side effect and
  // cannot change the model call's result.
  const telemetry = ctx?.telemetry || null;
  const startedAt = Date.now();
  const promptChars = (payload.messages || []).reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content || "").length), 0);
  let reported = false;
  const report = (obs) => {
    if (reported) return;
    reported = true;
    try {
      telemetry?.observeModelCall?.({
        purpose,
        model: selectedModel,
        requestedModel: model || null,
        streamed: !!stream,
        timeoutMs,
        latencyMs: Date.now() - startedAt,
        promptChars,
        ...obs
      });
    } catch { /* an observation must never break a model call */ }
  };

  const abortError = (charsOut = 0) => {
    if (abortSource === "client" || externalSignal?.aborted) {
      const error = clientAbortError(externalSignal?.reason);
      report({ status: "abort", errorClass: "abort", errorMessage: error.message, charsOut });
      return error;
    }
    const error = new Error(`Model request timed out after ${timeoutMs}ms`);
    report({ status: "timeout", errorClass: "timeout", errorMessage: error.message, charsOut });
    return error;
  };

  let response;
  let streamedText = "";
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal
    });

    if (!response.ok) {
      const detail = await response.text();
      report({ status: "http_error", httpStatus: response.status, errorMessage: detail.slice(0, 400) });
      throw new Error(`Model request failed (${response.status}): ${detail.slice(0, 400)}`);
    }

    // Streaming here is provider-facing only. User-facing answer chunks are
    // released separately, after the Governor has ruled on the complete draft.
    if (stream) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (delta) { streamedText += delta; onToken?.(delta); }
          } catch { /* skip malformed chunk */ }
        }
      }
      throwIfAborted(externalSignal);
      report({ status: "success", charsOut: streamedText.length });
      return streamedText;
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (ac.signal.aborted || externalSignal?.aborted) throw abortError();
      report({ status: "parse_error", errorClass: "malformed_response", errorMessage: "Model returned a response envelope that could not be parsed" });
      throw error;
    }
    throwIfAborted(externalSignal);

    const content = data?.choices?.[0]?.message?.content ?? "";
    const usage = data?.usage || null;
    if (!responseJsonSchema) {
      report({ status: "success", usage, charsOut: typeof content === "string" ? content.length : 0 });
      return content;
    }
    if (typeof content !== "string") {
      report({ status: "success", usage, charsOut: 0 });
      return content;
    }
    try {
      const parsed = JSON.parse(content);
      report({ status: "success", usage, charsOut: content.length });
      return parsed;
    } catch {
      report({ status: "parse_error", errorClass: "malformed_json", usage, errorMessage: "Model returned JSON-schema content that could not be parsed", charsOut: content.length });
      throw new Error("Model returned JSON-schema content that could not be parsed");
    }
  } catch (error) {
    if (isClientAbort(error, externalSignal)) {
      if (!reported) report({ status: "abort", errorClass: "abort", errorMessage: "Council turn cancelled by the client", charsOut: streamedText.length });
      throw clientAbortError(externalSignal?.reason || error);
    }
    if (error?.name === "AbortError" || ac.signal.aborted) {
      throw abortError(streamedText.length);
    }
    if (!reported) {
      report({ status: "network_error", errorClass: "network", errorMessage: String(error?.message || error).slice(0, 400), charsOut: streamedText.length });
    }
    throw error;
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// VERBATIM from base44/shared/llm.ts (cognos/full-integration). Do not edit.
// ---------------------------------------------------------------------------

const STYLE_DIRECTIVES = {
  balanced: "Communicate in a balanced, clear, neutral tone — helpful and direct.",
  casual: "Communicate in a casual, warm, conversational tone — friendly and approachable, like a thoughtful peer.",
  technical: "Communicate in a precise, technical tone — exact terminology, structured and detail-oriented.",
  strategic: "Communicate in a strategic, executive tone — frame decisions, trade-offs, and implications at a high level."
};

export function styleDirective(style) {
  return style && STYLE_DIRECTIVES[style] ? `\n\nCOMMUNICATION STYLE: ${STYLE_DIRECTIVES[style]}` : '';
}

export function buildContextSystemPrompt(workspace, memories, classification, base = 'You are COGNOS, an intelligent AI reasoning assistant. You provide thoughtful, accurate, and helpful responses. Use markdown formatting when appropriate for clarity.', style = null, councilRecord = null) {
  let systemPrompt = withCharter(base);
  if (workspace?.instructions) {
    systemPrompt += `\n\nWORKSPACE INSTRUCTIONS:\n${workspace.instructions}`;
  }
  if (memories && memories.length > 0) {
    systemPrompt += `\n\nRELEVANT MEMORIES:\n${memories.map(m => `- ${m.content}`).join('\n')}`;
  }
  if (classification?.task_type && classification.task_type !== 'conversation') {
    systemPrompt += `\n\nTASK CONTEXT: The Observer classified this as "${classification.task_type}" (${classification.complexity || 'unknown'} complexity). Tailor your reasoning approach accordingly.`;
  }
  if (councilRecord) {
    systemPrompt += `\n\nTHE COUNCIL'S OWN RECORD (what this system has decided before this session):\n${councilRecord}\nContinuity: prior decisions and refusals stand unless a material fact has changed. If you believe a recorded decision was wrong, say why, explicitly, before acting otherwise. This council does not contradict its own record silently.`;
  }
  systemPrompt += styleDirective(style);
  return systemPrompt;
}
