// Phase 30 — semantic memory embeddings (server/memory/embeddings.js).
// Unit tests: cosine math, ranking, model resolution, embedding text,
// the /embeddings call (mocked fetch), and the background refresh writer.
// The suite never touches the network or a real database.

let pass = 0;
function ok(cond, name) {
  if (!cond) { console.error("FAIL:", name); process.exit(1); }
  pass++;
  console.log("ok:", name);
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const {
  cosineSimilarity,
  parseEmbedding,
  rankMemoriesBySimilarity,
  resolveEmbeddingModel,
  embeddingTextFor,
  embedTexts,
  refreshMemoryEmbeddings,
  scheduleEmbeddingRefresh,
} = await import("../server/memory/embeddings.js");

// --- cosineSimilarity ---
ok(approx(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1), "identical vectors score 1");
ok(approx(cosineSimilarity([1, 0], [0, 1]), 0), "orthogonal vectors score 0");
ok(approx(cosineSimilarity([1, 1], [-1, -1]), -1), "opposite vectors score -1");
ok(cosineSimilarity([0, 0, 0], [1, 2, 3]) === 0, "zero vector scores 0, never NaN");
ok(cosineSimilarity([1, 2], [1, 2, 3]) === 0, "mismatched lengths score 0");
ok(cosineSimilarity([NaN, 1], [1, 1]) === 0, "NaN component scores 0");
ok(cosineSimilarity(null, [1]) === 0, "null input scores 0");
ok(cosineSimilarity([1, 2], [2, 4]) > 0.999, "parallel vectors score ~1");

// --- parseEmbedding ---
ok(JSON.stringify(parseEmbedding("[0.1,0.2]")) === "[0.1,0.2]", "parses JSON string");
ok(JSON.stringify(parseEmbedding([0.1, 0.2])) === "[0.1,0.2]", "passes through arrays");
ok(parseEmbedding("not json") === null, "junk string -> null");
ok(parseEmbedding("") === null, "empty string -> null");
ok(parseEmbedding('{"a":1}') === null, "non-array JSON -> null");
ok(parseEmbedding("[1,\"x\"]") === null, "non-numeric array -> null");
ok(parseEmbedding(null) === null, "null -> null");

// --- rankMemoriesBySimilarity ---
const mems = [
  { id: "a", embedding: JSON.stringify([1, 0]) },
  { id: "b", embedding: JSON.stringify([0, 1]) },
  { id: "c", embedding: null },
  { id: "d", embedding: JSON.stringify([0.9, 0.1]) },
];
const ranked = rankMemoriesBySimilarity([1, 0], mems, 10);
ok(ranked.map(m => m.id).join(",") === "a,d,b", "ranks most-similar first, skips unembedded");
ok(rankMemoriesBySimilarity([1, 0], mems, 2).length === 2, "respects limit");
ok(rankMemoriesBySimilarity([], mems, 5).length === 0, "empty query vector -> []");
ok(rankMemoriesBySimilarity([1, 0, 0], mems, 5).length === 0, "dimension mismatch -> []");

// --- resolveEmbeddingModel ---
const savedModel = process.env.COGNOS_EMBEDDING_MODEL;
delete process.env.COGNOS_EMBEDDING_MODEL;
ok(resolveEmbeddingModel("https://generativelanguage.googleapis.com/v1beta/openai") === "text-embedding-004",
  "Google base URL -> text-embedding-004");
ok(resolveEmbeddingModel("https://api.bluesminds.com/v1") === "text-embedding-3-small",
  "other base URL -> text-embedding-3-small fallback");
process.env.COGNOS_EMBEDDING_MODEL = "custom-embed-1";
ok(resolveEmbeddingModel("https://generativelanguage.googleapis.com/v1beta/openai") === "custom-embed-1",
  "COGNOS_EMBEDDING_MODEL override wins");
if (savedModel === undefined) delete process.env.COGNOS_EMBEDDING_MODEL; else process.env.COGNOS_EMBEDDING_MODEL = savedModel;

// --- embeddingTextFor ---
ok(embeddingTextFor({ content: "Jeremy likes tea" }) === "Jeremy likes tea", "content alone");
ok(embeddingTextFor({ content: "tea", memory_key: "user.preference.drink" }) === "user.preference.drink: tea",
  "key prefixes content");
ok(embeddingTextFor({ content: "x".repeat(5000) }).length === 2000, "truncates long content");
ok(embeddingTextFor({}) === "", "empty memory -> empty string");

// --- embedTexts (mocked fetch) ---
const savedKey = process.env.BLUESMINDS_API_KEY;
const savedUrl = process.env.BLUESMINDS_API_URL;
const savedOpenKey = process.env.OPENAI_API_KEY;
const realFetch = globalThis.fetch;
process.env.BLUESMINDS_API_KEY = "test-key";
process.env.BLUESMINDS_API_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
delete process.env.OPENAI_API_KEY;

let lastReq = null;
globalThis.fetch = async (url, opts) => {
  lastReq = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization };
  return {
    ok: true,
    json: async () => ({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] })
  };
};
const vecs = await embedTexts(["hello", "world"]);
ok(Array.isArray(vecs) && vecs.length === 2 && vecs[0][0] === 0.1, "returns vectors from /embeddings");
ok(lastReq.url === "https://generativelanguage.googleapis.com/v1beta/openai/embeddings", "posts to {baseUrl}/embeddings");
ok(lastReq.body.model === "text-embedding-004", "uses text-embedding-004 for Google");
ok(lastReq.body.input.length === 2, "sends batched inputs");
ok(lastReq.auth === "Bearer test-key", "sends the configured provider key");

globalThis.fetch = async () => ({ ok: false, status: 500 });
ok(await embedTexts(["hello"]) === null, "HTTP error -> null, never throws");

globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: "garbage" }) });
ok(await embedTexts(["hello"]) === null, "malformed body -> null");

globalThis.fetch = async () => { throw new Error("boom"); };
ok(await embedTexts(["hello"]) === null, "network throw -> null");

delete process.env.BLUESMINDS_API_KEY;
ok(await embedTexts(["hello"]) === null, "missing key -> null, never throws");

// --- refreshMemoryEmbeddings (mocked query + fetch) ---
process.env.BLUESMINDS_API_KEY = "test-key";
globalThis.fetch = async (url, opts) => ({
  ok: true,
  json: async () => ({ data: JSON.parse(opts.body).input.map((_, i) => ({ embedding: [0.5 + i * 0.1, 0.5] })) })
});
const updates = [];
const fakeQuery = async (text, params) => { updates.push({ text, params }); return []; };
const rows = [
  { id: "m1", content: "first memory", embedding: null, embedding_model: null },
  { id: "m2", content: "already done", embedding: JSON.stringify([0.1, 0.2]), embedding_model: "text-embedding-004" },
];
const n = await refreshMemoryEmbeddings(fakeQuery, rows, {});
ok(n === 1, "embeds only the missing row");
ok(updates.length === 1 && updates[0].params[2] === "m1", "UPDATE targets the right row");
ok(updates[0].params[1] === "text-embedding-004", "records the model used");
ok(JSON.parse(updates[0].params[0])[0] === 0.5, "stores the returned vector as JSON");
ok(rows[0].embedding_model === "text-embedding-004", "mutates the row in place for callers");

const n2 = await refreshMemoryEmbeddings(fakeQuery, rows, { force: true });
ok(n2 === 2, "force re-embeds every row");

globalThis.fetch = async () => { throw new Error("down"); };
ok(await refreshMemoryEmbeddings(fakeQuery, [{ id: "m3", content: "x" }], {}) === 0,
  "provider outage -> 0 updates, never throws");
ok(await refreshMemoryEmbeddings(null, [{ id: "m3", content: "x" }], {}) === 0,
  "missing queryFn -> 0, never throws");

// scheduleEmbeddingRefresh never throws, even with junk input.
scheduleEmbeddingRefresh(null, null);
scheduleEmbeddingRefresh(fakeQuery, []);
await new Promise(r => setTimeout(r, 50));
ok(true, "scheduleEmbeddingRefresh is fire-and-forget safe");

// --- restore ---
globalThis.fetch = realFetch;
if (savedKey === undefined) delete process.env.BLUESMINDS_API_KEY; else process.env.BLUESMINDS_API_KEY = savedKey;
if (savedUrl === undefined) delete process.env.BLUESMINDS_API_URL; else process.env.BLUESMINDS_API_URL = savedUrl;
if (savedOpenKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedOpenKey;

console.log(`\nmemory-semantic: ${pass} checks passed`);
