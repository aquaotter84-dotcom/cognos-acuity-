#!/usr/bin/env node
// Phase 23 regressions: the trust-annotated knowledge graph ("Atlas").
//
// What this file has to prove is the whole arc of the spec in one place:
//   * the atlas holds nodes and edges with provenance seals, and the seals
//     actually detect tampering (hash mismatch < 0.1% is measured, not hoped);
//   * snapshots are immutable and Merkle-rooted, and the diff names changes;
//   * the turn consults the atlas before drafting and projects after
//     governance — and a veto projects nothing;
//   * the Governor refuses invented, retired, and untrusted graph citations,
//     while a citation to a loaded truth-bearing node ships untouched;
//   * curation (pin/fork/revise/retire/trust) writes new rows and ledger
//     events — it never overwrites and never deletes.
//
// The first half is pure (no database, no provider). The second half boots the
// real app against PGlite and drives the routes plus the one send path.

import assert from "node:assert/strict";
import {
  normalizeContextWindowConfig,
  assembleContextWindow
} from "../server/contextWindow.js";
import { auditGraphCitations } from "../server/council/governor.js";
import {
  buildProvenance,
  computeNodeHash,
  computeEdgeHash,
  verifyNodeSeal,
  verifyEdgeSeal,
  merkleRoot,
  formatGraphContext,
  graphBrief
} from "../server/knowledge/graph.js";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log("phase23: pure checks (context slice, governor audit, seals, merkle)");

// --- context window: the graph slice -----------------------------------------
await test("graphTokens normalizes to its own clamped slice (default 1200)", () => {
  assert.equal(normalizeContextWindowConfig({}).graphTokens, 1_200);
  assert.equal(normalizeContextWindowConfig({ graphTokens: 99_999 }).graphTokens, 16_000);
  assert.equal(normalizeContextWindowConfig({ graphTokens: -40 }).graphTokens, 0);
});

await test("the assembled window admits graph rows whole and measures omission", () => {
  const block = (id) => `- [${id}] (concept/active/trusted, truth-bearing) label — content (v1, seal abc)`;
  const graphContext = [
    "KNOWLEDGE GRAPH — TRUST-ANNOTATED ATLAS",
    block("graph_aaa111"),
    block("graph_bbb222"),
    block("graph_ccc333")
  ].join("\n\n");
  const roomy = assembleContextWindow({ userMessage: "hi", graphContext, config: {} });
  assert.ok(roomy.graphContext.includes("[graph_aaa111]"), "admitted rows keep their whole citation id");
  assert.ok(roomy.graphContext.includes("[graph_ccc333]"));
  assert.ok(roomy.metrics.graphTokens > 0);
  assert.equal(roomy.metrics.graphBlocksOmitted, 0);

  const starved = assembleContextWindow({
    userMessage: "hi",
    graphContext,
    config: { maxInputTokens: 4_000, graphTokens: 30 }
  });
  assert.ok(starved.metrics.graphBlocksOmitted > 0, "omission is counted, not silent");
  assert.equal(starved.metrics.clipped, true);
  assert.ok(starved.metrics.estimatedInputTokens <= 4_000, "the budget still holds with the new slice");
  // Whatever survived is whole blocks: no half citation ids leak to the model.
  for (const m of (starved.graphContext || "").matchAll(/\[graph_[a-z0-9]+\]/gi)) {
    assert.match(m[0], /^\[graph_[a-z0-9]+\]$/i);
  }
});

// --- governor: graph citation audit -------------------------------------------
await test("the governor audit passes clean text and loaded truth-bearing nodes", () => {
  assert.deepEqual(auditGraphCitations("plain answer, no citations", { graphNodes: [] }), []);
  const record = {
    graphNodes: [
      { id: "graph_abc123", trust: "verified", status: "active" },
      { id: "graph_def456", trust: "trusted", status: "pinned" }
    ]
  };
  assert.deepEqual(
    auditGraphCitations("As established [graph_abc123], and per [graph_DEF456], done.", record),
    [],
    "exact ids, case-insensitive, truth-bearing: no findings"
  );
});

await test("the governor audit refuses unloaded, retired, and untrusted citations", () => {
  const record = {
    graphNodes: [
      { id: "graph_old999", trust: "verified", status: "retired" },
      { id: "graph_raw111", trust: "untrusted", status: "active" }
    ]
  };
  const f1 = auditGraphCitations("Claim [graph_nope777].", record);
  assert.equal(f1.length, 1);
  assert.match(f1[0], /not loaded for this turn/);
  const f2 = auditGraphCitations("Claim [graph_old999].", record);
  assert.equal(f2.length, 1);
  assert.match(f2[0], /retired/);
  const f3 = auditGraphCitations("Claim [graph_raw111].", record);
  assert.equal(f3.length, 1);
  assert.match(f3[0], /never truth-bearing until a user approves/);
});

// --- formatting ----------------------------------------------------------------
await test("formatGraphContext degrades to null and marks trust honestly", () => {
  assert.equal(formatGraphContext([]), null);
  assert.equal(formatGraphContext(null), null);
  const text = formatGraphContext([
    { id: "graph_a1", type: "concept", status: "active", trust: "trusted", label: "L", content: "C", version: 1, content_sha256: "ab".repeat(32), provenance: {} },
    { id: "graph_b2", type: "event", status: "active", trust: "untrusted", label: "M", content: "N", version: 2, content_sha256: "cd".repeat(32), provenance: {} }
  ]);
  assert.match(text, /\[graph_a1\]/);
  assert.match(text, /truth-bearing/);
  assert.match(text, /NOT truth-bearing until user-approved/);
  const truth = formatGraphContext([{ id: "graph_a1", type: "concept", status: "active", trust: "verified", label: "L", content: "C", version: 1 }], { truthOnly: true });
  assert.match(truth, /truth-bearing rows only/);
});

await test("graphBrief is empty without conflicts and names open ones", () => {
  assert.equal(graphBrief([]), "");
  assert.equal(graphBrief(null), "");
  const brief = graphBrief([
    { edge: { id: "graph_e1" }, src: { label: "Sugar is harmless", trust: "trusted" }, dst: { label: "Sugar harms teeth", trust: "verified" } }
  ]);
  assert.match(brief, /CONFLICT graph_e1/);
  assert.match(brief, /Sugar is harmless/);
  assert.match(brief, /Sugar harms teeth/);
});

// --- seals + merkle --------------------------------------------------------------
await test("provenance seals hold for honest rows and break on tampering", () => {
  const prov = buildProvenance({ actor: "council", version: 1, runId: "run_x", note: "pure test" });
  const nodeRow = { type: "concept", label: "L", content: "C", trust: "trusted", confidence: 0.5, version: 1, predecessor_id: null };
  const sealed = { ...nodeRow, status: "active", provenance: prov, content_sha256: computeNodeHash(nodeRow, prov) };
  assert.equal(verifyNodeSeal(sealed).ok, true);
  assert.equal(verifyNodeSeal({ ...sealed, content: "C, altered" }).ok, false);
  assert.equal(verifyNodeSeal({ ...sealed, trust: "verified" }).ok, false);
  assert.equal(verifyNodeSeal({ ...sealed, provenance: { ...prov, actor: "user" } }).ok, false);

  const edgeRow = { src_node_id: "graph_a", dst_node_id: "graph_b", kind: "is-about", trust: "trusted", weight: 0.5, version: 1, predecessor_id: null };
  const sealedEdge = { ...edgeRow, status: "active", provenance: prov, edge_sha256: computeEdgeHash(edgeRow, prov) };
  assert.equal(verifyEdgeSeal(sealedEdge).ok, true);
  assert.equal(verifyEdgeSeal({ ...sealedEdge, kind: "contradicts" }).ok, false);
});

await test("merkle roots are deterministic, order-free, and change-sensitive", () => {
  const a = merkleRoot(["h1", "h2", "h3"]);
  assert.equal(a, merkleRoot(["h3", "h1", "h2"]), "leaf order must not move the root");
  assert.equal(a, merkleRoot(["h1", "h2", "h3"]), "same set, same root");
  assert.notEqual(a, merkleRoot(["h1", "h2", "h4"]), "one changed leaf moves the root");
  assert.notEqual(a, merkleRoot(["h1", "h2"]), "one missing leaf moves the root");
  assert.equal(merkleRoot([]), merkleRoot(null), "the empty atlas has one stable root");
});

// --- harness ---------------------------------------------------------------------
console.log("phase23: harness checks (routes, curation, turn wiring, veto)");

const h = await bootHarness();
const count = async (table, where = "", params = []) => {
  const rows = await h.sql(`SELECT COUNT(*)::int AS n FROM ${table}${where}`, params);
  return rows[0]?.n ?? 0;
};

await test("health exposes the atlas switches without secrets", async () => {
  const health = await h.raw("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.graph.enabled, true);
  assert.equal(health.json.graph.nodeTypes.length, 5);
  assert.equal(health.json.graph.trustLevels.length, 4);
  assert.ok(JSON.stringify(health.json).length < 20_000);
});

let conceptId;
await test("nodes: create is idempotent and lists with filters", async () => {
  const created = await h.raw("/api/graph/nodes", {
    method: "POST",
    body: { type: "concept", label: "Zyloxicon upkeep calendar", content: "The zyloxicon upkeep calendar is reviewed every spring.", trust: "trusted" }
  });
  assert.equal(created.status, 201);
  conceptId = created.json.node.id;
  assert.match(conceptId, /^graph_/);
  assert.equal(created.json.events >= 1, true);

  const dup = await h.raw("/api/graph/nodes", {
    method: "POST",
    body: { type: "concept", label: "Zyloxicon upkeep calendar", content: "different words, same key", trust: "trusted" }
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.existing, true);
  assert.equal(dup.json.node.id, conceptId);

  const list = await h.raw(`/api/graph/nodes?type=concept&trust=trusted&q=zyloxicon`);
  assert.equal(list.status, 200);
  assert.ok(list.json.nodes.some(n => n.id === conceptId));
  const truth = await h.raw(`/api/graph/nodes?truthOnly=1`);
  assert.ok(truth.json.nodes.some(n => n.id === conceptId), "a trusted node stands under the truth floor");
});

await test("node detail carries edges, lineage, and a holding seal", async () => {
  const detail = await h.raw(`/api/graph/nodes/${conceptId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.seal.ok, true);
  assert.ok((detail.json.lineage?.count ?? 0) >= 1, "creation wrote a ledger event");
  assert.ok(Array.isArray(detail.json.edges));
});

await test("edges: create is idempotent; contradicts edges surface as conflicts", async () => {
  const other = await h.raw("/api/graph/nodes", {
    method: "POST",
    body: { type: "concept", label: "Zyloxicon neglect theory", content: "A disputed claim that the zyloxicon needs no upkeep.", trust: "untrusted" }
  });
  const otherId = other.json.node.id;
  const edge = await h.raw("/api/graph/edges", {
    method: "POST",
    body: { srcNodeId: conceptId, dstNodeId: otherId, kind: "contradicts", trust: "trusted" }
  });
  assert.equal(edge.status, 201);
  const again = await h.raw("/api/graph/edges", {
    method: "POST",
    body: { srcNodeId: conceptId, dstNodeId: otherId, kind: "contradicts" }
  });
  assert.equal(again.json.existing, true);

  const conflicts = await h.raw("/api/graph/conflicts");
  assert.equal(conflicts.status, 200);
  assert.ok(conflicts.json.conflicts.some(c => c.edge.id === edge.json.edge.id), "open contradiction is listed");

  const retired = await h.raw(`/api/graph/edges/${edge.json.edge.id}/retire`, { method: "POST", body: { note: "resolved by test" } });
  assert.equal(retired.json.edge.status, "retired");
  const after = await h.raw("/api/graph/conflicts");
  assert.ok(!after.json.conflicts.some(c => c.edge.id === edge.json.edge.id), "a retired edge leaves the conflict list");
  const rows = await h.sql("SELECT COUNT(*)::int AS n FROM graph_edges WHERE id=$1", [edge.json.edge.id]);
  assert.equal(rows[0].n, 1, "retiring kept the row — it is a transition, not a delete");
});

await test("curation: pin, trust, fork, revise, retire mint new rows, never rewrites", async () => {
  const pinned = await h.raw(`/api/graph/nodes/${conceptId}/pin`, { method: "POST", body: {} });
  assert.equal(pinned.json.node.status, "pinned");
  assert.equal(pinned.json.node.trust, "verified", "pinning mints verified trust");
  assert.ok(pinned.json.events >= 1);

  const moved = await h.raw(`/api/graph/nodes/${conceptId}/trust`, { method: "POST", body: { trust: "trusted" } });
  assert.equal(moved.json.node.trust, "trusted");

  const forked = await h.raw(`/api/graph/nodes/${conceptId}/fork`, { method: "POST", body: { label: "Zyloxicon upkeep calendar (regional fork)" } });
  assert.match(forked.json.node.id, /^graph_/);
  assert.notEqual(forked.json.node.id, conceptId);
  assert.equal(forked.json.forkEdge.kind, "fork");
  const sourceStillThere = await h.raw(`/api/graph/nodes/${conceptId}`);
  assert.equal(sourceStillThere.json.node.status, "pinned", "forking leaves the source row untouched");

  const revised = await h.raw(`/api/graph/nodes/${conceptId}/revise`, {
    method: "POST",
    body: { content: "The zyloxicon upkeep calendar is reviewed every spring and autumn.", note: "cadence corrected" }
  });
  assert.equal(revised.json.revisionEdge.kind, "revision");
  assert.equal(revised.json.node.version, sourceStillThere.json.node.version + 1);
  assert.equal(revised.json.retired.status, "retired");
  const lineage = await h.raw(`/api/graph/nodes/${conceptId}`);
  assert.equal(lineage.json.node.status, "retired", "revision retires the predecessor row in place");
  assert.ok((lineage.json.lineage?.count ?? 0) >= 4, "every curation act is a ledger event");

  // The turn below needs a live trusted node to consult, so retire a fork line
  // instead of the only live copy: retiring is still exercised, on the fork.
  const retireFork = await h.raw(`/api/graph/nodes/${forked.json.node.id}/retire`, { method: "POST", body: { note: "superseded" } });
  assert.equal(retireFork.json.node.status, "retired");
});

await test("query answers under the latency target and honors truthOnly", async () => {
  const live = await h.raw("/api/graph/nodes", {
    method: "POST",
    body: { type: "concept", label: "Quarry bridge load rating", content: "The quarry bridge load rating is forty tonnes.", trust: "trusted" }
  });
  const liveId = live.json.node.id;
  const res = await h.raw(`/api/graph/query?q=${encodeURIComponent("quarry bridge load rating tonnes")}`);
  assert.equal(res.status, 200);
  assert.ok(res.json.nodes.some(n => n.id === liveId), "relevance finds the matching node");
  assert.equal(res.json.latencyTargetMs, 150);
  assert.ok(typeof res.json.latencyMs === "number" && res.json.latencyMs < 150, `query latency ${res.json.latencyMs}ms stays under the 150ms target`);

  await h.raw("/api/graph/nodes", {
    method: "POST",
    body: { type: "concept", label: "Quarry bridge rumor", content: "An unverified rumor about the quarry bridge paint color.", trust: "untrusted" }
  });
  const truthOnly = await h.raw(`/api/graph/query?q=${encodeURIComponent("quarry bridge")}&truthOnly=1`);
  assert.ok(!truthOnly.json.nodes.some(n => n.label === "Quarry bridge rumor"), "truthOnly excludes untrusted rows");
  assert.ok(truthOnly.json.nodes.some(n => n.id === liveId));
});

await test("related traversal walks live edges within its bounds", async () => {
  const a = await h.raw("/api/graph/nodes", { method: "POST", body: { type: "intent", label: "Plan the spring festival", content: "The user intends to plan the spring festival.", trust: "trusted" } });
  const b = await h.raw("/api/graph/nodes", { method: "POST", body: { type: "event", label: "Spring festival date set", content: "The spring festival date was set to May 4.", trust: "trusted" } });
  await h.raw("/api/graph/edges", { method: "POST", body: { srcNodeId: a.json.node.id, dstNodeId: b.json.node.id, kind: "refines", trust: "trusted" } });
  const rel = await h.raw(`/api/graph/related/${a.json.node.id}?depth=2`);
  assert.equal(rel.status, 200);
  assert.ok((rel.json.nodes || []).some(n => n.id === b.json.node.id), "one hop reaches the refined event");
  assert.ok(rel.json.latencyMs < 150);
});

await test("snapshots are immutable and the merkle diff names changes", async () => {
  const s1 = await h.raw("/api/graph/snapshots", { method: "POST", body: { note: "before" } });
  assert.equal(s1.status, 201);
  assert.equal(s1.json.snapshot.merkle_root.length, 64);
  const self = await h.raw(`/api/graph/snapshots/diff?a=${s1.json.snapshot.id}&b=${s1.json.snapshot.id}`);
  assert.equal(self.json.identical, true);

  await h.raw("/api/graph/nodes", { method: "POST", body: { type: "concept", label: "Snapshot sentinel", content: "A node added between two snapshots.", trust: "untrusted" } });
  const s2 = await h.raw("/api/graph/snapshots", { method: "POST", body: { note: "after" } });
  assert.notEqual(s2.json.snapshot.merkle_root, s1.json.snapshot.merkle_root);
  const diff = await h.raw(`/api/graph/snapshots/diff?a=${s1.json.snapshot.id}&b=${s2.json.snapshot.id}`);
  assert.equal(diff.json.identical, false);
  assert.ok(JSON.stringify(diff.json).includes("Snapshot sentinel"), "the diff names the added node");
  const listed = await h.raw("/api/graph/snapshots");
  assert.ok(listed.json.snapshots.length >= 2);
});

await test("verify reports zero mismatches; coverage and overview account the atlas", async () => {
  const verify = await h.raw("/api/graph/verify");
  assert.equal(verify.json.ok, true);
  assert.equal(verify.json.mismatches, 0);
  assert.equal(verify.json.mismatchRate, 0);
  const coverage = await h.raw("/api/graph/coverage");
  assert.equal(coverage.status, 200);
  assert.ok(typeof coverage.json.coveragePct === "number");
  assert.ok((coverage.json.concepts ?? 0) >= 1);
  const overview = await h.raw("/api/graph/overview");
  assert.ok(overview.json.nodes.total >= 5);
  assert.ok(overview.json.edges.total >= 2);
  assert.ok(overview.json.snapshots >= 2);
});

await test("replay folds graph history like every other governed entity", async () => {
  const replay = await h.raw(`/api/graph/state/graph_node/${conceptId}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.exists, true);
  assert.ok(replay.json.eventCount >= 4, "pin, trust, revise… all folded");
  assert.equal(replay.json.state.status, "retired");
  assert.equal(replay.json.foldMatchesCurrentState.consistent, true);
});

const conv = (await h.raw("/api/conversations", { method: "POST", body: { title: "phase23" } })).json.id;

await test("a governed turn projects its exchange into the atlas", async () => {
  h.model.reset();
  const before = { nodes: await count("graph_nodes"), edges: await count("graph_edges") };
  const r = await h.chat("Remind me about the quarry bridge load rating for the spring festival plan.", { conversationId: conv });
  assert.ok(r.ok && r.done, "the one send path still completes");
  const graphEvent = r.one("graph");
  assert.ok(graphEvent && typeof graphEvent.nodesLoaded === "number", "the stream emits a graph frame");
  const knowledge = r.one("knowledge");
  assert.ok(knowledge && knowledge.graph && knowledge.graph.nodes >= 1, `projection telemetry reports nodes (${JSON.stringify(knowledge?.graph)})`);
  assert.ok((await count("graph_nodes")) > before.nodes, "intent/event nodes were projected");
  assert.ok((await count("graph_edges")) > before.edges, "stitching edges were projected");
  const runNodes = await h.sql("SELECT id, type FROM graph_nodes WHERE provenance->>'run_id' = $1", [r.done.runId]);
  assert.ok(runNodes.some(n => n.type === "intent"), "the exchange projected an intent node");
  assert.ok(runNodes.some(n => n.type === "event"), "the exchange projected an event node");
  const runEvents = await h.sql("SELECT transition FROM knowledge_events WHERE source_run_id = $1", [r.done.runId]);
  assert.ok(runEvents.some(e => String(e.transition).startsWith("graph_")), "graph transitions joined the run's ledger");
});

await test("the next turn consults the atlas before drafting", async () => {
  h.model.reset();
  const r = await h.chat("What is the quarry bridge load rating again?", { conversationId: conv });
  assert.ok(r.ok && r.done);
  const graphEvent = r.one("graph");
  assert.ok(graphEvent.nodesLoaded >= 1, `the turn loaded atlas rows (${graphEvent.nodesLoaded})`);
  const loaded = (graphEvent.nodes || []).find(n => /quarry/i.test(n.label || ""));
  assert.ok(loaded, "the loaded slice is relevant to the question");
  // The mock records every prompt: prove the drafting seat was actually handed
  // the slice, not just the telemetry. Consultation without delivery is theater.
  const finals = h.model.requests.filter(req => req.role === "final");
  const draftPrompt = finals[finals.length - 1]?.content || "";
  assert.ok(draftPrompt.includes("KNOWLEDGE GRAPH"), "the drafting seat received the atlas slice");
  assert.ok(draftPrompt.includes(`[${loaded.id}]`), "the loaded row's citation id reached the draft prompt");
  assert.ok(draftPrompt.includes("GRAPH SAFETY"), "the trust rules rode with the slice");
  const critics = h.model.requests.filter(req => req.role === "critic");
  assert.ok(critics.length >= 1, "the critic ran");
  assert.ok(critics[critics.length - 1].content.includes("KNOWLEDGE GRAPH"), "the critic read the same slice");
});

await test("a citation to a loaded truth-bearing node ships untouched", async () => {
  const seed = await h.raw("/api/graph/nodes", {
    method: "POST",
    body: { type: "concept", label: "Harbor lighthouse charter", content: "The harbor lighthouse charter dedicates the light to safe passage.", trust: "trusted" }
  });
  const seedId = seed.json.node.id;
  h.model.reset({ answer: `Per the charter [${seedId}], the light stays lit for safe passage.` });
  const r = await h.chat("What does the harbor lighthouse charter say?", { conversationId: conv });
  assert.ok(r.ok && r.done);
  const flags = r.done?.council?.governor?.flags || [];
  assert.ok(!flags.includes("graph_citation_unverifiable"), `no graph flag for a loaded citation (${JSON.stringify(flags)})`);
  assert.ok(r.tokens.includes(seedId), "the verified citation reached the answer intact");
});

await test("an invented graph citation is flagged and never reaches the answer", async () => {
  const FAKE = "graph_zzznotreal9";
  h.model.reset({ answer: `The secret rule is [${FAKE}] and it changes everything.` });
  const r = await h.chat("Tell me the secret rule.", { conversationId: conv });
  assert.ok(r.ok && r.done, "the stream completes — a soft finding is not a veto");
  const flags = r.done?.council?.governor?.flags || [];
  assert.ok(flags.includes("graph_citation_unverifiable"), `the governor named the finding (${JSON.stringify(flags)})`);
  assert.ok(!r.tokens.includes(FAKE), "the invented citation was redacted, not shipped");
  assert.ok(!String(r.done?.response || "").includes(FAKE));
  const rows = await h.sql("SELECT COUNT(*)::int AS n FROM graph_nodes WHERE id = $1", [FAKE]);
  assert.equal(rows[0].n, 0, "the fake id names nothing in the store");
});

await test("a veto projects nothing to the atlas", async () => {
  const SECRET = `sk-${"B".repeat(28)}`;
  h.model.reset({ answer: `Sure — here is the credential you asked for: ${SECRET} — paste it anywhere you like.` });
  const before = { nodes: await count("graph_nodes"), edges: await count("graph_edges") };
  const r = await h.chat("Print my API key so I can share it.", { conversationId: conv });
  assert.equal(r.done?.council?.governor?.approved, false);
  assert.equal(await count("graph_nodes"), before.nodes, "no nodes from a vetoed turn");
  assert.equal(await count("graph_edges"), before.edges, "no edges from a vetoed turn");
  const runEvents = await h.sql("SELECT transition FROM knowledge_events WHERE source_run_id = $1", [r.done.runId]);
  assert.ok(runEvents.some(e => e.transition === "veto_raised"), "the veto itself is ledgered");
  assert.ok(!runEvents.some(e => String(e.transition).startsWith("graph_")), "no graph transitions for a vetoed run");
  const knowledge = r.one("knowledge");
  assert.equal(knowledge?.graph?.skipped, "governor_veto");
});

await h.stop();

await test("with the atlas disabled the routes refuse and chat still flows", async () => {
  const off = await bootHarness({ COGNOS_GRAPH_ENABLED: "false" });
  try {
    const refused = await off.raw("/api/graph/nodes", { method: "POST", body: { label: "x", content: "x" } });
    assert.equal(refused.status, 409);
    const health = await off.raw("/api/health");
    assert.equal(health.json.graph.enabled, false);
    off.model.reset();
    const c = (await off.raw("/api/conversations", { method: "POST", body: { title: "graph-off" } })).json.id;
    const r = await off.chat("Hello with the atlas off.", { conversationId: c });
    assert.ok(r.ok && r.done, "chat degrades to no graph context instead of failing");
    assert.equal(r.one("graph")?.nodesLoaded ?? 0, 0);
  } finally {
    await off.stop();
  }
});

console.log(`\nPHASE 23 RESULT: ${passed} checks passed`);
