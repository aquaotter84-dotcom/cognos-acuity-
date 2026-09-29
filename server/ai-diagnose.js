// Staged AI-connection self-diagnostic.
//
// The app's chat path (server/llm.js) reports only "the model provider could
// not be reached" when fetch() throws at the transport level, swallowing the
// underlying error. This module replays the connection the app makes — the
// same base-URL resolution, the same undici fetch — but in observable stages
// (key sanity, DNS, TCP, TLS, HTTPS) so the failing stage names the real
// cause instead of leaving us guessing.
//
// SECURITY: the API key is never logged, returned, or persisted by this
// module. Results carry only booleans, key-length metadata, addresses,
// status codes, and error metadata. The Authorization header value is built
// in-memory for the HTTPS stage and never leaves this module.

import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

export const DIAGNOSE_DEFAULT_BASE_URL = "https://api.bluesminds.com/v1";
const STAGE_TIMEOUT_MS = 8000;

// Mirrors server/llm.js apiConfig()'s base-URL resolution, minus the key, so
// the diagnostic tests exactly what the app would use. Precedence:
// explicit options.baseUrl (tests) → COGNOS_DIAGNOSE_BASE_URL (a test-only
// env override consumed ONLY by this diagnostic) → the app's own env vars →
// the built-in default.
export function resolveDiagnoseBaseUrl(options = {}) {
  const raw = options.baseUrl
    || process.env.COGNOS_DIAGNOSE_BASE_URL
    || process.env.BLUESMINDS_API_URL
    || process.env.OPENAI_BASE_URL
    || DIAGNOSE_DEFAULT_BASE_URL;
  return String(raw)
    .replace(/\/chat\/completions\/?$/, "")
    .replace(/\/$/, "");
}

function stripCredentials(url) {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return String(url);
  }
}

// Defense in depth: if a misconfigured base URL ever embedded credentials,
// keep them out of any recorded message.
function sanitizeMessage(text) {
  return String(text).replace(/:\/\/[^@\s/]+@/g, "://***@");
}

// Key sanity. Returns metadata only — the key value never leaves this
// function except inside the HTTPS stage's Authorization header.
function checkKey() {
  const raw = process.env.BLUESMINDS_API_KEY || process.env.OPENAI_API_KEY;
  const present = typeof raw === "string" && raw.trim().length > 0;
  const length = present ? raw.trim().length : 0;
  let formatOk = false;
  let detail;
  if (!present) {
    detail = "No API key is saved on this device — add one under Settings → AI model key first.";
  } else {
    const key = raw.trim();
    const printableAscii = /^[\x20-\x7E]+$/.test(key);
    const noInternalWhitespace = !/\s/.test(key);
    formatOk = key.length >= 1 && key.length <= 500 && printableAscii && noInternalWhitespace;
    detail = formatOk
      ? `A key is saved (${key.length} characters) and its format looks sane.`
      : `A key is saved (${key.length} characters) but its format looks off — check for stray spaces, line breaks, or pasted HTML.`;
  }
  return { present, length, formatOk, detail };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Timed out after ${ms}ms`);
      err.code = "DIAG_TIMEOUT";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function connectTcp(host, port, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const err = new Error(`TCP connect to ${host}:${port} timed out after ${ms}ms`);
      err.code = "DIAG_TIMEOUT";
      socket.destroy();
      reject(err);
    }, ms);
    socket.once("connect", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

function connectTls(host, port, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const socket = tls.connect({ host, port, servername: host });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const err = new Error(`TLS handshake with ${host}:${port} timed out after ${ms}ms`);
      err.code = "DIAG_TIMEOUT";
      socket.destroy();
      reject(err);
    }, ms);
    socket.once("secureConnect", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const protocol = typeof socket.getProtocol === "function" ? socket.getProtocol() : null;
      socket.destroy();
      resolve({ protocol });
    });
    socket.once("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

// The exact request shape the app makes (same undici fetch). Any HTTP
// response — even a 401 — proves the transport works; a throw is the datum
// the chat path currently swallows, so record name/code/message.
async function stageHttps(modelsUrl, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STAGE_TIMEOUT_MS);
  try {
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    return { transportOk: true, status: res.status };
  } catch (err) {
    // The only abort source is our own timer, so an AbortError is a timeout.
    const timeout = err?.name === "AbortError";
    const message = timeout
      ? `Timed out after ${STAGE_TIMEOUT_MS}ms with no HTTP response`
      : sanitizeMessage(String(err?.message || err)).slice(0, 300);
    return {
      transportOk: false,
      errorName: timeout ? "TimeoutError" : (err?.name || "Error"),
      errorCode: timeout ? "DIAG_TIMEOUT" : (err?.code || null),
      errorMessage: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function diagnoseAiConnection(options = {}) {
  const t0 = Date.now();
  const baseUrl = resolveDiagnoseBaseUrl(options);
  const stages = [];
  let url = null;
  try { url = new URL(baseUrl); } catch { url = null; }
  const host = url ? url.hostname : null;
  const port = url ? (url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80)) : null;

  const finish = (ok, failedStage) => ({
    ok,
    baseUrl: stripCredentials(baseUrl),
    host,
    port,
    stages,
    totalMs: Date.now() - t0,
    summary: ok
      ? "All stages passed — this device can reach the AI service. If answers still fail, the problem is the key or the model, not the network."
      : `Stopped at the "${failedStage}" stage — its detail above names the problem.`,
    at: new Date().toISOString(),
  });

  const runStage = async (name, fn) => {
    const s0 = Date.now();
    try {
      const data = await fn();
      stages.push({ name, ok: true, ms: Date.now() - s0, ...data });
      return true;
    } catch (err) {
      stages.push({
        name,
        ok: false,
        ms: Date.now() - s0,
        detail: String(err?.message || err).slice(0, 300),
        data: { errorName: err?.name || "Error", errorCode: err?.code || null },
      });
      return false;
    }
  };

  // Stage 1: key sanity (no network).
  {
    const key = checkKey();
    const s0 = Date.now();
    const ok = key.present && key.formatOk;
    stages.push({
      name: "key",
      ok,
      ms: Date.now() - s0,
      detail: key.detail,
      data: { present: key.present, length: key.length, formatOk: key.formatOk },
    });
    if (!ok) return finish(false, "key");
  }

  // Stage 2: DNS.
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    stages.push({
      name: "dns", ok: false, ms: 0,
      detail: `Cannot parse a host from the configured base URL.`,
      data: {},
    });
    return finish(false, "dns");
  }
  if (!await runStage("dns", async () => {
    const addrs = await withTimeout(dns.lookup(host, { all: true }), STAGE_TIMEOUT_MS);
    const list = addrs.map((a) => `${a.address} (IPv${a.family})`);
    return {
      detail: `Resolved ${host} to ${list.join(", ")}.`,
      data: { addresses: list },
    };
  })) return finish(false, "dns");

  // Stage 3: TCP.
  if (!await runStage("tcp", async () => {
    await connectTcp(host, port, STAGE_TIMEOUT_MS);
    return { detail: `TCP connection to ${host}:${port} opened successfully.`, data: {} };
  })) return finish(false, "tcp");

  // Stage 4: TLS (https only; skipped for plain-http test URLs).
  if (url.protocol === "https:") {
    if (!await runStage("tls", async () => {
      const { protocol } = await connectTls(host, port, STAGE_TIMEOUT_MS);
      return {
        detail: `TLS handshake completed${protocol ? ` (${protocol})` : ""}.`,
        data: { protocol: protocol || null },
      };
    })) return finish(false, "tls");
  } else {
    stages.push({
      name: "tls", ok: true, skipped: true, ms: 0,
      detail: "Skipped — plain HTTP test URL, no TLS involved.",
      data: {},
    });
  }

  // Stage 5: HTTPS — any HTTP status is transport success.
  {
    const apiKey = process.env.BLUESMINDS_API_KEY || process.env.OPENAI_API_KEY;
    const modelsUrl = `${baseUrl}/v1/models`;
    const s0 = Date.now();
    const result = await stageHttps(modelsUrl, apiKey);
    if (result.transportOk) {
      const keyNote = (result.status === 401 || result.status === 403)
        ? " The key was rejected, but the connection itself works — fix the key, not the network."
        : "";
      stages.push({
        name: "https", ok: true, ms: Date.now() - s0,
        detail: `The server answered HTTP ${result.status} — the full network path works.${keyNote}`,
        data: { status: result.status },
      });
    } else {
      stages.push({
        name: "https", ok: false, ms: Date.now() - s0,
        detail: `The request failed before any HTTP response arrived: ${result.errorName}${result.errorCode ? ` (${result.errorCode})` : ""} — ${result.errorMessage}`,
        data: {
          errorName: result.errorName,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        },
      });
      return finish(false, "https");
    }
  }

  return finish(true);
}
