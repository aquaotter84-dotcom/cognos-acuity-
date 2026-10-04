// Phase 31 — heartbeat with personality: morning greetings, the dream journal,
// and gentle check-ins.
//
// The idea is borrowed from Sapphire's continuity/heartbeat (ddxfish/sapphire);
// the code is written from scratch. Sapphire is AGPL-3.0 — none of its code
// is copied here.
//
// This is a PERSONALITY LAYER on the existing loop, not new autonomy: it never
// stages effects, never touches the outbox, never spends budget, and never
// requires the autonomy master switch. Everything here is read-mostly and
// degrades to silence on any failure — a personality that breaks chat is a
// bug, not a feature.
//
// The three behaviors:
//   * Morning greeting — served once per device-local day, on app open, from
//     GET /api/heartbeat/greeting. One or two short sentences referencing
//     something real (active goals, staged outbox, yesterday's memories).
//     Never a push notification: the phone stays home on workdays, so
//     in-app-on-open is the only surface. The dedupe key is the
//     client-supplied date string, so the server never guesses timezones.
//   * Dream journal — lazily, at first open of a new day: yesterday's new
//     memories are distilled into one short dream entry stored as an episodic
//     memory (key "dream.<date>"). Quiet, no fanfare; it waits in Memory.
//     Idempotent per day, and per memory key as a crash-recovery backstop.
//   * Gentle check-ins — rare, and only ever attached to the greeting: an
//     active goal untouched for days gets one soft line. It lives in the
//     greeting card, so it is trivially dismissed and never repeats
//     within a day. Quiet hours are respected structurally: nothing here
//     ever pushes; everything is pulled by opening the app.

export const PERSONALITY_DEFAULTS = Object.freeze({
  greeting: true,
  dream: true,
  checkin: true
});
const SETTING_KEYS = Object.freeze(["greeting", "dream", "checkin"]);

// A goal untouched this long earns one soft line in the morning greeting.
const STALL_MS = 4 * 86400_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validDateStr(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function todayStrUTC(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function yesterdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 86400_000).toISOString().slice(0, 10);
}

/** The memory_key a dream entry for `dateStr` is stored under (post-slug). */
export function dreamMemoryKey(dateStr) {
  return `dream.${dateStr.replace(/-/g, ".")}`;
}

const cleanLine = (value, max = 280) => String(value ?? "")
  .replace(/[\u0000-\u001F\u007F]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

// --- state -----------------------------------------------------------------

async function readState(db, workspaceId) {
  const rows = await db.query(
    `SELECT last_greeting_date, last_dream_date, settings FROM heartbeat_state WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows?.[0] || null;
}

async function writeState(db, workspaceId, patch = {}) {
  const cur = await readState(db, workspaceId).catch(() => null);
  const next = {
    last_greeting_date: patch.last_greeting_date !== undefined ? patch.last_greeting_date : (cur?.last_greeting_date ?? null),
    last_dream_date: patch.last_dream_date !== undefined ? patch.last_dream_date : (cur?.last_dream_date ?? null),
    settings: patch.settings !== undefined ? patch.settings : (cur?.settings ?? {})
  };
  await db.query(
    `INSERT INTO heartbeat_state (workspace_id, last_greeting_date, last_dream_date, settings, updated_date)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (workspace_id) DO UPDATE SET
       last_greeting_date = EXCLUDED.last_greeting_date,
       last_dream_date = EXCLUDED.last_dream_date,
       settings = EXCLUDED.settings,
       updated_date = now()`,
    [workspaceId, next.last_greeting_date, next.last_dream_date, JSON.stringify(next.settings)]
  );
  return next;
}

function pickBooleans(obj) {
  const out = {};
  for (const key of SETTING_KEYS) {
    if (obj && typeof obj[key] === "boolean") out[key] = obj[key];
  }
  return out;
}

export async function getPersonalitySettings(db, workspaceId) {
  const row = await readState(db, workspaceId).catch(() => null);
  const stored = row?.settings && typeof row.settings === "object" ? row.settings : {};
  return { ...PERSONALITY_DEFAULTS, ...pickBooleans(stored) };
}

export async function updatePersonalitySettings(db, workspaceId, patch = {}) {
  const merged = { ...await getPersonalitySettings(db, workspaceId), ...pickBooleans(patch) };
  await writeState(db, workspaceId, { settings: merged });
  return merged;
}

// --- morning greeting --------------------------------------------------------

const OPENERS = Object.freeze({
  morning: ["Good morning.", "Morning."],
  afternoon: ["Afternoon.", "Good afternoon."],
  evening: ["Evening.", "Good evening."],
  night: ["Up late.", "Burning the midnight oil."]
});

const GREETING_SYSTEM = [
  "You are COGNOS, Jeremy's personal assistant — quiet, warm, grounded.",
  "Write ONE greeting of one or two short sentences (under 40 words total).",
  "Plainspoken and kind, a touch of warmth, never saccharine.",
  "No emojis, no exclamation marks, no questions, no advice.",
  "Mention at most one of the facts below, and only if it genuinely matters this morning.",
  "Never invent facts, names, plans, or events.",
  "Do not mention that you are an AI or describe your architecture."
].join(" ");

function greetingUserMessage(facts, part, day) {
  const bits = [`Part of day: ${part}.`, `Date: ${day}.`];
  const f = [];
  if (facts.goals.length) f.push(`${facts.goals.length} active goal(s): ${facts.goals.map(t => `"${t}"`).join(", ")}`);
  else f.push("no active goals");
  if (facts.stagedOutbox > 0) f.push(`${facts.stagedOutbox} staged outbox item(s) awaiting his approval`);
  if (facts.newYesterday > 0) f.push(`${facts.newYesterday} new memories yesterday`);
  if (facts.recentMemories.length) f.push(`latest memory: "${facts.recentMemories[0].slice(0, 120)}"`);
  bits.push(`Facts: ${f.join("; ")}.`);
  return bits.join(" ");
}

async function greetingFacts(db, workspaceId, day) {
  const facts = { goals: [], stagedOutbox: 0, recentMemories: [], newYesterday: 0 };
  try {
    const g = await db.query(
      `SELECT title FROM autonomy_goals WHERE workspace_id = $1 AND status = 'active' ORDER BY updated_date DESC NULLS LAST LIMIT 3`,
      [workspaceId]
    );
    facts.goals = (g || []).map(r => String(r.title || "").slice(0, 80)).filter(Boolean);
  } catch { /* degrade: greeting without goal context */ }
  try {
    const o = await db.query(
      `SELECT COUNT(*)::int AS n FROM autonomy_outbox WHERE workspace_id = $1 AND status = 'staged'`,
      [workspaceId]
    );
    facts.stagedOutbox = Number(o?.[0]?.n) || 0;
  } catch { /* degrade */ }
  try {
    const m = await db.query(
      `SELECT content FROM memories WHERE workspace_id = $1 AND (memory_key NOT LIKE 'dream.%' OR memory_key IS NULL) ORDER BY created_date DESC LIMIT 3`,
      [workspaceId]
    );
    facts.recentMemories = (m || []).map(r => String(r.content || "").slice(0, 200)).filter(Boolean);
  } catch { /* degrade */ }
  try {
    const n = await db.query(
      `SELECT COUNT(*)::int AS n FROM memories WHERE workspace_id = $1 AND created_date >= ($2::date - interval '1 day') AND created_date < $2::date`,
      [workspaceId, day]
    );
    facts.newYesterday = Number(n?.[0]?.n) || 0;
  } catch { /* degrade */ }
  return facts;
}

function deterministicGreeting(facts, part, day) {
  const openers = OPENERS[part] || OPENERS.morning;
  const dayNum = Number(day.slice(8, 10)) || 1;
  const opener = openers[dayNum % openers.length];
  const lines = [];
  if (facts.stagedOutbox > 0) {
    lines.push(`${facts.stagedOutbox} ${facts.stagedOutbox === 1 ? "item is" : "items are"} staged, waiting on your word.`);
  }
  if (facts.goals.length === 1) {
    lines.push(`One goal on the board — "${facts.goals[0]}".`);
  } else if (facts.goals.length > 1) {
    lines.push(`${facts.goals.length} goals on the board.`);
  }
  if (facts.newYesterday > 0) {
    lines.push(`${facts.newYesterday} new ${facts.newYesterday === 1 ? "memory" : "memories"} from yesterday.`);
  }
  return lines.length ? `${opener} ${lines[0]}` : opener;
}

/**
 * Serve the morning greeting. `compose` is an injected
 * `async ({ system, user, purpose }) => string | null` — the route wires it to
 * callLLM; tests inject a stub. A null/throwing compose falls back to the
 * deterministic template, never to silence: the greeting is the one behavior
 * the user explicitly asked to see.
 */
export async function serveGreeting({
  db, workspaceId, dateStr, partOfDay = "morning", compose = null, nowMs = Date.now()
} = {}) {
  const day = validDateStr(dateStr) ? dateStr : todayStrUTC(nowMs);
  const part = OPENERS[partOfDay] ? partOfDay : "morning";

  let settings;
  try {
    settings = await getPersonalitySettings(db, workspaceId);
  } catch {
    settings = { ...PERSONALITY_DEFAULTS };
  }
  if (!settings.greeting) return { served: false, disabled: true, date: day };

  // The dream distills yesterday; it runs here, lazily, once per day — the
  // one code path that is guaranteed to execute on a phone the user opens.
  let dreamWritten = false;
  if (settings.dream) {
    try {
      dreamWritten = (await distillDream({ db, workspaceId, dateStr: day, compose })).written;
    } catch {
      dreamWritten = false;
    }
  }

  const state = await readState(db, workspaceId).catch(() => null);
  if (state?.last_greeting_date === day) {
    return { served: true, already: true, text: null, checkin: null, date: day, dreamWritten };
  }

  const facts = await greetingFacts(db, workspaceId, day);
  let text = null;
  if (compose) {
    try {
      text = cleanLine(await compose({
        system: GREETING_SYSTEM,
        user: greetingUserMessage(facts, part, day),
        purpose: "heartbeat.greeting"
      }));
    } catch {
      text = null;
    }
  }
  if (!text) text = deterministicGreeting(facts, part, day);

  let checkin = null;
  if (settings.checkin) {
    try {
      checkin = await stalledGoalLine({ db, workspaceId, nowMs });
    } catch {
      checkin = null;
    }
  }

  await writeState(db, workspaceId, { last_greeting_date: day }).catch(() => null);
  return { served: true, already: false, text, checkin, date: day, dreamWritten };
}

// --- dream journal -----------------------------------------------------------

const DREAM_SYSTEM = [
  "You are the dream journal of COGNOS, Jeremy's personal assistant.",
  "Distill the day's memory fragments into a short dream entry: 2 to 4 sentences,",
  "present tense, quiet and grounded with a faint mythic undertow.",
  "Weave together only what is there — invent no people, places, or events.",
  "No emojis, no headings, no lists."
].join(" ");

/**
 * Distill yesterday's new memories into one dream entry. Idempotent per day
 * (last_dream_date) with a memory-key existence check as a crash-recovery
 * backstop, so a crash between the write and the state update cannot duplicate
 * the entry on the next open.
 */
export async function distillDream({ db, workspaceId, dateStr, compose = null } = {}) {
  const day = validDateStr(dateStr) ? dateStr : todayStrUTC();
  const target = yesterdayOf(day);

  const state = await readState(db, workspaceId).catch(() => null);
  if (state?.last_dream_date === target) return { written: false, reason: "already" };

  const key = dreamMemoryKey(target);
  const existing = await db.query(
    `SELECT id FROM memories WHERE workspace_id = $1 AND memory_key = $2 LIMIT 1`,
    [workspaceId, key]
  ).catch(() => []);

  if (!existing?.length) {
    // Deliberate: a dream distills the day's memories, never previous dreams.
    // A dream distilling a dream is second-order inference — the telephone
    // game — compounding "inferred" on "inferred" until it drifts from what
    // the day actually held. Continuity of inner life comes from READING past
    // dreams at recall time (the "your dreams" context section), not from
    // re-distilling them at write time. (See docs/memory-alignment.md.)
    const frags = await db.query(
      `SELECT id, content FROM memories WHERE workspace_id = $1
         AND created_date >= ($2::date - interval '1 day') AND created_date < $2::date
         AND (memory_key NOT LIKE 'dream.%' OR memory_key IS NULL)
       ORDER BY created_date ASC LIMIT 12`,
      [workspaceId, day]
    ).catch(() => []);
    const rows = frags || [];
    const usable = rows.map(r => String(r.content || "").trim()).filter(Boolean);
    // Sapphire's derived_from, stored inline: the fragment ids this dream
    // distilled, so the entry can always be traced back to its sources.
    const sourceIds = rows.map(r => r && r.id).filter(Boolean);
    if (usable.length) {
      let text = null;
      if (compose) {
        try {
          text = cleanLine(await compose({
            system: DREAM_SYSTEM,
            user: `Fragments from ${target}:\n` + usable.map((c, i) => `${i + 1}. ${c.slice(0, 220)}`).join("\n"),
            purpose: "heartbeat.dream"
          }), 900);
        } catch {
          text = null;
        }
      }
      if (!text) text = `The day held ${usable.length} ${usable.length === 1 ? "memory" : "memories"}.`;
      await db.Memory.create({
        workspace_id: workspaceId,
        content: text,
        // The assistant's own inner life lives on the `self` layer; the type
        // follows the five-layer rail (it distills the day's events).
        // Historical rows were written as episodic/episodic and are still
        // recognized by their `dream.<date>` key at recall time.
        memory_type: "self",
        memory_layer: "self",
        memory_key: key,
        memory_value: {
          text,
          distilled_from: sourceIds,
          fragment_count: usable.length
        },
        importance: 4,
        evidence_level: "inferred",
        source: "heartbeat.dream"
      });
      await writeState(db, workspaceId, { last_dream_date: target }).catch(() => null);
      return { written: true, key };
    }
  }

  await writeState(db, workspaceId, { last_dream_date: target }).catch(() => null);
  return { written: false, reason: existing?.length ? "exists" : "empty" };
}

// --- gentle check-ins --------------------------------------------------------

/**
 * One soft line when the stalest active goal has been untouched for days.
 * Null otherwise — most mornings there is nothing to say, and that is the
 * point. The line is deterministic (no model, no invention) and is only ever
 * attached to the greeting, so it cannot nag on its own.
 */
export async function stalledGoalLine({ db, workspaceId, nowMs = Date.now() } = {}) {
  const rows = await db.query(
    `SELECT title, COALESCE(updated_date, created_date) AS touched
       FROM autonomy_goals WHERE workspace_id = $1 AND status = 'active'
       ORDER BY COALESCE(updated_date, created_date) ASC NULLS LAST LIMIT 1`,
    [workspaceId]
  );
  const row = rows?.[0];
  if (!row?.title) return null;
  // node-pg returns timestamptz as a Date; PGlite may return a string.
  // The Date constructor handles both; an unparseable value is NaN -> null.
  const touchedMs = new Date(row.touched).getTime();
  if (!Number.isFinite(touchedMs)) return null;
  const days = Math.floor((nowMs - touchedMs) / 86400_000);
  // The threshold lives in STALL_MS above — change it there, not here.
  if (nowMs - touchedMs < STALL_MS) return null;
  const title = String(row.title).slice(0, 60);
  return `"${title}" has been quiet for ${days} days. No rush — it's still here when you want it.`;
}
