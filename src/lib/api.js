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
  identity: () => req("/api/identity"),

  getWorkspace: () => req("/api/workspace"),
  updateWorkspace: (data) => req("/api/workspace", { method: "PATCH", body: data }),

  listConversations: () => req("/api/conversations"),
  createConversation: (title, projectId) => req("/api/conversations", { method: "POST", body: { title, projectId } }),
  renameConversation: (id, title) => req(`/api/conversations/${id}`, { method: "PATCH", body: { title } }),
  deleteConversation: (id) => req(`/api/conversations/${id}`, { method: "DELETE" }),
  getConversation: (id) => req(`/api/conversations/${id}/messages`),

  // --- Phase 18: durable research projects --------------------------------
  listProjects: () => req("/api/projects"),
  createProject: (name, objective) => req("/api/projects", { method: "POST", body: { name, objective } }),
  getProject: (id) => req(`/api/projects/${id}`),
  updateProject: (id, data) => req(`/api/projects/${id}`, { method: "PATCH", body: data }),
  deleteProject: (id) => req(`/api/projects/${id}`, { method: "DELETE" }),

  listMemories: () => req("/api/memories"),
  createMemory: (data) => req("/api/memories", { method: "POST", body: data }),
  updateMemory: (id, data) => req(`/api/memories/${id}`, { method: "PATCH", body: data }),
  deleteMemory: (id) => req(`/api/memories/${id}`, { method: "DELETE" }),

  listActivity: () => req("/api/activity"),

  // --- Phase 17: immutable document/link/image sources + bounded agent records ---
  listSources: (params = {}) => req(`/api/sources${qs(params)}`),
  source: (id) => req(`/api/sources/${id}`),
  uploadDocument: (data) => req("/api/sources/documents", { method: "POST", body: data }),
  openLink: (data) => req("/api/sources/links", { method: "POST", body: data }),
  /** Phase 18: PNG/JPEG/WebP originals; server-side vision readings when enabled. */
  uploadImage: (data) => req("/api/sources/images", { method: "POST", body: data }),
  /** Same-origin URL of the immutable original bytes (no secret in the URL). */
  imageUrl: (sourceId) => `/api/sources/${sourceId}/image`,
  agentTools: () => req("/api/agent/tools"),
  agentRuns: (params = {}) => req(`/api/agent/runs${qs(params)}`),
  agentRun: (id) => req(`/api/agent/runs/${id}`),
  /** Phase 18: user decides an awaiting_approval research plan (approve/decline). */
  decideAgentRun: (id, body) => req(`/api/agent/runs/${id}/decision`, { method: "POST", body }),

  // --- Phase 19: durable autonomy (residents, goals, outbox) ---------------
  // Every route here is either a query over stored rows or an authorization
  // decision. None of them produces an answer: a goal's findings surface only
  // when the user asks, through the council, through the Governor.
  autonomyStatus: () => req("/api/autonomy/status"),

  /** One row per resident — the current version of each brief. */
  listResidents: () => req("/api/autonomy/agents"),
  /** A resident plus every version of its brief, oldest first. */
  getResident: (id) => req(`/api/autonomy/agents/${id}`),
  createResident: (data) => req("/api/autonomy/agents", { method: "POST", body: data }),
  /** Changing a brief creates a NEW version; the superseded row is kept. */
  updateResident: (id, data) => req(`/api/autonomy/agents/${id}`, { method: "PATCH", body: data }),
  deleteResident: (id) => req(`/api/autonomy/agents/${id}`, { method: "DELETE" }),

  listGoals: (params = {}) => req(`/api/autonomy/goals${qs(params)}`),
  createGoal: (data) => req("/api/autonomy/goals", { method: "POST", body: data }),
  /** goal, events, steps, notes, approvals, outbox, subagents, promotions — the whole audit trail. */
  getGoal: (id) => req(`/api/autonomy/goals/${id}`),
  /** THE BARRIER: authorize | decline | pause | resume | cancel. */
  decideGoal: (id, body) => req(`/api/autonomy/goals/${id}/decision`, { method: "POST", body }),

  listNotices: (params = {}) => req(`/api/autonomy/notices${qs(params)}`),
  ackNotice: (id) => req(`/api/autonomy/notices/${id}/ack`, { method: "POST" }),

  /** Staged effects plus the shadow corpus that earns the next rung. */
  listOutbox: (params = {}) => req(`/api/autonomy/outbox${qs(params)}`),
  decideEffect: (id, body) => req(`/api/autonomy/outbox/${id}/decision`, { method: "POST", body }),

  // --- Phase 20: promotion — the only route from a note to knowledge ----
  // Listing is always visible; deciding applies the write the moment it lands.
  listPromotions: (params = {}) => req(`/api/autonomy/promotions${qs(params)}`),
  /** approve (and apply) | refuse. Only 'requested' rows can be decided. */
  decidePromotion: (id, body) => req(`/api/autonomy/promotions/${id}/decide`, { method: "POST", body }),

  listTicks: (params = {}) => req(`/api/autonomy/ticks${qs(params)}`),
  /** Run one bounded slice now. No-op (frozen) when autonomy is disabled. */
  runTick: (body = {}) => req("/api/autonomy/tick", { method: "POST", body }),

  // --- Phase 25: hybrid enablement, the attention queue, the designer --------
  /**
   * The delegated switch: what it is, who decided it, and whether this UI may
   * change it. `pinned` means an operator forced it in the environment and the
   * toggle cannot override that; `canToggle` false with no pin means the switch
   * was never delegated.
   */
  autonomySettings: (params = {}) => req(`/api/autonomy/settings${qs(params)}`),
  /** Flip it. 409 (with the reason in words) when pinned or not delegated. */
  setAutonomyEnabled: (enabled, body = {}) =>
    req("/api/autonomy/settings", { method: "POST", body: { enabled, ...body } }),
  /** What is waiting on a human, grouped, each group naming the tab that resolves it. */
  autonomyAttention: (params = {}) => req(`/api/autonomy/attention${qs(params)}`),
  /**
   * One designer turn. Stateless: send the transcript and the current draft, get
   * the next draft plus a short design note. Creates nothing.
   */
  designResident: (body) => req("/api/autonomy/designer", { method: "POST", body }),
  /** THE explicit click: create the resident, and optionally its first goal. */
  createDesignedResident: (body) => req("/api/autonomy/designer/create", { method: "POST", body }),

  // --- Phase 21: rungs and the evidence that earns them ---------------------
  // A rung flag says an operator switched it on. An evidence row says the
  // shadow corpus justified it. A live external write needs both.
  /** Every rung: built, flag, recorded evidence, and the corpus measured now. */
  listRungs: () => req("/api/autonomy/rungs"),
  /**
   * Measure the shadow corpus and record it as an evidence row. Append-only:
   * an insufficient measurement is recorded too, as the history of having asked.
   */
  recordRungEvidence: (rung, body = {}) =>
    req(`/api/autonomy/rungs/${encodeURIComponent(rung)}/evidence`, { method: "POST", body }),

  // --- Phase 22 (autonomy row): the earned flip to live --------------------
  // `listRungs().live` is the readiness report: eight named conditions, each
  // with a sentence to read when it is unmet. This is the flip itself.
  /**
   * Widen or narrow the outbox mode. 409 with `code: 'live_not_earned'` and the
   * whole readiness report attached when a widening to live has not been earned;
   * `not_delegated` when the deployment never handed the switch to this UI;
   * `pinned_by_operator` when an environment value holds the mode down.
   * Narrowing is refused by nothing.
   */
  setOutboxMode: (outboxMode, body = {}) =>
    req("/api/autonomy/settings", { method: "POST", body: { outboxMode, ...body } }),

  // --- Phase 26: forgo goal authorization ------------------------------
  /**
   * Flip auto-authorize. 409 with the reason in words when pinned or not
   * delegated. When on, newly created goals start active with their scope and
   * budget hashes recorded under decision_source 'auto'; staged effects still
   * wait for their own approval.
   */
  setAutoAuthorize: (autoAuthorize, body = {}) =>
    req("/api/autonomy/settings", { method: "POST", body: { autoAuthorize, ...body } }),

  // --- Phase 28: the earned-corpus bypass ------------------------------
  /**
   * Flip the earned-corpus bypass. 409 with the reason in words when pinned or
   * not delegated. When on, a live T4 release no longer waits for a recorded
   * shadow corpus aimed at the approved destination; the rung flag, the
   * destination, the per-effect Governor and every T5 approval still apply.
   */
  setBypassEarning: (bypassEarning, body = {}) =>
    req("/api/autonomy/settings", { method: "POST", body: { bypassEarning, ...body } }),

  // --- Phase 26: the delegated council switches (Critic, Governor) -------
  /** What is on, what is pinned, whether the UI may flip, and recent flips. */
  councilSettings: (params = {}) => req(`/api/council/settings${qs(params)}`),
  /** Flip one seat. 409 with the reason in words when pinned or not delegated. */
  setCouncilSwitch: (which, enabled, body = {}) =>
    req("/api/council/settings", { method: "POST", body: { switch: which, enabled, ...body } }),

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
  proposeAdaptation: (body) => req("/api/meta/adaptations", { method: "POST", body }),

  // --- Phase 23: the trust-annotated knowledge graph ("Atlas") -------------//
  // Queries are read-only instruments. Curation routes write new rows with
  // ledger events — retiring is a transition, never a delete.
  graphOverview: () => req("/api/graph/overview"),
  graphNodes: (params = {}) => req(`/api/graph/nodes${qs(params)}`),
  graphCreateNode: (body) => req("/api/graph/nodes", { method: "POST", body }),
  graphNode: (id) => req(`/api/graph/nodes/${id}`),
  graphPinNode: (id, body = {}) => req(`/api/graph/nodes/${id}/pin`, { method: "POST", body }),
  graphRetireNode: (id, body = {}) => req(`/api/graph/nodes/${id}/retire`, { method: "POST", body }),
  graphForkNode: (id, body = {}) => req(`/api/graph/nodes/${id}/fork`, { method: "POST", body }),
  graphReviseNode: (id, body = {}) => req(`/api/graph/nodes/${id}/revise`, { method: "POST", body }),
  graphTrustNode: (id, body) => req(`/api/graph/nodes/${id}/trust`, { method: "POST", body }),
  graphEdges: (params = {}) => req(`/api/graph/edges${qs(params)}`),
  graphCreateEdge: (body) => req("/api/graph/edges", { method: "POST", body }),
  graphEdge: (id) => req(`/api/graph/edges/${id}`),
  graphRetireEdge: (id, body = {}) => req(`/api/graph/edges/${id}/retire`, { method: "POST", body }),
  graphRelated: (nodeId, params = {}) => req(`/api/graph/related/${nodeId}${qs(params)}`),
  graphQuery: (params = {}) => req(`/api/graph/query${qs(params)}`),
  graphConflicts: (params = {}) => req(`/api/graph/conflicts${qs(params)}`),
  graphSnapshots: () => req("/api/graph/snapshots"),
  graphSnapshot: (id) => req(`/api/graph/snapshots/${id}`),
  graphCreateSnapshot: (body = {}) => req("/api/graph/snapshots", { method: "POST", body }),
  graphDiffSnapshots: (a, b) => req(`/api/graph/snapshots/diff${qs({ a, b })}`),
  graphVerify: () => req("/api/graph/verify"),
  graphCoverage: () => req("/api/graph/coverage")
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
