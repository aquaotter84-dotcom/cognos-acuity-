// Ideas API (Phase 37) — thin HTTP over server/autonomy/ideas.js.
// Same discipline as the other route modules: every behavior lives in the
// autonomy module (testable without HTTP); this file only wires it to routes.

import {
  listIdeas,
  acceptIdea,
  dismissIdea,
  refreshIdeas,
  retireObsoleteIdeas
} from "../autonomy/ideas.js";

export function registerIdeaRoutes(app, { wrap, db, logger }) {
  app.get("/api/autonomy/ideas", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const status = req.query?.status ?? "new";
    const ideas = await listIdeas(db, ws.id, { status: status === "all" ? null : status });
    res.json({ ideas });
  }));

  app.post("/api/autonomy/ideas/:id/accept", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const accepted = await acceptIdea(db, ws.id, req.params.id);
    if (!accepted) {
      return res.status(409).json({
        error: "Idea is no longer available — it was already accepted, dismissed or expired."
      });
    }
    res.json({ idea: accepted });
  }));

  app.post("/api/autonomy/ideas/:id/dismiss", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const dismissed = await dismissIdea(db, ws.id, req.params.id);
    if (!dismissed) {
      return res.status(409).json({
        error: "Idea is no longer new — nothing to dismiss."
      });
    }
    res.json({ idea: dismissed });
  }));

  app.post("/api/autonomy/ideas/refresh", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const retired = await retireObsoleteIdeas(db, ws.id);
    const created = await refreshIdeas(db, ws.id);
    logger?.info?.("ideas refreshed", {
      workspace: ws.id,
      retired,
      created: created.length
    });
    res.json({ created, retired, ideas: created });
  }));
}
