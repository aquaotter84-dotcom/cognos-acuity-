// The webhook delivery adapter — Phase 21, the first T4 destination.
//
// AUTONOMY.md §4.7.1. One adapter buys most of the external-write surface
// (Slack, Discord, n8n, Zapier, Make, Home Assistant, any custom endpoint are
// all POST to an https URL) and it is the sharpest one: a webhook is not a
// message, it is a TRIGGER. So every gate here is deterministic and runs
// before a socket opens, and the four risks named in the design each get their
// own code path:
//
//   outbound SSRF       checkWebhookUrl + resolvePublicHosts + re-check per hop
//   downstream harm     destinations come from granted scope rows, never args
//   credential leakage  secret_ref names an env var; the value is read at send
//                       time, signs the body, and is stored nowhere
//   amplification       one attempt + one bounded retry, idempotency key on the
//                       wire, per-goal/per-day caps judged by the Governor
//
// Receipts are METADATA ONLY. A response body is read, digest, and discarded:
// an endpoint that echoes a credential back must not write that credential into
// the ledger, the outbox, or telemetry. Header NAMES are recorded, never values.
//
// Nothing in this module decides whether a delivery may happen. That is the
// Action Governor's verdict, and this module is only what a `live` verdict is
// allowed to touch.

import { createHash, createHmac } from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { isPublicAddress } from "../sources/safeFetch.js";

/** An env-var name shape. A `secret_ref` is a NAME, and this is what one looks like. */
const SECRET_REF_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Headers the adapter itself sets. A caller supplying one is spoofing provenance. */
export const RESERVED_HEADERS = Object.freeze([
  "user-agent", "content-length", "host", "connection",
  "x-cognos-idempotency-key", "x-cognos-goal-id", "x-cognos-agent-id",
  "x-cognos-tick-id", "x-cognos-effect-id", "x-cognos-timestamp",
  "x-cognos-signature", "x-cognos-signature-algorithm"
]);

/**
 * Headers that may never be supplied as arguments, whatever the allowlist says.
 * `authorization` is here because §8.10c requires it: a credential in a payload
 * is refused, and a header named Authorization is a credential by another name.
 * Signing is done by `secret_ref`, which resolves server-side and never lands
 * in a stored row.
 */
export const FORBIDDEN_HEADERS = Object.freeze([
  "authorization", "proxy-authorization", "cookie", "set-cookie",
  "x-api-key", "x-auth-token", "x-goog-api-key", "api-key",
  "transfer-encoding", "upgrade", "te", "trailer", "expect",
  "referer", "origin", "forwarded", "x-forwarded-for", "x-forwarded-host"
]);

/** Argument headers may be `content-type` or anything under the COGNOS prefix. */
export function isAllowedHeaderName(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower || !/^[a-z0-9][a-z0-9!#$%&'*+.^_`|~-]*$/.test(lower)) return false;
  if (RESERVED_HEADERS.includes(lower)) return false;
  if (FORBIDDEN_HEADERS.includes(lower)) return false;
  return lower === "content-type" || lower.startsWith("x-cognos-");
}

/**
 * Validate argument headers. Refuses the whole set and names every offending
 * header, because a refusal that names one of three problems invites a retry
 * that fixes one and keeps two.
 *
 * @returns {{ok: boolean, errors: string[], names: string[], values: Object}}
 */
export function checkWebhookHeaders(headers) {
  const source = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  const errors = [];
  const names = [];
  const values = {};
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = String(rawName || "").trim().toLowerCase();
    if (!name) { errors.push("a header name is empty"); continue; }
    if (FORBIDDEN_HEADERS.includes(name)) {
      errors.push(`header '${name}' may never be supplied as an argument`);
      continue;
    }
    if (RESERVED_HEADERS.includes(name)) {
      errors.push(`header '${name}' is set by the adapter and cannot be supplied`);
      continue;
    }
    if (!isAllowedHeaderName(name)) {
      errors.push(`header '${name}' is not allowlisted (content-type or x-cognos-* only)`);
      continue;
    }
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      errors.push(`header '${name}' must be a non-empty string`);
      continue;
    }
    if (rawValue.length > 400) {
      errors.push(`header '${name}' exceeds 400 characters`);
      continue;
    }
    // A header value is on the wire, so it gets the same control-character
    // treatment a body gets: no CRLF injection into the request line.
    if (/[\u0000-\u001F\u007F]/.test(rawValue)) {
      errors.push(`header '${name}' contains a control character`);
      continue;
    }
    names.push(name);
    values[name] = rawValue.trim();
  }
  return { ok: errors.length === 0, errors, names: names.sort(), values };
}

const LOCAL_HOSTNAMES = Object.freeze(["localhost"]);
const LOCAL_SUFFIXES = Object.freeze([".localhost", ".local", ".internal", ".invalid", ".lan", ".home"]);

/**
 * Is this hostname local or reserved by name (never mind DNS)? Exported so the
 * GRANT path — validating a destination an operator is about to write into a
 * scope — can apply the adapter's own boundary instead of growing a second
 * copy of the rule that could drift away from it.
 */
export function isLocalOrReservedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return false;
  return LOCAL_HOSTNAMES.includes(host) || LOCAL_SUFFIXES.some(s => host.endsWith(s));
}

/**
 * The structural gate: https, standard port, no credentials, no literal IP, no
 * local hostname. Runs before DNS and again for every redirect target, because
 * a public URL that 302s to `http://169.254.169.254/` is the whole attack.
 *
 * @returns {{ok: boolean, reason: string|null, url: URL|null, hostname: string|null}}
 */
export function checkWebhookUrl(href) {
  let parsed = null;
  try {
    parsed = new URL(String(href || "").trim());
  } catch {
    return { ok: false, reason: "the webhook URL does not parse", url: null, hostname: null };
  }
  const fail = (reason) => ({ ok: false, reason, url: parsed, hostname: parsed.hostname });

  if (parsed.protocol !== "https:") {
    return fail(`a webhook must be https; this is ${parsed.protocol}//`);
  }
  if (parsed.username || parsed.password) return fail("the webhook URL carries credentials");
  const hostname = String(parsed.hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname) return fail("the webhook URL has no hostname");
  if (net.isIP(hostname)) return fail("the webhook URL names a literal IP address");
  if (isLocalOrReservedHost(hostname)) {
    return fail(`the webhook URL names a local or reserved hostname (${hostname})`);
  }
  const port = parsed.port || "443";
  if (port !== "443") return fail(`a webhook must use port 443; this names ${parsed.port}`);

  parsed.hostname = hostname;
  parsed.hash = "";
  return { ok: true, reason: null, url: parsed, hostname };
}

/**
 * Resolve a hostname and require EVERY answer to be public. One private record
 * in a round-robin set is enough to refuse: the connection could land on any of
 * them, and "usually public" is not a boundary.
 */
export async function resolvePublicHosts(hostname, { resolve = null } = {}) {
  const lookup = resolve || (async (host) => {
    const family = net.isIP(host);
    if (family) return [{ address: host, family }];
    return dns.lookup(host, { all: true, verbatim: true });
  });
  let records;
  try {
    records = await lookup(hostname);
  } catch {
    throw Object.assign(new Error("the webhook hostname could not be resolved"), { rule: "UNSAFE_URL" });
  }
  const list = Array.isArray(records) ? records : [];
  if (!list.length) {
    throw Object.assign(new Error("the webhook hostname did not resolve"), { rule: "UNSAFE_URL" });
  }
  const privateRecord = list.find(r => !isPublicAddress(r?.address, r?.family));
  if (privateRecord) {
    // The ADDRESS is not logged: naming which internal host a deployment can
    // reach is exactly the reconnaissance an outbound SSRF probe is for.
    throw Object.assign(
      new Error("the webhook destination resolves to a private, local, reserved, or non-public address"),
      { rule: "UNSAFE_URL", addresses: list.length }
    );
  }
  return list;
}

/**
 * Read a signing secret by NAME. The name is what is stored; the value exists
 * only for the lifetime of one request (pin.secrets_env_only).
 *
 * @returns {{ok: boolean, value?: string, reason?: string}}
 */
export function resolveSecretRef(secretRef, env = process.env) {
  if (secretRef === null || secretRef === undefined || secretRef === "") {
    return { ok: true, value: null };                    // signing is optional
  }
  const name = String(secretRef).trim();
  if (!SECRET_REF_SHAPE.test(name)) {
    return { ok: false, reason: `secret_ref '${name.slice(0, 40)}' is not an environment variable name` };
  }
  const value = env ? env[name] : undefined;
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, reason: `secret_ref '${name}' names an environment variable that is not set` };
  }
  return { ok: true, value, name };
}

/** `X-COGNOS-Signature: sha256=<hmac(body)>` — the design's exact shape. */
export function signBody(body, secret) {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(String(body ?? ""), "utf8")).digest("hex")}`;
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Build the exact request a live verdict would send. PURE: no socket, no DNS.
 *
 * `dry_run` stores this and sends nothing (§4.7.1 gate 7), so the record shows
 * the request that would have gone out — header names and a body digest, never
 * a secret and never a signature value.
 */
export function buildWebhookRequest({
  url, method = "POST", headers = {}, body = "", secretRef = null,
  idempotencyKey = null, goalId = null, agentId = null, tickId = null, effectId = null,
  nowMs = Date.now(), env = process.env, maxBodyBytes = 32_768
}) {
  const errors = [];

  const shaped = checkWebhookUrl(url);
  if (!shaped.ok) errors.push(shaped.reason);

  if (String(method || "POST").toUpperCase() !== "POST") {
    errors.push(`method '${String(method || "").toUpperCase() || "(none)"}' is not POST; POST is the only method built`);
  }

  const text = typeof body === "string" ? body : (body == null ? "" : JSON.stringify(body));
  const bodyBytes = Buffer.byteLength(text, "utf8");
  if (!text.trim()) errors.push("a webhook body is required");
  if (bodyBytes > maxBodyBytes) errors.push(`the body is ${bodyBytes} bytes, over the ${maxBodyBytes} byte cap`);

  const checked = checkWebhookHeaders(headers);
  errors.push(...checked.errors);

  const secret = resolveSecretRef(secretRef, env);
  if (!secret.ok) errors.push(secret.reason);

  const finalHeaders = {
    "user-agent": "COGNOS-Webhook/1.0",
    "content-type": "application/json",
    ...checked.values,
    "x-cognos-idempotency-key": String(idempotencyKey || ""),
    "x-cognos-timestamp": String(nowMs)
  };
  if (goalId) finalHeaders["x-cognos-goal-id"] = String(goalId);
  if (agentId) finalHeaders["x-cognos-agent-id"] = String(agentId);
  if (tickId) finalHeaders["x-cognos-tick-id"] = String(tickId);
  if (effectId) finalHeaders["x-cognos-effect-id"] = String(effectId);
  if (secret.value) {
    finalHeaders["x-cognos-signature-algorithm"] = "sha256";
    finalHeaders["x-cognos-signature"] = signBody(text, secret.value);
  }

  return {
    ok: errors.length === 0,
    errors,
    request: {
      url: shaped.url ? shaped.url.href : String(url || ""),
      hostname: shaped.hostname,
      method: "POST",
      headers: finalHeaders,
      body: text,
      bodyBytes
    },
    // What may be stored: names, never values.
    sentHeaderNames: Object.keys(finalHeaders).map(n => n.toLowerCase()).sort(),
    signed: Boolean(secret.value),
    secretRef: secret.name || null,
    bodyDigest: sha256(text),
    bodyBytes
  };
}

/** A DNS-pinned POST. No automatic redirects: every hop is re-validated here. */
export function pinnedTransport({ url, headers, body, records, timeoutMs, signal, maxResponseBytes }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(Object.assign(new Error("the webhook delivery was cancelled"), { name: "AbortError" }));
    }
    const target = new URL(url);
    const lookup = (_hostname, options, callback) => {
      const family = typeof options === "object" ? Number(options.family || 0) : Number(options || 0);
      const candidates = family ? records.filter(r => Number(r.family) === family) : records;
      const selected = candidates[0] || records[0];
      if (typeof options === "object" && options.all) return callback(null, candidates);
      callback(null, selected.address, selected.family);
    };

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };

    const req = https.request(target, {
      method: "POST",
      lookup,
      servername: target.hostname,
      headers: { ...headers, "content-length": String(Buffer.byteLength(body || "", "utf8")),
        "accept-encoding": "identity" }
    }, response => {
      const declared = Number(response.headers["content-length"] || 0);
      const encoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
      const chunks = [];
      let bytes = 0;
      let kept = 0;
      let truncated = false;
      // Read to the cap and no further. A receiver that answers with a gigabyte
      // gets a digest of its first bytes and a `truncated` flag, not a memory
      // exhaustion — and the body is never returned, only its digest.
      response.on("data", chunk => {
        bytes += chunk.length;
        if (kept < maxResponseBytes) {
          const room = maxResponseBytes - kept;
          chunks.push(room >= chunk.length ? chunk : chunk.subarray(0, room));
          kept += Math.min(room, chunk.length);
          if (chunk.length > room) truncated = true;
        } else {
          truncated = true;
        }
      });
      response.on("error", error => finish(reject, error));
      response.on("end", () => finish(resolve, {
        status: response.statusCode || 0,
        statusText: response.statusMessage || "",
        headers: response.headers,
        body: Buffer.concat(chunks),
        bytes,
        truncated,
        declaredLength: declared,
        encoding
      }));
      // The safe reader asked for identity encoding; anything else is a body we
      // cannot bound or digest honestly, so the socket closes instead.
      if (!["", "identity"].includes(encoding)) response.destroy();
    });

    req.setTimeout(timeoutMs, () => req.destroy(
      Object.assign(new Error(`the webhook delivery timed out after ${timeoutMs}ms`), { rule: "TIMEOUT" })));
    req.on("error", error => finish(reject, error));
    const onAbort = () => req.destroy(signal?.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error("the webhook delivery was cancelled"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.end(body || "");
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function retryAfterMs(headers, capMs) {
  const raw = headers?.["retry-after"];
  if (!raw) return Math.min(capMs, 250);
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(capMs, seconds * 1000));
  const at = Date.parse(String(raw));
  if (Number.isFinite(at)) return Math.max(0, Math.min(capMs, at - Date.now()));
  return Math.min(capMs, 250);
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (ms <= 0) return resolve();
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error("the webhook delivery was cancelled"), { name: "AbortError" })); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

/**
 * Perform one delivery: DNS-pinned, redirect-re-checked, one bounded retry.
 *
 * The transport and resolver are parameters with code-owned defaults. That is a
 * dependency seam, not a capability grant: the ONLY caller that passes one is a
 * test, and the gates above run identically either way — an injected transport
 * still receives a request that passed every structural and DNS check.
 *
 * @returns {object} the receipt: metadata only, response body digested
 */
export async function deliverWebhook(request, {
  resolve = null,
  transport = pinnedTransport,
  timeoutMs = 8_000,
  maxRedirects = 2,
  retryStatuses = [429, 502, 503, 504],
  maxRetryDelayMs = 2_000,
  maxResponseBytes = 65_536,
  digestBytes = 4_096,
  signal = null,
  now = () => Date.now()
} = {}) {
  const startedAt = now();
  let current = String(request.url || "");
  let redirects = 0;
  let attempts = 0;
  let retried = false;
  let last = null;

  for (;;) {
    const shaped = checkWebhookUrl(current);
    if (!shaped.ok) {
      throw Object.assign(new Error(shaped.reason), { rule: "UNSAFE_URL", attempts, redirects });
    }
    // Resolution happens per hop, so a redirect cannot launder a private
    // destination past the gate that checked the first one.
    const records = await resolvePublicHosts(shaped.hostname, { resolve });

    attempts += 1;
    let response;
    try {
      response = await transport({
        url: shaped.url.href,
        method: "POST",
        headers: request.headers,
        body: request.body,
        records,
        timeoutMs,
        signal,
        maxResponseBytes
      });
    } catch (error) {
      // A transport failure may be retried once, exactly like a retry status:
      // the alternative is a goal parked by one dropped packet.
      if (!retried && attempts === 1 && error?.name !== "AbortError") {
        retried = true;
        await sleep(Math.min(maxRetryDelayMs, 250), signal);
        continue;
      }
      throw Object.assign(error, { attempts, redirects });
    }
    last = { response, url: shaped.url.href };

    if (REDIRECTS.has(response.status)) {
      const location = response.headers?.location;
      if (!location) break;
      if (redirects >= maxRedirects) {
        throw Object.assign(new Error(`the webhook redirected more than ${maxRedirects} time(s)`),
          { rule: "UNSAFE_URL", attempts, redirects });
      }
      redirects += 1;
      let next;
      try {
        next = new URL(String(location), shaped.url).href;
      } catch {
        throw Object.assign(new Error("the webhook redirect target does not parse"),
          { rule: "UNSAFE_URL", attempts, redirects });
      }
      current = next;
      continue;                                  // re-validate and re-resolve
    }

    if (retryStatuses.includes(response.status) && !retried) {
      retried = true;
      await sleep(retryAfterMs(response.headers, maxRetryDelayMs), signal);
      continue;                                  // same URL, one more attempt
    }
    break;
  }

  const { response, url } = last;
  const raw = response.body || Buffer.alloc(0);
  const digestSource = raw.subarray(0, Math.max(0, digestBytes));
  return {
    status: response.status,
    statusText: String(response.statusText || "").slice(0, 80),
    accepted: response.status >= 200 && response.status < 300,
    latencyMs: now() - startedAt,
    attempts,
    redirects,
    retried,
    url,
    bodyBytes: Buffer.byteLength(request.body || "", "utf8"),
    sentHeaderNames: Object.keys(request.headers || {}).map(n => n.toLowerCase()).sort(),
    signed: Boolean(request.headers?.["x-cognos-signature"]),
    signatureAlgorithm: request.headers?.["x-cognos-signature"] ? "sha256" : null,
    // Digest only. The body itself is discarded here and never returned.
    responseBodyDigest: sha256(digestSource),
    responseBytes: Number(response.bytes ?? raw.length),
    responseTruncated: response.truncated === true,
    sentAt: new Date(startedAt).toISOString()
  };
}
