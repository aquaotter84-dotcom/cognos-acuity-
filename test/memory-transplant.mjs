// Phase 35 — the Sapphire memory transplant, tested end to end.
//
// Against a real Postgres (PGlite over the wire protocol, like the other
// harness tests): the five-layer rail, edges CRUD, the priced recall walk
// (importance / age / volatility pricing, depth cap, budget), the
// supersede step modeling Jeremy's exact symptom, librarian verbs and shield
// rules, volatility-aware decay with its day-guard and one-time announcement,
// recall instrumentation that never ranks, and the backup-verify-fail-closed
// transplant itself.
//
// Pure units come first; the destructive transplant runs LAST — it wipes the
// memories table for every workspace.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startPglite } from "./pglite.mjs";

import {
  MEMORY_LAYERS, normalizeMemoryLayer, normalizeMemoryType, normalizeMemoryFields,
  MEMORY_SCHEMA_VERSION, DEFAULT_MEMORY_LAYER
} from "../server/memory/structure.js";
import { EDGE_TYPES, linkMemories, edgesFor, adjacencyFromEdges } from "../server/memory/edges.js";
import {
  pricedRecallWalk, supersedeTransientClaims, traversalCost, recordRecall,
  isCoreMemory, importanceNorm, ageDays, isTransientClaim,
  RECALL_BUDGET, RECALL_MAX_DEPTH
} from "../server/memory/recall.js";
import {
  shieldAllows, decayFactor, DECAY_HALF_LIFE_DAYS, decayDue, librarianDue,
  dayKey, extractTemporalRefs, runDecayTick, pruneMemory, reviveMemory,
  atomizeMemory, promoteMemory, markProcessed, runLibrarian, CORE_IMPORTANCE_MIN
} from "../server/memory/librarian.js";
import {
  runMemoryTransplant, transplantDone, TRANSPLANT_MARKER,
  resolveBackupDir, backupFileName
} from "../server/memory/transplant.js";
import { renderNotice } from "../server/autonomy/notice.js";

// ---------------------------------------------------------------------------
// The five-layer rail (pure).
// ---------------------------------------------------------------------------

await test("the rail is exactly Sapphire's five layers", async () => {
  assert.deepEqual([...MEMORY_LAYERS].sort(), ["self", "events", "entities", "knowledge", "goals"].sort());
  assert.equal(DEFAULT_MEMORY_LAYER, "events");
  assert.equal(MEMORY_SCHEMA_VERSION, 2);
});

await test("retired layers map onto the rail; working ceases to exist", async () => {
  assert.equal(normalizeMemoryLayer("working"), "events", "working is gone — chat history covers it");
  assert.equal(normalizeMemoryLayer("short-term"), "events");
  assert.equal(normalizeMemoryLayer("episodic"), "events");
  assert.equal(normalizeMemoryLayer("semantic"), "knowledge");
  assert.equal(normalizeMemoryLayer("persistent"), "knowledge");
  assert.equal(normalizeMemoryLayer("self"), "self");
  assert.equal(normalizeMemoryLayer("entities"), "entities");
  assert.equal(normalizeMemoryLayer("goals"), "goals");
  assert.equal(normalizeMemoryLayer("bogus"), "events", "unknowns fall to the default");
  assert.equal(normalizeMemoryLayer(null), "events");
});

await test("memory_type follows the same rail", async () => {
  assert.equal(normalizeMemoryType("episodic", "events"), "events");
  assert.equal(normalizeMemoryType("semantic", "knowledge"), "knowledge");
  assert.equal(normalizeMemoryType("bogus", "goals"), "goals", "bad types fall back to the layer");
});

await test("write boundary defaults to events and stamps schema v2", async () => {
  const f = normalizeMemoryFields({ content: "Jeremy got home from work." });
  assert.equal(f.memory_layer, "events");
  assert.equal(f.memory_type, "events");
  assert.equal(f.memory_schema_version, 2);
  assert.ok(f.memory_key.length > 0);
});

// ---------------------------------------------------------------------------
// Priced recall (pure).
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-10-04T12:00:00Z");
const mk = (id, extra = {}) => ({
  id,
  content: `memory ${id}`,
  memory_layer: "events",
  memory_type: "events",
  memory_key: null,
  volatility: "medium",
  importance: 5,
  created_date: new Date(NOW).toISOString(),
  ...extra
});

await test("importance prices the walk: important memories cost less", async () => {
  const cheap = traversalCost(mk("a", { importance: 9 }), { nowMs: NOW });
  const dear = traversalCost(mk("b", { importance: 2 }), { nowMs: NOW });
  assert.ok(cheap < dear, `importance 9 (${cheap}) must cost less than importance 2 (${dear})`);
});

await test("temporal grounding: age is a first-class cost, not a tiebreaker", async () => {
  const fresh = traversalCost(mk("a", { created_date: new Date(NOW - 3600_000).toISOString() }), { nowMs: NOW });
  const old = traversalCost(mk("b", { created_date: new Date(NOW - 3 * 86400_000).toISOString() }), { nowMs: NOW });
  assert.ok(old > fresh, `3-day-old (${old}) must cost more than 1-hour-old (${fresh})`);
});

await test("volatility-aware pricing: a stale transient state prices itself out", async () => {
  const staleTransient = mk("a", {
    importance: 8, volatility: "high",
    created_date: new Date(NOW - 3 * 86400_000).toISOString()
  });
  const freshMild = mk("b", {
    importance: 4, volatility: "low",
    created_date: new Date(NOW - 3600_000).toISOString()
  });
  const costStale = traversalCost(staleTransient, { nowMs: NOW });
  const costFresh = traversalCost(freshMild, { nowMs: NOW });
  assert.ok(costFresh < costStale,
    `fresh importance-4 (${costFresh}) must undercut stale importance-8 high-volatility (${costStale})`);
});

await test("depth is capped at 2", async () => {
  const pool = ["h", "a", "b", "c"].map(id => mk(id));
  const edges = [
    { from_memory_id: "h", to_memory_id: "a", edge_type: "mentions" },
    { from_memory_id: "a", to_memory_id: "b", edge_type: "mentions" },
    { from_memory_id: "b", to_memory_id: "c", edge_type: "mentions" }
  ];
  const out = pricedRecallWalk({ pool, seedIds: ["h"], edges, nowMs: NOW });
  const ids = out.map(m => m.id);
  assert.ok(ids.includes("h") && ids.includes("a") && ids.includes("b"), "depths 0-2 admitted");
  assert.ok(!ids.includes("c"), "depth 3 is beyond the cap");
});

await test("the budget runs dry on expensive hops", async () => {
  const pool = [mk("s"), mk("n1", { importance: 1, volatility: "high", created_date: new Date(NOW - 3 * 86400_000).toISOString() }),
    mk("n2", { importance: 1, volatility: "high", created_date: new Date(NOW - 3 * 86400_000).toISOString() })];
  const edges = [
    { from_memory_id: "s", to_memory_id: "n1", edge_type: "mentions" },
    { from_memory_id: "n1", to_memory_id: "n2", edge_type: "mentions" }
  ];
  const out = pricedRecallWalk({ pool, seedIds: ["s"], edges, nowMs: NOW });
  const ids = out.map(m => m.id);
  assert.ok(ids.includes("n1"), "first expensive hop fits the budget");
  assert.ok(!ids.includes("n2"), "the accumulated cost of two expensive hops exceeds the budget");
  const tight = pricedRecallWalk({ pool, seedIds: ["s"], edges, nowMs: NOW, budget: 5 });
  assert.ok(!tight.map(m => m.id).includes("n1"), "a tight budget excludes even the first hop");
});

await test("with no edges the walk degrades to the seed list", async () => {
  const pool = [mk("a"), mk("b")];
  const out = pricedRecallWalk({ pool, seedIds: ["b", "a"], edges: [], nowMs: NOW });
  assert.deepEqual(out.map(m => m.id), ["b", "a"], "seed order preserved");
});

await test("core memories are importance >= 0.9", async () => {
  assert.equal(isCoreMemory({ importance: 9 }), true);
  assert.equal(isCoreMemory({ importance: 10 }), true);
  assert.equal(isCoreMemory({ importance: 8 }), false);
  assert.equal(importanceNorm({ importance: 5 }), 0.5);
});

// ---------------------------------------------------------------------------
// Jeremy's symptom: contradictory transient states.
// "It has all its memories about me in every response. One time it might
// think I just got home from work and the next time it might think I'm
// about to take a nap. Like a roll of the dice, what it remembers."
// ---------------------------------------------------------------------------

await test("supersede: the newer transient state wins; the older is excluded, not demoted", async () => {
  const stale = mk("stale", {
    content: "Jeremy just got home from work",
    memory_key: "user.state.activity", volatility: "high", importance: 7,
    created_date: new Date(NOW - 3 * 86400_000).toISOString()
  });
  const fresh = mk("fresh", {
    content: "Jeremy is about to take a nap",
    memory_key: "user.state.activity", volatility: "high", importance: 5,
    created_date: new Date(NOW - 3600_000).toISOString()
  });
  assert.equal(isTransientClaim(stale), true);
  assert.equal(isTransientClaim(fresh), true);
  const admitted = supersedeTransientClaims([stale, fresh], { nowMs: NOW });
  assert.deepEqual(admitted.map(m => m.id), ["fresh"],
    "the stale state is EXCLUDED — not ranked lower, not present");
});

await test("the full recall path never admits both contradictory states", async () => {
  const stale = mk("stale", {
    content: "Jeremy just got home from work",
    memory_key: "user.state.activity", volatility: "high", importance: 7,
    created_date: new Date(NOW - 3 * 86400_000).toISOString()
  });
  const fresh = mk("fresh", {
    content: "Jeremy is about to take a nap",
    memory_key: "user.state.activity", volatility: "high", importance: 5,
    created_date: new Date(NOW - 3600_000).toISOString()
  });
  // Both seeds fire (the seed chain is indiscriminate) — the walk + supersede
  // is what grounds them.
  const walked = pricedRecallWalk({ pool: [stale, fresh], seedIds: ["stale", "fresh"], edges: [], nowMs: NOW });
  assert.equal(walked.length, 2, "both seeds reach the walk");
  const admitted = supersedeTransientClaims(walked, { nowMs: NOW });
  assert.deepEqual(admitted.map(m => m.id), ["fresh"]);
  assert.ok(!admitted.some(m => m.id === "stale"), "stale state excluded from admission");
});

await test("supersede only collapses same-key transient claims", async () => {
  const a = mk("a", { memory_key: "user.state.activity", volatility: "high", created_date: new Date(NOW - 7200_000).toISOString() });
  const b = mk("b", { memory_key: "user.state.activity", volatility: "high", created_date: new Date(NOW - 3600_000).toISOString() });
  const other = mk("c", { memory_key: "user.state.mood", volatility: "high", created_date: new Date(NOW - 7200_000).toISOString() });
  const calm = mk("d", { memory_key: "user.state.activity", volatility: "low", created_date: new Date(NOW - 7200_000).toISOString() });
  const out = supersedeTransientClaims([a, b, other, calm], { nowMs: NOW });
  assert.deepEqual(out.map(m => m.id).sort(), ["b", "c", "d"].sort(),
    "different keys survive; low-volatility same-key rows are not transient claims");
});

await test("supersede freshness prefers last_confirmed over created_date", async () => {
  const older = mk("o", {
    memory_key: "user.state.activity", volatility: "high",
    created_date: new Date(NOW - 86400_000).toISOString(),
    last_confirmed: new Date(NOW - 600_000).toISOString()
  });
  const newer = mk("n", {
    memory_key: "user.state.activity", volatility: "high",
    created_date: new Date(NOW - 3600_000).toISOString()
  });
  const out = supersedeTransientClaims([older, newer], { nowMs: NOW });
  assert.deepEqual(out.map(m => m.id), ["o"], "a reconfirmed state beats a merely newer row");
});

// ---------------------------------------------------------------------------
// Instrumentation restraint (pure).
// ---------------------------------------------------------------------------

await test("recall_count and last_recalled never influence pricing or ranking", async () => {
  const quiet = mk("q", { recall_count: 0, last_recalled: null });
  const popular = mk("p", { recall_count: 1000, last_recalled: new Date(NOW).toISOString() });
  assert.equal(traversalCost(quiet, { nowMs: NOW }), traversalCost(popular, { nowMs: NOW }),
    "identical rows price identically regardless of recall history");
  const out = pricedRecallWalk({ pool: [quiet, popular], seedIds: ["q", "p"], edges: [], nowMs: NOW });
  assert.deepEqual(out.map(m => m.id), ["q", "p"], "seed order decides, never the counters");
});

await test("recordRecall never throws and returns 0 on bad input", async () => {
  assert.equal(await recordRecall(null, ["x"]), 0);
  assert.equal(await recordRecall(async () => { throw new Error("down"); }, ["x"]), 0);
  assert.equal(await recordRecall(async () => [], []), 0);
});

// ---------------------------------------------------------------------------
// Real database: PGlite over the wire protocol, like the harness tests.
// ---------------------------------------------------------------------------

const pg = await startPglite({ port: 0 });
process.env.DATABASE_URL = pg.url;
const { db, closeDatabase } = await import("../server/db.js");
await db.query("SELECT 1"); // first query triggers the lazy migration (incl. phase 35)

let memSeq = 0;
async function seedMemory(ws, {
  content = "seeded memory", importance = 5, volatility = "medium",
  memory_layer = "events", memory_type = "events", memory_key = null,
  created_days_ago = 0, is_favorite = false, last_confirmed = null,
  evidence_level = "direct", recall_count = 0, is_enabled = true, source = "test"
} = {}) {
  const id = `tmem${++memSeq}`;
  const created = new Date(Date.now() - created_days_ago * 86400_000).toISOString();
  const rows = await db.query(
    `INSERT INTO memories
       (id, workspace_id, content, memory_type, memory_layer, memory_key, memory_value,
        memory_schema_version, importance, evidence_level, volatility, last_confirmed,
        is_enabled, is_favorite, recall_count, source, created_date, updated_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,2,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
     RETURNING *`,
    [id, ws, content, memory_type, memory_layer, memory_key, JSON.stringify({ text: content }),
     importance, evidence_level, volatility, last_confirmed, is_enabled, is_favorite,
     recall_count, source, created]
  );
  return rows[0];
}

async function makeWorkspace(name) {
  const id = `ws-t${++memSeq}`;
  await db.query(`INSERT INTO workspaces (id, name) VALUES ($1,$2)`, [id, name]);
  return id;
}

// ---------------------------------------------------------------------------
// Edges CRUD (real DB).
// ---------------------------------------------------------------------------

await test("edges: link, idempotent relink, both-direction reads", async () => {
  const ws = await makeWorkspace("edges");
  const a = await seedMemory(ws, { content: "Jeremy got home from work" });
  const b = await seedMemory(ws, { content: "Jeremy is about to take a nap" });
  const e1 = await linkMemories(db, {
    workspace_id: ws, from_memory_id: a.id, to_memory_id: b.id,
    edge_type: "mentions", created_by: "test"
  });
  assert.ok(e1 && e1.id, "first link creates the edge");
  const e2 = await linkMemories(db, {
    workspace_id: ws, from_memory_id: a.id, to_memory_id: b.id, edge_type: "mentions"
  });
  assert.equal(e2, null, "re-linking the same pair+type is a no-op (unique index)");
  const e3 = await linkMemories(db, {
    workspace_id: ws, from_memory_id: a.id, to_memory_id: b.id, edge_type: "structural"
  });
  assert.ok(e3 && e3.id, "a different edge type is a distinct edge");
  const fromA = await edgesFor(db, ws, [a.id]);
  const fromB = await edgesFor(db, ws, [b.id]);
  assert.equal(fromA.length, 2, "edges found from the from-side");
  assert.equal(fromB.length, 2, "edges found from the to-side too");
  assert.equal(await db.MemoryEdge.count(ws), 2);
});

await test("edges: unknown types and self-loops are refused", async () => {
  const ws = await makeWorkspace("edge-validation");
  const a = await seedMemory(ws);
  await assert.rejects(
    () => linkMemories(db, { workspace_id: ws, from_memory_id: a.id, to_memory_id: "other", edge_type: "vibes" }),
    /unknown edge_type/);
  await assert.rejects(
    () => linkMemories(db, { workspace_id: ws, from_memory_id: a.id, to_memory_id: a.id, edge_type: "mentions" }),
    /distinct memory ids/);
  assert.deepEqual(EDGE_TYPES.slice().sort(), ["derived_from", "mentions", "structural"].sort());
});

await test("adjacency is undirected and deduplicated", async () => {
  const adj = adjacencyFromEdges([
    { from_memory_id: "a", to_memory_id: "b", edge_type: "mentions" },
    { from_memory_id: "a", to_memory_id: "b", edge_type: "mentions" },
    { from_memory_id: "b", to_memory_id: "a", edge_type: "mentions" }
  ]);
  assert.deepEqual(adj.get("a").map(e => e.to), ["b"], "duplicate rows collapse");
  assert.deepEqual(adj.get("b").map(e => e.to), ["a"], "traversable both ways");
});

// ---------------------------------------------------------------------------
// Instrumentation against the real table.
// ---------------------------------------------------------------------------

await test("recordRecall bumps recall_count and stamps last_recalled", async () => {
  const ws = await makeWorkspace("instrumentation");
  const m = await seedMemory(ws);
  assert.equal(m.recall_count, 0);
  assert.equal(m.last_recalled, null);
  const touched = await recordRecall(db.query, [m.id, m.id, "missing"]);
  assert.equal(touched, 1, "deduped; the missing id touches nothing");
  const back = await db.Memory.get(m.id);
  assert.equal(back.recall_count, 1);
  assert.ok(back.last_recalled, "last_recalled stamped");
});

// ---------------------------------------------------------------------------
// Librarian verbs + shield rules (real DB).
// ---------------------------------------------------------------------------

await test("shieldAllows: favorites and core refuse prune/atomize; the rest is always allowed", async () => {
  assert.equal(shieldAllows({ is_favorite: true, importance: 5 }, "prune"), false);
  assert.equal(shieldAllows({ is_favorite: false, importance: 10 }, "prune"), false, "importance 10 is core");
  assert.equal(shieldAllows({ is_favorite: false, importance: 9 }, "atomize"), false, "importance 9 is core");
  assert.equal(shieldAllows({ is_favorite: false, importance: 8 }, "prune"), true);
  assert.equal(shieldAllows({ is_favorite: true, importance: 5 }, "promote"), true);
  assert.equal(shieldAllows({ importance: 10 }, "mark_processed"), true);
  assert.equal(CORE_IMPORTANCE_MIN, 9);
});

await test("prune is a soft, reversible retire — and it honors the shield", async () => {
  const ws = await makeWorkspace("prune");
  const plain = await seedMemory(ws, { content: "a plain old note" });
  const fav = await seedMemory(ws, { content: "a favorite", is_favorite: true });
  const core = await seedMemory(ws, { content: "a core pin", importance: 10 });
  const pruned = await pruneMemory(db, plain.id, "librarian_prune");
  assert.equal(pruned.ok, true);
  const parked = await db.Memory.get(plain.id);
  assert.equal(parked.is_enabled, false, "soft-retired, not deleted");
  assert.equal(parked.retired_reason, "librarian_prune");
  const revived = await reviveMemory(db, plain.id);
  assert.equal(revived.ok, true);
  assert.equal((await db.Memory.get(plain.id)).is_enabled, true, "revive restores it");
  const favRefused = await pruneMemory(db, fav.id);
  assert.deepEqual({ ok: favRefused.ok, refused: favRefused.refused }, { ok: false, refused: true });
  assert.equal((await db.Memory.get(fav.id)).is_enabled, true, "the favorite is untouched");
  const coreRefused = await pruneMemory(db, core.id);
  assert.equal(coreRefused.refused, true, "core refuses prune");
  assert.equal((await db.Memory.get(core.id)).is_enabled, true);
});

await test("atomize splits a row with derived_from provenance; shielded rows refuse", async () => {
  const ws = await makeWorkspace("atomize");
  const src = await seedMemory(ws, { content: "Jeremy likes coffee and tea", importance: 6 });
  const out = await atomizeMemory(db, src.id, [
    { content: "Jeremy likes coffee" },
    { content: "Jeremy likes tea" }
  ]);
  assert.equal(out.ok, true);
  assert.equal(out.parts.length, 2);
  const parked = await db.Memory.get(src.id);
  assert.equal(parked.is_enabled, false);
  assert.equal(parked.retired_reason, "atomized");
  const edges = await edgesFor(db, ws, out.parts);
  assert.ok(edges.some(e => e.edge_type === "derived_from" && e.to_memory_id === src.id),
    "parts carry derived_from edges back to the original");
  const fav = await seedMemory(ws, { content: "a favorite", is_favorite: true });
  const refused = await atomizeMemory(db, fav.id, [{ content: "a part" }]);
  assert.equal(refused.refused, true, "favorites refuse atomize");
});

await test("promote copies to a target layer — never a move", async () => {
  const ws = await makeWorkspace("promote");
  const src = await seedMemory(ws, {
    content: "Jeremy's truck needs an oil change", memory_layer: "events", importance: 7, volatility: "low"
  });
  const out = await promoteMemory(db, src.id, "knowledge");
  assert.equal(out.ok, true);
  assert.equal(out.layer, "knowledge");
  const copy = await db.Memory.get(out.id);
  assert.equal(copy.memory_layer, "knowledge");
  assert.equal(copy.volatility, "low", "promoted reference material is durable");
  const original = await db.Memory.get(src.id);
  assert.equal(original.is_enabled, true, "the original is untouched");
  assert.equal(original.memory_layer, "events");
  const edges = await edgesFor(db, ws, [out.id]);
  assert.ok(edges.some(e => e.edge_type === "derived_from" && e.to_memory_id === src.id),
    "promotion provenance is an edge, not a footnote");
  const bad = await promoteMemory(db, src.id, "nether");
  assert.equal(bad.ok, false, "unknown target layers are refused");
});

await test("markProcessed stamps processed_at", async () => {
  const ws = await makeWorkspace("mark-processed");
  const m = await seedMemory(ws);
  assert.equal(m.processed_at, null);
  await markProcessed(db.query, m.id, { nowMs: NOW });
  assert.equal(new Date((await db.Memory.get(m.id)).processed_at).getTime(), NOW);
});

// ---------------------------------------------------------------------------
// Nightly decay (real DB): volatility-aware, day-guarded, announced once.
// ---------------------------------------------------------------------------

await test("decayFactor: high volatility fades in hours-to-a-day, durable facts barely move", async () => {
  const high = decayFactor("high");
  const medium = decayFactor("medium");
  const low = decayFactor("low");
  assert.ok(Math.abs(high - 0.25) < 1e-9, `high half-life 0.5d -> factor 0.25, got ${high}`);
  assert.ok(high < medium && medium < low, "steepest curve on high volatility");
  assert.ok(low > 0.98, `low half-life 60d barely moves per night, got ${low}`);
  assert.deepEqual(Object.keys(DECAY_HALF_LIFE_DAYS).sort(), ["high", "low", "medium"].sort());
});

await test("runDecayTick: volatility rates, shield, floor, day-guard", async () => {
  const ws = await makeWorkspace("decay");
  const high = await seedMemory(ws, { content: "about to take a nap", volatility: "high", importance: 8 });
  const med = await seedMemory(ws, { content: "working on the truck", volatility: "medium", importance: 8 });
  const low = await seedMemory(ws, { content: "born in South Carolina", volatility: "low", importance: 8 });
  const fav = await seedMemory(ws, { content: "favorite transient", volatility: "high", importance: 8, is_favorite: true });
  const core = await seedMemory(ws, { content: "core transient", volatility: "high", importance: 10 });
  const tiny = await seedMemory(ws, { content: "almost gone", volatility: "high", importance: 2 });

  assert.equal(await decayDue(db, ws, NOW), true, "decay is due before the first tick");
  const first = await runDecayTick({ db, workspaceId: ws, nowMs: NOW });
  assert.ok(first.decayed >= 3, `high/medium/tiny decayed, got ${first.decayed}`);
  assert.equal((await db.Memory.get(high.id)).importance, 2, "high: 8 -> ROUND(8*0.25)");
  assert.equal((await db.Memory.get(med.id)).importance, 7, "medium: 8 -> ROUND(8*0.9057)");
  assert.equal((await db.Memory.get(low.id)).importance, 8, "low: unchanged (would round to itself)");
  assert.equal((await db.Memory.get(fav.id)).importance, 8, "favorites never decay");
  assert.equal((await db.Memory.get(core.id)).importance, 10, "core never decays");
  assert.equal((await db.Memory.get(tiny.id)).importance, 1, "importance floors at 1");

  const again = await runDecayTick({ db, workspaceId: ws, nowMs: NOW });
  assert.equal(again.skipped, true, "day-guard: no second tick the same day");
  assert.equal(await decayDue(db, ws, NOW), false);
  assert.equal(await decayDue(db, ws, NOW + 86400_000), true, "due again the next day");
});

await test("decay announces itself exactly once, in warm plain language", async () => {
  const ws = await makeWorkspace("decay-announce");
  await seedMemory(ws, { content: "about to take a nap", volatility: "high", importance: 8 });
  await runDecayTick({ db, workspaceId: ws, nowMs: NOW });
  const notes = await db.query(
    `SELECT * FROM autonomy_notices WHERE workspace_id = $1 AND template_id = 'memory_decay_live'`, [ws]);
  assert.equal(notes.length, 1, "one announcement notice");
  const rendered = renderNotice("memory_decay_live", notes[0].fields);
  assert.ok(rendered && rendered.includes("gently fade"), `plain warm language, got: ${rendered}`);
  assert.ok(rendered.includes("favorites or pinned"));
  // Another decaying night must not announce again.
  await seedMemory(ws, { content: "about to eat lunch", volatility: "high", importance: 8 });
  await runDecayTick({ db, workspaceId: ws, nowMs: NOW + 86400_000 });
  const notes2 = await db.query(
    `SELECT * FROM autonomy_notices WHERE workspace_id = $1 AND template_id = 'memory_decay_live'`, [ws]);
  assert.equal(notes2.length, 1, "the announcement fires exactly once");
});

await test("extractTemporalRefs stamps dates without inventing them", async () => {
  const iso = extractTemporalRefs("met Sam on 2026-09-20 for coffee", NOW);
  assert.equal(iso.event_date, "2026-09-20");
  const rel = extractTemporalRefs("called mom yesterday", NOW);
  assert.equal(rel.event_date, "2026-10-03");
  assert.ok(rel.refs.includes("yesterday"));
  const none = extractTemporalRefs("the sky is blue", NOW);
  assert.equal(none.event_date, null);
});

// ---------------------------------------------------------------------------
// A full librarian night: decay first, five passes, journal, day-guard.
// ---------------------------------------------------------------------------

await test("runLibrarian: decay, five passes, journal row, day-guard, never kills the beat", async () => {
  const ws = await makeWorkspace("librarian-night");
  await seedMemory(ws, { content: "met Sam yesterday at the shop", importance: 5, created_days_ago: 1 });
  assert.equal(await librarianDue(db, ws, NOW), true);
  const night = await runLibrarian({ db, workspaceId: ws, nowMs: NOW });
  assert.equal(night.ok, true);
  for (const pass of ["dates", "link", "dedup", "sort", "self"]) {
    assert.ok(pass in night.passes, `pass ${pass} ran`);
    assert.ok(!("error" in night.passes[pass]), `pass ${pass} did not fail`);
  }
  assert.ok(night.passes.dates.stamped >= 1, "the dates pass stamped the temporal ref");
  assert.equal(night.passes.self.sheet_created, true, "the self sheet is guaranteed");
  const journal = await db.LibrarianRun.last(ws);
  assert.ok(journal && journal.finished_ms, "the night is journaled");
  assert.equal(await librarianDue(db, ws, NOW), false, "day-guard: one night per day");
  const sheet = await db.query(
    `SELECT * FROM memories WHERE workspace_id = $1 AND memory_key = 'self.sheet' AND is_enabled = TRUE`, [ws]);
  assert.equal(sheet.length, 1, "self.sheet exists");
});

await test("the dedup pass retires superseded transient states nightly", async () => {
  const ws = await makeWorkspace("dedup-night");
  await seedMemory(ws, {
    content: "Jeremy just got home from work", memory_key: "user.state.activity",
    volatility: "high", importance: 7, created_days_ago: 3
  });
  const fresh = await seedMemory(ws, {
    content: "Jeremy is about to take a nap", memory_key: "user.state.activity",
    volatility: "high", importance: 5, created_days_ago: 0
  });
  const night = await runLibrarian({ db, workspaceId: ws, nowMs: NOW });
  assert.ok(night.passes.dedup.retired_superseded_transients >= 1,
    "the older transient state retired overnight");
  const rows = await db.query(
    `SELECT id, is_enabled, retired_reason FROM memories
     WHERE workspace_id = $1 AND memory_key = 'user.state.activity' ORDER BY created_date ASC`, [ws]);
  assert.equal(rows[0].is_enabled, false, "the stale state is parked");
  assert.equal(rows[0].retired_reason, "superseded_transient_state");
  assert.equal(rows[1].id, fresh.id, "the fresh state stands");
  assert.equal(rows[1].is_enabled, true);
});

// ---------------------------------------------------------------------------
// The wipe — Jeremy explicitly approved it. Backup, verify, wipe, marker.
// Fail closed. Runs last: it empties the memories table for ALL workspaces.
// ---------------------------------------------------------------------------

await test("backup path helpers", async () => {
  const name = backupFileName(Date.parse("2026-10-04T12:00:00Z"));
  assert.equal(name, "memories-pre-sapphire-2026-10-04.json");
  const keep = { COGNOS_DATA_DIR: process.env.COGNOS_DATA_DIR, COGNOS_BACKUP_DIR: process.env.COGNOS_BACKUP_DIR };
  delete process.env.COGNOS_DATA_DIR;
  delete process.env.COGNOS_BACKUP_DIR;
  assert.equal(resolveBackupDir(), null, "no env, no backup dir");
  process.env.COGNOS_DATA_DIR = "/data/app";
  assert.equal(resolveBackupDir(), path.join("/data/app", "backups"));
  if (keep.COGNOS_DATA_DIR === undefined) delete process.env.COGNOS_DATA_DIR; else process.env.COGNOS_DATA_DIR = keep.COGNOS_DATA_DIR;
  if (keep.COGNOS_BACKUP_DIR === undefined) delete process.env.COGNOS_BACKUP_DIR; else process.env.COGNOS_BACKUP_DIR = keep.COGNOS_BACKUP_DIR;
});

await test("transplant: backup, verify, wipe, marker, notice — conversations stay", async () => {
  const ws = await makeWorkspace("transplant");
  const dream = await seedMemory(ws, {
    content: "The day held two memories.", memory_layer: "self", memory_type: "self",
    memory_key: "dream.2026.10.03", importance: 4, source: "heartbeat.dream"
  });
  const fact = await seedMemory(ws, { content: "Jeremy works at SB Precision Builders", memory_layer: "knowledge" });
  await linkMemories(db, { workspace_id: ws, from_memory_id: fact.id, to_memory_id: dream.id, edge_type: "mentions" });
  // A conversation and a message: hands-off, they stay.
  await db.query(`INSERT INTO conversations (id, workspace_id, title) VALUES ('tconv1', $1, 'hello')`, [ws]);
  await db.query(`INSERT INTO messages (id, conversation_id, workspace_id, role, content) VALUES ('tmsg1', 'tconv1', $1, 'user', 'hi')`, [ws]);
  const before = await db.query(`SELECT COUNT(*)::int AS n FROM memories`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognos-transplant-"));
  const res = await runMemoryTransplant({ db, nowMs: NOW, backupDir: dir });
  assert.equal(res.status, "done");
  assert.ok(res.backup_file.endsWith("memories-pre-sapphire-2026-10-04.json"));
  assert.equal(res.memory_count, before[0].n);

  // The backup verifies by re-parse: marker + row count + the dream row.
  const back = JSON.parse(fs.readFileSync(res.backup_file, "utf8"));
  assert.equal(back.marker, TRANSPLANT_MARKER);
  assert.equal(back.row_count, before[0].n);
  assert.equal(back.rows.length, before[0].n);
  assert.ok(back.rows.some(r => r.memory_key === "dream.2026.10.03"), "dreams go with the backup");

  // The wipe: memories and edges are gone.
  assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM memories`))[0].n, 0);
  assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM memory_edges`))[0].n, 0);

  // Conversations and messages were not touched.
  assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM conversations WHERE id = 'tconv1'`))[0].n, 1);
  assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM messages WHERE id = 'tmsg1'`))[0].n, 1);

  // The marker makes it exactly-once, and Jeremy gets the warm notice.
  const marker = await transplantDone(db.query);
  assert.ok(marker, "marker row set");
  const markerValue = typeof marker.value === "string" ? JSON.parse(marker.value) : marker.value;
  assert.equal(markerValue.row_count, before[0].n);
  const notices = await db.query(
    `SELECT * FROM autonomy_notices WHERE template_id = 'memory_transplant_done' ORDER BY created_ms DESC LIMIT 1`);
  assert.equal(notices.length, 1);
  const rendered = renderNotice("memory_transplant_done", notices[0].fields);
  assert.ok(rendered && rendered.includes(path.basename(res.backup_file)),
    `the notice names the backup file, got: ${rendered}`);
  assert.ok(rendered.includes(dir), "the notice names the backup directory");
});

await test("transplant is exactly-once: the second run does nothing", async () => {
  const survivor = await seedMemory("ws-t9", { content: "written after the wipe" });
  const res = await runMemoryTransplant({ db, nowMs: NOW, backupDir: os.tmpdir() });
  assert.equal(res.status, "already_done");
  assert.equal((await db.Memory.get(survivor.id)).content, "written after the wipe",
    "post-wipe rows are never touched again");
});

await test("transplant fails closed: an unwritable backup dir wipes nothing", async () => {
  await db.query(`DELETE FROM schema_markers WHERE key = $1`, [TRANSPLANT_MARKER]);
  const ws = await makeWorkspace("fail-closed");
  const keep = await seedMemory(ws, { content: "do not lose me" });
  const blocker = path.join(os.tmpdir(), `cognos-blocker-${Date.now()}`);
  fs.writeFileSync(blocker, "i am a file, not a directory");
  const res = await runMemoryTransplant({ db, nowMs: NOW, backupDir: path.join(blocker, "backups") });
  assert.equal(res.status, "backup_failed");
  assert.equal(res.reason, "write_failed");
  assert.equal((await db.Memory.get(keep.id)).content, "do not lose me", "no wipe without a verified backup");
  assert.equal(await transplantDone(db.query), null, "no marker on failure — it retries next boot");
  fs.unlinkSync(blocker);
});

await test("transplant fails closed: no backup directory available", async () => {
  const keep = { COGNOS_DATA_DIR: process.env.COGNOS_DATA_DIR, COGNOS_BACKUP_DIR: process.env.COGNOS_BACKUP_DIR };
  delete process.env.COGNOS_DATA_DIR;
  delete process.env.COGNOS_BACKUP_DIR;
  const before = await db.query(`SELECT COUNT(*)::int AS n FROM memories`);
  const res = await runMemoryTransplant({ db, nowMs: NOW });
  assert.equal(res.status, "no_backup_dir");
  assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM memories`))[0].n, before[0].n,
    "nothing wiped when there is nowhere safe to back up");
  if (keep.COGNOS_DATA_DIR === undefined) delete process.env.COGNOS_DATA_DIR; else process.env.COGNOS_DATA_DIR = keep.COGNOS_DATA_DIR;
  if (keep.COGNOS_BACKUP_DIR === undefined) delete process.env.COGNOS_BACKUP_DIR; else process.env.COGNOS_BACKUP_DIR = keep.COGNOS_BACKUP_DIR;
});

// ---------------------------------------------------------------------------

await test("teardown", async () => {
  await closeDatabase();
  await pg.stop();
});
