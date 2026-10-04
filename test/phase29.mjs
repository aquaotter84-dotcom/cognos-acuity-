#!/usr/bin/env node
// Phase 29 — the RUNG switches, as DELEGATED operator switches.
//
// THE CLAIM UNDER TEST. A rung is the operator's sign-off that a capability
// EXISTS in this deployment. Phase 19 read them straight from the environment,
// so moving one meant a Railway variable and a restart.
//
// Phase 34 removed the two writing rungs (externalWrites, irreversible) with
// the earned requirement: T4/T5 are allowed whenever built, gated per effect
// by the Governor and by Jeremy's approval. Three rungs remain — residents,
// search, inbound — all pure operator switches that were never earned.
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
//   * one rung flip writes ONE column, and it does not disturb the other two,
//     the mode, auto-authorize or enablement — proved against a real Postgres,
//     through the real route;
//   * the route refuses an unknown rung and a two-switch request, and records
//     an autonomy.rung audit row for a flip that lands;
//   * the new delegation is documented in .env.example under the name wired;
//   * the three columns are applied by the SERVER's own boot path, not only by
//     scripts/migrate.mjs.

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
    assert.equal(rungRefusal("search").code, "not_delegated");

    // Delegation without a stored row is still OFF: an unread row is not a
    // permission, and a database blip must not open a capability.
    process.env[RUNG_UI_CONTROL_ENV] = "true";
    resetSettingsCache();
    assert.equal(effectiveRung("search"), false);
    assert.equal(rungRefusal("search"), null, "with delegation the page MAY flip it");
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
  await withEnv({ ...noPins, [RUNG_UI_CONTROL_ENV]: "true", [RUNG_PIN_ENVS.search]: "false" },
    async () => {
      const writes = [];
      const outcome = await setRung(settingsDb(writes), { rung: "search", enabled: true });
      assert.equal(outcome.ok, false, "a pinned-off rung cannot be opened from the page");
      assert.equal(outcome.refusal.code, "pinned_by_operator");
      assert.match(outcome.refusal.message, /COGNOS_AUTONOMY_SEARCH/,
        "the refusal names the variable to remove");
      assert.deepEqual(writes, [], "nothing was written");
      assert.equal(effectiveRung("search"), false);

      // A pin ON is also final: the page cannot close a rung an operator opened.
      process.env[RUNG_PIN_ENVS.inbound] = "true";
      resetSettingsCache();
      assert.equal(effectiveRung("inbound"), true);
      assert.equal(rungRefusal("inbound").code, "pinned_by_operator");
    });
});

await test("an unknown rung reads as OFF and is refused on write", async () => {
  await withEnv({ ...noPins, [RUNG_UI_CONTROL_ENV]: "true" }, async () => {
    assert.equal(isRungKey("search"), true);
    assert.equal(isRungKey("externalWrites"), false, "the writing rungs are gone");
    assert.equal(isRungKey("Search"), false, "keys are exact — no case folding");
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
    const on = await setRung(settingsDb(writes), { rung: "search", enabled: true });
    assert.equal(on.ok, true, JSON.stringify(on.refusal));
    assert.equal(on.settings.rungs.search, true, "write-through: the response is the new truth");
    assert.equal(effectiveRung("search"), true);
    assert.equal(describeSettings().stored.rungs.search, true);
    assert.equal(on.settings.rungs.residents, false, "the other two are untouched");
    assert.deepEqual(effectiveRungs(), { residents: false, search: true, inbound: false });
    assert.equal(writes.filter(w => w.writer === "rung").length, 1);
    assert.ok(writes.some(w => w.writer === "audit" && w.action === "autonomy.rung"),
      "the flip is recorded as its own audit action");

    const off = await setRung(settingsDb(), { rung: "search", enabled: false });
    assert.equal(off.ok, true);
    assert.equal(effectiveRung("search"), false, "the brake needs no permission");
  });
});

await test("a flip with no delegation is refused with a sentence and stores nothing", async () => {
  await withEnv(noPins, async () => {
    const writes = [];
    const outcome = await setRung(settingsDb(writes), { rung: "search", enabled: true });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refusal.code, "not_delegated");
    assert.match(outcome.refusal.message, /COGNOS_AUTONOMY_RUNGS_UI_CONTROL=true/);
    assert.deepEqual(writes, [], "nothing was written");
    assert.equal(effectiveRung("search"), false);
  });
});

await test("Phase 34: T4/T5 need no rung — allowed when built, approval still gates", async () => {
  await withEnv(noPins, async () => {
    const cfg = autonomyConfig();
    assert.equal(tierAllowed("T4", cfg), cfg.builtTiers.includes("T4"),
      "T4 follows the build, not a rung flag");
    assert.equal(tierAllowed("T5", cfg), cfg.builtTiers.includes("T5"),
      "T5 follows the build, not a rung flag");
    assert.equal(cfg.liveDestination.configured, false,
      "no approved destination is implied by anything here");
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

await test("the column map covers exactly the three rungs", async () => {
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
  await test("the server's own boot path applies the three rung columns", async () => {
    const rows = await harness.sql(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'autonomy_settings' AND column_name LIKE 'rung\\_%'`
    );
    const found = rows.map(r => r.column_name);
    for (const col of Object.values(RUNG_COLUMNS)) {
      assert.ok(found.includes(col), `${col} is applied by the server boot path`);
    }
    // The retired writing-rung columns stay in the schema, unread — like
    // bypass_earning, they are harmless history, not a migration.
  });

  await test("the route flips one rung and writes exactly one column", async () => {
    const before = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(before.length, 0, "no row before the first flip");

    const res = await post({ rung: { name: "residents", enabled: true } });
    assert.equal(res.status, 200, res.text?.slice(0, 300));
    assert.equal(res.json.rungs.residents, true);
    assert.equal(res.json.changed, true);
    assert.equal(res.json.rung, "residents");

    const [row] = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(row.rung_residents, true);
    assert.equal(row.rung_search, null, "the other two columns were never written");
    assert.equal(row.rung_inbound, null);
    assert.equal(row.enabled, false, "a rung flip does not enable autonomy");
    assert.equal(row.outbox_mode, null, "a rung flip does not touch the mode");
    assert.equal(row.auto_authorize_goals, null);

    const status = await harness.raw("/api/autonomy/status");
    assert.equal(status.json.rung.residents, true, "status reports the resolved rung");
    assert.equal(status.json.settings.rungs.residents, true);
    assert.equal(status.json.settings.canSetRungs, true);

    const audit = await harness.sql(
      `SELECT action, resource_id, detail FROM workspace_audit WHERE action = 'autonomy.rung'`
    );
    assert.equal(audit.length, 1, "one audit row for one flip");
    assert.equal(audit[0].resource_id, "residents");
    assert.equal(audit[0].detail.to, true);
  });

  await test("a second flip narrows the same column without disturbing the first", async () => {
    const on = await post({ rung: { name: "search", enabled: true } });
    assert.equal(on.status, 200, on.text?.slice(0, 300));
    const [row] = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(row.rung_search, true);
    assert.equal(row.rung_residents, true, "the rung next to it still holds its value");

    const off = await post({ rung: { name: "residents", enabled: false } });
    assert.equal(off.status, 200);
    const [after] = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(after.rung_residents, false, "the brake lands");
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
      const res = await post({ rung: { name: "inbound", enabled: true } });
      assert.equal(res.status, 409, res.text?.slice(0, 300));
      assert.equal(res.json.code, "not_delegated");
      assert.match(res.json.error, /COGNOS_AUTONOMY_RUNGS_UI_CONTROL=true/);
    } finally {
      process.env[RUNG_UI_CONTROL_ENV] = "true";
      resetSettingsCache();
    }
    const [after] = await harness.sql(`SELECT * FROM autonomy_settings`);
    assert.equal(after.rung_inbound, null, "a refused flip writes nothing");
    assert.equal(after.rung_search, before.rung_search);
  });

  await test("a fresh read agrees with what the flips stored", async () => {
    const status = await harness.raw("/api/autonomy/status?fresh=1");
    assert.equal(status.json.settings.rungs.search, true);
    assert.equal(status.json.settings.rungs.residents, false);
    assert.equal(status.json.rung.search, true, "config.rung and the settings snapshot agree");
  });
} finally {
  await harness.stop();
  resetSettingsCache();
}

console.log(`\nPHASE29 RESULT: ${passed} passed`);
