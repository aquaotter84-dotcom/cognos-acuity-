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
  const { apiKey, url } = apiConfig();
  const selectedModel = mapModel(model);

  const payload = {
    model: selectedModel,
    messages: withAttachments(messages, file_urls),
    ...(responseJsonSchema ? { response_format: schemaEnvelope(responseJsonSchema) } : {}),
    ...(stream ? { stream: true } : {})
  };

  // Bound every upstream call. A hung provider must not consume the entire
  // serverless function budget and kill the whole turn with no output.
  const timeoutMs = Number(process.env.COGNOS_LLM_TIMEOUT_MS || 60_000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  // --- Phase 15.1 telemetry hook ------------------------------------------
  // One observation per call, on EVERY exit path: success, timeout, abort,
  // upstream HTTP error, malformed JSON. This is the capture point that turns
  // "the model hung" from a mystery into a record. It is a side effect: the
  // observation is wrapped, it cannot throw, and it changes nothing about the
  // call, the thrown error, or the returned value. When ctx.telemetry is absent
  // (any caller outside an orchestration run) it is a no-op.
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

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      // The AbortController fired: the provider did not answer inside the budget.
      report({ status: "timeout", errorClass: "timeout", errorMessage: `Model request timed out after ${timeoutMs}ms` });
      throw new Error(`Model request timed out after ${timeoutMs}ms`);
    }
    report({ status: "network_error", errorClass: "network", errorMessage: String(e?.message || e).slice(0, 400) });
    throw e;
  }

  if (!response.ok) {
    clearTimeout(timer);
    const detail = await response.text();
    report({ status: "http_error", httpStatus: response.status, errorMessage: detail.slice(0, 400) });
    throw new Error(`Model request failed (${response.status}): ${detail.slice(0, 400)}`);
  }

  // --- Streaming path: used only by the Specialist/Synthesizer final answer ---
  if (stream) {
    let full = "";
    try {
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
            if (delta) { full += delta; onToken?.(delta); }
          } catch { /* skip malformed chunk */ }
        }
      }
      // No `usage` on a streamed completion unless the provider volunteers one,
      // so the recorder estimates from characters and flags it as estimated.
      report({ status: "success", charsOut: full.length });
      return full;
    } catch (e) {
      const aborted = e?.name === "AbortError";
      report({
        status: aborted ? "timeout" : "stream_error",
        errorClass: aborted ? "timeout" : "stream",
        errorMessage: aborted ? `Model request timed out after ${timeoutMs}ms` : String(e?.message || e).slice(0, 400),
        charsOut: full.length
      });
      throw aborted ? new Error(`Model request timed out after ${timeoutMs}ms`) : e;
    } finally { clearTimeout(timer); }
  }

  clearTimeout(timer);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  // Token usage, where the provider exposes it. Measured beats estimated, and
  // the record says which one it got.
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

export function buildContextSystemPrompt(workspace, memories, classification, base = 'You are COGNOS, an intelligent AI reasoning assistant. You provide thoughtful, accurate, and helpful responses. Use markdown formatting when appropriate for clarity.', style = null) {
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
  systemPrompt += styleDirective(style);
  return systemPrompt;
}
