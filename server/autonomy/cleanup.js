// The cleanup agent — a scheduled audit of everything COGNOS persists.
//
// It runs day-guarded inside the heartbeat (no new scheduler): one pass per
// day over every store, applying the per-store policy:
//
//   AUTO-TIDY (safe, logged, reversible): exact-duplicate memories
//     (soft-disabled, never deleted), expired TTL rows, duplicate graph
//     edges (retired), old telemetry rows and acked notices (retention).
//   REVIEW QUEUE (Jeremy decides): near-duplicates, redundant keys,
//     subsumptions, fragment merges, stale volatile entries, orphaned graph
//     nodes, dead-end subgraphs, contradictions, orphaned goal notes.
//   HANDS-OFF (never touched): the audit trail itself (goal_events,
//     outbox_events, note_promotions, cleanup_proposals, graph_snapshots,
//     confidence_history, knowledge_events, improvement_ledger), beliefs,
//     relationships, the outbox, heartbeat_state, conversations/messages,
//     sources and their chunks (Jeremy's research library).
//
// Nothing irreplaceable is destroyed silently. Every auto-tidy is recorded
// on the cleanup_runs row and, where a ledger exists, as a ledger event
// (memory_disabled, edge retired). Hard deletes happen only for telemetry
// and acked notices past retention — never for user content — with one
// approved exception: an orphan_note proposal Jeremy explicitly approves
// deletes the orphaned rows, because their parent goal is gone and there is
// no soft-disable column on goal_notes. That delete is his decision, not
// the agent's, and it is recorded on the proposal row.

import { createHash } from "node:crypto";
import { cosineSimilarity, parseEmbedding } from "../memory/embeddings.js";
import { retireNode, retireEdge } from "../knowledge/graph.js";
import { isDreamMemory, normalizeMemoryLayer } from "../memory/structure.js";
import { buildNoticeFields } from "./notice.js";

export const CLEANUP_SCAN_LIMIT = 1000;
export const TELEMETRY_RETENTION_DAYS = 90;
export const NOTICE_RETENTION_DAYS = 90;
export const STALE_VOLATILE_DAYS = 30;
export const ORPHAN_NODE_GRACE_DAYS = 7;
export const DEAD_END_COMPONENT_DAYS = 30;
export const FRAGMENT_MAX_CHARS = 60;
export const FRAGMENT_MAX_IMPORTANCE = 3;
export const NEAR_DUPE_THRESHOLD = 0.92;
export const NEAR_DUPE_MAX_PAIRS = 2000;
export const MAX_PROPOSALS_PER_KIND = 25;

const DAY_MS = 86400_000;

// --- pure detection ----------------------------------------------------------

export function normalizeContent(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Groups of rows whose trimmed content is byte-identical. Auto-mergeable. */
export function findExactDuplicateGroups(rows = []) {
  const byContent = new Map();
  for (const r of rows) {
    const key = String(r.content ?? "").trim();
    if (!key) continue;
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push(r.id);
  }
  return [...byContent.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key: key.slice(0, 120), ids }));
}

/** Keep the highest-importance, then newest row of a duplicate group. */
export function pickCanonical(rows = [], ids = []) {
  const byId = new Map(rows.map(r => [r.id, r]));
  return [...ids].sort((a, b) => {
    const ra = byId.get(a) || {};
    const rb = byId.get(b) || {};
    const imp = Number(rb.importance || 0) - Number(ra.importance || 0);
    if (imp !== 0) return imp;
    return Date.parse(rb.created_date || 0) - Date.parse(ra.created_date || 0);
  })[0];
}

/**
 * Embedding-similarity pairs, cheaply pre-filtered (same layer, lengths
 * within 2x) and capped — the O(n^2) stays bounded on a daily audit.
 */
export function findNearDuplicatePairs(rows = [], { threshold = NEAR_DUPE_THRESHOLD, maxPairs = NEAR_DUPE_MAX_PAIRS } = {}) {
  const withEmb = [];
  for (const r of rows) {
    const emb = parseEmbedding(r.embedding);
    if (emb) withEmb.push({ row: r, emb });
  }
  const pairs = [];
  let evaluated = 0;
  for (let i = 0; i < withEmb.length && evaluated < maxPairs; i++) {
    for (let j = i + 1; j < withEmb.length && evaluated < maxPairs; j++) {
      const a = withEmb[i].row;
      const b = withEmb[j].row;
      if (normalizeMemoryLayer(a.memory_layer, a.memory_type) !== normalizeMemoryLayer(b.memory_layer, b.memory_type)) continue;
      const la = (a.content || "").length;
      const lb = (b.content || "").length;
      if (!la || !lb || Math.max(la, lb) > 2 * Math.min(la, lb)) continue;
      evaluated++;
      const sim = cosineSimilarity(withEmb[i].emb, withEmb[j].emb);
      if (sim >= threshold) {
        pairs.push({ aId: a.id, bId: b.id, similarity: Math.round(sim * 1000) / 1000 });
      }
    }
  }
  return { pairs, evaluated, scanned: withEmb.length };
}

/** Same memory_key, different content: the key was reused, older rows are stale. */
export function findRedundantKeyGroups(rows = []) {
  const byKey = new Map();
  for (const r of rows) {
    const key = String(r.memory_key || "").trim();
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const groups = [];
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    if (new Set(members.map(m => String(m.content ?? "").trim())).size < 2) continue;
    groups.push({ key, ids: members.map(m => m.id) });
  }
  return groups;
}

/** A shorter row fully contained in a longer one: the shorter is redundant. */
export function findSubsumedPairs(rows = [], { maxChecks = 50000, minChars = 24 } = {}) {
  const sorted = rows
    .filter(r => String(r.content ?? "").trim().length >= minChars)
    .sort((a, b) => String(b.content ?? "").length - String(a.content ?? "").length);
  const pairs = [];
  let checks = 0;
  for (let i = 0; i < sorted.length && checks < maxChecks; i++) {
    const lc = String(sorted[i].content ?? "").toLowerCase();
    for (let j = sorted.length - 1; j > i && checks < maxChecks; j--) {
      const sc = String(sorted[j].content ?? "").trim().toLowerCase();
      if (!sc || sc.length * 1.25 >= lc.length) continue;
      checks++;
      if (lc.includes(sc)) {
        pairs.push({ longerId: sorted[i].id, shorterId: sorted[j].id });
        break;
      }
    }
  }
  return pairs;
}

/** Tiny, low-importance, weakly-evidenced rows, grouped by layer for coherent merges. Dreams are never fragments. */
export function findFragmentGroups(rows = []) {
  const frags = rows.filter(r => {
    if (isDreamMemory(r)) return false;
    const len = String(r.content ?? "").trim().length;
    return len > 0 && len < FRAGMENT_MAX_CHARS
      && Number(r.importance || 0) <= FRAGMENT_MAX_IMPORTANCE
      && ["assumed", "inferred"].includes(String(r.evidence_level || ""));
  });
  const byLayer = new Map();
  for (const r of frags) {
    const layer = normalizeMemoryLayer(r.memory_layer, r.memory_type);
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer).push(r.id);
  }
  return [...byLayer.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([layer, ids]) => ({ layer, ids }));
}

/** High-volatility rows untouched for a month: the world moved on. */
export function findStaleVolatile(rows = [], nowMs = Date.now()) {
  const cutoff = nowMs - STALE_VOLATILE_DAYS * DAY_MS;
  return rows
    .filter(r => {
      if (isDreamMemory(r)) return false;
      if (String(r.volatility || "") !== "high") return false;
      const touched = Date.parse(r.updated_date || r.created_date || 0);
      return touched > 0 && touched < cutoff;
    })
    .map(r => r.id);
}

// --- graph detection (pure) ---------------------------------------------------

export function findOrphanGraphNodes(nodes = [], edges = [], nowMs = Date.now()) {
  const connected = new Set();
  for (const e of edges) {
    if (e.status !== "active") continue;
    connected.add(e.src_node_id);
    connected.add(e.dst_node_id);
  }
  const cutoff = nowMs - ORPHAN_NODE_GRACE_DAYS * DAY_MS;
  return nodes
    .filter(n => n.status === "active" && !connected.has(n.id)
      && Date.parse(n.created_date || 0) < cutoff)
    .map(n => n.id);
}

export function findDuplicateGraphEdges(edges = []) {
  const byHash = new Map();
  for (const e of edges) {
    if (e.status !== "active" || !e.edge_sha256) continue;
    if (!byHash.has(e.edge_sha256)) byHash.set(e.edge_sha256, []);
    byHash.get(e.edge_sha256).push(e.id);
  }
  return [...byHash.values()].filter(ids => ids.length > 1);
}

/** Connected components of only untrusted, aging nodes: dead corners of the atlas. */
export function findDeadEndComponents(nodes = [], edges = [], nowMs = Date.now()) {
  const active = nodes.filter(n => n.status === "active");
  const parent = new Map(active.map(n => [n.id, n.id]));
  const find = x => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    return r;
  };
  for (const e of edges) {
    if (e.status !== "active") continue;
    if (parent.has(e.src_node_id) && parent.has(e.dst_node_id)) {
      parent.set(find(e.src_node_id), find(e.dst_node_id));
    }
  }
  const comps = new Map();
  for (const n of active) {
    const root = find(n.id);
    if (!comps.has(root)) comps.set(root, []);
    comps.get(root).push(n);
  }
  const cutoff = nowMs - DEAD_END_COMPONENT_DAYS * DAY_MS;
  const dead = [];
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    if (members.some(n => String(n.trust || "") !== "untrusted")) continue;
    const newest = Math.max(...members.map(n => Date.parse(n.created_date || 0)));
    if (newest < cutoff) dead.push(members.map(n => n.id));
  }
  return dead;
}

export function findContradictions(edges = []) {
  return edges
    .filter(e => e.status === "active" && e.kind === "contradicts")
    .map(e => e.id);
}

// --- proposals ----------------------------------------------------------------

export function proposalKeyFor({ store, kind, targetIds = [] }) {
  return createHash("sha256")
    .update(JSON.stringify([store, kind, [...targetIds].sort()]))
    .digest("hex");
}

/** Idempotent: a repeat finding resolves to the existing open proposal. */
export async function proposeFinding(db, workspaceId, { store, kind, title, detail, targetIds = [] }) {
  const proposal_key = proposalKeyFor({ store, kind, targetIds });
  const existing = await db.CleanupProposal.findByKey(workspaceId, proposal_key).catch(() => null);
  if (existing) return { proposal: existing, duplicate: true };
  const row = await db.CleanupProposal.create({
    workspace_id: workspaceId, store, kind, title,
    detail: detail || {}, proposal_key, status: "requested"
  });
  return { proposal: row, duplicate: false };
}

const previewOf = (rows, id, max = 160) => {
  const r = rows.find(x => x.id === id);
  return String(r?.content || r?.label || id).replace(/\s+/g, " ").trim().slice(0, max);
};
const previewsFor = (rows, ids) => Object.fromEntries(ids.map(id => [id, previewOf(rows, id)]));

async function applyProposal(db, proposal) {
  const detail = typeof proposal.detail === "string" ? JSON.parse(proposal.detail) : (proposal.detail || {});
  const ids = detail.ids || [];
  switch (proposal.kind) {
    case "near_duplicate":
    case "redundant_key":
    case "subsumed": {
      const keep = detail.canonicalId;
      const disabled = [];
      for (const id of ids) {
        if (id === keep) continue;
        await db.Memory.update(id, { is_enabled: false });
        disabled.push(id);
      }
      return { disabled, kept: keep };
    }
    case "fragment_merge": {
      const merged = await db.Memory.create({
        workspace_id: proposal.workspace_id,
        content: ids.map(id => detail.previews?.[id] || id).join("\n\n---\n\n"),
        memory_type: "knowledge",
        memory_layer: normalizeMemoryLayer(detail.layer),
        memory_key: `cleanup.merged.${proposal.id}`,
        memory_value: { merged_from: ids, fragment_count: ids.length },
        source: "cleanup.merge",
        importance: 3,
        evidence_level: "inferred",
        volatility: "low"
      });
      for (const id of ids) await db.Memory.update(id, { is_enabled: false });
      return { mergedId: merged.id, disabled: ids };
    }
    case "stale_volatile": {
      for (const id of ids) await db.Memory.update(id, { is_enabled: false });
      return { disabled: ids };
    }
    case "orphan_node":
    case "dead_end": {
      const retired = [];
      for (const nodeId of (detail.nodeIds || [])) {
        await retireNode(db.query, { nodeId, actor: "cleanup", note: `retired per approved cleanup proposal ${proposal.id}` });
        retired.push(nodeId);
      }
      return { retired };
    }
    case "contradiction": {
      // The contradicts edge is the flag, not data: reviewed, the flag retires.
      await retireEdge(db.query, { edgeId: detail.edgeId, actor: "cleanup", note: `contradiction reviewed in cleanup proposal ${proposal.id}` });
      return { retiredEdge: detail.edgeId };
    }
    case "orphan_note": {
      const noteIds = detail.noteIds || [];
      if (noteIds.length) {
        await db.query(`DELETE FROM goal_notes WHERE id = ANY($1)`, [noteIds]);
      }
      return { deleted: noteIds };
    }
    default:
      throw new Error(`unknown cleanup proposal kind: ${proposal.kind}`);
  }
}

/**
 * Decide one proposal. Approve applies synchronously: Jeremy's confirm is the
 * last gate, so there is no window where an approval waits to mean something.
 */
export async function decideCleanupProposal({ db, proposalId, decision, reason = null, actor = "user" }) {
  const row = await db.CleanupProposal.get(proposalId);
  if (!row) return { ok: false, error: "proposal not found" };
  if (row.status === "applied") return { ok: false, error: "already applied", status: row.status };

  if (decision === "refuse") {
    if (!["requested", "approved"].includes(row.status)) {
      return { ok: false, error: `cannot refuse a ${row.status} proposal`, status: row.status };
    }
    const decided = await db.CleanupProposal.decide(row.id, {
      status: "refused", reason: reason || "refused by Jeremy", decidedBy: `human:${actor}`
    });
    return { ok: true, proposalId: row.id, status: decided.status };
  }
  if (decision !== "approve") return { ok: false, error: "decision must be approve or refuse" };
  if (!["requested", "approved"].includes(row.status)) {
    return { ok: false, error: `cannot approve a ${row.status} proposal`, status: row.status };
  }
  if (row.status === "requested") {
    await db.CleanupProposal.decide(row.id, {
      status: "approved", reason: reason || "approved by Jeremy", decidedBy: `human:${actor}`
    });
  }
  try {
    const applied = await applyProposal(db, row);
    await db.CleanupProposal.markApplied(row.id);
    return { ok: true, proposalId: row.id, status: "applied", ...applied };
  } catch (error) {
    // The row stays 'approved': an interrupted apply resumes, it never half-applies.
    return { ok: false, error: String(error?.message || error).slice(0, 300), proposalId: row.id, status: "approved" };
  }
}

// --- the audit ------------------------------------------------------------------

export async function cleanupDue(db, workspaceId, nowMs = Date.now()) {
  const last = await db.CleanupRun.last(workspaceId).catch(() => null);
  if (!last?.finished_ms) return true;
  return Math.floor(nowMs / DAY_MS) !== Math.floor(Number(last.finished_ms) / DAY_MS);
}

export async function runCleanupAudit({ db, workspaceId, logger = null, nowMs = Date.now(), noticesEnabled = true } = {}) {
  const runRow = await db.CleanupRun.start(workspaceId);
  const findings = {};
  const tidied = {};
  let proposedCount = 0;
  const propose = async (store, kind, title, detail, targetIds) => {
    const { duplicate } = await proposeFinding(db, workspaceId, { store, kind, title, detail, targetIds });
    if (!duplicate) proposedCount++;
  };

  try {
    // ---- memories: every layer -------------------------------------------
    const mems = await db.Memory.filter({ workspace_id: workspaceId, is_enabled: true }, CLEANUP_SCAN_LIMIT);
    findings.memories_scanned = mems.length;

    const dupeGroups = findExactDuplicateGroups(mems);
    let dupesTidied = 0;
    for (const g of dupeGroups) {
      const canonical = pickCanonical(mems, g.ids);
      for (const id of g.ids) {
        if (id === canonical) continue;
        await db.Memory.update(id, { is_enabled: false });
        dupesTidied++;
      }
    }
    tidied.exact_duplicates = dupesTidied;
    findings.exact_duplicate_groups = dupeGroups.length;

    const expired = mems.filter(m => m.expires_at && Date.parse(m.expires_at) < nowMs);
    for (const m of expired) await db.Memory.update(m.id, { is_enabled: false });
    tidied.expired_ttl = expired.length;

    const dupeIds = new Set(dupeGroups.flatMap(g => g.ids));
    const { pairs } = findNearDuplicatePairs(mems.filter(m => !dupeIds.has(m.id)));
    findings.near_duplicate_pairs = pairs.length;
    for (const p of pairs.slice(0, MAX_PROPOSALS_PER_KIND)) {
      const canonical = pickCanonical(mems, [p.aId, p.bId]);
      await propose("memories", "near_duplicate", "Two memories say nearly the same thing",
        { ids: [p.aId, p.bId], canonicalId: canonical, similarity: p.similarity, previews: previewsFor(mems, [p.aId, p.bId]) },
        [p.aId, p.bId]);
    }

    for (const g of findRedundantKeyGroups(mems).slice(0, MAX_PROPOSALS_PER_KIND)) {
      const canonical = pickCanonical(mems, g.ids);
      await propose("memories", "redundant_key", `One key holds ${g.ids.length} different memories`,
        { key: g.key, ids: g.ids, canonicalId: canonical, previews: previewsFor(mems, g.ids) }, g.ids);
    }

    for (const p of findSubsumedPairs(mems).slice(0, MAX_PROPOSALS_PER_KIND)) {
      await propose("memories", "subsumed", "A shorter memory lives inside a longer one",
        { ids: [p.longerId, p.shorterId], canonicalId: p.longerId, previews: previewsFor(mems, [p.longerId, p.shorterId]) },
        [p.longerId, p.shorterId]);
    }

    for (const g of findFragmentGroups(mems)) {
      await propose("memories", "fragment_merge", `${g.ids.length} tiny fragments worth merging`,
        { layer: g.layer, ids: g.ids, previews: previewsFor(mems, g.ids) }, g.ids);
    }

    const stale = findStaleVolatile(mems, nowMs);
    if (stale.length) {
      await propose("memories", "stale_volatile",
        `${stale.length} fast-changing ${stale.length === 1 ? "memory has" : "memories have"} gone quiet`,
        { ids: stale, previews: previewsFor(mems, stale) }, stale);
    }

    // ---- knowledge graph ---------------------------------------------------
    const nodes = await db.Graph.listNodes(workspaceId, { status: "active", limit: 2000 }).catch(() => []);
    const edges = await db.Graph.listEdges(workspaceId, { status: "active", limit: 5000 }).catch(() => []);
    findings.graph_nodes = nodes.length;
    findings.graph_edges = edges.length;

    let edgesRetired = 0;
    for (const ids of findDuplicateGraphEdges(edges)) {
      for (const id of ids.slice(1)) {
        await retireEdge(db.query, { edgeId: id, actor: "cleanup", note: "duplicate edge auto-retired by the cleanup audit" });
        edgesRetired++;
      }
    }
    tidied.duplicate_edges = edgesRetired;

    const orphans = findOrphanGraphNodes(nodes, edges, nowMs);
    if (orphans.length) {
      await propose("graph", "orphan_node",
        `${orphans.length} graph ${orphans.length === 1 ? "node has" : "nodes have"} no connections`,
        { nodeIds: orphans, labels: Object.fromEntries(orphans.map(id => [id, previewOf(nodes, id)])) },
        orphans);
    }

    for (const comp of findDeadEndComponents(nodes, edges, nowMs)) {
      await propose("graph", "dead_end",
        `A dead-end corner of the graph (${comp.length} untrusted, aging nodes)`,
        { nodeIds: comp, labels: Object.fromEntries(comp.map(id => [id, previewOf(nodes, id)])) },
        comp);
    }

    for (const edgeId of findContradictions(edges).slice(0, MAX_PROPOSALS_PER_KIND)) {
      const e = edges.find(x => x.id === edgeId) || {};
      await propose("graph", "contradiction", "Two graph entries disagree",
        { edgeId, srcLabel: previewOf(nodes, e.src_node_id), dstLabel: previewOf(nodes, e.dst_node_id) },
        [edgeId]);
    }

    // ---- telemetry retention (auto, logged) ----------------------------------
    const telCut = new Date(nowMs - TELEMETRY_RETENTION_DAYS * DAY_MS).toISOString();
    const telCalls = await db.query(
      `DELETE FROM telemetry_model_calls WHERE created_date < $1 RETURNING id`, [telCut]
    ).catch(() => []);
    const telRuns = await db.query(
      `DELETE FROM telemetry_runs WHERE workspace_id = $1 AND created_date < $2 RETURNING id`,
      [workspaceId, telCut]
    ).catch(() => []);
    tidied.telemetry_rows = (telRuns?.length || 0) + (telCalls?.length || 0);

    // ---- acked notices past retention (auto, logged) ---------------------------
    const noticeCut = nowMs - NOTICE_RETENTION_DAYS * DAY_MS;
    const oldNotices = await db.query(
      `DELETE FROM autonomy_notices WHERE workspace_id = $1 AND acked_ms IS NOT NULL AND acked_ms < $2 RETURNING id`,
      [workspaceId, noticeCut]
    ).catch(() => []);
    tidied.old_notices = oldNotices?.length || 0;

    // ---- orphaned goal notes (review: the goal is gone) ------------------------
    // goal_notes carries no workspace_id; scope through the note's agent.
    const orphanNotes = await db.query(
      `SELECT n.id FROM goal_notes n
         LEFT JOIN autonomy_agents a ON a.id = n.agent_id
        WHERE n.goal_id IS NOT NULL
          AND n.goal_id NOT IN (SELECT id FROM autonomy_goals)
          AND (a.workspace_id = $1 OR a.id IS NULL)
       LIMIT 100`, [workspaceId]
    ).catch(() => []);
    if (orphanNotes?.length) {
      const noteIds = orphanNotes.map(n => n.id);
      await propose("autonomy", "orphan_note",
        `${noteIds.length} ${noteIds.length === 1 ? "note is" : "notes are"} orphaned from deleted goals`,
        { noteIds }, noteIds);
    }

    await db.CleanupRun.finish(runRow.id, {
      findings, tidied, proposals: { requested: proposedCount }
    });

    const totalTidied = Object.values(tidied).reduce((n, v) => n + (Number(v) || 0), 0);
    if (noticesEnabled && (totalTidied > 0 || proposedCount > 0)) {
      const fields = buildNoticeFields("cleanup_report", { tidied: totalTidied, awaitingReview: proposedCount });
      if (fields) {
        await db.AutonomyNotice.create({
          workspace_id: workspaceId, agent_id: null, goal_id: null,
          template_id: "cleanup_report", fields, severity: "info"
        }).catch(() => null);
      }
    }
    logger?.info?.("cleanup audit finished", { findings, tidied, proposals: proposedCount });
    return { ok: true, runId: runRow.id, findings, tidied, proposals: proposedCount };
  } catch (error) {
    await db.CleanupRun.finish(runRow.id, {
      findings, tidied,
      proposals: { requested: proposedCount },
      error: String(error?.message || error).slice(0, 500)
    }).catch(() => null);
    throw error;
  }
}
