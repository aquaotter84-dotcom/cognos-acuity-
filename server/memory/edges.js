// The memory graph — Sapphire-style edges between memories, reimplemented in
// COGNOS's own code and style (ideas only; no Sapphire code).
//
// Edge types:
//   mentions     — this memory talks about that one (memory↔memory, or a
//                  memory pointing at an entity card)
//   derived_from — this row was distilled from that one: provenance for every
//                  librarian promotion and atomization, and for dream
//                  distillation (which also keeps its inline distilled_from)
//   structural   — anything else the librarian wires deliberately
//
// Edges are traversed by the priced recall walk (server/memory/recall.js).
// They are never popularity-ranked and never used to score a memory — the
// walk spends a budget reaching important, fresh nodes, it does not count
// connections.

export const EDGE_TYPES = Object.freeze(["mentions", "derived_from", "structural"]);

/**
 * Link two memories. Idempotent: re-linking the same pair with the same type
 * is a no-op returning null (the unique index swallows it).
 */
export async function linkMemories(db, {
  workspace_id, from_memory_id, to_memory_id, edge_type = "mentions",
  metadata = null, created_by = null
} = {}) {
  if (!EDGE_TYPES.includes(edge_type)) throw new Error(`unknown edge_type: ${edge_type}`);
  if (!workspace_id) throw new Error("linkMemories needs a workspace_id");
  return db.MemoryEdge.create({
    workspace_id, from_memory_id, to_memory_id, edge_type, metadata, created_by
  });
}

/** Every edge touching any of the given memory ids, either direction. */
export async function edgesFor(db, workspace_id, memoryIds) {
  return db.MemoryEdge.listFor(workspace_id, memoryIds);
}

/**
 * Build an undirected adjacency map from edge rows: id -> [{ to, edge_type }].
 * The walk treats edges as traversable both ways — a `derived_from` edge is
 * provenance you can follow in either direction at recall time.
 */
export function adjacencyFromEdges(edgeRows = []) {
  const adj = new Map();
  const add = (from, to, edge_type) => {
    if (!from || !to || from === to) return;
    if (!adj.has(from)) adj.set(from, []);
    const list = adj.get(from);
    if (!list.some(e => e.to === to && e.edge_type === edge_type)) {
      list.push({ to, edge_type });
    }
  };
  for (const e of edgeRows || []) {
    add(e.from_memory_id, e.to_memory_id, e.edge_type);
    add(e.to_memory_id, e.from_memory_id, e.edge_type);
  }
  return adj;
}
