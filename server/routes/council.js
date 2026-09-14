// Phase 26 — the delegated council switches (Critic, Governor).
//
// Two read-only facts and one write: what is on, whether an operator pinned it,
// and whether the UI may flip it. Nothing here composes prose or touches the
// council pipeline directly — it records a switch, and server/config.js reads
// the resolved value on the next turn. The precedence (env pin > delegated row
// > ON) lives in server/council/settings.js, which is also what getSystemConfig
// asks, so the route and the council can never disagree about the same value.
//
//   GET  /api/council/settings   — governor/critic on, pinned, delegated, and
//                                  the recent flips
//   POST /api/council/settings   — flip one switch: { switch, enabled }
//                                  (409 against a pin, or with no delegation)

import {
  describeCouncilSettings, ensureCouncilSettingsLoaded,
  setCouncilToggle, listCouncilFlips
} from "../council/settings.js";

const safe = (value, max) => String(value ?? "")
  .replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function registerCouncilRoutes(app, { wrap, db, logger }) {
  app.get("/api/council/settings", wrap(async (req, res) => {
    if (req.query.fresh) await import("../council/settings.js").then(m => m.refreshCouncilSettings(db));
    else await ensureCouncilSettingsLoaded(db);
    const flips = await listCouncilFlips(db, { limit: Number(req.query.limit) || 10 });
    res.json({ ...describeCouncilSettings(), flips });
  }));

  app.post("/api/council/settings", wrap(async (req, res) => {
    await ensureCouncilSettingsLoaded(db);
    const which = String(req.body?.switch || "").trim().toLowerCase();
    const enabled = req.body?.enabled;
    if (!["governor", "critic"].includes(which)) {
      return res.status(400).json({ error: "switch must be governor or critic" });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be true or false" });
    }

    const outcome = await setCouncilToggle(db, {
      which, enabled,
      updatedBy: safe(req.body?.updated_by, 60) || "ui"
    });
    if (!outcome.ok) {
      return res.status(409).json({
        error: outcome.refusal.message,
        code: outcome.refusal.code,
        settings: outcome.settings
      });
    }
    logger.info("council switch flipped from the UI", {
      which, to: enabled,
      from: which === "governor" ? outcome.previous.governorEnabled : outcome.previous.criticEnabled
    });
    res.json({
      which,
      enabled: which === "governor" ? outcome.settings.governorEnabled : outcome.settings.criticEnabled,
      changed: (which === "governor" ? outcome.previous.governorEnabled : outcome.previous.criticEnabled) !== enabled,
      atMs: outcome.atMs,
      settings: outcome.settings,
      note: enabled === false && which === "governor"
        ? "The Governor is off: empty responses, secret leakage and citation audits are no longer vetoing answers. Only an operator who understands that should do this."
        : undefined
    });
  }));
}
