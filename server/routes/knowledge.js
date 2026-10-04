// Phase 14 route module — read-only instruments over the dynamic knowledge store.

import { createTemporalReasoner } from "../knowledge/temporal.js";
import { analytics, changeRatePerEntity, stabilityIndex, churnOverTime, overview } from "../knowledge/analytics.js";
import { TRACKED_FIELDS } from "../knowledge/store.js";
import { num } from "../db/util.js";
import { parseInstant as parseAt } from "../http/query.js";

export function registerKnowledgeRoutes(app, { wrap, db, logger }) {
  // ===========================================================================
  // Phase 14 — Dynamic Systems. Read-only query surfaces over the event ledger.
  // Bare JSON, as the phase allows: these are instruments for an operator, not a
  // UI. Nothing here writes, and nothing here is on the send path.
  //
  // Phase 37d adds operator-owned mutation: PATCH and DELETE on
  // /api/knowledge/events/:id, so Jeremy can edit or remove ledger entries.
  // These are the only write routes in this module. They are workspace-scoped
  // and validate before they touch anything.
  // ===========================================================================

  const hydrateEvent = (e) => ({
    ...e,
    seq: num(e.seq),
    ts_ms: num(e.ts_ms),
    at: new Date(num(e.ts_ms)).toISOString(),
    reversible: Boolean(e.reversible)
  });

  app.get("/api/knowledge/events", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.KnowledgeEvent.recent({
      workspaceId: req.query.scope === "all" ? null : ws.id,
      entityType: req.query.entityType || null,
      entityId: req.query.entityId || null,
      transition: req.query.transition || null,
      runId: req.query.runId || null,
      messageId: req.query.messageId || null,
      sinceMs: parseAt(req.query.since),
      untilMs: parseAt(req.query.until),
      limit: Number(req.query.limit || 100)
    });
    res.json({ count: rows.length, appendOnly: true, transitions: db.KnowledgeEvent.transitions(), events: rows.map(hydrateEvent) });
  }));

  // --- Phase 37d — operator-owned ledger: edit / delete ---------------------
  // Jeremy's record, his call. Workspace-scoped; 404 when the id is unknown
  // or belongs to another workspace; 400 when delta/to_state are not objects.
  const ledgerEditFields = ["delta", "to_state"];
  const asObjectField = (name, value) => {
    if (value === undefined || value === null) return { skip: true };
    if (typeof value !== "object" || Array.isArray(value)) {
      return { error: `${name} must be a JSON object.` };
    }
    return { value };
  };

  app.patch("/api/knowledge/events/:id", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const existing = await db.KnowledgeEvent.getScoped(req.params.id, ws.id);
    if (!existing) return res.status(404).json({ error: "No ledger entry with that id in this workspace." });
    const patch = {};
    for (const name of ledgerEditFields) {
      const parsed = asObjectField(name, (req.body || {})[name]);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      if (!parsed.skip) patch[name] = parsed.value;
    }
    const updated = await db.KnowledgeEvent.update(req.params.id, patch);
    res.json({ event: hydrateEvent(updated) });
  }));

  app.delete("/api/knowledge/events/:id", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const existing = await db.KnowledgeEvent.getScoped(req.params.id, ws.id);
    if (!existing) return res.status(404).json({ error: "No ledger entry with that id in this workspace." });
    await db.KnowledgeEvent.remove(req.params.id);
    res.json({ deleted: req.params.id });
  }));

  app.get("/api/knowledge/overview", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await overview(db, { workspaceId: ws.id }));
  }));

  app.get("/api/knowledge/analytics", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await analytics(db, {
      workspaceId: ws.id,
      windowDays: Number(req.query.windowDays || 30),
      bucketHours: Number(req.query.bucketHours || 24),
      limit: Number(req.query.limit || 50)
    }));
  }));

  app.get("/api/knowledge/analytics/change-rate", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await changeRatePerEntity(db, { workspaceId: ws.id, windowDays: Number(req.query.windowDays || 30), limit: Number(req.query.limit || 50) }));
  }));

  app.get("/api/knowledge/analytics/stability", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await stabilityIndex(db, { workspaceId: ws.id, windowDays: Number(req.query.windowDays || 30), entityType: req.query.entityType || "belief", limit: Number(req.query.limit || 50) }));
  }));

  app.get("/api/knowledge/analytics/churn", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await churnOverTime(db, { workspaceId: ws.id, windowDays: Number(req.query.windowDays || 14), bucketHours: Number(req.query.bucketHours || 24) }));
  }));

  app.get("/api/knowledge/beliefs", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.Belief.list(ws.id, { status: req.query.status || null, limit: Number(req.query.limit || 100) });
    const at = Date.now();
    res.json({
      count: rows.length,
      note: "Nothing is deleted: a retired belief keeps its row and its history.",
      beliefs: rows.map(b => ({ ...b, confidence: num(b.confidence), lineage: b.lineage || null }))
    });
  }));

  app.get("/api/knowledge/relationships", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const at = Date.now();
    const rows = await db.Relationship.list(ws.id, { kind: req.query.kind || null, status: req.query.status || null, limit: Number(req.query.limit || 100), at });
    res.json({
      count: rows.length,
      at,
      note: "effective_strength applies exponential decay from strength_as_of_ms, so a stale link weakens with no writer involved.",
      relationships: rows.map(r => ({ ...r, strength: num(r.strength), effective_strength: Number(num(r.effective_strength, 0).toFixed(6)) }))
    });
  }));

  app.get("/api/knowledge/coherence", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.CoherenceReport.recent({ verdict: req.query.verdict || null, workspaceId: ws.id, limit: Number(req.query.limit || 50) });
    res.json({ count: rows.length, reports: rows.map(r => ({ ...r, confidence_delta: num(r.confidence_delta) })) });
  }));

  // --- 14.2 REPLAY: any entity's state at any past instant --------------------
  app.get("/api/knowledge/state/:entityType/:entityId", wrap(async (req, res) => {
    const { entityType, entityId } = req.params;
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
      // Proof that current state IS the fold: folding the whole ledger with no
      // cut-off must reproduce the materialized row, field for field.
      foldMatchesCurrentState: verification ? { consistent: verification.consistent, drift: verification.drift, current: verification.current } : null
    });
  }));

  app.get("/api/knowledge/verify/:entityType/:entityId", wrap(async (req, res) => {
    const { entityType, entityId } = req.params;
    const tracked = TRACKED_FIELDS[entityType];
    if (!tracked) return res.status(400).json({ error: `No tracked projection for entity type '${entityType}'. Known: ${Object.keys(TRACKED_FIELDS).join(", ")}` });
    res.json(await db.Replay.verify(entityType, entityId, tracked));
  }));

  // --- temporal lineage -------------------------------------------------------
  app.get("/api/knowledge/lineage/run/:runId", wrap(async (req, res) => {
    const temporal = createTemporalReasoner({ db, logger });
    const [lineage, runDigest] = await Promise.all([
      db.Replay.lineage({ runId: req.params.runId, limit: 500 }),
      temporal.digestForRun(req.params.runId)
    ]);
    res.json({ runId: req.params.runId, ...lineage, digest: runDigest });
  }));

  app.get("/api/knowledge/lineage/:entityType/:entityId", wrap(async (req, res) => {
    const { entityType, entityId } = req.params;
    const lineage = await db.Replay.lineage({ entityType, entityId, limit: 500 });
    res.json({ entityType, entityId, ...lineage });
  }));

  app.get("/api/knowledge/temporal/:entityType/:entityId", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const { entityType, entityId } = req.params;
    const temporal = createTemporalReasoner({ db, workspaceId: ws.id, logger });
    const [velocity, trend, stability, before] = await Promise.all([
      temporal.confidenceVelocity(entityType, entityId),
      temporal.uncertaintyTrend(entityType, entityId),
      temporal.stability(entityType, entityId),
      temporal.whatChangedBefore({ anchorMs: Date.now(), limit: 10 })
    ]);
    res.json({ entityType, entityId, confidenceVelocity: velocity, uncertaintyTrend: trend, stability, whatChangedBefore: before });
  }));

  app.get("/api/knowledge/temporal", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const temporal = createTemporalReasoner({ db, workspaceId: ws.id, logger });
    const ids = String(req.query.beliefs || "").split(",").map(x => x.trim()).filter(Boolean);
    const [workspaceDigest, beliefs] = await Promise.all([
      temporal.digestForWorkspace({ windowDays: Number(req.query.windowDays || 7) }),
      ids.length ? temporal.digestForBeliefs(ids) : Promise.resolve(null)
    ]);
    res.json({ workspace: workspaceDigest, beliefs });
  }));


}
