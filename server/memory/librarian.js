// The librarian — COGNOS's nightly groundskeeper. Sapphire's idea,
// reimplemented in COGNOS's own code and style (ideas only; no Sapphire code).
//
// Five passes, in order — dates, link, dedup, sort, self — with verbs
// mark_processed, atomize, promote, prune (prune = soft-retire, reversible).
// A nightly round runs the decay tick FIRST (day-guarded), then the passes,
// scope by scope. It rides the existing heartbeat (no new scheduler), and a
// failed night NEVER kills the beat: every pass is individually guarded, the
// outcome lands in the librarian_runs journal, and the next day's beat tries
// again.
//
// Shield rules, enforced in code:
//   * favorites and core memories (importance >= 0.9, i.e. 9–10 on the
//     integer scale) refuse prune and atomize;
//   * a rating can never lower a core pin — the librarian never lowers
//     importance at all; only the decay tick lowers, and it skips
//     favorites and core rows;
//   * nothing hard-deletes: prune sets is_enabled = FALSE with a
//     retired_reason, always reversible via reviveMemory.

import { normalizeMemoryLayer, MEMORY_LAYERS } from "./structure.js";
import { linkMemories } from "./edges.js";
import { importanceNorm, isCoreMemory, freshnessTs, isTransientClaim } from "./recall.js";
import { buildNoticeFields } from "../autonomy/notice.js";

export const LIBRARIAN_PASSES = Object.freeze(["dates", "link", "dedup", "sort", "self"]);
export const CORE_IMPORTANCE_MIN = 9; // normalized 0.9 on the 1–10 scale

/** UTC date key for the day-guards: "2026-10-04". */
export function dayKey(nowMs = Date.now()) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export async function librarianDue(db, workspaceId, nowMs = Date.now()) {
  try {
    const t = await db.MemoryTending.get(workspaceId);
    return t?.last_librarian_date !== dayKey(nowMs);
  } catch {
    return false; // fail closed: never tend when the state is unreadable
  }
}

export async function decayDue(db, workspaceId, nowMs = Date.now()) {
  try {
    const t = await db.MemoryTending.get(workspaceId);
    return t?.last_decay_date !== dayKey(nowMs);
  } catch {
    return false;
  }
}

// --- shield ------------------------------------------------------------------

/**
 * prune and atomize are refused for favorites and core memories. promote,
 * mark_processed and rating are non-destructive and always allowed.
 */
export function shieldAllows(memory, verb) {
  if (verb !== "prune" && verb !== "atomize") return true;
  if (memory?.is_favorite === true) return false;
  if (isCoreMemory(memory)) return false;
  return true;
}

// --- verbs -------------------------------------------------------------------

export async function markProcessed(run, id, { nowMs = Date.now() } = {}) {
  await run(`UPDATE memories SET processed_at = $1 WHERE id = $2`,
    [new Date(nowMs).toISOString(), id]);
  return { ok: true, id };
}

/**
 * Soft-retire a row. The row stays in the table with its history; the
 * retired_reason says why. Reversible via reviveMemory. Favorites and core
 * memories refuse.
 */
export async function pruneMemory(db, id, reason = "librarian_prune") {
  const memory = await db.Memory.get(id);
  if (!memory) return { ok: false, reason: "not_found", id };
  if (!shieldAllows(memory, "prune")) return { ok: false, refused: true, id };
  await db.Memory.update(id, { is_enabled: false, retired_reason: reason });
  return { ok: true, id, reason };
}

/** Reverse a prune. The knowledge was never destroyed, only parked. */
export async function reviveMemory(db, id) {
  const memory = await db.Memory.get(id);
  if (!memory) return { ok: false, reason: "not_found", id };
  await db.Memory.update(id, { is_enabled: true, retired_reason: null });
  return { ok: true, id };
}

function parseValue(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try { const p = JSON.parse(value); return p && typeof p === "object" ? p : {}; }
    catch { return {}; }
  }
  return {};
}

/**
 * Split one memory into parts. Each part becomes a new row carrying a
 * derived_from edge back to the original; the original is soft-retired with
 * retired_reason "atomized" (reversible). Favorites and core memories refuse.
 */
export async function atomizeMemory(db, id, parts = [], { created_by = "librarian", nowMs = Date.now() } = {}) {
  const memory = await db.Memory.get(id);
  if (!memory) return { ok: false, reason: "not_found", id };
  if (!shieldAllows(memory, "atomize")) return { ok: false, refused: true, id };
  const clean = (parts || []).filter(p => String(p?.content || "").trim().length > 0);
  if (!clean.length) return { ok: false, reason: "no_parts", id };
  const created = [];
  for (const part of clean) {
    const row = await db.Memory.create({
      workspace_id: memory.workspace_id,
      content: String(part.content).trim(),
      memory_layer: memory.memory_layer,
      memory_key: part.memory_key || memory.memory_key,
      memory_value: { ...parseValue(part.memory_value), atomized_from: id },
      importance: memory.importance,
      volatility: memory.volatility,
      evidence_level: memory.evidence_level,
      source: memory.source
    }, { origin: "librarian_atomize", skipEmbeddingRefresh: true });
    created.push(row);
    await linkMemories(db, {
      workspace_id: memory.workspace_id, from_memory_id: row.id, to_memory_id: id,
      edge_type: "derived_from", created_by
    }).catch(() => null);
  }
  await db.Memory.update(id, {
    is_enabled: false,
    retired_reason: "atomized",
    memory_value: { ...parseValue(memory.memory_value), atomized_into: created.map(r => r.id) }
  });
  await markProcessed(db.query, id, { nowMs });
  return { ok: true, id, parts: created.map(r => r.id) };
}

/**
 * Copy a row onto another layer (default: knowledge) with a derived_from
 * edge back to the original. A copy, never a move — the original is
 * untouched, so core rows keep their pin exactly where it was.
 */
export async function promoteMemory(db, id, targetLayer = "knowledge", { created_by = "librarian", nowMs = Date.now() } = {}) {
  const memory = await db.Memory.get(id);
  if (!memory) return { ok: false, reason: "not_found", id };
  if (!MEMORY_LAYERS.includes(targetLayer)) return { ok: false, reason: "bad_layer", id };
  const row = await db.Memory.create({
    workspace_id: memory.workspace_id,
    content: memory.content,
    memory_layer: targetLayer,
    memory_key: memory.memory_key,
    memory_value: {
      ...parseValue(memory.memory_value),
      promoted_from: id,
      promoted_from_layer: normalizeMemoryLayer(memory.memory_layer, memory.memory_type)
    },
    importance: memory.importance,
    volatility: "low", // promoted reference material is durable by definition
    evidence_level: memory.evidence_level,
    source: memory.source
  }, { origin: "librarian_promote", skipEmbeddingRefresh: true });
  await linkMemories(db, {
    workspace_id: memory.workspace_id, from_memory_id: row.id, to_memory_id: id,
    edge_type: "derived_from", created_by
  }).catch(() => null);
  await markProcessed(db.query, id, { nowMs });
  return { ok: true, id: row.id, from: id, layer: targetLayer };
}

// --- nightly importance decay ------------------------------------------------
// Genuine Sapphire physiology: importance fades a little every night, so the
// priced walk gradually spends its budget elsewhere. The rate is a function
// of volatility — transient states fade in hours-to-a-day, durable facts
// barely move. Favorites and core memories never decay. This CHANGES recall
// behavior, so the first night it moves a row, Jeremy gets a plain-language
// notice saying so.

export const DECAY_HALF_LIFE_DAYS = Object.freeze({ high: 0.5, medium: 7, low: 60 });

/** Per-night multiplicative factor for a volatility class. */
export function decayFactor(volatility) {
  const key = String(volatility || "").toLowerCase();
  const halfLife = DECAY_HALF_LIFE_DAYS[key] ?? DECAY_HALF_LIFE_DAYS.medium;
  return Math.pow(0.5, 1 / halfLife);
}

export async function runDecayTick({ db, workspaceId, logger = null, nowMs = Date.now() } = {}) {
  const run = db.query;
  if (!(await decayDue(db, workspaceId, nowMs))) return { decayed: 0, skipped: true };
  let decayed = 0;
  for (const vol of ["high", "medium", "low"]) {
    const factor = decayFactor(vol);
    // The shield in SQL: favorites and core rows (importance >= 9) are never
    // touched; importance floors at 1; rows only update when the rounded
    // value actually drops, so stable memories cause no write churn. The
    // factor is a fractional multiplier — cast it explicitly, otherwise
    // Postgres infers integer from `importance * $1` and rejects "0.25".
    const rows = await run(
      `UPDATE memories SET importance = GREATEST(1, ROUND(importance * $1::double precision))
       WHERE workspace_id = $2 AND is_enabled = TRUE
         AND COALESCE(is_favorite, FALSE) = FALSE
         AND COALESCE(importance, 5) < $4
         AND COALESCE(volatility, 'medium') = $3
         AND GREATEST(1, ROUND(importance * $1::double precision)) < COALESCE(importance, 5)
       RETURNING id`,
      [factor, workspaceId, vol, CORE_IMPORTANCE_MIN]
    );
    decayed += rows.length;
  }
  await db.MemoryTending.markDecay(workspaceId, dayKey(nowMs));
  if (decayed > 0) {
    const t = await db.MemoryTending.get(workspaceId).catch(() => null);
    if (t && !t.decay_announced) {
      try {
        const fields = buildNoticeFields("memory_decay_live", { fadedCount: decayed });
        if (fields) {
          await db.AutonomyNotice.create({
            workspace_id: workspaceId, template_id: "memory_decay_live",
            fields, severity: "info"
          });
        }
        await db.MemoryTending.setDecayAnnounced(workspaceId);
      } catch (e) {
        logger?.warn?.("decay announcement failed", { error: String(e?.message || e).slice(0, 200) });
      }
    }
  }
  logger?.info?.("memory decay tick", { workspaceId, decayed });
  return { decayed };
}

// --- passes ------------------------------------------------------------------
// Heuristic, deterministic, no model calls: the night shift is mechanical.

const PASS_BATCH = 200;

const RELATIVE_DAY_OFFSETS = Object.freeze({
  today: 0, tonight: 0, yesterday: -1, "last night": -1, tomorrow: 1
});

/**
 * Pull temporal references out of free text. Returns { event_date, refs } —
 * event_date is the first solid date found (ISO first, then relative words),
 * refs is everything spotted. Heuristic; the librarian stamps, never invents.
 */
export function extractTemporalRefs(content, nowMs = Date.now()) {
  const text = String(content || "");
  const refs = [];
  let event_date = null;
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = `${iso[1]}-${iso[2]}-${iso[3]}`;
    if (!Number.isNaN(Date.parse(d))) { event_date = d; refs.push(d); }
  }
  const lower = text.toLowerCase();
  for (const [word, offset] of Object.entries(RELATIVE_DAY_OFFSETS)) {
    if (lower.includes(word)) {
      refs.push(word);
      if (!event_date) {
        const dt = new Date(nowMs + offset * 86400_000);
        event_date = dt.toISOString().slice(0, 10);
      }
    }
  }
  return { event_date, refs };
}

/** Dates pass: stamp when things happened onto unprocessed event rows. */
async function passDates({ db, workspaceId, nowMs }) {
  const run = db.query;
  const rows = await run(
    `SELECT id, content, memory_value FROM memories
     WHERE workspace_id = $1 AND is_enabled = TRUE AND processed_at IS NULL
       AND memory_layer = 'events'
     ORDER BY created_date ASC LIMIT $2`, [workspaceId, PASS_BATCH]);
  let stamped = 0;
  for (const r of rows) {
    const { event_date } = extractTemporalRefs(r.content, nowMs);
    const stamp = new Date(nowMs).toISOString();
    if (event_date) {
      const merged = { ...parseValue(r.memory_value), event_date };
      await run(`UPDATE memories SET memory_value = $1::jsonb, processed_at = $2 WHERE id = $3`,
        [JSON.stringify(merged), stamp, r.id]);
      stamped++;
    } else {
      await markProcessed(run, r.id, { nowMs });
    }
  }
  return { scanned: rows.length, stamped };
}

const LINK_STOPWORDS = new Set(
  "the,a,an,and,or,but,for,with,from,that,this,these,those,was,were,are,is,be,been,being,have,has,had,will,would,should,could,about,into,over,after,before,when,where,which,what,whom,whose,just,like,more,most,much,many,some,such,than,then,there,their,they,them,he,she,his,her,its,you,your,we,our,us,i,my,me,of,to,in,on,at,by,as,do,does,did,not,no,yes,if,so,because,while,who,whom".split(",")
);

function contentTokens(text) {
  const out = new Set();
  for (const w of String(text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !LINK_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * Link pass: wire the graph. derived_from edges from inline provenance
 * (dream distillation etc.); mentions edges from real token overlap. Junk
 * is ruled connection-free rather than force-linked.
 */
async function passLink({ db, workspaceId, nowMs }) {
  const run = db.query;
  const rows = await run(
    `SELECT id, content, memory_value FROM memories
     WHERE workspace_id = $1 AND is_enabled = TRUE AND processed_at IS NULL
     ORDER BY created_date ASC LIMIT 100`, [workspaceId]);
  let derived = 0, mentions = 0;
  for (const r of rows) {
    const from = parseValue(r.memory_value)?.distilled_from;
    if (Array.isArray(from)) {
      for (const srcId of from) {
        if (typeof srcId !== "string" || !srcId) continue;
        const e = await linkMemories(db, {
          workspace_id: workspaceId, from_memory_id: r.id, to_memory_id: srcId,
          edge_type: "derived_from", created_by: "librarian"
        }).catch(() => null);
        if (e) derived++;
      }
    }
  }
  const toks = new Map(rows.map(r => [r.id, contentTokens(r.content)]));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = toks.get(rows[i].id), b = toks.get(rows[j].id);
      let shared = 0;
      for (const t of a) { if (b.has(t) && ++shared >= 3) break; }
      if (shared >= 3) {
        const e = await linkMemories(db, {
          workspace_id: workspaceId, from_memory_id: rows[i].id, to_memory_id: rows[j].id,
          edge_type: "mentions", metadata: { shared_terms: shared }, created_by: "librarian"
        }).catch(() => null);
        if (e) mentions++;
      }
    }
  }
  for (const r of rows) await markProcessed(run, r.id, { nowMs });
  return { scanned: rows.length, derived_edges: derived, mention_edges: mentions };
}

/** Dedup pass: exact duplicates collapse; superseded transient states retire. */
async function passDedup({ db, workspaceId }) {
  const run = db.query;
  const rows = await run(
    `SELECT id, content, memory_key, memory_layer, memory_type, volatility, importance,
            is_favorite, created_date, last_confirmed
     FROM memories WHERE workspace_id = $1 AND is_enabled = TRUE
     ORDER BY created_date DESC LIMIT 1000`, [workspaceId]);
  let retiredDupes = 0, retiredSuperseded = 0, refused = 0;
  const byContent = new Map();
  for (const r of rows) {
    const k = String(r.content || "").trim();
    if (!k) continue;
    if (!byContent.has(k)) byContent.set(k, []);
    byContent.get(k).push(r);
  }
  for (const group of byContent.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) =>
      freshnessTs(b) - freshnessTs(a) || Number(b.importance || 0) - Number(a.importance || 0));
    for (const loser of sorted.slice(1)) {
      const res = await pruneMemory(db, loser.id, "exact_duplicate");
      if (res.ok) retiredDupes++; else if (res.refused) refused++;
    }
  }
  // Jeremy's symptom, tended nightly: two transient states sharing one key
  // cannot both stay live — the older retires, the freshest stands.
  const byKey = new Map();
  for (const r of rows) {
    if (!isTransientClaim(r)) continue;
    const k = String(r.memory_key);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => freshnessTs(b) - freshnessTs(a));
    for (const loser of sorted.slice(1)) {
      const res = await pruneMemory(db, loser.id, "superseded_transient_state");
      if (res.ok) retiredSuperseded++; else if (res.refused) refused++;
    }
  }
  return {
    scanned: rows.length,
    retired_exact_duplicates: retiredDupes,
    retired_superseded_transients: retiredSuperseded,
    shield_refusals: refused
  };
}

const SORT_PROMOTE_MIN_IMPORTANCE = 7;
const SORT_PROMOTE_MAX_PER_NIGHT = 10;
const SORT_PRUNE_MAX_PER_NIGHT = 25;

/**
 * Sort pass: the judgment pass. Durable, important event material is
 * promoted (copied) into knowledge; tiny stale fragments are pruned.
 * Ratings only ever go up, never above 8, and never touch core or favorite
 * rows — a rating can never lower a core pin, and the librarian mints no
 * new core rows.
 */
async function passSort({ db, workspaceId, nowMs }) {
  const run = db.query;
  const rows = await run(
    `SELECT id, content, memory_layer, memory_type, volatility, importance,
            is_favorite, recall_count, created_date
     FROM memories WHERE workspace_id = $1 AND is_enabled = TRUE AND processed_at IS NOT NULL
     ORDER BY created_date ASC LIMIT 500`, [workspaceId]);
  let promoted = 0, pruned = 0, rerated = 0;
  const weekAgo = nowMs - 7 * 86400_000;
  const monthAgo = nowMs - 30 * 86400_000;
  for (const r of rows) {
    const created = Date.parse(r.created_date) || nowMs;
    const layer = normalizeMemoryLayer(r.memory_layer, r.memory_type);
    if (promoted < SORT_PROMOTE_MAX_PER_NIGHT
        && layer === "events"
        && Number(r.importance) >= SORT_PROMOTE_MIN_IMPORTANCE
        && String(r.volatility || "").toLowerCase() === "low"
        && created < weekAgo) {
      const res = await promoteMemory(db, r.id, "knowledge");
      if (res.ok) promoted++;
      continue;
    }
    if (pruned < SORT_PRUNE_MAX_PER_NIGHT
        && String(r.content || "").length < 60
        && Number(r.importance) <= 3
        && created < monthAgo) {
      const res = await pruneMemory(db, r.id, "stale_fragment");
      if (res.ok) pruned++;
      continue;
    }
    if (Number(r.recall_count) >= 5 && Number(r.importance) < 8
        && r.is_favorite !== true && !isCoreMemory(r)) {
      await run(`UPDATE memories SET importance = LEAST(8, importance + 1) WHERE id = $1`, [r.id]);
      rerated++;
    }
  }
  return { scanned: rows.length, promoted, pruned_stale_fragments: pruned, rerated };
}

/**
 * Self pass: tend the assistant's own layer. Guarantees the self sheet
 * exists (memory_key self.sheet); marks self rows processed. The sheet is
 * never pruned here — it is tended, not tidied.
 */
async function passSelf({ db, workspaceId, nowMs }) {
  const run = db.query;
  let sheetCreated = false;
  const existing = await run(
    `SELECT id FROM memories WHERE workspace_id = $1 AND memory_key = 'self.sheet' AND is_enabled = TRUE LIMIT 1`,
    [workspaceId]);
  if (!existing.length) {
    await db.Memory.create({
      workspace_id: workspaceId,
      content: "Self sheet — who COGNOS is, in its own words. Tended by the librarian; sections live here, never scattered.",
      memory_layer: "self",
      memory_key: "self.sheet",
      memory_value: { sections: {} },
      importance: 8,
      volatility: "low",
      evidence_level: "direct",
      source: "librarian"
    }, { origin: "librarian_self", skipEmbeddingRefresh: true });
    sheetCreated = true;
  }
  const rows = await run(
    `SELECT id FROM memories WHERE workspace_id = $1 AND is_enabled = TRUE
       AND memory_layer = 'self' AND processed_at IS NULL LIMIT 100`, [workspaceId]);
  for (const r of rows) await markProcessed(run, r.id, { nowMs });
  return { scanned: rows.length, sheet_created: sheetCreated };
}

const PASSES = Object.freeze({
  dates: passDates,
  link: passLink,
  dedup: passDedup,
  sort: passSort,
  self: passSelf
});

/**
 * One full night: the decay tick first (day-guarded), then the five passes in
 * order. Each pass is individually guarded — a failed pass is recorded in the
 * journal and the night continues. The day-guard advances whenever the round
 * was attempted, so a bad night doesn't retry every beat.
 */
export async function runLibrarian({ db, workspaceId, logger = null, nowMs = Date.now() } = {}) {
  const started = nowMs;
  const passes = {};
  let decayed = 0;
  let error = null;
  let runRow = null;
  try { runRow = await db.LibrarianRun.start(workspaceId, started); }
  catch (e) { logger?.warn?.("librarian journal unavailable", { error: String(e?.message || e).slice(0, 200) }); }
  try {
    try {
      const decay = await runDecayTick({ db, workspaceId, logger, nowMs });
      decayed = decay.decayed;
      passes.decay = { decayed, skipped: Boolean(decay.skipped) };
    } catch (e) {
      passes.decay = { error: String(e?.message || e).slice(0, 200) };
      logger?.warn?.("librarian decay tick failed", { error: String(e?.message || e).slice(0, 200) });
    }
    for (const name of LIBRARIAN_PASSES) {
      try {
        passes[name] = await PASSES[name]({ db, workspaceId, logger, nowMs });
      } catch (e) {
        passes[name] = { error: String(e?.message || e).slice(0, 200) };
        logger?.warn?.("librarian pass failed", { pass: name, error: String(e?.message || e).slice(0, 200) });
      }
    }
    await db.MemoryTending.markLibrarian(workspaceId, dayKey(nowMs));
  } catch (e) {
    error = String(e?.message || e).slice(0, 300);
    logger?.warn?.("librarian round failed", { error });
  }
  if (runRow) {
    try { await db.LibrarianRun.finish(runRow.id, { passes, decayed, error }); }
    catch (e) { logger?.warn?.("librarian journal finish failed", { error: String(e?.message || e).slice(0, 200) }); }
  }
  return { ok: !error, passes, decayed, error };
}

export { importanceNorm };
