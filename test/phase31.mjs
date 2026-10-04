// Phase 31 — heartbeat with personality (server/autonomy/personality.js).
// Unit tests: date helpers, settings defaults/validation, greeting dedupe and
// fallback composition, dream idempotency, and the stalled-goal check-in.
// The suite never touches the network or a real database: the db is faked and
// `compose` (the LLM) is an injected stub.

let pass = 0;
function ok(cond, name) {
  if (!cond) { console.error("FAIL:", name); process.exit(1); }
  pass++;
  console.log("ok:", name);
}

const {
  PERSONALITY_DEFAULTS,
  validDateStr,
  todayStrUTC,
  yesterdayOf,
  dreamMemoryKey,
  getPersonalitySettings,
  updatePersonalitySettings,
  serveGreeting,
  distillDream,
  stalledGoalLine,
} = await import("../server/autonomy/personality.js");

// --- date helpers ------------------------------------------------------------
ok(validDateStr("2026-10-01"), "valid date accepted");
ok(!validDateStr("2026-13-01"), "month 13 rejected");
ok(!validDateStr("2026-02-30"), "Feb 30 rejected");
ok(!validDateStr("not-a-date"), "garbage rejected");
ok(!validDateStr(null), "null rejected");
ok(!validDateStr("2026-1-1"), "non-padded rejected");
ok(yesterdayOf("2026-10-01") === "2026-09-30", "yesterday across month boundary");
ok(yesterdayOf("2026-01-01") === "2025-12-31", "yesterday across year boundary");
ok(dreamMemoryKey("2026-09-30") === "dream.2026.09.30", "dream key is slug-stable");
ok(todayStrUTC(Date.UTC(2026, 9, 1, 12)) === "2026-10-01", "todayStrUTC formats UTC");

// --- fake db -----------------------------------------------------------------
// Pattern-matches the SQL the module actually issues (see personality.js).
function makeDb({
  goals = [],               // [{ title, touched }] — touched is an ISO string
  recentMemories = [],      // [content]
  yesterdayMemories = [],   // [content]
  yesterdayCount = null,
  outboxStaged = 0,
  state = null,             // heartbeat_state row or null
  existingDreamKeys = [],   // memory_keys already stored
} = {}) {
  const db = {
    _state: state,
    _created: [],
    async query(sql, params) {
      const q = String(sql);
      if (q.startsWith("INSERT INTO heartbeat_state")) {
        db._state = {
          last_greeting_date: params[1],
          last_dream_date: params[2],
          settings: JSON.parse(params[3]),
        };
        return [];
      }
      if (q.includes("FROM heartbeat_state")) return db._state ? [db._state] : [];
      if (q.includes("FROM autonomy_goals") && q.includes("LIMIT 3")) {
        return goals.slice(0, 3).map(g => ({ title: g.title }));
      }
      if (q.includes("FROM autonomy_goals") && q.includes("LIMIT 1")) {
        const sorted = [...goals].sort((a, b) => Date.parse(a.touched) - Date.parse(b.touched));
        const g = sorted[0];
        return g ? [{ title: g.title, touched: g.touched }] : [];
      }
      if (q.includes("FROM autonomy_outbox")) return [{ n: outboxStaged }];
      if (q.includes("FROM memories") && q.includes("memory_key = $2")) {
        return existingDreamKeys.includes(params[1]) ? [{ id: "mem_dream" }] : [];
      }
      if (q.includes("FROM memories") && q.includes("COUNT(*)")) {
        return [{ n: yesterdayCount ?? yesterdayMemories.length }];
      }
      if (q.includes("FROM memories") && q.includes("ORDER BY created_date DESC")) {
        return recentMemories.map(content => ({ content }));
      }
      if (q.includes("FROM memories") && q.includes("ORDER BY created_date ASC")) {
        return yesterdayMemories.map(content => ({ content }));
      }
      throw new Error("fake db: unexpected query: " + q.slice(0, 80));
    },
    Memory: {
      async create(data) {
        const row = { id: `mem_${db._created.length}`, ...data };
        db._created.push(row);
        return row;
      }
    },
    Workspace: { async ensureDefault() { return { id: "ws1" }; } },
  };
  return db;
}

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01 12:00 UTC
const DAY = "2026-10-01";
const isoDaysAgo = (n) => new Date(NOW - n * 86400_000).toISOString();

// --- settings ----------------------------------------------------------------
{
  const db = makeDb();
  const s = await getPersonalitySettings(db, "ws1");
  ok(s.greeting === true && s.dream === true && s.checkin === true, "settings default all true");
  ok(JSON.stringify(s) === JSON.stringify({ ...PERSONALITY_DEFAULTS }), "defaults match frozen object shape");
}
{
  const db = makeDb();
  const s = await updatePersonalitySettings(db, "ws1", { greeting: false, dream: "yes", bogus: 1 });
  ok(s.greeting === false && s.dream === true && s.checkin === true, "patch applies booleans, ignores junk");
  const again = await getPersonalitySettings(db, "ws1");
  ok(again.greeting === false, "settings persist in heartbeat_state");
}

// --- greeting: dedupe ---------------------------------------------------------
{
  const db = makeDb({ goals: [{ title: "Fix the porch", touched: isoDaysAgo(1) }] });
  const first = await serveGreeting({ db, workspaceId: "ws1", dateStr: DAY, partOfDay: "morning", compose: null, nowMs: NOW });
  ok(first.served === true && first.already === false, "first greeting of the day is served");
  ok(typeof first.text === "string" && first.text.length > 0, "fallback greeting is non-empty text");
  ok(/^(Good morning|Morning)\./.test(first.text), "fallback starts with a morning opener");
  ok(db._state.last_greeting_date === DAY, "greeting date persisted");
  const second = await serveGreeting({ db, workspaceId: "ws1", dateStr: DAY, partOfDay: "morning", compose: null, nowMs: NOW });
  ok(second.served === true && second.already === true && second.text === null, "second call same day is deduped");
  ok(db._created.length === 0, "no dream written when yesterday is empty of memories");
  ok(db._state.last_dream_date === "2026-09-30", "empty yesterday still marks the dream done");
}

// --- greeting: compose success / failure --------------------------------------
{
  const db = makeDb();
  const r = await serveGreeting({
    db, workspaceId: "ws1", dateStr: DAY, partOfDay: "evening", nowMs: NOW,
    compose: async () => "  Good evening. The shop was quiet today.  ",
  });
  ok(r.text === "Good evening. The shop was quiet today.", "composed text is cleaned and used");
}
{
  const db = makeDb();
  const r = await serveGreeting({
    db, workspaceId: "ws1", dateStr: DAY, partOfDay: "morning", nowMs: NOW,
    compose: async () => { throw new Error("provider down"); },
  });
  ok(r.served === true && typeof r.text === "string" && r.text.length > 0,
    "throwing compose degrades to deterministic text, never silence");
}
{
  const db = makeDb();
  const r = await serveGreeting({
    db, workspaceId: "ws1", dateStr: DAY, partOfDay: "morning", nowMs: NOW,
    compose: async () => "   ",
  });
  ok(typeof r.text === "string" && r.text.length > 0, "blank compose output falls back");
}

// --- greeting: disabled / invalid date -----------------------------------------
{
  const db = makeDb();
  await updatePersonalitySettings(db, "ws1", { greeting: false });
  const r = await serveGreeting({ db, workspaceId: "ws1", dateStr: DAY, nowMs: NOW });
  ok(r.served === false && r.disabled === true, "greeting toggle off -> not served");
}
{
  const db = makeDb();
  const r = await serveGreeting({ db, workspaceId: "ws1", dateStr: "garbage", nowMs: NOW });
  ok(r.served === true && r.date === "2026-10-01", "invalid date falls back to server UTC date");
}
{
  const db = makeDb();
  const r = await serveGreeting({ db, workspaceId: "ws1", dateStr: DAY, partOfDay: "midnight", nowMs: NOW });
  ok(/^(Good morning|Morning)\./.test(r.text), "unknown part of day falls back to morning");
}

// --- dream: writes one entry, then never again ----------------------------------
{
  const db = makeDb({ yesterdayMemories: ["planted tomatoes", "called mom"] });
  const first = await distillDream({ db, workspaceId: "ws1", dateStr: DAY, compose: null });
  ok(first.written === true && first.key === "dream.2026.09.30", "dream written for yesterday");
  ok(db._created.length === 1, "exactly one dream memory created");
  const row = db._created[0];
  ok(row.memory_key === "dream.2026.09.30", "dream stored under the dream key");
  ok(row.memory_type === "episodic" && row.memory_layer === "self", "dream is episodic, on the self layer");
  ok(row.source === "heartbeat.dream", "dream source labeled");
  ok(typeof row.content === "string" && row.content.length > 0, "dream has content");
  const second = await distillDream({ db, workspaceId: "ws1", dateStr: DAY, compose: null });
  ok(second.written === false && second.reason === "already", "dream is idempotent per day");
  ok(db._created.length === 1, "no duplicate dream memory");
}
{
  // Crash between the write and the state update: the key exists, the date
  // does not. The key check is the backstop.
  const db = makeDb({ yesterdayMemories: ["planted tomatoes"], existingDreamKeys: ["dream.2026.09.30"] });
  const r = await distillDream({ db, workspaceId: "ws1", dateStr: DAY, compose: null });
  ok(r.written === false && r.reason === "exists", "existing dream key prevents a duplicate");
  ok(db._created.length === 0, "no write when the key already exists");
  ok(db._state.last_dream_date === "2026-09-30", "state still advances past the recovered day");
}
{
  const db = makeDb({ yesterdayMemories: ["saw a heron at the river"] });
  const r = await distillDream({
    db, workspaceId: "ws1", dateStr: DAY,
    compose: async () => "The heron stood in the river like a held breath.",
  });
  ok(r.written === true && db._created[0].content === "The heron stood in the river like a held breath.",
    "composed dream text is stored verbatim (cleaned)");
}
{
  // The greeting path runs the dream lazily: one call covers both.
  const db = makeDb({ yesterdayMemories: ["fixed the fence"] });
  const r = await serveGreeting({ db, workspaceId: "ws1", dateStr: DAY, partOfDay: "morning", compose: null, nowMs: NOW });
  ok(r.dreamWritten === true, "serveGreeting distills the dream lazily");
  ok(db._created.length === 1 && db._created[0].memory_key === "dream.2026.09.30", "dream memory present after greeting");
}

// --- check-ins: rare, soft, deterministic -----------------------------------------
{
  const db = makeDb({ goals: [{ title: "Learn grafting", touched: isoDaysAgo(6) }] });
  const line = await stalledGoalLine({ db, workspaceId: "ws1", nowMs: NOW });
  ok(typeof line === "string" && line.includes("Learn grafting") && line.includes("6 days"),
    "stalled goal produces one soft line with title and days");
  ok(!line.includes("!"), "check-in has no exclamation marks");
}
{
  const db = makeDb({ goals: [{ title: "Learn grafting", touched: isoDaysAgo(1) }] });
  ok(await stalledGoalLine({ db, workspaceId: "ws1", nowMs: NOW }) === null, "recent goal -> no check-in");
}
{
  const db = makeDb();
  ok(await stalledGoalLine({ db, workspaceId: "ws1", nowMs: NOW }) === null, "no goals -> no check-in");
}
{
  const db = makeDb({ goals: [{ title: "x", touched: "not-a-date" }] });
  ok(await stalledGoalLine({ db, workspaceId: "ws1", nowMs: NOW }) === null, "unparseable timestamp -> no check-in");
}
{
  // The stalest goal is the one named, not the most recently touched.
  const db = makeDb({ goals: [
    { title: "Fresh goal", touched: isoDaysAgo(1) },
    { title: "Old goal", touched: isoDaysAgo(9) },
  ]});
  const line = await stalledGoalLine({ db, workspaceId: "ws1", nowMs: NOW });
  ok(line.includes("Old goal"), "stalest active goal is the one mentioned");
}
{
  // Check-in rides the greeting, and only when enabled.
  const db = makeDb({ goals: [{ title: "Learn grafting", touched: isoDaysAgo(5) }] });
  const r = await serveGreeting({ db, workspaceId: "ws1", dateStr: DAY, partOfDay: "morning", compose: null, nowMs: NOW });
  ok(typeof r.checkin === "string" && r.checkin.includes("Learn grafting"), "check-in attached to greeting");
}
{
  const db = makeDb({ goals: [{ title: "Learn grafting", touched: isoDaysAgo(5) }] });
  await updatePersonalitySettings(db, "ws1", { checkin: false });
  const r = await serveGreeting({ db, workspaceId: "ws1", dateStr: DAY, partOfDay: "morning", compose: null, nowMs: NOW });
  ok(r.checkin === null && typeof r.text === "string", "check-in toggle off silences it, greeting remains");
}

// --- greeting facts shape the fallback -------------------------------------------
{
  const db = makeDb({ outboxStaged: 2 });
  const r = await serveGreeting({ db, workspaceId: "ws1", dateStr: "2026-10-02", partOfDay: "morning", compose: null, nowMs: NOW });
  ok(r.text.includes("2 items are staged"), "staged outbox surfaces in the fallback greeting");
}

console.log(`\nphase31: ${pass} assertions passed`);
