// Phase 31 — heartbeat personality routes. Thin on purpose: every behavior
// lives in server/autonomy/personality.js so it is unit-testable without HTTP.
// The only route-specific work is wiring `compose` to callLLM and resolving
// the default workspace — the same two things every other route module does.

import {
  getPersonalitySettings,
  updatePersonalitySettings,
  serveGreeting
} from "../autonomy/personality.js";
import { callLLM } from "../llm.js";

export function registerHeartbeatRoutes(app, { wrap, db, logger }) {
  // One small model call per behavior, at most once a day each. A failure
  // here never fails the request: personality.js falls back to deterministic
  // text, and a compose that throws is caught there too.
  const compose = async ({ system, user, purpose }) => {
    try {
      const text = await callLLM(null, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        purpose
      });
      return typeof text === "string" && text.trim() ? text : null;
    } catch (error) {
      logger?.warn?.("heartbeat compose failed", {
        purpose,
        error: String(error?.message || error).slice(0, 200)
      });
      return null;
    }
  };

  // The morning greeting, served once per device-local day. The client sends
  // ?date=YYYY-MM-DD&part=morning|afternoon|evening|night from the device
  // clock; the server dedupes on that string and never guesses timezones.
  app.get("/api/heartbeat/greeting", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await serveGreeting({
      db,
      workspaceId: ws.id,
      dateStr: req.query?.date,
      partOfDay: req.query?.part,
      compose
    }));
  }));

  app.get("/api/heartbeat/settings", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json({ settings: await getPersonalitySettings(db, ws.id) });
  }));

  app.post("/api/heartbeat/settings", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json({ settings: await updatePersonalitySettings(db, ws.id, req.body || {}) });
  }));
}
