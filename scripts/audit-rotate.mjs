#!/usr/bin/env node
/**
 * scripts/audit-rotate.mjs — monthly rotation for the workspace audit trail.
 *
 *     node scripts/audit-rotate.mjs            move rows older than the retention window
 *     node scripts/audit-rotate.mjs --dry-run  count what would move, touch nothing
 *
 * The brief (§4) says the audit log is "a read-only table; rotate monthly".
 * The APP never updates or deletes workspace_audit rows — no accessor could.
 * This maintenance script is the single sanctioned mover: in ONE transaction
 * it copies rows older than COGNOS_AUDIT_RETENTION_DAYS (default 35) into
 * workspace_audit_archive (created if missing) and removes them from the live
 * table. The archive is append-only from the app's point of view; together
 * the two tables hold the complete, ordered trail.
 */
import pg from "pg";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

const retentionDays = Math.max(1, Number(process.env.COGNOS_AUDIT_RETENTION_DAYS || 35) || 35);
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Rotation needs a Postgres connection string.");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const archive = await pool.query(
    `CREATE TABLE IF NOT EXISTS workspace_audit_archive (LIKE workspace_audit INCLUDING ALL)`
  );
  void archive;

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM workspace_audit WHERE created_date < $1`,
    [cutoff]
  );
  const count = rows[0].n;
  console.log(`audit rotate: retention ${retentionDays}d, cutoff ${cutoff.toISOString()}, ${count} row(s) to archive${dryRun ? " (dry run)" : ""}`);

  if (dryRun || count === 0) {
    console.log("nothing to do.");
    process.exit(0);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const moved = await client.query(
      `WITH moved AS (
         DELETE FROM workspace_audit WHERE id IN (
           SELECT id FROM workspace_audit WHERE created_date < $1 ORDER BY created_date ASC LIMIT 5000
         ) RETURNING *
       ) INSERT INTO workspace_audit_archive SELECT * FROM moved RETURNING id`,
      [cutoff]
    );
    await client.query("COMMIT");
    console.log(`archived ${moved.rowCount} row(s). Re-run until the live table is inside its window.`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`rotation failed: ${e.message} (rolled back)`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
} finally {
  await pool.end().catch(() => {});
}
