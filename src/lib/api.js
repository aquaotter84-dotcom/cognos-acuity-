// The app's own API client. Replaces src/api/base44Client.js and the Base44 SDK.
// Same-origin relative URLs only — no VITE_ vars, no app-params, no *.base44.app.

async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error || detail; } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

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

  listActivity: () => req("/api/activity")
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
