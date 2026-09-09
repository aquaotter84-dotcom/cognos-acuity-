#!/usr/bin/env node
// Operator-invoked, read-only latency report over persisted reasoning telemetry.
// Usage: npm run latency -- --limit=200 [--days=7] [--json]

import db, { closeDatabase } from "../server/db.js";
import { buildLatencyReport, formatLatencyReport } from "../server/meta/latency.js";

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => {
  const raw = args.find(arg => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
  const number = Number(raw);
  return Number.isFinite(number) ? number : fallback;
};

const limit = Math.max(1, Math.min(500, value("limit", 200)));
const days = Math.max(0, value("days", 0));
const sinceMs = days ? Date.now() - days * 24 * 60 * 60 * 1000 : null;

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; the report reads telemetry without modifying it");
  const [workspace] = await db.Workspace.list();
  if (!workspace) throw new Error("No workspace exists; there is no telemetry to report");
  let runs = await db.TelemetryRun.recent({ limit, workspaceId: workspace.id });
  if (sinceMs) runs = runs.filter(run => Number(run.started_ms) >= sinceMs);
  const runIds = runs.map(run => run.id);
  const calls = runIds.length
    ? await db.query("SELECT * FROM telemetry_model_calls WHERE run_id = ANY($1) ORDER BY created_date DESC", [runIds])
    : [];
  const report = buildLatencyReport({ runs, calls });
  console.log(flag("json") ? JSON.stringify(report, null, 2) : formatLatencyReport(report));
} finally {
  await closeDatabase().catch(() => {});
}
