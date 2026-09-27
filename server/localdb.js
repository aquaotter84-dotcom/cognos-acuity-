// On-device / local-file database boot.
//
// Additive and inert unless BOTH hold:
//   * process.env.DATABASE_URL is unset, and
//   * process.env.COGNOS_DATA_DIR is set (the Android APK sets it to the
//     app's internal-storage data dir before booting the server).
//
// When active, boots PGlite (Postgres compiled to WASM) with a FILE-BACKED
// dataDir inside COGNOS_DATA_DIR, fronts it with the Postgres wire-protocol
// socket server, and points DATABASE_URL at it. server/db.js then connects
// with the ordinary `pg` driver — the same SQL, transactions and JSONB as
// Neon, with zero changes to the data layer. This is the exact pattern the
// test harness (test/pglite.mjs) already proves against the full suite.
//
// Nothing is ever deleted: the dataDir persists across restarts, and the
// schema is created lazily by db.js on first query, same as server deploys.

import fs from "node:fs";
import path from "node:path";

export async function bootLocalDatabase(logger) {
  if (process.env.DATABASE_URL || !process.env.COGNOS_DATA_DIR) return false;
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const dataDir = path.join(process.env.COGNOS_DATA_DIR, "pglite");
  fs.mkdirSync(dataDir, { recursive: true });
  // Pre-flight: first launch copies ~213 MB of engine assets and PGlite
  // writes back a ~39 MB cluster during initdb. Fail fast with an actionable
  // message instead of a cryptic ErrnoError (ENOSPC) from inside PGlite.
  // bavail (not bfree) is the space actually writable by this unprivileged
  // process. A reading of exactly 0 is treated as "unknown" (some sandboxed
  // filesystems report zero) — PGlite is allowed to try, and its properly
  // serialized error will tell the truth if the disk really is full.
  if (typeof fs.statfsSync === "function") {
    try {
      const st = fs.statfsSync(dataDir);
      const freeMiB = Math.floor((Number(st.bavail) * Number(st.bsize)) / 1048576);
      if (freeMiB > 0 && freeMiB < 400) {
        throw new Error(
          "localdb: only " + freeMiB + " MiB free in " + dataDir +
          "; first launch needs ~350 MiB (engine copy + database init). " +
          "Free up phone storage and retry."
        );
      }
    } catch (e) {
      if (e && e.message && e.message.indexOf("localdb: only") === 0) throw e;
      // statfs unavailable or failed — continue and let PGlite try.
    }
  }
  const pglite = new PGlite({ dataDir });
  await pglite.waitReady;
  const pgServer = new PGLiteSocketServer({ db: pglite, port: 0, host: "127.0.0.1", maxConnections: 16 });
  await pgServer.start();
  const connStr = String(pgServer.getServerConn?.() ?? "");
  const port = Number(connStr.match(/:(\d+)$/)?.[1] || 0);
  if (!port) throw new Error("localdb: could not determine the PGlite socket port");
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  logger?.info?.("local PGlite database ready", { dataDir, port });
  return true;
}
