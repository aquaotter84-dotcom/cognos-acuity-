#!/usr/bin/env node
// Phase 39 — native email tools for residents.
//
// What this file proves:
//   * Definition validation: name/to/body rules, recipient parsing (fixed,
//     {{to}} arg, comma-separated mix), malformed placeholders fail closed,
//     and {{secret:…}} is refused — email tools send from the COGNOS Gmail,
//     so Secrets are meaningless on them.
//   * Request building: args render into to/subject/body, invalid rendered
//     recipients fail closed, caps hold.
//   * Approval gating: invoking an email tool NEVER sends — it stages a
//     tool_call effect and waits. The Governor refuses it before a per-effect
//     approval row exists (TOOL_WRITE_NEEDS_APPROVAL) and releases it after.
//   * Delivery: after approval, performToolEffect sends through the COGNOS
//     Gmail account (stubbed mailer in tests), one send per recipient, and
//     the run log records success with metadata only.
//   * Safety: no Gmail configured → loud failure, nothing sent; recipients
//     changed after approval → refused; unassigned resident → refused; the
//     master kill switch halts invocation.
//   * Routes: create/get/patch round-trip the email kind; kind is immutable.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateEmailToolDefinition,
  buildEmailRequest,
  invokeTool,
  performToolEffect,
} from "../server/autonomy/residentTools.js";
import { bootHarness } from "./harness.mjs";
import { setCredentials } from "../server/insights/emailStore.js";
import { _resetVaultKeyCache } from "../server/autonomy/vault.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---------------------------------------------------------------------------
// Pure unit tests: validation and request building
// ---------------------------------------------------------------------------

await test("validateEmailToolDefinition accepts a fixed-address tool", async () => {
  const v = validateEmailToolDefinition({
    name: "Email me",
    description: "sends a note",
    to_template: "aquaotter84@gmail.com",
    subject_template: "hello",
    body_template: "hi there",
  });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

await test("validateEmailToolDefinition accepts {{to}}/{{subject}}/{{body}} args", async () => {
  const v = validateEmailToolDefinition({
    name: "Emailer",
    to_template: "{{to}}",
    subject_template: "{{subject}}",
    body_template: "{{body}}",
  });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

await test("validateEmailToolDefinition accepts a comma-separated mix", async () => {
  const v = validateEmailToolDefinition({
    name: "Emailer",
    to_template: "{{to}}, backup@example.com",
    subject_template: "",
    body_template: "x",
  });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

await test("validateEmailToolDefinition rejects bad input plainly", async () => {
  let v = validateEmailToolDefinition({ name: "", to_template: "a@b.c", body_template: "x" });
  assert.equal(v.ok, false);
  assert.ok(v.errors[0].includes("name"));

  v = validateEmailToolDefinition({ name: "E", to_template: "", body_template: "x" });
  assert.equal(v.ok, false);
  assert.ok(v.errors[0].includes("recipient"));

  v = validateEmailToolDefinition({ name: "E", to_template: "not-an-address", body_template: "x" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("doesn't look like an email address")));

  v = validateEmailToolDefinition({ name: "E", to_template: "a@b.c", body_template: "   " });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("body")));

  v = validateEmailToolDefinition({ name: "E", to_template: "{{to}", body_template: "x" });
  assert.equal(v.ok, false, "malformed placeholder fails closed");

  v = validateEmailToolDefinition({
    name: "E", to_template: "a@b.c", subject_template: "{{secret:S}}", body_template: "x",
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("don't use {{secret:")), JSON.stringify(v.errors));
});

await test("buildEmailRequest renders args and fails closed on bad recipients", async () => {
  const tool = {
    kind: "email",
    to_template: "{{to}}",
    subject_template: "Re: {{subject}}",
    body_template: "Hi,\n{{body}}",
  };
  const good = buildEmailRequest(tool, { args: { to: "pal@example.com", subject: "news", body: "it happened" } });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.deepEqual(good.to, ["pal@example.com"]);
  assert.equal(good.subject, "Re: news");
  assert.ok(good.body.includes("it happened"));
  assert.ok(good.redacted.bodyDigest);
  assert.equal(good.redacted.to[0], "pal@example.com");

  const bad = buildEmailRequest(tool, { args: { to: "bogus", subject: "s", body: "b" } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors[0].includes("doesn't look like an email address"));

  const missing = buildEmailRequest(tool, { args: { subject: "s", body: "b" } });
  assert.equal(missing.ok, false, "missing {{to}} fails closed");

  const multi = buildEmailRequest(
    { ...tool, to_template: "a@x.co, {{to}}" },
    { args: { to: "b@y.co", subject: "s", body: "b" } }
  );
  assert.equal(multi.ok, true, JSON.stringify(multi.errors));
  assert.deepEqual(multi.to, ["a@x.co", "b@y.co"]);
});

// ---------------------------------------------------------------------------
// Harness integration tests: routes, approval, delivery, kill switch
// ---------------------------------------------------------------------------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cognos-emailtools-test-"));
_resetVaultKeyCache();
const h = await bootHarness({ COGNOS_DATA_DIR: dataDir, COGNOS_AUTONOMY_ENABLED: "true" });
const { db } = await import("../server/db.js");
const { judgeEffect } = await import("../server/autonomy/actionGovernor.js");
const { autonomyConfig } = await import("../server/autonomy/config.js");

const ws = await db.Workspace.ensureDefault();

// The COGNOS Gmail account, as Jeremy configured it in Settings.
await setCredentials(db, ws.id, {
  email_address: "sogoth26@gmail.com",
  app_password: "abcd efgh ijkl mnop",
});

async function makeResident(name, slug) {
  return db.AutonomyAgent.create({
    workspace_id: ws.id, name, slug,
    purpose: "test resident", brief: "test brief", enabled: true,
  });
}

async function makeEmailTool(over = {}) {
  return db.ResidentTool.create({
    workspace_id: ws.id,
    kind: "email",
    name: over.name || "Test Emailer",
    description: "a test email tool",
    method: "POST",
    url: "",
    headers: {},
    to_template: over.to_template || "{{to}}",
    subject_template: over.subject_template || "{{subject}}",
    body_template: over.body_template || "{{body}}",
    created_by: "test",
  });
}

/** A stub mailer: captures sends, delivers nothing. */
function stubMailer(captured) {
  return async ({ to, subject, body }) => {
    captured.push({ to, subject, body });
    return { ok: true };
  };
}

const cfg = { ...autonomyConfig(), builtTiers: ["T0", "T1", "T2", "T3", "T4", "T5"] };
const residentA = await makeResident("Resident A", "resident-a");
const residentB = await makeResident("Resident B", "resident-b");

await test("routes: create/get/patch round-trip the email kind", async () => {
  const created = await h.raw("/api/autonomy/tools", {
    method: "POST",
    body: {
      kind: "email",
      name: "Route Emailer",
      description: "via routes",
      to_template: "{{to}}",
      subject_template: "Hi {{subject}}",
      body_template: "Body: {{body}}",
    },
  });
  assert.equal(created.status, 201, created.text?.slice(0, 200));
  const tool = created.json.tool;
  assert.equal(tool.kind, "email");
  assert.equal(tool.method, "POST");
  assert.equal(tool.to_template, "{{to}}");
  assert.equal(tool.subject_template, "Hi {{subject}}");

  const one = await h.raw(`/api/autonomy/tools/${tool.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.tool.kind, "email");

  const patched = await h.raw(`/api/autonomy/tools/${tool.id}`, {
    method: "PATCH",
    body: { subject_template: "Yo {{subject}}" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.tool.subject_template, "Yo {{subject}}");
  assert.equal(patched.json.tool.to_template, "{{to}}", "untouched fields survive");

  const badKind = await h.raw(`/api/autonomy/tools/${tool.id}`, {
    method: "PATCH",
    body: { kind: "https" },
  });
  assert.equal(badKind.status, 400, "kind is immutable");
  assert.ok(badKind.json.error.includes("can't change kind"));

  const badCreate = await h.raw("/api/autonomy/tools", {
    method: "POST",
    body: { kind: "email", name: "Bad", to_template: "nope", body_template: "x" },
  });
  assert.equal(badCreate.status, 400);
});

await test("routes: email tools refuse Secrets", async () => {
  const res = await h.raw("/api/autonomy/tools", {
    method: "POST",
    body: {
      kind: "email", name: "Secret Emailer",
      to_template: "a@b.co", body_template: "x",
      secrets: { KEY: "value" },
    },
  });
  assert.equal(res.status, 400);
  assert.ok(res.json.error.includes("don't use Secrets"));
});

await test("invoke stages an approval and never sends", async () => {
  const tool = await makeEmailTool({ name: "Stage Only" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);

  const sent = [];
  const out = await invokeTool({
    db, toolId: tool.id, agentId: residentA.id,
    args: { to: "pal@example.com", subject: "hello", body: "world" },
    config: { outboxMode: "live" },
    mailer: stubMailer(sent), // must not be touched: invoke never sends
  });
  assert.equal(out.ok, true);
  assert.equal(out.staged, true);
  assert.ok(out.outboxId);
  assert.equal(sent.length, 0, "invoke must never send email");

  const effect = await db.AutonomyOutbox.get(out.outboxId);
  assert.equal(effect.status, "staged");
  assert.equal(effect.payload.kind, "email");
  assert.deepEqual(effect.payload.to, ["pal@example.com"]);
  assert.equal(effect.payload.subject, "hello");
  assert.ok(!JSON.stringify(effect.payload).includes("mnop"), "no Gmail credential in the payload");
});

await test("Governor refuses before approval, releases after", async () => {
  const tool = await makeEmailTool({ name: "Governed" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);
  const out = await invokeTool({
    db, toolId: tool.id, agentId: residentA.id,
    args: { to: "pal@example.com", subject: "s", body: "b" },
    config: { outboxMode: "live" },
  });
  const effect = await db.AutonomyOutbox.get(out.outboxId);

  const before = await judgeEffect({ db, effect, goal: null, authorization: null, config: cfg, mode: "live" });
  assert.equal(before.decision, "refuse");
  assert.ok(before.failed.some((f) => f.rule === "TOOL_WRITE_NEEDS_APPROVAL"));

  await db.EffectApproval.append({
    workspace_id: ws.id, outbox_id: effect.id, goal_id: null,
    agent_id: residentA.id, decision: "approve", decided_by: "operator",
  });
  const after = await judgeEffect({ db, effect, goal: null, authorization: null, config: cfg, mode: "live" });
  assert.equal(after.decision, "release", JSON.stringify(after.failed));
});

await test("approved email sends from the COGNOS Gmail via stub mailer", async () => {
  const tool = await makeEmailTool({ name: "Sender" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);
  const out = await invokeTool({
    db, toolId: tool.id, agentId: residentA.id,
    args: { to: "pal@example.com, mate@example.com", subject: "news", body: "it happened" },
    config: { outboxMode: "live" },
  });
  const effect = await db.AutonomyOutbox.get(out.outboxId);
  await db.EffectApproval.append({
    workspace_id: ws.id, outbox_id: effect.id, goal_id: null,
    agent_id: residentA.id, decision: "approve", decided_by: "operator",
  });

  const sent = [];
  const settled = await performToolEffect({ db, effect, config: cfg, mailer: stubMailer(sent) });
  assert.equal(sent.length, 2, "one send per recipient");
  assert.equal(sent[0].to, "pal@example.com");
  assert.equal(sent[1].to, "mate@example.com");
  assert.equal(sent[0].subject, "news");
  assert.ok(sent[0].body.includes("it happened"));
  assert.equal(settled.receipt.from, "sogoth26@gmail.com");
  assert.equal(settled.output.delivered, true);

  const runRows = await h.sql(
    `SELECT status, error FROM resident_tool_runs WHERE outbox_id = $1`, [effect.id]
  );
  assert.equal(runRows[0]?.status, "succeeded");
});

await test("no Gmail configured: loud failure, nothing sent", async () => {
  // Wipe the Gmail config for this check, restore it after.
  await h.sql(`DELETE FROM insights_email_config WHERE workspace_id = $1`, [ws.id]);
  const tool = await makeEmailTool({ name: "No Gmail" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);
  const out = await invokeTool({
    db, toolId: tool.id, agentId: residentA.id,
    args: { to: "pal@example.com", subject: "s", body: "b" },
    config: { outboxMode: "live" },
  });
  const effect = await db.AutonomyOutbox.get(out.outboxId);
  await db.EffectApproval.append({
    workspace_id: ws.id, outbox_id: effect.id, goal_id: null,
    agent_id: residentA.id, decision: "approve", decided_by: "operator",
  });
  const sent = [];
  await assert.rejects(
    () => performToolEffect({ db, effect, config: cfg, mailer: stubMailer(sent) }),
    /isn't set up/
  );
  assert.equal(sent.length, 0);
  const runRows = await h.sql(
    `SELECT status FROM resident_tool_runs WHERE outbox_id = $1`, [effect.id]
  );
  assert.equal(runRows[0]?.status, "failed");
  // Restore for the remaining tests.
  await setCredentials(db, ws.id, { email_address: "sogoth26@gmail.com", app_password: "abcd efgh ijkl mnop" });
});

await test("recipients changed after approval: refused at send time", async () => {
  const tool = await makeEmailTool({ name: "Tamper Check", to_template: "{{to}}" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);
  const out = await invokeTool({
    db, toolId: tool.id, agentId: residentA.id,
    args: { to: "pal@example.com", subject: "s", body: "b" },
    config: { outboxMode: "live" },
  });
  const effect = await db.AutonomyOutbox.get(out.outboxId);
  // Tamper with the definition after approval was staged: re-render lands elsewhere.
  await db.ResidentTool.update(tool.id, { to_template: "attacker@example.com" });
  await db.EffectApproval.append({
    workspace_id: ws.id, outbox_id: effect.id, goal_id: null,
    agent_id: residentA.id, decision: "approve", decided_by: "operator",
  });
  const sent = [];
  await assert.rejects(
    () => performToolEffect({ db, effect, config: cfg, mailer: stubMailer(sent) }),
    /recipients changed/
  );
  assert.equal(sent.length, 0);
});

await test("assignment isolation: unassigned resident is refused", async () => {
  const tool = await makeEmailTool({ name: "A-only Emailer" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);
  const sent = [];
  const denied = await invokeTool({
    db, toolId: tool.id, agentId: residentB.id,
    args: { to: "pal@example.com", subject: "s", body: "b" },
    mailer: stubMailer(sent),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "not_assigned");
  assert.equal(sent.length, 0);
});

await test("Governor refuses a tampered recipient list", async () => {
  const tool = await makeEmailTool({ name: "Gov Tamper", to_template: "pal@example.com" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);
  const out = await invokeTool({
    db, toolId: tool.id, agentId: residentA.id,
    args: { subject: "s", body: "b" },
    config: { outboxMode: "live" },
  });
  const effect = await db.AutonomyOutbox.get(out.outboxId);
  // Rewrite the staged payload's recipients directly, as an attacker would.
  await h.sql(`UPDATE autonomy_outbox SET payload = jsonb_set(payload, '{to}', '["evil@example.com"]') WHERE id = $1`, [effect.id]);
  const again = await db.AutonomyOutbox.get(out.outboxId);
  await db.EffectApproval.append({
    workspace_id: ws.id, outbox_id: again.id, goal_id: null,
    agent_id: residentA.id, decision: "approve", decided_by: "operator",
  });
  const verdict = await judgeEffect({ db, effect: again, goal: null, authorization: null, config: cfg, mode: "live" });
  assert.equal(verdict.decision, "refuse");
  assert.ok(verdict.failed.some((f) => f.rule === "TOOL_RECIPIENT_MISMATCH"), JSON.stringify(verdict.failed.map((f) => f.rule)));
});

await test("kill switch halts email invocation", async () => {
  const tool = await makeEmailTool({ name: "Killed Emailer" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);
  const sent = [];
  // Flip the master switch off mid-test via env, like the harness kill tests.
  process.env.COGNOS_AUTONOMY_ENABLED = "false";
  try {
    const out = await invokeTool({
      db, toolId: tool.id, agentId: residentA.id,
      args: { to: "pal@example.com", subject: "s", body: "b" },
      mailer: stubMailer(sent),
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "killed");
    assert.equal(sent.length, 0);
  } finally {
    process.env.COGNOS_AUTONOMY_ENABLED = "true";
  }
});

await test("invoke validates the rendered recipient at stage time", async () => {
  const tool = await makeEmailTool({ name: "Bad Render" });
  await db.ResidentTool.assign(tool.id, residentA.slug, ws.id);
  const out = await invokeTool({
    db, toolId: tool.id, agentId: residentA.id,
    args: { to: "not-an-address", subject: "s", body: "b" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad_request");
  assert.ok(out.message.includes("doesn't look like an email address"));
});

await h.stop();

console.log(`\nresident-email-tools: ${passed} passed`);
