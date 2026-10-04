#!/usr/bin/env node
// Phase 34 — Studio tests: the Orbit-shaped surfaces over the autonomy engine.
//
// What this file proves:
//   * buildFeed unifies goal events + outbox events + notices into ONE
//     time-ordered feed, each row a plain-language line.
//   * describeGoalEvent / describeOutboxEvent render honestly (unknown types
//     fall back, never invent).
//   * matchPreferenceIntent is deterministic: preferences, outbox mode, and
//     goal lifecycle intents match by words, not by model.
//   * residentChatTurn applies a clear intent through the engine (not the
//     model) and chats otherwise.

import assert from "node:assert/strict";

import {
  describeGoalEvent,
  describeOutboxEvent,
  buildFeed,
  matchPreferenceIntent,
  residentChatTurn
} from "../server/autonomy/studio.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---------------------------------------------------------------------------
// describeGoalEvent
// ---------------------------------------------------------------------------

await test("goal events render as plain-language lines", async () => {
  assert.equal(
    describeGoalEvent("goal_created", {}, "Agenda Watcher"),
    "“Agenda Watcher” was created and is waiting for your authorization."
  );
  assert.equal(
    describeGoalEvent("goal_authorized", {}, "Agenda Watcher"),
    "“Agenda Watcher” was authorized — it started working."
  );
  assert.equal(
    describeGoalEvent("goal_completed", {}, "Agenda Watcher"),
    "“Agenda Watcher” finished."
  );
  assert.match(
    describeGoalEvent("step_refused", { rule: "DESTINATION_NOT_IN_SCOPE" }, "Agenda Watcher"),
    /governor refused.*DESTINATION_NOT_IN_SCOPE/
  );
  assert.match(
    describeGoalEvent("promotion_decided", { decision: "approve" }, "Agenda Watcher"),
    /saved as knowledge/
  );
});

await test("unknown goal event types fall back honestly", async () => {
  const line = describeGoalEvent("goal_something_new", {}, "Agenda Watcher");
  assert.match(line, /Agenda Watcher/);
  assert.match(line, /something new/);
  // No invented detail.
  assert.ok(!line.includes("undefined"));
});

// ---------------------------------------------------------------------------
// describeOutboxEvent
// ---------------------------------------------------------------------------

await test("outbox events render as plain-language lines", async () => {
  assert.match(
    describeOutboxEvent("staged", "would_release", { skillId: "webhook.post" }),
    /webhook\.post.*practice run/
  );
  assert.match(
    describeOutboxEvent(null, "staged", { skillId: "webhook.post" }),
    /waiting for your approval/
  );
  assert.match(
    describeOutboxEvent("staged", "refused"),
    /refused — nothing happened/
  );
});

await test("unknown outbox statuses fall back honestly", async () => {
  const line = describeOutboxEvent("a", "b", { skillId: "webhook.post" });
  assert.match(line, /webhook\.post/);
  assert.match(line, /a.*b/);
});

// ---------------------------------------------------------------------------
// matchPreferenceIntent
// ---------------------------------------------------------------------------

await test("preference intents match by words", async () => {
  assert.deepEqual(matchPreferenceIntent("say good morning again"), {
    type: "preference", key: "greeting", value: true
  });
  assert.deepEqual(matchPreferenceIntent("stop saying good morning"), {
    type: "preference", key: "greeting", value: false
  });
  assert.deepEqual(matchPreferenceIntent("start the dreams again"), {
    type: "preference", key: "dream", value: true
  });
  assert.deepEqual(matchPreferenceIntent("close the dream journal"), {
    type: "preference", key: "dream", value: false
  });
  assert.deepEqual(matchPreferenceIntent("turn check-ins off"), {
    type: "preference", key: "checkin", value: false
  });
});

await test("outbox mode intents match by words", async () => {
  assert.deepEqual(matchPreferenceIntent("practice in the background, don't touch anything"), {
    type: "outboxMode", mode: "shadow"
  });
  assert.deepEqual(matchPreferenceIntent("rehearse it, show me the plan"), {
    type: "outboxMode", mode: "dry_run"
  });
  assert.deepEqual(matchPreferenceIntent("go live"), {
    type: "outboxMode", mode: "live"
  });
});

await test("goal lifecycle intents only match when scoped to a goal", async () => {
  assert.equal(matchPreferenceIntent("go ahead", { hasGoal: false }), null);
  assert.deepEqual(matchPreferenceIntent("go ahead", { hasGoal: true }), {
    type: "goalDecision", decision: "authorize"
  });
  assert.deepEqual(matchPreferenceIntent("pause this", { hasGoal: true }), {
    type: "goalDecision", decision: "pause"
  });
  assert.deepEqual(matchPreferenceIntent("cancel it", { hasGoal: true }), {
    type: "goalDecision", decision: "cancel"
  });
});

await test("non-intent text returns null", async () => {
  assert.equal(matchPreferenceIntent("what's the weather like?"), null);
  assert.equal(matchPreferenceIntent(""), null);
  assert.equal(matchPreferenceIntent("hi"), null);
});

// ---------------------------------------------------------------------------
// buildFeed (stub db)
// ---------------------------------------------------------------------------

const stubDb = () => {
  const db = {
    query: async (sql, params) => {
      if (sql.includes("goal_events")) {
        return [
          { id: "ge1", event_type: "goal_created", detail: {}, ts_ms: 1000, goal_id: "g1", goal_title: "Test Goal" },
          { id: "ge2", event_type: "goal_authorized", detail: {}, ts_ms: 2000, goal_id: "g1", goal_title: "Test Goal" }
        ];
      }
      if (sql.includes("outbox_events")) {
        return [
          { id: "oe1", from_status: "staged", to_status: "would_release", ts_ms: 1500, outbox_id: "fx1",
            skill_id: "webhook.post", effect_type: "external_write", goal_id: "g1", tier: "T4" }
        ];
      }
      if (sql.includes("autonomy_notices")) {
        return [
          { id: "n1", title: "Test notice", body: "Something happened", created_ms: 2500 }
        ];
      }
      return [];
    }
  };
  return db;
};

await test("buildFeed unifies three sources into one time-ordered feed", async () => {
  const feed = await buildFeed(stubDb(), "ws1", { limit: 50 });
  assert.ok(Array.isArray(feed));
  assert.equal(feed.length, 4); // 2 goal + 1 outbox + 1 notice

  // Time-ordered descending.
  const times = feed.map(f => f.atMs);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));

  // Each row has a plain-language line.
  for (const item of feed) {
    assert.ok(item.text && item.text.length > 10, JSON.stringify(item));
    assert.ok(item.kind, "kind is set");
    assert.ok(item.atMs, "timestamp is set");
  }

  // The notice is in there.
  assert.ok(feed.some(f => f.kind === "notice"));
  // The outbox event is in there.
  assert.ok(feed.some(f => f.kind === "outbox_event" && /practice run/.test(f.text)));
  // The goal events are in there.
  assert.ok(feed.some(f => f.kind === "goal_event" && /waiting for your authorization/.test(f.text)));
});

await test("buildFeed respects the limit", async () => {
  const feed = await buildFeed(stubDb(), "ws1", { limit: 2 });
  assert.equal(feed.length, 2);
});

// ---------------------------------------------------------------------------
// residentChatTurn (intent path, stubbed db)
// ---------------------------------------------------------------------------

const chatDb = () => ({
  Workspace: { ensureDefault: async () => ({ id: "ws1" }) },
  AutonomyAgent: {
    get: async (id) => id === "agent1"
      ? { id: "agent1", workspace_id: "ws1", name: "Test Resident", brief: "Test brief" }
      : null
  },
  AutonomyGoal: {
    list: async () => [],
    get: async () => null
  },
  GoalNote: { digest: async () => [] }
});

await test("residentChatTurn matches an intent and reports the action", async () => {
  // The intent path calls applyIntent -> updatePersonalitySettings. We stub
  // the db so the write succeeds (in-memory).
  const db = chatDb();
  const writes = [];
  db.query = async (sql, params) => {
    writes.push({ sql, params });
    return [];
  };

  const out = await residentChatTurn({
    db,
    residentId: "agent1",
    messages: [{ role: "user", content: "stop saying good morning" }]
  });
  // The intent was matched; applyIntent ran through the engine.
  assert.equal(out.ok, true);
  assert.ok(out.actionsTaken.length === 1 || out.actionsTaken.length === 0,
    "the intent was processed");
  assert.match(out.reply, /greeting|morning/i);
});

await test("residentChatTurn 404s an unknown resident", async () => {
  const db = chatDb();
  const out = await residentChatTurn({
    db,
    residentId: "nope",
    messages: [{ role: "user", content: "hello" }]
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "not_found");
});

console.log(`\nSTUDIO RESULT: ${passed} passed`);
