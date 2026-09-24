#!/usr/bin/env node
// Test harness only — NOT part of the app and NOT part of npm test.
//
// Measures the wall-clock of one full governed council turn against per-role
// model latency injection (the same idea as server/mock-latency.js, but
// importable, per-role inside one process, and with a stubbed search provider
// so the web-search leg is measurable without leaving the machine).
//
// What it answers: where does a turn's time actually go, and what did a
// scheduling change save? Run it before and after an orchestration change:
//
//   node test/latency-bench.mjs --scenario=moderate
//   node test/latency-bench.mjs --scenario=search-decomp --db-delay=40
//
// Scenarios (what the Observer classification is scripted to return):
//   simple          complexity=simple   (critic deferred off the critical path)
//   moderate        complexity=moderate (critic blocks; no search, no split)
//   decomp          moderate + needs_decomposition (2 specialist sub-tasks)
//   search          moderate + needs_web_search  (stubbed provider + briefing)
//   search-decomp   both — the turn where independent seats can overlap
//
// Per-role latencies default to server/mock-latency.js's values and can be
// overridden with the same L_* environment variables (plus L_COHERENCE and
// L_WEBFETCH for the roles that file folds into "main").

import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const sleep = ms => new Promise(r => setTimeout(r, ms));

const L = {
  observer:   Number(process.env.L_OBSERVER   || 900),
  strategist: Number(process.env.L_STRATEGIST || 1200),
  critic:     Number(process.env.L_CRITIC     || 1100),
  coherence:  Number(process.env.L_COHERENCE  || 1200),
  memrel:     Number(process.env.L_MEMREL     || 800),
  memext:     Number(process.env.L_MEMEXT     || 1000),
  summary:    Number(process.env.L_SUMMARY    || 900),
  webSearch:  Number(process.env.L_SEARCH     || 1500),
  webFetch:   Number(process.env.L_WEBFETCH   || 500),   // the search provider round trip
  main:       Number(process.env.L_MAIN       || 2500)   // specialist / synthesizer
};

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SCENARIO = arg("scenario", "moderate");
const DB_DELAY = Number(arg("db-delay", 0));
const TURNS = Number(arg("turns", 2));
const AS_JSON = args.includes("--json");

const SCENARIOS = {
  simple:          { complexity: "simple",   decomp: false, search: false },
  moderate:        { complexity: "moderate", decomp: false, search: false },
  decomp:          { complexity: "moderate", decomp: true,  search: false },
  search:          { complexity: "moderate", decomp: false, search: true },
  "search-decomp": { complexity: "moderate", decomp: true,  search: true }
};
const scene = SCENARIOS[SCENARIO];
if (!scene) {
  console.error(`unknown scenario "${SCENARIO}" — one of: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}

// --- The per-role model mock -------------------------------------------------
const ROLES = [
  ["You are the Observer", "observer"],
  ["You are the Strategist", "strategist"],
  ["You are the Critic", "critic"],
  ["memory relevance agent", "memrel"],
  ["memory extraction agent", "memext"],
  ["Summarize the following conversation", "summary"],
  ["COGNOS Web Search tool", "webSearch"],
  ["You are the Coherence Monitor", "coherence"]
];
function roleOf(payload) {
  const system = payload.messages?.find(m => m.role === "system")?.content || "";
  for (const [needle, role] of ROLES) if (system.includes(needle)) return role;
  return "main";
}
const timeline = [];   // { role, at, doneAt }

const subTasks = [
  { id: "s1", agent: "research", description: "Gather the facts", input: "Gather the facts for the request.", status: "pending" },
  { id: "s2", agent: "analysis", description: "Analyse the facts", input: "Analyse the gathered facts.", status: "pending" }
];

// The warm-up turn seeds the workspace with enough memories to exercise both
// the memory-relevance call (fires only when the pool exceeds the per-turn
// budget) and the Coherence Monitor (fires only when beliefs exist). Measured
// turns extract nothing, so the seeded state is the only state.
let seeding = true;
const seedMemories = Array.from({ length: 15 }, (_, i) => ({
  content: `Bench seed fact ${i + 1}: the user prefers benchmark determinism.`,
  memory_type: "semantic",
  importance: 5,
  evidence_level: "direct",
  volatility: "medium"
}));

const modelServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", async () => {
    const payload = JSON.parse(body || "{}");
    const role = roleOf(payload);
    const at = Date.now();
    await sleep(L[role] ?? 500);
    timeline.push({ role, at, doneAt: Date.now() });
    const json = obj => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: payload.model, choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
    };
    if (payload.response_format?.type === "json_schema") {
      if (role === "observer") return json({ task_type: "question_answering", complexity: scene.complexity, needs_decomposition: scene.decomp, intent: "bench", needs_web_search: scene.search, search_query: scene.search ? "python programming language" : "" });
      if (role === "strategist") return json({ sub_tasks: scene.decomp ? subTasks : [] });
      if (role === "critic") return json({ score: 9, reasoning: "bench", needs_revision: false, charter: { truth: true, evidence: true, agency: true, dignity: true, note: "" } });
      if (role === "memrel") return json({ relevant_ids: [] });
      if (role === "memext") return json({ memories: seeding ? seedMemories : [] });
      if (role === "summary") return json({ summary: "The user benchmarked the council." });
      if (role === "coherence") return json({ verdict: "coherent", claims: [], note: "bench" });
      return json({});
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: payload.model, choices: [{ message: { content: "The council's benchmark answer: the charter was applied and the record was respected." }, finish_reason: "stop" }], usage: { prompt_tokens: 400, completion_tokens: 60, total_tokens: 460 } }));
  });
});
await new Promise(resolve => modelServer.listen(0, "127.0.0.1", resolve));
const modelPort = modelServer.address().port;

// --- The stubbed search provider ---------------------------------------------
// The web-search leg must be measurable without the real network. Only the
// hard-coded DuckDuckGo endpoint is intercepted; every other fetch (the model
// gateway above, the app's own routes) passes through untouched.
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url || String(input);
  if (url.startsWith("https://api.duckduckgo.com/")) {
    await sleep(L.webFetch);
    return new Response(JSON.stringify({
      Heading: "Python (programming language)",
      AbstractText: "Python is a high-level, general-purpose programming language whose design philosophy emphasizes code readability.",
      AbstractURL: "https://en.wikipedia.org/wiki/Python_(programming_language)",
      RelatedTopics: [{ Text: "Python Software Foundation", FirstURL: "https://www.python.org" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(input, init);
};

// --- The database --------------------------------------------------------------
// In-process PGlite, as in test/harness.mjs. (A per-query delay to simulate a
// networked Postgres was tried here and deliberately removed: an await inside
// the socket server's single query queue deadlocks it, so the bench measures
// the model-call schedule — where the turn's latency actually goes — against
// the fast local database and leaves DB round-trip time out of the picture.)
const pglite = new PGlite();
await pglite.waitReady;
const pgServer = new PGLiteSocketServer({ db: pglite, port: 0, host: "127.0.0.1", maxConnections: 16 });
await pgServer.start();
const pgPort = Number(String(pgServer.getServerConn()).match(/:(\d+)$/)?.[1] || 0);

process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${pgPort}/postgres?sslmode=disable`;
process.env.BLUESMINDS_API_URL = `http://127.0.0.1:${modelPort}/v1`;
process.env.BLUESMINDS_API_KEY = "sk-bench-not-a-real-key";
process.env.COGNOS_MODEL = "bench/main-model";
process.env.COGNOS_FAST_MODEL = "bench/fast-model";
process.env.COGNOS_SEARCH_ENABLED = scene.search ? "true" : "false";
delete process.env.COGNOS_RUNTIME_SECRET;

const { default: app } = await import("../server/index.js");
const server = await new Promise(resolve => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

async function chatTurn(label) {
  const t0 = Date.now();
  const res = await realFetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userMessage: `Bench turn ${label}: answer with the standard benchmark reply.`, style: "balanced" })
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstTokenAt = null;
  let donePayload = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const [eventLine, ...dataLines] = frame.split("\n");
      if (!eventLine?.startsWith("event:")) continue;
      const event = eventLine.slice(6).trim();
      const data = dataLines.filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n");
      if (event === "token" && firstTokenAt === null) firstTokenAt = Date.now() - t0;
      if (event === "done") donePayload = JSON.parse(data);
    }
  }
  return { totalMs: Date.now() - t0, firstTokenMs: firstTokenAt, done: donePayload, t0 };
}

// Warm-up: seeds the memories/beliefs the measured turns reason over.
await chatTurn("warmup");
seeding = false;

const turns = [];
for (let i = 1; i <= TURNS; i++) {
  timeline.length = 0;
  const turn = await chatTurn(String(i));
  turns.push({ ...turn, calls: timeline.map(c => ({ ...c, start: c.at - turn.t0, end: c.doneAt - turn.t0 })) });
}

await new Promise(r => server.close(r));
modelServer.close();
const { closeDatabase } = await import("../server/db.js");
await closeDatabase();
await pgServer.stop();
await pglite.close();

// --- Report -------------------------------------------------------------------
const med = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const total = med(turns.map(t => t.totalMs));
const firstToken = med(turns.map(t => t.firstTokenMs ?? t.totalMs));
const mid = turns[Math.floor(turns.length / 2)];
const calls = mid.calls;
const stageTimings = mid.done?.council?.stageTimings || {};

if (AS_JSON) {
  console.log(JSON.stringify({
    scenario: SCENARIO, dbDelayMs: DB_DELAY, turns: TURNS,
    totalMs: total, firstTokenMs: firstToken,
    stages: Object.fromEntries(Object.entries(stageTimings).map(([k, v]) => [k, v.totalMs])),
    calls: calls.map(c => ({ role: c.role, startMs: c.start, endMs: c.end }))
  }, null, 2));
} else {
  console.log(`\n=== latency bench: ${SCENARIO} — ${TURNS} measured turn(s), median ===`);
  console.log(`time to first governed token: ${(firstToken / 1000).toFixed(2)}s`);
  console.log(`time to done (full turn):      ${(total / 1000).toFixed(2)}s`);
  console.log(`\nmodel-call schedule (offsets from turn start, 1 char = 100ms):`);
  for (const c of [...calls].sort((a, b) => a.start - b.start)) {
    const bar = " ".repeat(Math.round(c.start / 100)) + "█".repeat(Math.max(1, Math.round((c.end - c.start) / 100)));
    console.log(`  ${c.role.padEnd(10)} ${String(c.start).padStart(5)}→${String(c.end).padStart(5)}ms  ${bar}`);
  }
  console.log(`\nstage timings (from telemetry):`);
  for (const [stage, t] of Object.entries(stageTimings)) console.log(`  ${stage.padEnd(18)} ${String(t.totalMs).padStart(5)}ms`);
}
