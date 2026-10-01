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
import { diagnoseAiConnection, DIAGNOSE_DEFAULT_BASE_URL } from "../ai-diagnose.js";
import { resolveModel } from "../llm.js";
import { envFlag } from "../autonomy/settings.js";
import {
  AUTONOMY_DELEGATION_FILES,
  delegationEntry,
  readDelegationFile,
} from "../delegation-files.mjs";

const KEY_FILE = "bluesminds_api_key.txt";
const DB_URL_FILE = "database_url.txt";
const BASE_URL_FILE = "bluesminds_api_url.txt";
const MODEL_FILE = "cognos_model.txt";

function deviceKeyPath() {
  const dir = process.env.COGNOS_DATA_DIR;
  return dir ? path.join(dir, KEY_FILE) : null;
}

function deviceDbUrlPath() {
  const dir = process.env.COGNOS_DATA_DIR;
  return dir ? path.join(dir, DB_URL_FILE) : null;
}

function deviceBaseUrlPath() {
  const dir = process.env.COGNOS_DATA_DIR;
  return dir ? path.join(dir, BASE_URL_FILE) : null;
}

function deviceModelPath() {
  const dir = process.env.COGNOS_DATA_DIR;
  return dir ? path.join(dir, MODEL_FILE) : null;
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

  // Staged AI-connection self-test: replays the model provider connection in
  // observable stages (key sanity, DNS, TCP, TLS, HTTPS) so a failing stage
  // names the real cause. Never returns key material — see server/ai-diagnose.js.
  app.get("/api/settings/diagnose-ai", wrap(async (req, res) => {
    const result = await diagnoseAiConnection();
    res.json(result);
  }));

  // AI provider base URL. Points COGNOS at any OpenAI-compatible endpoint —
  // e.g. Gemini's https://generativelanguage.googleapis.com/v1beta/openai
  // (llm.js appends /chat/completions, which is exactly Gemini's documented
  // path). Stored in bluesminds_api_url.txt on-device (mode 600); llm.js reads
  // BLUESMINDS_API_URL from process.env on every call, so updating both the
  // file and the env var takes effect immediately. The URL is not secret, so
  // GET returns it. An empty POST (or DELETE) resets to the built-in default.
  app.get("/api/settings/model-base-url", wrap(async (req, res) => {
    res.json({
      configured: Boolean(process.env.BLUESMINDS_API_URL || process.env.OPENAI_BASE_URL),
      value: process.env.BLUESMINDS_API_URL || process.env.OPENAI_BASE_URL || DIAGNOSE_DEFAULT_BASE_URL,
      isDefault: !process.env.BLUESMINDS_API_URL && !process.env.OPENAI_BASE_URL,
      managed: deviceBaseUrlPath() ? "device" : "environment",
    });
  }));

  app.post("/api/settings/model-base-url", wrap(async (req, res) => {
    const urlPath = deviceBaseUrlPath();
    if (!urlPath) {
      return res.status(400).json({
        error: "The provider base URL is managed by the server environment on this install — it can't be changed from Settings.",
      });
    }
    const raw = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!raw) {
      try { fs.unlinkSync(urlPath); } catch { /* already absent */ }
      delete process.env.BLUESMINDS_API_URL;
      if (logger) logger.info("settings", "provider base URL reset to default from Settings page");
      return res.json({ ok: true, reset: true, value: DIAGNOSE_DEFAULT_BASE_URL });
    }
    const problem = validateBaseUrl(raw);
    if (problem) return res.status(400).json({ error: problem });
    const url = normalizeBaseUrl(raw);
    fs.mkdirSync(path.dirname(urlPath), { recursive: true });
    fs.writeFileSync(urlPath, url, { mode: 0o600, encoding: "utf8" });
    process.env.BLUESMINDS_API_URL = url;
    if (logger) logger.info("settings", "provider base URL updated from Settings page");
    res.json({ ok: true, value: url });
  }));

  app.delete("/api/settings/model-base-url", wrap(async (req, res) => {
    const urlPath = deviceBaseUrlPath();
    if (!urlPath) {
      return res.status(400).json({
        error: "The provider base URL is managed by the server environment on this install.",
      });
    }
    try { fs.unlinkSync(urlPath); } catch { /* already absent */ }
    delete process.env.BLUESMINDS_API_URL;
    if (logger) logger.info("settings", "provider base URL reset to default from Settings page");
    res.json({ ok: true, reset: true, value: DIAGNOSE_DEFAULT_BASE_URL });
  }));

  // AI model id. Same on-device pattern (cognos_model.txt, mode 600 →
  // COGNOS_MODEL); llm.js resolves the model per call via resolveModel(), so
  // changes apply immediately. Not secret — GET returns it. Empty POST (or
  // DELETE) resets to the built-in default. Switching providers usually means
  // switching the model too (e.g. gemini-2.0-flash for Gemini).
  app.get("/api/settings/model-id", wrap(async (req, res) => {
    res.json({
      configured: Boolean(process.env.COGNOS_MODEL || process.env.OPENAI_MODEL),
      value: resolveModel(),
      isDefault: !process.env.COGNOS_MODEL && !process.env.OPENAI_MODEL,
      managed: deviceModelPath() ? "device" : "environment",
    });
  }));

  app.post("/api/settings/model-id", wrap(async (req, res) => {
    const modelPath = deviceModelPath();
    if (!modelPath) {
      return res.status(400).json({
        error: "The model id is managed by the server environment on this install — it can't be changed from Settings.",
      });
    }
    const raw = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (!raw) {
      try { fs.unlinkSync(modelPath); } catch { /* already absent */ }
      delete process.env.COGNOS_MODEL;
      if (logger) logger.info("settings", "model id reset to default from Settings page");
      return res.json({ ok: true, reset: true, value: resolveModel() });
    }
    const problem = validateModelId(raw);
    if (problem) return res.status(400).json({ error: problem });
    fs.mkdirSync(path.dirname(modelPath), { recursive: true });
    fs.writeFileSync(modelPath, raw, { mode: 0o600, encoding: "utf8" });
    process.env.COGNOS_MODEL = raw;
    if (logger) logger.info("settings", "model id updated from Settings page");
    res.json({ ok: true, value: raw });
  }));

  app.delete("/api/settings/model-id", wrap(async (req, res) => {
    const modelPath = deviceModelPath();
    if (!modelPath) {
      return res.status(400).json({
        error: "The model id is managed by the server environment on this install.",
      });
    }
    try { fs.unlinkSync(modelPath); } catch { /* already absent */ }
    delete process.env.COGNOS_MODEL;
    if (logger) logger.info("settings", "model id reset to default from Settings page");
    res.json({ ok: true, reset: true, value: resolveModel() });
  }));

  // --- Switch delegation (on-device operator handover) -----------------------
  // The *_UI_CONTROL env vars hand the switches to the UI
  // (server/autonomy/settings.js for the five autonomy switches,
  // server/council/settings.js for the council switches). On a phone there is
  // no operator shell, so the page hands them to itself: writing the delegation
  // file ("true", mode 600) delegates, deleting it takes the switch back.
  // mobile/entry.mjs reads the files at boot, so a handover takes effect when
  // the app is closed and reopened; an env var already set (a real operator)
  // keeps winning and outranks the file. Delegation names a capability, not a
  // secret, so GET reports which switches are handed over.
  app.get("/api/settings/autonomy-delegation", wrap(async (req, res) => {
    res.json({
      // "device": the delegation files live in app-internal storage and can be
      // changed here. "environment": a server deploy — managed by env vars.
      managed: process.env.COGNOS_DATA_DIR ? "device" : "environment",
      switches: process.env.COGNOS_DATA_DIR
        ? AUTONOMY_DELEGATION_FILES.map(delegationSwitchState)
        : [],
    });
  }));

  app.post("/api/settings/autonomy-delegation", wrap(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const entry = delegationEntry(name);
    if (!entry) {
      return res.status(400).json({ error: `Unknown switch "${name.slice(0, 40)}". Nothing was changed.` });
    }
    const filePath = deviceDelegationPath(entry);
    if (!filePath) {
      return res.status(400).json({
        error: "Switch delegation is managed by the server environment on this install — it can't be changed from this page.",
      });
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "true\n", { mode: 0o600, encoding: "utf8" });
    if (logger) logger.info("settings", `switch handed over: ${entry.name}`);
    res.json({
      ok: true,
      name: entry.name,
      restartRequired: true,
      switches: AUTONOMY_DELEGATION_FILES.map(delegationSwitchState),
    });
  }));

  app.delete("/api/settings/autonomy-delegation", wrap(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const entry = delegationEntry(name);
    if (!entry) {
      return res.status(400).json({ error: `Unknown switch "${name.slice(0, 40)}". Nothing was changed.` });
    }
    const filePath = deviceDelegationPath(entry);
    if (!filePath) {
      return res.status(400).json({
        error: "Switch delegation is managed by the server environment on this install.",
      });
    }
    try { fs.unlinkSync(filePath); } catch { /* already absent */ }
    if (logger) logger.info("settings", `switch taken back: ${entry.name}`);
    res.json({
      ok: true,
      name: entry.name,
      restartRequired: true,
      switches: AUTONOMY_DELEGATION_FILES.map(delegationSwitchState),
    });
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

/**
 * Friendly validation for a user-supplied AI provider base URL (any
 * OpenAI-compatible endpoint). Returns an error message string, or null when
 * the URL is acceptable. Empty input is not an error here — the route treats
 * it as "reset to the built-in default".
 */
export function validateBaseUrl(url) {
  url = typeof url === "string" ? url.trim() : "";
  if (!url) return "Paste a provider base URL first, or clear the field to go back to the default.";
  if (url.length > 200) return "That URL looks too long to be valid — check for extra characters.";
  if (!/^https:\/\//i.test(url)) {
    return "The base URL must start with https:// — for example https://generativelanguage.googleapis.com/v1beta/openai";
  }
  return null;
}

/** Normalize a validated base URL: trim and strip trailing slashes (llm.js
 *  appends /chat/completions itself). */
export function normalizeBaseUrl(url) {
  return String(url).trim().replace(/\/+$/, "");
}

/**
 * Friendly validation for a user-supplied model id. Returns an error message
 * string, or null when the id is acceptable. Empty input is not an error here
 * — the route treats it as "reset to the built-in default".
 */
export function validateModelId(model) {
  model = typeof model === "string" ? model.trim() : "";
  if (!model) return "Type a model id first, or clear the field to go back to the default.";
  if (model.length > 100) return "That model id looks too long to be valid — check for extra characters.";
  if (!/^[A-Za-z0-9.:/_-]+$/.test(model)) {
    return "Model ids may only contain letters, numbers, and . : / _ - characters.";
  }
  return null;
}

/**
 * Plain-language labels for the five delegatable switches, for the Autonomy
 * page's handover panel. The outbox entry says the consequential part out
 * loud: this is the switch that lets the loop act on the world.
 */
const DELEGATION_LABELS = Object.freeze({
  autonomy: {
    label: "The on/off switch",
    cta: "Hand me the on/off switch",
    blurb: "Lets this page turn the autonomy loop on and off. The loop still stages everything for your approval — the switch only decides whether it wakes at all.",
  },
  rungs: {
    label: "The rung switches",
    cta: "Hand me the rung switches",
    blurb: "Decides which tiers exist here — what COGNOS may reach for. Opening a rung never approves an action by itself.",
  },
  auto_authorize: {
    label: "The auto-authorize switch",
    cta: "Hand me the auto-authorize switch",
    blurb: "Lets this page choose whether a new goal waits for your approval before it runs, or starts on its own.",
  },
  bypass_earning: {
    label: "The corpus-bypass switch",
    cta: "Hand me the corpus-bypass switch",
    blurb: "Lets this page choose whether a live release must first earn its way past the recorded shadow corpus.",
  },
  outbox: {
    label: "The outbox-mode switch",
    cta: "Hand me the outbox-mode switch",
    blurb: "Lets this page choose whether the loop may act on the world. Shadow only records; live performs releases — to the one approved destination, judged one effect at a time.",
  },
  // The council switches live on the Settings → Governance section, not the
  // Autonomy page, but they ride the same handover rails. The handover hands
  // over the toggles ONLY — both seats still rest ON (fail-closed), and an
  // operator pin still outranks everything.
  council: {
    label: "The council switches",
    cta: "Hand me the council switches",
    blurb: "Lets this page turn the Critic and the Governor on and off. Both rest ON — the handover only hands over the switches, never the rest state.",
  },
});

/** One switch's handover state for the GET response (and POST/DELETE echoes). */
function delegationSwitchState(entry) {
  const dir = process.env.COGNOS_DATA_DIR;
  return {
    name: entry.name,
    envVar: entry.env,
    ...DELEGATION_LABELS[entry.name],
    // Effective delegation: a real env var, or a file read at boot (which
    // entry.mjs turned into the env var). False until the restart after a
    // handover — the page says so honestly instead of pretending.
    delegated: envFlag(entry.env, false),
    fileDelegated: dir ? readDelegationFile(dir, entry.file) : false,
  };
}

/** Absolute path of a switch's delegation file, or null on a server deploy. */
function deviceDelegationPath(entry) {
  const dir = process.env.COGNOS_DATA_DIR;
  return dir ? path.join(dir, entry.file) : null;
}
