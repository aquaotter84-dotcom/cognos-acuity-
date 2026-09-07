// Phase 14.2 / 14.3 / 14.5 — beliefs: the knowledge layer's current state.
//
// A belief is a statement the system holds, with a confidence that moves over
// time. Beliefs are created from memory writes (the honest source: what the
// council was told and stored), reinforced when they recur, weakened when the
// council's own output contradicts them, and retired — never deleted — when
// they can no longer be defended.
//
// Every function here takes a query runner and appends its own ledger events on
// that same runner, so a caller inside withTransaction() gets the write and its
// history committed or rolled back together. Nothing in this module ever issues
// a DELETE against beliefs.

import { newId, num, clamp01, int, nowMs } from "../db/util.js";
import { appendEvents, parse } from "./events.js";
import { transferLinksOnRetirement } from "./relationships.js";

// The projection recorded in every to_state. The fold of the ledger reproduces
// exactly these fields, so `fold(now)` and the materialized row must agree —
// server/knowledge/replay.js checks that and reports drift.
export const BELIEF_TRACKED_FIELDS = Object.freeze([
  "statement", "status", "hypothesis", "confidence", "evidence_level", "volatility",
  "support_count", "contradict_count", "first_seen_ms", "last_confirmed_ms",
  "retired_at_ms", "successor_id"
]);

export function beliefState(row) {
  if (!row) return null;
  return {
    statement: row.statement ?? null,
    status: row.status ?? "active",
    hypothesis: Boolean(row.hypothesis),
    confidence: num(row.confidence, 0.5),
    evidence_level: row.evidence_level ?? "inferred",
    volatility: row.volatility ?? "medium",
    support_count: int(row.support_count, 1),
    contradict_count: int(row.contradict_count, 0),
    first_seen_ms: int(row.first_seen_ms, 0),
    last_confirmed_ms: int(row.last_confirmed_ms, 0),
    retired_at_ms: row.retired_at_ms === null || row.retired_at_ms === undefined ? null : int(row.retired_at_ms, null),
    successor_id: row.successor_id ?? null
  };
}

/** Normalized identity of a statement. Two memories that say the same thing in
 *  different punctuation are the same belief; anything needing real semantic
 *  equivalence is the Coherence Monitor's job, not a string comparison's. */
export function statementKey(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(the user|user|i|they|he|she)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** Starting confidence for a belief derived from a memory. Evidence leads,
 *  importance nudges. Deliberately conservative: an assumption never starts
 *  above 0.45, so it takes real support to become load-bearing. */
export function confidenceFromEvidence({ evidence_level, importance } = {}, table = {}) {
  const base = num(table[evidence_level], null) ?? {
    direct: 0.85, repeated: 0.75, inferred: 0.55, assumed: 0.35
  }[evidence_level] ?? 0.5;
  const nudge = ((int(importance, 5) - 5) / 5) * 0.1;
  return Number(clamp01(base + nudge).toFixed(4));
}

function lineageOf(row, eventIds, runId) {
  const prev = parse(row?.lineage) || {};
  const events = Array.from(new Set([...(Array.isArray(prev.events) ? prev.events : []), ...eventIds])).slice(-12);
  const runs = Array.from(new Set([...(Array.isArray(prev.runs) ? prev.runs : []), ...(runId ? [runId] : [])])).slice(-8);
  return { created_run_id: prev.created_run_id ?? runId ?? null, created_message_id: prev.created_message_id ?? null, events, runs };
}

export async function findBelief(run, workspaceId, key) {
  const rows = await run(`SELECT * FROM beliefs WHERE workspace_id = $1 AND statement_key = $2 LIMIT 1`, [workspaceId, key]);
  return rows[0] || null;
}

export async function getBelief(run, id) {
  const rows = await run(`SELECT * FROM beliefs WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** The belief pool the Coherence Monitor reasons against: active and hypothesis
 *  rows, most-confident and most-recently-confirmed first, capped. */
export async function beliefPool(run, workspaceId, limit = 12) {
  return run(
    `SELECT * FROM beliefs
      WHERE workspace_id = $1 AND status IN ('active','weakened','hypothesis')
      ORDER BY confidence DESC, last_confirmed_ms DESC
      LIMIT $2`,
    [workspaceId, Math.max(1, Math.min(int(limit, 12), 50))]
  );
}

export async function listBeliefs(run, workspaceId, { status = null, limit = 100 } = {}) {
  const params = [workspaceId];
  let where = "workspace_id = $1";
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  params.push(Math.max(1, Math.min(int(limit, 100), 500)));
  return run(`SELECT * FROM beliefs WHERE ${where} ORDER BY updated_date DESC LIMIT $${params.length}`, params);
}

// --- writes ----------------------------------------------------------------

async function insertBelief(run, b) {
  const rows = await run(
    `INSERT INTO beliefs (id, workspace_id, statement, statement_key, status, hypothesis, confidence,
                          evidence_level, volatility, source_memory_id, support_count, contradict_count,
                          first_seen_ms, last_confirmed_ms, lineage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [b.id, b.workspace_id, b.statement, b.statement_key, b.status, b.hypothesis, b.confidence,
     b.evidence_level, b.volatility, b.source_memory_id ?? null, b.support_count ?? 1, b.contradict_count ?? 0,
     b.first_seen_ms, b.last_confirmed_ms, JSON.stringify(b.lineage ?? {})]
  );
  return rows[0];
}

async function updateBelief(run, id, patch) {
  const cols = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    values.push(k === "lineage" ? JSON.stringify(v) : v);
    cols.push(`${k} = $${values.length}`);
  }
  if (!cols.length) return getBelief(run, id);
  cols.push(`updated_date = now()`);
  values.push(id);
  const rows = await run(`UPDATE beliefs SET ${cols.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
  return rows[0] || null;
}

async function recordConfidence(run, { entityType, entityId, confidence, prev, sourceEventId, sourceRunId, tsMs }) {
  await run(
    `INSERT INTO confidence_history (id, entity_type, entity_id, confidence, prev_confidence, delta, source_event_id, source_run_id, ts_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId("cfh"), entityType, entityId, confidence, prev ?? null,
     prev === null || prev === undefined ? null : Number((confidence - prev).toFixed(4)),
     sourceEventId ?? null, sourceRunId ?? null, tsMs]
  );
}

/**
 * A memory row was written. Project it into the belief store: create the belief,
 * or strengthen the one that already says this. Returns the events appended.
 */
export async function projectMemoryWrite(run, { memory, source = {}, config = {} }) {
  const workspaceId = memory.workspace_id;
  const key = statementKey(memory.content);
  if (!key) return { belief: null, events: [], created: false };
  const ts = nowMs();
  const existing = await findBelief(run, workspaceId, key);
  const confidence = num(memory.confidence, null) ?? confidenceFromEvidence(memory, config.confidenceFromEvidence);

  if (!existing) {
    const id = newId("bel");
    const created = await insertBelief(run, {
      id,
      workspace_id: workspaceId,
      statement: String(memory.content).trim(),
      statement_key: key,
      status: "active",
      hypothesis: false,
      confidence,
      evidence_level: memory.evidence_level || "inferred",
      volatility: memory.volatility || "medium",
      source_memory_id: memory.id,
      support_count: 1,
      contradict_count: 0,
      first_seen_ms: ts,
      last_confirmed_ms: ts
    });
    const events = await appendEvents(run, [{
      workspaceId,
      entityType: "belief",
      entityId: id,
      transition: "belief_created",
      toState: { ...beliefState(created), id, statement_key: key, source_memory_id: memory.id },
      delta: { confidence },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? memory.source ?? null,
      sourceKind: source.kind || "run",
      payload: { origin: "memory_write", memory_id: memory.id, evidence_level: memory.evidence_level || "inferred" }
    }]);
    await recordConfidence(run, { entityType: "belief", entityId: id, confidence, prev: null, sourceEventId: events[0]?.id, sourceRunId: source.runId ?? null, tsMs: ts });
    await updateBelief(run, id, { lineage: lineageOf(created, events.map(e => e.id), source.runId ?? null) });
    return { belief: await getBelief(run, id), events, created: true };
  }

  // Recurrence: the same statement was stored again. Support, do not duplicate.
  const prevConfidence = num(existing.confidence, 0.5);
  const gain = num(config.confirmationGain, 0.1);
  const confidence2 = Number(clamp01(prevConfidence + gain * (1 - prevConfidence)).toFixed(4));
  const wasHypothesis = Boolean(existing.hypothesis) || existing.status === "hypothesis";
  const status = wasHypothesis ? "active" : (existing.status === "retired" ? "active" : (confidence2 >= num(config.weakenBelow, 0.5) ? "active" : existing.status));
  const patch = {
    status,
    hypothesis: false,
    confidence: confidence2,
    support_count: int(existing.support_count, 1) + 1,
    last_confirmed_ms: ts,
    retired_at_ms: null,
    evidence_level: strongerEvidence(existing.evidence_level, memory.evidence_level)
  };
  const events = await appendEvents(run, [
    {
      workspaceId,
      entityType: "belief",
      entityId: existing.id,
      transition: wasHypothesis ? "hypothesis_confirmed" : (existing.status === "retired" ? "belief_reinstated" : "belief_confirmed"),
      fromState: beliefState(existing),
      toState: { ...beliefState(existing), ...patch },
      delta: { support: 1, confidence: Number((confidence2 - prevConfidence).toFixed(4)) },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? memory.source ?? null,
      sourceKind: source.kind || "run",
      payload: { origin: "memory_write", memory_id: memory.id }
    },
    {
      workspaceId,
      entityType: "belief",
      entityId: existing.id,
      transition: "confidence_changed",
      fromState: { confidence: prevConfidence },
      toState: { confidence: confidence2 },
      delta: { confidence: Number((confidence2 - prevConfidence).toFixed(4)), cause: "recurrence" },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? memory.source ?? null,
      sourceKind: source.kind || "run"
    }
  ]);
  patch.lineage = lineageOf(existing, events.map(e => e.id), source.runId ?? null);
  await updateBelief(run, existing.id, patch);
  await recordConfidence(run, { entityType: "belief", entityId: existing.id, confidence: confidence2, prev: prevConfidence, sourceEventId: events[1]?.id, sourceRunId: source.runId ?? null, tsMs: ts });
  return { belief: await getBelief(run, existing.id), events, created: false };
}

const EVIDENCE_RANK = { assumed: 0, inferred: 1, repeated: 2, direct: 3 };
function strongerEvidence(a, b) {
  if (!b) return a || "inferred";
  return (EVIDENCE_RANK[b] ?? 0) > (EVIDENCE_RANK[a] ?? 0) ? b : (a || b);
}

/**
 * Phase 14.5 — the Coherence Monitor found the council's own output contradicting
 * a stored belief. A contradiction is a measurement: lower the confidence, log
 * both claims and their lineage, and retire only when it can no longer stand.
 */
export async function applyContradiction(run, { belief, claim, source = {}, config = {}, successorId = null }) {
  const ts = nowMs();
  const prevConfidence = num(belief.confidence, 0.5);
  const penalty = num(config.contradictionPenalty, 0.25) * clamp01(num(claim?.confidence, 0.7));
  const confidence = Number(Math.max(0.02, prevConfidence - penalty).toFixed(4));
  const contradictCount = int(belief.contradict_count, 0) + 1;
  const isHypothesis = Boolean(belief.hypothesis) || belief.status === "hypothesis";
  const retireBelow = num(config.retireBelow, 0.2);
  const weakenBelow = num(config.weakenBelow, 0.5);
  const abandon = isHypothesis && (confidence < retireBelow || contradictCount >= 2);
  const retire = !isHypothesis && confidence < retireBelow;
  const status = abandon || retire ? "retired" : (confidence < weakenBelow ? "weakened" : belief.status);

  const patch = {
    confidence,
    contradict_count: contradictCount,
    status,
    retired_at_ms: abandon || retire ? ts : belief.retired_at_ms ?? null,
    successor_id: successorId ?? belief.successor_id ?? null,
    hypothesis: isHypothesis && !abandon ? belief.hypothesis : false
  };

  const events = [];
  events.push({
    workspaceId: belief.workspace_id,
    entityType: "belief",
    entityId: belief.id,
    transition: "contradiction_detected",
    fromState: beliefState(belief),
    toState: { ...beliefState(belief), ...patch },
    delta: { confidence: Number((confidence - prevConfidence).toFixed(4)), contradict_count: 1 },
    sourceRunId: source.runId ?? null,
    sourceMessageId: source.messageId ?? null,
    sourceKind: source.kind || "run",
    reversible: false,
    payload: {
      stored_claim: belief.statement,
      stored_confidence: prevConfidence,
      stored_lineage: parse(belief.lineage) || null,
      new_claim: claim?.claim ?? null,
      new_claim_confidence: num(claim?.confidence, null),
      relation: "contradicts",
      note: claim?.note ?? null
    }
  });
  events.push({
    workspaceId: belief.workspace_id,
    entityType: "belief",
    entityId: belief.id,
    transition: "confidence_changed",
    fromState: { confidence: prevConfidence },
    toState: { confidence },
    delta: { confidence: Number((confidence - prevConfidence).toFixed(4)), cause: "contradiction" },
    sourceRunId: source.runId ?? null,
    sourceMessageId: source.messageId ?? null,
    sourceKind: source.kind || "run"
  });
  if (confidence < prevConfidence && status !== "retired") {
    events.push({
      workspaceId: belief.workspace_id,
      entityType: "belief",
      entityId: belief.id,
      transition: "belief_weakened",
      fromState: beliefState(belief),
      toState: { ...beliefState(belief), ...patch },
      delta: { confidence: Number((confidence - prevConfidence).toFixed(4)) },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "run"
    });
  }
  if (abandon) {
    events.push({
      workspaceId: belief.workspace_id,
      entityType: "belief",
      entityId: belief.id,
      transition: "hypothesis_abandoned",
      fromState: beliefState(belief),
      toState: { ...beliefState(belief), ...patch },
      delta: { status: "retired", contradict_count: contradictCount },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "run",
      reversible: false,
      payload: { reason: "contradicted past recovery" }
    });
  } else if (retire) {
    events.push({
      workspaceId: belief.workspace_id,
      entityType: "belief",
      entityId: belief.id,
      transition: "belief_retired",
      fromState: beliefState(belief),
      toState: { ...beliefState(belief), ...patch },
      delta: { status: "retired", confidence: Number((confidence - prevConfidence).toFixed(4)) },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "run",
      payload: { reason: "confidence below retirement floor", successor_id: patch.successor_id }
    });
  }

  const written = await appendEvents(run, events);
  patch.lineage = lineageOf(belief, written.map(e => e.id), source.runId ?? null);
  await updateBelief(run, belief.id, patch);
  await recordConfidence(run, {
    entityType: "belief", entityId: belief.id, confidence, prev: prevConfidence,
    sourceEventId: written[1]?.id ?? written[0]?.id ?? null, sourceRunId: source.runId ?? null, tsMs: ts
  });
  return {
    belief: await getBelief(run, belief.id),
    events: written,
    confidenceDelta: Number((confidence - prevConfidence).toFixed(4)),
    retired: status === "retired",
    abandoned: abandon
  };
}

/** The council's output supported a stored belief. */
export async function applyConfirmation(run, { belief, claim, source = {}, config = {} }) {
  const ts = nowMs();
  const prevConfidence = num(belief.confidence, 0.5);
  const gain = num(config.confirmationGain, 0.1) * clamp01(num(claim?.confidence, 0.7));
  const confidence = Number(clamp01(prevConfidence + gain * (1 - prevConfidence)).toFixed(4));
  const isHypothesis = Boolean(belief.hypothesis) || belief.status === "hypothesis";
  const patch = {
    confidence,
    support_count: int(belief.support_count, 1) + 1,
    last_confirmed_ms: ts,
    status: isHypothesis ? "active" : (confidence >= num(config.weakenBelow, 0.5) ? "active" : belief.status),
    hypothesis: false
  };
  const written = await appendEvents(run, [
    {
      workspaceId: belief.workspace_id,
      entityType: "belief",
      entityId: belief.id,
      transition: isHypothesis ? "hypothesis_confirmed" : "belief_confirmed",
      fromState: beliefState(belief),
      toState: { ...beliefState(belief), ...patch },
      delta: { confidence: Number((confidence - prevConfidence).toFixed(4)), support: 1 },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "run",
      payload: { claim: claim?.claim ?? null }
    },
    {
      workspaceId: belief.workspace_id,
      entityType: "belief",
      entityId: belief.id,
      transition: "confidence_changed",
      fromState: { confidence: prevConfidence },
      toState: { confidence },
      delta: { confidence: Number((confidence - prevConfidence).toFixed(4)), cause: "confirmation" },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "run"
    }
  ]);
  patch.lineage = lineageOf(belief, written.map(e => e.id), source.runId ?? null);
  await updateBelief(run, belief.id, patch);
  await recordConfidence(run, {
    entityType: "belief", entityId: belief.id, confidence, prev: prevConfidence,
    sourceEventId: written[1]?.id ?? null, sourceRunId: source.runId ?? null, tsMs: ts
  });
  return { belief: await getBelief(run, belief.id), events: written, confidenceDelta: Number((confidence - prevConfidence).toFixed(4)) };
}

/** A durable claim the council made that nothing in the store supports yet.
 *  Recorded as a hypothesis at a discount — it has to earn confidence. */
export async function proposeHypothesis(run, { claim, workspaceId, source = {}, config = {} }) {
  const statement = String(claim?.claim || "").trim();
  const key = statementKey(statement);
  if (!key || key.length < 8) return { belief: null, events: [] };
  const existing = await findBelief(run, workspaceId, key);
  if (existing) return { belief: existing, events: [], existing: true };
  const ts = nowMs();
  const confidence = Number((clamp01(num(claim?.confidence, 0.5)) * 0.6).toFixed(4));
  const id = newId("bel");
  const created = await insertBelief(run, {
    id,
    workspace_id: workspaceId,
    statement: statement.slice(0, 1000),
    statement_key: key,
    status: "hypothesis",
    hypothesis: true,
    confidence,
    evidence_level: "inferred",
    volatility: "medium",
    source_memory_id: null,
    support_count: 0,
    contradict_count: 0,
    first_seen_ms: ts,
    last_confirmed_ms: ts
  });
  const written = await appendEvents(run, [{
    workspaceId,
    entityType: "belief",
    entityId: id,
    transition: "hypothesis_proposed",
    toState: { ...beliefState(created), id, statement_key: key },
    delta: { confidence },
    sourceRunId: source.runId ?? null,
    sourceMessageId: source.messageId ?? null,
    sourceKind: source.kind || "run",
    payload: { scope: claim?.scope ?? null, note: claim?.note ?? null }
  }]);
  await recordConfidence(run, { entityType: "belief", entityId: id, confidence, prev: null, sourceEventId: written[0]?.id, sourceRunId: source.runId ?? null, tsMs: ts });
  await updateBelief(run, id, { lineage: lineageOf(created, written.map(e => e.id), source.runId ?? null) });
  return { belief: await getBelief(run, id), events: written, created: true };
}

/**
 * Retire the belief that says `key`. Retirement is a transition: the row stays,
 * its status changes, its confidence is halved, and the relationships that
 * rested on it weaken. Nothing is deleted.
 */
export async function retireBeliefByKey(run, { workspaceId, key, reason = null, source = {}, config = {}, successorId = null }) {
  if (!key) return { belief: null, events: [] };
  const belief = await findBelief(run, workspaceId, key);
  if (!belief || belief.status === "retired") return { belief, events: [] };
  const ts = nowMs();
  const prevConfidence = num(belief.confidence, 0.5);
  const confidence = Number(Math.max(0.02, prevConfidence * 0.5).toFixed(4));
  const patch = { status: "retired", confidence, retired_at_ms: ts, successor_id: successorId ?? belief.successor_id ?? null };
  const written = await appendEvents(run, [
    {
      workspaceId,
      entityType: "belief",
      entityId: belief.id,
      transition: "belief_retired",
      fromState: beliefState(belief),
      toState: { ...beliefState(belief), ...patch },
      delta: { confidence: Number((confidence - prevConfidence).toFixed(4)), status: "retired" },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "api",
      payload: { reason, successor_id: patch.successor_id }
    },
    {
      workspaceId,
      entityType: "belief",
      entityId: belief.id,
      transition: "confidence_changed",
      fromState: { confidence: prevConfidence },
      toState: { confidence },
      delta: { confidence: Number((confidence - prevConfidence).toFixed(4)), cause: "retirement" },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "api"
    }
  ]);
  patch.lineage = lineageOf(belief, written.map(e => e.id), source.runId ?? null);
  await updateBelief(run, belief.id, patch);
  await recordConfidence(run, {
    entityType: "belief", entityId: belief.id, confidence, prev: prevConfidence,
    sourceEventId: written[1]?.id ?? null, sourceRunId: source.runId ?? null, tsMs: ts
  });
  const links = await transferLinksOnRetirement(run, {
    belief: { ...belief, ...patch }, successorId, workspaceId, source, config
  });
  return { belief: await getBelief(run, belief.id), events: [...written, ...(links.events || [])], linksMoved: links.moved || 0 };
}
