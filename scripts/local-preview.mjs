#!/usr/bin/env node
// scripts/local-preview.mjs — dev-only preview runner.
//
// Boots the real app (server/index.js via server/serve.js) against an embedded
// PGlite Postgres instead of requiring a Neon DATABASE_URL. Same SQL, same
// schema, same routes — a zero-config way to click through the app locally.
// NOT part of the deployment path: production reads DATABASE_URL as before.
//
//     node scripts/local-preview.mjs [port]
//
// Optionally point GOOGLE_CLIENT_ID/SECRET at anything to see the sign-in
// button configuration state; real Google sign-in still needs real credentials.

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.argv[2] || process.env.PORT || 3000);

const pglite = new PGlite();
await pglite.waitReady;
const socket = new PGLiteSocketServer({ db: pglite, port: 0, host: "127.0.0.1", maxConnections: 24 });
await socket.start();
// Mirror the harness: read the OS-assigned port back off the socket server.
const pgPort = socket.getServerConn
  ? Number(String(socket.getServerConn()).match(/:(\d+)$/)?.[1] || 0)
  : 0;
if (!pgPort) throw new Error("PGlite socket server did not report a port");
process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${pgPort}/postgres?sslmode=disable`;
process.env.COGNOS_SEARCH_ENABLED = process.env.COGNOS_SEARCH_ENABLED || "false";
process.env.PORT = String(port);

console.log(JSON.stringify({ level: "info", component: "local-preview", message: `PGlite on 127.0.0.1:${pgPort}; app on :${port}` }));

await import("../server/serve.js");

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    try { await socket.stop(); await pglite.close(); } catch { /* exiting anyway */ }
    process.exit(0);
  });
}
