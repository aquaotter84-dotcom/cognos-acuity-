// On-device database boot: file-backed PGlite via server/localdb.js.
//
// Boots with COGNOS_DATA_DIR set, writes a row through the real db layer,
// then confirms the dataDir landed on disk — the Android persistence story.
// Also pins the two inertness guarantees: untouched when COGNOS_DATA_DIR is
// unset, and untouched when DATABASE_URL is already set (server deploys).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognos-localdb-"));
const quiet = { info() {}, warn() {}, error() {}, child() { return quiet; } };
let pass = 0;
function ok(cond, name) {
  if (!cond) { console.error("FAIL:", name); process.exit(1); }
  pass++;
  console.log("ok:", name);
}

const { bootLocalDatabase } = await import("../server/localdb.js");

// 1. inert without COGNOS_DATA_DIR
delete process.env.DATABASE_URL;
delete process.env.COGNOS_DATA_DIR;
ok((await bootLocalDatabase(quiet)) === false, "inert when COGNOS_DATA_DIR unset");
ok(!process.env.DATABASE_URL, "DATABASE_URL untouched when inert");

// 2. boots and points DATABASE_URL at loopback PGlite
process.env.COGNOS_DATA_DIR = dir;
ok(await bootLocalDatabase(quiet), "boots local database");
ok(
  /^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/postgres/.test(process.env.DATABASE_URL || ""),
  "DATABASE_URL points at local PGlite"
);

// 3. the real db layer works against it (lazy schema + write + read)
const db = (await import("../server/db.js")).default;
await db.query(
  "INSERT INTO workspaces (id, name) VALUES ('ws_localdb_t', 'localdb probe') ON CONFLICT (id) DO NOTHING"
);
const rows = await db.query("SELECT name FROM workspaces WHERE id='ws_localdb_t'");
ok(rows.length === 1 && rows[0].name === "localdb probe", "write+read through server/db.js");

// 4. files landed on disk (this is what survives reinstalls/restarts)
ok(fs.existsSync(path.join(dir, "pglite", "PG_VERSION")), "pglite dataDir persisted to disk");

// 5. inert when DATABASE_URL already set (server deploy path untouched)
const before = process.env.DATABASE_URL;
ok((await bootLocalDatabase(quiet)) === false, "inert when DATABASE_URL already set");
ok(process.env.DATABASE_URL === before, "existing DATABASE_URL preserved");

console.log(`localdb: ${pass} checks passed`);
process.exit(0);
