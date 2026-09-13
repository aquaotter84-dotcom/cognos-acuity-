// Phase 23 route module — the trust-annotated knowledge-graph ("Atlas") API.
//
// Query routes are read-only instruments over the atlas; curation routes are
// the user-controlled write path (pin/fork/retire/revise/trust). Every write
// runs inside one transaction with its ledger event, and nothing here can
// release an answer: the atlas informs the council, it never addresses the
// user. Graph citations in an answer are audited by the Governor against the
// rows the turn actually loaded (see server/council/governor.js).

import { parseInstant as parseAt } from "../http/query.js";
import { num } from "../db/util.js";
import { TRACKED_FIELDS } from "../knowledge/store.js";

function cleanLabel(value, limit = 240) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanContent(value, limit = 4000) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function hydrateNode(node) {
  if (!node) return null;
  return { ...node, confidence: num(node.confidence, 0.5), version: Number(node.version ?? 1) };
}

function hydrateEdge(edge) {
  if (!edge) return null;
  return { ...edge, weight: num(edge.weight, 0.5), version: Number(edge.version ?? 1) };
}

export function registerGraphRoutes(app, { wrap, db, logger }) {
  const needGraph = (req, res, next) => {
    if (process.env.COGNOS_GRAPH_ENABLED === "false") {
      return res.status(409).json({ error: "The knowledge graph is disabled on this deployment (COGNOS_GRAPH_ENABLED=false)." });
    }
    return next();
  };

  // --- overview --------------------------------------------------------------
  app.get("/api/graph/overview", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await db.Graph.overview(ws.id));
  }));

  // --- nodes -----------------------------------------------------------------
  app.get("/api/graph/nodes", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.Graph.listNodes(ws.id, {
      type: req.query.type || null,
      status: req.query.status || null,
      trust: req.query.trust || null,
      conversationId: req.query.conversationId || null,
      projectId: req.query.projectId || null,
      q: req.query.q || null,
      truthOnly: req.query.truthOnly === "1" || req.query.truthOnly === "true",
      limit: Number(req.query.limit || 100)
    });
    res.json({ count: rows.length, nodes: rows.map(hydrateNode) });
  }));

  app.post("/api/graph/nodes", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const label = cleanLabel(req.body?.label);
    if (!label) return res.status(400).json({ error: "label is required" });
    const content = cleanContent(req.body?.content ?? label);
    if (!content) return res.status(400).json({ error: "content is required" });
    const out = await db.withTransaction(async (store) => {
      return store.Graph.createNode({
        workspaceId: ws.id,
        type: req.body?.type || "concept",
        label,
        content,
        trust: req.body?.trust || "untrusted",
        confidence: req.body?.confidence ?? 0.5,
        projectId: req.body?.projectId || null,
        conversationId: req.body?.conversationId || null,
        sourceIds: Array.isArray(req.body?.sourceIds) ? req.body.sourceIds : [],
        actor: "user",
        note: cleanLabel(req.body?.note || "created by the user", 280) || null
      });
    });
    res.status(out.existing ? 200 : 201).json({
      existing: !!out.existing,
      node: hydrateNode(out.node),
      events: (out.events || []).length
    });
  }));

  app.get("/api/graph/nodes/:id", needGraph, wrap(async (req, res) => {
    const node = await db.Graph.getNode(req.params.id);
    if (!node) return res.status(404).json({ error: "Graph node not found" });
    const [edges, lineage, seal] = await Promise.all([
      db.Graph.edgesForNode(node.id, { status: null, limit: 100 }),
      db.Replay.lineage({ entityType: "graph_node", entityId: node.id, limit: 200 }),
      Promise.resolve(db.Graph.verifyNodeSeal(node))
    ]);
    res.json({ node: hydrateNode(node), edges: edges.map(hydrateEdge), lineage, seal });
  }));

  // User-controlled curation. Each act writes a new edge with a revision link
  // to its predecessor; nothing is overwritten and nothing is deleted.
  app.post("/api/graph/nodes/:id/pin", needGraph, wrap(async (req, res) => {
    const out = await db.withTransaction(async (store) => {
      return store.Graph.pinNode({ nodeId: req.params.id, actor: "user", note: cleanLabel(req.body?.note || "", 280) || null });
    });
    res.json({ node: hydrateNode(out.node), events: out.events.length });
  }));

  app.post("/api/graph/nodes/:id/retire", needGraph, wrap(async (req, res) => {
    const out = await db.withTransaction(async (store) => {
      return store.Graph.retireNode({
        nodeId: req.params.id, actor: "user",
        note: cleanLabel(req.body?.note || req.body?.reason || "", 280) || null,
        successorId: req.body?.successorId || null
      });
    });
    res.json({ node: hydrateNode(out.node), events: out.events.length });
  }));

  app.post("/api/graph/nodes/:id/fork", needGraph, wrap(async (req, res) => {
    const out = await db.withTransaction(async (store) => {
      return store.Graph.forkNode({
        nodeId: req.params.id,
        label: req.body?.label ? cleanLabel(req.body.label) : null,
        content: req.body?.content ? cleanContent(req.body.content) : null,
        trust: req.body?.trust || null,
        actor: "user",
        note: cleanLabel(req.body?.note || "", 280) || null
      });
    });
    res.json({ node: hydrateNode(out.node), forkEdge: hydrateEdge(out.forkEdge), events: out.events.length });
  }));

  app.post("/api/graph/nodes/:id/revise", needGraph, wrap(async (req, res) => {
    const out = await db.withTransaction(async (store) => {
      return store.Graph.reviseNode({
        nodeId: req.params.id,
        label: req.body?.label ? cleanLabel(req.body.label) : null,
        content: req.body?.content ? cleanContent(req.body.content) : null,
        trust: req.body?.trust || null,
        confidence: req.body?.confidence ?? null,
        actor: "user",
        note: cleanLabel(req.body?.note || "", 280) || null
      });
    });
    res.json({
      node: hydrateNode(out.node),
      retired: hydrateNode(out.retired),
      revisionEdge: hydrateEdge(out.revisionEdge),
      events: out.events.length
    });
  }));

  app.post("/api/graph/nodes/:id/trust", needGraph, wrap(async (req, res) => {
    const out = await db.withTransaction(async (store) => {
      return store.Graph.setTrust({
        nodeId: req.params.id,
        trust: req.body?.trust || "untrusted",
        actor: "user",
        note: cleanLabel(req.body?.note || "", 280) || null
      });
    });
    res.json({ node: hydrateNode(out.node), events: out.events.length });
  }));

  // --- edges -----------------------------------------------------------------
  app.get("/api/graph/edges", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.Graph.listEdges(ws.id, {
      kind: req.query.kind || null,
      status: req.query.status || null,
      trust: req.query.trust || null,
      nodeId: req.query.nodeId || null,
      truthOnly: req.query.truthOnly === "1" || req.query.truthOnly === "true",
      limit: Number(req.query.limit || 200)
    });
    res.json({ count: rows.length, edges: rows.map(hydrateEdge) });
  }));

  app.post("/api/graph/edges", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const { srcNodeId, dstNodeId } = req.body || {};
    if (!srcNodeId || !dstNodeId) return res.status(400).json({ error: "srcNodeId and dstNodeId are required" });
    const out = await db.withTransaction(async (store) => {
      return store.Graph.createEdge({
        workspaceId: ws.id,
        srcNodeId, dstNodeId,
        kind: req.body?.kind || "is-about",
        trust: req.body?.trust || "untrusted",
        weight: req.body?.weight ?? 0.5,
        actor: "user",
        note: cleanLabel(req.body?.note || "", 280) || null
      });
    });
    res.status(out.existing ? 200 : 201).json({
      existing: !!out.existing,
      edge: hydrateEdge(out.edge),
      events: (out.events || []).length
    });
  }));

  app.get("/api/graph/edges/:id", needGraph, wrap(async (req, res) => {
    const edge = await db.Graph.getEdge(req.params.id);
    if (!edge) return res.status(404).json({ error: "Graph edge not found" });
    const [lineage, seal] = await Promise.all([
      db.Replay.lineage({ entityType: "graph_edge", entityId: edge.id, limit: 200 }),
      Promise.resolve(db.Graph.verifyEdgeSeal(edge))
    ]);
    res.json({ edge: hydrateEdge(edge), lineage, seal });
  }));

  app.post("/api/graph/edges/:id/retire", needGraph, wrap(async (req, res) => {
    const out = await db.withTransaction(async (store) => {
      return store.Graph.retireEdge({
        edgeId: req.params.id, actor: "user",
        note: cleanLabel(req.body?.note || req.body?.reason || "", 280) || null
      });
    });
    res.json({ edge: hydrateEdge(out.edge), events: out.events.length });
  }));

  // --- traversal + truth query -------------------------------------------------
  app.get("/api/graph/related/:nodeId", needGraph, wrap(async (req, res) => {
    const t0 = Date.now();
    const kinds = req.query.kinds ? String(req.query.kinds).split(",").map(s => s.trim()).filter(Boolean) : null;
    const out = await db.Graph.findRelated(req.params.nodeId, {
      depth: Number(req.query.depth || 2),
      kinds,
      truthOnly: req.query.truthOnly === "1" || req.query.truthOnly === "true",
      limit: Number(req.query.limit || 60)
    });
    res.json({ ...out, latencyMs: Date.now() - t0, latencyTargetMs: 150 });
  }));

  app.get("/api/graph/query", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const q = String(req.query.q || "");
    if (!q.trim()) return res.status(400).json({ error: "q is required" });
    const t0 = Date.now();
    const types = req.query.types ? String(req.query.types).split(",").map(s => s.trim()).filter(Boolean) : null;
    const nodes = await db.Graph.queryRelevant(ws.id, q, {
      limit: Number(req.query.limit || 8),
      truthOnly: req.query.truthOnly === "1" || req.query.truthOnly === "true",
      types
    });
    res.json({
      q: q.slice(0, 200),
      truthOnly: req.query.truthOnly === "1" || req.query.truthOnly === "true",
      count: nodes.length,
      latencyMs: Date.now() - t0,
      latencyTargetMs: 150,
      nodes: nodes.map(hydrateNode)
    });
  }));

  app.get("/api/graph/conflicts", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.Graph.listConflicts(ws.id, { limit: Number(req.query.limit || 50) });
    res.json({
      count: rows.length,
      note: "Contradicts edges between live nodes, surfaced for manual resolution.",
      conflicts: rows.map(({ edge, src, dst }) => ({
        edge: hydrateEdge(edge),
        src: hydrateNode(src),
        dst: hydrateNode(dst)
      }))
    });
  }));

  // --- snapshots (immutable, Merkle) -------------------------------------------
  app.get("/api/graph/snapshots", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.Graph.listSnapshots(ws.id, { limit: Number(req.query.limit || 30) });
    res.json({ count: rows.length, snapshots: rows });
  }));

  app.post("/api/graph/snapshots", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const out = await db.withTransaction(async (store) => {
      return store.Graph.createSnapshot({
        workspaceId: ws.id,
        note: cleanLabel(req.body?.note || "", 280) || null,
        actor: "user"
      });
    });
    res.status(201).json({ snapshot: out.snapshot, events: out.events.length });
  }));

  // Registered before /:id so Express does not treat "diff" as an id.
  app.get("/api/graph/snapshots/diff", needGraph, wrap(async (req, res) => {
    const { a, b } = req.query || {};
    if (!a || !b) return res.status(400).json({ error: "query params a and b (snapshot ids) are required" });
    res.json(await db.Graph.diffSnapshots(String(a), String(b)));
  }));

  app.get("/api/graph/snapshots/:id", needGraph, wrap(async (req, res) => {
    const snapshot = await db.Graph.getSnapshot(req.params.id);
    if (!snapshot) return res.status(404).json({ error: "Snapshot not found" });
    res.json({ snapshot });
  }));

  // --- integrity + coverage ------------------------------------------------------
  app.get("/api/graph/verify", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await db.Graph.verifyWorkspace(ws.id, { limit: Number(req.query.limit || 2000) }));
  }));

  app.get("/api/graph/coverage", needGraph, wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await db.Graph.coverageAudit(ws.id));
  }));

  // --- replay parity: the atlas folds like every other entity -------------------
  app.get("/api/graph/state/:entityType/:entityId", needGraph, wrap(async (req, res) => {
    const { entityType, entityId } = req.params;
    if (!["graph_node", "graph_edge"].includes(entityType)) {
      return res.status(400).json({ error: "entityType must be graph_node or graph_edge" });
    }
    const at = parseAt(req.query.at);
    const replay = await db.Replay.stateAt(entityType, entityId, { atMs: at });
    const tracked = TRACKED_FIELDS[entityType] || null;
    const verification = tracked ? await db.Replay.verify(entityType, entityId, tracked) : null;
    res.json({
      entityType, entityId,
      asOf: replay.asOf ?? new Date().toISOString(),
      replayed: replay.asOf !== null,
      exists: replay.exists,
      state: replay.state,
      eventCount: replay.eventCount,
      firstEventAt: replay.firstEventAt,
      lastTransition: replay.lastTransition,
      history: replay.history,
      trackedFields: tracked,
      foldMatchesCurrentState: verification ? { consistent: verification.consistent, drift: verification.drift, current: verification.current } : null
    });
  }));

  logger.info("graph routes registered", { base: "/api/graph" });
}
