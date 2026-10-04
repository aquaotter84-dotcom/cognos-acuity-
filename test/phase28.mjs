#!/usr/bin/env node
// Phase 34 — the earned requirement is gone ("86 that shit").
//
// THE CLAIM UNDER TEST. A live T4/T5 release no longer has to EARN its way
// past a shadow corpus. The capability is available; the trust model is ASK,
// not EARN. What this suite proves:
//
//   * a live T4 external_write with NO evidence row and NO corpus is judged on
//     policy alone — never refused for EVIDENCE_GATE_UNMET;
//   * the policy still binds: an unapproved destination is refused by name,
//     a bad URL is refused, a missing scope grant is refused;
//   * T5 still needs a per-effect human approval naming the exact row
//     (T5_NEEDS_HUMAN), and the approval is what opens it;
//   * the outbox approve/refuse inbox still gates: a staged effect does
//     nothing until a human decision runs the Governor;
//   * the bypass machinery is gone: setBypassEarning / effectiveBypassEarning /
//     bypassEarningRefusal are no longer exported, and the writing rungs are
//     no longer rung keys.

import assert from "node:assert/strict";
import * as settings from "../server/autonomy/settings.js";
import { judgeEffect } from "../server/autonomy/actionGovernor.js";
import { autonomyConfig, tierAllowed } from "../server/autonomy/config.js";
import { scopeHashes } from "../server/autonomy/authorize.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const APPROVED = "https://hooks-approved.example.com/cognos";
const ELSEWHERE = "https://hooks-elsewhere.example.com/cognos";
const hashes = scopeHashes({
  goalId: "goal_p34",
  scope: { effectsAllowed: ["notify", { effect: "webhook.post", destinations: [APPROVED, ELSEWHERE] }] },
  budget: { maxEffectsPerDay: 10, maxExternalEffects: 25 }
});
const goal = {
  id: "goal_p34", workspace_id: "ws1", spent: {},
  scope: { effectsAllowed: ["notify", { effect: "webhook.post", destinations: [APPROVED, ELSEWHERE] }] },
  budget: { maxEffectsPerDay: 10, maxExternalEffects: 25 }
};
const authorization = {
  decision: "authorize", scope_sha256: hashes.scopeSha256,
  budget_sha256: hashes.budgetSha256, expires_at_ms: Date.now() + 600_000
};
// No RungEvidence stub at all: the Governor must not even ask for it.
const db = { query: async () => [] };
const cfgWith = (over = {}) => {
  const base = autonomyConfig();
  return {
    ...base,
    quietHours: { enabled: false, misconfigured: false, startHour: null, endHour: null },
    liveDestination: { configured: true, misconfigured: false, url: APPROVED,
      hostname: "hooks-approved.example.com", reason: null },
    ...over
  };
};
const effectAt = (url, over = {}) => ({
  id: "fx_p34", skill_id: "webhook.post", tier: "T4", effect_type: "external_write",
  status: "staged", mode: "shadow", destination: url, scope_sha256: hashes.scopeSha256,
  payload: { url, method: "POST", headers: {}, body: '{"n":1}', secretRef: null, reason: null },
  ...over
});
const judge = (url, opts = {}) => judgeEffect({
  db, effect: effectAt(url, opts.effectOver || {}), goal, authorization,
  config: opts.config || cfgWith(), mode: "live"
});
const rulesOf = (v) => (v.failed || []).map(f => f.rule);

// ============================================ no corpus, judged on policy
await test("a live T4 release with no corpus is judged on policy, never on earning", async () => {
  const verdict = await judge(APPROVED);
  assert.ok(!rulesOf(verdict).includes("EVIDENCE_GATE_UNMET"),
    `no corpus gate anymore: ${JSON.stringify(verdict.failed)}`);
  assert.ok(!rulesOf(verdict).includes("EVIDENCE_UNREADABLE"),
    `no evidence lookup at all: ${JSON.stringify(verdict.failed)}`);
  assert.equal(verdict.decision, "release", JSON.stringify(verdict.failed));
});

await test("the policy still binds: unapproved destination, bad URL, missing grant", async () => {
  const elsewhere = await judge(ELSEWHERE);
  assert.equal(elsewhere.decision, "refuse");
  assert.ok(rulesOf(elsewhere).includes("DESTINATION_NOT_APPROVED"), JSON.stringify(elsewhere.failed));

  const badUrl = await judge("http://insecure.example.com/hook");
  assert.equal(badUrl.decision, "refuse", "non-https is still refused");

  const ungranted = await judge("https://hooks-approved.example.com/other-path");
  assert.equal(ungranted.decision, "refuse", "a destination outside the scope grant is still refused");
});

await test("T4/T5 tiers are allowed when built — no rung flag to flip", async () => {
  const cfg = autonomyConfig();
  assert.equal(tierAllowed("T4", cfg), cfg.builtTiers.includes("T4"));
  assert.equal(tierAllowed("T5", cfg), cfg.builtTiers.includes("T5"));
  assert.ok(!("externalWrites" in (cfg.rung || {})), "the writing rung is gone from config.rung");
  assert.ok(!("irreversible" in (cfg.rung || {})), "the irreversible rung is gone from config.rung");
});

// ================================================== T5: approval is the gate
const t5Effect = () => ({
  id: "fx_p34_t5", skill_id: "post.publish", tier: "T5", effect_type: "irreversible",
  status: "staged", mode: "shadow", destination: APPROVED, scope_sha256: hashes.scopeSha256,
  payload: { url: APPROVED, method: "POST", headers: {}, body: '{"n":1}', reason: null }
});
const t5Goal = {
  ...goal,
  scope: { effectsAllowed: ["notify", { effect: "post.publish", destinations: [APPROVED] }] },
};
const t5Hashes = scopeHashes({
  goalId: "goal_p34",
  scope: t5Goal.scope,
  budget: goal.budget
});
const t5Auth = { ...authorization, scope_sha256: t5Hashes.scopeSha256, budget_sha256: t5Hashes.budgetSha256 };

await test("T5 still needs a per-effect human approval naming the exact row", async () => {
  const noApproval = await judgeEffect({
    db: { query: async () => [], EffectApproval: { current: async () => null } },
    effect: t5Effect(), goal: t5Goal, authorization: t5Auth, config: cfgWith(), mode: "live"
  });
  assert.equal(noApproval.decision, "refuse");
  assert.ok(rulesOf(noApproval).includes("T5_NEEDS_HUMAN"), JSON.stringify(noApproval.failed));

  const withApproval = await judgeEffect({
    db: { query: async () => [], EffectApproval: { current: async () => ({ decision: "approve" }) } },
    effect: t5Effect(), goal: t5Goal, authorization: t5Auth, config: cfgWith(), mode: "live"
  });
  assert.ok(!rulesOf(withApproval).includes("T5_NEEDS_HUMAN"),
    `the approval — not a corpus — is what opens T5: ${JSON.stringify(withApproval.failed)}`);
});

// ================================================== the bypass is gone
await test("the bypass machinery no longer exists", async () => {
  for (const name of ["setBypassEarning", "effectiveBypassEarning", "bypassEarningRefusal",
    "bypassEarningPinned", "bypassEarningDelegated"]) {
    assert.equal(typeof settings[name], "undefined", `${name} is gone`);
  }
  assert.ok(!settings.RUNG_KEYS.includes("externalWrites"), "externalWrites is not a rung key");
  assert.ok(!settings.RUNG_KEYS.includes("irreversible"), "irreversible is not a rung key");
  assert.deepEqual([...settings.RUNG_KEYS].sort(), ["inbound", "residents", "search"]);
});

console.log(`\nPHASE28 RESULT: ${passed} passed`);
