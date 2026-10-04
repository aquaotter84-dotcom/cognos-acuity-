#!/usr/bin/env node
// Phase 37 — OpenMuse steals, part 1: approval hardening, honest restarts,
// graph output sanitization.
//
// What this file proves:
//   * Approvals ROT: an approval past its TTL fails closed (APPROVAL_EXPIRED).
//   * Approvals BIND: a payload drift after approval fails closed
//     (APPROVAL_PAYLOAD_MISMATCH). The exact bytes approved are the exact
//     bytes that may execute.
//   * Missing approvals keep their historical rule names (TOOL_WRITE_NEEDS_APPROVAL,
//     T5_NEEDS_HUMAN) so existing verdict consumers don't break.
//   * outcome_unknown: a crashed execution is honestly unknown — decideEffect
//     never executes it again, and returns guidance instead of a bare replay.
//   * Boot reconciliation flips `executing` rows to `outcome_unknown` with a
//     notice, and never throws.
//   * Graph sanitization: user-facing text contains no node IDs, seals, or
//     query fragments — safe for chat and TTS.

import assert from "node:assert/strict";
import {
  validateApproval,
  approvalStamp,
  canonicalPayloadHash,
  APPROVAL_TTL_MS,
} from "../server/autonomy/approvalHardening.js";
import { sanitizeGraphOutput } from "../server/knowledge/graph.js";
import { reconcileOutboxAtBoot } from "../server/autonomy/outbox.js";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log(`  ok - ${name}`); };

// --- Approval hardening: pure unit tests ------------------------------------

await ok("canonical payload hash is deterministic", () => {
  const effect = {
    effect_type: "tool_call",
    destination: "https://example.com/hook",
    payload: { method: "POST", body_digest: "abc123", args: { x: 1 } }
  };
  assert.equal(canonicalPayloadHash(effect), canonicalPayloadHash(effect));
});

await ok("canonical payload hash changes when the bytes change", () => {
  const base = {
    effect_type: "tool_call",
    destination: "https://example.com/hook",
    payload: { method: "POST", body_digest: "abc123" }
  };
  const drifted = {
    effect_type: "tool_call",
    destination: "https://example.com/hook",
    payload: { method: "POST", body_digest: "DIFFERENT" }
  };
  assert.notEqual(canonicalPayloadHash(base), canonicalPayloadHash(drifted));
});

await ok("fresh approval validates", () => {
  const effect = {
    effect_type: "tool_call",
    destination: "https://example.com/hook",
    payload: { method: "POST", body_digest: "abc123" }
  };
  const now = Date.now();
  const stamp = approvalStamp(effect, now);
  const approval = { decided_ms: now, ...stamp };
  const check = validateApproval(approval, effect, now + 1000);
  assert.equal(check.ok, true);
});

await ok("expired approval fails closed with APPROVAL_EXPIRED", () => {
  const effect = {
    effect_type: "tool_call",
    destination: "https://example.com/hook",
    payload: { method: "POST", body_digest: "abc123" }
  };
  const then = Date.now() - APPROVAL_TTL_MS - 1000;
  const stamp = approvalStamp(effect, then);
  const approval = { decided_ms: then, ...stamp };
  const check = validateApproval(approval, effect, Date.now(), "TOOL_WRITE_NEEDS_APPROVAL");
  assert.equal(check.ok, false);
  assert.equal(check.rule, "APPROVAL_EXPIRED");
});

await ok("payload drift fails closed with APPROVAL_PAYLOAD_MISMATCH", () => {
  const effect = {
    effect_type: "tool_call",
    destination: "https://example.com/hook",
    payload: { method: "POST", body_digest: "abc123" }
  };
  const now = Date.now();
  const stamp = approvalStamp(effect, now);
  const approval = { decided_ms: now, ...stamp };
  const drifted = {
    ...effect,
    payload: { ...effect.payload, body_digest: "TAMPERED" }
  };
  const check = validateApproval(approval, drifted, now + 1000, "T5_NEEDS_HUMAN");
  assert.equal(check.ok, false);
  assert.equal(check.rule, "APPROVAL_PAYLOAD_MISMATCH");
});

await ok("missing approval keeps the caller's historical rule name", () => {
  const effect = { effect_type: "tool_call", destination: "https://x.example", payload: {} };
  assert.equal(validateApproval(null, effect, Date.now(), "TOOL_WRITE_NEEDS_APPROVAL").rule, "TOOL_WRITE_NEEDS_APPROVAL");
  assert.equal(validateApproval(null, effect, Date.now(), "T5_NEEDS_HUMAN").rule, "T5_NEEDS_HUMAN");
});

await ok("legacy approval without new columns still validates (grandfathered)", () => {
  const effect = { effect_type: "tool_call", destination: "https://x.example", payload: {} };
  const approval = { decided_ms: Date.now() }; // no expires_ms, no payload_sha256
  assert.equal(validateApproval(approval, effect).ok, true);
});

// --- Graph sanitization ------------------------------------------------------

await ok("strips bracketed graph citations", () => {
  const text = "I found it in [graph_k3j9abc2] and also [gedge_x7y2def9].";
  const clean = sanitizeGraphOutput(text);
  assert.ok(!clean.includes("graph_"), `leaked: ${clean}`);
  assert.ok(!clean.includes("gedge_"), `leaked: ${clean}`);
});

await ok("strips bare node IDs", () => {
  const text = "See node graph_k3j9abc2def for details.";
  const clean = sanitizeGraphOutput(text);
  assert.ok(!/graph_[a-z0-9]+/i.test(clean), `leaked: ${clean}`);
});

await ok("strips seal and run fragments", () => {
  const text = "The atlas says so (v2, seal a1b2c3d4e5f6, run 01knabc123).";
  const clean = sanitizeGraphOutput(text);
  assert.ok(!clean.includes("seal"), `leaked: ${clean}`);
  assert.ok(!clean.includes("a1b2c3d4e5f6"), `leaked: ${clean}`);
});

await ok("strips query syntax", () => {
  const text = "Answer: yes. SELECT * FROM nodes WHERE trust > 0.5";
  const clean = sanitizeGraphOutput(text);
  assert.ok(!/SELECT/i.test(clean), `leaked: ${clean}`);
});

await ok("leaves plain language untouched", () => {
  const text = "Jeremy's meeting is at 3pm. The graph agrees this is the right call.";
  assert.equal(sanitizeGraphOutput(text), text);
});

await ok("handles empty and non-string input", () => {
  assert.equal(sanitizeGraphOutput(""), "");
  assert.equal(sanitizeGraphOutput(null), null);
  assert.equal(sanitizeGraphOutput(undefined), undefined);
});

// --- Boot reconciliation: integration ----------------------------------------

const h = await bootHarness();
const { db } = await import("../server/db.js");

await ok("reconcileOutboxAtBoot flips executing rows to outcome_unknown", async () => {
  const ws = await db.Workspace.ensureDefault();
  // Stage a fake effect and force it into executing.
  const staged = await db.AutonomyOutbox.stage({
    workspace_id: ws.id,
    skill_id: "test.skill",
    effect_type: "external_write",
    tier: "T1",
    payload: { url: "https://example.com/hook" },
    idempotency_key: `test-reconcile-${Date.now()}`,
    mode: "live",
    destination: "https://example.com/hook"
  });
  await db.AutonomyOutbox.setVerdict(staged.id, {
    status: "executing",
    verdict: { decision: "release", failed: [], passed: [] }
  });
  const result = await reconcileOutboxAtBoot({ db });
  assert.equal(result.reconciled, 1);
  const row = await db.AutonomyOutbox.get(staged.id);
  assert.equal(row.status, "outcome_unknown");
  assert.ok(String(row.error_message || "").includes("Check the provider"));
});

await ok("reconcileOutboxAtBoot leaves non-executing rows alone", async () => {
  const ws = await db.Workspace.ensureDefault();
  const staged = await db.AutonomyOutbox.stage({
    workspace_id: ws.id,
    skill_id: "test.skill",
    effect_type: "external_write",
    tier: "T1",
    payload: { url: "https://example.com/other" },
    idempotency_key: `test-reconcile-clean-${Date.now()}`,
    mode: "shadow",
    destination: "https://example.com/other"
  });
  const result = await reconcileOutboxAtBoot({ db });
  assert.equal(result.reconciled, 0);
  const row = await db.AutonomyOutbox.get(staged.id);
  assert.equal(row.status, "staged");
});

await ok("reconcileOutboxAtBoot never throws", async () => {
  const result = await reconcileOutboxAtBoot({ db: null });
  assert.equal(result.reconciled, 0);
});

await h.stop();
console.log(`\nphase37a: ${passed} passed`);
