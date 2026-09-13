#!/usr/bin/env node
// Phase 20 regressions: sub-agents, T3 external reads, promotion, goal-note
// locators, and the explicit-ask path that carries cited findings into memory.
//
// Deterministic and local: no test here reaches a real model or the network.
// Fetches are judged in shadow (no socket opens), refused structurally, or
// aimed at .invalid — the suite proves the gates without leaving the sandbox.

import assert from "node:assert/strict";
import { autonomyConfig } from "../server/autonomy/config.js";
import { isSkillEnabled } from "../server/skills/index.js";
import { urlAllowedByScope } from "../server/autonomy/scopeUrl.js";
import { judgeEffect } from "../server/autonomy/actionGovernor.js";
import { scopeHashes } from "../server/autonomy/authorize.js";
import { governorAgent } from "../server/council/governor.js";
import { parseNoteLocators, noteLocator, buildGoalEvidence } from "../server/autonomy/goalEvidence.js";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const SECRET = "sk-ABCdef1234567890ABCDEF1234";

// ------------------------------------------------------------------ pure units
await test("allowlist entries are exact URLs or host+prefix — never wider", async () => {
  const yes = (url, entries) => assert.equal(urlAllowedByScope(url, entries).allowed, true, `${url} vs ${entries}`);
  const no = (url, entries) => assert.equal(urlAllowedByScope(url, entries).allowed, false, `${url} vs ${entries}`);
  yes("https://example.com/docs/a", ["example.com/docs"]);
  yes("https://example.com/docs/a", ["https://example.com/docs/a"]);
  no("https://example.com/docs/b", ["https://example.com/docs/a"]);
  no("https://example.com/docs2", ["example.com/docs"]);
  no("https://sub.example.com/docs/a", ["example.com/docs"]);
  yes("https://example.com/anything", ["example.com"]);
  no("https://example.com/docs/a", []);
  no("https://example.com/docs/a", null);
  no("https://example.com/docs/a", [42, null, ""]);
  // Case-insensitive hosts, exact paths.
  yes("https://EXAMPLE.com/docs/a", ["example.com/docs"]);
});

await test("goal-note locators parse, round-trip, and reject garbage", async () => {
  assert.equal(noteLocator("goal_m7x2k", 3), "[goal_m7x2k:n3]");
  const found = parseNoteLocators("Per [goal_m7x2k:n3], revenue grew. Also [GOAL_m7x2k:N4]!");
  assert.deepEqual(found.map(f => [f.goalId, f.ordinal]), [["goal_m7x2k", 3], ["goal_m7x2k", 4]]);
  assert.deepEqual(parseNoteLocators("no locators here [n3] [goal_:n1] [goal_x:n0]"), []);
  // Cross-goal filtering: the answer-carried path only hears its own goal.
  const filtered = parseNoteLocators("[goal_aaa:n1] and [goal_bbb:n2]", { goalId: "goal_bbb" });
  assert.deepEqual(filtered.map(f => f.ordinal), [2]);
});

await test("the Action Governor judges T3 reads: scope, destination, shape", async () => {
  const db = { query: async () => [{ total: 0, n: 0 }] };
  const config = autonomyConfig();
  const goalScope = { effectsAllowed: ["external_read"], urlAllowlist: ["example.com/docs"] };
  const goal = { id: "goal_test", workspace_id: "ws1", scope: goalScope, spent: {}, budget: {} };
  const hashes = scopeHashes({ goalId: goal.id, scope: goalScope, budget: {} });
  const auth = { decision: "authorize", scope_sha256: hashes.scopeSha256,
    budget_sha256: hashes.budgetSha256, expires_at_ms: Date.now() + 999999 };
  const judge = (effect, authorization = auth) => judgeEffect({ db, effect, goal, authorization, config });
  const rules = (v) => v.failed.map(f => f.rule);
  const fetchFx = (url, sha = hashes.scopeSha256) => ({
    skill_id: "web.fetch", tier: "T3", effect_type: "external_read", mode: "shadow",
    payload: { op: "fetch", url, scopeSha256: sha }
  });

  assert.equal((await judge(fetchFx("https://example.com/docs/a"))).decision, "release");
  assert.ok(rules(await judge(fetchFx("https://evil.example.com/x"))).includes("DESTINATION_NOT_IN_SCOPE"));
  assert.ok(rules(await judge(fetchFx("https://127.0.0.1/x"))).includes("UNSAFE_URL"));
  assert.ok(rules(await judge(fetchFx("http://2130706433/x"))).includes("UNSAFE_URL"));
  assert.ok(rules(await judge(fetchFx("ftp://example.com/docs/x"))).includes("UNSAFE_URL"));
  assert.ok(rules(await judge(fetchFx("https://user:pass@example.com/docs/x"))).includes("UNSAFE_URL"));
  assert.ok(rules(await judge(fetchFx("https://example.com/docs/a", "stale"))).includes("EFFECT_NOT_IN_SCOPE"));
  assert.ok(rules(await judge(fetchFx("https://example.com/docs/a"), null)).includes("GOAL_NOT_AUTHORIZED"));

  // Search has no destination: the effect class is judged, the query scanned.
  const search = (query) => ({
    skill_id: "web.search", tier: "T3", effect_type: "external_read", mode: "shadow",
    payload: { op: "search", query, scopeSha256: hashes.scopeSha256 }
  });
  assert.equal((await judge(search("quarterly revenue"))).decision, "release");
  assert.ok(rules(await judge(search(`find ${SECRET} now`))).includes("SECRET_IN_PAYLOAD"));
});

await test("rung-gated skills fail closed without their rung", async () => {
  // Pure units run before the harness boots, so the global switch is unset
  // (off) here. Set it to isolate the RUNG gate from the master gate.
  const prev = process.env.COGNOS_AUTONOMY_ENABLED;
  process.env.COGNOS_AUTONOMY_ENABLED = "true";
  const cfg = autonomyConfig();
  assert.equal(typeof cfg.rung.residents, "boolean");
  assert.equal(typeof cfg.rung.search, "boolean");
  const off = { ...cfg, rung: { residents: false, search: false } };
  const on = { ...cfg, rung: { residents: true, search: true } };
  assert.equal(isSkillEnabled("subagent.spawn", off), false);
  assert.equal(isSkillEnabled("subagent.spawn", on), true);
  assert.equal(isSkillEnabled("web.search", off), false);
  assert.equal(isSkillEnabled("web.search", on), true);
  assert.equal(isSkillEnabled("note.promote.request", off), false);
  assert.equal(isSkillEnabled("note.promote.request", on), true);
  // web.fetch is allowlist-gated, not rung-gated.
  assert.equal(isSkillEnabled("web.fetch", off), true);
  assert.equal(isSkillEnabled("web.fetch", on), true);
  if (prev === undefined) delete process.env.COGNOS_AUTONOMY_ENABLED;
  else process.env.COGNOS_AUTONOMY_ENABLED = prev;
});

await test("the council Governor audits goal-note citations against the loaded set", async () => {
  const ctx = { config: { council: { governorEnabled: true } } };
  const govern = (responseText, record) => governorAgent.handle(
    { content: { responseText, coherence: null, record } }, ctx);
  const loaded = ["[goal_m7x2k:n1]", "[goal_m7x2k:n2]"];

  const clean = await govern("The change is described in [goal_m7x2k:n1].", { goalNoteLocators: loaded });
  assert.ok(!clean.flags.includes("goal_note_citation_unverifiable"), JSON.stringify(clean.flags));

  const dirty = await govern("The change is described in [goal_m7x2k:n9].", { goalNoteLocators: loaded });
  assert.ok(dirty.flags.includes("goal_note_citation_unverifiable"));
  assert.equal(dirty.approved, false);

  const foreign = await govern("The change is described in [goal_other:n1].", { goalNoteLocators: loaded });
  assert.ok(foreign.flags.includes("goal_note_citation_unverifiable"));

  const none = await govern("A plain answer with no citations.", { goalNoteLocators: [] });
  assert.ok(!none.flags.includes("goal_note_citation_unverifiable"));
});

// --------------------------------------------------------------- route-driven
const h = await bootHarness({
  COGNOS_AUTONOMY_ENABLED: "true",
  COGNOS_AUTONOMY_RESIDENTS: "true",
  COGNOS_AUTONOMY_NOTICE_MODE: "internal"
});

const count = async (table, where = "", params = []) =>
  Number((await h.sql(`SELECT COUNT(*)::int AS n FROM ${table}${where}`, params))[0]?.n || 0);

// JSONB columns arrive parsed through the harness driver; TEXT ones do not.
// This helper reads both without caring which is which.
const json = (value, fallback = null) => {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
};

const ALL_SKILLS = ["note.append", "evidence.read", "memory.search", "belief.search",
  "source.snapshot", "note.promote.request", "notice.emit",
  "subagent.spawn", "web.fetch", "web.search"];

async function makeAgent(allowlist = ALL_SKILLS) {
  const created = await h.raw("/api/autonomy/agents", {
    method: "POST",
    body: { name: `R${Date.now()}${Math.floor(Math.random() * 1e6)}`, purpose: "phase20",
      brief: "v1", skill_allowlist: allowlist }
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json;
}

async function makeGoal(agentId, { scope = null, conversationId = undefined } = {}) {
  const body = { title: "Phase 20 goal", objective: "Prove the Phase 20 gates.", agent_id: agentId };
  if (scope) body.scope = scope;
  if (conversationId !== undefined) body.conversation_id = conversationId;
  const made = await h.raw("/api/autonomy/goals", { method: "POST", body });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  return made.json.goal;
}

async function authorize(goalId) {
  const yes = await h.raw(`/api/autonomy/goals/${goalId}/decision`, { method: "POST", body: { decision: "authorize" } });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  // Earlier tests leave authorized goals behind, and a tick claims whatever
  // is due — not only the goal under test. Retire them first.
  await h.sql(
    `UPDATE autonomy_goals SET status='cancelled', park_reason='paused_by_user', ended_ms=$1
      WHERE status IN ('active','parked','awaiting_authorization','proposed') AND id <> $2`,
    [Date.now(), goalId]);
  await h.sql(`UPDATE autonomy_goals SET next_run_at_ms=0 WHERE id=$1`, [goalId]);
}

async function tick(needle) {
  h.model.state.autonomyStep = needle;
  // A tick only claims DUE goals; a goal that just ran is scheduled out.
  // authorize() leaves exactly one goal active per test, so dueing all active
  // goals dues the goal under test and nothing else.
  await h.sql(`UPDATE autonomy_goals SET next_run_at_ms=0 WHERE status='active'`);
  const res = await h.raw("/api/autonomy/tick", { method: "POST" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res;
}

const FETCH_SCOPE = { effectsAllowed: ["notify", "external_read"], urlAllowlist: ["example.com/docs"] };

await test("rung gates refuse spawn/search/promote while the allowlist-gated fetch still judges", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id, { scope: FETCH_SCOPE });
  await authorize(goal.id);

  const prev = process.env.COGNOS_AUTONOMY_RESIDENTS;
  delete process.env.COGNOS_AUTONOMY_RESIDENTS;   // search was never enabled in this file
  try {
    // The fetch runs FIRST: three consecutive refusals trip the loop's own
    // failure brake and park the goal, which is correct behaviour getting in
    // the way of a test script. Success first, then the refusals.
    const script = [
      { thought: "fetch", skill: "web.fetch", args: { url: "https://example.com/docs/a" }, done: false },
      { thought: "spawn", skill: "subagent.spawn", args: { objective: "x", skills: ["note.append"] }, done: false },
      { thought: "search", skill: "web.search", args: { query: "x" }, done: false },
      { thought: "promote", skill: "note.promote.request", args: { noteId: "gnote_nope" }, done: false },
      { thought: "done", skill: "none", args: {}, done: true }
    ];
    let i = 0;
    await tick(() => script[Math.min(i++, script.length - 1)]);

    const steps = await h.sql(
      `SELECT skill_id, status, error_message FROM goal_steps WHERE goal_id=$1 ORDER BY ordinal`, [goal.id]);
    assert.equal(steps.length, 4, JSON.stringify(steps));
    // The fetch is gated by the allowlist, not the rung: it judges in shadow.
    assert.equal(steps[0].status, "completed");
    assert.equal(steps[1].status, "refused");
    assert.match(steps[1].error_message, /rung gate: subagent\.spawn needs rung 'residents'/);
    assert.equal(steps[2].status, "refused");
    assert.match(steps[2].error_message, /rung gate: web\.search needs rung 'search'/);
    assert.equal(steps[3].status, "refused");
    assert.match(steps[3].error_message, /rung gate: note\.promote\.request needs rung 'residents'/);
    const fx = await h.sql(
      `SELECT effect_type, status FROM autonomy_outbox WHERE goal_id=$1 ORDER BY created_date`, [goal.id]);
    assert.deepEqual(fx.map(r => [r.effect_type, r.status]),
      [["external_read", "would_release"], ["notify", "would_release"]],
      "the fetch judged in shadow; the failure brake parked the goal and reported it");
    assert.equal(await count("sources", ""), 0, "shadow judges; it never fetches");
  } finally {
    if (prev === undefined) delete process.env.COGNOS_AUTONOMY_RESIDENTS;
    else process.env.COGNOS_AUTONOMY_RESIDENTS = prev;
  }
});

await test("§8.11a: a spawned worker's findings enter as evidence with its id attached", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id);
  await authorize(goal.id);

  let plannerCalls = 0;
  let workerCalls = 0;
  await tick((payload) => {
    const system = payload.messages?.find(m => m.role === "system")?.content || "";
    if (String(system).includes("SUB-AGENT")) {
      workerCalls++;
      if (workerCalls === 1) {
        return { thought: "record", skill: "note.append",
          args: { kind: "finding", body: "The north meter reads 12." }, done: false };
      }
      return { thought: "done", skill: "none", args: {}, done: true };
    }
    plannerCalls++;
    if (plannerCalls === 1) {
      return { thought: "delegate", skill: "subagent.spawn",
        args: { objective: "Read the north meter.", skills: ["note.append"], maxSteps: 2 }, done: false };
    }
    return { thought: "done", skill: "none", args: {}, done: true };
  });

  const workers = await h.sql(`SELECT * FROM goal_subagents WHERE goal_id=$1`, [goal.id]);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].status, "completed");
  assert.deepEqual(json(workers[0].skills), ["note.append"]);
  assert.ok(Number(json(workers[0].spent, {}).steps || 0) <= 2);

  const notes = await h.sql(`SELECT refs FROM goal_notes WHERE goal_id=$1 AND kind='finding'`, [goal.id]);
  assert.equal(notes.length, 1);
  assert.equal(json(notes[0].refs, [])[0]?.sub_agent_id, workers[0].id);

  const spent = (await h.sql(`SELECT spent FROM autonomy_goals WHERE id=$1`, [goal.id]))[0]?.spent || {};
  assert.ok(Number(spent.steps || 0) >= 1, "worker steps meter against the goal");
  assert.ok(Number(spent.modelCalls || 0) >= 2, "worker model calls meter against the goal");
});

await test("§8.11b: a worker cannot widen its subset, and nesting refuses loudly", async () => {
  const agent = await makeAgent();
  // Two halves, two goals: each half ends with done (which completes its
  // goal), and a completed goal never ticks again.
  const nestGoal = await makeGoal(agent.id);
  await authorize(nestGoal.id);

  // A declared subset naming the spawner refuses the SPAWN: no worker runs on
  // a subset it was not granted.
  // One nesting attempt, then done — a constant needle would re-nest until
  // the failure brake parks the goal, and the second half needs it active.
  let nests = 0;
  await tick(() => (++nests === 1
    ? { thought: "nest", skill: "subagent.spawn",
        args: { objective: "Spawn again.", skills: ["note.append", "subagent.spawn"] }, done: false }
    : { thought: "done", skill: "none", args: {}, done: true }));
  assert.equal(await count("goal_subagents", " WHERE goal_id=$1", [nestGoal.id]), 0);
  const nestStep = (await h.sql(
    `SELECT status, error_message FROM goal_steps WHERE goal_id=$1 ORDER BY ordinal DESC LIMIT 1`, [nestGoal.id]))[0];
  assert.equal(nestStep.status, "failed");
  assert.match(nestStep.error_message, /subset refused/);

  const goal = await makeGoal(agent.id);
  await authorize(goal.id);

  // A worker that reaches outside its subset is stopped and recorded — but
  // the spawn itself still succeeded.
  let plannerCalls = 0;
  await tick((payload) => {
    const system = payload.messages?.find(m => m.role === "system")?.content || "";
    if (String(system).includes("SUB-AGENT")) {
      return { thought: "escalate", skill: "notice.emit",
        args: { templateId: "finding_ready", fields: {} }, done: false };
    }
    plannerCalls++;
    if (plannerCalls === 1) {
      return { thought: "delegate", skill: "subagent.spawn",
        args: { objective: "Try to notify.", skills: ["note.append"] }, done: false };
    }
    return { thought: "done", skill: "none", args: {}, done: true };
  });
  const workers = await h.sql(`SELECT * FROM goal_subagents WHERE goal_id=$1`, [goal.id]);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].status, "refused");
  assert.match(String(workers[0].error_message || ""), /subset/);
  const parent = (await h.sql(
    `SELECT status, output FROM goal_steps WHERE goal_id=$1 AND skill_id='subagent.spawn' ORDER BY ordinal DESC LIMIT 1`, [goal.id]))[0];
  assert.equal(parent.status, "completed", "the spawn succeeded; the worker's reach did not");
  assert.equal(parent.output?.status, "refused");
});

await test("§8.11c: a proposed sub-budget is clamped to the ceilings", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id);
  await authorize(goal.id);
  let plannerCalls = 0;
  await tick((payload) => {
    const system = payload.messages?.find(m => m.role === "system")?.content || "";
    if (String(system).includes("SUB-AGENT")) return { thought: "done", skill: "none", args: {}, done: true };
    plannerCalls++;
    if (plannerCalls === 1) {
      // Schema-valid (max 10 / 0.25) but above the ceilings (5 / 0.10):
      // the schema bounds the ask, the ceilings bound the grant.
      return { thought: "splurge", skill: "subagent.spawn",
        args: { objective: "Spend it all.", skills: ["note.append"], maxSteps: 10, maxCostUsd: 0.25 }, done: false };
    }
    return { thought: "done", skill: "none", args: {}, done: true };
  });
  const row = (await h.sql(`SELECT budget FROM goal_subagents WHERE goal_id=$1`, [goal.id]))[0];
  const budget = json(row.budget, {});
  assert.ok(Number(budget.maxSteps) <= 5, `maxSteps clamped, got ${budget.maxSteps}`);
  assert.ok(Number(budget.maxCostUsd) <= 0.10, `maxCostUsd clamped, got ${budget.maxCostUsd}`);
});

await test("T3 fetch off the allowlist refuses with the destination rule", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id, { scope: FETCH_SCOPE });
  await authorize(goal.id);
  let evil = 0;
  await tick(() => (++evil === 1
    ? { thought: "fetch evil", skill: "web.fetch", args: { url: "https://evil.example.com/x" }, done: false }
    : { thought: "done", skill: "none", args: {}, done: true }));
  const step = (await h.sql(
    `SELECT status, error_message FROM goal_steps WHERE goal_id=$1 ORDER BY ordinal DESC LIMIT 1`, [goal.id]))[0];
  assert.equal(step.status, "failed");
  assert.match(step.error_message, /refused/);
  const fx = (await h.sql(
    `SELECT status, verdict FROM autonomy_outbox WHERE goal_id=$1 AND effect_type='external_read'`, [goal.id]))[0];
  assert.equal(fx.status, "refused");
  assert.ok(JSON.stringify(fx.verdict).includes("DESTINATION_NOT_IN_SCOPE"));
});

await test("T3 fetch of a literal IP refuses even when the allowlist names it", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id, {
    scope: { effectsAllowed: ["notify", "external_read"], urlAllowlist: ["http://127.0.0.1/x"] }
  });
  await authorize(goal.id);
  let loop = 0;
  await tick(() => (++loop === 1
    ? { thought: "fetch loopback", skill: "web.fetch", args: { url: "http://127.0.0.1/x" }, done: false }
    : { thought: "done", skill: "none", args: {}, done: true }));
  const fx = (await h.sql(
    `SELECT status, verdict FROM autonomy_outbox WHERE goal_id=$1 AND effect_type='external_read'`, [goal.id]))[0];
  assert.equal(fx.status, "refused");
  assert.ok(JSON.stringify(fx.verdict).includes("UNSAFE_URL"));
});

await test("T3 fetch replays: one staged row, however many steps cite the URL", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id, { scope: FETCH_SCOPE });
  await authorize(goal.id);
  let calls = 0;
  await tick(() => (++calls <= 2
    ? { thought: "fetch", skill: "web.fetch", args: { url: "https://example.com/docs/a" }, done: false }
    : { thought: "done", skill: "none", args: {}, done: true }));
  assert.equal(await count("autonomy_outbox", " WHERE goal_id=$1 AND effect_type='external_read'", [goal.id]), 1);
  const steps = await h.sql(`SELECT status FROM goal_steps WHERE goal_id=$1 ORDER BY ordinal`, [goal.id]);
  assert.deepEqual(steps.map(s => s.status), ["completed", "completed"]);
});

await test("T3 live fetch fails closed with no network path", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id, {
    scope: { effectsAllowed: ["notify", "external_read"], urlAllowlist: ["http://x.invalid/"] }
  });
  await authorize(goal.id);
  const prev = process.env.COGNOS_AUTONOMY_OUTBOX_MODE;
  process.env.COGNOS_AUTONOMY_OUTBOX_MODE = "live";
  try {
    let invalid = 0;
    await tick(() => (++invalid === 1
      ? { thought: "fetch invalid", skill: "web.fetch", args: { url: "http://x.invalid/" }, done: false }
      : { thought: "done", skill: "none", args: {}, done: true }));
  } finally {
    if (prev === undefined) delete process.env.COGNOS_AUTONOMY_OUTBOX_MODE;
    else process.env.COGNOS_AUTONOMY_OUTBOX_MODE = prev;
  }
  const fx = (await h.sql(
    `SELECT status, error_message FROM autonomy_outbox WHERE goal_id=$1 AND effect_type='external_read'`, [goal.id]))[0];
  assert.equal(fx.status, "failed", "live mode attempted the read and recorded the failure");
  assert.ok(String(fx.error_message || "").length > 0);
});

await test("§8.13 + false-promotion: approval applies inferred-with-origin, never direct", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id);
  await authorize(goal.id);

  await tick(() => ({ thought: "note", skill: "note.append",
    args: { kind: "finding", body: "The county courthouse is at 123 Fake Street and open 24 hours." }, done: false }));
  const note = (await h.sql(`SELECT id, ordinal FROM goal_notes WHERE goal_id=$1 ORDER BY ordinal`, [goal.id]))[0];
  await tick(() => ({ thought: "request", skill: "note.promote.request",
    args: { noteId: note.id }, done: false }));

  const queue = await h.raw(`/api/autonomy/promotions?goalId=${goal.id}`);
  assert.equal(queue.status, 200);
  assert.equal(queue.json.length, 1);
  assert.equal(queue.json[0].status, "requested");

  const decide = await h.raw(`/api/autonomy/promotions/${queue.json[0].id}/decide`, {
    method: "POST", body: { decision: "approve" }
  });
  assert.equal(decide.status, 200, JSON.stringify(decide.json));
  assert.equal(decide.json.status, "applied");
  assert.ok(decide.json.memoryId);

  const mem = (await h.sql(`SELECT * FROM memories WHERE id=$1`, [decide.json.memoryId]))[0];
  assert.equal(mem.evidence_level, "inferred");
  assert.notEqual(mem.evidence_level, "direct");
  assert.equal(mem.source, "autonomy_promotion");
  const tags = json(mem.tags, []);
  assert.ok(tags.includes(`autonomy_goal:${goal.id}`), `origin tag, got ${tags}`);
  assert.ok(tags.includes("note:n1"), `note tag, got ${tags}`);

  const events = await h.sql(`SELECT event_type FROM goal_events WHERE goal_id=$1 ORDER BY seq DESC LIMIT 1`, [goal.id]);
  assert.equal(events[0].event_type, "promotion_decided");
});

await test("§8.1 secret-in-note: a credential cannot promote, and the queue withholds it", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id);
  await authorize(goal.id);

  await tick(() => ({ thought: "note", skill: "note.append",
    args: { kind: "finding", body: `The meter key is ${SECRET} per the plate.` }, done: false }));
  const note = (await h.sql(`SELECT id FROM goal_notes WHERE goal_id=$1 ORDER BY ordinal`, [goal.id]))[0];
  await tick(() => ({ thought: "request", skill: "note.promote.request",
    args: { noteId: note.id }, done: false }));

  const step = (await h.sql(
    `SELECT status, error_message FROM goal_steps WHERE goal_id=$1 ORDER BY ordinal DESC LIMIT 1`, [goal.id]))[0];
  assert.equal(step.status, "failed");
  assert.match(step.error_message, /credential-shaped/);

  const queue = await h.raw(`/api/autonomy/promotions?goalId=${goal.id}`);
  assert.equal(queue.json.length, 1);
  assert.equal(queue.json[0].status, "refused");
  assert.equal(queue.json[0].redacted, true);
  assert.equal(queue.json[0].note_body, null);
  assert.ok(!String(queue.json[0].reason || "").includes(SECRET));

  assert.equal(await count("memories", " WHERE content LIKE $1", [`%${SECRET}%`]), 0);
  const reasons = await h.sql(`SELECT reason FROM note_promotions WHERE goal_id=$1`, [goal.id]);
  assert.ok(!JSON.stringify(reasons).includes(SECRET));
});

await test("answer-carried: a citing answer applies an open request; uncited and unrequested never move", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id);
  await authorize(goal.id);

  const bodies = ["The north meter reads 12.", "The south meter reads 9.", "The gate was locked."];
  // No done anywhere on this goal: filler questions keep both ticks under
  // the step cap, and saying done would complete the goal mid-test.
  const filler = (n) => ({ thought: "filler", skill: "note.append",
    args: { kind: "question", body: `filler ${n}` }, done: false });
  let appends = 0;
  await tick(() => (++appends <= 3
    ? { thought: "note", skill: "note.append", args: { kind: "finding", body: bodies[appends - 1] }, done: false }
    : filler(appends)));
  const notes = await h.sql(
    `SELECT id, ordinal FROM goal_notes WHERE goal_id=$1 AND kind='finding' ORDER BY ordinal`, [goal.id]);
  assert.equal(notes.length, 3);
  let reqs = 0;
  await tick(() => (++reqs <= 2
    ? { thought: "request", skill: "note.promote.request", args: { noteId: notes[reqs - 1].id }, done: false }
    : filler(reqs)));
  assert.equal(await count("note_promotions", " WHERE goal_id=$1 AND status='requested'", [goal.id]), 2);

  const tail = goal.id.replace(/^goal_/, "");
  const prevAnswer = h.model.state.answer;
  h.model.state.answer = `The change is described in [goal_${tail}:n1]. A related observation is in [goal_${tail}:n3].`;
  // The goal inherited its resident's home conversation: ask there, as the
  // Autonomy page's Ask button does.
  assert.ok(goal.conversation_id, "agent-owned goals inherit a home conversation");
  let result;
  try {
    result = await h.chat("What did the goal find?", { goalId: goal.id, conversationId: goal.conversation_id });
  } finally {
    h.model.state.answer = prevAnswer;
  }
  const done = (result.events || []).find(e => e.event === "done");
  assert.ok(done, `a done frame shipped: ${JSON.stringify((result.events || []).map(e => e.event))}`);
  assert.equal(done.data.goalId, goal.id);
  assert.equal(done.data.goalPromotions?.applied?.length, 1);
  assert.equal(done.data.goalPromotions.applied[0].ordinal, 1);

  // n1 carried; n2 requested but uncited; n3 cited but never requested.
  const promos = await h.sql(
    `SELECT note_id, status, decision_source FROM note_promotions WHERE goal_id=$1`, [goal.id]);
  const byNote = Object.fromEntries(promos.map(p => [p.note_id, p]));
  assert.equal(byNote[notes[0].id].status, "applied");
  assert.match(byNote[notes[0].id].decision_source, /^answer_carried:/);
  assert.equal(byNote[notes[1].id].status, "requested");
  assert.equal(byNote[notes[2].id], undefined);

  const mems = await h.sql(`SELECT evidence_level, tags FROM memories WHERE content=$1`, [bodies[0]]);
  assert.equal(mems.length, 1);
  assert.equal(mems[0].evidence_level, "inferred");
  assert.ok(json(mems[0].tags, []).includes(`autonomy_goal:${goal.id}`));
});

await test("goal evidence loads into the turn and the trace names it", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id);
  await authorize(goal.id);
  let traced = 0;
  await tick(() => (++traced === 1
    ? { thought: "note", skill: "note.append", args: { kind: "finding", body: "Trace me." }, done: false }
    : { thought: "done", skill: "none", args: {}, done: true }));

  const tail = goal.id.replace(/^goal_/, "");
  const result = await h.chat("Summarize the goal.", { goalId: goal.id, conversationId: goal.conversation_id });
  const done = (result.events || []).find(e => e.event === "done");
  assert.ok(done, "a done frame shipped");
  assert.equal(done.data.council?.goal?.goalId, goal.id);
  assert.equal(done.data.council.goal.notesLoaded, 1);
  assert.deepEqual(done.data.council.goal.locators, [`[goal_${tail}:n1]`]);
  assert.deepEqual(done.data.goalPromotions, { applied: [], cited: 0 });
});

await test("chat goalId validation: unknown goals 404, foreign goals 409", async () => {
  const missing = await h.raw("/api/chat", { method: "POST", body: { userMessage: "hi", goalId: "goal_nope" } });
  assert.equal(missing.status, 404);

  const conv = await h.chat("start a thread");
  const convId = (conv.events.find(e => e.event === "start")?.data?.conversationId) || null;
  assert.ok(convId);
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id, { conversationId: convId });
  const other = await h.chat("another thread");
  const otherId = other.events.find(e => e.event === "start")?.data?.conversationId;
  assert.ok(otherId && otherId !== convId);
  const clash = await h.raw("/api/chat", {
    method: "POST", body: { userMessage: "hi", conversationId: otherId, goalId: goal.id }
  });
  assert.equal(clash.status, 409);
});

await test("promotion routes: the decision matrix", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id);
  await authorize(goal.id);
  await tick(() => ({ thought: "note", skill: "note.append",
    args: { kind: "finding", body: "Decide me." }, done: false }));
  const note = (await h.sql(`SELECT id FROM goal_notes WHERE goal_id=$1`, [goal.id]))[0];
  await tick(() => ({ thought: "request", skill: "note.promote.request",
    args: { noteId: note.id }, done: false }));
  const row = (await h.sql(`SELECT id FROM note_promotions WHERE goal_id=$1`, [goal.id]))[0];

  const unknown = await h.raw("/api/autonomy/promotions/promo_nope/decide", {
    method: "POST", body: { decision: "approve" }
  });
  assert.equal(unknown.status, 404);

  const bad = await h.raw(`/api/autonomy/promotions/${row.id}/decide`, {
    method: "POST", body: { decision: "maybe" }
  });
  assert.equal(bad.status, 400);

  const prev = process.env.COGNOS_AUTONOMY_ENABLED;
  process.env.COGNOS_AUTONOMY_ENABLED = "false";
  try {
    const frozen = await h.raw(`/api/autonomy/promotions/${row.id}/decide`, {
      method: "POST", body: { decision: "approve" }
    });
    assert.equal(frozen.status, 409);
  } finally {
    if (prev === undefined) delete process.env.COGNOS_AUTONOMY_ENABLED;
    else process.env.COGNOS_AUTONOMY_ENABLED = prev;
  }

  const first = await h.raw(`/api/autonomy/promotions/${row.id}/decide`, {
    method: "POST", body: { decision: "refuse", reason: "not yet" }
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.status, "refused");
  const second = await h.raw(`/api/autonomy/promotions/${row.id}/decide`, {
    method: "POST", body: { decision: "approve" }
  });
  assert.equal(second.status, 409, "a decided row cannot be re-decided");

  const filtered = await h.raw(`/api/autonomy/promotions?status=requested&goalId=${goal.id}`);
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.json, []);
});

await test("goal detail and status carry the Phase 20 surface", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id);
  await authorize(goal.id);
  const detail = await h.raw(`/api/autonomy/goals/${goal.id}`);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.json.subagents), "subagents ride the goal detail");
  assert.ok(Array.isArray(detail.json.promotions), "promotions ride the goal detail");
  const status = await h.raw("/api/autonomy/status");
  assert.equal(typeof status.json.counts.openPromotions, "number");
});

await test("goal evidence orders findings first and parses nothing without a store", async () => {
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id);
  await authorize(goal.id);
  // Ordinal order scrambles kinds; the evidence builder ranks findings first.
  const kinds = ["question", "finding", "blocker", "finding", "decision"];
  let i = 0;
  await tick(() => (++i <= kinds.length
    ? { thought: "note", skill: "note.append", args: { kind: kinds[i - 1], body: `note ${i}` }, done: false }
    : { thought: "done", skill: "none", args: {}, done: true }));
  const { default: db } = await import("../server/db.js");
  const built = await buildGoalEvidence(db, goal.id);
  assert.equal(built.notes.length, 5);
  assert.deepEqual(built.notes.map(n => n.kind), ["finding", "finding", "decision", "question", "blocker"]);
  assert.ok(built.notes.every(n => n.locator.startsWith("[goal_")));
  const missing = await buildGoalEvidence(db, "goal_nope");
  assert.equal(missing.goal, null);
});

test("kill switches: every registry switch is documented, and the documented names are the wired ones", async () => {
  const { readFileSync } = await import("node:fs");
  const { SKILL_REGISTRY: SKILLS } = await import("../server/skills/index.js");
  const example = readFileSync(".env.example", "utf8");
  for (const [id, skill] of Object.entries(SKILLS)) {
    assert.match(skill.killSwitch, /^COGNOS_SKILL_/, `${id} names a kill switch`);
    assert.ok(
      example.split("\n").some(line => line.startsWith(skill.killSwitch + "=")),
      `${id}: ${skill.killSwitch} is documented in .env.example`
    );
  }
});

await h.stop();

console.log(`phase20: ${passed} test(s) passed`);
