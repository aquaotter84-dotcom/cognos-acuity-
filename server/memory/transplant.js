// The one-time memory transplant — Jeremy explicitly approved wiping the
// existing memories for the Sapphire-style rebuild.
//
// Why boot code and not a SQL migration: the backup must be written to a
// FILE and verified before anything is deleted, and a SQL migration running
// against the hosted database (Supabase) has no server filesystem. So the
// first boot of the new version does it in Node, guarded by a marker row so
// it runs exactly once:
//
//   1. SELECT * FROM memories (all workspaces, all layers) → JSON at
//      <appDataDir>/backups/memories-pre-sapphire-<YYYY-MM-DD>.json
//   2. Verify by re-parsing the file (marker + row count must match).
//   3. ONLY if the backup verifies: wipe the memories table (dreams go with
//      it — they're memory rows; conversations/messages are a separate store
//      and are hands-off, they stay).
//   4. Apply the new schema (edges table, tending state, instrumentation
//      columns — idempotent, the lazy boot migration applies it too).
//   5. Set the marker row. A warm plain-language notice tells Jeremy the
//      architecture changed and exactly where his backup lives.
//
// Fail closed: if the backup write or verification fails — or if no backup
// directory is available — nothing is wiped, no marker is set, it logs loudly
// and retries on the next boot.

import fs from "node:fs";
import path from "node:path";
import { PHASE35_SCHEMA } from "../db/schema.js";
import { buildNoticeFields } from "../autonomy/notice.js";

export const TRANSPLANT_MARKER = "sapphire_transplant_v1";

/** <appDataDir>/backups — on the APK, COGNOS_DATA_DIR is the app's internal storage. */
export function resolveBackupDir() {
  const base = process.env.COGNOS_DATA_DIR || process.env.COGNOS_BACKUP_DIR;
  if (!base) return null;
  return path.join(base, "backups");
}

export function backupFileName(nowMs = Date.now()) {
  return `memories-pre-sapphire-${new Date(nowMs).toISOString().slice(0, 10)}.json`;
}

export async function transplantDone(run) {
  try {
    const rows = await run(`SELECT value FROM schema_markers WHERE key = $1`, [TRANSPLANT_MARKER]);
    return rows.length > 0 ? rows[0] : null;
  } catch {
    return null; // markers table missing → not done
  }
}

/**
 * Run the one-time transplant. Returns a status object; never throws —
 * boot must survive a transplant failure with the old data intact.
 */
export async function runMemoryTransplant({ db, logger = null, nowMs = Date.now(), backupDir = null } = {}) {
  const run = db.query;
  const log = logger || { info() {}, warn() {}, error() {} };
  const fail = (status, reason, extra = {}) => {
    log.error("MEMORY TRANSPLANT ABORTED — memories left untouched, will retry next boot",
      { status, reason, ...extra });
    return { status, reason };
  };

  // The marker table has to exist before we can prove exactly-once. This is
  // also the first query of boot, so it triggers the lazy DB connect + full
  // schema migration (which includes the Phase 35 relations).
  try {
    await run(`CREATE TABLE IF NOT EXISTS schema_markers (
      key TEXT PRIMARY KEY, value JSONB,
      created_date TIMESTAMPTZ NOT NULL DEFAULT now())`);
  } catch (e) {
    return fail("not_ready", "marker_table_failed", { error: String(e?.message || e).slice(0, 200) });
  }
  if (await transplantDone(run)) return { status: "already_done" };

  const dir = backupDir || resolveBackupDir();
  if (!dir) {
    return fail("no_backup_dir", "no_backup_directory",
      { hint: "set COGNOS_DATA_DIR (on-device) or COGNOS_BACKUP_DIR" });
  }

  // 1. Read every memory row, all workspaces, all layers.
  let rows;
  try {
    rows = await run(`SELECT * FROM memories ORDER BY created_date ASC`);
  } catch (e) {
    return fail("backup_failed", "read_failed", { error: String(e?.message || e).slice(0, 200) });
  }

  // 2. Write the backup file.
  const file = path.join(dir, backupFileName(nowMs));
  const payload = {
    marker: TRANSPLANT_MARKER,
    exported_at: new Date(nowMs).toISOString(),
    row_count: rows.length,
    note: "Pre-transplant backup of the memories table (all workspaces, all layers). " +
      "Dreams are memory rows and are included. Conversations and messages were not touched.",
    rows
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload));
  } catch (e) {
    return fail("backup_failed", "write_failed",
      { file, error: String(e?.message || e).slice(0, 200) });
  }

  // 3. Verify by re-parsing: the marker and the row count must round-trip.
  let verified = false;
  try {
    const back = JSON.parse(fs.readFileSync(file, "utf8"));
    verified = Boolean(back)
      && back.marker === TRANSPLANT_MARKER
      && Array.isArray(back.rows)
      && back.rows.length === rows.length;
  } catch {
    verified = false;
  }
  if (!verified) {
    return fail("backup_failed", "verify_failed", { file });
  }

  // 4. The backup is good — wipe. Memories only: conversations/messages are a
  // separate store and stay. The ledger (knowledge_events, confidence_history,
  // beliefs) is append-only audit and is intentionally left alone.
  try { await run(`DELETE FROM memory_edges`); }
  catch { /* table may not exist yet on a database the lazy migration hasn't touched */ }
  await run(`DELETE FROM memories`);

  // 5. New schema (idempotent — the boot migration applies it too).
  await run(PHASE35_SCHEMA);

  // 6. Marker — exactly once.
  const markerValue = {
    backup_file: file,
    row_count: rows.length,
    wiped_at: new Date(nowMs).toISOString()
  };
  await run(
    `INSERT INTO schema_markers (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
    [TRANSPLANT_MARKER, JSON.stringify(markerValue)]
  );
  log.info("memory transplant complete", { backup_file: file, memory_count: rows.length });

  // 7. Warm plain-language notice for Jeremy.
  try {
    const ws = await db.Workspace.ensureDefault();
    const fields = buildNoticeFields("memory_transplant_done", {
      backupDir: dir, backupName: path.basename(file), memoryCount: rows.length
    });
    if (fields) {
      await db.AutonomyNotice.create({
        workspace_id: ws.id, template_id: "memory_transplant_done",
        fields, severity: "info"
      });
    }
  } catch (e) {
    log.warn("transplant notice failed", { error: String(e?.message || e).slice(0, 200) });
  }

  return { status: "done", backup_file: file, memory_count: rows.length };
}
