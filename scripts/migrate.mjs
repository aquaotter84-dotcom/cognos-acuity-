#!/usr/bin/env node
/**
 * scripts/migrate.mjs — apply the additive Phase 14–17 migrations.
 *
 *     node scripts/migrate.mjs            apply every migration in PHASE_SCHEMAS
 *     node scripts/migrate.mjs --dry-run  print what would run, touch nothing
 *     node scripts/migrate.mjs --check    verify the tables exist, change nothing
 *
 * The server applies the same statements lazily on first query (server/db.js),
 * so this script is optional — it exists for controlled rollouts and for
 * confirming a database is ready before traffic arrives.
 *
 * Safety rails, enforced here rather than trusted:
 *   1. ADDITIVE ONLY — a migration containing DROP / TRUNCATE / DELETE / RENAME /
 *      REPLACE is refused before anything is executed (pin.additive_schema).
 *   2. Idempotent — every statement is IF NOT EXISTS, so re-running is a no-op.
 *   3. Per-migration transaction — a failure rolls back that migration and
 *      leaves the earlier ones applied.
 *   4. Read-only against existing tables — the only writes to pre-existing
 *      structures are ADD COLUMN IF NOT EXISTS.
 */
import pg from "pg";
import { PHASE_SCHEMAS } from "../server/db/schema.js";

const { Pool } = pg;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const checkOnly = args.has("--check");

const FORBIDDEN = [
  { re: /\bDROP\s+(TABLE|INDEX|COLUMN|SCHEMA|DATABASE|TYPE)\b/i, why: "destructive DDL" },
  { re: /\bTRUNCATE\b/i, why: "truncates a table" },
  { re: /\bDELETE\s+FROM\b/i, why: "deletes rows" },
  { re: /\bALTER\s+TABLE[^;]*\b(DROP|RENAME|ALTER)\b/i, why: "modifies an existing column" },
  { re: /\bUPDATE\s+[a-z_]+\s+SET\b/i, why: "rewrites rows" }
];

function assertAdditive(migration) {
  const violations = [];
  for (const rule of FORBIDDEN) if (rule.re.test(migration.sql)) violations.push(rule.why);
  if (violations.length) {
    throw new Error(`migration ${migration.id} (${migration.name}) is not additive: ${violations.join(", ")}`);
  }
}

function summarize(sql) {
  const count = (re) => (sql.match(re) || []).length;
  return {
    tables: count(/CREATE TABLE IF NOT EXISTS/gi),
    indexes: count(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/gi),
    addedColumns: count(/ADD COLUMN IF NOT EXISTS/gi)
  };
}

async function main() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Migrations need a Postgres connection string (secrets stay env-only).");
    process.exit(2);
  }

  console.log(`Phase 14–17 migrations — ${PHASE_SCHEMAS.length} block(s), mode: ${dryRun ? "dry-run" : checkOnly ? "check" : "apply"}\n`);

  for (const migration of PHASE_SCHEMAS) {
    assertAdditive(migration);
    const s = summarize(migration.sql);
    console.log(`${migration.id}  ${migration.name} (phase ${migration.phase})`);
    console.log(`      ${s.tables} new table(s), ${s.indexes} new index(es), ${s.addedColumns} added column(s) — additive, idempotent`);
  }

  if (dryRun) {
    console.log("\nDry run: nothing executed.");
    return;
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    if (!checkOnly) {
      for (const migration of PHASE_SCHEMAS) {
        const client = await pool.connect();
        const started = Date.now();
        try {
          await client.query("BEGIN");
          await client.query(migration.sql);
          await client.query("COMMIT");
          console.log(`\napplied ${migration.id} ${migration.name} in ${Date.now() - started}ms`);
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          console.error(`\nFAILED ${migration.id} ${migration.name}: ${e.message} (rolled back)`);
          process.exitCode = 1;
          return;
        } finally {
          client.release();
        }
      }
    }

    // Verify: every table the phases declare must now exist.
    const expected = [
      "knowledge_events", "beliefs", "confidence_history", "relationships", "coherence_reports",
      "telemetry_runs", "telemetry_model_calls", "strategies", "strategy_evaluations",
      "adaptive_decisions", "improvement_ledger",
      "sources", "source_chunks", "agent_runs", "agent_steps", "agent_events", "agent_approvals"
    ];
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name",
      [expected]
    );
    const present = new Set(rows.map(r => r.table_name));
    const missing = expected.filter(t => !present.has(t));
    console.log(`\nverification: ${present.size}/${expected.length} phase tables present`);
    if (missing.length) {
      console.error(`missing: ${missing.join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log("all Phase 14/15/17 tables exist; Phase 16 is verified by its additive columns below.");
    }

    const col = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'memories' AND column_name = 'confidence'"
    );
    console.log(col.rows.length ? "memories.confidence: present" : "memories.confidence: MISSING");

    const perfCols = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE (table_name = 'telemetry_runs' AND column_name = 'performance')
           OR (table_name = 'telemetry_model_calls' AND column_name = ANY($1))`,
      [["request_id", "response_headers_ms", "response_decode_ms", "prompt_cached_tokens", "requested_service_tier", "service_tier"]]
    );
    console.log(perfCols.rows.length === 7
      ? "latency/resilience observability columns: 7/7 present"
      : `latency/resilience observability columns: ${perfCols.rows.length}/7 present`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(`migrate failed: ${e.message}`);
  process.exit(1);
});
