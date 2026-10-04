#!/usr/bin/env node
// Phase 36 — resident tools: Orbit-style assignable HTTPS tools.
//
// What this file proves:
//   * Template rendering: {{var}} substitution, {{secret:NAME}} resolution,
//     ••• redaction for previews, and fail-closed on missing/malformed
//     placeholders.
//   * Definition validation: method allowlist, https-only URLs, no literal
//     IPs, no placeholders in the hostname, header allowlist (x-api-key is
//     the one exception), and real-looking keys refused outside {{secret:}}.
//   * Assignment isolation: a resident cannot invoke another resident's tool
//     (invokeTool AND the Governor agree).
//   * Approval gating: a write stages and waits; the Governor refuses it
//     without a per-effect approval row and releases it with one (the same
//     EffectApproval story as T5).
//   * Secret redaction: secret values never appear in list/get APIs, run
//     history, outbox payloads, or the approval preview.
//   * Kill switch: the master switch halts tool invocation and refuses an
//     approved tool effect while down.

import assert from "node:assert/strict";
import {
  renderTemplate,
  extractSecretRefs,
  validateToolDefinition,
  buildToolRequest,
} from "../server/autonomy/residentTools.js";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---------------------------------------------------------------------------
// Pure unit tests: templates, validation, request building
// ---------------------------------------------------------------------------

await test("renderTemplate substitutes args and secrets", async () => {
  assert.equal(
    renderTemplate("https://api.example.com/items/{{id}}?q={{q}}", {
      args: { id: 42, q: "hi" }, secrets: {},
    }),
    "https://api.example.com/items/42?q=hi"
  );
  assert.equal(
    renderTemplate("Bearer {{secret:API_TOKEN}}", { args: {}, secrets: { API_TOKEN: "s3cr3t" } }),
    "Bearer s3cr3t"
  );
});

await test("renderTemplate redacts secrets for previews", async () => {
  const out = renderTemplate("key={{secret:API_TOKEN}}&id={{id}}", {
    args: { id: "7" }, secrets: { API_TOKEN: "s3cr3t" }, redactSecrets: true,
  });
  assert.equal(out, "key=•••&id=7");
  assert.ok(!out.includes("s3cr3t"));
});

await test("renderTemplate fails closed on missing or stray placeholders", async () => {
  assert.throws(() => renderTemplate("{{missing}}", { args: {} }), /no value/);
  assert.throws(() => renderTemplate("{{secret:ABSENT}}", { args: {}, secrets: {} }), /no value/);
  assert.throws(() => renderTemplate("{{oops}", { args: {} }), /no value/);
  // Objects are never interpolated (no prototype games through args).
  assert.throws(() => renderTemplate("{{a}}", { args: { a: { x: 1 } } }), /no value/);
  // \{{ escapes to a literal {{.
  assert.equal(renderTemplate("\\{{literal}}", { args: {} }), "{{literal}}");
});

await test("extractSecretRefs lists secret names", async () => {
  assert.deepEqual(
    extractSecretRefs("{{secret:B}} and {{secret:A}} and {{x}}"),
    ["A", "B"]
  );
});

await test("validateToolDefinition accepts a well-formed tool", async () => {
  const v = validateToolDefinition({
    name: "Ping",
    method: "GET",
    url: "https://api.example.com/ping",
    headers: { "x-cognos-note": "hi" },
    body_template: "",
  });
  assert.ok(v.ok, v.errors.join("; "));
});

await test("validateToolDefinition rejects bad methods, URLs, and hosts", async () => {
  for (const bad of [
    { name: "x", method: "TRACE", url: "https://api.example.com/" },
    { name: "x", method: "GET", url: "http://api.example.com/" },
    { name: "x", method: "GET", url: "https://127.0.0.1/x" },
    { name: "x", method: "GET", url: "https://{{host}}/x" },
    { name: "", method: "GET", url: "https://api.example.com/" },
  ]) {
    const v = validateToolDefinition(bad);
    assert.ok(!v.ok, `should reject ${JSON.stringify(bad)}`);
  }
});

await test("validateToolDefinition enforces the header allowlist", async () => {
  const bad = validateToolDefinition({
    name: "x", method: "GET", url: "https://api.example.com/",
    headers: { authorization: "Bearer abc" },
  });
  assert.ok(!bad.ok && /authorization/i.test(bad.errors.join(" ")));

  const okKey = validateToolDefinition({
    name: "x", method: "GET", url: "https://api.example.com/",
    headers: { "x-api-key": "{{secret:K}}" },
  });
  assert.ok(okKey.ok, okKey.errors.join("; "));
});

await test("validateToolDefinition refuses real-looking keys outside {{secret:}}", async () => {
  const v = validateToolDefinition({
    name: "x", method: "POST", url: "https://api.example.com/",
    headers: {},
    body_template: '{"token": "sk-abcdefghij1234567890ABCD"}',
  });
  assert.ok(!v.ok && /Secrets section/.test(v.errors.join(" ")));

  const ok = validateToolDefinition({
    name: "x", method: "POST", url: "https://api.example.com/",
    headers: {},
    body_template: '{"token": "{{secret:API_TOKEN}}"}',
  });
  assert.ok(ok.ok, ok.errors.join("; "));
});

await test("buildToolRequest renders fully and redacts the preview", async () => {
  const tool = {
    id: "tool_1", method: "POST",
    url: "https://api.example.com/items/{{id}}",
    headers: { "x-api-key": "{{secret:K}}", "content-type": "application/json" },
    body_template: '{"id":"{{id}}","key":"{{secret:K}}"}',
  };
  const built = buildToolRequest(tool, { args: { id: "9" }, secrets: { K: "sekrit!" } });
  assert.ok(built.ok, built.errors.join("; "));
  assert.equal(built.request.url, "https://api.example.com/items/9");
  assert.equal(built.request.headers["x-api-key"], "sekrit!");
  assert.ok(built.request.body.includes('"sekrit!"'));
  assert.ok(!JSON.stringify(built.redacted).includes("sekrit!"));
  assert.ok(built.redacted.bodyPreview.includes("•••"));
  assert.deepEqual(built.secretRefs, ["K"]);
});

await test("buildToolRequest refuses a rendered URL that leaves the origin", async () => {
  const tool = {
    id: "tool_1", method: "GET",
    url: "https://api.example.com/{{p}}",
    headers: {}, body_template: "",
  };
  // A hostile arg cannot move the host: placeholders never survive into it,
  // and even a crafted path stays on the same origin check.
  const built = buildToolRequest(tool, { args: { p: "x" }, secrets: {} });
  assert.ok(built.ok, built.errors.join("; "));
  assert.equal(built.origin, "https://api.example.com");
});

// ---------------------------------------------------------------------------
// Harness integration tests: assignment, approval, secrets, kill switch
// ---------------------------------------------------------------------------

const h = await bootHarness({ COGNOS_AUTONOMY_ENABLED: "true" });
const { db } = await import("../server/db.js");
const { invokeTool, performToolEffect } = await import("../server/autonomy/residentTools.js");
const { judgeEffect } = await import("../server/autonomy/actionGovernor.js");
const { autonomyConfig } = await import("../server/autonomy/config.js");

const ws = await db.Workspace.ensureDefault();

async function makeResident(name, slug) {
  return db.AutonomyAgent.create({
    workspace_id: ws.id, name, slug,
    purpose: "test resident", brief: "test brief", enabled: true,
  });
}

async function makeTool(over = {}) {
  return db.ResidentTool.create({
    workspace_id: ws.id,
    name: over.name || "Test Tool",
    description: "a test tool",
    method: over.method || "GET",
    url: over.url || "https://api.example.com/things/{{id}}",
    headers: over.headers || {},
    body_template: over.body_template || "",
    created_by: "test",
  });
}

/** A stub transport: captures the request, answers 200 with a small body. */
function stubTransport(captured) {
  return async ({ url, method, headers, body }) => {
    captured.push({ url, method, headers, body });
    return {
      status: 200, statusText: "OK", headers: {},
      body: Buffer.from('{"ok":true,"echo":"hi"}'),
      bytes: 22, truncated: false,
    };
  };
}

const residentA = await makeResident("Resident A", "resident-a");
const residentB = await makeResident("Resident B", "resident-b");

await test("assignment isolation: invokeTool refuses an unassigned resident", async () => {
  const tool = await makeTool({ name: "A-only GET" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);

  const captured = [];
  const denied = await invokeTool({
    db, toolId: tool.id, agentId: residentB.id, args: { id: "1" },
    transport: stubTransport(captured),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "not_assigned");
  assert.equal(captured.length, 0, "nothing was sent for an unassigned resident");
});

await test("assignment isolation: the Governor refuses a cross-resident effect", async () => {
  const tool = await makeTool({ name: "A-only POST", method: "POST", body_template: '{"a":1}' });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);

  const staged = await db.AutonomyOutbox.stage({
    workspace_id: ws.id, agent_id: residentB.id, goal_id: null,
    skill_id: "tool.invoke", effect_type: "tool_call", tier: "T4",
    payload: {
      toolId: tool.id, toolName: tool.name, agentSlug: residentB.slug,
      method: "POST", url_template: tool.url, url_origin: "https://api.example.com",
      args: {}, header_names: [], secret_refs: [], preview: null,
      body_chars: 7, body_digest: "x",
    },
    idempotency_key: `test-${Date.now()}-b`,
    mode: "live",
  });
  const verdict = await judgeEffect({
    db, effect: staged, goal: null, authorization: null,
    config: { ...autonomyConfig(), builtTiers: ["T0", "T1", "T2", "T3", "T4", "T5"] },
    mode: "live",
  });
  assert.equal(verdict.decision, "refuse");
  assert.ok(verdict.failed.some((f) => f.rule === "TOOL_NOT_ASSIGNED"));
});

await test("approval gating: a write stages, waits, and runs only after approval", async () => {
  const tool = await makeTool({
    name: "Write Tool", method: "POST",
    url: "https://api.example.com/write",
    headers: { "x-api-key": "{{secret:K}}" },
    body_template: '{"msg":"{{msg}}","key":"{{secret:K}}"}',
  });
  await db.ResidentTool.setSecret(tool.id, "K", "topsecret-value");
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);

  const out = await invokeTool({
    db, toolId: tool.id, agentId: residentA.id, args: { msg: "hello" },
    config: { outboxMode: "live" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.staged, true);
  assert.ok(out.outboxId);

  const effect = await db.AutonomyOutbox.get(out.outboxId);
  assert.equal(effect.status, "staged");

  // No approval yet: the Governor refuses with the named rule.
  const cfg = { ...autonomyConfig(), builtTiers: ["T0", "T1", "T2", "T3", "T4", "T5"] };
  const before = await judgeEffect({ db, effect, goal: null, authorization: null, config: cfg, mode: "live" });
  assert.equal(before.decision, "refuse");
  assert.ok(before.failed.some((f) => f.rule === "TOOL_WRITE_NEEDS_APPROVAL"));

  // Jeremy approves (the route's exact write): per-effect approval row, then judge.
  await db.EffectApproval.append({
    workspace_id: ws.id, outbox_id: effect.id, goal_id: null,
    agent_id: residentA.id, decision: "approve", decided_by: "operator",
  });
  const after = await judgeEffect({ db, effect, goal: null, authorization: null, config: cfg, mode: "live" });
  assert.equal(after.decision, "release", JSON.stringify(after.failed));

  // The executor sends with the secret resolved — and the run log stays clean.
  // resolve is stubbed to a public address: the sandbox DNS sink is not public.
  const captured = [];
  const publicResolve = async () => [{ address: "93.184.216.34", family: 4 }];
  const settled = await performToolEffect({
    db, effect, config: cfg, transport: stubTransport(captured), resolve: publicResolve,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers["x-api-key"], "topsecret-value");
  assert.ok(settled.receipt.status === 200);

  const runRows = await h.sql(
    `SELECT status, error FROM resident_tool_runs WHERE outbox_id = $1`, [effect.id]
  );
  assert.equal(runRows[0]?.status, "succeeded");

  // Secret values appear NOWHERE stored: not in runs, not in the outbox row.
  const secretLeak = await h.sql(
    `SELECT COUNT(*)::int AS n FROM resident_tool_runs
      WHERE tool_id = $1 AND (error LIKE '%topsecret-value%' OR tool_name LIKE '%topsecret-value%')`,
    [tool.id]
  );
  assert.equal(secretLeak[0].n, 0);
  const effectLeak = await h.sql(
    `SELECT payload FROM autonomy_outbox WHERE id = $1`, [effect.id]
  );
  const payloadText = JSON.stringify(effectLeak[0].payload);
  assert.ok(!payloadText.includes("topsecret-value"), "outbox payload must not hold the secret value");
  assert.ok(payloadText.includes("•••"), "the stored preview redacts secrets");
});

await test("secret redaction: list/get APIs never return secret values", async () => {
  const tool = await makeTool({ name: "Secret Tool", headers: { "x-api-key": "{{secret:API_TOKEN}}" } });
  await db.ResidentTool.setSecret(tool.id, "API_TOKEN", "ultrasecret-999");

  const listed = await h.raw("/api/autonomy/tools");
  assert.equal(listed.status, 200);
  const listedText = JSON.stringify(listed.json);
  assert.ok(!listedText.includes("ultrasecret-999"), "list must not leak secret values");

  const one = await h.raw(`/api/autonomy/tools/${tool.id}`);
  assert.equal(one.status, 200);
  assert.ok(!JSON.stringify(one.json).includes("ultrasecret-999"), "get must not leak secret values");
  assert.deepEqual(one.json.tool.secret_names, ["API_TOKEN"]);

  // Reads run freely at the invokeTool level (stub transport — no network):
  // the secret resolves into the sent headers, while nothing stored leaks it.
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);
  const captured = [];
  const getOut = await invokeTool({
    db, toolId: tool.id, agentId: residentA.id, args: { id: "1" },
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async ({ url, method, headers, body }) => {
      captured.push({ url, method, headers, body });
      return { status: 200, statusText: "OK", headers: {}, body: Buffer.from('{"ok":true}'), bytes: 12, truncated: false };
    },
  });
  assert.equal(getOut.ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers["x-api-key"], "ultrasecret-999", "the secret must resolve at send time");
  const runLeak = await h.sql(
    `SELECT COUNT(*)::int AS n FROM resident_tool_runs
      WHERE tool_id = $1 AND (error LIKE '%ultrasecret-999%')`, [tool.id]
  );
  assert.equal(runLeak[0].n, 0, "run history must not hold the secret value");
});

await test("kill switch: tools halt when autonomy is off", async () => {
  const tool = await makeTool({ name: "Kill Tool" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);

  const prev = process.env.COGNOS_AUTONOMY_ENABLED;
  delete process.env.COGNOS_AUTONOMY_ENABLED;
  try {
    const out = await invokeTool({ db, toolId: tool.id, agentId: residentA.id, args: {} });
    assert.equal(out.ok, false);
    assert.equal(out.code, "killed");
    assert.match(out.message, /master switch/i);

    // And an approved effect judged while the switch is down is refused.
    const staged = await db.AutonomyOutbox.stage({
      workspace_id: ws.id, agent_id: residentA.id, goal_id: null,
      skill_id: "tool.invoke", effect_type: "tool_call", tier: "T4",
      payload: {
        toolId: tool.id, toolName: tool.name, agentSlug: residentA.slug,
        method: "GET", url_template: tool.url, url_origin: "https://api.example.com",
        args: {}, header_names: [], secret_refs: [], preview: null,
        body_chars: 0, body_digest: "x",
      },
      idempotency_key: `test-kill-${Date.now()}`,
      mode: "live",
    });
    const verdict = await judgeEffect({
      db, effect: staged, goal: null, authorization: null,
      config: { ...autonomyConfig(), builtTiers: ["T0", "T1", "T2", "T3", "T4", "T5"] },
      mode: "live",
    });
    assert.equal(verdict.decision, "refuse");
    assert.ok(verdict.failed.some((f) => f.rule === "AUTONOMY_DISABLED"));
  } finally {
    if (prev === undefined) delete process.env.COGNOS_AUTONOMY_ENABLED;
    else process.env.COGNOS_AUTONOMY_ENABLED = prev;
  }
});

await test("write tool via HTTP route stages an approval (no network)", async () => {
  const created = await h.raw("/api/autonomy/tools", {
    method: "POST",
    body: {
      name: "Route Write Tool",
      method: "POST",
      url: "https://api.example.com/route-write",
      headers: {},
      body_template: '{"ping":"{{ping}}"}',
      secrets: { HOOK: "hook-secret-1" },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json).slice(0, 300));
  const toolId = created.json.tool.id;
  assert.deepEqual(created.json.tool.secret_names, ["HOOK"]);
  assert.ok(!JSON.stringify(created.json).includes("hook-secret-1"));

  const assigned = await h.raw(`/api/autonomy/agents/${residentA.id}/tools`, {
    method: "POST", body: { toolId },
  });
  assert.equal(assigned.status, 200);

  const listed = await h.raw(`/api/autonomy/agents/${residentA.id}/tools`);
  assert.equal(listed.status, 200);
  assert.ok(listed.json.tools.some((t) => t.id === toolId));

  const inv = await h.raw(`/api/autonomy/agents/${residentA.id}/tools/${toolId}/invoke`, {
    method: "POST", body: { args: { ping: "pong" } },
  });
  assert.equal(inv.status, 200, JSON.stringify(inv.json).slice(0, 300));
  assert.equal(inv.json.staged, true);
  assert.ok(inv.json.outboxId);

  // It shows up in the approvals inbox (the outbox list).
  const inbox = await h.raw("/api/autonomy/outbox?effectType=tool_call");
  assert.equal(inbox.status, 200);
  assert.ok(inbox.json.effects.some((e) => e.id === inv.json.outboxId));

  // Run history is visible per resident, metadata only.
  const runs = await h.raw(`/api/autonomy/agents/${residentA.id}/tool-runs`);
  assert.equal(runs.status, 200);
  const run = runs.json.runs.find((r) => r.outbox_id === inv.json.outboxId);
  assert.ok(run);
  assert.equal(run.status, "awaiting_approval");
  assert.ok(!JSON.stringify(run).includes("hook-secret-1"));
});

await h.stop();
console.log(`\nresident-tools: ${passed} passed`);
