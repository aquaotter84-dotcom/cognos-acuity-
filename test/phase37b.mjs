#!/usr/bin/env node
// Phase 37 — OpenMuse steals, part 2: the Ideas surface.
//
// What this file proves:
//   * Content-hash IDs + insert-if-absent: creating the same idea twice
//     yields exactly one row.
//   * Accept is a compare-and-swap: two accepts racing produce one idea row
//     moved to 'accepted' and exactly one durable task.
//   * Dismiss moves a new idea to 'dismissed'; a second dismiss is a no-op.
//   * Refresh rules: an active goal with no steps gets a plan idea; an active
//     goal with steps gets none; a resident with no tools and no watches gets
//     an idea; a resident with a tool assigned gets none. Refresh is
//     idempotent (no duplicates on re-run) and caps at 20.
//   * Retire: ideas whose source goal completed/cancelled, or whose source
//     resident is gone, move to 'expired'.

import assert from "node:assert/strict";
import { bootHarness } from "./harness.mjs";
import {
  ideaIdFor,
  createIdea,
  listIdeas,
  acceptIdea,
  dismissIdea,
  refreshIdeas,
  retireObsoleteIdeas,
  MAX_IDEAS_PER_REFRESH
} from "../server/autonomy/ideas.js";

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log(`  ok - ${name}`); };

const h = await bootHarness();
const { db } = await import("../server/db.js");
const ws = await db.Workspace.ensureDefault();

const ideaPayload = (overrides = {}) => ({
  workspaceId: ws.id,
  title: "A fresh thought",
  reason: "Just a test idea, nothing nagging.",
  evidence: [{ kind: "note", id: "n1" }],
  prompt: "Do the thing described in the title.",
  kind: "test",
  input: { a: 1 },
  sourceKind: null,
  sourceId: null,
  ...overrides
});

// --- Content-hash dedupe -----------------------------------------------------

await ok("ideaIdFor is deterministic and distinct per title", () => {
  const a = ideaPayload();
  assert.equal(ideaIdFor(a), ideaIdFor({ ...a }));
  assert.notEqual(ideaIdFor(a), ideaIdFor({ ...a, title: "A different thought" }));
  assert.notEqual(ideaIdFor(a), ideaIdFor({ ...a, sourceId: "x" }));
});

const first = await createIdea(db, ideaPayload());
const again = await createIdea(db, ideaPayload());
await ok("creating the same idea twice yields one row", async () => {
  assert.equal(first.id, again.id);
  const rows = await db.query(`SELECT COUNT(*)::int AS n FROM cognos_ideas WHERE id=$1`, [first.id]);
  assert.equal(rows[0].n, 1);
});

// --- Accept: CAS, exactly one durable task -----------------------------------

await ok("accept moves new->accepted and creates one queued durable task", async () => {
  const accepted = await acceptIdea(db, ws.id, first.id);
  assert.ok(accepted, "first accept should win the CAS");
  assert.equal(accepted.status, "accepted");
  assert.ok(accepted.task_id, "task_id stamped on the idea");
  const tasks = await db.query(
    `SELECT id, data FROM workflow_records WHERE owner=$1 AND kind='durable_tasks' AND id=$2`,
    [ws.id, accepted.task_id]
  );
  assert.equal(tasks.length, 1);
  const task = typeof tasks[0].data === "string" ? JSON.parse(tasks[0].data) : tasks[0].data;
  assert.equal(task.status, "queued");
  assert.equal(task.input.prompt, first.prompt);
  assert.equal(task.input.ideaId, first.id);
});

await ok("double accept loses the CAS: null, no second task", async () => {
  const second = await acceptIdea(db, ws.id, first.id);
  assert.equal(second, null);
  const tasks = await db.query(
    `SELECT COUNT(*)::int AS n FROM workflow_records WHERE owner=$1 AND kind='durable_tasks'`,
    [ws.id]
  );
  assert.equal(tasks[0].n, 1);
});

// --- Dismiss ------------------------------------------------------------------

const toDismiss = await createIdea(db, ideaPayload({
  title: "An idea to put away",
  kind: "test",
  sourceKind: "note",
  sourceId: "n2"
}));
await ok("dismiss moves new->dismissed; second dismiss is a no-op", async () => {
  const d = await dismissIdea(db, ws.id, toDismiss.id);
  assert.ok(d);
  assert.equal(d.status, "dismissed");
  const d2 = await dismissIdea(db, ws.id, toDismiss.id);
  assert.equal(d2, null);
});

// --- Refresh rules ------------------------------------------------------------

const goalNoSteps = await db.AutonomyGoal.create({
  workspace_id: ws.id, title: "Plant the fall garden", objective: "Get beds ready",
  status: "active"
});
const goalWithSteps = await db.AutonomyGoal.create({
  workspace_id: ws.id, title: "Rebuild the fence", objective: "Fix the north run",
  status: "active"
});
await db.GoalStep.create({
  goal_id: goalWithSteps.id, skill_id: "test-skill", idempotency_key: "phase37b-fence-1",
  tier: "T0", ordinal: 1
});

const residentIdle = await db.AutonomyAgent.create({
  workspace_id: ws.id, name: "Scout", slug: "scout", brief: "keeps an eye out"
});
const residentBusy = await db.AutonomyAgent.create({
  workspace_id: ws.id, name: "Piper", slug: "piper", brief: "pipes things along"
});
const tool = await db.ResidentTool.create({
  workspace_id: ws.id, name: "Test hook", url: "https://example.com/hook"
});
await db.ResidentTool.assign(tool.id, "piper", ws.id);

const created = await refreshIdeas(db, ws.id);
await ok("goal with no steps gets a plan idea; goal with steps gets none", async () => {
  const planIdeas = created.filter(i => i.source_kind === "goal");
  assert.equal(planIdeas.length, 1);
  const plan = planIdeas[0];
  assert.equal(plan.source_id, goalNoSteps.id);
  assert.equal(plan.kind, "plan");
  assert.ok(plan.title.includes("Plant the fall garden"));
  assert.deepEqual(plan.evidence, [{ kind: "goal", id: goalNoSteps.id, title: "Plant the fall garden" }]);
  assert.ok(plan.prompt && plan.prompt.length > 0);
});

await ok("resident with no tools/watches gets an idea; busy resident gets none", async () => {
  const resIdeas = created.filter(i => i.source_kind === "resident");
  assert.equal(resIdeas.length, 1);
  assert.equal(resIdeas[0].source_id, residentIdle.id);
  assert.ok(resIdeas[0].title.includes("Scout"));
});

await ok("refresh is idempotent: second pass creates nothing", async () => {
  const second = await refreshIdeas(db, ws.id);
  assert.equal(second.length, 0);
});

await ok("cap: never more than 20 ideas per refresh", async () => {
  assert.ok(MAX_IDEAS_PER_REFRESH === 20);
  const ideas = await listIdeas(db, ws.id, { status: "new" });
  assert.ok(ideas.length <= 20, `expected <= 20 new ideas, got ${ideas.length}`);
});

// --- Retire obsolete ----------------------------------------------------------

await ok("idea for a completed goal expires", async () => {
  await db.AutonomyGoal.setStatus(goalNoSteps.id, { status: "completed" });
  const retired = await retireObsoleteIdeas(db, ws.id);
  assert.ok(retired >= 1);
  const rows = await db.query(`SELECT status FROM cognos_ideas WHERE id=$1`, [
    ideaIdFor({ kind: "plan", sourceKind: "goal", sourceId: goalNoSteps.id, title: `Let's make a plan for Plant the fall garden` })
  ]);
  assert.equal(rows[0].status, "expired");
});

await ok("idea for a deleted resident expires", async () => {
  const residentIdeaRows = await db.query(
    `SELECT id FROM cognos_ideas WHERE workspace_id=$1 AND source_kind='resident' AND source_id=$2`,
    [ws.id, residentIdle.id]
  );
  assert.ok(residentIdeaRows.length === 1);
  await db.query(`DELETE FROM autonomy_agents WHERE id=$1`, [residentIdle.id]);
  const retired = await retireObsoleteIdeas(db, ws.id);
  assert.ok(retired >= 1);
  const rows = await db.query(`SELECT status FROM cognos_ideas WHERE id=$1`, [residentIdeaRows[0].id]);
  assert.equal(rows[0].status, "expired");
});

await ok("retire leaves live ideas alone", async () => {
  const ideas = await listIdeas(db, ws.id, { status: "new" });
  for (const idea of ideas) {
    if (idea.source_kind === "goal") {
      const g = await db.AutonomyGoal.get(idea.source_id);
      assert.ok(g && !["completed", "cancelled", "expired"].includes(g.status),
        `goal idea points at a dead goal: ${idea.id}`);
    }
    if (idea.source_kind === "resident") {
      const r = await db.AutonomyAgent.get(idea.source_id);
      assert.ok(r, `resident idea points at a missing resident: ${idea.id}`);
    }
  }
});

console.log(`\nphase37b: ${passed} passed`);
await h.stop();
process.exit(0);
