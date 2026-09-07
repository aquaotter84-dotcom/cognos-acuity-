// Test harness only — NOT part of the app.
//
// A real Postgres for the smoke run. The sandbox has no postgres binary and no
// apt network, so the harness boots PGlite (Postgres compiled to WASM) behind
// its wire-protocol socket server. server/db.js connects to it with the ordinary
// `pg` driver, exactly as it would to Neon: same SQL, same transactions, same
// JSONB, no production code changes and no test-only branch inside db.js.
//
// Usage:
//   const db = await startPglite();          // db.url, db.stop()
//   process.env.DATABASE_URL = db.url;

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export async function startPglite({ port = 0, host = "127.0.0.1", maxConnections = 16 } = {}) {
  const pglite = new PGlite();
  await pglite.waitReady;
  const server = new PGLiteSocketServer({ db: pglite, port, host, maxConnections });
  await server.start();
  // port 0 -> the OS picked one; read it back off the underlying net server.
  const boundPort = server.getServerConn ? Number(String(server.getServerConn()).match(/:(\d+)$/)?.[1] || port) : port;
  const url = `postgresql://postgres@${host}:${boundPort || port}/postgres?sslmode=disable`;
  return {
    url,
    port: boundPort || port,
    pglite,
    async stop() {
      try { await server.stop(); } catch { /* already down */ }
      try { await pglite.close(); } catch { /* already down */ }
    }
  };
}
