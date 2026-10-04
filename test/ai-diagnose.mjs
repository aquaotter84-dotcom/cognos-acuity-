// AI-connection self-diagnostic (server/ai-diagnose.js).
//
// Verifies the staged diagnostic's shape, its key-sanity checks, that the key
// (or any part of it) never appears in the output, graceful handling of a
// refused TCP connection via the test-only base-URL override, and that stages
// short-circuit in order. All network I/O here is loopback-only — nothing
// leaves the machine.

import http from "node:http";

let pass = 0;
function ok(cond, name) {
  if (!cond) { console.error("FAIL:", name); process.exit(1); }
  pass++;
  console.log("ok:", name);
}

const { diagnoseAiConnection, resolveDiagnoseBaseUrl, DIAGNOSE_DEFAULT_BASE_URL } =
  await import("../server/ai-diagnose.js");

// --- env hygiene -----------------------------------------------------------
const savedEnv = {};
for (const k of ["BLUESMINDS_API_KEY", "OPENAI_API_KEY", "COGNOS_DIAGNOSE_BASE_URL",
  "BLUESMINDS_API_URL", "OPENAI_BASE_URL", "BLUESMINDS_MODEL", "COGNOS_MODEL",
  "OPENAI_MODEL", "COGNOS_DATA_DIR"]) {
  savedEnv[k] = process.env[k];
  delete process.env[k];
}
const restoreEnv = () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
process.on("exit", restoreEnv);

const SECRET = "sk-test-DIAGNOSE-SECRET-zz9q8w7e";

// --- base-URL resolution ---------------------------------------------------
ok(resolveDiagnoseBaseUrl() === DIAGNOSE_DEFAULT_BASE_URL,
  "defaults to the real BluesMinds base URL");
ok(resolveDiagnoseBaseUrl({ baseUrl: "https://api.bluesminds.com/v1/chat/completions" }) ===
  "https://api.bluesminds.com/v1",
  "strips a pasted /chat/completions suffix");
process.env.COGNOS_DIAGNOSE_BASE_URL = "http://127.0.0.1:9999";
ok(resolveDiagnoseBaseUrl() === "http://127.0.0.1:9999",
  "COGNOS_DIAGNOSE_BASE_URL override is honored");
ok(resolveDiagnoseBaseUrl({ baseUrl: "http://127.0.0.1:8888" }) === "http://127.0.0.1:8888",
  "explicit param wins over the env override");
delete process.env.COGNOS_DIAGNOSE_BASE_URL;

// --- no key: short-circuits after the key stage -----------------------------
{
  const r = await diagnoseAiConnection({ baseUrl: "http://127.0.0.1:9999" });
  ok(r.ok === false, "no key → overall not ok");
  ok(Array.isArray(r.stages) && r.stages.length === 1 && r.stages[0].name === "key",
    "no key → only the key stage runs");
  ok(r.stages[0].ok === false && r.stages[0].data.present === false,
    "no key → key stage reports present:false");
  ok(typeof r.summary === "string" && r.summary.length > 0, "result carries a summary");
  ok(typeof r.totalMs === "number" && typeof r.at === "string", "result carries timing metadata");
}

// --- bad-charset key: detected, never echoed --------------------------------
{
process.env.BLUESMINDS_API_KEY="sk bad\nkey <b>html</b>";
  const r = await diagnoseAiConnection({ baseUrl: "http://127.0.0.1:9999" });
  ok(r.stages.length === 1 && r.stages[0].name === "key" && r.stages[0].ok === false,
    "bad-charset key → key stage fails and short-circuits");
  ok(r.stages[0].data.formatOk === false, "bad-charset key → formatOk is false");
  const dumped = JSON.stringify(r);
  ok(!dumped.includes("sk bad") && !dumped.includes("DIAGNOSE") && !dumped.includes("<b>html</b>"),
    "key material never appears in diagnostic output");
  delete process.env.BLUESMINDS_API_KEY;
}

// --- refused TCP: graceful, ordered, real error code ------------------------
async function closedLoopbackPort() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
{
process.env.BLUESMINDS_API_KEY=SECRET;
  const port = await closedLoopbackPort();
  const r = await diagnoseAiConnection({ baseUrl: `http://127.0.0.1:${port}` });
  const names = r.stages.map((s) => s.name);
  ok(r.ok === false, "refused TCP → overall not ok");
  ok(JSON.stringify(names) === JSON.stringify(["key", "dns", "tcp"]),
    `refused TCP → stages stop after tcp (got: ${names.join(",")})`);
  ok(r.stages[0].ok === true && r.stages[1].ok === true,
    "refused TCP → key and dns stages pass");
  const tcp = r.stages[2];
  ok(tcp.ok === false && tcp.data.errorCode === "ECONNREFUSED",
    `refused TCP → tcp stage records ECONNREFUSED (got: ${tcp.data.errorCode})`);
  ok(!JSON.stringify(r).includes("DIAGNOSE-SECRET"),
    "refused TCP → key material never appears in output");
  delete process.env.BLUESMINDS_API_KEY;
}

// --- full loopback success: 401 still counts as transport success -----------
{
process.env.BLUESMINDS_API_KEY=SECRET;
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid token" } }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const r = await diagnoseAiConnection({ baseUrl: `http://127.0.0.1:${port}` });
    const names = r.stages.map((s) => s.name);
    ok(r.ok === true, "loopback 401 → overall ok");
    ok(JSON.stringify(names) === JSON.stringify(["key", "dns", "tcp", "tls", "https"]),
      `loopback 401 → all five stages run (got: ${names.join(",")})`);
    ok(r.stages.every((s) => s.ok === true), "loopback 401 → every stage passes");
    const tlsStage = r.stages.find((s) => s.name === "tls");
    ok(tlsStage.skipped === true, "loopback http → tls stage is marked skipped");
    const https = r.stages.find((s) => s.name === "https");
    ok(https.data.status === 401, "loopback 401 → https stage records the status");
    ok(r.host === "127.0.0.1" && r.port === port, "result reports the tested host/port");
    ok(!JSON.stringify(r).includes("DIAGNOSE-SECRET"),
      "loopback success → key material never appears in output");
    ok(r.totalMs < 40000, "diagnostic stays within its wall-clock budget");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.BLUESMINDS_API_KEY;
  }
}

// --- env-only override path (no param) ---------------------------------------
{
process.env.BLUESMINDS_API_KEY=SECRET;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  process.env.COGNOS_DIAGNOSE_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    const r = await diagnoseAiConnection();
    ok(r.ok === true && r.baseUrl === `http://127.0.0.1:${port}`,
      "env override is used when no param is given");
  } finally {
    delete process.env.COGNOS_DIAGNOSE_BASE_URL;
    await new Promise((resolve) => server.close(resolve));
    delete process.env.BLUESMINDS_API_KEY;
  }
}

// --- hanging server: https stage times out with a named error ----------------
{
process.env.BLUESMINDS_API_KEY=SECRET;
  const server = http.createServer(() => { /* never respond */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const r = await diagnoseAiConnection({ baseUrl: `http://127.0.0.1:${port}` });
    const https = r.stages.find((s) => s.name === "https");
    ok(r.ok === false && https && https.ok === false,
      "hanging server → https stage fails");
    ok(https.data.errorName === "TimeoutError" && https.data.errorCode === "DIAG_TIMEOUT",
      `hanging server → records TimeoutError/DIAG_TIMEOUT (got: ${https.data.errorName}/${https.data.errorCode})`);
    ok(!JSON.stringify(r).includes("DIAGNOSE-SECRET"),
      "hanging server → key material never appears in output");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.BLUESMINDS_API_KEY;
  }
}

// --- AI model settings routes (server/routes/settings.js) --------------------
// Model-id settings: validation, file mode 0600, env applied immediately,
// reset semantics, and GET responses that never leak the API key or the
// endpoint URL (Jeremy's boundary: keys and endpoints stay keyed in).
import express from "express";
import fss from "node:fs";
import oss from "node:os";
import pathh from "node:path";

const { validateModelId, registerSettingsRoutes } =
  await import("../server/routes/settings.js");

// Unit: model-id validation.
ok(validateModelId("gemini-2.0-flash") === null, "accepts a Gemini model id");
ok(validateModelId("openai/gpt-oss-20b") === null, "accepts a namespaced model id");
ok(validateModelId("model_v1.2:fast") === null, "accepts . _ : characters");
ok(typeof validateModelId("bad model!") === "string", "rejects model id with bad charset");
ok(typeof validateModelId("x".repeat(101)) === "string", "rejects overlong model id");

// Route-level: minimal express app with an isolated device dir.
process.env.COGNOS_DATA_DIR = fss.mkdtempSync(pathh.join(oss.tmpdir(), "cognos-aisettings-"));
const tapp = express();
tapp.use(express.json());
const twrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  if (!res.headersSent) res.status(500).json({ error: String(err && err.message || err) });
});
registerSettingsRoutes(tapp, { wrap: twrap, logger: null });
const tsrv = await new Promise((resolve) => {
  const s = tapp.listen(0, "127.0.0.1", () => resolve(s));
});
const tapi = `http://127.0.0.1:${tsrv.address().port}`;
const KEY3 = "sk-test-PROVIDER-ROUTE-SECRET-zz4";
process.env.BLUESMINDS_API_KEY = KEY3;

async function tcall(method, p, body) {
  const res = await fetch(tapi + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}
const noKeyLeak = (obj, name) =>
  ok(!JSON.stringify(obj).includes("PROVIDER-ROUTE-SECRET"), `${name} → GET never leaks the API key`);

// Model id: default state.
{
  const r = await tcall("GET", "/api/settings/model-id");
  ok(r.status === 200 && r.json.configured === false && r.json.isDefault === true &&
    r.json.value === "openai/gpt-oss-20b" && r.json.managed === "device",
    "GET model id reports the built-in default");
  noKeyLeak(r.json, "model id default");
}

// Model id: set, file mode 0600, env applied immediately.
{
  const r = await tcall("POST", "/api/settings/model-id", { model: "gemini-2.0-flash" });
  ok(r.status === 200 && r.json.value === "gemini-2.0-flash", "POST model id saves");
  ok(process.env.COGNOS_MODEL === "gemini-2.0-flash",
    "POST model id applies to the environment immediately");
  const fp = pathh.join(process.env.COGNOS_DATA_DIR, "cognos_model.txt");
  ok(fss.readFileSync(fp, "utf8") === "gemini-2.0-flash",
    "POST model id persists to the device file");
  ok((fss.statSync(fp).mode & 0o777) === 0o600, "model id device file has mode 0600");
  const g = await tcall("GET", "/api/settings/model-id");
  ok(g.json.configured === true && g.json.isDefault === false && g.json.value === "gemini-2.0-flash",
    "GET model id reflects the override");
  noKeyLeak(g.json, "model id override");
}

// Model id: rejections leave state untouched.
for (const [bad, name] of [["bad model!", "bad charset"], ["x".repeat(101), "overlong"]]) {
  const r = await tcall("POST", "/api/settings/model-id", { model: bad });
  ok(r.status === 400 && typeof r.json.error === "string", `POST model id rejects ${name}`);
}
ok(process.env.COGNOS_MODEL === "gemini-2.0-flash",
  "rejected POSTs leave the configured model untouched");

// Model id: reset semantics.
{
  const r = await tcall("POST", "/api/settings/model-id", { model: "" });
  ok(r.status === 200 && r.json.reset === true, "empty POST resets the model id");
  ok(!("COGNOS_MODEL" in process.env) &&
    !fss.existsSync(pathh.join(process.env.COGNOS_DATA_DIR, "cognos_model.txt")),
    "reset removes the env var and the device file");
  const g = await tcall("GET", "/api/settings/model-id");
  ok(g.json.isDefault === true && g.json.value === "openai/gpt-oss-20b",
    "GET model id reports the default after reset");
}

await new Promise((resolve) => tsrv.close(resolve));
fss.rmSync(process.env.COGNOS_DATA_DIR, { recursive: true, force: true });
delete process.env.COGNOS_DATA_DIR;
delete process.env.BLUESMINDS_API_KEY;

console.log(`\nai-diagnose: ${pass} checks passed`);
