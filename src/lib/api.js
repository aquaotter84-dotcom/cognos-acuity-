// The app's own API client. Replaces src/api/base44Client.js and the Base44 SDK.
// Same-origin relative URLs only — no VITE_ vars, no app-params, no *.base44.app.

/** Build a query string, dropping empty values. */
function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : "";
}

export class ApiError extends Error {
  constructor(message, { status = 0, statusText = "", body = null } = {}) {
    super(message || statusText || "Request failed");
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    this.code = body?.code || null;
  }
}

/**
 * Same-origin JSON request helper. Non-2xx responses retain their parsed body
 * on ApiError.body so a domain response such as a Policy Engine refusal (409)
 * reaches the UI intact instead of collapsing to the string "Conflict".
 */
export async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let body = null;
  if (res.status !== 204) {
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = text; }
    }
  }

  if (!res.ok) {
    const message = typeof body === "object" && body
      ? body.error || body.message || (Array.isArray(body.reasons) ? body.reasons[0] : null)
      : (typeof body === "string" ? body : null);
    throw new ApiError(message || res.statusText, {
      status: res.status,
      statusText: res.statusText,
      body
    });
  }
  return body;
}

const req = request;

export const api = {
  health: () => req("/api/health"),

  getWorkspace: () => req("/api/workspace"),
  updateWorkspace: (data) => req("/api/workspace", { method: "PATCH", body: data }),

  listConversations: () => req("/api/conversations"),
  renameConversation: (id, title) => req(`/api/conversations/${id}`, { method: "PATCH", body: { title } }),
  deleteConversation: (id) => req(`/api/conversations/${id}`, { method: "DELETE" }),
  getConversation: (id) => req(`/api/conversations/${id}/messages`),

  listMemories: () => req("/api/memories"),
  createMemory: (data) => req("/api/memories", { method: "POST", body: data }),
  updateMemory: (id, data) => req(`/api/memories/${id}`, { method: "PATCH", body: data }),
  deleteMemory: (id) => req(`/api/memories/${id}`, { method: "DELETE" }),

  listActivity: () => req("/api/activity"),

  // --- Phase 14: the knowledge layer (read-only) ---------------------------
  knowledgeEvents: (params = {}) => req(`/api/knowledge/events${qs(params)}`),
  knowledgeOverview: () => req("/api/knowledge/overview"),
  knowledgeAnalytics: (params = {}) => req(`/api/knowledge/analytics${qs(params)}`),
  knowledgeBeliefs: (params = {}) => req(`/api/knowledge/beliefs${qs(params)}`),
  knowledgeRelationships: (params = {}) => req(`/api/knowledge/relationships${qs(params)}`),
  knowledgeCoherence: (params = {}) => req(`/api/knowledge/coherence${qs(params)}`),
  /** REPLAY: an entity's state as it was at `at` (epoch ms or ISO string). */
  knowledgeState: (entityType, entityId, params = {}) => req(`/api/knowledge/state/${entityType}/${entityId}${qs(params)}`),
  knowledgeLineage: (entityType, entityId) => req(`/api/knowledge/lineage/${entityType}/${entityId}`),
  knowledgeRunLineage: (runId) => req(`/api/knowledge/lineage/run/${runId}`),
  knowledgeTemporal: (entityType, entityId) => req(`/api/knowledge/temporal/${entityType}/${entityId}`),

  // --- Phase 15: meta-cognition -------------------------------------------
  telemetryRuns: (params = {}) => req(`/api/meta/telemetry${qs(params)}`),
  telemetrySummary: () => req("/api/meta/telemetry?summary=1"),
  telemetryRun: (runId) => req(`/api/meta/telemetry/${runId}`),
  modelCalls: (params = {}) => req(`/api/meta/model-calls${qs(params)}`),
  strategies: () => req("/api/meta/strategies"),
  laws: () => req("/api/meta/laws"),
  policy: () => req("/api/meta/policy"),
  improvements: (params = {}) => req(`/api/meta/improvements${qs(params)}`),
  adaptive: () => req("/api/meta/adaptive"),
  evaluations: () => req("/api/meta/evaluations"),
  rateTable: () => req("/api/meta/rates"),
  /** The gate: propose an adaptation. Refusals come back 409 with the laws cited. */
  proposeAdaptation: (body) => req("/api/meta/adaptations", { method: "POST", body })
};

/**
 * THE send path, client side. Opens the SSE stream from POST /api/chat and
 * forwards each council event to `handlers`. One function; nothing else in the
 * app posts a chat turn.
 */
export async function sendMessage(payload, handlers = {}, signal) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal
  });

  if (!res.ok || !res.body) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch { /* non-JSON */ }
    throw new Error(detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      let event = "message";
      const dataLines = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let data;
      try { data = JSON.parse(dataLines.join("\n")); } catch { continue; }
      handlers[event]?.(data);
      handlers.any?.(event, data);
    }
  }
}
