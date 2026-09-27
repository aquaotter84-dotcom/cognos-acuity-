// COGNOS embedded-Node entry point (Android APK).
//
// The Capacitor boot page starts the Node runtime in manual mode and passes
// COGNOS_DATA_DIR (internal storage) + PORT via env. This file applies the
// on-device conveniences, then boots the regular server: server/serve.js
// sees COGNOS_DATA_DIR with no DATABASE_URL and brings up the file-backed
// PGlite database itself (server/localdb.js).

import fs from "node:fs";
import path from "node:path";

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
if (bootLogPath) {
  try {
    fs.mkdirSync(path.dirname(bootLogPath), { recursive: true });
    fs.writeFileSync(
      bootLogPath,
      new Date().toISOString() + " entry: boot, node " + process.version +
        ", platform=" + process.platform + ", cwd=" + process.cwd() + "\n"
    );
  } catch { /* never break boot for logging */ }
}
process.on("uncaughtException", (err) => {
  bootLog("UNCAUGHT " + ((err && err.stack) || err));
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  bootLog("UNHANDLED_REJECTION " + ((err && err.stack) || err));
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
}

bootLog("entry: loading server/serve.js");
try {
  await import("./server/serve.js");
  bootLog("entry: serve.js loaded");
} catch (err) {
  bootLog("entry: serve.js failed: " + ((err && err.stack) || err));
  throw err;
}
