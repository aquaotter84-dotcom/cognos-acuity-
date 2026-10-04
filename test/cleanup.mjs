// Cleanup agent (Phase 33): pure detection plus the proposal/decide flow
// against a fake db. The authority model under test: exact duplicates tidy
// themselves; everything else waits for Jeremy's approve/refuse, and a refusal
// stands — the row is never touched again.
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeContent,
  findExactDuplicateGroups,
  pickCanonical,
  findNearDuplicatePairs,
  findRedundantKeyGroups,
  findSubsumedPairs,
  findFragmentGroups,
  findStaleVolatile,
  findOrphanGraphNodes,
  findDuplicateGraphEdges,
  findDeadEndComponents,
  findContradictions,
  proposalKeyFor,
  proposeFinding,
  decideCleanupProposal,
  cleanupDue,
  NEAR_DUPE_THRESHOLD
} from "../server/autonomy/cleanup.js";
import { renderNotice } from "../server/autonomy/notice.js";

const mem = (id, content, extra = {}) => ({
  id, content,
  memory_layer: "semantic",
  memory_key: null,
  importance: 1,
  evidence_level: "inferred",
  volatility: "low",
  created_date: "2026-09-01T00:00:00Z",
  updated_date: "2026-09-01T00:00:00Z",
  ...extra
});

// ---------------------------------------------------------------------------
await test("exact duplicates group by identical content", async () => {
  const rows = [
    mem("a", "Jeremy likes strong coffee"),
    mem("b", "Jeremy likes strong coffee "),
    mem("c", "something entirely different")
  ];
  const groups = findExactDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].ids].sort(), ["a", "b"]);
});

await test("pickCanonical keeps the most important, then the newest", async () => {
  const rows = [
    mem("old", "same words here", { importance: 5, created_date: "2026-08-01T00:00:00Z" }),
    mem("new", "same words here", { importance: 1, created_date: "2026-09-01T00:00:00Z" })
  ];
  assert.equal(pickCanonical(rows, ["old", "new"]), "old");
  const rows2 = [
    mem("old", "same words here", { importance: 1, created_date: "2026-08-01T00:00:00Z" }),
    mem("new", "same words here", { importance: 1, created_date: "2026-09-01T00:00:00Z" })
  ];
  assert.equal(pickCanonical(rows2, ["old", "new"]), "new", "ties break newest-first");
});

await test("near-duplicate pairs need embeddings and stay in-layer", async () => {
  const emb = (x) => JSON.stringify([x, 1 - x, 0.5]);
  const rows = [
    mem("a", "the river is high today my friend", { embedding: emb(0.9), memory_layer: "episodic" }),
    mem("b", "the river is high today my friend!", { embedding: emb(0.9), memory_layer: "episodic" }),
    mem("c", "the river is high today my friend", { embedding: emb(0.9), memory_layer: "semantic" }),
    mem("d", "totally unrelated content here", { embedding: emb(0.1), memory_layer: "episodic" }),
    mem("e", "no embedding at all")
  ];
  const { pairs } = findNearDuplicatePairs(rows, { threshold: NEAR_DUPE_THRESHOLD });
  const keys = pairs.map(p => [p.aId, p.bId].sort().join("+"));
  assert.ok(keys.includes("a+b"), "same layer, near-identical content pairs");
  assert.ok(!keys.some(k => k.includes("c")), "cross-layer never pairs");
  assert.ok(!keys.some(k => k.includes("e")), "rows without embeddings are skipped");
  assert.ok(pairs.every(p => p.similarity >= NEAR_DUPE_THRESHOLD));
});

await test("redundant keys: same key, different content", async () => {
  const rows = [
    mem("a", "first version", { memory_key: "working.plan" }),
    mem("b", "second version", { memory_key: "working.plan" }),
    mem("c", "repeated", { memory_key: "stable.key" }),
    mem("d", "repeated", { memory_key: "stable.key" })
  ];
  const groups = findRedundantKeyGroups(rows);
  assert.equal(groups.length, 1, "byte-identical rows under one key are dupes, not redundancy");
  assert.equal(groups[0].key, "working.plan");
});

await test("subsumed pairs find the shorter row inside the longer", async () => {
  const long = "jeremy works at SB precision builders in little river south carolina doing hurricane reinforcement";
  const rows = [mem("long", long), mem("short", "sb precision builders in little river")];
  const pairs = findSubsumedPairs(rows);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].longerId, "long");
  assert.equal(pairs[0].shorterId, "short");
});

await test("fragments are tiny, low-importance, weakly-evidenced — and dreams are never fragments", async () => {
  const rows = [
    mem("f1", "tiny note one", { importance: 2, evidence_level: "inferred", memory_layer: "episodic" }),
    mem("f2", "tiny note two", { importance: 1, evidence_level: "assumed", memory_layer: "episodic" }),
    mem("big", "this is a much longer note that cannot be a fragment of anything", { importance: 1 }),
    mem("dream", "tiny dream line", {
      importance: 1, evidence_level: "inferred", memory_layer: "self",
      memory_key: "dream.2026-10-01", source: "heartbeat.dream"
    })
  ];
  const groups = findFragmentGroups(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].ids].sort(), ["f1", "f2"], "dreams are excluded from fragment merges");
});

await test("stale volatile: high volatility untouched for 30+ days", async () => {
  const now = Date.parse("2026-10-03T00:00:00Z");
  const rows = [
    mem("stale", "price of lumber today", { volatility: "high", updated_date: "2026-08-01T00:00:00Z" }),
    mem("fresh", "price of lumber today", { volatility: "high", updated_date: "2026-09-20T00:00:00Z" }),
    mem("calm", "jeremy's birthday", { volatility: "low", updated_date: "2026-08-01T00:00:00Z" })
  ];
  assert.deepEqual(findStaleVolatile(rows, now), ["stale"]);
});

// ---------------------------------------------------------------------------
await test("graph: orphans, duplicate edges, dead ends, contradictions", async () => {
  const nodes = [
    { id: "n1", status: "active", trust: "trusted", created_date: "2026-08-01T00:00:00Z", label: "n1" },
    { id: "n2", status: "active", trust: "untrusted", created_date: "2026-08-01T00:00:00Z", label: "n2" },
    { id: "n3", status: "active", trust: "untrusted", created_date: "2026-08-01T00:00:00Z", label: "n3" },
    { id: "fresh", status: "active", trust: "untrusted", created_date: "2026-10-02T00:00:00Z", label: "fresh" }
  ];
  const edges = [
    { id: "e1", status: "active", kind: "relates", src_node_id: "n1", dst_node_id: "n2", edge_sha256: "h1" },
    { id: "e2", status: "active", kind: "relates", src_node_id: "n1", dst_node_id: "n2", edge_sha256: "h1" },
    { id: "e3", status: "active", kind: "contradicts", src_node_id: "n2", dst_node_id: "n3", edge_sha256: "h3" }
  ];
  const now = Date.parse("2026-10-03T00:00:00Z");
  // n1/n2/n3 are all connected via active edges; "fresh" has no edges but is
  // inside the 7-day grace window.
  assert.deepEqual(findOrphanGraphNodes(nodes, edges, now), [],
    "grace window protects new nodes");
  const orphans = findOrphanGraphNodes(
    nodes.map(n => (n.id === "fresh" ? n : { ...n, created_date: "2026-08-01T00:00:00Z" })),
    edges.filter(e => e.id !== "e3"),
    now
  );
  assert.deepEqual(orphans, ["n3"], "n3 loses its only edge");
  assert.deepEqual(findDuplicateGraphEdges(edges), [["e1", "e2"]]);
  assert.deepEqual(findContradictions(edges), ["e3"]);
  const dead = findDeadEndComponents(
    [{ id: "u1", status: "active", trust: "untrusted", created_date: "2026-08-01T00:00:00Z" },
     { id: "u2", status: "active", trust: "untrusted", created_date: "2026-08-01T00:00:00Z" },
     { id: "t1", status: "active", trust: "trusted", created_date: "2026-08-01T00:00:00Z" }],
    [{ id: "x1", status: "active", src_node_id: "u1", dst_node_id: "u2" }],
    now
  );
  assert.deepEqual(dead, [["u1", "u2"]], "trusted nodes keep their corner alive");
});

// ---------------------------------------------------------------------------
// A fake db good enough for the proposal/decide path. SQL shape is asserted
// loosely: decideCleanupProposal drives the store through its own helpers.
// ---------------------------------------------------------------------------
function fakeDb() {
  const proposals = new Map();
  const memories = new Map();
  let seq = 0;
  const db = {
    async query(sql, params) { return []; },
    CleanupProposal: {
      async create(data) {
        const row = { id: `clnp${++seq}`, ...data, created_date: new Date().toISOString(), applied_ms: null, reason: null, decided_by: null };
        proposals.set(row.id, row);
        return row;
      },
      async get(id) { return proposals.get(id) || null; },
      async findByKey(workspaceId, key) {
        return [...proposals.values()].find(p => p.workspace_id === workspaceId && p.proposal_key === key) || null;
      },
      async decide(id, { status, reason, decidedBy }) {
        const row = proposals.get(id);
        if (!row || !["requested", "approved"].includes(row.status)) return null;
        Object.assign(row, { status, reason, decided_by: decidedBy, decided_ms: Date.now() });
        return row;
      },
      async markApplied(id) {
        const row = proposals.get(id);
        if (row) { row.status = "applied"; row.applied_ms = Date.now(); }
        return row;
      }
    },
    Memory: {
      async update(id, patch) {
        const m = memories.get(id) || { id, is_enabled: true };
        Object.assign(m, patch);
        memories.set(id, m);
        return m;
      },
      async create(data) {
        const row = { id: `mem${++seq}`, ...data };
        memories.set(row.id, row);
        return row;
      },
      get: (id) => memories.get(id) || null
    },
    _memories: memories,
    _proposals: proposals
  };
  return db;
}

await test("proposal keys are stable and idempotent", async () => {
  const k1 = proposalKeyFor({ store: "memories", kind: "near_duplicate", targetIds: ["b", "a"] });
  const k2 = proposalKeyFor({ store: "memories", kind: "near_duplicate", targetIds: ["a", "b"] });
  assert.equal(k1, k2, "target order does not change the key");

  const db = fakeDb();
  const first = await proposeFinding(db, "ws1", {
    store: "memories", kind: "near_duplicate", title: "Two memories say nearly the same thing",
    detail: { ids: ["a", "b"] }, targetIds: ["a", "b"]
  });
  assert.equal(first.duplicate, false);
  const second = await proposeFinding(db, "ws1", {
    store: "memories", kind: "near_duplicate", title: "Two memories say nearly the same thing",
    detail: { ids: ["a", "b"] }, targetIds: ["a", "b"]
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.proposal.id, first.proposal.id, "a repeat finding resolves to the open proposal");
});

await test("approve applies the disable synchronously; refuse stands", async () => {
  const db = fakeDb();
  db.Memory.update("keep", { is_enabled: true, content: "canonical" });
  db.Memory.update("dupe", { is_enabled: true, content: "canonical-ish" });

  const { proposal } = await proposeFinding(db, "ws1", {
    store: "memories", kind: "near_duplicate", title: "merge",
    detail: { ids: ["keep", "dupe"], canonicalId: "keep" }, targetIds: ["keep", "dupe"]
  });

  const approved = await decideCleanupProposal({ db, proposalId: proposal.id, decision: "approve" });
  assert.equal(approved.ok, true);
  assert.equal(approved.status, "applied");
  assert.equal(db.Memory.get("dupe").is_enabled, false, "the loser is soft-disabled, never deleted");
  assert.equal(db.Memory.get("keep").is_enabled, true);
  assert.notEqual(db._proposals.get(proposal.id).applied_ms, null);

  const again = await decideCleanupProposal({ db, proposalId: proposal.id, decision: "approve" });
  assert.equal(again.ok, false, "an applied proposal cannot be applied twice");

  const { proposal: p2 } = await proposeFinding(db, "ws1", {
    store: "memories", kind: "fragment_merge", title: "merge",
    detail: { ids: ["keep", "dupe"], layer: "semantic" }, targetIds: ["keep", "dupe"]
  });
  const refused = await decideCleanupProposal({ db, proposalId: p2.id, decision: "refuse" });
  assert.equal(refused.ok, true);
  assert.equal(refused.status, "refused");
  assert.equal(db.Memory.get("keep").is_enabled, true, "a refusal touches nothing");
  const retry = await decideCleanupProposal({ db, proposalId: p2.id, decision: "approve" });
  assert.equal(retry.ok, false, "a refused proposal stays refused");
});

await test("fragment merge writes one merged memory and disables the parts", async () => {
  const db = fakeDb();
  db.Memory.update("f1", { is_enabled: true });
  db.Memory.update("f2", { is_enabled: true });
  const { proposal } = await proposeFinding(db, "ws1", {
    store: "memories", kind: "fragment_merge", title: "merge",
    detail: { ids: ["f1", "f2"], layer: "episodic", previews: { f1: "alpha", f2: "beta" } },
    targetIds: ["f1", "f2"]
  });
  const out = await decideCleanupProposal({ db, proposalId: proposal.id, decision: "approve" });
  assert.equal(out.ok, true);
  const merged = db.Memory.get(out.mergedId);
  assert.ok(merged, "a merged memory exists");
  assert.equal(merged.memory_layer, "episodic");
  assert.equal(merged.source, "cleanup.merge");
  assert.ok(String(merged.content).includes("alpha") && String(merged.content).includes("beta"));
  assert.equal(db.Memory.get("f1").is_enabled, false);
  assert.equal(db.Memory.get("f2").is_enabled, false);
});

// ---------------------------------------------------------------------------
await test("cleanupDue: one pass per day", async () => {
  const mkRun = (finished_ms) => ({
    CleanupRun: {
      async last() { return finished_ms == null ? null : { finished_ms }; }
    }
  });
  assert.equal(await cleanupDue(mkRun(null), "ws"), true, "never ran → due");
  const now = Date.parse("2026-10-03T12:00:00Z");
  assert.equal(await cleanupDue(mkRun(Date.parse("2026-10-03T08:00:00Z")), "ws", now), false, "same day → not due");
  assert.equal(await cleanupDue(mkRun(Date.parse("2026-10-02T08:00:00Z")), "ws", now), true, "yesterday → due");
});

await test("cleanup_report notice reads warm and plain", async () => {
  const both = renderNotice("cleanup_report", { tidied: 12, awaitingReview: 3 });
  assert.ok(both.includes("tidied up 12 things"), "plain count of the auto-tidy");
  assert.ok(both.includes("3 things need your call"), "plain count of the review queue");
  assert.ok(!both.includes("cleanup_report") && !both.includes("proposal"), "no jargon in the text");
  const onlyReview = renderNotice("cleanup_report", { tidied: 0, awaitingReview: 1 });
  assert.ok(onlyReview.includes("One thing needs your call"));
  const tidy = renderNotice("cleanup_report", { tidied: 0, awaitingReview: 0 });
  assert.ok(tidy.includes("everything already looks tidy"));
});
