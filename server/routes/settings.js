// On-device settings routes.
//
// The model API key lives in <COGNOS_DATA_DIR>/bluesminds_api_key.txt on-device
// (written by the APK boot page); server deploys keep it in env vars instead.
// These routes let the Settings page change or remove the key without
// reinstalling the app. server/llm.js reads process.env on every call, so
// updating both the file and the env var takes effect immediately — no
// restart needed. The key value itself is never returned by any route.

import fs from "node:fs";
import path from "node:path";

const KEY_FILE = "bluesminds_api_key.txt";

function deviceKeyPath() {
  const dir = process.env.COGNOS_DATA_DIR;
  return dir ? path.join(dir, KEY_FILE) : null;
}

export function registerSettingsRoutes(app, { wrap, logger }) {
  app.get("/api/settings/model-key", wrap(async (req, res) => {
    res.json({
      configured: Boolean(process.env.BLUESMINDS_API_KEY || process.env.OPENAI_API_KEY),
      // "device": the key file lives in app-internal storage and can be
      // changed here. "environment": a server deploy — managed by env vars.
      managed: deviceKeyPath() ? "device" : "environment",
    });
  }));

  app.post("/api/settings/model-key", wrap(async (req, res) => {
    const keyPath = deviceKeyPath();
    if (!keyPath) {
      return res.status(400).json({
        error: "The model key is managed by the server environment on this install — it can't be changed from Settings.",
      });
    }
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    if (!key) return res.status(400).json({ error: "Enter an API key first." });
    if (key.length > 500) return res.status(400).json({ error: "That key looks too long to be valid — check for extra characters." });
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key, { mode: 0o600, encoding: "utf8" });
    // llm.js reads process.env per call, so this applies immediately.
    process.env.BLUESMINDS_API_KEY = key;
    if (logger) logger.info("settings", "model key updated from Settings page");
    res.json({ ok: true, configured: true });
  }));

  app.delete("/api/settings/model-key", wrap(async (req, res) => {
    const keyPath = deviceKeyPath();
    if (!keyPath) {
      return res.status(400).json({
        error: "The model key is managed by the server environment on this install.",
      });
    }
    try { fs.unlinkSync(keyPath); } catch { /* already absent */ }
    delete process.env.BLUESMINDS_API_KEY;
    if (logger) logger.info("settings", "model key removed from Settings page");
    res.json({ ok: true, configured: Boolean(process.env.OPENAI_API_KEY) });
  }));
}
