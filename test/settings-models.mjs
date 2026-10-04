// Model tap-options (server/routes/settings.js).
//
// Jeremy's direction: things you'd have to set as a variable should be a tap
// option. The model pickers (main / quick-tasks / image-reading) are backed by
// the provider's live /v1/models catalog so new models show up without another
// release. Keys and endpoint URLs stay keyed in — no route here reads, writes,
// or returns them.
//
// What this file proves:
//   * validateModelId still gates the manual-entry path.
//   * GET /api/settings/models fetches, sorts, dedupes, and bounds the live
//     catalog; caches for an hour; ?refresh=1 bypasses; failure degrades to a
//     friendly error (never a key leak, never a throw).
//   * The fast/image model routes persist to their device files (mode 0600),
//     apply to the environment immediately, validate, and reset cleanly.
//   * GET /api/settings/diagnose-ai scrubs the endpoint URL (baseUrl/host/port
//     and host:port in stage details) before it reaches the app.

import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

const { validateModelId, registerSettingsRoutes } = await import("../server/routes/settings.js");

// --- validateModelId -------------------------------------------------------
await test("validateModelId accepts good ids", () => {
  assert.equal(validateModelId("openai/gpt-oss-20b"), null);
  assert.equal(validateModelId("anthropic/claude-sonnet-4-5"), null);
  assert.equal(validateModelId("model_v1.2:fast"), null);
});
await test("validateModelId rejects bad ids", () => {
  assert.equal(typeof validateModelId("bad model!"), "string");
  assert.equal(typeof validateModelId("x".repeat(101)), "string");
  assert.equal(typeof validateModelId(""), "string");
});

// --- route harness: isolated device dir + scriptable fetch ------------------
process.env.COGNOS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cognos-models-"));
const app = express();
app.use(express.json());
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  if (!res.headersSent) res.status(500).json({ error: String((err && err.message) || err) });
});
registerSettingsRoutes(app, { wrap, logger: null });
const srv = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const api = `http://127.0.0.1:${srv.address().port}`;
const call = async (method, p, body) => {
  const res = await fetch(api + p, {
    method, headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};

// Scriptable provider fetch: the models route calls global fetch.
const realFetch = global.fetch;
let providerHandler = null;
global.fetch = async (url, opts) => {
  if (typeof url === "string" && url.includes("/v1/models") && providerHandler) {
    return providerHandler(url, opts);
  }
  return realFetch(url, opts);
};
const providerJson = (data, status = 200) => async () => ({
  ok: status >= 200 && status < 300, status,
  json: async () => ({ data }),
});
process.env.BLUESMINDS_API_KEY = "test-provider-key";

// --- live catalog ------------------------------------------------------------
await test("GET /api/settings/models returns a sorted, deduped, bounded list", async () => {
  providerHandler = providerJson([
    { id: "zebra-1" }, { id: "anthropic/claude-sonnet-4-5" }, { id: "zebra-1" },
    { id: "" }, { id: "x".repeat(101) }, { id: "aaa-1" },
  ]);
  const r = await call("GET", "/api/settings/models?refresh=1");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.models, ["aaa-1", "anthropic/claude-sonnet-4-5", "zebra-1"]);
  assert.equal(r.json.cached, false);
});

await test("the catalog is cached for an hour; refresh bypasses", async () => {
  let hits = 0;
  providerHandler = async () => { hits++; return providerJson([{ id: "fresh-model" }])(); };
  const r1 = await call("GET", "/api/settings/models");
  assert.equal(r1.json.cached, true, "second call serves the cache");
  assert.equal(hits, 0, "no provider hit while cached");
  const r2 = await call("GET", "/api/settings/models?refresh=1");
  assert.equal(r2.json.cached, false);
  assert.deepEqual(r2.json.models, ["fresh-model"]);
  assert.equal(hits, 1, "refresh bypasses the cache");
});

await test("catalog failure degrades to a friendly error, never a key leak", async () => {
  providerHandler = async () => { throw new Error("boom"); };
  const r = await call("GET", "/api/settings/models?refresh=1");
  assert.equal(r.status, 502);
  assert.equal(r.json.ok, false);
  assert.equal(typeof r.json.error, "string");
  assert.ok(!JSON.stringify(r.json).includes("test-provider-key"), "no key material leaks");
});

await test("provider rejection reports cleanly", async () => {
  providerHandler = providerJson([], 401);
  const r = await call("GET", "/api/settings/models?refresh=1");
  assert.equal(r.status, 502);
  assert.ok(/rejected/i.test(r.json.error), JSON.stringify(r.json));
});

await test("no configured key → 503 with a plain-language error", async () => {
  delete process.env.BLUESMINDS_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const r = await call("GET", "/api/settings/models?refresh=1");
  assert.equal(r.status, 503);
  assert.ok(/key/i.test(r.json.error), JSON.stringify(r.json));
  process.env.BLUESMINDS_API_KEY = "test-provider-key";
});

await test("the catalog URL never doubles the /v1 prefix", async () => {
  // 2026-10-04: the route built `${baseUrl}/v1/models` while baseUrl already
  // ended in /v1 → the provider 404d. providerModelsUrl() is the single
  // source of truth now; assert on it directly and on the outgoing request.
  const { providerModelsUrl } = await import("../server/llm.js");
  const url = providerModelsUrl();
  assert.ok(!url.includes("/v1/v1/"), `no doubled prefix in ${url}`);
  assert.ok(/\/v1\/models$/.test(url), `ends in /v1/models: ${url}`);
  let seen = null;
  providerHandler = async (u) => { seen = u; return providerJson([{ id: "m1" }])(); };
  const r = await call("GET", "/api/settings/models?refresh=1");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(seen && !seen.includes("/v1/v1/"), `outgoing request has no doubled prefix: ${seen}`);
});

// --- fast / image model routes --------------------------------------------------
await test("fast-model: set, persist (0600), apply, reset", async () => {
  const r = await call("POST", "/api/settings/fast-model-id", { model: "z-ai/glm4.7" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.value, "z-ai/glm4.7");
  assert.equal(process.env.COGNOS_FAST_MODEL, "z-ai/glm4.7");
  const fp = path.join(process.env.COGNOS_DATA_DIR, "cognos_fast_model.txt");
  assert.equal(fs.readFileSync(fp, "utf8"), "z-ai/glm4.7");
  assert.equal(fs.statSync(fp).mode & 0o777, 0o600);

  const g = await call("GET", "/api/settings/fast-model-id");
  assert.equal(g.json.configured, true);
  assert.equal(g.json.value, "z-ai/glm4.7");
  assert.equal(g.json.isDefault, false);

  const bad = await call("POST", "/api/settings/fast-model-id", { model: "bad model!" });
  assert.equal(bad.status, 400);
  assert.equal(process.env.COGNOS_FAST_MODEL, "z-ai/glm4.7", "rejections leave state untouched");

  const d = await call("DELETE", "/api/settings/fast-model-id");
  assert.equal(d.status, 200);
  assert.equal(d.json.reset, true);
  assert.ok(!("COGNOS_FAST_MODEL" in process.env));
  assert.ok(!fs.existsSync(fp));
});

await test("image-model: set, persist, reset", async () => {
  const r = await call("POST", "/api/settings/image-model-id", { model: "qwen/qwen3-next-80b-a3b-instruct" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(process.env.COGNOS_IMAGE_MODEL, "qwen/qwen3-next-80b-a3b-instruct");
  const fp = path.join(process.env.COGNOS_DATA_DIR, "cognos_image_model.txt");
  assert.equal(fs.statSync(fp).mode & 0o777, 0o600);
  const d = await call("DELETE", "/api/settings/image-model-id");
  assert.equal(d.json.reset, true);
  assert.ok(!("COGNOS_IMAGE_MODEL" in process.env));
  assert.ok(!fs.existsSync(fp));
});

// --- diagnose-ai scrubbing ------------------------------------------------------
await test("diagnose-ai never exposes the endpoint URL to the app", async () => {
  delete process.env.BLUESMINDS_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const r = await call("GET", "/api/settings/diagnose-ai");
  assert.equal(r.status, 200);
  const keys = Object.keys(r.json);
  assert.ok(!keys.includes("baseUrl") && !keys.includes("host") && !keys.includes("port"),
    `endpoint fields scrubbed, got: ${keys.join(",")}`);
  for (const s of r.json.stages || []) {
    assert.ok(!/https?:\/\//.test(String(s.detail || "")), `stage "${s.name}" leaks no URL`);
  }
  process.env.BLUESMINDS_API_KEY = "test-provider-key";
});

global.fetch = realFetch;
srv.close();
delete process.env.COGNOS_DATA_DIR;

console.log(`\nSETTINGS-MODELS RESULT: ${passed} passed`);
