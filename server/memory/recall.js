// Priced graph-walk recall — Sapphire's retrieval idea, reimplemented in
// COGNOS's own code and style (ideas only; no Sapphire code).
//
// Recall is a Dijkstra walk over the memory graph with a cost budget and a
// depth cap of 2. Reaching a memory spends budget; important memories cost
// LESS, so the walk spends itself on what matters and runs dry on noise.
//
// Jeremy's correction, wired in as first-class pricing (not tiebreakers):
// recall used to be temporally ungrounded — a days-old "just got home from
// work" could surface next to a fresh "about to take a nap" as if both were
// live, and it felt like a roll of the dice. So age and volatility price
// every hop: older memories cost more to reach, and high-volatility
// transient states get stale fast. A stale-but-important transient state
// can never outrank a fresh one on importance alone.
//
// Restraint, honored in code: `recall_count` / `last_recalled` are recorded
// on every recall (recordRecall) and are NEVER read by any ranking or
// pricing function below. Instrumentation, not pricing.

import { adjacencyFromEdges } from "./edges.js";
import { normalizeMemoryLayer } from "./structure.js";

/** Abstract cost units the walk may spend per recall. */
export const RECALL_BUDGET = 20;
/** Sapphire's depth cap: seeds (0), their neighbors (1), neighbors-of-neighbors (2). */
export const RECALL_MAX_DEPTH = 2;

const BASE_COST = 2;
const IMPORTANCE_WEIGHT = 4;   // (1 - importanceNorm) * 4: important memories cost less
const AGE_WEIGHT = 1.5;        // per day of age, capped — temporal grounding
const AGE_CAP_DAYS = 3;
const VOLATILITY_WEIGHT = 2;   // per volatility level, scaled by staleness
const STALENESS_FULL_DAYS = 0.5; // a half-day-old transient state pays full volatility cost

const VOLATILITY_LEVELS = Object.freeze({ low: 0, medium: 1, high: 2 });

/** Importance on COGNOS's 1–10 integer scale, normalized to 0–1. */
export function importanceNorm(memory) {
  const n = Number(memory?.importance);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n / 10));
}

/** Core memories (Sapphire's ≥ 0.9): importance 9–10 on the integer scale. */
export function isCoreMemory(memory) {
  return importanceNorm(memory) >= 0.9;
}

export function ageDays(memory, nowMs = Date.now()) {
  const ts = Date.parse(memory?.created_date);
  if (!ts || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, (nowMs - ts) / 86400_000);
}

/**
 * The price of reaching a memory from a neighbor. Higher importance → lower
 * cost; older → higher cost; high volatility + age → much higher cost. A
 * fresh "about to take a nap" prices near the base cost; the same row three
 * days later prices itself out of the walk.
 */
export function traversalCost(memory, { nowMs = Date.now() } = {}) {
  const importanceTerm = (1 - importanceNorm(memory)) * IMPORTANCE_WEIGHT;
  const age = ageDays(memory, nowMs);
  const ageTerm = Math.min(age, AGE_CAP_DAYS) * AGE_WEIGHT;
  const volLevel = VOLATILITY_LEVELS[String(memory?.volatility || "").toLowerCase()] ?? 1;
  const staleness = Math.min(age / STALENESS_FULL_DAYS, 2);
  const volatilityTerm = volLevel * staleness * VOLATILITY_WEIGHT;
  return BASE_COST + importanceTerm + ageTerm + volatilityTerm;
}

/**
 * Multi-source Dijkstra over the memory graph. Seeds cost 0 (their admission
 * was decided by the semantic/LLM seed stage); every hop prices its target.
 * Returns the admitted rows ordered by walk distance — seed relevance order
 * breaks ties among seeds — capped by budget and depth. With no edges the
 * walk degrades to the seed list in seed order.
 *
 * NOTE: recall_count / last_recalled are never consulted here.
 */
export function pricedRecallWalk({
  pool = [], seedIds = [], edges = [],
  nowMs = Date.now(), budget = RECALL_BUDGET, maxDepth = RECALL_MAX_DEPTH
} = {}) {
  const byId = new Map();
  for (const m of pool || []) if (m?.id) byId.set(m.id, m);
  const seedOrder = new Map();
  (seedIds || []).forEach((id, i) => { if (!seedOrder.has(id)) seedOrder.set(id, i); });

  const adj = adjacencyFromEdges(edges);
  const dist = new Map();
  const depth = new Map();
  const pq = [];
  const push = (id, d, dep) => {
    if (d > budget) return;
    if (dist.has(id) && dist.get(id) <= d) return;
    dist.set(id, d);
    depth.set(id, dep);
    pq.push({ id, d });
  };
  for (const id of seedIds || []) {
    if (byId.has(id)) push(id, 0, 0);
  }
  while (pq.length) {
    pq.sort((a, b) => a.d - b.d);
    const { id, d } = pq.shift();
    if (d !== dist.get(id) || d > budget) continue;   // stale queue entry
    const dep = depth.get(id);
    if (dep >= maxDepth) continue;                    // depth capped
    for (const { to } of adj.get(id) || []) {
      const row = byId.get(to);
      if (!row) continue;
      push(to, d + traversalCost(row, { nowMs }), dep + 1);
    }
  }
  return [...dist.entries()]
    .filter(([id, d]) => d <= budget && byId.has(id))
    .sort((a, b) =>
      a[1] - b[1]
      || (seedOrder.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (seedOrder.get(b[0]) ?? Number.MAX_SAFE_INTEGER)
      || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => byId.get(id));
}

// --- contradiction handling --------------------------------------------------
// When two memories imply incompatible current states, the newer wins and the
// older must NOT surface alongside it as if equally live — it is excluded,
// not merely ranked lower. The deterministic mechanism is the stable
// memory_key: transient current-state facts share one key per subject
// (e.g. `user.state.activity`), and the librarian's dedup pass retires the
// superseded ones outright (see librarian.js).

const TRANSIENT_LAYER = "events";

/** A transient current-state claim: high-volatility, on the events layer, keyed. */
export function isTransientClaim(memory) {
  return String(memory?.volatility || "").toLowerCase() === "high"
    && normalizeMemoryLayer(memory?.memory_layer, memory?.memory_type) === TRANSIENT_LAYER
    && Boolean(memory?.memory_key);
}

/** Freshness for supersede ordering: creation or last confirmation, whichever is newer. */
export function freshnessTs(memory) {
  const created = Date.parse(memory?.created_date) || 0;
  const confirmed = Date.parse(memory?.last_confirmed) || 0;
  return Math.max(created, confirmed);
}

/**
 * Collapse same-key transient claims to the freshest per key. Losers are
 * dropped from the admitted set entirely. Everything else passes through in
 * order. Pure and synchronous — safe to unit-test Jeremy's exact symptom.
 */
export function supersedeTransientClaims(memories = [], { nowMs = Date.now() } = {}) {
  void nowMs;
  const winners = new Map(); // key -> row
  for (const m of memories || []) {
    if (!isTransientClaim(m)) continue;
    const key = String(m.memory_key);
    const cur = winners.get(key);
    if (!cur) { winners.set(key, m); continue; }
    const ft = freshnessTs(m), fc = freshnessTs(cur);
    if (ft > fc || (ft === fc && Number(m.importance || 0) > Number(cur.importance || 0))) {
      winners.set(key, m);
    }
  }
  const winnerIds = new Set([...winners.values()].map(m => m.id));
  return (memories || []).filter(m => !isTransientClaim(m) || winnerIds.has(m.id));
}

// --- instrumentation ---------------------------------------------------------
// Recorded on every recall; never used for ranking. The UPDATE is best-effort:
// instrumentation must never break or slow the turn.

/**
 * Bump recall_count and stamp last_recalled for the admitted ids. Returns the
 * number of rows touched. Never throws.
 */
export async function recordRecall(run, ids, { nowMs = Date.now() } = {}) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length || typeof run !== "function") return 0;
  try {
    const rows = await run(
      `UPDATE memories SET recall_count = recall_count + 1, last_recalled = $1 WHERE id = ANY($2) RETURNING id`,
      [new Date(nowMs).toISOString(), list]
    );
    return rows.length;
  } catch {
    return 0;
  }
}
