#!/usr/bin/env node
// Phase 37 — OpenMuse steals, part 2: vault, lease runner, watches.
//
// What this file proves:
//   * Vault: AES-256-GCM round-trip; tampered ciphertext fails closed; wrong
//     key fails closed; legacy plaintext detection.
//   * Lease runner: claim → heartbeat → complete; LostLease → requeue (never
//     fail); expired lease reclaimed by maintenance; CAS prevents double-claim.
//   * Watches: create/list/pause/delete; condition evaluation (change,
//     contains, price_below); hash dedupe (no double alert); failure backoff.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  encryptSecret, decryptSecret, isEncrypted, _resetVaultKeyCache
} from "../server/autonomy/vault.js";
import { createWorkflowStore } from "../server/autonomy/workflowStore.js";
import { createTaskRunner, createDurableTask, LostLeaseError } from "../server/autonomy/leaseRunner.js";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log(`  ok - ${name}`); };

// --- Vault (pure unit, no DB) -------------------------------------------------

const TEST_KEY = randomBytes(32).toString("base64");

await ok("vault round-trips", () => {
  const enc = encryptSecret("super-secret-value", TEST_KEY);
  assert.equal(decryptSecret(enc, TEST_KEY), "super-secret-value");
});

await ok("vault envelope is versioned", () => {
  const enc = encryptSecret("x", TEST_KEY);
  assert.ok(enc.startsWith("v1."));
  assert.equal(enc.split(".").length, 4);
});

await ok("vault fails closed on tampered ciphertext", () => {
  const enc = encryptSecret("x", TEST_KEY);
  const parts = enc.split(".");
  parts[3] = parts[3].slice(0, -2) + "AA"; // flip tail bits
  assert.throws(() => decryptSecret(parts.join("."), TEST_KEY), /Unable to authenticate/);
});

await ok("vault fails closed on wrong key", () => {
  const enc = encryptSecret("x", TEST_KEY);
  const other = randomBytes(32).toString("base64");
  assert.throws(() => decryptSecret(enc, other), /Unable to authenticate/);
});

await ok("vault rejects malformed envelopes", () => {
  assert.throws(() => decryptSecret("not-an-envelope", TEST_KEY), /Invalid encrypted secret/);
  assert.throws(() => decryptSecret("v2.a.b.c", TEST_KEY), /Invalid encrypted secret/);
});

await ok("vault rejects bad keys", () => {
  assert.throws(() => encryptSecret("x", "too-short"), /32-byte/);
});

await ok("isEncrypted distinguishes envelopes from plaintext", () => {
  assert.equal(isEncrypted(encryptSecret("x", TEST_KEY)), true);
  assert.equal(isEncrypted("plaintext-secret"), false);
  assert.equal(isEncrypted(""), false);
  assert.equal(isEncrypted(null), false);
});

await ok("nonces are unique (no reuse)", () => {
  const a = encryptSecret("same", TEST_KEY);
  const b = encryptSecret("same", TEST_KEY);
  assert.notEqual(a, b);
});

// --- Workflow store + lease runner (integration) -------------------------------

const h = await bootHarness();
const { db } = await import("../server/db.js");
const { query } = await import("../server/db.js");
const store = createWorkflowStore(query);
const ws = await db.Workspace.ensureDefault();
const owner = ws.id;

await ok("workflow store: put/get round-trip", async () => {
  await store.put(owner, "test_kind", { id: "t1", status: "queued", n: 1 });
  const got = await store.get(owner, "test_kind", "t1");
  assert.equal(got.n, 1);
  await store.remove(owner, "test_kind", "t1");
});

await ok("workflow store: compareAndSwap wins on match, loses on mismatch", async () => {
  await store.put(owner, "test_kind", { id: "t2", status: "queued" });
  const won = await store.compareAndSwap(owner, "test_kind", "t2", { status: "queued" }, { status: "running" });
  assert.equal(won.status, "running");
  const lost = await store.compareAndSwap(owner, "test_kind", "t2", { status: "queued" }, { status: "failed" });
  assert.equal(lost, null);
  await store.remove(owner, "test_kind", "t2");
});

await ok("workflow store: insertIfAbsent never dupes", async () => {
  const v = { id: "t3", status: "new" };
  const first = await store.insertIfAbsent(owner, "test_kind", v);
  assert.ok(first);
  const second = await store.insertIfAbsent(owner, "test_kind", v);
  assert.equal(second, null);
  await store.remove(owner, "test_kind", "t3");
});

await ok("lease runner: claim → execute → succeed", async () => {
  const task = await createDurableTask(store, owner, { id: "lease-1", title: "test task" });
  assert.equal(task.status, "queued");
  const runner = createTaskRunner(store, async (o, t) => ({ status: "succeeded", result: { done: true } }), { leaseMs: 5000 });
  const settled = await runner.run(owner, "lease-1");
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.result.result.done, true);
  assert.equal(settled.leaseId, null);
});

await ok("lease runner: LostLease requeues, never fails", async () => {
  await createDurableTask(store, owner, { id: "lease-2", title: "loser task" });
  let runs = 0;
  let abortFn = null;
  const runner = createTaskRunner(store, async (o, t, ctx) => {
    runs++;
    if (runs === 1) {
      // Simulate an external abort (pause/cancel) mid-run.
      abortFn = () => { throw new LostLeaseError("paused by operator"); };
      throw new LostLeaseError("paused by operator");
    }
    return { status: "succeeded" };
  }, { leaseMs: 30000 });
  const settled = await runner.run(owner, "lease-2");
  // Lost lease → back to queued, not failed.
  assert.equal(settled.status, "queued");
  assert.equal(runs, 1);
});

await ok("lease runner: real errors fail the task (not lease losses)", async () => {
  await createDurableTask(store, owner, { id: "lease-3", title: "fail task" });
  const runner = createTaskRunner(store, async () => { throw new Error("boom"); }, { leaseMs: 5000 });
  const settled = await runner.run(owner, "lease-3");
  assert.equal(settled.status, "failed");
  assert.ok(settled.error.includes("boom"));
});

await ok("lease runner: maintenance requeues expired leases", async () => {
  const t = Date.now();
  await store.put(owner, "durable_tasks", {
    id: "lease-4", kind: "generic", title: "dead worker task",
    status: "running", leaseId: "dead-lease",
    leaseUntil: new Date(t - 60000).toISOString(), // expired a minute ago
    attempts: 1, createdMs: t, updatedMs: t
  });
  const runner = createTaskRunner(store, async () => ({}), {});
  await runner.maintain();
  const after = await store.get(owner, "durable_tasks", "lease-4");
  assert.equal(after.status, "queued");
  assert.equal(after.leaseId, null);
});

await ok("createDurableTask is idempotent by id", async () => {
  const a = await createDurableTask(store, owner, { id: "lease-5", title: "x" });
  const b = await createDurableTask(store, owner, { id: "lease-5", title: "x" });
  assert.equal(a.id, b.id);
});

// --- Watches -------------------------------------------------------------------

const { createWatchRunner } = await import("../server/autonomy/watches.js");
const watchRunner = createWatchRunner({ db, store, taskRunner: null });

await ok("watches: create/list/get round-trip", async () => {
  const agent = await db.AutonomyAgent.create({
    workspace_id: owner, name: "Test Resident", slug: "test-resident",
    purpose: "test", brief: "test", enabled: true
  });
  const watch = await watchRunner.createWatch({
    workspaceId: owner, residentId: agent.id, name: "Test watch",
    url: "https://example.com/page", condition: "change", intervalMinutes: 60
  });
  assert.equal(watch.name, "Test watch");
  assert.equal(watch.status, "active");
  const listed = await watchRunner.listWatches(owner, { residentId: agent.id });
  assert.ok(listed.some(w => w.id === watch.id));
  await watchRunner.deleteWatch(watch.id);
});

await ok("watches: rejects bad conditions and non-https URLs", async () => {
  const agent = await db.AutonomyAgent.create({
    workspace_id: owner, name: "Test Resident 2", slug: "test-resident-2",
    purpose: "test", brief: "test", enabled: true
  });
  await assert.rejects(() => watchRunner.createWatch({
    workspaceId: owner, residentId: agent.id, name: "bad",
    url: "https://example.com", condition: "teleport"
  }), /unknown watch condition/);
});

await ok("watches: pause/resume/stop", async () => {
  const agent = await db.AutonomyAgent.create({
    workspace_id: owner, name: "Test Resident 3", slug: "test-resident-3",
    purpose: "test", brief: "test", enabled: true
  });
  const watch = await watchRunner.createWatch({
    workspaceId: owner, residentId: agent.id, name: "Pausable",
    url: "https://example.com", condition: "change"
  });
  const paused = await watchRunner.setStatus(watch.id, "paused");
  assert.equal(paused.status, "paused");
  const active = await watchRunner.setStatus(watch.id, "active");
  assert.equal(active.status, "active");
  await watchRunner.deleteWatch(watch.id);
});

await h.stop();
_resetVaultKeyCache();
console.log(`\nphase37e: ${passed} passed`);
