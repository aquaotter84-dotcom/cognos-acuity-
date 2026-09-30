// COGNOS embedded-Node entry point (Android APK).
//
// The Capacitor boot page starts the Node runtime in manual mode and passes
// COGNOS_DATA_DIR (internal storage) + PORT via env. This file applies the
// on-device conveniences, then boots the regular server: server/serve.js
// sees COGNOS_DATA_DIR with no DATABASE_URL and brings up the file-backed
// PGlite database itself (server/localdb.js).

import fs from "node:fs";
import path from "node:path";
import { applyAutonomyDelegationFiles } from "./server/delegation-files.mjs";

// Node 18 (the runtime inside the APK) predates several web globals that
// newer dependencies expect. CustomEvent (used by @electric-sql/pglite-socket)
// landed in Node 19 — polyfill it on top of the Event global (present since
// Node 15) before anything else loads.
if (typeof globalThis.CustomEvent === "undefined" && typeof globalThis.Event !== "undefined") {
  class CustomEvent extends globalThis.Event {
    constructor(type, params = {}) {
      super(type, params);
      this.detail = params.detail;
    }
  }
  globalThis.CustomEvent = CustomEvent;
}

const dataDir = process.env.COGNOS_DATA_DIR;

// On-device boot log: timestamped lines appended to $COGNOS_DATA_DIR/boot.log
// (reset each launch) so the boot page can show what happened if the server
// never comes up. Logging must never break boot.
const bootLogPath = dataDir ? path.join(dataDir, "boot.log") : null;
function bootLog(line) {
  if (!bootLogPath) return;
  try {
    fs.mkdirSync(path.dirname(bootLogPath), { recursive: true });
    fs.appendFileSync(bootLogPath, new Date().toISOString() + " " + line + "\n");
  } catch { /* never break boot for logging */ }
}
// Serialize a thrown value so the on-device boot.log captures the real
// failure (name/message/code/errno/stack) instead of the useless literal
// "[object Object]" that String(err) produces for non-Error throws.
function fmtErr(err) {
  if (err == null) return String(err);
  if (typeof err === "object") {
    const out = {
      name: err.name,
      message: err.message,
      code: err.code,
      errno: err.errno,
      stack: err.stack,
    };
    for (const k of Object.keys(err)) {
      if (!(k in out)) {
        try {
          out[k] = err[k];
        } catch { /* unreadable property — skip */ }
      }
    }
    try {
      return JSON.stringify(out);
    } catch { /* fall through */ }
  }
  return String((err && err.stack) || err);
}
if (bootLogPath) {
  try {
    fs.mkdirSync(path.dirname(bootLogPath), { recursive: true });
    // Rotate: keep up to two previous launches' logs (boot.prev.log,
    // boot.prev2.log). If the app was killed during startup ("keeps
    // stopping"), the evidence survives this relaunch and the boot page
    // can show it instead of it being wiped here.
    try {
      const dir = path.dirname(bootLogPath);
      const prev = path.join(dir, "boot.prev.log");
      const prev2 = path.join(dir, "boot.prev2.log");
      if (fs.existsSync(bootLogPath)) {
        if (fs.existsSync(prev)) fs.renameSync(prev, prev2);
        fs.renameSync(bootLogPath, prev);
      }
    } catch { /* rotation is best-effort */ }
    fs.writeFileSync(
      bootLogPath,
      new Date().toISOString() + " entry: boot, node " + process.version +
        ", platform=" + process.platform + ", cwd=" + process.cwd() + "\n"
    );
  } catch { /* never break boot for logging */ }
}
process.on("uncaughtException", (err) => {
  bootLog("UNCAUGHT " + fmtErr(err));
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  bootLog("UNHANDLED_REJECTION " + fmtErr(err));
  // Fail fast like uncaughtException: a half-booted process with no server
  // is indistinguishable from "still loading" to the boot page. Exiting now
  // lets the boot page's fail-fast scan show the logged error immediately.
  process.exit(1);
});

if (dataDir) {
  // Optional: a file named bluesminds_api_key.txt in the data dir provides
  // the model gateway key without rebuilding the APK (e.g. via adb push).
  if (!process.env.BLUESMINDS_API_KEY && !process.env.OPENAI_API_KEY) {
    const keyFile = path.join(dataDir, "bluesminds_api_key.txt");
    try {
      const key = fs.readFileSync(keyFile, "utf8").trim();
      if (key) process.env.BLUESMINDS_API_KEY = key;
    } catch { /* absent — model calls will fail until a key is provided */ }
  }
  bootLog("entry: key file " + (process.env.BLUESMINDS_API_KEY ? "present" : "absent"));
  // Optional: bluesminds_api_url.txt overrides the AI provider base URL
  // (e.g. Gemini's OpenAI-compatible endpoint). Written by the Settings page.
  if (!process.env.BLUESMINDS_API_URL && !process.env.OPENAI_BASE_URL) {
    const baseUrlFile = path.join(dataDir, "bluesminds_api_url.txt");
    try {
      const baseUrl = fs.readFileSync(baseUrlFile, "utf8").trim();
      if (baseUrl) process.env.BLUESMINDS_API_URL = baseUrl;
    } catch { /* absent — the built-in default is used */ }
  }
  bootLog("entry: base URL file " + (process.env.BLUESMINDS_API_URL ? "present" : "absent"));
  // Optional: cognos_model.txt overrides the model id. Written by the
  // Settings page.
  if (!process.env.COGNOS_MODEL && !process.env.OPENAI_MODEL) {
    const modelFile = path.join(dataDir, "cognos_model.txt");
    try {
      const model = fs.readFileSync(modelFile, "utf8").trim();
      if (model) process.env.COGNOS_MODEL = model;
    } catch { /* absent — the built-in default is used */ }
  }
  bootLog("entry: model file " + (process.env.COGNOS_MODEL ? "present" : "absent"));
  // Optional: autonomy switch delegation files (see server/delegation-files.mjs).
  // On a phone there is no operator shell, so the Autonomy page hands its own
  // switches over by writing these files; they take effect here, at boot — an
  // env var already set keeps winning, and handing a switch over needs the app
  // to be closed and reopened.
  const delegatedSwitches = applyAutonomyDelegationFiles(dataDir);
  bootLog("entry: autonomy delegation " + (delegatedSwitches.length ? delegatedSwitches.join(",") : "none"));
  // Optional: database_url.txt points the server at an external Postgres
  // (e.g. Supabase) instead of the on-device PGlite database. When set,
  // server/localdb.js skips PGlite entirely — no WASM engine load, no ~1GB
  // memory spike on boot. Written by the boot page / Settings page; also
  // settable via adb push without rebuilding the APK.
  if (!process.env.DATABASE_URL) {
    const dbUrlFile = path.join(dataDir, "database_url.txt");
    try {
      const dbUrl = fs.readFileSync(dbUrlFile, "utf8").trim();
      if (dbUrl) process.env.DATABASE_URL = dbUrl;
    } catch { /* absent — falls back to the on-device database */ }
  }
  bootLog("entry: database " + (process.env.DATABASE_URL ? "external (DATABASE_URL set)" : "on-device (PGlite)"));
}

bootLog("entry: loading server/serve.js");
try {
  await import("./server/serve.js");
  bootLog("entry: serve.js loaded");
} catch (err) {
  bootLog("entry: serve.js failed: " + fmtErr(err));
  throw err;
}
