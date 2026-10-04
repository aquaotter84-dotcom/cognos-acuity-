#!/usr/bin/env node
// Phase 37d — operator-owned ledger: PATCH and DELETE on /api/knowledge/events/:id.
// Jeremy's record, his call.
//
// What this file proves:
//   * PATCH merges {delta, to_state} over the existing JSON and returns the updated event.
//   * PATCH rejects non-object delta/to_state with 400.
//   * PATCH on an unknown id -> 404.
//   * DELETE removes the row and returns {deleted: id}.
//   * DELETE on an unknown id -> 404.
//   * Workspace scoping: an id that belongs to another workspace is a 404 from
//     the default workspace's routes, and the row survives.

import assert from "node:assert/strict";
import { bootHarness } from "./harness.mjs";

const h = await bootHarness();
let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log(`  ok - ${name}`); };

const wsRows = await h.sql(`SELECT id FROM workspaces ORDER BY is_default DESC, created_date ASC LIMIT 1`);
const wsId = wsRows[0].id;
assert.ok(wsId, "harness has a default workspace");

// A second workspace, so scoping is real.
const otherWs = await h.sql(
  `INSERT INTO workspaces (id, name, description, color, icon, is_default)
   VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
  ["ws_phase37d_other", "Other", null, "#3B82F6", "Brain", false]
).then(r => r[0].id);

const ts = () => Date.now();

async function seedEvent({ id, workspaceId, entityId = "ent_a", transition = "belief_created", delta = { confidence: 0.5, note: "old" }, toState = { confidence: 0.5 } }) {
  const rows = await h.sql(
    `INSERT INTO knowledge_events (id, ts_ms, workspace_id, entity_type, entity_id, transition,
      from_state, to_state, delta, source_kind, reversible)
     VALUES ($1,$2,$3,'belief',$4,$5,NULL,$6::jsonb,$7::jsonb,'system',true)
     RETURNING id, workspace_id, entity_id, transition, delta, to_state, reversible`,
    [id, ts(), workspaceId, entityId, transition, JSON.stringify(toState), JSON.stringify(delta)]
  );
  return rows[0];
}

const E1 = await seedEvent({ id: "kev_phase37d_1", workspaceId: wsId });
const E2 = await seedEvent({ id: "kev_phase37d_2", workspaceId: wsId, delta: { confidence: 0.9 } });
const FOREIGN = await seedEvent({ id: "kev_phase37d_foreign", workspaceId: otherWs });

// --- PATCH -----------------------------------------------------------------
await ok("PATCH merges delta over the existing object and returns the event", async () => {
  const r = await h.raw(`/api/knowledge/events/${E1.id}`, {
    method: "PATCH",
    body: { delta: { note: "new", confidence: 0.8 } }
  });
  assert.equal(r.status, 200, `status=${r.status} ${r.text?.slice(0, 200)}`);
  const ev = r.json.event;
  assert.equal(ev.id, E1.id);
  // merged: note replaced, and (per the merge contract) the patched fields win
  assert.equal(ev.delta.note, "new");
  assert.equal(ev.delta.confidence, 0.8);
  // hydrated shape matches the GET route's contract
  assert.equal(typeof ev.seq, "number");
  assert.equal(typeof ev.ts_ms, "number");
  assert.ok(ev.at && ev.at.endsWith("Z"));
  assert.equal(ev.reversible, true);
});

await ok("PATCH keeps untouched fields when only delta is sent", async () => {
  const r = await h.raw(`/api/knowledge/events/${E1.id}`, { method: "PATCH", body: { delta: { extra: 1 } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.event.delta.extra, 1);
  assert.equal(r.json.event.delta.note, "new", "previous delta merge survives");
});

await ok("PATCH merges to_state as well", async () => {
  const r = await h.raw(`/api/knowledge/events/${E1.id}`, {
    method: "PATCH",
    body: { to_state: { confidence: 0.7, status: "active" } }
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.event.to_state.confidence, 0.7);
  assert.equal(r.json.event.to_state.status, "active");
});

await ok("PATCH with an empty body leaves the row alone", async () => {
  const before = await h.sql(`SELECT delta FROM knowledge_events WHERE id=$1`, [E1.id]);
  const r = await h.raw(`/api/knowledge/events/${E1.id}`, { method: "PATCH", body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.event.delta, before[0].delta);
});

await ok("PATCH rejects non-object delta with 400", async () => {
  const r = await h.raw(`/api/knowledge/events/${E1.id}`, {
    method: "PATCH",
    body: { delta: "not an object" }
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error || "", /delta/i);
});

await ok("PATCH on an unknown id returns 404", async () => {
  const r = await h.raw(`/api/knowledge/events/kev_phase37d_nope`, { method: "PATCH", body: { delta: { x: 1 } } });
  assert.equal(r.status, 404);
});

await ok("PATCH cannot touch another workspace's event (404, row survives)", async () => {
  const r = await h.raw(`/api/knowledge/events/${FOREIGN.id}`, {
    method: "PATCH",
    body: { delta: { hacked: true } }
  });
  assert.equal(r.status, 404);
  const rows = await h.sql(`SELECT delta FROM knowledge_events WHERE id=$1`, [FOREIGN.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delta.hacked, undefined);
});

// --- DELETE ----------------------------------------------------------------
await ok("DELETE removes the row and returns {deleted: id}", async () => {
  const r = await h.raw(`/api/knowledge/events/${E2.id}`, { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { deleted: E2.id });
  const rows = await h.sql(`SELECT id FROM knowledge_events WHERE id=$1`, [E2.id]);
  assert.equal(rows.length, 0);
});

await ok("DELETE on an unknown id returns 404", async () => {
  const r = await h.raw(`/api/knowledge/events/kev_phase37d_nope`, { method: "DELETE" });
  assert.equal(r.status, 404);
});

await ok("DELETE cannot touch another workspace's event (404, row survives)", async () => {
  const r = await h.raw(`/api/knowledge/events/${FOREIGN.id}`, { method: "DELETE" });
  assert.equal(r.status, 404);
  const rows = await h.sql(`SELECT id FROM knowledge_events WHERE id=$1`, [FOREIGN.id]);
  assert.equal(rows.length, 1);
});

await ok("the deleted row no longer shows in the ledger list", async () => {
  const r = await h.raw(`/api/knowledge/events?limit=1000`);
  assert.equal(r.status, 200);
  const ids = r.json.events.map(e => e.id);
  assert.ok(!ids.includes(E2.id), "deleted id absent from listing");
  assert.ok(ids.includes(E1.id), "surviving id still listed");
});

console.log(`\nphase37d: ${passed} checks passed`);
await h.stop();
process.exit(0);
