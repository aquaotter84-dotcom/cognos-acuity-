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
}

await import("./server/serve.js");
