#!/usr/bin/env node
// Phase 22 (autonomy row), first slice: EARN-AND-FLIP LIVE FOR T4 ONLY.
//
// What this file has to prove is not "live webhooks work" — Phase 21 proved the
// adapter. It is that the distance between "built" and "delivers" is now a
// RECORDED DECISION rather than a restart, and that the decision is refused
// until it is earned:
//
//   * the outbox mode rests at shadow, and absence of a stored mode is shadow;
//   * widening to live is refused unless a recorded evidence row still
//     satisfies the gate as configured now, the rung flag is on, autonomy is
//     running, exactly one destination is approved, and the earned corpus was
//     aimed at that destination;
//   * narrowing is refused by nothing — a brake an operator has to earn is not
//     a brake;
//   * an operator's environment value may hold the mode down and may never be
//     widened from a request;
//   * a live delivery is confined to the approved destination IN ADDITION TO
//     the goal's scope grant, and an unset or malformed approval fails closed;
//   * shadow judging is untouched, because the corpus is what earns the rung;
//   * T5 is still refused outright, and nothing here widened a rung, a ceiling,
//     a skill or a budget.
//
// Deterministic and local, on the same two seams Phase 21 uses: live deliveries
// go to a loopback sink through the injected transport, and the resolver is a
// stub that answers "public" so the SSRF gate is not what is under test.

import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import {
  autonomyConfig, resolveLiveDestination, liveDestinationCovers, LIVE_DESTINATION_ENV
} from "../server/autonomy/config.js";
import {
  effectiveOutboxMode, outboxModeSource, isWideningOutboxMode, applyOutboxModeCache,
  resetSettingsCache, envOutboxMode, OUTBOX_MODE_ENV, OUTBOX_UI_CONTROL_ENV, OUTBOX_MODES
} from "../server/autonomy/settings.js";
import { judgeEffect } from "../server/autonomy/actionGovernor.js";
import { LAWS, LAW_LAYER_VERSION } from "../server/council/laws.js";
import { evaluateAdaptation } from "../server/meta/policy.js";
import { IDENTITY_VERSION } from "../server/identity.js";
import { describeLiveReadiness, setOutboxMode, OUTBOX_MODE_AUDIT_ACTION } from "../server/autonomy/liveOutbox.js";
import { scopeHashes } from "../server/autonomy/authorize.js";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ----------------------------------------------------------------- fixtures
const APPROVED = "https://hooks-approved.example.com/cognos";
const ELSEWHERE = "https://hooks-elsewhere.example.com/cognos";
const UNGRANTED = "https://never-granted.example.com/hook";
const BODY = (n) => JSON.stringify({ event: "corpus.sample", n });

const ALL_SKILLS = ["note.append", "evidence.read", "memory.search", "belief.search",
  "source.snapshot", "note.promote.request", "notice.emit",
  "subagent.spawn", "web.fetch", "web.search", "webhook.post"];

/** A resolver that answers "public". The SSRF gate is Phase 21's subject. */
const publicResolve = async () => [{ address: "93.184.216.34", family: 4 }];

// ======================================================= pure: the destination
await test("the approved destination fails closed in every shape that is not one https endpoint", async () => {
  const withEnv = (value) => {
    const prev = process.env[LIVE_DESTINATION_ENV];
    if (value === null) delete process.env[LIVE_DESTINATION_ENV];
    else process.env[LIVE_DESTINATION_ENV] = value;
    try { return resolveLiveDestination(); }
    finally {
      if (prev === undefined) delete process.env[LIVE_DESTINATION_ENV];
      else process.env[LIVE_DESTINATION_ENV] = prev;
    }
  };

  // Unset is not "anywhere". It is "nowhere", and it says so without a reason
  // string that would have to be invented.
  const unset = withEnv(null);
  assert.equal(unset.configured, false);
  assert.equal(unset.misconfigured, false, "unset is not a mistake, it is the resting state");
  assert.equal(unset.url, null);

  const empty = withEnv("   ");
  assert.equal(empty.configured, false, "an empty value is unset, not a wildcard");
  assert.equal(empty.misconfigured, false);

  // Every shape the adapter itself would refuse is refused here too, because
  // this reads through checkWebhookUrl rather than keeping a second opinion.
  for (const bad of [
    "http://hooks.example.com/cognos",                       // not https
    "https://user:pass@hooks.example.com/cognos",            // credentials
    "https://127.0.0.1/cognos",                              // literal IP
    "https://localhost/cognos",                              // local hostname
    "https://hooks.example.com:8443/cognos",                 // not 443
    "not a url at all"
  ]) {
    const out = withEnv(bad);
    assert.equal(out.configured, false, `${bad} is not an approval`);
    assert.equal(out.misconfigured, true, `${bad} is reported as a misconfiguration, not silently ignored`);
    assert.ok(String(out.reason || "").length > 5, `${bad} says why`);
    assert.equal(out.url, null, "and a malformed approval grants no destination");
  }

  const good = withEnv(APPROVED);
  assert.equal(good.configured, true);
  assert.equal(good.misconfigured, false);
  assert.equal(good.url, APPROVED);
  assert.equal(good.hostname, "hooks-approved.example.com");
});

await test("one approved destination covers that destination, and nothing else", async () => {
  const dest = Object.freeze({ configured: true, misconfigured: false, url: APPROVED,
    hostname: "hooks-approved.example.com", reason: null });

  assert.equal(liveDestinationCovers(dest, APPROVED).allowed, true, "exact match");
  assert.equal(liveDestinationCovers(dest, `${APPROVED}/deeper`).allowed, false,
    "an exact URL entry is exact: a subpath is a different endpoint");
  assert.equal(liveDestinationCovers(dest, ELSEWHERE).allowed, false);
  assert.equal(liveDestinationCovers(dest, "https://hooks-approved.example.com/other").allowed, false);
  assert.equal(liveDestinationCovers(dest, "").allowed, false, "no destination is not the approved one");

  // Unset and malformed both refuse, with different sentences: an operator who
  // typed a bad value needs to be told the value is bad, not that it is missing.
  const unset = liveDestinationCovers({ configured: false, misconfigured: false }, APPROVED);
  assert.equal(unset.allowed, false);
  assert.match(unset.reason, /no approved destination is set/);
  const broken = liveDestinationCovers({ configured: false, misconfigured: true, reason: "not https" }, APPROVED);
  assert.equal(broken.allowed, false);
  assert.match(broken.reason, /misconfigured/);
});

// ==================================================== pure: mode precedence
await test("the mode is the narrower of an operator pin and a delegated row, and rests at shadow", async () => {
  const withEnv = (value, fn) => {
    const prev = process.env[OUTBOX_MODE_ENV];
    if (value === null) delete process.env[OUTBOX_MODE_ENV];
    else process.env[OUTBOX_MODE_ENV] = value;
    try { return fn(); }
    finally {
      if (prev === undefined) delete process.env[OUTBOX_MODE_ENV];
      else process.env[OUTBOX_MODE_ENV] = prev;
    }
  };
  const setRow = (mode) => { resetSettingsCache(); if (mode !== null) applyOutboxModeCache(mode); };

  try {
    // Absence of both is the resting state. Absence is OFF, never a default-on.
    setRow(null);
    assert.equal(withEnv(null, effectiveOutboxMode), "shadow");
    assert.equal(withEnv(null, outboxModeSource), "default-off");

    // An earned, delegated flip with no environment value.
    setRow("live");
    assert.equal(withEnv(null, effectiveOutboxMode), "live");
    assert.equal(withEnv(null, outboxModeSource), "ui");

    // A pin DOWN is final: the row cannot widen past it.
    setRow("live");
    assert.equal(withEnv("shadow", effectiveOutboxMode), "shadow");
    assert.equal(withEnv("shadow", outboxModeSource), "env-pin");
    setRow("live");
    assert.equal(withEnv("dry_run", effectiveOutboxMode), "dry_run");

    // The Phase 21 behaviour is unchanged: an environment live with no row is live.
    setRow(null);
    assert.equal(withEnv("live", effectiveOutboxMode), "live");
    assert.equal(withEnv("live", outboxModeSource), "env-pin");

    // The one asymmetry, and the reason for it: a pin may hold the system down,
    // never hold it out. An operator who pinned live can still brake from a
    // running system, because a brake they cannot reach is not a brake.
    setRow("shadow");
    assert.equal(withEnv("live", effectiveOutboxMode), "shadow");
    assert.equal(withEnv("live", outboxModeSource), "ui");

    // An unrecognisable environment value is not a mode. It reads as unset and
    // falls through to the resting state rather than failing open.
    setRow(null);
    assert.equal(withEnv("LIVE!", effectiveOutboxMode), "shadow");
    assert.equal(withEnv("LIVE!", envOutboxMode), null);
    setRow(null);
    assert.equal(withEnv("", effectiveOutboxMode), "shadow", "an empty value is OFF, not live");

    // An unrecognisable stored value is not a permission either.
    resetSettingsCache();
    applyOutboxModeCache("sideways");
    assert.equal(withEnv(null, effectiveOutboxMode), "shadow");

    assert.equal(isWideningOutboxMode("shadow", "live"), true);
    assert.equal(isWideningOutboxMode("shadow", "dry_run"), true);
    assert.equal(isWideningOutboxMode("dry_run", "live"), true);
    assert.equal(isWideningOutboxMode("live", "shadow"), false, "narrowing is never a widening");
    assert.equal(isWideningOutboxMode("live", "live"), false);
    assert.deepEqual([...OUTBOX_MODES], ["shadow", "dry_run", "live"]);
  } finally {
    resetSettingsCache();
  }
});

// =============================================== pure: the Governor's new rule
const hashes = scopeHashes({
  goalId: "goal_live", scope: { effectsAllowed: ["notify", { effect: "webhook.post", destinations: [APPROVED, ELSEWHERE] }] },
  budget: { maxEffectsPerDay: 10, maxExternalEffects: 25 }
});
const governedGoal = {
  id: "goal_live", workspace_id: "ws1", spent: {},
  scope: { effectsAllowed: ["notify", { effect: "webhook.post", destinations: [APPROVED, ELSEWHERE] }] },
  budget: { maxEffectsPerDay: 10, maxExternalEffects: 25 }
};
const governedAuth = {
  decision: "authorize", scope_sha256: hashes.scopeSha256,
  budget_sha256: hashes.budgetSha256, expires_at_ms: Date.now() + 600_000
};
const fakeDb = (evidenceRow) => ({
  query: async () => [{ total: 0, n: 0 }],
  RungEvidence: { currentJustified: async () => evidenceRow }
});
const evidence = (samples = 25, falseReleaseCount = 0) => ({
  id: "rev_live", rung: "external_writes", tier: "T4", decision: "justified",
  metrics: { samples, falseReleaseCount }, gate: { minSamples: 25, maxFalseReleases: 0 },
  metrics_sha256: "b".repeat(64), decided_ms: Date.now()
});
const cfgWith = (over = {}) => {
  const base = autonomyConfig();
  return {
    ...base,
    rung: { ...base.rung, externalWrites: true },
    quietHours: { enabled: false, misconfigured: false, startHour: null, endHour: null },
    liveDestination: { configured: true, misconfigured: false, url: APPROVED,
      hostname: "hooks-approved.example.com", reason: null },
    ...over
  };
};
const effectAt = (url) => ({
  id: "fx_live", skill_id: "webhook.post", tier: "T4", effect_type: "external_write",
  status: "staged", mode: "shadow", destination: url, scope_sha256: hashes.scopeSha256,
  payload: { url, method: "POST", headers: {}, body: BODY(1), secretRef: null, reason: null }
});
const judge = (url, opts = {}) => judgeEffect({
  db: opts.db ?? fakeDb(evidence()), effect: effectAt(url), goal: governedGoal,
  authorization: governedAuth, config: opts.config ?? cfgWith(), mode: opts.mode ?? "live"
});
const rulesOf = (verdict) => (verdict.failed || []).map(f => f.rule);

await test("a live write needs BOTH gates: the goal's grant and the deployment's approval", async () => {
  // Granted in scope AND approved: released.
  const both = await judge(APPROVED);
  assert.equal(both.decision, "release", JSON.stringify(both.failed));
  assert.ok(both.passed.some(p => /approved live endpoint/.test(p)));
  assert.equal(both.mode, "live");

  // Granted in scope, NOT approved: refused by name. This is the case the slice
  // exists for — a goal a human authorized to act somewhere the deployment did
  // not name.
  const grantedOnly = await judge(ELSEWHERE);
  assert.equal(grantedOnly.decision, "refuse");
  assert.ok(rulesOf(grantedOnly).includes("DESTINATION_NOT_APPROVED"), JSON.stringify(grantedOnly.failed));
  assert.ok(!rulesOf(grantedOnly).includes("DESTINATION_NOT_IN_SCOPE"),
    "the scope grant is intact; it is the deployment's approval that is missing");
  assert.equal(grantedOnly.failed.find(f => f.rule === "DESTINATION_NOT_APPROVED").law,
    "pin.live_destination_approved");

  // Neither: both rules fire, and a refusal names every gate it failed.
  const neither = await judge(UNGRANTED);
  assert.ok(rulesOf(neither).includes("DESTINATION_NOT_IN_SCOPE"));
  assert.ok(rulesOf(neither).includes("DESTINATION_NOT_APPROVED"));

  // No approval configured at all: fail closed, and say which variable is unset.
  const noApproval = await judge(APPROVED, {
    config: cfgWith({ liveDestination: { configured: false, misconfigured: false, reason: null } })
  });
  assert.equal(noApproval.decision, "refuse");
  assert.match(noApproval.failed.find(f => f.rule === "DESTINATION_NOT_APPROVED").reason,
    /COGNOS_AUTONOMY_LIVE_DESTINATION/);
});

await test("shadow judging is untouched, because the shadow corpus is what earns the rung", async () => {
  // The same effect the live judge just refused is RELEASED in shadow — recorded
  // as would_release, performed by nothing. Refusing shadow samples would starve
  // the gate that is supposed to decide whether live is safe.
  const shadow = await judge(ELSEWHERE, { mode: "shadow", db: fakeDb(null) });
  assert.equal(shadow.decision, "release", JSON.stringify(shadow.failed));
  assert.ok(!rulesOf(shadow).includes("DESTINATION_NOT_APPROVED"));
  assert.ok(!rulesOf(shadow).includes("EVIDENCE_GATE_UNMET"),
    "shadow asks no evidence question; that is what makes a corpus possible");

  // And a live verdict still asks the evidence question first: the destination
  // gate is an addition to Phase 21's, not a replacement for it.
  const noEvidence = await judge(APPROVED, { db: fakeDb(null) });
  assert.ok(rulesOf(noEvidence).includes("EVIDENCE_GATE_UNMET"), JSON.stringify(noEvidence.failed));
});

// ============================================================ pure: the laws
await test("the two new pins are laws, and the Policy Engine cites them at runtime", async () => {
  const ids = LAWS.map(l => l.id);
  for (const id of ["pin.live_destination_approved", "pin.live_mode_earned"]) {
    assert.ok(ids.includes(id), `${id} is a law`);
    const law = LAWS.find(l => l.id === id);
    assert.equal(law.layer, "operational");
    assert.equal(law.runtime_modifiable, false, `${id} cannot be modified at runtime`);
    assert.ok(String(law.statement).length > 40, `${id} says something`);
    assert.ok(Array.isArray(law.forbids) && law.forbids.length >= 3, `${id} names what it forbids`);
    assert.match(law.source, /Phase 22/);
  }

  // A floor, not an exact number: Phase 21 shipped 1.6.0 and this slice bumped
  // the layer for the two pins above.
  const [maj, min] = LAW_LAYER_VERSION.split(".").map(Number);
  assert.ok(maj > 1 || (maj === 1 && min >= 7), `the law layer is at least 1.7.0; it is ${LAW_LAYER_VERSION}`);

  const proposal = (action, params = {}) => evaluateAdaptation({
    action, params,
    justification: "The corpus is earned and the code is written, so widen the outbox to live.",
    law_refs: ["pin.live_mode_earned"],
    evidence: { shadowSamples: 25, falseReleases: 0 }
  });

  const rung = proposal("set_autonomy_rung", { rung: "external_writes" });
  assert.equal(rung.decision, "refused");
  assert.ok(rung.violations.some(v => v.law === "pin.live_mode_earned"), JSON.stringify(rung.violations));
  assert.ok(rung.violations.some(v => v.law === "pin.external_write_earned"));
  assert.equal(rung.applied, false);

  const channel = proposal("enable_outbound_channel", { killSwitch: "COGNOS_AUTONOMY_EXTERNAL_WRITES" });
  assert.equal(channel.decision, "refused");
  assert.ok(channel.violations.some(v => v.law === "pin.live_destination_approved"),
    JSON.stringify(channel.violations));

  // T5 is untouched by this slice: still refused outright, still never
  // class-authorized, and still a false release by definition in any corpus.
  const t5 = await judgeEffect({
    db: fakeDb(evidence(500)), effect: { ...effectAt(APPROVED), tier: "T5", skill_id: "webhook.post" },
    goal: governedGoal, authorization: governedAuth, config: cfgWith(), mode: "live"
  });
  assert.equal(t5.decision, "refuse");
  assert.ok(rulesOf(t5).includes("T5_NEEDS_HUMAN"), JSON.stringify(t5.failed));
});

// ================================================================ the harness
console.log("\noutbox-live: a deployment that delegated the mode and named one destination");

const h = await bootHarness({
  COGNOS_AUTONOMY_ENABLED: "true",
  COGNOS_AUTONOMY_RESIDENTS: "true",
  COGNOS_AUTONOMY_NOTICE_MODE: "internal",
  COGNOS_AUTONOMY_EXTERNAL_WRITES: "true",
  COGNOS_AUTONOMY_OUTBOX_UI_CONTROL: "true",
  COGNOS_AUTONOMY_LIVE_DESTINATION: APPROVED,
  COGNOS_AUTONOMY_OUTBOX_MODE: null
});
resetSettingsCache();

const count = async (table, where = "", params = []) =>
  Number((await h.sql(`SELECT COUNT(*)::int AS n FROM ${table}${where}`, params))[0]?.n || 0);
const json = (value, fallback = null) => {
  if (value == null) return fallback;
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return fallback; } }
  return value;
};

async function makeAgent() {
  const created = await h.raw("/api/autonomy/agents", {
    method: "POST",
    body: { name: `Live${Date.now()}${Math.floor(Math.random() * 1e6)}`, purpose: "outbox-live",
      brief: "v1", skill_allowlist: ALL_SKILLS }
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json;
}

/** Both endpoints are granted in scope, so the only thing separating them is
 *  the deployment's approval — which is exactly the distinction under test. */
async function makeGoal(agentId, { destinations = [APPROVED, ELSEWHERE], title = "Live gate goal" } = {}) {
  const made = await h.raw("/api/autonomy/goals", {
    method: "POST",
    body: {
      title, objective: "Prove the earned-live gates.", agent_id: agentId,
      scope: { effectsAllowed: ["notify", { effect: "webhook.post", destinations }] }
    }
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const yes = await h.raw(`/api/autonomy/goals/${made.json.goal.id}/decision`, {
    method: "POST", body: { decision: "authorize" }
  });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  return made.json.goal;
}

await test("the surfaces report the mode as three facts before anything is earned", async () => {
  const status = await h.raw("/api/autonomy/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.outboxMode, "shadow", "the resting state");
  assert.equal(status.json.outboxModeSource, "default-off", "nobody has flipped it");
  assert.equal(status.json.canSetOutboxMode, true, "this deployment delegated the mode");
  assert.equal(status.json.outboxRefusal, null);
  assert.equal(status.json.liveDestination.configured, true);
  assert.equal(status.json.liveDestination.hostname, "hooks-approved.example.com");
  assert.equal(status.json.liveDestination.env, LIVE_DESTINATION_ENV);
  // A privacy regression, not a convenience assertion. The flip's audit row
  // digests the destination rather than storing it, citing
  // pin.receipt_metadata_only; a served configuration object is read by the same
  // audience, so it reports the host and whether the deployment picked the value
  // up, and nothing that carries the path. Two surfaces reporting the same value
  // at different fidelity is how a URL leaks from the one that was not thinking
  // about it.
  assert.equal(status.json.liveDestination.url, undefined, "no served surface publishes the approved URL");
  assert.equal(status.json.liveDestination.requested, undefined, "nor the raw value the operator typed");
  assert.ok(!JSON.stringify(status.json).includes("hooks-approved.example.com/cognos"),
    "and the whole status body is free of the endpoint");

  const writes = status.json.externalWrites;
  assert.equal(writes.built, true);
  assert.equal(writes.rungEnabled, true);
  assert.equal(writes.deliversNow, false, "shadow: the loop performs nothing");
  assert.equal(writes.deliversOnApproval, true,
    "and an approval is a live decision whatever the loop's mode is — the two facts are reported separately");
  assert.equal(writes.requiresApprovedDestination, true);
  assert.equal(writes.approvedDestinationConfigured, true);

  const rungs = await h.raw("/api/autonomy/rungs");
  assert.equal(rungs.status, 200);
  assert.equal(rungs.json.live.ready, false, "nothing has earned a flip yet");
  assert.ok(rungs.json.live.unmet.includes("evidence_recorded"), JSON.stringify(rungs.json.live.unmet));
  assert.equal(rungs.json.live.destination.hostname, "hooks-approved.example.com");
  assert.equal(rungs.json.live.destination.url, undefined,
    "the readiness report names the host, not the endpoint");
  assert.equal(rungs.json.canSetOutboxMode, true);

  // The identity manifest and the agent-tools surface agree with the status
  // route, because a reader that consults only one of them gets a different
  // system than the one that is running.
  const identity = await h.raw("/api/identity");
  const runtime = identity.json.runtime.autonomy.externalWrites;
  assert.equal(runtime.deliversNow, false);
  assert.equal(runtime.deliversOnApproval, true);
  assert.equal(runtime.approvedDestinationConfigured, true);
  assert.equal(runtime.requiresApprovedDestination, true);
  assert.equal(identity.json.version, IDENTITY_VERSION, "the manifest this slice changed is the one served");

  const tools = await h.raw("/api/agent/tools");
  assert.equal(tools.json.autonomy.externalWrites.deliversNow, false);
  assert.equal(tools.json.autonomy.externalWrites.deliversOnApproval, true);
});

await test("widening to live is refused before it is earned, and the refusal is a list of things to do", async () => {
  const attempt = await h.raw("/api/autonomy/settings", {
    method: "POST", body: { outboxMode: "live", updated_by: "outbox-live-suite" }
  });
  assert.equal(attempt.status, 409, JSON.stringify(attempt.json));
  assert.equal(attempt.json.code, "live_not_earned");
  assert.equal(attempt.json.changed, false);
  assert.equal(attempt.json.mode, "shadow", "the truth is returned with the refusal");
  assert.ok(attempt.json.unmet.includes("evidence_recorded"), JSON.stringify(attempt.json.unmet));
  assert.match(attempt.json.error, /evidence/i, "the sentence says what is missing");
  assert.match(attempt.json.error, /rungs\/external_writes\/evidence|Outbox tab/,
    "and says where to go");

  // No row was written by a refused flip, and nothing was audited: an attempt
  // that changed nothing must not look like a decision somebody made.
  assert.equal(await count("autonomy_settings", " WHERE outbox_mode IS NOT NULL"), 0);
  assert.equal(await count("workspace_audit", " WHERE action=$1", [OUTBOX_MODE_AUDIT_ACTION]), 0);

  const still = await h.raw("/api/autonomy/status");
  assert.equal(still.json.outboxMode, "shadow");
});

await test("without a delegation the mode cannot be flipped, and the refusal names the variable", async () => {
  delete process.env[OUTBOX_UI_CONTROL_ENV];
  try {
    const status = await h.raw("/api/autonomy/status");
    assert.equal(status.json.canSetOutboxMode, false);
    assert.equal(status.json.outboxRefusal.code, "not_delegated");
    assert.match(status.json.outboxRefusal.message, /COGNOS_AUTONOMY_OUTBOX_UI_CONTROL/);

    const attempt = await h.raw("/api/autonomy/settings", { method: "POST", body: { outboxMode: "shadow" } });
    assert.equal(attempt.status, 409);
    assert.equal(attempt.json.code, "not_delegated");

    // Delegating the ENABLEMENT switch must not delegate this one: they are
    // different powers, and COGNOS_AUTONOMY_UI_CONTROL is not set here at all.
    const module = await import("../server/autonomy/settings.js");
    assert.equal(module.outboxModeDelegated(), false);
  } finally {
    process.env[OUTBOX_UI_CONTROL_ENV] = "true";
  }
});

await test("one request changes one switch, and an invented mode is refused", async () => {
  const both = await h.raw("/api/autonomy/settings", {
    method: "POST", body: { enabled: true, outboxMode: "live" }
  });
  assert.equal(both.status, 400);
  assert.equal(both.json.code, "one_switch_per_request");

  const invented = await h.raw("/api/autonomy/settings", { method: "POST", body: { outboxMode: "yolo" } });
  assert.equal(invented.status, 409);
  assert.equal(invented.json.code, "invalid_mode");
  assert.match(invented.json.error, /shadow, dry_run, live/);

  // The enablement switch is still on this route and still answers to ITS OWN
  // guard, which is the point of keeping them separate: this deployment pins
  // autonomy on with COGNOS_AUTONOMY_ENABLED and never delegated the on/off
  // switch, so `enabled` is refused while `outboxMode` is delegated and
  // accepted. Two powers, two delegations, two refusals.
  const enabled = await h.raw("/api/autonomy/settings", { method: "POST", body: { enabled: true } });
  assert.equal(enabled.status, 409, JSON.stringify(enabled.json));
  assert.equal(enabled.json.code, "pinned_by_operator");
  assert.equal(enabled.json.settings.canSetOutboxMode, true,
    "a refusal of the enablement switch says nothing about the mode switch");
});

await test("a corpus earned against another endpoint does not justify sending to this one", async () => {
  const { default: db } = await import("../server/db.js");
  const { requestExternalWrite } = await import("../server/autonomy/externalWrite.js");
  const agent = await makeAgent();
  // makeGoal returns the goal ROW; the loop below wants ids.
  //
  // The real floor, not a lowered one. SHADOW_GATE is frozen when config.js is
  // first imported, which in a test file happens before bootHarness can set
  // COGNOS_AUTONOMY_MIN_SHADOW_SAMPLES — so overriding it here would have
  // silently changed nothing and the suite would have measured a gate of 25
  // while asserting a gate of 6. Earning 25 samples across five goals is also
  // the honest version of the test: it stays inside the default per-goal
  // ceilings rather than raising them, which would be testing a deployment
  // nobody runs.
  const goalIds = [];
  for (let g = 0; g < 5; g++) goalIds.push((await makeGoal(agent.id, { title: `Corpus goal ${g}` })).id);

  // Every sample is granted in scope but aimed at ELSEWHERE, and every fourth
  // one is aimed at a destination the goal was never granted, so the corpus
  // contains both verdicts: a gate that never refuses has not been exercised.
  let n = 0;
  for (const goalId of goalIds) {
    const goalRow = await db.AutonomyGoal.get(goalId);
    assert.ok(goalRow, `the corpus goal ${goalId} is readable`);
    for (let k = 0; k < 5; k++) {
      n++;
      const url = n % 4 === 0 ? UNGRANTED : ELSEWHERE;
      const out = await requestExternalWrite({
        db, goal: goalRow, agentId: agent.id, tickId: `tick_aim_${n}`, skillId: "webhook.post",
        destination: url,
        payload: { url, method: "POST", headers: {}, body: BODY(n), secretRef: null, reason: "corpus" },
        keyPayload: { url, body: BODY(n) }, config: autonomyConfig()
      });
      assert.equal(out.ok, url === ELSEWHERE, `sample ${n} -> ${out.error}`);
      assert.equal(out.released, undefined, "shadow performed nothing");
    }
  }

  const measured = await h.raw("/api/autonomy/rungs");
  const live = measured.json.live;
  assert.ok(live.corpus.samples >= 25, JSON.stringify(live.corpus));
  assert.equal(live.corpus.gate.minSamples, 25, "the report quotes the wired gate, not a convenient one");
  assert.equal(live.corpus.falseReleases, 0, JSON.stringify(measured.json.rungs.find(r => r.rung === "external_writes").measurement.metrics.falseReleases));
  assert.ok(live.corpus.wouldRelease >= 15, "the corpus contains release verdicts");
  assert.ok(live.corpus.refused >= 5, "and refusals");
  assert.equal(live.corpus.aimedAtApproved, 0, "none of it was aimed at the approved endpoint");
  assert.ok(live.corpus.aimedElsewhere >= 15);
  assert.ok(live.unmet.includes("corpus_aimed"), JSON.stringify(live.unmet));

  // Recording the measurement is still allowed and still honest: the gate is
  // satisfied, so the row is justified. It is the FLIP that refuses, because a
  // corpus about one endpoint is not evidence about another.
  const recorded = await h.raw("/api/autonomy/rungs/external_writes/evidence", {
    method: "POST", body: { decided_by: "outbox-live-suite", reason: "corpus aimed elsewhere" }
  });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.json));
  assert.equal(recorded.json.decision, "justified");

  const attempt = await h.raw("/api/autonomy/settings", { method: "POST", body: { outboxMode: "live" } });
  assert.equal(attempt.status, 409);
  assert.deepEqual(attempt.json.unmet, ["corpus_aimed"], JSON.stringify(attempt.json.unmet));
  assert.match(attempt.json.error, /aimed/i);
  assert.equal(attempt.json.live.corpus.aimedAtApproved, 0);
  assert.equal(await count("autonomy_settings", " WHERE outbox_mode IS NOT NULL"), 0,
    "a refused flip still wrote nothing");
});

await test("narrowing needs no evidence: the brake is unconditional", async () => {
  // Shadow is where the deployment already is, so this is a no-op that must not
  // pretend to be a decision.
  const noop = await h.raw("/api/autonomy/settings", { method: "POST", body: { outboxMode: "shadow" } });
  assert.equal(noop.status, 200, JSON.stringify(noop.json));
  assert.equal(noop.json.changed, false);
  assert.equal(noop.json.mode, "shadow");
  assert.equal(await count("workspace_audit", " WHERE action=$1", [OUTBOX_MODE_AUDIT_ACTION]), 0,
    "a flip that changed nothing recorded nothing");

  // dry_run reaches further than shadow but sends nothing, so it is not a
  // delivery widening and is not gated on the corpus.
  const dry = await h.raw("/api/autonomy/settings", { method: "POST", body: { outboxMode: "dry_run" } });
  assert.equal(dry.status, 200, JSON.stringify(dry.json));
  assert.equal(dry.json.changed, true);
  assert.equal(dry.json.mode, "dry_run");
  assert.equal((await h.raw("/api/autonomy/status")).json.outboxMode, "dry_run");
  assert.equal((await h.raw("/api/autonomy/status")).json.outboxModeSource, "ui");

  const back = await h.raw("/api/autonomy/settings", { method: "POST", body: { outboxMode: "shadow" } });
  assert.equal(back.status, 200);
  assert.equal(back.json.mode, "shadow");
  assert.equal(await count("workspace_audit", " WHERE action=$1", [OUTBOX_MODE_AUDIT_ACTION]), 2,
    "both real flips are transitions in the audit trail");
});

await test("the flip succeeds once the corpus is aimed at the approved destination, and the audit row carries digests", async () => {
  // Same corpus, repointed: the deployment now approves the endpoint the
  // evidence was actually earned against. Nothing else changed.
  const prev = process.env[LIVE_DESTINATION_ENV];
  process.env[LIVE_DESTINATION_ENV] = ELSEWHERE;
  try {
    const rungs = await h.raw("/api/autonomy/rungs");
    const live = rungs.json.live;
    assert.equal(live.destination.hostname, "hooks-elsewhere.example.com");
    assert.ok(live.corpus.aimedAtApproved >= 15, JSON.stringify(live.corpus));
    assert.equal(live.ready, true, JSON.stringify(live.unmet));
    assert.deepEqual(live.unmet, []);
    assert.equal(live.justifiedNow, true);
    assert.ok(live.evidence, "a justified row is current");
    assert.equal(live.corpus.gate.minSamples, 25, "the report quotes the gate this deployment configured");

    const flip = await h.raw("/api/autonomy/settings", {
      method: "POST", body: { outboxMode: "live", updated_by: "outbox-live-suite" }
    });
    assert.equal(flip.status, 200, JSON.stringify(flip.json));
    assert.equal(flip.json.changed, true);
    assert.equal(flip.json.mode, "live");
    assert.equal(flip.json.previousMode, "shadow");
    assert.match(flip.json.note, /PERFORMED/);
    assert.equal(flip.json.live.ready, true);

    const status = await h.raw("/api/autonomy/status");
    assert.equal(status.json.outboxMode, "live");
    assert.equal(status.json.outboxModeSource, "ui");
    assert.equal(status.json.externalWrites.deliversNow, true, "the loop now performs release verdicts");

    // The transition is recorded with the evidence that justified it, and with
    // the destination DIGESTED: an audit row is readable by anyone who can read
    // this workspace's history, and it still proves which endpoint was approved.
    const rows = await h.sql(
      `SELECT detail FROM workspace_audit WHERE action=$1 ORDER BY ts_ms DESC LIMIT 1`,
      [OUTBOX_MODE_AUDIT_ACTION]);
    assert.equal(rows.length, 1);
    const detail = json(rows[0].detail, {});
    assert.equal(detail.from, "shadow");
    assert.equal(detail.to, "live");
    assert.equal(detail.effective, "live");
    assert.equal(detail.widening, true);
    assert.equal(detail.updatedBy, "outbox-live-suite");
    assert.equal(detail.rungFlag, true);
    assert.ok(String(detail.evidenceSha256 || "").length === 64, "the evidence digest travels with the flip");
    assert.ok(String(detail.destinationSha256 || "").length === 64, "and so does the destination's");
    assert.ok(Number(detail.samples) >= 25);
    assert.equal(Number(detail.falseReleases), 0);
    const blob = String(rows[0].detail);
    assert.ok(!blob.includes(ELSEWHERE), "the audit row does not carry the endpoint URL");
    assert.ok(!blob.includes("hooks-elsewhere"), "nor its hostname");
  } finally {
    if (prev === undefined) delete process.env[LIVE_DESTINATION_ENV];
    else process.env[LIVE_DESTINATION_ENV] = prev;
  }
});

await test("once live, a delivery to the approved destination is performed and one to another is refused", async () => {
  const { default: db } = await import("../server/db.js");
  const { requestExternalWrite } = await import("../server/autonomy/externalWrite.js");
  const sink = await startSink();
  try {
    const agent = await makeAgent();
    const goal = await makeGoal(agent.id, { title: "Live delivery goal" });
    const goalRow = await db.AutonomyGoal.get(goal.id);
    assert.equal(autonomyConfig().outboxMode, "live", "the flip is in effect for the loop, not just the route");

    // Approved and granted: performed, once, to the sink.
    sink.seen.length = 0;
    const body = BODY("live-1");
    const released = await requestExternalWrite({
      db, goal: goalRow, agentId: agent.id, tickId: "tick_live_ok", skillId: "webhook.post",
      destination: APPROVED,
      payload: { url: APPROVED, method: "POST", headers: {}, body, secretRef: null, reason: "live" },
      keyPayload: { url: APPROVED, body }, config: autonomyConfig(),
      transport: sinkTransport(sink), resolve: publicResolve
    });
    assert.equal(released.ok, true, JSON.stringify(released));
    assert.equal(released.released, true);
    assert.equal(sink.seen.length, 1, "one delivery, one request");

    // Granted in the goal's scope, NOT approved by the deployment: refused by
    // name, and no socket opened. This is the whole point of the second gate.
    sink.seen.length = 0;
    const otherBody = BODY("live-2");
    const refused = await requestExternalWrite({
      db, goal: goalRow, agentId: agent.id, tickId: "tick_live_no", skillId: "webhook.post",
      destination: ELSEWHERE,
      payload: { url: ELSEWHERE, method: "POST", headers: {}, body: otherBody, secretRef: null, reason: "live" },
      keyPayload: { url: ELSEWHERE, body: otherBody }, config: autonomyConfig(),
      transport: sinkTransport(sink), resolve: publicResolve
    });
    assert.equal(refused.ok, false);
    assert.ok(refused.rules.includes("DESTINATION_NOT_APPROVED"), JSON.stringify(refused.rules));
    assert.equal(sink.seen.length, 0, "nothing was sent to the unapproved endpoint");
    assert.equal(await count("autonomy_outbox",
      " WHERE goal_id=$1 AND destination=$2 AND status='refused'", [goal.id, ELSEWHERE]), 1,
      "and the refused attempt is still a row");

    // A route-driven approval of that same refused row cannot resurrect it: a
    // terminal row replays its verdict instead of acting again.
    const rows = await h.sql(
      `SELECT id FROM autonomy_outbox WHERE goal_id=$1 AND destination=$2`, [goal.id, ELSEWHERE]);
    const approve = await h.raw(`/api/autonomy/outbox/${rows[0].id}/decision`, {
      method: "POST", body: { decision: "approve" }
    });
    assert.equal(approve.status, 409, JSON.stringify(approve.json));
    assert.equal(sink.seen.length, 0, "an approval of a refused row delivers nothing");
  } finally {
    await sink.stop();
  }
});

await test("an operator pin holds the mode down and cannot be widened, but can always be narrowed", async () => {
  process.env[OUTBOX_MODE_ENV] = "shadow";
  try {
    // The pin wins over a stored live row, immediately and without a restart.
    const status = await h.raw("/api/autonomy/status");
    assert.equal(status.json.outboxMode, "shadow");
    assert.equal(status.json.outboxModeSource, "env-pin");
    assert.equal(status.json.externalWrites.deliversNow, false, "the brake reached a live deployment");

    const attempt = await h.raw("/api/autonomy/settings", { method: "POST", body: { outboxMode: "live" } });
    assert.equal(attempt.status, 409);
    assert.equal(attempt.json.code, "pinned_by_operator");
    assert.match(attempt.json.error, /COGNOS_AUTONOMY_OUTBOX_MODE=shadow/);

    // The readiness report says the same thing before anyone tries.
    const rungs = await h.raw("/api/autonomy/rungs");
    assert.ok(rungs.json.live.unmet.includes("not_pinned_down"), JSON.stringify(rungs.json.live.unmet));
    assert.match(rungs.json.live.conditions.find(c => c.id === "not_pinned_down").sentence,
      /outranks the API/);

    // A module-level flip agrees with the route: the guard is not in the handler.
    const direct = await setOutboxMode({ db: undefined, outboxMode: "live" });
    assert.equal(direct.ok, false);
    assert.equal(direct.refusal.code, "pinned_by_operator");
  } finally {
    delete process.env[OUTBOX_MODE_ENV];
  }

  // Pin lifted: the stored row is live again, and the loop says so.
  const after = await h.raw("/api/autonomy/status?fresh=1");
  assert.equal(after.json.outboxMode, "live");
  assert.equal(after.json.outboxModeSource, "ui");
});

await test("nothing in this slice widened a rung, a ceiling, a skill or a budget", async () => {
  const status = await h.raw("/api/autonomy/status");
  const cfg = status.json;
  assert.deepEqual(cfg.builtTiers, ["T0", "T1", "T2", "T3", "T4"], "T5 is still not built");
  assert.equal(cfg.rung.irreversible, false, "and its rung is still off");
  assert.equal(cfg.rung.inbound, false, "Rung 5 is still Phase 23");
  assert.equal(cfg.ceilings.maxCostPerDayUsd, 2, "the workspace ceiling did not move");
  assert.equal(cfg.ceilings.maxActiveGoals, 10, "nor did any other ceiling");
  assert.equal(cfg.shadowGate.maxAcceptableFalseReleases, 0, "zero tolerance is still the gate");
  assert.equal(cfg.defaultOff, true, "the resting state is still frozen");
  assert.ok(!cfg.skills.some(s => s.tier === "T5" && s.enabled), "no T5 skill became reachable");

  // A T5 effect is still refused outright, in the mode this slice just earned.
  const { default: db } = await import("../server/db.js");
  const { stageEffect } = await import("../server/autonomy/outbox.js");
  const agent = await makeAgent();
  const goal = await makeGoal(agent.id, { title: "T5 still refused" });
  const goalRow = await db.AutonomyGoal.get(goal.id);
  const authorization = await db.GoalAuthorization.current(goal.id, Date.now());
  const staged = await stageEffect({
    db, workspaceId: goalRow.workspace_id, agentId: agent.id, goalId: goal.id,
    skillId: "webhook.post", effectType: "irreversible", tier: "T5",
    payload: { url: APPROVED, method: "POST", headers: {}, body: BODY("t5"), secretRef: null },
    keyPayload: { url: APPROVED, body: BODY("t5") }, mode: "live"
  });
  const { decideEffect } = await import("../server/autonomy/outbox.js");
  const decided = await decideEffect({
    db, effectId: staged.row.id, goal: goalRow, authorization, config: autonomyConfig(), mode: "live"
  });
  assert.equal(decided.verdict.decision, "refuse");
  assert.ok(decided.verdict.failed.some(f => f.rule === "T5_NEEDS_HUMAN"),
    JSON.stringify(decided.verdict.failed));
  assert.equal(decided.executed, false);

  // And the route still refuses to stage one at all.
  const approve = await h.raw(`/api/autonomy/outbox/${staged.row.id}/decision`, {
    method: "POST", body: { decision: "approve" }
  });
  assert.equal(approve.status, 409);
});

await test("the readiness report is readable before anything is flipped, and reads as sentences", async () => {
  const { default: db } = await import("../server/db.js");
  const ws = await db.Workspace.ensureDefault();
  const report = await describeLiveReadiness({ db, workspaceId: ws.id, config: autonomyConfig() });
  assert.equal(report.ok, true);
  assert.equal(report.tier, "T4");
  assert.equal(report.rung, "external_writes");
  assert.equal(report.conditions.length, 8, "every condition is reported, not only the failures");
  assert.ok(report.corpus.samples >= 25, JSON.stringify(report.corpus));
  for (const condition of report.conditions) {
    assert.ok(condition.id && condition.label, JSON.stringify(condition));
    assert.equal(typeof condition.met, "boolean");
    // A met condition has nothing to say; an unmet one says what to do.
    if (condition.met) assert.equal(condition.sentence, "");
    else assert.ok(condition.sentence.length > 20, `${condition.id} explains itself`);
  }
  assert.equal(report.ready, true, "this deployment has earned it");
  assert.equal(report.refusal, null);
  assert.equal(report.destination.env, LIVE_DESTINATION_ENV);
  // Both counts are reported so a surface can say "8 of 8" without counting the
  // array it was handed, and so `ready` is a summary rather than the only one.
  assert.equal(report.total, report.conditions.length);
  assert.equal(report.met, report.total - report.unmet.length);
  assert.equal(report.met, report.total, "every condition is met here");

  // The settings surface carries the same report, so an operator does not have
  // to find the rungs route to learn what a flip would take.
  const settings = await h.raw("/api/autonomy/settings?live=1");
  assert.equal(settings.status, 200);
  assert.equal(settings.json.live.ready, true);
  // Measuring the corpus reads up to a thousand rows, so the plain read does not
  // do it — the same convention /api/autonomy/status?fresh=1 already sets.
  const cheap = await h.raw("/api/autonomy/settings");
  assert.equal(cheap.json.live, null, "the report is opt-in, not on every read");
  assert.equal(cheap.json.outboxMode, "live", "and the cheap read still answers the switch");
  assert.equal(settings.json.outboxMode, "live");
  assert.equal(Array.isArray(settings.json.outboxFlips), true);
  assert.ok(settings.json.outboxFlips.length >= 1);
  const flip = settings.json.outboxFlips.find(f => f.to === "live");
  assert.ok(flip, "the earned widening is in the mode history");
  assert.equal(flip.widening, true);
  assert.equal(flip.from, "shadow");
  assert.ok(String(flip.evidenceSha256).length === 64);
  assert.ok(String(flip.destinationSha256).length === 64);
  assert.ok(!JSON.stringify(settings.json.outboxFlips).includes("hooks-"),
    "and the history carries digests rather than endpoints");
});

await test("every switch this slice adds is documented in .env.example under the name that is wired", async () => {
  const example = readFileSync(".env.example", "utf8");
  const lines = example.split("\n");
  const documented = (name) => lines.some(line => line.startsWith(`${name}=`));
  for (const name of [
    "COGNOS_AUTONOMY_OUTBOX_MODE",
    "COGNOS_AUTONOMY_OUTBOX_UI_CONTROL",
    "COGNOS_AUTONOMY_LIVE_DESTINATION"
  ]) {
    assert.ok(documented(name), `${name} is documented in .env.example`);
  }
  assert.match(example, /COGNOS_AUTONOMY_OUTBOX_UI_CONTROL=false/, "the delegation is documented as OFF");
  assert.match(example, /COGNOS_AUTONOMY_LIVE_DESTINATION=\s*$/m,
    "and the approved destination as unset, which fails closed");

  // Every variable THIS MODULE reads is documented — an example file that omits
  // a switch is a switch nobody can find. The scan is scoped to the module the
  // slice added rather than to every autonomy file, because thirteen older
  // variables (the ceilings and the tick timings) are already undocumented and
  // quietly absorbing that gap into a new test would make this file fail for a
  // reason that has nothing to do with live delivery.
  const wired = [...readFileSync("server/autonomy/liveOutbox.js", "utf8")
    .matchAll(/COGNOS_AUTONOMY_[A-Z_]+/g)].map(m => m[0]);
  assert.ok(wired.length >= 2, "the module names the switches it depends on");
  for (const name of new Set(wired)) {
    assert.ok(documented(name), `${name} is read by this slice and documented`);
  }
});

await h.stop();

console.log(`\nOUTBOX-LIVE RESULT: ${passed} passed`);

// ------------------------------------------------------------------ sink seam
// Declared after use because the suite above is a sequence of awaited tests and
// function declarations hoist; keeping them at the bottom matches phase21.mjs,
// where the same two helpers sit next to the adapter tests that use them.
async function startSink() {
  const seen = [];
  let respond = () => ({ status: 200, body: '{"ok":true}' });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const out = respond({ attempt: seen.length, url: req.url, body }) || {};
      res.writeHead(out.status ?? 200, { "content-type": out.contentType || "application/json" });
      res.end(out.body ?? "");
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { port, seen, set respond(fn) { respond = fn; }, stop: () => new Promise(r => server.close(r)) };
}

/** The substituted socket layer: real HTTP, to the loopback sink, for any URL. */
function sinkTransport(sink) {
  return ({ url, method, headers, body, timeoutMs }) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      host: "127.0.0.1", port: sink.port, path: target.pathname + target.search, method,
      headers: { ...headers, host: `127.0.0.1:${sink.port}` }
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, statusText: res.statusMessage, headers: res.headers,
          body: raw, bytes: raw.length, truncated: false });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs || 2000, () =>
      req.destroy(Object.assign(new Error("the webhook timed out"), { rule: "TIMEOUT" })));
    req.end(body);
  });
}
