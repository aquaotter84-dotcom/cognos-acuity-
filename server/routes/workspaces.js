// Phase 24 route module — /api/workspaces/* and /api/groups/*.
//
// Every route below sits behind the same bearer-token middleware as
// /api/accounts/me, and every graph operation flows through the Workspace
// Manager's single isolation gate (resolveAccess) — the brief's
// "pre-processor that checks the JWT claim" for cross-workspace reads.
//
//   GET  /api/workspaces                        everything the bearer can see
//   GET  /api/workspaces/:ns/nodes              list (?type&trust&q&truthOnly&limit)
//   POST /api/workspaces/:ns/nodes              create (append-only, sealed)
//   GET  /api/workspaces/:ns/nodes/:nodeId      read one (403 outside the namespace)
//   POST /api/workspaces/:ns/nodes/:nodeId/retire   soft delete (a transition)
//   GET  /api/workspaces/:ns/edges              list (?kind&nodeId&limit)
//   POST /api/workspaces/:ns/edges              add edge (endpoints must be in-namespace)
//   GET  /api/workspaces/:ns/query?q=           relevance query
//   GET  /api/workspaces/:ns/verify             dual-seal provenance audit
//   GET  /api/workspaces/:ns/audit              the append-only audit trail
//
//   POST /api/groups                            create a group (+ its two buckets)
//   GET  /api/groups                            groups the bearer belongs to
//   GET  /api/groups/:id                        group detail (members see it)
//   POST /api/groups/:id/members                owner adds a member {email|user_id, can_write_private}
//   POST /api/groups/:id/members/:userId/flag   owner flips the private-bucket flag
//   DELETE /api/groups/:id/members/:userId      owner removes a member
//
// `:ns` is a namespace token: ws-<workspace_id>, group-public-<group_id>, or
// group-private-<group_id>. Anything else is a 400 before any data is touched.

export function registerWorkspaceRoutes(app, { wrap, db, logger, requireAuth, manager }) {

  // Resolve :ns syntax safely (Express 4 route params stop at "/").
  const NS_RE = /^(ws-|group-public-|group-private-)[A-Za-z0-9-]+$/;
  app.param("ns", (req, res, next, value) => {
    if (!NS_RE.test(value)) {
      return res.status(400).json({ error: `Unknown workspace namespace: ${value.slice(0, 60)}`, code: "bad_namespace" });
    }
    return next();
  });

  // --- overview ----------------------------------------------------------------
  app.get("/api/workspaces", requireAuth, wrap(async (req, res) => {
    res.json(await manager.listWorkspaces(req.auth));
  }));

  // --- nodes -------------------------------------------------------------------
  app.get("/api/workspaces/:ns/nodes", requireAuth, wrap(async (req, res) => {
    const { rows } = await manager.listNodes(req.auth, req.params.ns, {
      type: req.query.type || null,
      trust: req.query.trust || null,
      q: req.query.q || null,
      truthOnly: req.query.truthOnly === "1" || req.query.truthOnly === "true",
      limit: Number(req.query.limit || 100)
    });
    res.json({ namespace: req.params.ns, count: rows.length, nodes: rows });
  }));

  app.post("/api/workspaces/:ns/nodes", requireAuth, wrap(async (req, res) => {
    const node = await manager.createNode(req.auth, req.params.ns, req.body || {});
    res.status(node.created ? 201 : 200).json(node);
  }));

  app.get("/api/workspaces/:ns/nodes/:nodeId", requireAuth, wrap(async (req, res) => {
    const node = await manager.readNode(req.auth, req.params.ns, req.params.nodeId);
    if (!node) return res.status(404).json({ error: "Node not found", code: "node_not_found" });
    res.json(node);
  }));

  app.post("/api/workspaces/:ns/nodes/:nodeId/retire", requireAuth, wrap(async (req, res) => {
    const result = await manager.retireNode(req.auth, req.params.ns, req.params.nodeId, req.body?.reason || null);
    if (!result) return res.status(404).json({ error: "Node not found", code: "node_not_found" });
    res.json({ ok: true, node: result.node, existing: Boolean(result.existing) });
  }));

  // --- edges -------------------------------------------------------------------
  app.get("/api/workspaces/:ns/edges", requireAuth, wrap(async (req, res) => {
    const { rows } = await manager.listEdges(req.auth, req.params.ns, {
      kind: req.query.kind || null,
      nodeId: req.query.nodeId || null,
      limit: Number(req.query.limit || 200)
    });
    res.json({ namespace: req.params.ns, count: rows.length, edges: rows });
  }));

  app.post("/api/workspaces/:ns/edges", requireAuth, wrap(async (req, res) => {
    const body = req.body || {};
    const result = await manager.addEdge(req.auth, req.params.ns, {
      srcNodeId: body.src_node_id || body.srcNodeId,
      dstNodeId: body.dst_node_id || body.dstNodeId,
      kind: body.kind || "is-about",
      weight: body.weight ?? 0.5,
      trust: body.trust || "untrusted",
      source_graph_id: body.source_graph_id || null,
      run_id: body.run_id || null
    });
    res.status(result.existing ? 200 : 201).json(result.edge);
  }));

  // --- query / verify / audit ------------------------------------------------------
  app.get("/api/workspaces/:ns/query", requireAuth, wrap(async (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Provide ?q=", code: "q_required" });
    const { rows } = await manager.query(req.auth, req.params.ns, q, {
      limit: Number(req.query.limit || 8),
      truthOnly: req.query.truthOnly === "1" || req.query.truthOnly === "true"
    });
    res.json({ namespace: req.params.ns, q, count: rows.length, results: rows });
  }));

  app.get("/api/workspaces/:ns/verify", requireAuth, wrap(async (req, res) => {
    res.json(await manager.verifyProvenance(req.auth, req.params.ns, {
      limit: Number(req.query.limit || 500)
    }));
  }));

  app.get("/api/workspaces/:ns/audit", requireAuth, wrap(async (req, res) => {
    res.json(await manager.readAudit(req.auth, req.params.ns, {
      action: req.query.action || null,
      sinceMs: req.query.since !== undefined ? Number(req.query.since) : null,
      limit: Number(req.query.limit || 100)
    }));
  }));

  // --- groups --------------------------------------------------------------------
  app.post("/api/groups", requireAuth, wrap(async (req, res) => {
    const group = await manager.createGroup(req.auth, { name: req.body?.name });
    res.status(201).json(await manager.getGroup(req.auth, group.id));
  }));

  app.get("/api/groups", requireAuth, wrap(async (req, res) => {
    const view = await manager.listWorkspaces(req.auth);
    res.json({ count: view.groups.length, groups: view.groups });
  }));

  app.get("/api/groups/:groupId", requireAuth, wrap(async (req, res) => {
    const group = await manager.getGroup(req.auth, req.params.groupId);
    if (!group) return res.status(404).json({ error: "Group not found", code: "group_not_found" });
    res.json(group);
  }));

  app.post("/api/groups/:groupId/members", requireAuth, wrap(async (req, res) => {
    const body = req.body || {};
    res.json(await manager.addGroupMember(req.auth, req.params.groupId, {
      userId: body.user_id || null,
      email: body.email || null,
      canWritePrivate: body.can_write_private === true
    }));
  }));

  app.post("/api/groups/:groupId/members/:userId/flag", requireAuth, wrap(async (req, res) => {
    res.json(await manager.flagGroupMember(req.auth, req.params.groupId, req.params.userId,
      req.body?.can_write_private !== false));
  }));

  app.delete("/api/groups/:groupId/members/:userId", requireAuth, wrap(async (req, res) => {
    res.json(await manager.removeGroupMember(req.auth, req.params.groupId, req.params.userId));
  }));
}
