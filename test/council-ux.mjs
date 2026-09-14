#!/usr/bin/env node
// Phase 26 regressions — the user-friendliness work: delegated Critic/Governor
// switches and "forgo goal authorization".
//
// Deterministic and local: no test here reaches a real model or the network.
// The properties being checked are the ones that make these toggles safe to
// ship at all:
//
//   * the Critic and the Governor rest ON, and turning one off is a recorded,
//     reversible, operator-owned act — not a silent hole in the safety net;
//   * an operator's environment PIN outranks the UI in both directions, and
//     the UI says so instead of lying;
//   * without delegation the switches are not handed over, and the refusal
//     names the exact variable and the restart step;
//   * the Governor's off state is surfaced honestly (empty responses, secret
//     leakage, citation audits stop being vetoed);
//   * forgo-authorization removes ONLY the goal consent click: the scope and
//     budget hashes are still computed and stored under decision_source
//     'auto', and staged effects still wait for their own approval.
//
// THREE HARNESSES (and a couple of pure-unit probes), one process. Both
// server/council/settings.js and server/autonomy/settings.js cache at module
// scope and process.env survives bootHarness, so every harness boundary resets
// both caches and the relevant env keys. Forgetting either leaks a switch from
// one harness into the next and every assertion after it becomes fiction.

import assert from "node:assert/strict";
import {
  COUNCIL_UI_CONTROL_ENV, GOVERNOR_PIN_ENV, CRITIC_PIN_ENV,
  describeCouncilSettings, effectiveCriticEnabled, effectiveGovernorEnabled,
  resetCouncilSettingsCache, councilUiControlDelegated
} from "../server/council/settings.js";
import {
  AUTO_AUTHORIZE_PIN_ENV, AUTO_AUTHORIZE_UI_CONTROL_ENV,
  effectiveAutoAuthorize, autoAuthorizePinned, autoAuthorizeDelegated,
  autoAuthorizeRefusal, resetSettingsCache
} from "../server/autonomy/settings.js";
import { getSystemConfig } from "../server/config.js";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log("council-ux: pure checks (pins, precedence, resting state)");

// ------------------------------------------------------------------ pure units
await test("the council pins are tri-state: unset is not a pin, and only 'false' pins a seat off", async () => {
  const previous = {
    gov: process.env[GOVERNOR_PIN_ENV],
    crit: process.env[CRITIC_PIN_ENV],
    ui: process.env[COUNCIL_UI_CONTROL_ENV]
  };
  try {
    for (const [key, off] of [[GOVERNOR_PIN_ENV, "governor"], [CRITIC_PIN_ENV, "critic"]]) {
      const effective = off === "governor" ? effectiveGovernorEnabled : effectiveCriticEnabled;

      // Unset and empty are NOT pins: the resting state is ON.
      for (const value of [undefined, ""]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
        delete process.env[COUNCIL_UI_CONTROL_ENV];
        resetCouncilSettingsCache();
        assert.equal(effective(), true, `${key}="${value}" must leave the seat on`);
      }

      // The kill-switch semantics the council has always used: any explicit
      // value other than the literal "false" holds the seat ON; "false" pins OFF.
      process.env[key] = "false";
      assert.equal(effective(), false, `${key}=false pins the seat off`);
      for (const value of ["true", "1", "0", "yes", "off"]) {
        process.env[key] = value;
        assert.equal(effective(), true, `${key}="${value}" is an explicit value, so the seat is on`);
      }
    }
    resetCouncilSettingsCache();
    delete process.env[GOVERNOR_PIN_ENV];
    delete process.env[CRITIC_PIN_ENV];
    delete process.env[COUNCIL_UI_CONTROL_ENV];

    // Delegation is an allow-list, like the autonomy switch: only explicit
    // affirmatives hand the toggles over.
    for (const value of ["", "0", "false", "no", "maybe"]) {
      process.env[COUNCIL_UI_CONTROL_ENV] = value;
      assert.equal(councilUiControlDelegated(), false, `delegation "${value}" must not enable`);
    }
    for (const value of ["1", "true", "TRUE", " yes "]) {
      process.env[COUNCIL_UI_CONTROL_ENV] = value;
      assert.equal(councilUiControlDelegated(), true, `delegation "${value}" enables`);
    }

    // Delegation alone changes nothing: the seats still rest on.
    process.env[COUNCIL_UI_CONTROL_ENV] = "true";
    resetCouncilSettingsCache();
    assert.equal(effectiveGovernorEnabled(), true);
    assert.equal(effectiveCriticEnabled(), true);
    const described = describeCouncilSettings();
    assert.equal(described.governorPinned, false);
    assert.equal(described.criticPinned, false);
    assert.equal(described.uiControl, true);
    assert.equal(described.canToggleGovernor, true, "delegation makes the toggle usable");
    assert.equal(described.canToggleCritic, true);
    assert.equal(described.stored.loaded, false, "nothing has been read yet, and the resting state is on");
  } finally {
    resetCouncilSettingsCache();
    for (const [name, key] of [["gov", GOVERNOR_PIN_ENV], ["crit", CRITIC_PIN_ENV], ["ui", COUNCIL_UI_CONTROL_ENV]]) {
      if (previous[name] === undefined) delete process.env[key];
      else process.env[key] = previous[name];
    }
  }
});

await test("auto-authorize is an affirmative pin: explicit false pins off, only affirmatives pin on, unset is no pin", async () => {
  const previous = {
    pin: process.env[AUTO_AUTHORIZE_PIN_ENV],
    ui: process.env[AUTO_AUTHORIZE_UI_CONTROL_ENV]
  };
  try {
    delete process.env[AUTO_AUTHORIZE_PIN_ENV];
    delete process.env[AUTO_AUTHORIZE_UI_CONTROL_ENV];
    resetSettingsCache();
    assert.equal(autoAuthorizePinned(), null, "unset is not a pin");
    assert.equal(effectiveAutoAuthorize(), false, "the resting state is off");

    for (const value of ["", "0", "false", "no", "off", "maybe"]) {
      process.env[AUTO_AUTHORIZE_PIN_ENV] = value;
      // An empty value is not a pin at all; any other non-affirmative is a pin
      // OFF. Never a pin ON.
      assert.ok(autoAuthorizePinned() !== true, `pin "${value}" must not read as on`);
      assert.equal(effectiveAutoAuthorize(), false, `"${value}" must leave auto-authorize off`);
    }
    assert.equal(autoAuthorizePinned(), false, "an explicit non-affirmative is a pin off");
    process.env[AUTO_AUTHORIZE_PIN_ENV] = "";
    assert.equal(autoAuthorizePinned(), null, "an empty value is not a pin");
    for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
      process.env[AUTO_AUTHORIZE_PIN_ENV] = value;
      assert.equal(autoAuthorizePinned(), true, `pin "${value}" pins on`);
      assert.equal(effectiveAutoAuthorize(), true, "and the effective value follows the pin");
    }
    assert.equal(autoAuthorizeRefusal().code, "pinned_by_operator", "a pin refuses the UI");
    assert.match(autoAuthorizeRefusal().message, /COGNOS_AUTONOMY_AUTO_AUTHORIZE/);

    // Delegation alone turns nothing on; it is not the switch.
    delete process.env[AUTO_AUTHORIZE_PIN_ENV];
    process.env[AUTO_AUTHORIZE_UI_CONTROL_ENV] = "true";
    resetSettingsCache();
    assert.equal(autoAuthorizeDelegated(), true);
    assert.equal(effectiveAutoAuthorize(), false, "delegation without a stored value is off");
    assert.equal(autoAuthorizeRefusal(), null, "delegation does make the toggle usable");
    const notDelegated = () => { delete process.env[AUTO_AUTHORIZE_UI_CONTROL_ENV]; return autoAuthorizeRefusal(); };
    assert.equal(notDelegated().code, "not_delegated");
    assert.match(notDelegated().message, /COGNOS_AUTONOMY_AUTO_AUTHORIZE_UI_CONTROL/);
  } finally {
    resetSettingsCache();
    for (const [name, key] of [["pin", AUTO_AUTHORIZE_PIN_ENV], ["ui", AUTO_AUTHORIZE_UI_CONTROL_ENV]]) {
      if (previous[name] === undefined) delete process.env[key];
      else process.env[key] = previous[name];
    }
  }
});

// ----------------------------------------- harness A: delegated, no pin
const A = await bootHarness({
  COGNOS_COUNCIL_UI_CONTROL: "true",
  COGNOS_GOVERNOR_ENABLED: null,
  COGNOS_CRITIC_ENABLED: null,
  COGNOS_AUTONOMY_UI_CONTROL: "true",
  COGNOS_AUTONOMY_AUTO_AUTHORIZE_UI_CONTROL: "true",
  COGNOS_AUTONOMY_AUTO_AUTHORIZE: null
});
resetCouncilSettingsCache();
resetSettingsCache();

try {
  console.log("council-ux: harness A — delegated switches and forgo-authorization");

  await test("the council surface reports three facts: on, pinned, and may-I-change-it", async () => {
    const res = await A.raw("/api/council/settings");
    assert.equal(res.status, 200);
    assert.equal(res.json.governorEnabled, true, "the Governor rests on");
    assert.equal(res.json.criticEnabled, true, "the Critic rests on");
    assert.equal(res.json.governorPinned, false);
    assert.equal(res.json.criticPinned, false);
    assert.equal(res.json.uiControl, true);
    assert.equal(res.json.canToggleGovernor, true);
    assert.equal(res.json.canToggleCritic, true);
    assert.equal(res.json.governorRefusal, null);
    assert.equal(res.json.criticRefusal, null);
    assert.equal(res.json.stored.loaded, true, "the row was read, not assumed");
    assert.equal(res.json.stored.governorEnabled, true);
    assert.equal(Array.isArray(res.json.flips), true);
    assert.match(res.json.note, /delegated to the UI/);
  });

  await test("flipping a seat takes effect with no restart, and the synchronous council config agrees", async () => {
    const off = await A.raw("/api/council/settings", {
      method: "POST", body: { switch: "governor", enabled: false }
    });
    assert.equal(off.status, 200);
    assert.equal(off.json.which, "governor");
    assert.equal(off.json.enabled, false);
    assert.equal(off.json.changed, true);
    assert.equal(off.json.settings.governorEnabled, false);
    assert.match(off.json.note, /empty responses/);
    assert.equal(effectiveGovernorEnabled(), false, "the module cache was written through");
    assert.equal(getSystemConfig().council.governorEnabled, false,
      "getSystemConfig — the value the Governor dispatch actually reads — agrees");

    // A no-op flip is honest about being a no-op.
    const again = await A.raw("/api/council/settings", {
      method: "POST", body: { switch: "governor", enabled: false }
    });
    assert.equal(again.status, 200);
    assert.equal(again.json.changed, false);

    // And the identity route — the council's own self-description — agrees.
    const identity = await A.raw("/api/identity");
    assert.equal(identity.status, 200);
    assert.equal(identity.json.runtime.governance.governorEnabled, false);
    assert.equal(identity.json.runtime.governance.criticEnabled, true);
  });

  await test("every flip is recorded in the audit trail, newest first, and a no-op is still audited", async () => {
    // Two governor clicks so far: the transition (true -> false) and the no-op
    // (false -> false). Every click is audited, but the row reads as a
    // transition so the difference is visible.
    const rows = await A.sql(
      `SELECT ts_ms, detail FROM workspace_audit WHERE action='council.governor' ORDER BY ts_ms ASC`);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].detail.from, true);
    assert.equal(rows[0].detail.to, false);
    assert.equal(rows[0].detail.via, "ui");
    assert.ok(rows[0].detail.updatedBy, "the row says who did it");
    assert.equal(rows[1].detail.from, false, "the no-op is recorded as such");
    assert.equal(rows[1].detail.to, false);

    await A.raw("/api/council/settings", { method: "POST", body: { switch: "critic", enabled: false } });
    const criticRows = await A.sql(
      `SELECT detail FROM workspace_audit WHERE action='council.critic' ORDER BY ts_ms ASC`);
    assert.equal(criticRows.length, 1);
    assert.equal(criticRows[0].detail.from, true);
    assert.equal(criticRows[0].detail.to, false);

    const flips = await A.raw("/api/council/settings");
    assert.equal(flips.json.flips.length, 3, "the surface shows its own history");
    assert.equal(flips.json.flips[0].which, "critic", "newest first");
    assert.equal(flips.json.flips[0].to, false);
    assert.equal(flips.json.flips[0].from, true);

    // Turn both back on for the rest of the harness.
    await A.raw("/api/council/settings", { method: "POST", body: { switch: "governor", enabled: true } });
    await A.raw("/api/council/settings", { method: "POST", body: { switch: "critic", enabled: true } });
    assert.equal(effectiveGovernorEnabled(), true);
    assert.equal(effectiveCriticEnabled(), true);
  });

  await test("a malformed flip is a 400 in words, not a 500", async () => {
    const badSwitch = await A.raw("/api/council/settings", {
      method: "POST", body: { switch: "strategist", enabled: true }
    });
    assert.equal(badSwitch.status, 400);
    assert.match(badSwitch.json.error, /governor or critic/);

    const badValue = await A.raw("/api/council/settings", {
      method: "POST", body: { switch: "critic", enabled: "yes" }
    });
    assert.equal(badValue.status, 400);
    assert.match(badValue.json.error, /true or false/);
  });

  await test("forgo-authorization starts new goals active, with the consent RECORD intact", async () => {
    // The auto-authorize switch is delegated but off: a new goal still waits.
    const settings = await A.raw("/api/autonomy/settings");
    assert.equal(settings.status, 200);
    assert.equal(settings.json.autoAuthorize, false);
    assert.equal(settings.json.canSetAutoAuthorize, true);
    assert.equal(settings.json.autoAuthorizeRefusal, null);

    // Turn autonomy on and create a resident + first goal the manual way.
    await A.raw("/api/autonomy/settings", { method: "POST", body: { enabled: true } });
    const made = await A.raw("/api/autonomy/agents", {
      method: "POST",
      body: { name: "Watcher", slug: "watcher", brief: "b", skill_allowlist: ["note.append"], heartbeat_interval_ms: 3600000 }
    });
    assert.equal(made.status, 201, JSON.stringify(made.json));

    const waiting = await A.raw("/api/autonomy/goals", {
      method: "POST",
      body: { title: "Wait first", objective: "o", agent_id: made.json.id }
    });
    assert.equal(waiting.status, 201);
    assert.equal(waiting.json.goal.status, "awaiting_authorization",
      "with the switch off, the consent click is still required");

    // Flip the switch on, and the SAME creation is auto-authorized.
    const on = await A.raw("/api/autonomy/settings", {
      method: "POST", body: { autoAuthorize: true }
    });
    assert.equal(on.status, 200);
    assert.equal(on.json.autoAuthorize, true);
    assert.equal(on.json.changed, true);

    const auto = await A.raw("/api/autonomy/goals", {
      method: "POST",
      body: { title: "Auto'd", objective: "o", agent_id: made.json.id }
    });
    assert.equal(auto.status, 201);
    assert.equal(auto.json.goal.status, "active", "the goal did not wait");
    assert.ok(auto.json.hashes.scopeSha256, "the scope hash is still computed");
    assert.ok(auto.json.hashes.budgetSha256, "and so is the budget hash");

    // The consent RECORD exists, and it is machine-distinguishable from a human's.
    const auths = await A.sql(
      `SELECT decision, decision_source, scope_sha256, budget_sha256, reason
         FROM goal_authorizations WHERE goal_id=$1 ORDER BY decided_ms ASC`,
      [auto.json.goal.id]);
    assert.equal(auths.length, 1);
    assert.equal(auths[0].decision, "authorize");
    assert.equal(auths[0].decision_source, "auto", "an audit can tell this from a human authorize");
    assert.ok(auths[0].scope_sha256 && auths[0].budget_sha256);
    assert.match(auths[0].reason, /forgo goal authorization/);

    const events = await A.sql(
      `SELECT event_type, detail FROM goal_events WHERE goal_id=$1 ORDER BY seq ASC`, [auto.json.goal.id]);
    assert.equal(events[0].event_type, "goal_created");
    assert.equal(events[1].event_type, "goal_authorized");
    assert.equal(events[1].detail.decision_source, "auto");

    // The audit trail records the switch flip itself.
    const flipRows = await A.sql(
      `SELECT detail FROM workspace_audit WHERE action='autonomy.auto_authorize' ORDER BY ts_ms ASC`);
    assert.equal(flipRows.length, 1);
    assert.equal(flipRows[0].detail.from, false);
    assert.equal(flipRows[0].detail.to, true);

    // Turning it back off is a real flip too.
    const off = await A.raw("/api/autonomy/settings", {
      method: "POST", body: { autoAuthorize: false }
    });
    assert.equal(off.json.autoAuthorize, false);
    assert.equal(off.json.changed, true);
    const againWaiting = await A.raw("/api/autonomy/goals", {
      method: "POST",
      body: { title: "Waits again", objective: "o", agent_id: made.json.id }
    });
    assert.equal(againWaiting.json.goal.status, "awaiting_authorization", "off means the consent click is back");
  });
} finally {
  await A.stop();
  resetCouncilSettingsCache();
  resetSettingsCache();
}

// -------------------------------- harness B: no delegation, no pin
const B = await bootHarness({
  COGNOS_COUNCIL_UI_CONTROL: null,
  COGNOS_GOVERNOR_ENABLED: null,
  COGNOS_CRITIC_ENABLED: null
});
resetCouncilSettingsCache();

try {
  console.log("council-ux: harness B — no delegation, so the switches rest on and the page is told why");

  await test("without delegation the toggles are refused, and the refusal carries the setup", async () => {
    const res = await B.raw("/api/council/settings");
    assert.equal(res.status, 200);
    assert.equal(res.json.governorEnabled, true);
    assert.equal(res.json.criticEnabled, true);
    assert.equal(res.json.uiControl, false);
    assert.equal(res.json.canToggleGovernor, false);
    assert.equal(res.json.canToggleCritic, false);
    assert.equal(res.json.governorRefusal.code, "not_delegated");
    assert.equal(res.json.criticRefusal.code, "not_delegated");
    assert.match(res.json.governorRefusal.message, /COGNOS_COUNCIL_UI_CONTROL/);
    assert.match(res.json.note, /rest ON/);

    const attempt = await B.raw("/api/council/settings", {
      method: "POST", body: { switch: "governor", enabled: false }
    });
    assert.equal(attempt.status, 409, "the UI cannot grant itself a switch nobody delegated");
    assert.equal(attempt.json.code, "not_delegated");
    assert.match(attempt.json.error, /COGNOS_COUNCIL_UI_CONTROL=true/);
    assert.equal(attempt.json.settings.governorEnabled, true, "the truth is returned with the refusal");

    assert.equal((await B.sql(`SELECT COUNT(*)::int AS n FROM council_settings`))[0].n, 0,
      "a refused flip wrote no row");
    assert.equal(effectiveGovernorEnabled(), true, "the seat is still on");
    assert.equal(getSystemConfig().council.governorEnabled, true);
  });
} finally {
  await B.stop();
  resetCouncilSettingsCache();
}

// -------------------------------- harness C: an operator pin outranks the UI
const C = await bootHarness({
  COGNOS_COUNCIL_UI_CONTROL: "true",
  COGNOS_GOVERNOR_ENABLED: "false",   // pin the Governor OFF
  COGNOS_CRITIC_ENABLED: null
});
resetCouncilSettingsCache();

try {
  console.log("council-ux: harness C — an operator pin outranks the UI");

  await test("a pin holds whatever the UI asks, and the refusal says exactly what to do", async () => {
    const res = await C.raw("/api/council/settings");
    assert.equal(res.status, 200);
    assert.equal(res.json.governorEnabled, false, "the pin took the Governor off");
    assert.equal(res.json.criticEnabled, true);
    assert.equal(res.json.governorPinned, true);
    assert.equal(res.json.criticPinned, false);
    assert.equal(res.json.canToggleGovernor, false, "the UI may not override a pin");
    assert.equal(res.json.canToggleCritic, true, "the Critic is still delegated");
    assert.equal(res.json.governorRefusal.code, "pinned_by_operator");
    assert.match(res.json.governorRefusal.message, /COGNOS_GOVERNOR_ENABLED/);

    const on = await C.raw("/api/council/settings", {
      method: "POST", body: { switch: "governor", enabled: true }
    });
    assert.equal(on.status, 409);
    assert.equal(on.json.code, "pinned_by_operator");
    assert.match(on.json.error, /cannot override a pin/);
    assert.equal(on.json.settings.governorEnabled, false, "still off");

    // The pin is resolved in code, not by the table: a stored TRUE cannot beat
    // a pinned FALSE.
    const ws = (await C.sql(`SELECT id FROM workspaces LIMIT 1`))[0].id;
    await C.sql(
      `INSERT INTO council_settings (workspace_id, governor_enabled, critic_enabled, source, updated_ms)
       VALUES ($1, TRUE, TRUE, 'ui', $2)
       ON CONFLICT (workspace_id) DO UPDATE SET governor_enabled = TRUE`,
      [ws, Date.now()]);
    const fresh = await C.raw("/api/council/settings?fresh=1");
    assert.equal(fresh.json.governorEnabled, false, "a stored true cannot beat a pinned false");
    assert.equal(fresh.json.stored.governorEnabled, true, "the row is reported as it is");

    assert.equal(getSystemConfig().council.governorEnabled, false,
      "the Governor dispatch genuinely sees it off");
    assert.equal(getSystemConfig().council.criticEnabled, true);
  });
} finally {
  await C.stop();
  resetCouncilSettingsCache();
  resetSettingsCache();
  delete process.env[COUNCIL_UI_CONTROL_ENV];
  delete process.env[GOVERNOR_PIN_ENV];
  delete process.env[CRITIC_PIN_ENV];
  delete process.env[AUTO_AUTHORIZE_PIN_ENV];
  delete process.env[AUTO_AUTHORIZE_UI_CONTROL_ENV];
}

console.log(`council-ux: ${passed} test(s) passed`);
