#!/usr/bin/env node
// Goal deletion regression: deleting a goal that has steps and subagents must
// not violate the ON DELETE RESTRICT foreign keys on goal_steps and
// goal_subagents. (Production Postgres enforces RESTRICT; the delete used to
// go straight at autonomy_goals and blow up with
// "update or delete on table autonomy_goals violates RESTRICT".)

import assert from "node:assert/strict";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const h = await bootHarness();
try {
  await test("deleting a goal with steps and subagents clears children first, atomically", async () => {
    const ws = (await h.sql(`SELECT id FROM workspaces LIMIT 1`))[0];
    assert.ok(ws, "a workspace exists after warm-up");
    const gid = "gtest-del-1";

    await h.sql(
      `INSERT INTO autonomy_goals (id, workspace_id, title, objective, status)
       VALUES ($1, $2, 'delete me', 'test the delete path', 'parked')`,
      [gid, ws.id]
    );
    await h.sql(
      `INSERT INTO goal_steps (id, goal_id, ordinal, skill_id, tier, status, idempotency_key)
       VALUES ('gstep-1', $1, 0, 'noop', 'T0', 'done', 'idem-1'),
              ('gstep-2', $1, 1, 'noop', 'T0', 'done', 'idem-2')`,
      [gid]
    );
    await h.sql(
      `INSERT INTO goal_subagents (id, workspace_id, goal_id, objective, skills, status)
       VALUES ('gsub-1', $2, $1, 'help out', '[]'::jsonb, 'done')`,
      [gid, ws.id]
    );
    // An event row exercises the audit-trail rule: events are never deleted.
    await h.sql(
      `INSERT INTO goal_events (id, goal_id, event_type, detail, ts_ms)
       VALUES ('gevt-1', $1, 'note', '{}'::jsonb, 1)`,
      [gid]
    );

    const del = await h.raw(`/api/autonomy/goals/${gid}`, { method: "DELETE" });
    assert.equal(del.status, 200, `DELETE should succeed, got ${del.status}: ${del.text?.slice(0, 200)}`);
    assert.equal(del.json?.deleted, true);

    const goals = await h.sql(`SELECT id FROM autonomy_goals WHERE id = $1`, [gid]);
    assert.equal(goals.length, 0, "the goal row is gone");
    const steps = await h.sql(`SELECT id FROM goal_steps WHERE goal_id = $1`, [gid]);
    assert.equal(steps.length, 0, "the goal's steps are gone");
    const subs = await h.sql(`SELECT id FROM goal_subagents WHERE goal_id = $1`, [gid]);
    assert.equal(subs.length, 0, "the goal's subagents are gone");
    const events = await h.sql(`SELECT id FROM goal_events WHERE goal_id = $1`, [gid]);
    assert.equal(events.length, 1, "the goal's events survive as the audit trail");
  });

  await test("deleting a goal with no children still works", async () => {
    const ws = (await h.sql(`SELECT id FROM workspaces LIMIT 1`))[0];
    const gid = "gtest-del-2";
    await h.sql(
      `INSERT INTO autonomy_goals (id, workspace_id, title, objective, status)
       VALUES ($1, $2, 'lonely goal', 'nothing attached', 'parked')`,
      [gid, ws.id]
    );
    const del = await h.raw(`/api/autonomy/goals/${gid}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal(del.json?.deleted, true);
  });

  await test("deleting a missing goal is a 404", async () => {
    const del = await h.raw(`/api/autonomy/goals/nope-not-here`, { method: "DELETE" });
    assert.equal(del.status, 404);
  });
} finally {
  await h.stop();
}

console.log(`goal-delete: ${passed} test(s) passed`);
