#!/usr/bin/env node
// Phase 37c — follow-up queue (ported from OpenMuse's conversation-queue.ts).
//
// What this file proves, against src/lib/conversationQueue.js:
//   * enqueue preserves insertion order
//   * flush sends one at a time, in order, and picks up messages enqueued mid-flush
//   * a second flush while one is running is a no-op (no double-send)
//   * flush is a no-op while paused; resume re-arms it
//   * on error the queue pauses itself and the failed message is NOT resent
//     on the next flush (it already reached the transcript)
//   * remove(id) drops a pending message before it sends
//   * queued turn options (sources, agentMode) ride along into send()
//   * subscribe/notify fires on every mutation, for useSyncExternalStore

import assert from "node:assert/strict";
import { ConversationQueue } from "../src/lib/conversationQueue.js";

let passed = 0;
const ok = async (name, fn) => { await fn(); passed++; console.log(`  ok - ${name}`); };

const msg = (id, text = `text-${id}`, options = {}) => ({ id, text, options });

await ok("enqueue preserves insertion order", () => {
  const q = new ConversationQueue();
  q.enqueue(msg("a")); q.enqueue(msg("b")); q.enqueue(msg("c"));
  assert.deepEqual(q.getSnapshot().pending.map((m) => m.id), ["a", "b", "c"]);
});

await ok("flush sends one at a time, in order", async () => {
  const q = new ConversationQueue();
  q.enqueue(msg("a")); q.enqueue(msg("b")); q.enqueue(msg("c"));
  const sent = [];
  let active = 0, maxActive = 0;
  await q.flush(async (m) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    sent.push(m.id);
    active--;
  });
  assert.deepEqual(sent, ["a", "b", "c"]);
  assert.equal(maxActive, 1, "sends must not overlap");
  assert.equal(q.getSnapshot().pending.length, 0);
  assert.equal(q.getSnapshot().running, false);
});

await ok("running is true while flushing", async () => {
  const q = new ConversationQueue();
  q.enqueue(msg("a"));
  let runningSeen = null;
  const done = q.flush(async () => { runningSeen = q.getSnapshot().running; });
  assert.equal(q.getSnapshot().running, true);
  await done;
  assert.equal(runningSeen, true);
});

await ok("a second flush while running is a no-op", async () => {
  const q = new ConversationQueue();
  q.enqueue(msg("a")); q.enqueue(msg("b"));
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = q.flush(async () => { calls++; await gate; });
  await q.flush(async () => { calls++; }); // must return without sending
  release();
  await first;
  assert.equal(calls, 2, "only the two queued messages send, once each");
});

await ok("flush is a no-op while paused, resume re-arms it", async () => {
  const q = new ConversationQueue();
  q.enqueue(msg("a"));
  q.pause();
  let calls = 0;
  await q.flush(async () => { calls++; });
  assert.equal(calls, 0);
  assert.equal(q.getSnapshot().pending.length, 1);
  q.resume();
  await q.flush(async (m) => { calls++; assert.equal(m.id, "a"); });
  assert.equal(calls, 1);
});

await ok("on error the queue pauses and the failed message is never resent", async () => {
  const q = new ConversationQueue();
  q.enqueue(msg("a")); q.enqueue(msg("b")); q.enqueue(msg("c"));
  const sent = [];
  await assert.rejects(
    q.flush(async (m) => {
      sent.push(m.id);
      if (m.id === "b") throw new Error("boom");
    }),
    /boom/
  );
  assert.equal(q.getSnapshot().paused, true, "error pauses the queue");
  // "b" was shifted out before send ran; only "c" remains — never "b" again.
  assert.deepEqual(q.getSnapshot().pending.map((m) => m.id), ["c"]);
  q.resume();
  await q.flush(async (m) => { sent.push(m.id); });
  assert.deepEqual(sent, ["a", "b", "c"], "the failed message is not implicitly resent");
  assert.equal(q.getSnapshot().paused, false);
});

await ok("remove drops a pending message before it sends", async () => {
  const q = new ConversationQueue();
  q.enqueue(msg("a")); q.enqueue(msg("b")); q.enqueue(msg("c"));
  q.remove("b");
  q.remove("missing-id"); // no-op, must not throw
  const sent = [];
  await q.flush(async (m) => { sent.push(m.id); });
  assert.deepEqual(sent, ["a", "c"]);
});

await ok("messages enqueued mid-flush are picked up in the same flush", async () => {
  const q = new ConversationQueue();
  q.enqueue(msg("a"));
  const sent = [];
  await q.flush(async (m) => {
    sent.push(m.id);
    if (m.id === "a") q.enqueue(msg("b"));
  });
  assert.deepEqual(sent, ["a", "b"]);
});

await ok("queued turn options ride along into send()", async () => {
  const q = new ConversationQueue();
  const options = { sources: [{ id: "s1" }], agentMode: "observe" };
  q.enqueue(msg("a", "hello", options));
  let got = null;
  await q.flush(async (m) => { got = m; });
  assert.equal(got.text, "hello");
  assert.deepEqual(got.options, options);
});

await ok("subscribe notifies on every mutation", async () => {
  const q = new ConversationQueue();
  let n = 0;
  const unsub = q.subscribe(() => { n++; });
  q.enqueue(msg("a"));   // 1
  q.remove("a");         // 2
  q.pause();             // 3
  q.resume();            // 4
  q.enqueue(msg("b"));   // 5
  await q.flush(async () => {}); // running true (6), shift (7), running false (8)
  unsub();
  q.enqueue(msg("z"));   // not counted
  assert.equal(n, 8, `expected 8 notifications, got ${n}`);
});

await ok("getSnapshot returns a fresh object per update (no mutation)", () => {
  const q = new ConversationQueue();
  const before = q.getSnapshot();
  q.enqueue(msg("a"));
  const after = q.getSnapshot();
  assert.notEqual(before, after);
  assert.equal(before.pending.length, 0);
  assert.equal(after.pending.length, 1);
});

console.log(`\nphase37c: ${passed} passed`);
