#!/usr/bin/env node
// Phase 28 — the earned-corpus bypass, as a DELEGATED operator switch.
//
// THE CLAIM UNDER TEST. T4 live releases normally have to EARN their way past
// the shadow gate. The one off-ramp that said "vouch for the destination, skip
// the corpus" shipped as a raw environment read, which meant the switch that
// unblocks a live release was invisible on the page that shows you the wall.
//
// What this suite proves:
//
//   * the bypass rests OFF and absence is not a permission — an unread row, an
//     empty value and an unrecognised value all read as off (fail closed);
//   * delegation alone does not turn it on, and an operator pin outranks the UI
//     in BOTH directions (explicit true pins on, explicit false pins off);
//   * the legacy spelling (COGNOS_AUTONOMY_BYPASS_EVIDENCE) still pins;
//   * the ONLY path that turns it on is delegation plus a stored row, and a
//     flip with no delegation is refused with a sentence and stores nothing;
//   * what it waives is EXACTLY the corpus: with the bypass on, the Governor
//     still refuses a live release whose rung is off or whose destination is
//     not the one approved endpoint — and T5 is untouched;
//   * the new delegation is documented in .env.example under the name wired.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BYPASS_EARNING_PIN_ENV, BYPASS_EARNING_LEGACY_ENV, BYPASS_EARNING_UI_CONTROL_ENV,
  bypassEarningPinned, bypassEarningDelegated, effectiveBypassEarning,
  bypassEarningRefusal, setBypassEarning, describeSettings, resetSettingsCache
} from "../server/autonomy/settings.js";
import { judgeEffect } from "../server/autonomy/actionGovernor.js";
import { autonomyConfig } from "../server/autonomy/config.js";
import { scopeHashes } from "../server/autonomy/authorize.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const ALL_SWITCH_ENVS = [
  BYPASS_EARNING_PIN_ENV, BYPASS_EARNING_LEGACY_ENV, BYPASS_EARNING_UI_CONTROL_ENV
];

/** Run `fn` with exactly these switch variables set (null = unset), then restore. */
async function withEnv(vars, fn) {
  const saved = {};
  for (const name of ALL_SWITCH_ENVS) saved[name] = process.env[name];
  for (const [name, value] of Object.entries(vars)) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  resetSettingsCache();
  try {
    return await fn();
  } finally {
    for (const name of ALL_SWITCH_ENVS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetSettingsCache();
  }
}

/** A db just wide enough for setBypassEarning: it writes the one column. */
const settingsDb = (onWrite = () => {}) => ({
  Workspace: { ensureDefault: async () => ({ id: "ws1" }) },
  AutonomySettings: {
    setBypassEarning: async ({ workspace_id, bypass_earning }) => {
      onWrite(bypass_earning);
      return { workspace_id, bypass_earning };
    }
  },
  WorkspaceAudit: { append: async () => ({}) }
});

// ============================================ pure: the resting state and pins
await test("the bypass rests OFF — absence is not a permission", async () => {
  await withEnv({ [BYPASS_EARNING_PIN_ENV]: null, [BYPASS_EARNING_LEGACY_ENV]: null,
    [BYPASS_EARNING_UI_CONTROL_ENV]: null }, async () => {
    assert.equal(bypassEarningPinned(), null);
    assert.equal(bypassEarningDelegated(), false);
    assert.equal(effectiveBypassEarning(), false, "no row, no delegation, no bypass");
    assert.equal(bypassEarningRefusal().code, "not_delegated");

    // Delegation without a stored row is still OFF: an unread row is not a
    // permission, and a database blip must not silently waive the corpus.
    process.env[BYPASS_EARNING_UI_CONTROL_ENV] = "true";
    resetSettingsCache();
    assert.equal(effectiveBypassEarning(), false);
    assert.equal(bypassEarningRefusal(), null, "with delegation the UI MAY flip it");
  });
});

await test("an unrecognised value pins OFF and an empty value is not a pin", async () => {
  await withEnv({ [BYPASS_EARNING_PIN_ENV]: "" }, async () => {
    assert.equal(bypassEarningPinned(), null, "an empty value is not a pin at all");
    assert.equal(effectiveBypassEarning(), false);
  });
  for (const value of ["0", "off", "yes-please"]) {
    await withEnv({ [BYPASS_EARNING_PIN_ENV]: value }, async () => {
      assert.equal(bypassEarningPinned(), false, `"${value}" pins OFF, never on`);
      assert.equal(effectiveBypassEarning(), false);
    });
  }
  for (const value of ["1", "true", "yes", "on", "enabled", "TRUE"]) {
    await withEnv({ [BYPASS_EARNING_PIN_ENV]: value }, async () => {
      assert.equal(bypassEarningPinned(), true, `"${value}" is an explicit affirmative`);
      assert.equal(effectiveBypassEarning(), true);
    });
  }
});

await test("a pin outranks the UI in both directions, and the legacy spelling still pins", async () => {
  await withEnv({ [BYPASS_EARNING_PIN_ENV]: "true",
    [BYPASS_EARNING_UI_CONTROL_ENV]: "true" }, async () => {
    assert.equal(effectiveBypassEarning(), true);
    assert.equal(bypassEarningRefusal().code, "pinned_by_operator",
      "the UI cannot override a pin, and says so");
  });

  await withEnv({ [BYPASS_EARNING_LEGACY_ENV]: "true",
    [BYPASS_EARNING_UI_CONTROL_ENV]: "true" }, async () => {
    assert.equal(effectiveBypassEarning(), true, "the old spelling keeps the value it set");
  });

  await withEnv({ [BYPASS_EARNING_PIN_ENV]: "false",
    [BYPASS_EARNING_UI_CONTROL_ENV]: "true" }, async () => {
    const db = settingsDb();
    const outcome = await setBypassEarning(db, { enabled: true });
    assert.equal(outcome.ok, false, "a pinned-off bypass cannot be turned on");
    assert.equal(outcome.refusal.code, "pinned_by_operator");
    assert.equal(effectiveBypassEarning(), false);
  });
});

// ================================== the delegated flip: the only way it turns on
await test("delegation plus a stored row is the only path that turns it on", async () => {
  await withEnv({ [BYPASS_EARNING_PIN_ENV]: null, [BYPASS_EARNING_LEGACY_ENV]: null,
    [BYPASS_EARNING_UI_CONTROL_ENV]: "true" }, async () => {
    const writes = [];
    const db = settingsDb((value) => writes.push(value));

    const on = await setBypassEarning(db, { enabled: true });
    assert.equal(on.ok, true, JSON.stringify(on.refusal));
    assert.equal(on.settings.bypassEarning, true, "write-through: the response is the new truth");
    assert.equal(effectiveBypassEarning(), true);
    assert.equal(describeSettings().bypassEarning, true);
    assert.equal(describeSettings().bypassEarningDelegated, true);
    assert.equal(describeSettings().canSetBypassEarning, true);
    assert.equal(describeSettings().stored.bypassEarning, true);

    const off = await setBypassEarning(db, { enabled: false });
    assert.equal(off.ok, true);
    assert.equal(effectiveBypassEarning(), false, "the brake needs no permission");
    assert.deepEqual(writes, [true, false]);
  });
});

await test("a flip with no delegation is refused with a sentence and stores nothing", async () => {
  await withEnv({ [BYPASS_EARNING_PIN_ENV]: null, [BYPASS_EARNING_LEGACY_ENV]: null,
    [BYPASS_EARNING_UI_CONTROL_ENV]: null }, async () => {
    const writes = [];
    const outcome = await setBypassEarning(settingsDb((v) => writes.push(v)), { enabled: true });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refusal.code, "not_delegated");
    assert.match(outcome.refusal.message, /COGNOS_AUTONOMY_BYPASS_EARNING_UI_CONTROL=true/);
    assert.deepEqual(writes, [], "nothing was written");
    assert.equal(effectiveBypassEarning(), false);
  });
});

// ====================================== what it waives, and what it must not
const APPROVED = "https://hooks-approved.example.com/cognos";
const ELSEWHERE = "https://hooks-elsewhere.example.com/cognos";
const hashes = scopeHashes({
  goalId: "goal_p28",
  scope: { effectsAllowed: ["notify", { effect: "webhook.post", destinations: [APPROVED, ELSEWHERE] }] },
  budget: { maxEffectsPerDay: 10, maxExternalEffects: 25 }
});
const goal = {
  id: "goal_p28", workspace_id: "ws1", spent: {},
  scope: { effectsAllowed: ["notify", { effect: "webhook.post", destinations: [APPROVED, ELSEWHERE] }] },
  budget: { maxEffectsPerDay: 10, maxExternalEffects: 25 }
};
const authorization = {
  decision: "authorize", scope_sha256: hashes.scopeSha256,
  budget_sha256: hashes.budgetSha256, expires_at_ms: Date.now() + 600_000
};
const dbWith = (evidenceRow) => ({
  query: async () => [{ total: 0, n: 0 }],
  RungEvidence: { currentJustified: async () => evidenceRow }
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
  id: "fx_p28", skill_id: "webhook.post", tier: "T4", effect_type: "external_write",
  status: "staged", mode: "shadow", destination: url, scope_sha256: hashes.scopeSha256,
  payload: { url, method: "POST", headers: {}, body: '{"n":1}', secretRef: null, reason: null }
});
const judge = (url, { db = dbWith(null), config = cfgWith() } = {}) => judgeEffect({
  db, effect: effectAt(url), goal, authorization, config, mode: "live"
});
const rulesOf = (v) => (v.failed || []).map(f => f.rule);

await test("the Governor waives the corpus and nothing else", async () => {
  // Without a corpus and without the bypass: refused, by name.
  await withEnv({ [BYPASS_EARNING_PIN_ENV]: null, [BYPASS_EARNING_LEGACY_ENV]: null,
    [BYPASS_EARNING_UI_CONTROL_ENV]: null }, async () => {
    const refused = await judge(APPROVED);
    assert.equal(refused.decision, "refuse");
    assert.ok(rulesOf(refused).includes("EVIDENCE_GATE_UNMET"), JSON.stringify(refused.failed));
  });

  // With the bypass pinned on and no corpus: released, and it says why.
  await withEnv({ [BYPASS_EARNING_PIN_ENV]: "true" }, async () => {
    const released = await judge(APPROVED);
    assert.equal(released.decision, "release", JSON.stringify(released.failed));

    // Rung off is NOT waived: building a rung is still not enabling one.
    const rungOff = await judge(APPROVED, { config: cfgWith({ rung: { externalWrites: false } }) });
    assert.equal(rungOff.decision, "refuse", "the rung flag still binds");

    // The one approved destination is NOT waived either.
    const elsewhere = await judge(ELSEWHERE);
    assert.equal(elsewhere.decision, "refuse", "a granted-but-unapproved destination still binds");
    assert.ok(rulesOf(elsewhere).includes("DESTINATION_NOT_APPROVED"), JSON.stringify(elsewhere.failed));
  });
});

// ============================================== the switch is findable in docs
await test("the new delegation is documented in .env.example under the name wired", async () => {
  const example = readFileSync(".env.example", "utf8");
  const lines = example.split("\n");
  const documented = (name) => lines.some(line => line.startsWith(`${name}=`));
  for (const name of [BYPASS_EARNING_PIN_ENV, BYPASS_EARNING_LEGACY_ENV, BYPASS_EARNING_UI_CONTROL_ENV]) {
    assert.ok(documented(name), `${name} is documented in .env.example`);
  }
  assert.match(example, /COGNOS_AUTONOMY_BYPASS_EARNING_UI_CONTROL=false/,
    "the delegation is documented as OFF");
});

resetSettingsCache();
console.log(`\nPHASE28 RESULT: ${passed} passed`);
