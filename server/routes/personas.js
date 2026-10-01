// Phase 32 — persona routes. Thin on purpose: all behavior lives in
// server/personas.js so it is unit-testable without HTTP.

import {
  listPersonas,
  getPersona,
  createPersona,
  updatePersona,
  deletePersona,
  setActivePersona
} from "../personas.js";

function toStatus(err) {
  if (err?.code === "persona_not_found") return 404;
  if (err?.code === "invalid_persona" || err?.code === "builtin_persona") return 400;
  return 500;
}

export function registerPersonasRoutes(app, { wrap, db, logger }) {
  app.get("/api/personas", wrap(async (req, res) => {
    const personas = await listPersonas(db);
    const active = personas.find((p) => p.is_active) || null;
    res.json({ personas, activeId: active ? active.id : null });
  }));

  app.post("/api/personas", wrap(async (req, res) => {
    try {
      const persona = await createPersona(db, req.body || {});
      res.status(201).json({ persona });
    } catch (err) {
      logger?.warn?.("persona create failed", { error: String(err?.message || err).slice(0, 200) });
      res.status(toStatus(err)).json({ error: err.message });
    }
  }));

  app.put("/api/personas/:id", wrap(async (req, res) => {
    try {
      const persona = await updatePersona(db, req.params.id, req.body || {});
      res.json({ persona });
    } catch (err) {
      logger?.warn?.("persona update failed", { error: String(err?.message || err).slice(0, 200) });
      res.status(toStatus(err)).json({ error: err.message });
    }
  }));

  app.delete("/api/personas/:id", wrap(async (req, res) => {
    try {
      res.json(await deletePersona(db, req.params.id));
    } catch (err) {
      logger?.warn?.("persona delete failed", { error: String(err?.message || err).slice(0, 200) });
      res.status(toStatus(err)).json({ error: err.message });
    }
  }));

  app.post("/api/personas/:id/activate", wrap(async (req, res) => {
    try {
      const persona = await setActivePersona(db, req.params.id);
      res.json({ persona, activeId: persona.id });
    } catch (err) {
      logger?.warn?.("persona activate failed", { error: String(err?.message || err).slice(0, 200) });
      res.status(toStatus(err)).json({ error: err.message });
    }
  }));

  // Read-only single-persona fetch, used by the Settings editor.
  app.get("/api/personas/:id", wrap(async (req, res) => {
    const persona = await getPersona(db, req.params.id);
    if (!persona) return res.status(404).json({ error: "persona not found" });
    res.json({ persona });
  }));
}
