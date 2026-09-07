// Phase 14.1 — the Event Ledger.
//
// Append-only. Every transition of stored knowledge is a row here: nothing is
// UPDATEd, nothing is DELETEd. Retiring a belief is a transition, not a delete.
// This is deliberately NOT audit_events — that table keeps its rows and its
// meaning untouched and the ledger sits alongside it.
//
// The functions in this module take a query runner (`run`) as their first
// argument so they work identically inside a transaction (server/db.js
// withTransaction) and against the pool. Every knowledge write in the app calls
// them from inside the same transaction as the write itself.

import { newId } from "../db/util.js";

// --- Vocabulary ------------------------------------------------------------
// Each transition declares the entity it applies to and whether a later
// transition can undo it. "Reversible" is a property of the state change, not
// of the ledger: the ledger row itself is never removed either way.
const T = (entityType, reversible, note) => ({ entityType, reversible, note });

export const TRANSITIONS = Object.freeze({
  // beliefs / hypotheses
  belief_created: T("belief", true, "a new belief entered the store"),
  belief_updated: T("belief", true, "statement, status or counters changed"),
  belief_weakened: T("belief", true, "confidence lowered; the belief still stands"),
  belief_retired: T("belief", true, "withdrawn from active use — the row stays, status changes"),
  belief_reinstated: T("belief", true, "a retired belief was supported again"),
  belief_confirmed: T("belief", true, "independent support raised confidence"),
  confidence_changed: T("belief", true, "numeric confidence moved (a confidence_history row accompanies it)"),
  contradiction_detected: T("belief", false, "a measurement: two claims conflict. It happened; it cannot un-happen"),
  hypothesis_proposed: T("belief", true, "an unsupported-but-plausible claim recorded as a hypothesis"),
  hypothesis_confirmed: T("belief", true, "a hypothesis gathered support and became a belief"),
  hypothesis_abandoned: T("belief", false, "a hypothesis was contradicted past recovery"),

  // memories
  memory_written: T("memory", true, "a memory row was created"),
  memory_updated: T("memory", true, "content, importance, evidence or volatility changed"),
  memory_enabled: T("memory", true, "memory returned to service"),
  memory_disabled: T("memory", true, "memory taken out of service (soft)"),
  memory_retired: T("memory", false, "memory removed from the current-state table; its prior state is preserved here"),

  // conversations / summaries / goals
  summary_updated: T("conversation", true, "the running conversation summary changed"),
  conversation_updated: T("conversation", true, "conversation metadata changed (title, preview, archive)"),
  goal_updated: T("task_context", true, "a task goal was created or restated"),
  task_context_updated: T("task_context", true, "sub-tasks, status or final response changed"),

  // conclusions
  message_recorded: T("message", false, "a council conclusion (or a documented failure) was persisted"),

  // governance — the Governor's veto is knowledge about the run, not about a
  // belief. The refused draft is never stored: the event carries its length and
  // SHA-256 digest, the flags and the operator that produced it. Not reversible:
  // the veto happened, and nothing may un-record or re-ship it.
  veto_raised: T("run", false, "the Governor refused a draft; the draft itself is discarded, only its digest is kept"),

  // relationships
  relationship_created: T("relationship", true, "a new living structure"),
  relationship_strengthened: T("relationship", true, "interaction raised strength"),
  relationship_weakened: T("relationship", true, "interaction or contradiction lowered strength"),
  relationship_decayed: T("relationship", true, "time lowered strength — no writer involved"),
  relationship_merged: T("relationship", true, "two structures collapsed onto one"),
  relationship_split: T("relationship", true, "one structure divided into successors")
});

export const ENTITY_TYPES = Object.freeze(
  Array.from(new Set(Object.values(TRANSITIONS).map(t => t.entityType)))
);

export const SOURCE_KINDS = Object.freeze(["run", "message", "api", "sweep", "operator", "system"]);

export function isTransition(name) {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, name);
}

// --- State snapshots -------------------------------------------------------
// to_state carries the complete tracked projection of the entity, so folding
// the ledger alone reproduces current state (Phase 14.2). Long strings and
// long arrays are capped: the ledger records state, not payloads.
const MAX_STRING = 4000;
const MAX_ARRAY = 50;

export function snapshot(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING}]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (depth > 4) return "[deep]";
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map(v => snapshot(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…[+${value.length - MAX_ARRAY} more]`] : head;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = snapshot(v, depth + 1);
    return out;
  }
  return String(value);
}

function json(value) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(snapshot(value));
}

function normalizeEvent(input) {
  const transition = input.transition;
  if (!isTransition(transition)) {
    throw new Error(`Unknown ledger transition: ${transition}. Add it to TRANSITIONS in server/knowledge/events.js before using it.`);
  }
  const spec = TRANSITIONS[transition];
  const entityType = input.entityType || spec.entityType;
  if (!input.entityId) throw new Error(`Ledger event ${transition} requires an entityId`);
  const reversible = typeof input.reversible === "boolean" ? input.reversible : spec.reversible;
  return {
    id: input.id || newId("kev"),
    ts_ms: Number(input.tsMs ?? input.ts_ms ?? Date.now()),
    workspace_id: input.workspaceId ?? input.workspace_id ?? null,
    entity_type: entityType,
    entity_id: String(input.entityId),
    transition,
    from_state: json(input.fromState ?? input.from_state ?? null),
    to_state: json(input.toState ?? input.to_state ?? null),
    delta: json(input.delta ?? null),
    source_kind: input.sourceKind || input.source_kind || (input.sourceRunId || input.source_run_id ? "run" : "system"),
    source_message_id: input.sourceMessageId ?? input.source_message_id ?? null,
    source_run_id: input.sourceRunId ?? input.source_run_id ?? null,
    reversible,
    payload: json(input.payload ?? null)
  };
}

const COLUMNS = [
  "id", "ts_ms", "workspace_id", "entity_type", "entity_id", "transition",
  "from_state", "to_state", "delta", "source_kind", "source_message_id",
  "source_run_id", "reversible", "payload"
];

/** Append one event. Returns the stored row. */
export async function appendEvent(run, event) {
  const rows = await appendEvents(run, [event]);
  return rows[0] || null;
}

/** Append many events in ONE statement — the ledger is written inside the same
 *  transaction as the state change it describes, so round trips matter. */
export async function appendEvents(run, events) {
  const list = (events || []).filter(Boolean);
  if (list.length === 0) return [];
  const norm = list.map(normalizeEvent);
  const values = [];
  const tuples = norm.map((e, i) => {
    const base = i * COLUMNS.length;
    COLUMNS.forEach((col, j) => values.push(e[col]));
    return `(${COLUMNS.map((_, j) => `$${base + j + 1}`).join(",")})`;
  });
  return run(
    `INSERT INTO knowledge_events (${COLUMNS.join(", ")}) VALUES ${tuples.join(", ")} RETURNING *`,
    values
  );
}

/** Shared filter builder, so a listing and a count of the same filter agree. */
export function buildEventFilter({
  entityType = null, entityId = null, transition = null, transitions = null,
  runId = null, messageId = null, workspaceId = null, untilMs = null, sinceMs = null
} = {}) {
  const clauses = [];
  const params = [];
  const push = (sql, value) => { params.push(value); clauses.push(sql.replace("?", `$${params.length}`)); };
  if (entityType) push("entity_type = ?", entityType);
  if (entityId) push("entity_id = ?", entityId);
  if (transition) push("transition = ?", transition);
  if (Array.isArray(transitions) && transitions.length) {
    params.push(transitions);
    clauses.push(`transition = ANY($${params.length})`);
  }
  if (runId) push("source_run_id = ?", runId);
  if (messageId) push("source_message_id = ?", messageId);
  if (workspaceId) push("workspace_id = ?", workspaceId);
  if (untilMs != null) push("ts_ms <= ?", Number(untilMs));
  if (sinceMs != null) push("ts_ms >= ?", Number(sinceMs));
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Read the ledger. Filters are ANDed; nothing here mutates. */
export async function listEvents(run, filter = {}) {
  const { where, params } = buildEventFilter(filter);
  const limit = Math.max(1, Math.min(Number(filter.limit) || 200, 2000));
  params.push(limit);
  return run(
    `SELECT * FROM knowledge_events ${where} ORDER BY seq ASC LIMIT $${params.length}`,
    params
  );
}

/** COUNT(*) — for telemetry totals, without pulling rows across the network. */
export async function countEvents(run, filter = {}) {
  const { where, params } = buildEventFilter(filter);
  const rows = await run(`SELECT count(*)::int AS n FROM knowledge_events ${where}`, params);
  return Number(rows[0]?.n ?? 0);
}

/** Latest-first view, for endpoints and analytics. */
export async function recentEvents(run, opts = {}) {
  const rows = await listEvents(run, { ...opts, limit: opts.limit ?? 200 });
  return rows.reverse();
}

// --- 14.2 State reconstruction --------------------------------------------
// Current state is the fold of history: start from nothing, apply each
// recorded to_state in ledger order. `atMs` truncates the history, which is how
// any entity's state at any past instant is reconstructed.
export function foldState(events, { atMs = null } = {}) {
  const ordered = (events || [])
    .filter(e => (atMs == null ? true : Number(e.ts_ms) <= Number(atMs)))
    .slice()
    .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0) || Number(a.ts_ms) - Number(b.ts_ms));

  let state = null;
  const history = [];
  for (const e of ordered) {
    const from = parse(e.from_state);
    const to = parse(e.to_state);
    if (state === null && from && typeof from === "object") state = { ...from };
    if (state === null) state = {};
    if (to && typeof to === "object") state = { ...state, ...to };
    history.push({
      id: e.id,
      seq: Number(e.seq ?? 0),
      ts_ms: Number(e.ts_ms),
      at: new Date(Number(e.ts_ms)).toISOString(),
      transition: e.transition,
      delta: parse(e.delta),
      reversible: e.reversible,
      source_run_id: e.source_run_id,
      source_message_id: e.source_message_id
    });
  }
  return {
    exists: ordered.length > 0,
    state,
    eventCount: ordered.length,
    firstEventAt: history[0]?.at ?? null,
    lastTransition: history.length ? history[history.length - 1] : null,
    history
  };
}

export function parse(maybeJson) {
  if (maybeJson === null || maybeJson === undefined) return null;
  if (typeof maybeJson === "object") return maybeJson;
  try { return JSON.parse(maybeJson); } catch { return maybeJson; }
}

/** Compare a folded state against the materialized current-state row.
 *  Drift means a write path changed state without telling the ledger. */
export function diffState(folded, current, fields) {
  const drift = [];
  for (const f of fields) {
    const a = folded?.[f];
    const b = current?.[f];
    const na = typeof a === "string" && !Number.isNaN(Number(a)) && a.trim() !== "" ? Number(a) : a;
    const nb = typeof b === "string" && !Number.isNaN(Number(b)) && b.trim() !== "" ? Number(b) : b;
    const same = JSON.stringify(na ?? null) === JSON.stringify(nb ?? null)
      || (typeof na === "number" && typeof nb === "number" && Math.abs(na - nb) < 1e-9);
    if (!same) drift.push({ field: f, folded: na ?? null, current: nb ?? null });
  }
  return { drift, consistent: drift.length === 0 };
}
