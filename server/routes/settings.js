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
const DB_URL_FILE = "database_url.txt";

function deviceKeyPath() {
  const dir = process.env.COGNOS_DATA_DIR;
  return dir ? path.join(dir, KEY_FILE) : null;
}

function deviceDbUrlPath() {
  const dir = process.env.COGNOS_DATA_DIR;
  return dir ? path.join(dir, DB_URL_FILE) : null;
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

  // --- External database URL (Supabase etc.) --------------------------------
  // Same device-file pattern as the model key: <COGNOS_DATA_DIR>/database_url.txt
  // (written by the APK boot page or the Settings page below). entry.mjs reads
  // it at boot; when set, server/localdb.js skips the on-device PGlite database
  // entirely and db.js connects to the external Postgres with the regular pg
  // driver. Takes effect immediately: the lazy pool is reset so the next query
  // connects to the new URL (schema migrates itself, IF NOT EXISTS).
  app.get("/api/settings/database-url", wrap(async (req, res) => {
    res.json({
      configured: Boolean(process.env.DATABASE_URL),
      external: Boolean(deviceDbUrlPath() && process.env.DATABASE_URL && !isLocalSocketUrl(process.env.DATABASE_URL)),
      managed: deviceDbUrlPath() ? "device" : "environment",
    });
  }));

  app.post("/api/settings/database-url", wrap(async (req, res) => {
    const urlPath = deviceDbUrlPath();
    if (!urlPath) {
      return res.status(400).json({
        error: "The database URL is managed by the server environment on this install — it can't be changed from Settings.",
      });
    }
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    const problem = validateDatabaseUrl(url);
    if (problem) return res.status(400).json({ error: problem });
    fs.mkdirSync(path.dirname(urlPath), { recursive: true });
    fs.writeFileSync(urlPath, url, { mode: 0o600, encoding: "utf8" });
    process.env.DATABASE_URL = url;
    // Reset the lazy pool so the next query uses the new URL immediately.
    try {
      const { closeDatabase } = await import("../db.js");
      await closeDatabase();
    } catch { /* pool was never created — nothing to reset */ }
    if (logger) logger.info("settings", "database URL updated from Settings page");
    res.json({ ok: true, configured: true });
  }));

  app.delete("/api/settings/database-url", wrap(async (req, res) => {
    const urlPath = deviceDbUrlPath();
    if (!urlPath) {
      return res.status(400).json({
        error: "The database URL is managed by the server environment on this install.",
      });
    }
    try { fs.unlinkSync(urlPath); } catch { /* already absent */ }
    delete process.env.DATABASE_URL;
    try {
      const { closeDatabase } = await import("../db.js");
      await closeDatabase();
    } catch { /* pool was never created — nothing to reset */ }
    if (logger) logger.info("settings", "database URL removed from Settings page");
    res.json({ ok: true, configured: false });
  }));
}

// The PGlite socket server points DATABASE_URL at a local socket path when the
// on-device database is active — that is not an "external" database.
function isLocalSocketUrl(url) {
  return !/^postgres(ql)?:\/\//i.test(url);
}

/**
 * Friendly validation for a user-supplied Postgres connection string, mirroring
 * the hard rules in db.js assertPooledUrl. Returns an error message string, or
 * null when the URL is acceptable.
 */
export function validateDatabaseUrl(url) {
  url = typeof url === "string" ? url.trim() : "";
  if (!url) return "Paste a database connection string first.";
  if (url.length > 2000) return "That URL looks too long to be valid — check for extra characters.";
  if (/^https?:\/\//i.test(url)) {
    return "That looks like an https:// URL. COGNOS needs the postgres:// connection string (Supabase: Project Settings → Database → Connection string).";
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    return "That doesn't look like a Postgres connection string — it should start with postgresql://.";
  }
  return null;
}
