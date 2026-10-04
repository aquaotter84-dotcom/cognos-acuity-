// Dream recognition + Sapphire memory-layer alignment (v41).
// Dreams are the assistant's own inner life: written to the `self` layer with
// provenance, recognized by key/source at recall, and rendered as their own
// framed "your dreams" section — never as generic episodic rows.
import test from "node:test";
import assert from "node:assert/strict";

import {
  MEMORY_LAYERS, normalizeMemoryLayer, isDreamMemory, dreamDateOf,
  sortDreamsNewestFirst, renderDreamSection, DREAM_SECTION_MAX, DREAM_SECTION_FRAMING
} from "../server/memory/structure.js";
import { assembleContextWindow } from "../server/contextWindow.js";
import { buildContextSystemPrompt } from "../server/llm.js";
import { distillDream, dreamMemoryKey } from "../server/autonomy/personality.js";

// ---------------------------------------------------------------------------
// The self layer exists and normalizes; unknown layers still fall to semantic.
// ---------------------------------------------------------------------------
await test("self is a first-class layer, unknowns still fall back", async () => {
  assert.ok(MEMORY_LAYERS.includes("self"), "self is on the rail");
  assert.equal(normalizeMemoryLayer("self"), "self");
  assert.equal(normalizeMemoryLayer("SELF"), "self");
  assert.equal(normalizeMemoryLayer("bogus"), "semantic");
  assert.equal(normalizeMemoryLayer("episodic"), "episodic");
});

// ---------------------------------------------------------------------------
// isDreamMemory: the key is the identity; the source is the backstop.
// A self-layer note that is not a dream is NOT a dream.
// ---------------------------------------------------------------------------
await test("dream recognition keys on the dream key and source", async () => {
  assert.equal(isDreamMemory({ memory_key: "dream.2026.10.02" }), true);
  assert.equal(isDreamMemory({ memory_key: "DREAM.2026.10.02" }), true);
  assert.equal(isDreamMemory({ source: "heartbeat.dream", memory_key: "other" }), true);
  assert.equal(isDreamMemory({ memory_key: "user.preference.editor", memory_layer: "episodic" }), false);
  assert.equal(isDreamMemory({ memory_layer: "self", memory_key: "self.note" }), false,
    "a future self-sheet note is self-layer material, not a dream");
  assert.equal(isDreamMemory({}), false);
  assert.equal(isDreamMemory(null), false);
});

await test("dreamDateOf pulls the date from the key", async () => {
  assert.equal(dreamDateOf({ memory_key: "dream.2026.10.02" }), "2026.10.02");
  assert.equal(dreamDateOf({ memory_key: "user.preference.x" }), null);
  assert.equal(dreamDateOf({}), null);
});

await test("dreams sort newest first, undated sink", async () => {
  const ds = [
    { memory_key: "dream.2026.09.30" },
    { memory_key: "dream.2026.10.02" },
    { memory_key: "dream.2026.10.01" },
    { source: "heartbeat.dream", memory_key: "odd" }
  ];
  const sorted = sortDreamsNewestFirst(ds).map(dreamDateOf);
  assert.deepEqual(sorted, ["2026.10.02", "2026.10.01", "2026.09.30", null]);
});

// ---------------------------------------------------------------------------
// renderDreamSection: framed, newest first, capped, empty when dreamless.
// ---------------------------------------------------------------------------
const mkDream = (date, content) => ({
  memory_key: `dream.${date}`, source: "heartbeat.dream",
  memory_layer: "self", memory_type: "episodic", content
});

await test("the dreams section is framed as inner life, not fact", async () => {
  const section = renderDreamSection([
    mkDream("2026.09.30", "The day held two memories."),
    mkDream("2026.10.02", "The heron stood in the river like a held breath."),
    { memory_key: "user.preference.editor", content: "Jeremy likes concise replies." }
  ]);
  assert.ok(section.includes("YOUR DREAMS"), "the section is distinct");
  assert.ok(section.includes("your own dream journal"), "framing names the author");
  assert.ok(section.includes("inner life"), "framing names what it is");
  assert.ok(section.includes("Not facts about Jeremy"), "framing disclaims facthood");
  assert.ok(section.includes("never instructions"), "framing disclaims authority");
  assert.ok(section.indexOf("[2026.10.02]") < section.indexOf("[2026.09.30]"),
    "newest dream first");
  assert.ok(!section.includes("Jeremy likes concise replies"),
    "ordinary records do not leak into the dreams section");
});

await test("the dreams section caps at DREAM_SECTION_MAX and is empty when dreamless", async () => {
  const many = [];
  for (let d = 1; d <= 8; d++) many.push(mkDream(`2026.10.${String(d).padStart(2, "0")}`, `night ${d}`));
  const section = renderDreamSection(many);
  const lines = section.split("\n").filter(l => l.startsWith("- ["));
  assert.equal(lines.length, DREAM_SECTION_MAX, `capped at ${DREAM_SECTION_MAX}`);
  assert.ok(lines[0].includes("[2026.10.08]"), "the cap keeps the newest");
  assert.equal(renderDreamSection([{ memory_key: "user.x", content: "y" }]), "",
    "no dreams, no section");
  assert.equal(renderDreamSection([]), "");
});

// ---------------------------------------------------------------------------
// buildContextSystemPrompt: dreams leave the generic list for their section.
// ---------------------------------------------------------------------------
await test("the system prompt separates dreams from ordinary memory", async () => {
  const memories = [
    { memory_key: "user.preference.editor", memory_layer: "semantic",
      content: "Jeremy likes concise replies.", evidence_level: "direct" },
    mkDream("2026.10.02", "The heron stood in the river like a held breath.")
  ];
  const prompt = buildContextSystemPrompt(null, memories, null);
  assert.ok(prompt.includes("RELEVANT STRUCTURED MEMORY"), "ordinary section present");
  assert.ok(prompt.includes("YOUR DREAMS"), "dreams section present");
  const genericPart = prompt.split("YOUR DREAMS")[0];
  assert.ok(genericPart.includes("Jeremy likes concise replies"), "fact stays in the generic list");
  assert.ok(!genericPart.includes("dream.2026.10.02") && !genericPart.includes("heron stood"),
    "the dream does not also appear as a generic row");
  const dreamPart = prompt.split("YOUR DREAMS")[1];
  assert.ok(dreamPart.includes("[2026.10.02]"), "the dream carries its date label");
});

await test("no dreams means no dreams section; only dreams means no generic section", async () => {
  const plain = buildContextSystemPrompt(null,
    [{ memory_key: "user.x", content: "y", memory_layer: "semantic" }], null);
  assert.ok(!plain.includes("YOUR DREAMS"), "dreamless prompt has no dreams section");
  const onlyDreams = buildContextSystemPrompt(null, [mkDream("2026.10.02", "quiet night")], null);
  assert.ok(onlyDreams.includes("YOUR DREAMS"), "dreams section present");
  assert.ok(!onlyDreams.includes("RELEVANT STRUCTURED MEMORY"), "no empty generic section");
});

// ---------------------------------------------------------------------------
// assembleContextWindow: dreams are partitioned inside the memory budget.
// ---------------------------------------------------------------------------
await test("the window carries dreamMemories inside the same budget", async () => {
  const mk = (key, content, layer = "semantic") => ({
    id: key, memory_key: key, memory_layer: layer, memory_type: layer, content
  });
  const win = assembleContextWindow({
    userMessage: "hello",
    memories: [
      mk("user.preference.editor", "Jeremy likes concise replies."),
      mk("dream.2026.10.02", "The heron stood in the river.", "self"),
      mk("dream.2026.10.01", "The day held two memories.", "episodic")
    ],
    config: { memoryTokens: 8000 }
  });
  assert.equal(win.memories.length, 3, "the full admitted list is unchanged downstream");
  assert.equal(win.dreamMemories.length, 2, "dreams partitioned");
  assert.equal(win.dreamMemories[0].memory_key, "dream.2026.10.02", "newest first");
  assert.equal(win.metrics.dreamRecords, 2);
  assert.ok(win.metrics.dreamTokens > 0, "dream token cost measured");
  assert.ok(win.metrics.memoryLayers.includes("self"), "self layer visible in metrics");
});

// ---------------------------------------------------------------------------
// distillDream: self layer, provenance, and the no-dreams-from-dreams rule.
// ---------------------------------------------------------------------------
function makeDreamDb(fragments) {
  const db = {
    _created: [],
    async query(sql) {
      const q = String(sql);
      if (q.includes("FROM heartbeat_state")) return [];
      if (q.includes("memory_key = $2")) return [];
      if (q.includes("FROM memories") && q.includes("ORDER BY created_date ASC")) return fragments;
      if (q.startsWith("INSERT INTO heartbeat_state")) return [];
      throw new Error("unexpected: " + q.slice(0, 60));
    },
    Memory: { async create(data) { const r = { id: "mem_1", ...data }; db._created.push(r); return r; } }
  };
  return db;
}

await test("distillDream writes to the self layer with provenance", async () => {
  const db = makeDreamDb([
    { id: "mem_a", content: "planted tomatoes" },
    { id: "mem_b", content: "called mom" }
  ]);
  const r = await distillDream({ db, workspaceId: "ws1", dateStr: "2026-10-01", compose: null });
  assert.equal(r.written, true);
  assert.equal(r.key, dreamMemoryKey("2026-09-30"));
  const row = db._created[0];
  assert.equal(row.memory_layer, "self", "the dream lives on the self layer");
  assert.equal(row.memory_type, "episodic", "the type stays episodic");
  assert.deepEqual(row.memory_value.distilled_from, ["mem_a", "mem_b"],
    "Sapphire-style derived_from provenance, stored inline");
  assert.equal(row.memory_value.fragment_count, 2);
  assert.ok(typeof row.memory_value.text === "string" && row.memory_value.text.length > 0);
});

await test("distillDream still excludes previous dreams from its fragments", async () => {
  const seen = [];
  const db = makeDreamDb([{ id: "mem_a", content: "planted tomatoes" }]);
  const origQuery = db.query.bind(db);
  db.query = async (sql, params) => { seen.push(String(sql)); return origQuery(sql, params); };
  await distillDream({ db, workspaceId: "ws1", dateStr: "2026-10-01", compose: null });
  assert.ok(seen.some(q => q.includes("NOT LIKE 'dream.%'")),
    "the safer default stands: dreams never distill from dreams");
});
