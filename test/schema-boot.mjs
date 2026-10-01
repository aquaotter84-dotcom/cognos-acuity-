#!/usr/bin/env node
// Boot-schema wiring regression test. Guards against the 2026-09-30 incident
// where PHASE32_SCHEMA (personas table) was registered in PHASE_SCHEMAS but
// never concatenated into the boot SCHEMA, so fresh/provisioned databases
// shipped without the personas relation and Settings → Personas stuck on
// "Loading…" with `relation "personas" does not exist`.
//
// Contract: every migration entry in PHASE_SCHEMAS (server/db/schema.js) must
// appear verbatim in the assembled boot schema (server/db.js BOOT_SCHEMA).

import assert from 'node:assert/strict';
import { PHASE_SCHEMAS } from '../server/db/schema.js';
import { BOOT_SCHEMA } from '../server/db.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; };

// --- registry sanity ---------------------------------------------------------
ok('PHASE_SCHEMAS is a non-empty registry with unique ids', () => {
  assert.ok(Array.isArray(PHASE_SCHEMAS) && PHASE_SCHEMAS.length > 0);
  const ids = PHASE_SCHEMAS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'migration ids must be unique');
  for (const e of PHASE_SCHEMAS) {
    assert.ok(typeof e.sql === 'string' && e.sql.trim().length > 0, `${e.id} carries SQL`);
  }
});

// --- boot wiring -------------------------------------------------------------
for (const entry of PHASE_SCHEMAS) {
  ok(`boot schema applies migration ${entry.id}`, () => {
    assert.ok(
      BOOT_SCHEMA.includes(entry.sql),
      `PHASE_SCHEMAS entry ${entry.id} is missing from the boot SCHEMA — ` +
      'add its PHASE*_SCHEMA constant to the SCHEMA assembly in server/db.js',
    );
  });
}

// --- the incident's exact case ------------------------------------------------
ok('personas relation ships at boot (incident 2026-09-30)', () => {
  assert.match(BOOT_SCHEMA, /CREATE TABLE IF NOT EXISTS personas/i);
});

console.log(`SCHEMA-BOOT RESULT: ${passed} passed, 0 failed`);
