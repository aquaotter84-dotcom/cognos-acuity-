// Phase 23 — Persistent, Trust-Annotated Knowledge-Graph Layer ("Atlas").
//
// The one-shot evolution: a system-wide, user-controlled, immutable memory
// fabric that stitches every session, every source, every intent, and every
// footstep into a single queryable, provenance-driven graph.
//
// Design (mirrors the belief/relationship modules, same conventions):
//   * Every function takes a query runner `run` first, so it works identically
//     inside withTransaction() and against the pool. Every write appends its
//     own ledger event on that same runner — state and history commit or roll
//     back together. Nothing here ever issues a DELETE against graph tables.
//   * Nodes: Concept, Person, Source, Event, Intent. Edges: is-about,
//     in-source, refines, contradicts, plus supports/revision/fork lifecycle
//     kinds that chain every curation act to its predecessor.
//   * Every node and edge carries a provenance block (timestamp, actor,
//     version, cryptographic hash). Hashes are recomputable from stored
//     fields; snapshots carry a Merkle root over the sorted leaf hashes.
//   * Trust is data, not authority: verified/trusted rows may satisfy a truth
//     query; untrusted/flagged rows are visible but never load-bearing until
//     a user approves them. The Governor enforces that boundary; the Critic
//     surfaces contradicts edges for manual resolution.
//
// This module is a subsystem the council consults. It holds no seat, casts no
// vote, and cannot release an answer.

import { createHash } from "node:crypto";
import { newId, num, int, clamp01, nowMs } from "../db/util.js";
import { appendEvents, parse } from "./events.js";

export const NODE_TYPES = Object.freeze(["concept", "person", "source", "event", "intent"]);
export const EDGE_KINDS = Object.freeze([
  "is-about", "in-source", "refines", "contradicts", "supports", "revision", "fork"
]);
export const TRUST_LEVELS = Object.freeze(["verified", "trusted", "untrusted", "flagged"]);
export const NODE_STATUSES = Object.freeze(["active", "pinned", "retired"]);
export const EDGE_STATUSES = Object.freeze(["active", "retired"]);

export const GRAPH_NODE_TRACKED_FIELDS = Object.freeze([
  "type", "label", "content", "status", "trust", "confidence", "version",
  "predecessor_id", "successor_id"
]);
export const GRAPH_EDGE_TRACKED_FIELDS = Object.freeze([
  "kind", "status", "trust", "weight", "version", "predecessor_id", "successor_id"
]);

const TRUST_RANK = Object.freeze({ verified: 3, trusted: 2, untrusted: 1, flagged: 0 });

export function normalizeNodeType(value) {
  const v = String(value || "").trim().toLowerCase();
  return NODE_TYPES.includes(v) ? v : "concept";
}

export function normalizeEdgeKind(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "is_about" || v === "isabout") return "is-about";
  if (v === "in_source" || v === "insource") return "in-source";
  return EDGE_KINDS.includes(v) ? v : "is-about";
}

export function normalizeTrust(value, fallback = "untrusted") {
  const v = String(value || "").trim().toLowerCase();
  if (TRUST_LEVELS.includes(v)) return v;
  const f = String(fallback || "untrusted").trim().toLowerCase();
  return TRUST_LEVELS.includes(f) ? f : "untrusted";
}

/** Verified and trusted rows may satisfy a truth query. Everything else is visible but never load-bearing. */
export function trustSatisfiesTruth(trust) {
  return trust === "verified" || trust === "trusted";
}

export function trustRank(trust) {
  return TRUST_RANK[normalizeTrust(trust)] ?? 1;
}

/** Trust derived from a memory's evidence level. Verified is never derived — only a user act earns it. */
export function trustFromEvidenceLevel(evidenceLevel) {
  switch (String(evidenceLevel || "").toLowerCase()) {
    case "direct":
    case "repeated":
      return "trusted";
    case "assumed":
      return "flagged";
    case "inferred":
    default:
      return "untrusted";
  }
}

function cleanText(value, limit = 2000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function cleanLabel(value, fallback = "untitled") {
  const label = cleanText(value, 240);
  return label || fallback;
}

/** Normalized identity of a node. Same type + same normalized label = same key. */
export function nodeKey(type, label) {
  const t = normalizeNodeType(type);
  const key = String(label || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return `${t}:${key || "untitled"}`;
}

function sha256(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/** Canonical JSON: sorted keys, stable across runs, so hashes are recomputable. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function hashCanonical(value) {
  return sha256(canonicalJson(value));
}

/**
 * Provenance block carried by every node and edge: timestamp, actor, version,
 * and the cryptographic hash that seals the row. The hash covers the content
 * fields plus the provenance-without-hash, so verification recomputes it from
 * stored columns alone.
 */
export function buildProvenance({ actor = "system", version = 1, prevHash = null, runId = null, messageId = null, conversationId = null, memoryId = null, sourceIds = [], note = null, tsMs = null } = {}) {
  const cleanActor = ["user", "council", "system", "promotion", "api"].includes(String(actor)) ? String(actor) : "system";
  return {
    ts_ms: Number(tsMs ?? nowMs()),
    actor: cleanActor,
    version_id: `v${int(version, 1)}`,
    prev_hash: prevHash || null,
    run_id: runId || null,
    message_id: messageId || null,
    conversation_id: conversationId || null,
    memory_id: memoryId || null,
    source_ids: Array.from(new Set((Array.isArray(sourceIds) ? sourceIds : []).map(String).filter(Boolean))).slice(0, 12),
    note: note ? cleanText(note, 280) : null
  };
}

function nodeHashInput(row, provenance) {
  return {
    kind: "graph_node",
    type: normalizeNodeType(row.type),
    label: String(row.label || ""),
    content: String(row.content || ""),
    trust: normalizeTrust(row.trust),
    confidence: Number(num(row.confidence, 0.5).toFixed(4)),
    version: int(row.version, 1),
    predecessor_id: row.predecessor_id || null,
    provenance
  };
}

function edgeHashInput(row, provenance) {
  return {
    kind: "graph_edge",
    src: String(row.src_node_id || ""),
    dst: String(row.dst_node_id || ""),
    edge_kind: normalizeEdgeKind(row.kind),
    trust: normalizeTrust(row.trust),
    weight: Number(num(row.weight, 0.5).toFixed(4)),
    version: int(row.version, 1),
    predecessor_id: row.predecessor_id || null,
    provenance
  };
}

export function computeNodeHash(row, provenance) {
  return hashCanonical(nodeHashInput(row, provenance));
}

export function computeEdgeHash(row, provenance) {
  return hashCanonical(edgeHashInput(row, provenance));
}

export function graphNodeState(row) {
  if (!row) return null;
  return {
    type: normalizeNodeType(row.type),
    label: row.label ?? null,
    content: row.content ?? null,
    status: row.status ?? "active",
    trust: normalizeTrust(row.trust),
    confidence: num(row.confidence, 0.5),
    version: int(row.version, 1),
    predecessor_id: row.predecessor_id ?? null,
    successor_id: row.successor_id ?? null
  };
}

export function graphEdgeState(row) {
  if (!row) return null;
  return {
    kind: normalizeEdgeKind(row.kind),
    status: row.status ?? "active",
    trust: normalizeTrust(row.trust),
    weight: num(row.weight, 0.5),
    version: int(row.version, 1),
    predecessor_id: row.predecessor_id ?? null,
    successor_id: row.successor_id ?? null
  };
}

// --- reads -----------------------------------------------------------------

export async function getNode(run, id) {
  const rows = await run(`SELECT * FROM graph_nodes WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getEdge(run, id) {
  const rows = await run(`SELECT * FROM graph_edges WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function listNodes(run, workspaceId, { type = null, status = null, trust = null, conversationId = null, projectId = null, q = null, truthOnly = false, limit = 100 } = {}) {
  const clauses = ["workspace_id = $1"];
  const params = [workspaceId];
  if (type) { params.push(normalizeNodeType(type)); clauses.push(`type = $${params.length}`); }
  if (status) { params.push(String(status)); clauses.push(`status = $${params.length}`); }
  if (truthOnly) {
    clauses.push(`trust IN ('verified','trusted') AND status IN ('active','pinned')`);
  } else if (trust) {
    params.push(normalizeTrust(trust)); clauses.push(`trust = $${params.length}`);
  }
  if (conversationId) { params.push(String(conversationId)); clauses.push(`conversation_id = $${params.length}`); }
  if (projectId) { params.push(String(projectId)); clauses.push(`project_id = $${params.length}`); }
  if (q) {
    params.push(`%${String(q).slice(0, 120)}%`);
    clauses.push(`(label ILIKE $${params.length} OR content ILIKE $${params.length})`);
  }
  params.push(Math.max(1, Math.min(int(limit, 100), 500)));
  return run(
    `SELECT * FROM graph_nodes WHERE ${clauses.join(" AND ")} ORDER BY updated_date DESC LIMIT $${params.length}`,
    params
  );
}

export async function findNodeByKey(run, workspaceId, type, label) {
  const rows = await run(
    `SELECT * FROM graph_nodes WHERE workspace_id = $1 AND node_key = $2 AND successor_id IS NULL ORDER BY version DESC LIMIT 1`,
    [workspaceId, nodeKey(type, label)]
  );
  return rows[0] || null;
}

export async function listEdges(run, workspaceId, { kind = null, status = null, trust = null, nodeId = null, truthOnly = false, limit = 200 } = {}) {
  const clauses = ["workspace_id = $1"];
  const params = [workspaceId];
  if (kind) { params.push(normalizeEdgeKind(kind)); clauses.push(`kind = $${params.length}`); }
  if (truthOnly) {
    clauses.push(`trust IN ('verified','trusted') AND status = 'active'`);
  } else {
    if (status) { params.push(String(status)); clauses.push(`status = $${params.length}`); }
    if (trust) { params.push(normalizeTrust(trust)); clauses.push(`trust = $${params.length}`); }
  }
  if (nodeId) {
    params.push(String(nodeId));
    clauses.push(`(src_node_id = $${params.length} OR dst_node_id = $${params.length})`);
  }
  params.push(Math.max(1, Math.min(int(limit, 200), 1000)));
  return run(
    `SELECT * FROM graph_edges WHERE ${clauses.join(" AND ")} ORDER BY created_date DESC LIMIT $${params.length}`,
    params
  );
}

export async function findEdge(run, { workspaceId, kind, srcNodeId, dstNodeId }) {
  const rows = await run(
    `SELECT * FROM graph_edges WHERE workspace_id = $1 AND kind = $2 AND src_node_id = $3 AND dst_node_id = $4 AND status = 'active' LIMIT 1`,
    [workspaceId, normalizeEdgeKind(kind), String(srcNodeId), String(dstNodeId)]
  );
  return rows[0] || null;
}

export async function edgesForNode(run, nodeId, { kinds = null, status = "active", limit = 100 } = {}) {
  const params = [String(nodeId)];
  const clauses = [`(src_node_id = $1 OR dst_node_id = $1)`];
  if (status) { params.push(String(status)); clauses.push(`status = $${params.length}`); }
  if (Array.isArray(kinds) && kinds.length) {
    params.push(kinds.map(normalizeEdgeKind));
    clauses.push(`kind = ANY($${params.length})`);
  }
  params.push(Math.max(1, Math.min(int(limit, 100), 500)));
  return run(`SELECT * FROM graph_edges WHERE ${clauses.join(" AND ")} ORDER BY created_date DESC LIMIT $${params.length}`, params);
}

// --- writes ----------------------------------------------------------------

async function insertNode(run, n) {
  const rows = await run(
    `INSERT INTO graph_nodes (id, workspace_id, project_id, conversation_id, type, label, node_key, content,
                              content_sha256, status, trust, confidence, version, predecessor_id, successor_id,
                              provenance, source_memory_id, source_message_id, source_run_id, source_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [n.id, n.workspace_id, n.project_id || null, n.conversation_id || null, n.type, n.label, n.node_key, n.content,
     n.content_sha256, n.status, n.trust, n.confidence, n.version, n.predecessor_id || null, n.successor_id || null,
     JSON.stringify(n.provenance), n.source_memory_id || null, n.source_message_id || null, n.source_run_id || null,
     JSON.stringify(n.source_ids || [])]
  );
  return rows[0];
}

async function updateNode(run, id, patch) {
  const cols = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    values.push(k === "provenance" || k === "source_ids" ? JSON.stringify(v) : v);
    cols.push(`${k} = $${values.length}`);
  }
  if (!cols.length) return getNode(run, id);
  cols.push(`updated_date = now()`);
  values.push(id);
  const rows = await run(`UPDATE graph_nodes SET ${cols.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
  return rows[0] || null;
}

async function insertEdge(run, e) {
  const rows = await run(
    `INSERT INTO graph_edges (id, workspace_id, src_node_id, dst_node_id, kind, status, trust, weight,
                              version, predecessor_id, successor_id, provenance, edge_sha256, source_run_id, source_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [e.id, e.workspace_id, e.src_node_id, e.dst_node_id, e.kind, e.status, e.trust, e.weight,
     e.version, e.predecessor_id || null, e.successor_id || null, JSON.stringify(e.provenance),
     e.edge_sha256, e.source_run_id || null, e.source_message_id || null]
  );
  return rows[0];
}

async function updateEdge(run, id, patch) {
  const cols = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    values.push(k === "provenance" ? JSON.stringify(v) : v);
    cols.push(`${k} = $${values.length}`);
  }
  if (!cols.length) return getEdge(run, id);
  cols.push(`updated_date = now()`);
  values.push(id);
  const rows = await run(`UPDATE graph_edges SET ${cols.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
  return rows[0] || null;
}

/**
 * Create a node. Deduplicates on (workspace, node_key) for the live head: a
 * repeat creation returns the existing node instead of forking the atlas.
 */
export async function createNode(run, {
  workspaceId, type = "concept", label, content = null,
  trust = "untrusted", confidence = 0.5, status = "active",
  projectId = null, conversationId = null,
  sourceMemoryId = null, sourceMessageId = null, sourceRunId = null, sourceIds = [],
  actor = "system", note = null, provenance = null, tsMs = null
}) {
  const clean = cleanLabel(label);
  const body = cleanText(content ?? clean, 4000);
  const live = await findNodeByKey(run, workspaceId, type, clean);
  if (live) return { node: live, events: [], existing: true };

  const id = newId("graph");
  const version = 1;
  const prov = provenance || buildProvenance({
    actor, version, runId: sourceRunId, messageId: sourceMessageId,
    conversationId, memoryId: sourceMemoryId, sourceIds, note, tsMs
  });
  const draft = {
    type: normalizeNodeType(type), label: clean, content: body,
    trust: normalizeTrust(trust), confidence: clamp01(num(confidence, 0.5)),
    version, predecessor_id: null
  };
  const hash = computeNodeHash(draft, prov);
  const sealed = { ...prov, hash };
  const created = await insertNode(run, {
    id, workspace_id: workspaceId, project_id: projectId, conversation_id: conversationId,
    type: draft.type, label: clean, node_key: nodeKey(type, clean), content: body,
    content_sha256: hash, status: NODE_STATUSES.includes(status) ? status : "active",
    trust: draft.trust, confidence: draft.confidence, version,
    predecessor_id: null, successor_id: null, provenance: sealed,
    source_memory_id: sourceMemoryId, source_message_id: sourceMessageId,
    source_run_id: sourceRunId, source_ids: Array.from(new Set((sourceIds || []).map(String))).slice(0, 12)
  });
  const events = await appendEvents(run, [{
    workspaceId,
    entityType: "graph_node",
    entityId: id,
    transition: "graph_node_created",
    toState: { ...graphNodeState(created), id, node_key: created.node_key, content_sha256: hash },
    delta: { trust: draft.trust, version },
    sourceRunId: sourceRunId ?? null,
    sourceMessageId: sourceMessageId ?? null,
    sourceKind: actor === "user" ? "api" : "run",
    payload: { type: draft.type, label: clean, provenance: sealed }
  }]);
  return { node: created, events, created: true };
}

/**
 * Create an edge between two nodes in the same workspace. Both endpoints must
 * exist; cross-workspace links are refused. Duplicate active edges resolve to
 * the existing row.
 */
export async function createEdge(run, {
  workspaceId, srcNodeId, dstNodeId, kind = "is-about",
  trust = "untrusted", weight = 0.5,
  sourceRunId = null, sourceMessageId = null, actor = "system", note = null, tsMs = null
}) {
  const ekind = normalizeEdgeKind(kind);
  const [src, dst] = await Promise.all([getNode(run, srcNodeId), getNode(run, dstNodeId)]);
  if (!src || !dst) {
    const err = new Error("Both edge endpoints must exist");
    err.status = 404;
    throw err;
  }
  if (src.workspace_id !== workspaceId || dst.workspace_id !== workspaceId) {
    const err = new Error("Graph edges cannot cross workspaces");
    err.status = 400;
    throw err;
  }
  const live = await findEdge(run, { workspaceId, kind: ekind, srcNodeId, dstNodeId });
  if (live) return { edge: live, events: [], existing: true };

  const id = newId("gedge");
  const prov = buildProvenance({ actor, version: 1, runId: sourceRunId, messageId: sourceMessageId, note, tsMs });
  const draft = {
    src_node_id: String(srcNodeId), dst_node_id: String(dstNodeId),
    kind: ekind, trust: normalizeTrust(trust), weight: clamp01(num(weight, 0.5)),
    version: 1, predecessor_id: null
  };
  const hash = computeEdgeHash(draft, prov);
  const sealed = { ...prov, hash };
  const created = await insertEdge(run, {
    id, workspace_id: workspaceId, ...draft, status: "active",
    successor_id: null, provenance: sealed, edge_sha256: hash,
    source_run_id: sourceRunId, source_message_id: sourceMessageId
  });
  const events = await appendEvents(run, [{
    workspaceId,
    entityType: "graph_edge",
    entityId: id,
    transition: "graph_edge_created",
    toState: { ...graphEdgeState(created), id, src_node_id: created.src_node_id, dst_node_id: created.dst_node_id, edge_sha256: hash },
    delta: { kind: ekind, trust: draft.trust },
    sourceRunId: sourceRunId ?? null,
    sourceMessageId: sourceMessageId ?? null,
    sourceKind: actor === "user" ? "api" : "run",
    payload: { provenance: sealed }
  }]);
  return { edge: created, events, created: true };
}

/**
 * User-controlled curation: pin a node. Pinning marks the row curated AND
 * lifts trust to verified — the only write path that mints verified trust.
 * The previous state is preserved in the ledger; nothing is overwritten.
 */
export async function pinNode(run, { nodeId, actor = "user", source = {}, note = null }) {
  const node = await getNode(run, nodeId);
  if (!node) { const e = new Error("Graph node not found"); e.status = 404; throw e; }
  if (node.status === "retired") { const e = new Error("A retired node cannot be pinned; fork it instead"); e.status = 409; throw e; }
  const ts = nowMs();
  const prev = graphNodeState(node);
  const prevProv = parse(node.provenance) || {};
  const prov = buildProvenance({
    actor, version: int(node.version, 1), prevHash: node.content_sha256 || null,
    runId: source.runId ?? null, messageId: source.messageId ?? null,
    conversationId: node.conversation_id, memoryId: node.source_memory_id,
    sourceIds: parse(node.source_ids) || [], note: note || "pinned by the user", tsMs: ts
  });
  // The seal covers the NEW state; recompute the hash for pinned+verified.
  const next = { ...prev, status: "pinned", trust: "verified" };
  const hash = computeNodeHash({ ...node, ...next }, prov);
  const sealed = { ...prov, hash };
  const updated = await updateNode(run, nodeId, {
    status: "pinned", trust: "verified", content_sha256: hash, provenance: sealed
  });
  const events = await appendEvents(run, [
    {
      workspaceId: node.workspace_id, entityType: "graph_node", entityId: nodeId,
      transition: "graph_node_pinned", fromState: prev, toState: graphNodeState(updated),
      delta: { status: "pinned", trust: "verified" },
      sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
      sourceKind: actor === "user" ? "api" : "run",
      payload: { provenance: sealed }
    },
    {
      workspaceId: node.workspace_id, entityType: "graph_node", entityId: nodeId,
      transition: "graph_trust_changed", fromState: { trust: prev.trust }, toState: { trust: "verified" },
      delta: { trust: "verified", cause: "pin" },
      sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
      sourceKind: actor === "user" ? "api" : "run"
    }
  ]);
  return { node: updated, events };
}

/** Retire a node: a transition, never a delete. The row stays with its history. */
export async function retireNode(run, { nodeId, actor = "user", source = {}, note = null, successorId = null }) {
  const node = await getNode(run, nodeId);
  if (!node) { const e = new Error("Graph node not found"); e.status = 404; throw e; }
  if (node.status === "retired") return { node, events: [], existing: true };
  const ts = nowMs();
  const prev = graphNodeState(node);
  const prov = buildProvenance({
    actor, version: int(node.version, 1), prevHash: node.content_sha256 || null,
    runId: source.runId ?? null, messageId: source.messageId ?? null,
    conversationId: node.conversation_id, memoryId: node.source_memory_id,
    sourceIds: parse(node.source_ids) || [], note: note || "retired", tsMs: ts
  });
  const next = { ...prev, status: "retired", successor_id: successorId || node.successor_id || null };
  const hash = computeNodeHash({ ...node, ...next }, prov);
  const sealed = { ...prov, hash };
  const updated = await updateNode(run, nodeId, {
    status: "retired", retired_at_ms: ts,
    successor_id: successorId || node.successor_id || null,
    content_sha256: hash, provenance: sealed
  });
  const events = await appendEvents(run, [{
    workspaceId: node.workspace_id, entityType: "graph_node", entityId: nodeId,
    transition: "graph_node_retired", fromState: prev, toState: graphNodeState(updated),
    delta: { status: "retired", successor_id: updated.successor_id },
    sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
    sourceKind: actor === "user" ? "api" : "run",
    payload: { reason: note || "retired", provenance: sealed }
  }]);
  return { node: updated, events };
}

/**
 * Fork a node: the old row keeps its line; a new node continues it. A fork
 * edge chains the lines, so the atlas never loses where a thought went.
 */
export async function forkNode(run, { nodeId, label = null, content = null, actor = "user", source = {}, note = null, trust = null }) {
  const node = await getNode(run, nodeId);
  if (!node) { const e = new Error("Graph node not found"); e.status = 404; throw e; }
  const ts = nowMs();
  const newLabel = cleanLabel(label || `${node.label} (fork)`);
  // Forks get their own key suffix so they never collide with the live head.
  const forkSuffix = `fork ${new Date(ts).toISOString().slice(0, 10)} ${String(nodeId).slice(-4)}`;
  const id = newId("graph");
  const prov = buildProvenance({
    actor, version: 1, prevHash: node.content_sha256 || null,
    runId: source.runId ?? null, messageId: source.messageId ?? null,
    conversationId: node.conversation_id, memoryId: node.source_memory_id,
    sourceIds: parse(node.source_ids) || [], note: note || `forked from ${nodeId}`, tsMs: ts
  });
  const draft = {
    type: normalizeNodeType(node.type), label: newLabel,
    content: cleanText(content ?? node.content, 4000),
    trust: trust ? normalizeTrust(trust) : normalizeTrust(node.trust),
    confidence: clamp01(num(node.confidence, 0.5)),
    version: 1, predecessor_id: nodeId
  };
  const hash = computeNodeHash(draft, prov);
  const sealed = { ...prov, hash };
  const created = await insertNode(run, {
    id, workspace_id: node.workspace_id, project_id: node.project_id, conversation_id: node.conversation_id,
    type: draft.type, label: newLabel, node_key: `${nodeKey(node.type, node.label)}:${forkSuffix}`,
    content: draft.content, content_sha256: hash, status: "active",
    trust: draft.trust, confidence: draft.confidence, version: 1,
    predecessor_id: nodeId, successor_id: null, provenance: sealed,
    source_memory_id: node.source_memory_id, source_message_id: source.messageId || node.source_message_id,
    source_run_id: source.runId || node.source_run_id, source_ids: parse(node.source_ids) || []
  });
  const forked = await createEdge(run, {
    workspaceId: node.workspace_id, srcNodeId: nodeId, dstNodeId: id, kind: "fork",
    trust: draft.trust, sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
    actor, note: `fork: ${nodeId} -> ${id}`, tsMs: ts
  });
  const events = await appendEvents(run, [{
    workspaceId: node.workspace_id, entityType: "graph_node", entityId: nodeId,
    transition: "graph_node_forked", fromState: graphNodeState(node), toState: graphNodeState(node),
    delta: { fork_id: id }, sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
    sourceKind: actor === "user" ? "api" : "run",
    payload: { fork_id: id, provenance: sealed }
  }]);
  return { node: created, forkEdge: forked.edge, events: [...events, ...(forked.events || [])] };
}

/**
 * Revise a node: subtractive innovation. The old row is retired with a
 * successor pointer; the new row carries version+1 and a revision edge back.
 * The old version is never buried — it stays queryable with its lineage.
 */
export async function reviseNode(run, { nodeId, label = null, content = null, trust = null, confidence = null, actor = "user", source = {}, note = null }) {
  const node = await getNode(run, nodeId);
  if (!node) { const e = new Error("Graph node not found"); e.status = 404; throw e; }
  if (node.status === "retired") { const e = new Error("A retired node cannot be revised; fork it instead"); e.status = 409; throw e; }
  if (node.successor_id) { const e = new Error("This node already has a successor; revise the head instead"); e.status = 409; throw e; }
  const ts = nowMs();
  const newVersion = int(node.version, 1) + 1;
  const newLabel = cleanLabel(label || node.label);
  const id = newId("graph");
  const prov = buildProvenance({
    actor, version: newVersion, prevHash: node.content_sha256 || null,
    runId: source.runId ?? null, messageId: source.messageId ?? null,
    conversationId: node.conversation_id, memoryId: node.source_memory_id,
    sourceIds: parse(node.source_ids) || [], note: note || `revision of ${nodeId}`, tsMs: ts
  });
  const draft = {
    type: normalizeNodeType(node.type), label: newLabel,
    content: cleanText(content ?? node.content, 4000),
    trust: trust ? normalizeTrust(trust) : normalizeTrust(node.trust),
    confidence: confidence == null ? clamp01(num(node.confidence, 0.5)) : clamp01(num(confidence, 0.5)),
    version: newVersion, predecessor_id: nodeId
  };
  const hash = computeNodeHash(draft, prov);
  const sealed = { ...prov, hash };
  const created = await insertNode(run, {
    id, workspace_id: node.workspace_id, project_id: node.project_id, conversation_id: node.conversation_id,
    type: draft.type, label: newLabel, node_key: node.node_key, content: draft.content,
    content_sha256: hash, status: node.status === "pinned" ? "pinned" : "active",
    trust: draft.trust, confidence: draft.confidence, version: newVersion,
    predecessor_id: nodeId, successor_id: null, provenance: sealed,
    source_memory_id: node.source_memory_id, source_message_id: source.messageId || node.source_message_id,
    source_run_id: source.runId || node.source_run_id, source_ids: parse(node.source_ids) || []
  });
  // The old head steps aside: successor pointer + retired status, in one row.
  const prev = graphNodeState(node);
  const retiredProv = buildProvenance({
    actor, version: int(node.version, 1), prevHash: node.content_sha256 || null,
    runId: source.runId ?? null, messageId: source.messageId ?? null,
    conversationId: node.conversation_id, note: `superseded by ${id}`, tsMs: ts
  });
  const retiredNext = { ...prev, status: "retired", successor_id: id };
  const retiredHash = computeNodeHash({ ...node, ...retiredNext }, retiredProv);
  const retiredSealed = { ...retiredProv, hash: retiredHash };
  const retired = await updateNode(run, nodeId, {
    status: "retired", successor_id: id, retired_at_ms: ts,
    content_sha256: retiredHash, provenance: retiredSealed
  });
  const revision = await createEdge(run, {
    workspaceId: node.workspace_id, srcNodeId: nodeId, dstNodeId: id, kind: "revision",
    trust: draft.trust, sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
    actor, note: `revision: ${nodeId} -> ${id}`, tsMs: ts
  });
  const events = await appendEvents(run, [
    {
      workspaceId: node.workspace_id, entityType: "graph_node", entityId: id,
      transition: "graph_node_created", toState: { ...graphNodeState(created), id, node_key: created.node_key, content_sha256: hash },
      delta: { revision_of: nodeId, version: newVersion },
      sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
      sourceKind: actor === "user" ? "api" : "run",
      payload: { provenance: sealed }
    },
    {
      workspaceId: node.workspace_id, entityType: "graph_node", entityId: nodeId,
      transition: "graph_node_revised", fromState: prev, toState: graphNodeState(retired),
      delta: { successor_id: id, version: newVersion },
      sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
      sourceKind: actor === "user" ? "api" : "run",
      payload: { successor_id: id, provenance: retiredSealed }
    }
  ]);
  return { node: created, retired, revisionEdge: revision.edge, events: [...events, ...(revision.events || [])] };
}

/**
 * Move a node's trust annotation. Only the pin path mints verified; this path
 * moves between trusted/untrusted/flagged (and records verified only when the
 * actor is the user approving the row explicitly).
 */
export async function setTrust(run, { nodeId, trust, actor = "user", source = {}, note = null }) {
  const node = await getNode(run, nodeId);
  if (!node) { const e = new Error("Graph node not found"); e.status = 404; throw e; }
  const next = normalizeTrust(trust);
  if (next === "verified" && actor !== "user") {
    const e = new Error("Only a user act can mint verified trust");
    e.status = 403;
    throw e;
  }
  if (next === normalizeTrust(node.trust)) return { node, events: [], existing: true };
  const ts = nowMs();
  const prev = graphNodeState(node);
  const prov = buildProvenance({
    actor, version: int(node.version, 1), prevHash: node.content_sha256 || null,
    runId: source.runId ?? null, messageId: source.messageId ?? null,
    conversationId: node.conversation_id, note: note || `trust -> ${next}`, tsMs: ts
  });
  const hash = computeNodeHash({ ...node, trust: next }, prov);
  const sealed = { ...prov, hash };
  const updated = await updateNode(run, nodeId, { trust: next, content_sha256: hash, provenance: sealed });
  const events = await appendEvents(run, [{
    workspaceId: node.workspace_id, entityType: "graph_node", entityId: nodeId,
    transition: "graph_trust_changed", fromState: { trust: prev.trust }, toState: { trust: next },
    delta: { trust: next, cause: note || "manual" },
    sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
    sourceKind: actor === "user" ? "api" : "run",
    payload: { provenance: sealed }
  }]);
  return { node: updated, events };
}

/** Retire an edge: a transition, never a delete. */
export async function retireEdge(run, { edgeId, actor = "user", source = {}, note = null }) {
  const edge = await getEdge(run, edgeId);
  if (!edge) { const e = new Error("Graph edge not found"); e.status = 404; throw e; }
  if (edge.status === "retired") return { edge, events: [], existing: true };
  const ts = nowMs();
  const prev = graphEdgeState(edge);
  const updated = await updateEdge(run, edgeId, { status: "retired", retired_at_ms: ts });
  const events = await appendEvents(run, [{
    workspaceId: edge.workspace_id, entityType: "graph_edge", entityId: edgeId,
    transition: "graph_edge_retired", fromState: prev, toState: graphEdgeState(updated),
    delta: { status: "retired" },
    sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
    sourceKind: actor === "user" ? "api" : "run",
    payload: { reason: note || "retired" }
  }]);
  return { edge: updated, events };
}

// --- query -----------------------------------------------------------------

/**
 * Breadth-first traversal from a node: "find related events to X". Bounded by
 * depth and per-level fan-out, served by the src/dst indexes — no full-table
 * scan, so the Governor can consult it inside a turn.
 */
export async function findRelated(run, nodeId, { depth = 2, kinds = null, truthOnly = false, status = "active", limit = 60 } = {}) {
  const origin = await getNode(run, nodeId);
  if (!origin) { const e = new Error("Graph node not found"); e.status = 404; throw e; }
  const maxDepth = Math.max(1, Math.min(int(depth, 2), 3));
  const perLevel = 25;
  const seen = new Set([String(nodeId)]);
  const nodes = new Map([[String(nodeId), { ...origin, depth: 0 }]]);
  const edges = [];
  let frontier = [String(nodeId)];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const rows = await run(
      `SELECT * FROM graph_edges WHERE (src_node_id = ANY($1) OR dst_node_id = ANY($1))${status ? ` AND status = $2` : ""} ORDER BY created_date DESC LIMIT $3`,
      status ? [frontier, status, perLevel * frontier.length] : [frontier, perLevel * frontier.length]
    );
    const wanted = Array.isArray(kinds) && kinds.length ? new Set(kinds.map(normalizeEdgeKind)) : null;
    const next = [];
    for (const edge of rows) {
      if (wanted && !wanted.has(normalizeEdgeKind(edge.kind))) continue;
      if (truthOnly && !trustSatisfiesTruth(normalizeTrust(edge.trust))) continue;
      const otherId = seen.has(String(edge.src_node_id)) && !seen.has(String(edge.dst_node_id))
        ? String(edge.dst_node_id)
        : (!seen.has(String(edge.src_node_id)) ? String(edge.src_node_id) : null);
      if (!otherId) continue;
      const other = await getNode(run, otherId);
      if (!other) continue;
      if (truthOnly && (!trustSatisfiesTruth(normalizeTrust(other.trust)) || other.status === "retired")) continue;
      if (other.status === "retired" && status === "active") continue;
      seen.add(otherId);
      nodes.set(otherId, { ...other, depth: d, via: edge.id, via_kind: edge.kind });
      edges.push(edge);
      next.push(otherId);
      if (nodes.size >= Math.max(1, Math.min(int(limit, 60), 300))) break;
    }
    frontier = next;
  }
  return {
    origin: nodeId,
    depth: maxDepth,
    nodes: [...nodes.values()],
    edges,
    count: { nodes: nodes.size, edges: edges.length }
  };
}

const STOP_WORDS = new Set(
  ("a an the and or but not no nor for with without from into onto over under between through during after before about against because while when where which who whom this that these those their there they we our its it is are was were be been being has have had having will would could should can may might must of to by on at in out up as so than then them his her you your what when how why").split(" ")
);

function queryTokens(text) {
  const tokens = new Set();
  for (const raw of String(text || "").toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []) {
    if (!STOP_WORDS.has(raw)) tokens.add(raw);
  }
  return [...tokens].slice(0, 12);
}

/**
 * Relevance query for the council: keyword-overlap ranking over live heads,
 * trust-aware. truthOnly restricts to verified/trusted rows — the set the
 * Governor allows a truth claim to lean on.
 */
export async function queryRelevant(run, workspaceId, text, { limit = 8, truthOnly = false, types = null } = {}) {
  const tokens = queryTokens(text);
  const pool = await listNodes(run, workspaceId, {
    status: null, truthOnly, limit: 220
  });
  const live = pool.filter(n => n.status !== "retired" && !n.successor_id);
  const wanted = Array.isArray(types) && types.length ? new Set(types.map(normalizeNodeType)) : null;
  const scored = [];
  for (const node of live) {
    if (wanted && !wanted.has(normalizeNodeType(node.type))) continue;
    const hay = `${node.label} ${node.content}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (hay.includes(token)) score += token.length >= 7 ? 3 : 2;
    }
    if (node.status === "pinned") score += 4;
    score += trustRank(node.trust);
    score += clamp01(num(node.confidence, 0.5)) * 2;
    if (score > 0) scored.push({ node, score });
  }
  scored.sort((a, b) => b.score - a.score || String(b.node.updated_date).localeCompare(String(a.node.updated_date)));
  return scored.slice(0, Math.max(1, Math.min(int(limit, 8), 24))).map(({ node, score }) => ({ ...node, relevance: Number(score.toFixed(2)) }));
}

/** Contradiction edges between live nodes — surfaced by the Critic for manual resolution. */
export async function listConflicts(run, workspaceId, { limit = 50 } = {}) {
  const rows = await run(
    `SELECT e.* FROM graph_edges e
      JOIN graph_nodes s ON s.id = e.src_node_id
      JOIN graph_nodes d ON d.id = e.dst_node_id
     WHERE e.workspace_id = $1 AND e.kind = 'contradicts' AND e.status = 'active'
       AND s.status IN ('active','pinned') AND d.status IN ('active','pinned')
     ORDER BY e.created_date DESC LIMIT $2`,
    [workspaceId, Math.max(1, Math.min(int(limit, 50), 200))]
  );
  const out = [];
  for (const edge of rows.slice(0, 50)) {
    const [src, dst] = await Promise.all([getNode(run, edge.src_node_id), getNode(run, edge.dst_node_id)]);
    out.push({ edge, src, dst });
  }
  return out;
}

// --- integrity ---------------------------------------------------------------

function provenanceWithoutHash(provenance) {
  const prov = { ...(parse(provenance) || {}) };
  delete prov.hash;
  return prov;
}

/** Recompute a node's seal from its stored columns. A mismatch means drift or tampering. */
export function verifyNodeSeal(node) {
  if (!node) return { ok: false, reason: "missing" };
  const prov = provenanceWithoutHash(node.provenance);
  const recomputed = computeNodeHash(node, prov);
  const stored = String(node.content_sha256 || "");
  return {
    ok: recomputed === stored,
    stored,
    recomputed,
    reason: recomputed === stored ? null : "hash_mismatch"
  };
}

export function verifyEdgeSeal(edge) {
  if (!edge) return { ok: false, reason: "missing" };
  const prov = provenanceWithoutHash(edge.provenance);
  const recomputed = computeEdgeHash(edge, prov);
  const stored = String(edge.edge_sha256 || "");
  return {
    ok: recomputed === stored,
    stored,
    recomputed,
    reason: recomputed === stored ? null : "hash_mismatch"
  };
}

/** Provenance integrity audit: hash mismatch rate across the workspace atlas. */
export async function verifyWorkspace(run, workspaceId, { limit = 2000 } = {}) {
  const cap = Math.max(1, Math.min(int(limit, 2000), 5000));
  const nodes = await run(`SELECT * FROM graph_nodes WHERE workspace_id = $1 ORDER BY created_date DESC LIMIT $2`, [workspaceId, cap]);
  const edges = await run(`SELECT * FROM graph_edges WHERE workspace_id = $1 ORDER BY created_date DESC LIMIT $2`, [workspaceId, cap]);
  const badNodes = [];
  const badEdges = [];
  for (const node of nodes) {
    if (!verifyNodeSeal(node).ok) badNodes.push(node.id);
  }
  for (const edge of edges) {
    if (!verifyEdgeSeal(edge).ok) badEdges.push(edge.id);
  }
  const total = nodes.length + edges.length;
  const bad = badNodes.length + badEdges.length;
  return {
    workspaceId,
    nodes: nodes.length,
    edges: edges.length,
    checked: total,
    mismatches: bad,
    mismatchRate: total ? Number((bad / total).toFixed(6)) : 0,
    badNodes: badNodes.slice(0, 50),
    badEdges: badEdges.slice(0, 50),
    ok: bad === 0
  };
}

// --- snapshots (Merkle) ------------------------------------------------------

export function merkleRoot(leafHashes) {
  const leaves = [...(leafHashes || [])].filter(Boolean).sort();
  if (!leaves.length) return sha256("cognos-graph:empty");
  let level = leaves.map(h => sha256(`leaf:${h}`));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(sha256(`node:${left}:${right}`));
    }
    level = next;
  }
  return level[0];
}

/** Record an immutable snapshot of the workspace atlas. Append-only. */
export async function createSnapshot(run, { workspaceId, note = null, actor = "system", source = {}, limit = 2000 }) {
  const cap = Math.max(1, Math.min(int(limit, 2000), 5000));
  const nodes = await run(`SELECT id, content_sha256 FROM graph_nodes WHERE workspace_id = $1 ORDER BY id ASC LIMIT $2`, [workspaceId, cap]);
  const edges = await run(`SELECT id, edge_sha256 FROM graph_edges WHERE workspace_id = $1 ORDER BY id ASC LIMIT $2`, [workspaceId, cap]);
  const leafHashes = [...nodes.map(n => `n:${n.id}:${n.content_sha256}`), ...edges.map(e => `e:${e.id}:${e.edge_sha256}`)];
  const root = merkleRoot(leafHashes);
  const id = newId("gsnap");
  const ts = nowMs();
  const prov = buildProvenance({
    actor, version: 1, runId: source.runId ?? null, messageId: source.messageId ?? null,
    note: note || `snapshot of ${nodes.length} nodes, ${edges.length} edges`, tsMs: ts
  });
  const rows = await run(
    `INSERT INTO graph_snapshots (id, workspace_id, merkle_root, node_count, edge_count, node_ids, edge_ids, leaf_hashes, provenance, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id, workspaceId, root, nodes.length, edges.length,
     JSON.stringify(nodes.map(n => n.id)), JSON.stringify(edges.map(e => e.id)),
     JSON.stringify(leafHashes.slice(0, 4000)), JSON.stringify({ ...prov, hash: root }), note ? cleanText(note, 280) : null]
  );
  const snapshot = rows[0];
  const events = await appendEvents(run, [{
    workspaceId, entityType: "graph_snapshot", entityId: id,
    transition: "graph_snapshot_created",
    toState: { merkle_root: root, node_count: nodes.length, edge_count: edges.length },
    delta: { nodes: nodes.length, edges: edges.length },
    sourceRunId: source.runId ?? null, sourceMessageId: source.messageId ?? null,
    sourceKind: actor === "user" ? "api" : "run",
    reversible: false,
    payload: { note: snapshot.note }
  }]);
  return { snapshot, events };
}

export async function listSnapshots(run, workspaceId, { limit = 30 } = {}) {
  return run(
    `SELECT * FROM graph_snapshots WHERE workspace_id = $1 ORDER BY created_date DESC LIMIT $2`,
    [workspaceId, Math.max(1, Math.min(int(limit, 30), 200))]
  );
}

export async function getSnapshot(run, id) {
  const rows = await run(`SELECT * FROM graph_snapshots WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** Merkle-tree diff: concurrent edits merge without data loss; the diff names what moved. */
export async function diffSnapshots(run, idA, idB) {
  const [a, b] = await Promise.all([getSnapshot(run, idA), getSnapshot(run, idB)]);
  if (!a || !b) { const e = new Error("Snapshot not found"); e.status = 404; throw e; }
  if (a.workspace_id !== b.workspace_id) { const e = new Error("Snapshots belong to different workspaces"); e.status = 400; throw e; }
  const setA = new Set(parse(a.leaf_hashes) || []);
  const setB = new Set(parse(b.leaf_hashes) || []);
  const added = [...setB].filter(h => !setA.has(h));
  const removed = [...setA].filter(h => !setB.has(h));
  const parseLeaf = (leaf) => {
    const [prefix, id, hash] = String(leaf).split(":");
    return { kind: prefix === "n" ? "node" : "edge", id, hash };
  };
  const parsedAdded = added.map(parseLeaf);
  const parsedRemoved = removed.map(parseLeaf);
  // "Names what moved" means human names, not just ids: resolve node labels
  // for the moved leaves in one bounded query. Retired-away rows keep their
  // rows, so a label is still there to read.
  const movedNodeIds = [...new Set(
    [...parsedAdded, ...parsedRemoved].filter(p => p.kind === "node").map(p => p.id)
  )].slice(0, 200);
  let labels = {};
  if (movedNodeIds.length) {
    const rows = await run(`SELECT id, label FROM graph_nodes WHERE id = ANY($1)`, [movedNodeIds]);
    labels = Object.fromEntries(rows.map(r => [r.id, r.label]));
  }
  const named = (p) => ({ ...p, label: labels[p.id] ?? null });
  return {
    a: { id: a.id, root: a.merkle_root, nodes: a.node_count, edges: a.edge_count, at: a.created_date },
    b: { id: b.id, root: b.merkle_root, nodes: b.node_count, edges: b.edge_count, at: b.created_date },
    identical: a.merkle_root === b.merkle_root,
    added: parsedAdded.map(named),
    removed: parsedRemoved.map(named),
    addedCount: added.length,
    removedCount: removed.length
  };
}

// --- coverage ----------------------------------------------------------------

/**
 * Graph coverage audit: how much of the user-supplied session content appears
 * as nodes or edges. The target is >95% — the atlas should hold the heartbeat
 * of each conversation intact.
 */
export async function coverageAudit(run, workspaceId) {
  const [messages, memories, nodes, edges, byType, conversations] = await Promise.all([
    run(`SELECT count(*)::int AS n FROM messages WHERE workspace_id = $1 AND role = 'user'`, [workspaceId]).then(r => r[0]?.n ?? 0),
    run(`SELECT count(*)::int AS n FROM memories WHERE workspace_id = $1`, [workspaceId]).then(r => r[0]?.n ?? 0),
    run(`SELECT count(*)::int AS n, count(DISTINCT source_message_id)::int AS msgs, count(DISTINCT source_memory_id)::int AS mems FROM graph_nodes WHERE workspace_id = $1`, [workspaceId]).then(r => r[0] || { n: 0, msgs: 0, mems: 0 }),
    run(`SELECT count(*)::int AS n FROM graph_edges WHERE workspace_id = $1 AND status = 'active'`, [workspaceId]).then(r => r[0]?.n ?? 0),
    run(`SELECT type, count(*)::int AS n FROM graph_nodes WHERE workspace_id = $1 GROUP BY type`, [workspaceId]),
    run(`SELECT count(*)::int AS n FROM conversations WHERE workspace_id = $1`, [workspaceId]).then(r => r[0]?.n ?? 0)
  ]);
  const denominator = messages + memories;
  const covered = Math.min(denominator, (int(nodes.msgs, 0) + int(nodes.mems, 0)));
  const coverage = denominator ? covered / denominator : 1;
  const typeCounts = Object.fromEntries(byType.map(r => [r.type, int(r.n, 0)]));
  return {
    workspaceId,
    messages,
    memories,
    conversations: int(conversations, 0),
    sessionItems: denominator,
    coveredItems: covered,
    coverage: Number(coverage.toFixed(4)),
    coveragePct: Number((coverage * 100).toFixed(1)),
    nodes: int(nodes.n, 0),
    edges: int(edges, 0),
    concepts: int(typeCounts.concept, 0),
    intents: int(typeCounts.intent, 0),
    events: int(typeCounts.event, 0),
    persons: int(typeCounts.person, 0),
    sources: int(typeCounts.source, 0),
    target: 0.95,
    targetPct: 95,
    meetsTarget: denominator ? coverage >= 0.95 : true
  };
}

export async function overview(run, workspaceId) {
  const [nodeType, nodeTrust, nodeStatus, edgeKind, edgeStatus, snapshots, conflicts] = await Promise.all([
    run(`SELECT type, count(*)::int AS n FROM graph_nodes WHERE workspace_id = $1 GROUP BY type ORDER BY n DESC`, [workspaceId]),
    run(`SELECT trust, count(*)::int AS n FROM graph_nodes WHERE workspace_id = $1 GROUP BY trust ORDER BY n DESC`, [workspaceId]),
    run(`SELECT status, count(*)::int AS n FROM graph_nodes WHERE workspace_id = $1 GROUP BY status`, [workspaceId]),
    run(`SELECT kind, count(*)::int AS n FROM graph_edges WHERE workspace_id = $1 GROUP BY kind ORDER BY n DESC`, [workspaceId]),
    run(`SELECT status, count(*)::int AS n FROM graph_edges WHERE workspace_id = $1 GROUP BY status`, [workspaceId]),
    run(`SELECT count(*)::int AS n FROM graph_snapshots WHERE workspace_id = $1`, [workspaceId]).then(r => r[0]?.n ?? 0),
    run(`SELECT count(*)::int AS n FROM graph_edges WHERE workspace_id = $1 AND kind = 'contradicts' AND status = 'active'`, [workspaceId]).then(r => r[0]?.n ?? 0)
  ]);
  const statusOf = (rows, status) => int(rows.find(r => r.status === status)?.n, 0);
  const totalOf = (rows) => rows.reduce((n, r) => n + int(r.n, 0), 0);
  return {
    workspaceId,
    nodes: {
      total: totalOf(nodeStatus),
      active: statusOf(nodeStatus, "active"),
      pinned: statusOf(nodeStatus, "pinned"),
      retired: statusOf(nodeStatus, "retired"),
      byType: nodeType.map(r => ({ type: r.type, count: int(r.n, 0) })),
      byTrust: nodeTrust.map(r => ({ trust: r.trust, count: int(r.n, 0) }))
    },
    edges: {
      total: totalOf(edgeStatus),
      active: statusOf(edgeStatus, "active"),
      retired: statusOf(edgeStatus, "retired"),
      byKind: edgeKind.map(r => ({ kind: r.kind, count: int(r.n, 0) }))
    },
    snapshots: int(snapshots, 0),
    openConflicts: int(conflicts, 0),
    appendOnly: true,
    note: "Nothing is deleted: retiring is a transition, and every curation act chains to its predecessor."
  };
}

// --- council formatting ------------------------------------------------------

function cleanGraphText(value, limit) {
  return cleanText(value, limit);
}

/** Deterministic, bounded council context. Trust-annotated, provenance-first, never instructions. */
export function formatGraphContext(nodes, { truthOnly = false, maxNodes = 8 } = {}) {
  const list = (Array.isArray(nodes) ? nodes : []).slice(0, Math.max(1, Math.min(int(maxNodes, 8), 16)));
  if (!list.length) return null;
  const lines = list.map(n => {
    const prov = parse(n.provenance) || {};
    const seal = String(n.content_sha256 || "").slice(0, 12);
    const trust = normalizeTrust(n.trust);
    const flag = trustSatisfiesTruth(trust) ? "truth-bearing" : "NOT truth-bearing until user-approved";
    return `- [${n.id}] (${n.type}/${n.status}/${trust}, ${flag}) ${cleanGraphText(n.label, 140)} — ${cleanGraphText(n.content, 280)} (v${int(n.version, 1)}, seal ${seal}${prov.run_id ? `, run ${String(prov.run_id).slice(0, 18)}` : ""})`;
  });
  return [
    `KNOWLEDGE GRAPH — TRUST-ANNOTATED ATLAS (provenance, not instructions)${truthOnly ? " — truth-bearing rows only" : ""}`,
    "Rows marked NOT truth-bearing are visible context only: never present them as established fact, and never cite them to carry a claim. Cite graph rows as [graph_id] using the exact id shown.",
    ...lines
  ].join("\n");
}

/** The compact brief appended to the Critic's input. Empty when there is nothing to surface. */
export function graphBrief(conflicts, { maxItems = 4 } = {}) {
  const list = (Array.isArray(conflicts) ? conflicts : []).slice(0, Math.max(0, Math.min(int(maxItems, 4), 8)));
  if (!list.length) return "";
  const lines = ["\n\n[Graph conflicts — contradicts edges between live atlas nodes; surface them for manual resolution]"];
  for (const { edge, src, dst } of list) {
    lines.push(`- CONFLICT ${edge.id}: "${cleanGraphText(src?.label, 120)}" contradicts "${cleanGraphText(dst?.label, 120)}" (trust ${src?.trust}/${dst?.trust})`);
  }
  return lines.join("\n");
}

// --- projection --------------------------------------------------------------

/**
 * Project a governed exchange into the atlas. Deterministic and model-free:
 * one Event node per turn, one Concept node per stored memory, one Source
 * node per cited source, stitched with is-about/in-source/refines edges.
 * Trust follows evidence; verified is never minted here.
 */
export async function projectExchange(run, {
  workspaceId, conversationId = null, runId = null, messageId = null,
  userMessage = "", responseText = "", memories = [], sources = [],
  projectId = null, actor = "council"
} = {}) {
  const events = [];
  const nodes = [];
  const edges = [];
  const ts = nowMs();
  const seen = new Set();

  const track = (item, kind) => {
    if (!item) return null;
    const key = `${kind}:${item.id}`;
    if (seen.has(key)) return item;
    seen.add(key);
    (kind === "node" ? nodes : edges).push(item);
    return item;
  };

  // The turn itself: an Event node so sessions stitch into one fabric.
  const turnLabel = `Turn ${new Date(ts).toISOString().slice(0, 16)} — ${cleanText(userMessage, 90) || "exchange"}`;
  const turnContent = `User asked: ${cleanText(userMessage, 500)} The council answered (${cleanText(responseText, 120).length} chars of governed text).`;
  const turn = await createNode(run, {
    workspaceId, type: "event", label: turnLabel, content: turnContent,
    trust: "untrusted", confidence: 0.5, projectId, conversationId,
    sourceMessageId: messageId, sourceRunId: runId, actor, tsMs: ts,
    note: "governed exchange projected into the atlas"
  });
  events.push(...(turn.events || []));
  track(turn.node, "node");
  const turnNode = turn.node;

  // Each stored memory becomes a Concept node linked to the turn.
  for (const memory of (memories || []).slice(0, 8)) {
    if (!memory?.content) continue;
    const label = cleanText(memory.memory_key || memory.content, 140) || "memory";
    const made = await createNode(run, {
      workspaceId, type: "concept", label, content: cleanText(memory.content, 1200),
      trust: trustFromEvidenceLevel(memory.evidence_level), confidence: num(memory.confidence, 0.5),
      projectId, conversationId, sourceMemoryId: memory.id, sourceMessageId: messageId,
      sourceRunId: runId, actor, tsMs: ts, note: "projected from a stored memory"
    });
    events.push(...(made.events || []));
    track(made.node, "node");
    if (!made.existing) {
      const edge = await createEdge(run, {
        workspaceId, srcNodeId: made.node.id, dstNodeId: turnNode.id, kind: "is-about",
        trust: made.node.trust, sourceRunId: runId, sourceMessageId: messageId, actor, tsMs: ts,
        note: "memory projected from this exchange"
      });
      events.push(...(edge.events || []));
      track(edge.edge, "edge");
    }
  }

  // Each cited source becomes a Source node linked to the turn.
  for (const source of (sources || []).slice(0, 8)) {
    if (!source?.id) continue;
    const label = cleanText(source.name || source.id, 140);
    const made = await createNode(run, {
      workspaceId, type: "source", label,
      content: `Source ${source.id} (${source.kind || "evidence"}): ${cleanText(source.name || "", 200)} sha ${String(source.content_sha256 || source.sha256 || "").slice(0, 16)}`,
      trust: "trusted", confidence: 0.6, projectId, conversationId,
      sourceMessageId: messageId, sourceRunId: runId, sourceIds: [source.id],
      actor, tsMs: ts, note: "projected from cited evidence"
    });
    events.push(...(made.events || []));
    track(made.node, "node");
    if (!made.existing) {
      const edge = await createEdge(run, {
        workspaceId, srcNodeId: turnNode.id, dstNodeId: made.node.id, kind: "in-source",
        trust: "trusted", sourceRunId: runId, sourceMessageId: messageId, actor, tsMs: ts,
        note: "exchange grounded in this source"
      });
      events.push(...(edge.events || []));
      track(edge.edge, "edge");
    }
  }

  // The user's intent, kept as its own node so future turns can refine it.
  const intentText = cleanText(userMessage, 400);
  if (intentText.length >= 8) {
    const made = await createNode(run, {
      workspaceId, type: "intent", label: intentText.slice(0, 140), content: intentText,
      trust: "untrusted", confidence: 0.5, projectId, conversationId,
      sourceMessageId: messageId, sourceRunId: runId, actor, tsMs: ts,
      note: "user intent for this exchange"
    });
    events.push(...(made.events || []));
    track(made.node, "node");
    if (!made.existing) {
      const edge = await createEdge(run, {
        workspaceId, srcNodeId: made.node.id, dstNodeId: turnNode.id, kind: "is-about",
        trust: "untrusted", sourceRunId: runId, sourceMessageId: messageId, actor, tsMs: ts,
        note: "intent behind this exchange"
      });
      events.push(...(edge.events || []));
      track(edge.edge, "edge");
    }
  }

  return { nodes, edges, events };
}
