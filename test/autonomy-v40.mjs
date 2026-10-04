// v40 regression suite — the autonomy-layer cleanup.
// Each test pins a fixed bug or a sharpened edge from docs/autonomy-review.md.
// Pure units and judgeEffect/decideEffect with stub stores; no network, no DB.
import test from "node:test";
import assert from "node:assert/strict";

import { isTightening, scopeHashes } from "../server/autonomy/authorize.js";
import {
  dayStartMs, hourInTimeZone, DEFAULT_USER_TZ
} from "../server/autonomy/config.js";
import { judgeEffect, RULES } from "../server/autonomy/actionGovernor.js";
import {
  decideEffect, minimizeReceipt, rulesOf, rulesList
} from "../server/autonomy/outbox.js";
import { renderNotice, validateNoticeFields } from "../server/autonomy/notice.js";
import { stalledGoalLine } from "../server/autonomy/personality.js";
import { settingsSnapshot } from "../server/autonomy/settings.js";

// ---------------------------------------------------------------------------
// isTightening: removing a cap is not tightening it.
// ---------------------------------------------------------------------------
await test("isTightening: dropping a budget line fails, lowering passes", async () => {
  assert.equal(isTightening({ maxCostUsd: 10, maxSteps: 500 }, { maxCostUsd: 5, maxSteps: 500 }), true);
  assert.equal(isTightening({ maxCostUsd: 10, maxSteps: 500 }, { maxCostUsd: 20, maxSteps: 500 }), false);
  assert.equal(isTightening({ maxCostUsd: 10, maxSteps: 500 }, { maxCostUsd: 10 }), false,
    "removing maxSteps deletes the cap — that is not tightening");
  assert.equal(isTightening({}, { maxCostUsd: 5 }), true, "adding a cap where none was is fine");
});

// ---------------------------------------------------------------------------
// dayStartMs / hourInTimeZone: the human's day, not the server's.
// 2026-10-03T12:00:00Z is a Saturday; New York is UTC-4, so local 08:00.
// ---------------------------------------------------------------------------
await test("day boundaries follow the configured timezone", async () => {
  const noon = Date.UTC(2026, 9, 3, 12, 0, 0);
  assert.equal(hourInTimeZone(noon, "America/New_York"), 8);
  assert.equal(dayStartMs(noon, "America/New_York"), Date.UTC(2026, 9, 3, 4, 0, 0),
    "NY midnight is 04:00Z");
  // 03:00Z is still Friday in New York (23:00 Thursday local).
  assert.equal(dayStartMs(Date.UTC(2026, 9, 3, 3, 0, 0), "America/New_York"),
    Date.UTC(2026, 9, 2, 4, 0, 0));
  // No timezone: the server's local day, as before.
  const d = new Date(noon);
  d.setHours(0, 0, 0, 0);
  assert.equal(dayStartMs(noon, null), d.getTime());
  assert.equal(DEFAULT_USER_TZ, "America/New_York");
});

// ---------------------------------------------------------------------------
// Governor: malformed config records a refusal, never throws.
// ---------------------------------------------------------------------------
const SKILL_EFFECT = {
  id: "fx1", skill_id: "note.append", tier: "T1", effect_type: "internal_write",
  status: "staged", mode: "shadow", payload: { note: "x" }
};
const fakeDb = { query: async () => [{ n: 0, total: 0 }] };
const baseConfig = {
  builtTiers: ["T0", "T1", "T2", "T3", "T4", "T5"],
  rung: {}, notices: { enabled: true }, webhook: { maxBodyBytes: 32768 },
  ceiling: { maxDailyUsd: 10 }, userTimeZone: "America/New_York",
  quietHours: { enabled: false }, shadow: {}, outboxMode: "shadow"
};

await test("a malformed config is a refusal row, not a throw", async () => {
  const verdict = await judgeEffect({
    db: fakeDb, effect: SKILL_EFFECT, goal: { id: "g1", workspace_id: "ws1", budget: {} },
    authorization: null, config: { /* builtTiers missing */ }, nowMs: Date.now()
  });
  assert.equal(verdict.decision, "refuse");
  assert.ok(verdict.failed.some(f => f.rule === "CONFIG_UNREADABLE"),
    JSON.stringify(verdict.failed));
});

await test("a missing spend ceiling is unverifiable, not a crash", async () => {
  const verdict = await judgeEffect({
    db: fakeDb, effect: SKILL_EFFECT, goal: { id: "g1", workspace_id: "ws1", budget: {} },
    authorization: null, config: { ...baseConfig, ceiling: {} }, nowMs: Date.now()
  });
  assert.equal(verdict.decision, "refuse");
  assert.ok(verdict.failed.some(f => f.rule === "SPEND_UNVERIFIABLE"),
    JSON.stringify(verdict.failed));
});

// ---------------------------------------------------------------------------
// decideEffect: reverted rows replay as reverted, not refused.
// ---------------------------------------------------------------------------
await test("a reverted effect replays as reverted", async () => {
  const row = { id: "fx3", status: "reverted", tier: "T4", mode: "shadow",
    verdict: { decision: "revert", revertedFrom: "released" } };
  const out = await decideEffect({
    db: { AutonomyOutbox: { get: async () => row } },
    effectId: "fx3", goal: { id: "g1" }, config: baseConfig
  });
  assert.equal(out.ok, true);
  assert.equal(out.replayed, true);
  assert.deepEqual(out.verdict, row.verdict);
});

// ---------------------------------------------------------------------------
// decideEffect: shadow rows are not stamped with a release time.
// ---------------------------------------------------------------------------
await test("a would_release row carries no releasedMs", async () => {
  const seen = {};
  const row = { id: "fx4", skill_id: "notice.emit", tier: "T2", effect_type: "notify",
    status: "staged", mode: "shadow",
    payload: { templateId: "finding_ready",
      fields: { goalTitle: "x", agentName: "y", findings: 1, sourcesProduced: 0 } } };
  const db = {
    query: async () => [{ n: 0, total: 0 }],
    AutonomyOutbox: {
      get: async () => row,
      setVerdict: async (id, patch) => { Object.assign(seen, patch); return { ...row, ...patch }; }
    },
    OutboxEvent: { append: async () => null },
    GoalEvent: { append: async () => null }
  };
  const scope = { effectsAllowed: ["notify"] };
  const budget = {};
  const hashes = scopeHashes({ goalId: "g1", scope, budget });
  const out = await decideEffect({
    db, effectId: "fx4",
    goal: { id: "g1", workspace_id: "ws1", budget, scope },
    authorization: { decision: "authorize", scope_sha256: hashes.scopeSha256,
      budget_sha256: hashes.budgetSha256, expires_at_ms: Date.now() + 60000 },
    config: baseConfig, mode: "shadow"
  });
  assert.equal(out.ok, true);
  assert.equal(out.wouldRelease, true);
  assert.equal(seen.status, "would_release");
  assert.ok(!("releasedMs" in seen) || seen.releasedMs == null,
    "nothing was performed, so no release timestamp may be recorded");
});

// ---------------------------------------------------------------------------
// minimizeReceipt: a failed delivery keeps the actionable rule.
// ---------------------------------------------------------------------------
await test("a minimized failure receipt keeps the rule", async () => {
  const mini = minimizeReceipt({ failed: true, attempts: 2, redirects: 1, rule: "TIMEOUT" });
  assert.deepEqual(mini, { failed: true, rule: "TIMEOUT", attempts: 2, redirects: 1 });
});

// ---------------------------------------------------------------------------
// rulesOf / rulesList live on the outbox now (deduplicated).
// ---------------------------------------------------------------------------
await test("rulesOf and rulesList are shared from the outbox", async () => {
  const verdict = { failed: [{ rule: "A" }, { rule: "B" }, {}] };
  assert.deepEqual(rulesList(verdict), ["A", "B"]);
  assert.equal(rulesOf(verdict), "A, B");
  assert.equal(rulesOf({ failed: [] }), "refused");
});

// ---------------------------------------------------------------------------
// Notices: warm, plain, bounded, deterministic.
// ---------------------------------------------------------------------------
await test("notice templates speak plainly and stay bounded", async () => {
  const parked = renderNotice("goal_parked", {
    goalTitle: "Track the county record", agentName: "Recorder",
    parkReason: "budget_exhausted", stepsExecuted: 12, findings: 3, effectsAwaitingApproval: 2
  });
  assert.match(parked, /is on pause/);
  assert.match(parked, /ran out of budget/);
  assert.match(parked, /12 steps done, 3 findings saved/);
  assert.match(parked, /2 things are waiting on your word/);

  const one = renderNotice("goal_parked", {
    goalTitle: "x", agentName: "y", parkReason: "paused_by_user",
    stepsExecuted: 1, findings: 1, effectsAwaitingApproval: 1
  });
  assert.match(one, /1 step done, 1 finding saved/);
  assert.match(one, /One thing is waiting on your word/);

  const done = renderNotice("goal_completed", {
    goalTitle: "Write the brief", agentName: "Piper", stepsExecuted: 5, findings: 2
  });
  assert.match(done, /is done/);
  assert.match(done, /Ask me about it/);

  const found = renderNotice("finding_ready", {
    goalTitle: "Research", agentName: "Atlas", findings: 3, sourcesProduced: 2
  });
  assert.match(found, /Atlas found 3 new findings/);
  assert.match(found, /2 saved copies/);

  const warn = renderNotice("budget_warning", {
    goalTitle: "Nightly sweep", agentName: "Scout",
    budgetLine: "maxCostUsd", spent: 4.2, limit: 5
  });
  assert.match(warn, /Heads up/);
  // Number fields truncate by validation discipline: 4.2 -> 4.
  assert.match(warn, /\$4\.00 of \$5\.00/);

  for (const text of [parked, one, done, found, warn]) {
    assert.ok(text.length <= 240, "notices stay bounded");
    assert.equal(text.includes("<"), false, "no markup in notices");
  }
  // Deterministic: same fields, same string.
  assert.equal(renderNotice("goal_parked", {
    goalTitle: "x", agentName: "y", parkReason: "paused_by_user",
    stepsExecuted: 1, findings: 1, effectsAwaitingApproval: 0
  }), renderNotice("goal_parked", {
    goalTitle: "x", agentName: "y", parkReason: "paused_by_user",
    stepsExecuted: 1, findings: 1, effectsAwaitingApproval: 0
  }));
  // The validation discipline is untouched.
  assert.equal(validateNoticeFields("goal_parked", { prose: "smuggle" }).ok, false);
});

// ---------------------------------------------------------------------------
// stalledGoalLine: the STALL_MS constant is the threshold (no drift).
// ---------------------------------------------------------------------------
await test("the stall threshold is the constant, not a hardcoded 4", async () => {
  const dayMs = 86400_000;
  const mkDb = (touchedMs) => ({
    query: async () => [{ title: "Quiet goal", touched: new Date(touchedMs).toISOString() }]
  });
  const now = Date.now();
  const fresh = await stalledGoalLine({ db: mkDb(now - 1 * dayMs), workspaceId: "ws1", nowMs: now });
  assert.equal(fresh, null, "a goal touched yesterday earns no line");
  const stale = await stalledGoalLine({ db: mkDb(now - 5 * dayMs), workspaceId: "ws1", nowMs: now });
  assert.ok(stale && stale.includes("quiet for 5 days"), JSON.stringify(stale));
});

// ---------------------------------------------------------------------------
// settingsSnapshot: mutating the snapshot must not mutate the module cache.
// ---------------------------------------------------------------------------
await test("settingsSnapshot isolates its rungs object", async () => {
  const a = settingsSnapshot();
  const b = settingsSnapshot();
  assert.notEqual(a.rungs, b.rungs, "each snapshot gets its own rungs object");
  a.rungs.__probe = true;
  assert.equal(settingsSnapshot().rungs.__probe, undefined,
    "a caller mutating a snapshot must not poison the cache");
});

// ---------------------------------------------------------------------------
// RULES values stay human-readable; keys stay stable for the evidence gate.
// ---------------------------------------------------------------------------
await test("refusal rule ids are stable, reasons are plain language", async () => {
  for (const key of ["UNKNOWN_SKILL", "TIER_NOT_BUILT", "EFFECT_NOT_IN_SCOPE",
    "DESTINATION_NOT_IN_SCOPE", "GOAL_BUDGET_EXHAUSTED", "WORKSPACE_CEILING",
    "SECRET_IN_PAYLOAD", "UNSAFE_URL", "QUIET_HOURS", "EVIDENCE_GATE_UNMET",
    "OPERATOR_REFUSED", "SPEND_UNVERIFIABLE", "EVIDENCE_UNREADABLE",
    "APPROVAL_UNREADABLE", "CONFIG_UNREADABLE", "BODY_REQUIRED"]) {
    assert.ok(typeof RULES[key] === "string" && RULES[key].length > 0, key);
  }
  assert.match(RULES.UNSAFE_URL, /safety check/);
  assert.ok(!/SSRF|registry|tier/i.test(RULES.UNKNOWN_SKILL + RULES.TIER_NOT_BUILT),
    "no internal jargon in the two most-seen reasons");
});
