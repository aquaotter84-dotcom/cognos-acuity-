// Phase 36 — resident tools: Orbit-style assignable HTTPS tools for residents.
//
// The split of authority, stated once:
//
//   * SKILLS ARE CODE (server/skills/index.js). `tool.invoke` is registered
//     there: the code-owned *mechanism* of invoking an HTTPS endpoint, with
//     its tier, idempotency rule, and kill switch. It cannot be added to at
//     runtime.
//   * TOOLS ARE JEREMY'S DATA. A tool definition (name, method, URL, headers,
//     body template) is hand-typed by Jeremy and stored server-side. A tool
//     grants nothing by existing: a resident may invoke ONLY tools explicitly
//     assigned to it, reads run freely, writes wait for Jeremy's per-effect
//     approval in the existing approvals inbox, and the master kill switch
//     halts everything.
//   * SECRETS ARE WRITE-ONLY. They are typed in once, stored server-side, and
//     never surface: not in list/get APIs, not in run history, not in the
//     outbox payload, not in logs. The executor resolves them at send time.
//
// Template language (URLs, header values, body):
//   {{name}}        — a runtime argument (flat string/number/boolean)
//   {{secret:NAME}} — a write-only secret, resolved at send time; rendered as
//                     ••• in every preview, log, and stored row.

import { createHash } from "node:crypto";
import { SECRET_PATTERNS } from "../meta/policy.js";
import {
  checkWebhookUrl,
  checkWebhookHeaders,
  isAllowedHeaderName,
  resolvePublicHosts,
  pinnedTransport,
} from "./webhookPost.js";
import { effectiveEnabled } from "./settings.js";
import { stageEffect, canonicalize } from "./outbox.js";
import { sendMail } from "../insights/smtp.js";
import { getSendCredentials, validEmail } from "../insights/emailStore.js";

export const TOOL_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);
// A tool is either an 'https' endpoint (Phase 36) or a native 'email' send
// (Phase 39): the resident composes to/subject/body and the delivery goes
// through Jeremy's COGNOS Gmail account — no third-party API, no
// Authorization header, no secrets on the tool. Email tools are ALWAYS
// writes: they stage an approval and never auto-send.
export const TOOL_KINDS = Object.freeze(["https", "email"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BODY_CAP_BYTES = 32_768;
const EXCERPT_CHARS = 4000;
const MAX_EMAIL_RECIPIENTS = 20;
const SUBJECT_CAP_CHARS = 300;

const sha256 = (v) => createHash("sha256").update(String(v ?? ""), "utf8").digest("hex");
const clean = (v, max = 300) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*|secret:[A-Z0-9_]{1,64})\s*\}\}/g;
const STRAY_PLACEHOLDER_RE = /\{\{[^}]*\}\}/;
// `\{{` renders a literal `{{` — the template language owns bare `{{`, and a
// stray one is a typo'd placeholder, which fails closed below.
const ESCAPED_OPEN = "\u0000LBRACE\u0000";

/**
 * Render a template. Throws on any placeholder with no value, and on any
 * leftover {{...}} (malformed or unresolvable). With redactSecrets, secret
 * placeholders render as ••• for previews and stored rows.
 */
export function renderTemplate(template, { args = {}, secrets = {}, redactSecrets = false } = {}) {
  const missing = [];
  const src = String(template ?? "").replace(/\\\{\{/g, ESCAPED_OPEN);
  const rendered = src.replace(PLACEHOLDER_RE, (m, name) => {
    if (name.startsWith("secret:")) {
      const sname = name.slice(7);
      if (redactSecrets) return "•••";
      const v = secrets[sname];
      if (typeof v !== "string" || !v) { missing.push(m); return m; }
      return v;
    }
    const v = args[name];
    if (v === undefined || v === null || typeof v === "object") { missing.push(m); return m; }
    return String(v);
  });
  const stray = rendered.match(STRAY_PLACEHOLDER_RE) || rendered.match(/\{\{/);
  if (missing.length || stray) {
    const names = [...new Set(missing)].slice(0, 5).join(", ") || (stray ? String(stray[0]).slice(0, 40) : "");
    throw new Error(`the template has placeholders with no value: ${names}`);
  }
  return rendered.split(ESCAPED_OPEN).join("{{");
}

/** Secret names referenced by a template ({{secret:NAME}}). */
export function extractSecretRefs(template) {
  const names = new Set();
  String(template ?? "").replace(PLACEHOLDER_RE, (m, name) => {
    if (name.startsWith("secret:")) names.add(name.slice(7));
    return m;
  });
  return [...names].sort();
}

/** Argument names referenced by a template ({{name}}, not {{secret:…}}). */
export function extractArgNames(template) {
  const names = new Set();
  String(template ?? "").replace(PLACEHOLDER_RE, (m, name) => {
    if (!name.startsWith("secret:")) names.add(name);
    return m;
  });
  return [...names].sort();
}

/**
 * Dry-render a template for SHAPE validation: every arg gets a dummy value,
 * secrets redact. Throws only on malformed placeholders — never on missing
 * values, because args arrive at invoke time.
 */
export function dryRenderShape(template) {
  const args = {};
  for (const n of extractArgNames(template)) args[n] = "x";
  return renderTemplate(template, { args, secrets: {}, redactSecrets: true });
}

/** The template with every placeholder blanked — for secret-pattern scans. */
const blankPlaceholders = (s) => String(s ?? "").replace(PLACEHOLDER_RE, "").replace(STRAY_PLACEHOLDER_RE, "");

function looksLikeSecret(text) {
  const blanked = blankPlaceholders(text);
  return SECRET_PATTERNS.some((p) => p.test(blanked));
}

// ---------------------------------------------------------------------------
// Definition validation (routes call this; plain-language errors for Jeremy)
// ---------------------------------------------------------------------------

export function validateToolDefinition({ name, method, url, headers, body_template }) {
  const errors = [];

  const cleanName = String(name ?? "").trim();
  if (!cleanName) errors.push("give the tool a name");
  else if (cleanName.length > 80) errors.push("the name is over 80 characters");

  const cleanMethod = String(method ?? "GET").toUpperCase();
  if (!TOOL_METHODS.includes(cleanMethod)) {
    errors.push(`the method must be one of ${TOOL_METHODS.join(", ")}`);
  }

  // The URL may carry {{var}} in the path or query — never in the host.
  const rawUrl = String(url ?? "").trim();
  if (!rawUrl) {
    errors.push("the tool needs a URL");
  } else {
    try {
      const parsed = new URL(rawUrl);
      if (/\{\{|\}\}/.test(parsed.hostname)) {
        errors.push("placeholders aren't allowed in the hostname — only the path and query");
      }
    } catch {
      errors.push("the URL doesn't parse");
    }
    if (!errors.length || errors[errors.length - 1] !== "the URL doesn't parse") {
      const probed = checkWebhookUrl(rawUrl.replace(PLACEHOLDER_RE, "x").replace(STRAY_PLACEHOLDER_RE, "x"));
      if (!probed.ok) errors.push(`the URL didn't pass the safety check: ${probed.reason}`);
    }
    if (looksLikeSecret(rawUrl)) {
      errors.push("the URL looks like it contains a real key — put keys in the Secrets section, never in the URL");
    }
  }

  const hdrs = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : null;
  if (headers !== undefined && headers !== null && !hdrs) {
    errors.push("headers must be an object of name → value");
  } else if (hdrs) {
    const names = Object.keys(hdrs);
    if (names.length > 20) errors.push("over 20 headers — trim it down");
    for (const rawName of names) {
      const lname = String(rawName || "").trim().toLowerCase();
      if (!lname) { errors.push("a header name is empty"); continue; }
      // Tool definitions allow x-api-key (the standard custom-key header);
      // authorization/cookie/session headers stay forbidden — ambient
      // authority must never be hand-typed into a tool.
      const allowed = lname === "x-api-key" || isAllowedHeaderName(lname);
      if (!allowed) {
        errors.push(`header '${lname}' isn't allowed (content-type, x-cognos-*, or x-api-key only — never authorization or cookie)`);
        continue;
      }
      const v = hdrs[rawName];
      if (typeof v !== "string" || !v.trim()) { errors.push(`header '${lname}' must be a non-empty string`); continue; }
      if (v.length > 2000) { errors.push(`header '${lname}' is over 2000 characters`); continue; }
      if (/[\u0000-\u001F\u007F]/.test(v)) { errors.push(`header '${lname}' contains a control character`); continue; }
      try { dryRenderShape(v); }
      catch (e) { errors.push(`header '${lname}': ${e.message}`); }
      if (looksLikeSecret(v)) {
        errors.push(`header '${lname}' looks like it contains a real key — use {{secret:NAME}} with the Secrets section instead`);
      }
    }
  }

  const body = String(body_template ?? "");
  if (body.length > 200_000) errors.push("the body template is over 200KB");
  if (body) {
    try { dryRenderShape(body); }
    catch (e) { errors.push(`body template: ${e.message}`); }
    if (looksLikeSecret(body)) {
      errors.push("the body template looks like it contains a real key — use {{secret:NAME}} with the Secrets section instead");
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Secret names must look like names, not values. */
export function validateSecretName(name) {
  return /^[A-Z0-9_]{1,64}$/.test(String(name || ""));
}

/** The tool's kind, normalized. Creation-time validation only ever writes
 *  'https' or 'email'; anything else (a hand-built row) reads as 'https',
 *  which fails closed on the empty URL in buildToolRequest. */
export function toolKind(tool) {
  return tool && tool.kind === "email" ? "email" : "https";
}

// ---------------------------------------------------------------------------
// Native email tools (Phase 39)
// ---------------------------------------------------------------------------
// Definition validation (routes call this; plain-language errors for Jeremy).
// The recipient template may be fixed ("you@example.com"), an argument
// ("{{to}}"), or a comma-separated mix — it is rendered with a dummy address
// per argument and every resulting recipient must parse as an email address.

/** Render a template for SHAPE validation with a dummy address per arg. */
function dryRenderEmailShape(template) {
  const args = {};
  for (const n of extractArgNames(template)) args[n] = "placeholder@example.com";
  return renderTemplate(template, { args, secrets: {}, redactSecrets: true });
}

function splitRecipients(rendered) {
  return String(rendered || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function validateEmailToolDefinition({ name, description, to_template, subject_template, body_template }) {
  const errors = [];

  const cleanName = String(name ?? "").trim();
  if (!cleanName) errors.push("give the tool a name");
  else if (cleanName.length > 80) errors.push("the name is over 80 characters");

  const combined = `${to_template ?? ""} ${subject_template ?? ""} ${body_template ?? ""}`;
  if (/\{\{\s*secret:/.test(combined)) {
    errors.push("email tools don't use {{secret:…}} — they send from your COGNOS Gmail, no keys needed");
  }

  const toRaw = String(to_template ?? "").trim();
  if (!toRaw) {
    errors.push("the tool needs a recipient — an address, or {{to}} to fill in when it runs");
  } else {
    try {
      const addrs = splitRecipients(dryRenderEmailShape(toRaw));
      if (!addrs.length) {
        errors.push("the recipient list is empty");
      } else if (addrs.length > MAX_EMAIL_RECIPIENTS) {
        errors.push(`over ${MAX_EMAIL_RECIPIENTS} recipients — trim it down`);
      } else {
        for (const a of addrs) {
          if (!validEmail(a)) {
            errors.push(`“${a.slice(0, 60)}” doesn't look like an email address`);
            break;
          }
        }
      }
    } catch (e) {
      errors.push(`recipient: ${e.message}`);
    }
    if (looksLikeSecret(toRaw)) {
      errors.push("the recipient looks like it contains a real key — email tools don't use Secrets");
    }
  }

  const subj = String(subject_template ?? "");
  try {
    const rendered = dryRenderEmailShape(subj);
    if (rendered.length > SUBJECT_CAP_CHARS) {
      errors.push(`the subject is over ${SUBJECT_CAP_CHARS} characters`);
    }
  } catch (e) {
    errors.push(`subject: ${e.message}`);
  }
  if (looksLikeSecret(subj)) {
    errors.push("the subject looks like it contains a real key — email tools don't use Secrets");
  }

  const body = String(body_template ?? "");
  if (!body.trim()) {
    errors.push("the tool needs a body — an empty email is a misconfiguration");
  } else {
    if (body.length > 200_000) errors.push("the body template is over 200KB");
    try { dryRenderShape(body); }
    catch (e) { errors.push(`body template: ${e.message}`); }
    if (looksLikeSecret(body)) {
      errors.push("the body template looks like it contains a real key — email tools don't use Secrets");
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build the exact email an invocation would send. Renders to/subject/body
 * from args (no secrets exist for email tools — a {{secret:…}} here throws,
 * fail-closed). The returned `redacted` preview is what gets stored and
 * shown; it carries no credential because there is none.
 */
export function buildEmailRequest(tool, { args = {} } = {}) {
  const errors = [];
  let to = [];
  let subject = "";
  let body = "";
  try {
    to = splitRecipients(renderTemplate(tool.to_template || "", { args, secrets: {} }));
  } catch (e) { errors.push(`recipient: ${e.message}`); }
  try {
    subject = renderTemplate(tool.subject_template || "", { args, secrets: {} });
  } catch (e) { errors.push(`subject: ${e.message}`); }
  try {
    body = renderTemplate(tool.body_template || "", { args, secrets: {} });
  } catch (e) { errors.push(`body: ${e.message}`); }

  let bodyBytes = 0;
  if (!errors.length) {
    if (!to.length) errors.push("the email has no recipient");
    else if (to.length > MAX_EMAIL_RECIPIENTS) errors.push(`over ${MAX_EMAIL_RECIPIENTS} recipients — trim it down`);
    else {
      for (const a of to) {
        if (!validEmail(a)) { errors.push(`“${a.slice(0, 80)}” doesn't look like an email address`); break; }
      }
    }
    if (!body.trim()) errors.push("the email body is empty — nothing to send");
    bodyBytes = Buffer.byteLength(body, "utf8");
    if (bodyBytes > BODY_CAP_BYTES) errors.push(`the body is ${bodyBytes} bytes, over the ${BODY_CAP_BYTES} cap`);
    if (subject.length > SUBJECT_CAP_CHARS) errors.push(`the subject is over ${SUBJECT_CAP_CHARS} characters`);
  }

  const bodyDigest = sha256(body);
  let redacted = null;
  if (!errors.length) {
    redacted = {
      kind: "email",
      to,
      subject: subject.slice(0, SUBJECT_CAP_CHARS),
      bodyPreview: body.slice(0, 2000),
      bodyBytes,
      bodyDigest,
    };
  }
  return { ok: errors.length === 0, errors, to, subject, body, bodyDigest, redacted };
}

/** The run row's origin column for an email tool: the destination, honestly. */
function emailOrigin(to) {
  const list = (Array.isArray(to) ? to : []).join(",");
  return list ? `mailto:${list}`.slice(0, 500) : "mailto:(unset)";
}

// ---------------------------------------------------------------------------
// Request building (pure except for the shape; no socket)
// ---------------------------------------------------------------------------

export function originOf(href) {
  try { return new URL(href).origin; } catch { return null; }
}

/**
 * Build the exact request a tool invocation would send. Secrets resolve here
 * (values), but the returned `redacted` preview carries ••• everywhere a
 * secret would appear — that preview is what gets stored and shown.
 */
export function buildToolRequest(tool, { args = {}, secrets = {} } = {}) {
  const errors = [];
  const method = String(tool.method || "GET").toUpperCase();

  let url = null;
  let origin = null;
  try {
    url = renderTemplate(tool.url, { args, secrets });
  } catch (e) { errors.push(`URL: ${e.message}`); }
  if (url) {
    const shaped = checkWebhookUrl(url);
    if (!shaped.ok) errors.push(`URL: ${shaped.reason}`);
    else {
      origin = shaped.url.origin;
      // The destination's authority is the definition: the rendered request
      // must stay on the definition's origin. Placeholders can't move the
      // host (creation-time rule), so a mismatch here is a bug, not input.
      const defOrigin = originOf(String(tool.url).replace(PLACEHOLDER_RE, "x").replace(STRAY_PLACEHOLDER_RE, "x"));
      if (defOrigin && origin !== defOrigin) errors.push("the rendered URL left the tool's own origin");
    }
  }

  const headerCheck = checkToolHeaders(tool.headers, { args, secrets });
  errors.push(...headerCheck.errors);

  let body = "";
  if (method !== "GET") {
    try { body = renderTemplate(tool.body_template || "", { args, secrets }); }
    catch (e) { errors.push(`body: ${e.message}`); }
    if ((method === "POST" || method === "PUT" || method === "PATCH") && !body.trim()) {
      errors.push(`${method} needs a body — the template is empty`);
    }
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > BODY_CAP_BYTES) errors.push(`the body is ${bodyBytes} bytes, over the ${BODY_CAP_BYTES} cap`);
  if (looksLikeSecret(body)) errors.push("the rendered body looks like it contains a credential outside {{secret:…}}");

  const sentHeaderNames = [...headerCheck.names.map((n) => n.toLowerCase()),
    "user-agent", "content-type", "x-cognos-tool-id", "x-cognos-idempotency-key"].sort();

  // The redacted preview: same shape, secrets as •••. Safe to store and show.
  let redacted = null;
  if (!errors.length) {
    try {
      redacted = {
        method,
        url: renderTemplate(tool.url, { args, secrets, redactSecrets: true }),
        headerNames: sentHeaderNames,
        bodyPreview: method === "GET" ? "" : renderTemplate(tool.body_template || "", { args, secrets, redactSecrets: true }).slice(0, 2000),
        bodyBytes,
        bodyDigest: sha256(body),
        secretRefs: extractSecretRefs(`${tool.url} ${JSON.stringify(tool.headers)} ${tool.body_template}`),
      };
    } catch { redacted = null; }
  }

  return {
    ok: errors.length === 0,
    errors,
    origin,
    secretRefs: extractSecretRefs(`${tool.url} ${JSON.stringify(tool.headers || {})} ${tool.body_template || ""}`),
    sentHeaderNames,
    bodyBytes,
    bodyDigest: sha256(body),
    request: errors.length ? null : {
      url, method, origin,
      headers: {
        "user-agent": "COGNOS-Tool/1.0",
        "content-type": "application/json",
        ...headerCheck.values,
        "x-cognos-tool-id": String(tool.id),
      },
      body,
    },
    redacted,
  };
}

/**
 * Tool header validation: the webhook allowlist, plus x-api-key (the standard
 * custom-key header). Values render {{secret:NAME}} at send time.
 */
function checkToolHeaders(headers, { args = {}, secrets = {}, redactSecrets = false } = {}) {
  const source = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  const errors = [];
  const names = [];
  const values = {};
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = String(rawName || "").trim().toLowerCase();
    if (!name) { errors.push("a header name is empty"); continue; }
    const allowed = name === "x-api-key" || isAllowedHeaderName(name);
    if (!allowed) {
      // checkWebhookHeaders would refuse x-api-key; allow it here, but keep
      // every other refusal (authorization, cookie, reserved x-cognos-*).
      const probe = checkWebhookHeaders({ [name]: "x" });
      if (!probe.ok) { errors.push(`header '${name}': ${probe.errors[0]}`); continue; }
    }
    let rendered;
    try { rendered = renderTemplate(String(rawValue ?? ""), { args, secrets, redactSecrets }); }
    catch (e) { errors.push(`header '${name}': ${e.message}`); continue; }
    if (!rendered.trim()) { errors.push(`header '${name}' must be a non-empty string`); continue; }
    if (rendered.length > 2000) { errors.push(`header '${name}' is over 2000 characters`); continue; }
    if (/[\u0000-\u001F\u007F]/.test(rendered)) { errors.push(`header '${name}' contains a control character`); continue; }
    names.push(name);
    values[name] = rendered.trim();
  }
  return { ok: errors.length === 0, errors, names: names.sort(), values };
}

// ---------------------------------------------------------------------------
// The sender: DNS-pinned, redirect-re-validated, one bounded retry.
// Mirrors deliverWebhook's safety; the method comes from the tool definition.
// ---------------------------------------------------------------------------

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (ms <= 0) return resolve();
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error("cancelled"), { name: "AbortError" })); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

export async function deliverToolRequest(request, {
  timeoutMs = 10_000,
  maxRedirects = 2,
  retryStatuses = [429, 502, 503, 504],
  maxRetryDelayMs = 2_000,
  maxResponseBytes = 65_536,
  digestBytes = 4_096,
  signal = null,
  transport = null,
  resolve = null,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  const send = transport || pinnedTransport;
  let current = String(request.url || "");
  let redirects = 0;
  let attempts = 0;
  let retried = false;
  let last = null;

  for (;;) {
    const shaped = checkWebhookUrl(current);
    if (!shaped.ok) throw Object.assign(new Error(shaped.reason), { rule: "UNSAFE_URL", attempts, redirects });
    const records = await resolvePublicHosts(shaped.hostname, { resolve });
    attempts += 1;
    let response;
    try {
      response = await send({
        url: shaped.url.href,
        method: request.method || "GET",
        headers: request.headers,
        body: request.body || "",
        records,
        timeoutMs,
        signal,
        maxResponseBytes,
      });
    } catch (error) {
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
        throw Object.assign(new Error(`the tool redirected more than ${maxRedirects} time(s)`),
          { rule: "UNSAFE_URL", attempts, redirects });
      }
      redirects += 1;
      try { current = new URL(String(location), shaped.url).href; }
      catch {
        throw Object.assign(new Error("the tool redirect target does not parse"),
          { rule: "UNSAFE_URL", attempts, redirects });
      }
      continue;
    }
    if (retryStatuses.includes(response.status) && !retried) {
      retried = true;
      await sleep(Math.min(maxRetryDelayMs, 250), signal);
      continue;
    }
    break;
  }

  const { response, url } = last;
  const raw = response.body || Buffer.alloc(0);
  return {
    status: response.status,
    statusText: String(response.statusText || "").slice(0, 80),
    accepted: response.status >= 200 && response.status < 300,
    latencyMs: now() - startedAt,
    attempts,
    redirects,
    retried,
    url,
    // Metadata + a bounded excerpt for the resident to read. The excerpt is
    // returned, never stored: the run log keeps the digest and the char
    // count, like every other receipt in this system.
    excerpt: raw.subarray(0, Math.min(raw.length, EXCERPT_CHARS)).toString("utf8"),
    excerptChars: Math.min(raw.length, EXCERPT_CHARS),
    responseBodyDigest: sha256(raw.subarray(0, Math.max(0, digestBytes))),
    responseBytes: Number(response.bytes ?? raw.length),
    responseTruncated: response.truncated === true,
    sentAt: new Date(startedAt).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

function checkArgs(args) {
  if (args === undefined || args === null) return null;
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object of name → value";
  const keys = Object.keys(args);
  if (keys.length > 50) return "over 50 arguments — trim it down";
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) return `argument name '${k.slice(0, 40)}' isn't allowed`;
    const v = args[k];
    if (v === undefined || v === null || typeof v === "object") return `argument '${k}' must be a string, number, or boolean`;
    if (String(v).length > 2000) return `argument '${k}' is over 2000 characters`;
  }
  return null;
}

/** The run row never carries bodies, secrets, or query strings. */
async function logRun(db, base, patch = {}) {
  return db.ResidentTool.recordRun({ ...base, ...patch });
}

/**
 * Invoke a tool as a resident. Reads run freely; writes stage an approval in
 * the outbox and wait for Jeremy. The kill switch and the assignment are
 * checked before anything else, every time.
 */
export async function invokeTool({
  db, toolId, agentId, goalId = null, args = {},
  config = null, signal = null, invokedBy = "resident",
  // Test-only seams (like deliverWebhook's): a stub transport / resolver.
  transport = null, resolve = null,
} = {}) {
  // --- the master switch halts tools, not just chat and work ---------------
  if (!effectiveEnabled()) {
    return { ok: false, code: "killed", message: "Autonomy is off — the master switch is down, so nothing ran." };
  }

  const ws = await db.Workspace.ensureDefault();
  const tool = await db.ResidentTool.get(toolId);
  if (!tool || tool.workspace_id !== ws.id) {
    return { ok: false, code: "not_found", message: "I couldn't find that tool." };
  }
  const agent = await db.AutonomyAgent.get(agentId);
  if (!agent || agent.workspace_id !== ws.id) {
    return { ok: false, code: "not_found", message: "I couldn't find that resident." };
  }
  // Assignment is by slug: a brief change must not strand or grant tools.
  if (!(await db.ResidentTool.isAssigned(tool.id, agent.slug))) {
    return { ok: false, code: "not_assigned", message: `“${tool.name}” isn't one of ${agent.name}'s tools.` };
  }
  const argsError = checkArgs(args);
  if (argsError) return { ok: false, code: "bad_args", message: argsError };

  const runBase = {
    workspace_id: ws.id,
    tool_id: tool.id,
    tool_name: tool.name,
    agent_id: agent.id,
    agent_slug: agent.slug,
    goal_id: goalId,
    method: tool.method,
    url_origin: originOf(String(tool.url).replace(PLACEHOLDER_RE, "x")) || "(unknown)",
  };

  // --- email tools are ALWAYS writes: stage an approval, never auto-send ----
  if (toolKind(tool) === "email") {
    const built = buildEmailRequest(tool, { args });
    const emailBase = { ...runBase, method: "POST", url_origin: emailOrigin(built.to) };
    if (!built.ok) {
      await logRun(db, emailBase, { status: "failed", error: built.errors[0] });
      return { ok: false, code: "bad_request", message: built.errors[0] };
    }
    const argsDigest = sha256(JSON.stringify(canonicalize(args || {})));
    const { row, deduplicated } = await stageEffect({
      db,
      workspaceId: ws.id,
      agentId: agent.id,
      goalId,
      skillId: "tool.invoke",
      effectType: "tool_call",
      tier: "T4",
      payload: {
        kind: "email",
        toolId: tool.id,
        toolName: tool.name,
        agentSlug: agent.slug,
        method: "POST",
        to: built.to,
        subject: built.subject,
        args: args || {},
        preview: built.redacted, // to/subject/body excerpt — no secrets exist
        body_chars: built.redacted.bodyBytes,
        body_digest: built.bodyDigest,
      },
      mode: config?.outboxMode || "shadow",
      destination: emailOrigin(built.to),
      keyPayload: { kind: "email", toolId: tool.id, goalId: goalId || null, args: argsDigest },
    });
    const run = await logRun(db, {
      ...emailBase,
      outbox_id: row.id,
      status: "awaiting_approval",
      request_digest: built.bodyDigest,
    });
    return {
      ok: true, staged: true, runId: run.id, outboxId: row.id,
      deduplicated: deduplicated === true,
      message: deduplicated
        ? `“${tool.name}” is already waiting for approval — nothing new was staged.`
        : `“${tool.name}” sends email, so it's waiting for Jeremy's approval in the inbox. Nothing was sent.`,
    };
  }

  // --- reads run freely ------------------------------------------------------
  if (tool.method === "GET") {
    const run = await logRun(db, runBase, { status: "staged" });
    const secrets = await db.ResidentTool.resolveSecrets(tool.id);
    const built = buildToolRequest(tool, { args, secrets });
    if (!built.ok) {
      await db.ResidentTool.updateRun(run.id, { status: "failed", error: built.errors[0] });
      return { ok: false, code: "bad_request", message: built.errors[0], runId: run.id };
    }
    await db.ResidentTool.updateRun(run.id, {
      url_origin: built.origin, request_digest: built.bodyDigest,
    });
    const started = Date.now();
    try {
      const receipt = await deliverToolRequest(built.request, {
        timeoutMs: Math.max(1000, Math.min(60_000, Number(tool.timeout_ms) || 10_000)),
        signal, transport: transport || undefined, resolve: resolve || undefined,
      });
      await db.ResidentTool.updateRun(run.id, {
        status: "succeeded",
        status_code: receipt.status,
        latency_ms: receipt.latencyMs,
        response_digest: receipt.responseBodyDigest,
        response_chars: receipt.responseBytes,
      });
      return {
        ok: receipt.accepted, runId: run.id,
        status: receipt.status, statusText: receipt.statusText,
        output: receipt.excerpt, outputChars: receipt.excerptChars,
        truncated: receipt.responseTruncated,
        message: receipt.accepted
          ? `“${tool.name}” answered ${receipt.status}.`
          : `“${tool.name}” answered ${receipt.status} — the run log has the details.`,
      };
    } catch (error) {
      const msg = clean(error?.message || String(error), 200);
      await db.ResidentTool.updateRun(run.id, {
        status: "failed", latency_ms: Date.now() - started, error: msg,
      });
      return { ok: false, code: "failed", message: `“${tool.name}” failed: ${msg}`, runId: run.id };
    }
  }

  // --- writes stage an approval; nothing is sent until Jeremy says so -------
  const secrets = await db.ResidentTool.resolveSecrets(tool.id);
  const built = buildToolRequest(tool, { args, secrets });
  if (!built.ok) {
    await logRun(db, runBase, { status: "failed", url_origin: "(unset)", error: built.errors[0] });
    return { ok: false, code: "bad_request", message: built.errors[0] };
  }
  const argsDigest = sha256(JSON.stringify(canonicalize(args || {})));
  const { row, deduplicated } = await stageEffect({
    db,
    workspaceId: ws.id,
    agentId: agent.id,
    goalId,
    skillId: "tool.invoke",
    effectType: "tool_call",
    tier: "T4",
    payload: {
      toolId: tool.id,
      toolName: tool.name,
      agentSlug: agent.slug,
      method: tool.method,
      url_template: tool.url,
      url_origin: built.origin,
      args: args || {},
      header_names: built.sentHeaderNames,
      secret_refs: built.secretRefs,
      preview: built.redacted, // secrets as ••• — safe to store and show
      body_chars: built.bodyBytes,
      body_digest: built.bodyDigest,
    },
    mode: config?.outboxMode || "shadow",
    destination: built.origin,
    keyPayload: { toolId: tool.id, goalId: goalId || null, args: argsDigest },
  });
  const run = await logRun(db, {
    ...runBase,
    url_origin: built.origin,
    outbox_id: row.id,
    status: "awaiting_approval",
    request_digest: built.bodyDigest,
  });
  return {
    ok: true, staged: true, runId: run.id, outboxId: row.id,
    deduplicated: deduplicated === true,
    message: deduplicated
      ? `“${tool.name}” is already waiting for approval — nothing new was staged.`
      : `“${tool.name}” is a write, so it's waiting for Jeremy's approval in the inbox. Nothing was sent.`,
  };
}

/**
 * The outbox executor for native email tools. Runs only after a live verdict —
 * a per-effect human approval row names this exact outbox id, and the
 * approval is hash-bound to the exact recipients, subject, and body. The
 * kill switch and the assignment were re-verified by the caller before this
 * branch. Delivery goes through the COGNOS Gmail account (the same SMTP path
 * as the Daily Insights digest): one send per recipient.
 */
async function performEmailEffect({ db, effect, tool, payload: p, started, failRun, mailer = null }) {
  if (p.kind !== "email" || p.method !== "POST") {
    await failRun("refused", "The staged payload doesn't match the email tool's definition.");
    throw new Error("the staged payload doesn't match the email tool's definition — refusing");
  }

  const built = buildEmailRequest(tool, { args: p.args || {} });
  if (!built.ok) {
    await failRun("failed", built.errors[0]);
    throw new Error(`the approved email could not be rebuilt: ${built.errors[0]}`);
  }
  // The approval named exact recipients; a re-render that lands elsewhere
  // dies here — the email analog of the HTTPS destination check.
  if (JSON.stringify(built.to) !== JSON.stringify(p.to || [])) {
    await failRun("refused", "The email recipients changed after approval.");
    throw new Error("the email recipients changed since approval — refusing");
  }

  const wsId = effect.workspace_id || (await db.Workspace.ensureDefault()).id;
  const creds = await getSendCredentials(db, wsId);
  if (!creds?.password) {
    await failRun("failed", "The COGNOS Gmail isn't set up.");
    throw new Error(
      creds?.decryptError
        ? "the stored Gmail app password couldn't be decrypted — re-enter it under Settings → Daily Insights email, then approve again"
        : "the COGNOS Gmail isn't set up — add the address and app password under Settings → Daily Insights email, then approve again"
    );
  }

  const send = mailer || (({ to, subject, body }) => sendMail({
    host: "smtp.gmail.com",
    port: 465,
    user: creds.address,
    pass: creds.password,
    from: creds.address,
    to,
    subject,
    text: body,
  }));

  try {
    for (const rcpt of built.to) {
      await send({ to: rcpt, subject: built.subject, body: built.body });
    }
  } catch (error) {
    const msg = clean(error?.message || String(error), 200);
    await failRun("failed", msg);
    throw error;
  }

  const runs = await db.ResidentTool.runsForTool(p.toolId, 5);
  const run = (runs || []).find((r) => r.outbox_id === effect.id);
  if (run) {
    await db.ResidentTool.updateRun(run.id, {
      status: "succeeded",
      latency_ms: Date.now() - started,
      response_digest: built.bodyDigest,
      response_chars: built.redacted.bodyBytes,
    });
  }

  return {
    // Metadata only. The body is digested, never stored — like every receipt
    // in this system.
    receipt: {
      toolId: tool.id,
      toolName: tool.name,
      kind: "email",
      method: "POST",
      from: creds.address,
      to: built.to,
      subject: built.subject.slice(0, SUBJECT_CAP_CHARS),
      bodyDigest: built.bodyDigest,
      bodyChars: built.redacted.bodyBytes,
      effectId: effect.id,
    },
    output: {
      delivered: true,
      accepted: true,
      to: built.to,
      effectId: effect.id,
      note: "the email was sent from the COGNOS Gmail account",
    },
  };
}

/**
 * The outbox executor for tool_call effects. Runs only after a live verdict —
 * which for a write means a per-effect human approval row names this exact
 * outbox id (the same story as T5). Re-verifies the kill switch and the
 * assignment at send time: an approval must not outlive either.
 */
export async function performToolEffect({ db, effect, config = null, signal = null,
  // Test-only seams, like deliverWebhook's.
  transport = null, resolve = null,
  // Test-only seam for email tools: async ({ to, subject, body }) => void.
  // Production sends through the COGNOS Gmail account below.
  mailer = null } = {}) {
  const p = effect.payload || {};
  const started = Date.now();

  const failRun = async (status, error) => {
    try {
      const runs = await db.ResidentTool.runsForTool(p.toolId, 5);
      const run = (runs || []).find((r) => r.outbox_id === effect.id);
      if (run) await db.ResidentTool.updateRun(run.id, { status, error, latency_ms: Date.now() - started });
    } catch { /* logging must never fail the effect */ }
  };

  if (!effectiveEnabled()) {
    await failRun("refused", "Autonomy is off — the master switch is down.");
    throw new Error("autonomy is off — the master switch is down, so the approved tool call was not sent");
  }

  const agent = effect.agent_id ? await db.AutonomyAgent.get(effect.agent_id) : null;
  const slug = p.agentSlug || agent?.slug;
  if (!agent || !slug || !(await db.ResidentTool.isAssigned(p.toolId, slug))) {
    await failRun("refused", "The tool is no longer assigned to this resident.");
    throw new Error("the tool is no longer assigned to this resident — the approval died with the assignment");
  }

  const tool = await db.ResidentTool.getWithSecrets(p.toolId);
  if (!tool) {
    await failRun("failed", "The tool was deleted after approval.");
    throw new Error("the tool was deleted after it was approved");
  }
  if (tool.method !== p.method) {
    await failRun("refused", "The tool's method changed after approval.");
    throw new Error("the tool's method changed since approval — refusing");
  }

  // --- email tools deliver through the COGNOS Gmail account ------------------
  if (toolKind(tool) === "email") {
    return performEmailEffect({ db, effect, tool, payload: p, started, failRun, mailer });
  }

  const built = buildToolRequest(tool, { args: p.args || {}, secrets: tool.secrets });
  if (!built.ok) {
    await failRun("failed", built.errors[0]);
    throw new Error(`the approved tool call could not be rebuilt: ${built.errors[0]}`);
  }
  if (built.origin !== p.url_origin) {
    await failRun("refused", "The tool's destination changed after approval.");
    throw new Error("the tool's destination changed since approval — refusing");
  }

  let receipt;
  try {
    receipt = await deliverToolRequest(built.request, {
      timeoutMs: Math.max(1000, Math.min(60_000, Number(tool.timeout_ms) || 10_000)),
      signal, transport: transport || undefined, resolve: resolve || undefined,
    });
  } catch (error) {
    const msg = clean(error?.message || String(error), 200);
    await failRun("failed", msg);
    throw error;
  }

  const runs = await db.ResidentTool.runsForTool(p.toolId, 5);
  const run = (runs || []).find((r) => r.outbox_id === effect.id);
  if (run) {
    await db.ResidentTool.updateRun(run.id, {
      status: "succeeded",
      status_code: receipt.status,
      latency_ms: receipt.latencyMs,
      response_digest: receipt.responseBodyDigest,
      response_chars: receipt.responseBytes,
    });
  }

  return {
    // Metadata only, like every receipt in this system. The response body is
    // digested and discarded — an endpoint echoing a credential must not write
    // it into the ledger.
    receipt: {
      toolId: tool.id,
      toolName: tool.name,
      method: built.request.method,
      urlOrigin: built.origin,
      status: receipt.status,
      statusText: receipt.statusText,
      accepted: receipt.accepted,
      attempts: receipt.attempts,
      redirects: receipt.redirects,
      latencyMs: receipt.latencyMs,
      sentHeaderNames: built.sentHeaderNames,
      secretRefs: built.secretRefs,
      bodyDigest: built.bodyDigest,
      responseDigest: receipt.responseBodyDigest,
      responseChars: receipt.responseBytes,
      effectId: effect.id,
    },
    output: {
      delivered: receipt.accepted,
      accepted: receipt.accepted,
      status: receipt.status,
      urlOrigin: built.origin,
      attempts: receipt.attempts,
      effectId: effect.id,
      note: receipt.accepted ? "the tool call was delivered" : `delivered; the receiver answered ${receipt.status}`,
    },
  };
}
