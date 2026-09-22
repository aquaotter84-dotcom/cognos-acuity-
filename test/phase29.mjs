#!/usr/bin/env node
// Phase 29 — the RUNG switches, as DELEGATED operator switches.
//
// THE CLAIM UNDER TEST. A rung is the operator's sign-off that a tier EXISTS in
// this deployment. Phase 19 read the five of them straight from the
// environment, so the sign-off that decides whether T4 exists was invisible on
// the page that reports T4, and moving it meant a Railway variable and a
// restart.
//
// What this suite proves:
//
//   * the rungs rest OFF and absence is not a permission — an unread row, a
//     missing column and an unrecognised value all read as off (fail closed);
//   * delegation alone opens nothing, and a pin outranks the page in BOTH
//     directions (explicit true pins on, explicit false pins off, and the
//     refusal names the variable);
//   * the ONLY path that opens a rung is delegation plus a stored row, and a
//     flip with no delegation is refused with a sentence and stores nothing;
//   * the rung reaches the gate that matters — tierAllowed('T4') follows the
//     resolved value, not the environment;
//   * one rung flip writes ONE column, and it does not disturb the other four,
//     the mode, auto-authorize, the bypass or enablement — proved against a real
//     Postgres, through the real route;
//   * the route refuses an unknown rung and a two-switch request, and records
//     an autonomy.rung audit row for a flip that lands;
//   * the new delegation is documented in .env.example under the name wired;
//   * the five columns are applied by the SERVER's own boot path, not only by
//     scripts/migrate.mjs (Phase 28 registered its column in PHASE_SCHEMAS but
//     never concatenated it into db.js; that gap is fixed here and tested).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RUNG_KEYS, RUNG_PIN_ENVS, RUNG_COLUMNS, RUNG_UI_CONTROL_ENV,
  isRungKey, rungPinned, rungsDelegated, effectiveRung, effectiveRungs,
  rungRefusal, setRung, setSettingsEnabled, describeSettings, resetSettingsCache,
  refreshSettings
} from "../server/autonomy/settings.js";
import { autonomyConfig, tierAllowed } from "../server/autonomy/config.js";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/** Every variable this phase reads. `withEnv` restores all of them. */
const ALL_RUNG_ENVS = [...Object.values(RUNG_PIN_ENVS), RUNG_UI_CONTROL_ENV];

async function withEnv(vars, fn) {
  const saved = {};
  for (const name of ALL_RUNG_ENVS) saved[name] = process.env[name];
  for (const [name, value] of Object.entries(vars)) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
  resetSettingsCache();
  try {
    return await fn();
  } finally {
    for (const name of ALL_RUNG_ENVS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetSettingsCache();
  }
}

const noPins = Object.fromEntries(ALL_RUNG_ENVS.map(n => [n, null]));

/** A db just wide enough for the two writers this suite drives. */
const settingsDb = (writes = []) => ({
  Workspace: { ensureDefault: async () => ({ id: "ws1" }) },
  AutonomySettings: {
    set: async ({ workspace_id, enabled }) => {
      writes.push({ writer: "enabled", enabled });
      return { workspace_id, enabled, source: "ui", updated_by: "ui", updated_ms: Date.now() };
    },
    setRung: async ({ workspace_id, rung, rung_enabled }) => {
      writes.push({ writer: "rung", rung, rung_enabled });
      return { workspace_id, [RUNG_COLUMNS[rung]]: rung_enabled };
    }
  },
  WorkspaceAudit: { append: async (row) => { writes.push({ writer: "audit", action: row.action }); return row; } }
});

// ============================================ pure: the resting state and pins
await test("the rungs rest OFF — absence is not a permission", async () => {
  await withEnv(noPins, async () => {
    for (const key of RUNG_KEYS) {
      assert.equal(rungPinned(key), null, `${key} is not pinned`);
      assert.equal(effectiveRung(key), false, `${key} rests off`);
    }
    assert.equal(rungsDelegated(), false);
    assert.equal(rungRefusal("externalWrites").code, "not_delegated");

    // Delegation without a stored row is still OFF: an unread row is not a
    // permission, and a database blip must not open a tier.
    process.env[RUNG_UI_CONTROL_ENV] = "true";
    resetSettingsCache();
    assert.equal(effectiveRung("externalWrites"), false);
    assert.equal(rungRefusal("externalWrites"), null, "with delegation the page MAY flip it");
    assert.equal(describeSettings().canSetRungs, true);
  });
});

await test("an unrecognised value pins OFF and an empty value is not a pin", async () => {
  const env = RUNG_PIN_ENVS.search;
  await withEnv({ ...noPins, [env]: "" }, async () => {
    assert.equal(rungPinned("search"), null, "an empty value is not a pin at all");
    assert.equal(effectiveRung("search"), false);
  });
  for (const value of ["0", "off", "yes-please"]) {
    await withEnv({ ...noPins, [env]: value }, async () => {
      assert.equal(rungPinned("search"), false, `"${value}" pins OFF, never on`);
      assert.equal(effectiveRung("search"), false);
    });
  }
  for (const value of ["1", "true", "yes", "on", "enabled", "TRUE"]) {
    await withEnv({ ...noPins, [env]: value }, async () => {
      assert.equal(rungPinned("search"), true, `"${value}" is an explicit affirmative`);
      assert.equal(effectiveRung("search"), true);
    });
  }
});

await test("a pin outranks the page in both directions, and names itself when it refuses", async () => {
  await withEnv({ ...noPins, [RUNG_UI_CONTROL_ENV]: "true", [RUNG_PIN_ENVS.externalWrites]: "false" },
    async () => {
      const writes = [];
      const outcome = await setRung(settingsDb(writes), { rung: "externalWrites", enabled: true });
      assert.equal(outcome.ok, false, "a pinned-off rung cannot be opened from the page");
      assert.equal(outcome.refusal.code, "pinned_by_operator");
      assert.match(outcome.refusal.message, /COGNOS_AUTONOMY_EXTERNAL_WRITES/,
        "the refusal names the variable to remove");
      assert.deepEqual(writes, [], "nothing was written");
      assert.equal(effectiveRung("externalWrites"), false);

      // A pin ON is also final: the page cannot close a rung an operator opened.
      process.env[RUNG_PIN_ENVS.irreversible] = "true";
      resetSettingsCache();
      assert.equal(effectiveRung("irreversible"), true);
      assert.equal(rungRefusal("irreversible").code, "pinned_by_operator");
    });
});

await test("an unknown rung reads as OFF and is refused on write", async () => {
  await withEnv({ ...noPins, [RUNG_UI_CONTROL_ENV]: "true" }, async () => {
    assert.equal(isRungKey("externalWrites"), true);
    assert.equal(isRungKey("ExternalWrites"), false, "keys are exact — no case folding");
    assert.equal(isRungKey("everything"), false);
    assert.equal(effectiveRung("everything"), false, "a typo on the read path must not open a tier");

    const writes = [];
    const outcome = await setRung(settingsDb(writes), { rung: "everything", enabled: true });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refusal.code, "unknown_rung");
    assert.match(outcome.refusal.message, /residents/);
    assert.deepEqual(writes, [], "an unknown rung never reaches the database");
  });
});

// ================================== the delegated flip: the only way a rung opens
await test("delegation plus a stored row is the only path that opens a rung", async () => {
  await withEnv({ ...noPins, [RUNG_UI_CONTROL_ENV]: "true" }, async () => {
    const writes = [];
    const on = await setRung(settingsDb(writes), { rung: "externalWrites", enabled: true });
    assert.equal(on.ok, true, JSON.stringify(on.refusal));
    assert.equal(on.settings.rungs.externalWrites, true, "write-through: the response is the new truth");
    assert.equal(effectiveRung("externalWrites"), true);
    assert.equal(describeSettings().stored.rungs.externalWrites, true);
    assert.equal(on.settings.rungs.search, false, "the other four are untouched");
    assert.deepEqual(effectiveRungs(), { residents: false, search: false, externalWrites: true, irreversible: false, inbound: false });
    assert.equal(writes.filter(w => w.writer === "rung").length, 1);
    assert.ok(writes.some(w => w.writer === "audit" && w.action === "autonomy.rung"),
      "the flip is recorded as its own audit action");

    const off = await setRung(settingsDb(), { rung: "externalWrites", enabled: false });
    assert.equal(off.ok, true);
    assert.equal(effectiveRung("externalWrites"), false, "the brake needs no permission");
  });
});

await test("a flip with no delegation is refused with a sentence and stores nothing", async () => {
  await withEnv(noPins, async () => {
    const writes = [];
    const outcome = await setRung(settingsDb(writes), { rung: "externalWrites", enabled: true });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refusal.code, "not_delegated");
    assert.match(outcome.refusal.message, /COGNOS_AUTONOMY_RUNGS_UI_CONTROL=true/);
    assert.deepEqual(writes, [], "nothing was written");
    assert.equal(effectiveRung("externalWrites"), false);
  });
});

await test("the resolved rung reaches tierAllowed, and a rung flip is not a corpus", async () => {
  await withEnv(noPins, async () => {
    assert.equal(tierAllowed("T4", autonomyConfig()), false, "T4 rests off");
    assert.equal(tierAllowed("T5", autonomyConfig()), false, "T5 rests off");
  });
  await withEnv({ ...noPins, [RUNG_UI_CONTROL_ENV]: "true" }, async () => {
    await setRung(settingsDb(), { rung: "externalWrites", enabled: true });
    const cfg = autonomyConfig();
    assert.equal(cfg.rung.externalWrites, true, "config.rung is a resolved value now");
    assert.equal(tierAllowed("T4", cfg), true, "the rung gate follows the page");
    assert.equal(tierAllowed("T5", cfg), false, "opening one rung opens exactly one tier");
    // The other half of the gate is untouched: the corpus and the destination
    // are not in this row and no request can write them.
    assert.equal(cfg.liveDestination.configured, false, "no approved destination is implied by a rung");
  });
});

await test("flipping enablement does not forget the rungs", async () => {
  await withEnv({ ...noPins, [RUNG_UI_CONTROL_ENV]: "true", COGNOS_AUTONOMY_UI_CONTROL: "true" }, async () => {
    const db = settingsDb();
    await setRung(db, { rung: "search", enabled: true });
    assert.equal(effectiveRung("search"), true);
    await setSettingsEnabled(db, { enabled: true });
    assert.equal(effectiveRung("search"), true,
      "an enable/disable flip must not drop the delegated rungs");
    assert.equal(describeSettings().stored.rungs.search, true);
  });
});

await test("the column map covers exactly the five rungs", async () => {
  assert.deepEqual(Object.keys(RUNG_COLUMNS).sort(), [...RUNG_KEYS].sort());
  assert.deepEqual(Object.keys(RUNG_PIN_ENVS).sort(), [...RUNG_KEYS].sort());
  for (const key of RUNG_KEYS) {
    assert.match(RUNG_COLUMNS[key], /^rung_[a-z_]+$/, `${key} -> a rung_ column`);
  }
});

// ============================================== the switch is findable in docs
await test("the new delegation is documented in .env.example under the name wired", async () => {
  const example = readFileSync(".env.example", "utf8");
  const lines = example.split("\n");
  assert.ok(lines.some(line => line.startsWith(`${RUNG_UI_CONTROL_ENV}=`)),
    `${RUNG_UI_CONTROL_ENV} is documented in .env.example`);
  assert.match(example, /COGNOS_AUTONOMY_RUNGS_UI_CONTROL=false/, "documented as OFF");
  for (const name of Object.values(RUNG_PIN_ENVS)) {
    assert.ok(example.includes(name), `${name} is named in .env.example`);
  }
});

// ==================================================== against a real Postgres
// One boot. The delegation is read from the environment per request, so the
// suite can delete it, prove the refusal, and restore it without a second boot.
process.env[RUNG_UI_CONTROL_ENV] = "true";
const harness = await bootHarness({ [RUNG_UI_CONTROL_ENV]: "true" });
const post = (body) => harness.raw("/api/autonomy/settings", { method: "POST", body });

try {
  await test("the server's own boot path applies the five rung columns", async () => {
    const rows = await harness.sql(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'autonomy_settings' AND column_name LIKE 'rung\\_%'`
    );
    const found = rows.map(r => r.column_name).sort();
    assert.deepEqual(found, Object.values(RUNG_COLUMNS).sort(),
      "PHASE29_SCHEMA is concatenated into db.js, not only into PHASE_SCHEMAS");
    const bypass = await harness.sql(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'autonomy_settings' AND column_name = 'bypass_earning'`
    );
    assert.equal(bypass.length, 1, "and Phase 28's column is wired into boot too");
  });

  await test("the route flips one rung and writes exactly one column", async () => {
    const before = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(before.length, 0, "no row before the first flip");

    const res = await post({ rung: { name: "externalWrites", enabled: true } });
    assert.equal(res.status, 200, res.text?.slice(0, 300));
    assert.equal(res.json.rungs.externalWrites, true);
    assert.equal(res.json.changed, true);
    assert.equal(res.json.rung, "externalWrites");

    const [row] = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(row.rung_external_writes, true);
    assert.equal(row.rung_search, null, "the other four columns were never written");
    assert.equal(row.rung_residents, null);
    assert.equal(row.rung_irreversible, null);
    assert.equal(row.rung_inbound, null);
    assert.equal(row.enabled, false, "a rung flip does not enable autonomy");
    assert.equal(row.outbox_mode, null, "a rung flip does not touch the mode");
    assert.equal(row.auto_authorize_goals, null);
    assert.equal(row.bypass_earning, null);

    const status = await harness.raw("/api/autonomy/status");
    assert.equal(status.json.rung.externalWrites, true, "status reports the resolved rung");
    assert.equal(status.json.settings.rungs.externalWrites, true);
    assert.equal(status.json.settings.canSetRungs, true);

    const audit = await harness.sql(
      `SELECT action, resource_id, detail FROM workspace_audit WHERE action = 'autonomy.rung'`
    );
    assert.equal(audit.length, 1, "one audit row for one flip");
    assert.equal(audit[0].resource_id, "externalWrites");
    assert.equal(audit[0].detail.to, true);
  });

  await test("a second flip narrows the same column without disturbing the first", async () => {
    const on = await post({ rung: { name: "search", enabled: true } });
    assert.equal(on.status, 200, on.text?.slice(0, 300));
    const [row] = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(row.rung_search, true);
    assert.equal(row.rung_external_writes, true, "the rung next to it still holds its value");

    const off = await post({ rung: { name: "externalWrites", enabled: false } });
    assert.equal(off.status, 200);
    const [after] = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(after.rung_external_writes, false, "the brake lands");
    assert.equal(after.rung_search, true, "and the other rung is untouched");
    assert.equal(off.json.note.includes("off"), true, "the response says what it means");
  });

  await test("the route refuses an unknown rung and a two-switch request", async () => {
    const unknown = await post({ rung: { name: "everything", enabled: true } });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.code, "unknown_rung");
    assert.deepEqual(unknown.json.rungs, [...RUNG_KEYS], "the refusal lists what a rung can be");

    const badValue = await post({ rung: { name: "search", enabled: "yes" } });
    assert.equal(badValue.status, 400);
    assert.equal(badValue.json.code, "bad_rung_value");

    const both = await post({ enabled: true, rung: { name: "search", enabled: true } });
    assert.equal(both.status, 400);
    assert.equal(both.json.code, "one_switch_per_request");

    const [row] = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(row.rung_search, true, "none of the refusals changed a stored value");
  });

  await test("with no delegation the route refuses with a sentence and stores nothing", async () => {
    const [before] = await harness.sql(`SELECT * FROM autonomy_settings`);
    delete process.env[RUNG_UI_CONTROL_ENV];
    resetSettingsCache();
    try {
      const res = await post({ rung: { name: "irreversible", enabled: true } });
      assert.equal(res.status, 409, res.text?.slice(0, 300));
      assert.equal(res.json.code, "not_delegated");
      assert.match(res.json.error, /COGNOS_AUTONOMY_RUNGS_UI_CONTROL=true/);
    } finally {
      process.env[RUNG_UI_CONTROL_ENV] = "true";
      resetSettingsCache();
    }
    const [after] = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(after.rung_irreversible, null, "a refused flip writes nothing");
    assert.equal(after.rung_search, before.rung_search);
  });

  await test("a fresh read agrees with what the flips stored", async () => {
    const status = await harness.raw("/api/autonomy/status?fresh=1");
    assert.equal(status.json.settings.rungs.search, true);
    assert.equal(status.json.settings.rungs.externalWrites, false);
    assert.equal(status.json.rung.search, true, "config.rung and the settings snapshot agree");
  });
} finally {
  await harness.stop();
  resetSettingsCache();
}

console.log(`\nPHASE29 RESULT: ${passed} passed`);
