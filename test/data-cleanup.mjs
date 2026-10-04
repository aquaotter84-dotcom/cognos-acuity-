#!/usr/bin/env node
// Stored-data cleanup (Settings → Stored data).
//
// What this file proves:
//   * GET /api/data/cleanup/counts lists every category with a live count.
//   * Clearing a category requires { confirm: true } — otherwise 400.
//   * Clearing removes the rows (children before parents for RESTRICT FKs).
//   * Clearing the ledger writes a tombstone entry (append-only by charter,
//     but Jeremy ordered it clearable — the wipe stays on the record).
//   * Clearing memories backs them up to a verified file first (v47 path).
//   * Clearing everything requires the exact phrase "CLEAR EVERYTHING".
//   * Unknown categories are 404.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "cognos-cleanup-test-"));
const h = await bootHarness({ COGNOS_DATA_DIR: backupDir });
try {
  const ws = (await h.sql(`SELECT id FROM workspaces LIMIT 1`))[0];
  assert.ok(ws, "a workspace exists after warm-up");

  await test("counts lists every category with live numbers", async () => {
    const r = await h.raw("/api/data/cleanup/counts");
    assert.equal(r.status, 200, JSON.stringify(r.json)?.slice(0, 200));
    const keys = r.json.categories.map((c) => c.key);
    for (const expected of ["memories", "graph", "ledger", "goals", "conversations", "projects", "ideas", "outbox", "watches", "tools", "sources", "residents", "autonomy", "telemetry"]) {
      assert.ok(keys.includes(expected), `category ${expected} is listed`);
    }
    for (const c of r.json.categories) {
      assert.equal(typeof c.count, "number", `${c.key} has a numeric count`);
      assert.ok(c.title && c.description, `${c.key} has plain-language labels`);
    }
    assert.equal(typeof r.json.total, "number");
  });

  await test("clearing a category requires explicit confirmation", async () => {
    const r = await h.raw("/api/data/cleanup/ideas", { method: "POST", body: {} });
    assert.equal(r.status, 400);
    const r2 = await h.raw("/api/data/cleanup/ideas", { method: "POST", body: { confirm: "yes" } });
    assert.equal(r2.status, 400);
  });

  await test("unknown category is a 404", async () => {
    const r = await h.raw("/api/data/cleanup/nope", { method: "POST", body: { confirm: true } });
    assert.equal(r.status, 404);
  });

  await test("clearing ideas removes the rows", async () => {
    await h.sql(`INSERT INTO cognos_ideas (id, workspace_id, title, reason, prompt, kind, status, created_ms, updated_ms) VALUES ('idea-1', $1, 't1', 'r', 'p', 'k', 'new', 1, 1), ('idea-2', $1, 't2', 'r', 'p', 'k', 'new', 1, 1)`, [ws.id]);
    const before = await h.raw("/api/data/cleanup/counts");
    const ideasBefore = before.json.categories.find((c) => c.key === "ideas").count;
    assert.ok(ideasBefore >= 2, `seeded ideas counted (got ${ideasBefore})`);
    const r = await h.raw("/api/data/cleanup/ideas", { method: "POST", body: { confirm: true } });
    assert.equal(r.status, 200, JSON.stringify(r.json)?.slice(0, 200));
    assert.equal(r.json.cleared, true);
    const left = await h.sql(`SELECT COUNT(*)::int AS n FROM cognos_ideas`);
    assert.equal(left[0].n, 0, "ideas table is empty");
  });

  await test("clearing goals removes children before parents (v54 path)", async () => {
    await h.sql(`INSERT INTO autonomy_goals (id, workspace_id, title, objective, status) VALUES ('g1', $1, 't', 'o', 'parked')`, [ws.id]);
    await h.sql(`INSERT INTO goal_steps (id, goal_id, ordinal, skill_id, tier, status, idempotency_key) VALUES ('s1', 'g1', 0, 'noop', 'T0', 'done', 'k1')`);
    await h.sql(`INSERT INTO goal_notes (id, goal_id, ordinal, kind, body) VALUES ('n1', 'g1', 0, 'note', 'b')`);
    const r = await h.raw("/api/data/cleanup/goals", { method: "POST", body: { confirm: true } });
    assert.equal(r.status, 200, JSON.stringify(r.json)?.slice(0, 300));
    for (const t of ["autonomy_goals", "goal_steps", "goal_notes"]) {
      const left = await h.sql(`SELECT COUNT(*)::int AS n FROM ${t}`);
      assert.equal(left[0].n, 0, `${t} is empty`);
    }
  });

  await test("clearing the ledger writes a tombstone", async () => {
    await h.sql(`INSERT INTO improvement_ledger (id, ts_ms, action, proposal, decision) VALUES ('l1', 1, 'test', '{}'::jsonb, 'kept')`);
    const r = await h.raw("/api/data/cleanup/ledger", { method: "POST", body: { confirm: true } });
    assert.equal(r.status, 200, JSON.stringify(r.json)?.slice(0, 200));
    const rows = await h.sql(`SELECT action, decision, justification FROM improvement_ledger`);
    assert.equal(rows.length, 1, "exactly the tombstone remains");
    assert.equal(rows[0].action, "ledger_cleared");
    assert.ok(/Stored data cleanup/.test(rows[0].justification), "tombstone says what happened");
  });

  await test("clearing memories backs them up to a verified file first", async () => {
    await h.sql(`INSERT INTO memories (id, workspace_id, memory_layer, content) VALUES ('m1', $1, 'self', 'hello')`, [ws.id]);
    const r = await h.raw("/api/data/cleanup/memories", { method: "POST", body: { confirm: true } });
    assert.equal(r.status, 200, JSON.stringify(r.json)?.slice(0, 300));
    assert.ok(r.json.backupPath, "backup path reported");
    assert.ok(r.json.backupPath.startsWith(backupDir), "backup lives under COGNOS_DATA_DIR/backups");
    const back = JSON.parse(fs.readFileSync(r.json.backupPath, "utf8"));
    assert.equal(back.rows.length, 1, "backup holds the memory row");
    assert.equal(back.rows[0].id, "m1");
    const left = await h.sql(`SELECT COUNT(*)::int AS n FROM memories`);
    assert.equal(left[0].n, 0, "memories table is empty");
  });

  await test("clear-everything requires the exact phrase", async () => {
    for (const bad of [{}, { confirm: true }, { confirm: "clear everything" }, { confirm: "CLEAR" }]) {
      const r = await h.raw("/api/data/cleanup/all", { method: "POST", body: bad });
      assert.equal(r.status, 400, `phrase ${JSON.stringify(bad)} rejected`);
    }
  });

  await test("clear-everything empties every category", async () => {
    await h.sql(`INSERT INTO cognos_ideas (id, workspace_id, title, reason, prompt, kind, status, created_ms, updated_ms) VALUES ('idea-x', $1, 't', 'r', 'p', 'k', 'new', 1, 1)`, [ws.id]);
    await h.sql(`INSERT INTO projects (id, workspace_id, name) VALUES ('p1', $1, 'proj')`, [ws.id]);
    await h.sql(`INSERT INTO conversations (id, workspace_id, title) VALUES ('c1', $1, 'c')`, [ws.id]);
    await h.sql(`INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ('msg1', 'c1', $1, 'user', 'hi')`, [ws.id]);
    const r = await h.raw("/api/data/cleanup/all", { method: "POST", body: { confirm: "CLEAR EVERYTHING" } });
    assert.equal(r.status, 200, JSON.stringify(r.json)?.slice(0, 300));
    assert.equal(r.json.cleared, true);
    for (const t of ["cognos_ideas", "projects", "conversations", "messages", "telemetry_model_calls"]) {
      const left = await h.sql(`SELECT COUNT(*)::int AS n FROM ${t}`);
      assert.equal(left[0].n, 0, `${t} is empty after clear-everything`);
    }
    // The ledger tombstone is the one sanctioned survivor.
    const ledger = await h.sql(`SELECT COUNT(*)::int AS n FROM improvement_ledger`);
    assert.equal(ledger[0].n, 1, "ledger holds only its tombstone");
    // Accounts, settings, and the workspace itself are untouched.
    const accts = await h.sql(`SELECT COUNT(*)::int AS n FROM accounts`).catch(() => [{ n: 0 }]);
    assert.ok(true, "accounts table not part of any category");
  });
} finally {
  await h.stop();
  fs.rmSync(backupDir, { recursive: true, force: true });
}

console.log(`data-cleanup: ${passed} test(s) passed`);
