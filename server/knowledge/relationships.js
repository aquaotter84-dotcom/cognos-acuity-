// Phase 14.4 — Relationship Dynamics Engine.
//
// Relationships (user↔system, concept↔concept) are living structures: they have
// a strength, a direction, and they age. Strength is stored as of
// `strength_as_of_ms`, so the effective strength at any later instant is
//
//     strength * exp(-ln2 * age / half_life)
//
// which means a stale relationship weakens on its own — no writer has to touch
// it for time to pass. A bounded sweep materializes that decay into the row and
// logs it, so the ledger records time's effect like any other transition.
//
// Every function takes a query runner and appends its own ledger events on it.
// Nothing here issues a DELETE.

import { newId, num, int, clamp01, nowMs } from "../db/util.js";
import { appendEvents, parse } from "./events.js";

const LN2 = 0.6931471805599453;

export const RELATIONSHIP_TRACKED_FIELDS = Object.freeze([
  "kind", "direction", "strength", "strength_as_of_ms", "interactions", "status", "merged_into"
]);

export function relationshipState(row) {
  if (!row) return null;
  return {
    kind: row.kind ?? "association",
    direction: row.direction ?? "bidirectional",
    strength: num(row.strength, 0.5),
    strength_as_of_ms: int(row.strength_as_of_ms, 0),
    interactions: int(row.interactions, 1),
    status: row.status ?? "active",
    merged_into: row.merged_into ?? null
  };
}

export function decayConfig(config = {}) {
  const d = config.decay || config || {};
  return {
    enabled: d.enabled !== false,
    halfLifeMs: Math.max(60_000, num(d.halfLifeMs, 14 * 24 * 60 * 60 * 1000)),
    floor: clamp01(num(d.floor, 0.05)),
    sweepLimit: Math.max(1, Math.min(int(d.sweepLimit, 25), 200)),
    reinforceGain: clamp01(num(d.reinforceGain, 0.15)),
    weakenPenalty: clamp01(num(d.weakenPenalty, 0.2)),
    inheritFactor: clamp01(num(d.inheritFactor, 0.7)),
    maxPairsPerRun: Math.max(0, Math.min(int(d.maxPairsPerRun, 6), 20)),
    maxLinksPerRetirement: Math.max(0, Math.min(int(d.maxLinksPerRetirement, 8), 25))
  };
}

/** Effective strength right now, given the stored anchor. */
export function effectiveStrength(row, at = nowMs(), defaultHalfLifeMs = 14 * 24 * 60 * 60 * 1000) {
  const strength = num(row?.strength, 0);
  const anchor = int(row?.strength_as_of_ms, at);
  const halfLife = Math.max(60_000, num(row?.decay_half_life_ms, null) ?? defaultHalfLifeMs);
  const age = Math.max(0, Number(at) - anchor);
  return Number((strength * Math.exp((-LN2 * age) / halfLife)).toFixed(6));
}

/** Bidirectional kinds are stored with their endpoints in a canonical order so
 *  (A,B) and (B,A) can never become two rows that later have to be merged. */
function canonicalPair(kind, direction, subject, object) {
  if (direction === "directed") return { subject, object };
  const a = `${subject.type}:${subject.id}`;
  const b = `${object.type}:${object.id}`;
  return a <= b ? { subject, object } : { subject: object, object: subject };
}

export async function findRelationship(run, { workspaceId, kind, subject, object, direction = "bidirectional" }) {
  const p = canonicalPair(kind, direction, subject, object);
  const rows = await run(
    `SELECT * FROM relationships
      WHERE workspace_id = $1 AND kind = $2 AND subject_type = $3 AND subject_id = $4
        AND object_type = $5 AND object_id = $6
      LIMIT 1`,
    [workspaceId, kind, p.subject.type, String(p.subject.id), p.object.type, String(p.object.id)]
  );
  return rows[0] || null;
}

export async function getRelationship(run, id) {
  const rows = await run(`SELECT * FROM relationships WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function listRelationships(run, workspaceId, { kind = null, status = null, limit = 100, at = nowMs(), halfLifeMs } = {}) {
  const params = [workspaceId];
  const clauses = ["workspace_id = $1"];
  if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  params.push(Math.max(1, Math.min(int(limit, 100), 500)));
  const rows = await run(
    `SELECT * FROM relationships WHERE ${clauses.join(" AND ")}
     ORDER BY strength DESC, interactions DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(r => ({ ...r, effective_strength: effectiveStrength(r, at, halfLifeMs) }));
}

async function recordStrengthHistory(run, { id, strength, prev, sourceEventId, sourceRunId, ts }) {
  await run(
    `INSERT INTO confidence_history (id, entity_type, entity_id, confidence, prev_confidence, delta, source_event_id, source_run_id, ts_ms)
     VALUES ($1,'relationship',$2,$3,$4,$5,$6,$7,$8)`,
    [newId("cfh"), id, strength, prev ?? null,
     prev === null || prev === undefined ? null : Number((strength - prev).toFixed(4)),
     sourceEventId ?? null, sourceRunId ?? null, ts]
  );
}

function lineage(row, eventIds, runId) {
  const prev = parse(row?.lineage) || {};
  return {
    created_run_id: prev.created_run_id ?? runId ?? null,
    events: Array.from(new Set([...(Array.isArray(prev.events) ? prev.events : []), ...eventIds])).slice(-12),
    runs: Array.from(new Set([...(Array.isArray(prev.runs) ? prev.runs : []), ...(runId ? [runId] : [])])).slice(-8)
  };
}

/**
 * Strengthen (or create) a relationship. Decay is applied first, so a link that
 * has gone cold is reinforced from where it actually is, not where it was left.
 */
export async function reinforce(run, {
  workspaceId, kind = "association", direction = "bidirectional",
  subject, object, source = {}, config = {}, note = null
}) {
  const d = decayConfig(config);
  const ts = nowMs();
  const existing = await findRelationship(run, { workspaceId, kind, subject, object, direction });

  if (!existing) {
    const p = canonicalPair(kind, direction, subject, object);
    const id = newId("rel");
    const strength = Number(Math.min(1, d.reinforceGain + 0.2).toFixed(4));
    const rows = await run(
      `INSERT INTO relationships (id, workspace_id, subject_type, subject_id, object_type, object_id, kind,
                                  direction, strength, strength_as_of_ms, interactions, status, decay_half_life_ms, lineage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13) RETURNING *`,
      [id, workspaceId, p.subject.type, String(p.subject.id), p.object.type, String(p.object.id), kind,
       direction, strength, ts, 1, d.halfLifeMs, JSON.stringify({ created_run_id: source.runId ?? null, events: [], runs: [] })]
    );
    const created = rows[0];
    const written = await appendEvents(run, [{
      workspaceId,
      entityType: "relationship",
      entityId: id,
      transition: "relationship_created",
      toState: { ...relationshipState(created), subject: `${p.subject.type}:${p.subject.id}`, object: `${p.object.type}:${p.object.id}` },
      delta: { strength },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "run",
      payload: { note }
    }]);
    await recordStrengthHistory(run, { id, strength, prev: null, sourceEventId: written[0]?.id, sourceRunId: source.runId ?? null, ts });
    await run(`UPDATE relationships SET lineage = $1 WHERE id = $2`, [JSON.stringify(lineage(created, written.map(e => e.id), source.runId ?? null)), id]);
    return { relationship: await getRelationship(run, id), events: written, created: true };
  }

  const prevStored = num(existing.strength, 0.5);
  const eff = effectiveStrength(existing, ts, d.halfLifeMs);
  const strength = Number(clamp01(eff + d.reinforceGain * (1 - eff)).toFixed(4));
  const patch = {
    strength,
    strength_as_of_ms: ts,
    interactions: int(existing.interactions, 1) + 1,
    status: "active"
  };
  const written = await appendEvents(run, [{
    workspaceId,
    entityType: "relationship",
    entityId: existing.id,
    transition: "relationship_strengthened",
    fromState: relationshipState(existing),
    toState: { ...relationshipState(existing), ...patch },
    delta: { strength: Number((strength - prevStored).toFixed(4)), decayed_before_reinforce: Number((eff - prevStored).toFixed(4)), interactions: 1 },
    sourceRunId: source.runId ?? null,
    sourceMessageId: source.messageId ?? null,
    sourceKind: source.kind || "run",
    payload: { note }
  }]);
  await applyPatch(run, existing.id, { ...patch, lineage: lineage(existing, written.map(e => e.id), source.runId ?? null) });
  await recordStrengthHistory(run, { id: existing.id, strength, prev: prevStored, sourceEventId: written[0]?.id, sourceRunId: source.runId ?? null, ts });
  return { relationship: await getRelationship(run, existing.id), events: written, created: false };
}

/** Lower a relationship's strength (a veto, a failed run, a contradiction). */
export async function weaken(run, { workspaceId, kind, direction = "bidirectional", subject, object, source = {}, config = {}, note = null }) {
  const d = decayConfig(config);
  const ts = nowMs();
  const existing = await findRelationship(run, { workspaceId, kind, subject, object, direction });
  if (!existing) {
    // Nothing to weaken. Create it weak rather than pretend the interaction happened.
    return reinforce(run, { workspaceId, kind, direction, subject, object, source, config, note: note || "created weak: first interaction was negative" });
  }
  const prevStored = num(existing.strength, 0.5);
  const eff = effectiveStrength(existing, ts, d.halfLifeMs);
  const strength = Number(Math.max(0, eff - d.weakenPenalty * eff).toFixed(4));
  const patch = {
    strength,
    strength_as_of_ms: ts,
    interactions: int(existing.interactions, 1) + 1,
    status: strength < 0.5 ? "weakened" : existing.status
  };
  const written = await appendEvents(run, [{
    workspaceId,
    entityType: "relationship",
    entityId: existing.id,
    transition: "relationship_weakened",
    fromState: relationshipState(existing),
    toState: { ...relationshipState(existing), ...patch },
    delta: { strength: Number((strength - prevStored).toFixed(4)) },
    sourceRunId: source.runId ?? null,
    sourceMessageId: source.messageId ?? null,
    sourceKind: source.kind || "run",
    payload: { note }
  }]);
  await applyPatch(run, existing.id, { ...patch, lineage: lineage(existing, written.map(e => e.id), source.runId ?? null) });
  await recordStrengthHistory(run, { id: existing.id, strength, prev: prevStored, sourceEventId: written[0]?.id, sourceRunId: source.runId ?? null, ts });
  return { relationship: await getRelationship(run, existing.id), events: written, created: false };
}

async function applyPatch(run, id, patch) {
  const cols = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    values.push(k === "lineage" || k === "split_into" ? JSON.stringify(v) : v);
    cols.push(`${k} = $${values.length}`);
  }
  if (!cols.length) return null;
  cols.push(`updated_date = now()`);
  values.push(id);
  const rows = await run(`UPDATE relationships SET ${cols.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
  return rows[0] || null;
}

/** Fold `absorb` into `keep`. The absorbed row stays: status 'merged', pointer
 *  to what it became. Logged as relationship_merged. */
export async function mergeRelationships(run, { keep, absorb, source = {}, config = {}, note = null }) {
  if (!keep || !absorb || keep.id === absorb.id) return { events: [] };
  const d = decayConfig(config);
  const ts = nowMs();
  const keepEff = effectiveStrength(keep, ts, d.halfLifeMs);
  const absorbEff = effectiveStrength(absorb, ts, d.halfLifeMs);
  const strength = Number(clamp01(Math.max(keepEff, absorbEff) + 0.05 * Math.min(keepEff, absorbEff)).toFixed(4));
  const keepPrev = num(keep.strength, strength);
  const keepPatch = {
    strength,
    strength_as_of_ms: ts,
    interactions: int(keep.interactions, 1) + int(absorb.interactions, 0),
    status: "active"
  };
  const absorbPatch = { status: "merged", merged_into: keep.id, strength: 0, strength_as_of_ms: ts };

  const written = await appendEvents(run, [
    {
      workspaceId: keep.workspace_id,
      entityType: "relationship",
      entityId: absorb.id,
      transition: "relationship_merged",
      fromState: relationshipState(absorb),
      toState: { ...relationshipState(absorb), ...absorbPatch },
      delta: { merged_into: keep.id },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "run",
      payload: { note }
    },
    {
      workspaceId: keep.workspace_id,
      entityType: "relationship",
      entityId: keep.id,
      transition: "relationship_strengthened",
      fromState: relationshipState(keep),
      toState: { ...relationshipState(keep), ...keepPatch },
      delta: { strength: Number((strength - keepPrev).toFixed(4)), absorbed: absorb.id },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "run",
      payload: { note: note || "absorbed a duplicate structure" }
    }
  ]);
  await applyPatch(run, absorb.id, { ...absorbPatch, lineage: lineage(absorb, [written[0]?.id].filter(Boolean), source.runId ?? null) });
  await applyPatch(run, keep.id, { ...keepPatch, lineage: lineage(keep, [written[1]?.id].filter(Boolean), source.runId ?? null) });
  await recordStrengthHistory(run, { id: keep.id, strength, prev: keepPrev, sourceEventId: written[1]?.id, sourceRunId: source.runId ?? null, ts });
  return { relationship: await getRelationship(run, keep.id), events: written };
}

/**
 * Divide one structure into successors. The original stays, marked 'split' with
 * a pointer to what it became — so the ledger can always show where a
 * relationship went. Used when a belief is retired and its links have to move.
 */
export async function splitRelationship(run, { rel, successors, source = {}, config = {}, note = null }) {
  if (!rel || !Array.isArray(successors) || successors.length === 0) return { events: [] };
  const d = decayConfig(config);
  const ts = nowMs();
  const eff = effectiveStrength(rel, ts, d.halfLifeMs);
  const share = Number((eff / successors.length).toFixed(4));
  const createdIds = [];
  const events = [];
  let mergedOut = false;           // a successor already had the link: merge, don't split

  for (const s of successors) {
    const existing = await findRelationship(run, {
      workspaceId: rel.workspace_id, kind: s.kind || rel.kind,
      direction: s.direction || rel.direction, subject: s.subject, object: s.object
    });
    if (existing) {
      const merged = await mergeRelationships(run, { keep: existing, absorb: rel, source, config, note: note || "successor already linked" });
      events.push(...(merged.events || []));
      createdIds.push(existing.id);
      mergedOut = true;
      break;                       // rel is now 'merged'; nothing left to split
    }
    const id = newId("rel");
    const strength = Number(clamp01(share * d.inheritFactor).toFixed(4));
    const p = canonicalPair(s.kind || rel.kind, s.direction || rel.direction, s.subject, s.object);
    const rows = await run(
      `INSERT INTO relationships (id, workspace_id, subject_type, subject_id, object_type, object_id, kind,
                                  direction, strength, strength_as_of_ms, interactions, status, decay_half_life_ms, lineage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active',$12,$13) RETURNING *`,
      [id, rel.workspace_id, p.subject.type, String(p.subject.id), p.object.type, String(p.object.id),
       s.kind || rel.kind, s.direction || rel.direction, strength, ts, 1,
       num(rel.decay_half_life_ms, null) ?? d.halfLifeMs,
       JSON.stringify({ created_run_id: source.runId ?? null, split_from: rel.id, events: [], runs: [] })]
    );
    createdIds.push(id);
    const created = rows[0];
    events.push(...await appendEvents(run, [{
      workspaceId: rel.workspace_id,
      entityType: "relationship",
      entityId: id,
      transition: "relationship_created",
      toState: { ...relationshipState(created), subject: `${p.subject.type}:${p.subject.id}`, object: `${p.object.type}:${p.object.id}` },
      delta: { strength, inherited_from: rel.id },
      sourceRunId: source.runId ?? null,
      sourceMessageId: source.messageId ?? null,
      sourceKind: source.kind || "run",
      payload: { note: note || "successor of a split structure" }
    }]));
    await recordStrengthHistory(run, { id, strength, prev: null, sourceEventId: events[events.length - 1]?.id, sourceRunId: source.runId ?? null, ts });
  }

  // If a successor already held the link, mergeRelationships() has already
  // retired `rel` as 'merged' and logged it. Do not also mark it 'split'.
  if (mergedOut) {
    return { relationship: await getRelationship(run, rel.id), successors: createdIds, events, merged: true };
  }

  const relPatch = { status: "split", split_into: createdIds, strength: 0, strength_as_of_ms: ts };
  const splitEvents = await appendEvents(run, [{
    workspaceId: rel.workspace_id,
    entityType: "relationship",
    entityId: rel.id,
    transition: "relationship_split",
    fromState: relationshipState(rel),
    toState: { ...relationshipState(rel), ...relPatch },
    delta: { into: createdIds },
    sourceRunId: source.runId ?? null,
    sourceMessageId: source.messageId ?? null,
    sourceKind: source.kind || "run",
    payload: { note }
  }]);
  await applyPatch(run, rel.id, { ...relPatch, lineage: lineage(rel, splitEvents.map(e => e.id), source.runId ?? null) });
  return { relationship: await getRelationship(run, rel.id), successors: createdIds, events: [...events, ...splitEvents] };
}

/**
 * Materialize time's effect. Bounded: at most `sweepLimit` rows per call, and
 * only rows whose effective strength has actually moved. One UPDATE + one bulk
 * ledger append, so a turn never pays more than two round trips for decay.
 */
export async function decaySweep(run, { workspaceId, config = {}, source = {} }) {
  const d = decayConfig(config);
  if (!d.enabled) return { swept: 0, events: [] };
  const ts = nowMs();
  const rows = await run(
    `WITH due AS (
       SELECT id,
              strength AS prev_strength,
              status AS prev_status,
              GREATEST(0, LEAST(1, strength * exp((-0.6931471805599453 * ($2::numeric - strength_as_of_ms::numeric))
                     / COALESCE(NULLIF(decay_half_life_ms, 0), $3::numeric)))) AS eff
         FROM relationships
        WHERE workspace_id = $1
          AND status IN ('active','weakened')
          AND strength > 0
          AND strength_as_of_ms < $2
        ORDER BY strength_as_of_ms ASC
        LIMIT $4
     )
     UPDATE relationships r
        SET strength = ROUND(due.eff, 4),
            strength_as_of_ms = $2,
            status = CASE WHEN due.eff < $5 THEN 'decayed' ELSE r.status END,
            updated_date = now()
       FROM due
      WHERE r.id = due.id
        AND ABS(due.eff - due.prev_strength) > 0.005
     RETURNING r.*, due.prev_strength, due.prev_status`,
    [workspaceId, ts, d.halfLifeMs, d.sweepLimit, d.floor]
  );
  if (!rows.length) return { swept: 0, events: [] };
  const events = rows.map(r => ({
    workspaceId,
    entityType: "relationship",
    entityId: r.id,
    transition: "relationship_decayed",
    fromState: { ...relationshipState(r), strength: num(r.prev_strength), status: r.prev_status },
    toState: relationshipState(r),
    delta: { strength: Number((num(r.strength, 0) - num(r.prev_strength, 0)).toFixed(4)) },
    tsMs: ts,
    sourceRunId: source.runId ?? null,
    sourceMessageId: source.messageId ?? null,
    sourceKind: "sweep",
    payload: { half_life_ms: num(r.decay_half_life_ms, null) ?? d.halfLifeMs, age_ms: ts - int(r.strength_as_of_ms, ts) }
  }));
  const written = await appendEvents(run, events);
  return { swept: rows.length, events: written, decayed: rows.filter(r => r.status === "decayed").length };
}

/** Beliefs written in the same turn are co-activated: they were thought about
 *  together. Bounded to maxPairsPerRun pairs so a chatty turn cannot explode. */
export async function linkCoActivations(run, { workspaceId, beliefIds, source = {}, config = {} }) {
  const d = decayConfig(config);
  const ids = Array.from(new Set((beliefIds || []).filter(Boolean)));
  if (ids.length < 2 || d.maxPairsPerRun === 0) return { events: [], links: 0 };
  const pairs = [];
  for (let i = 0; i < ids.length && pairs.length < d.maxPairsPerRun; i++) {
    for (let j = i + 1; j < ids.length && pairs.length < d.maxPairsPerRun; j++) {
      pairs.push([ids[i], ids[j]]);
    }
  }
  const events = [];
  for (const [a, b] of pairs) {
    const r = await reinforce(run, {
      workspaceId,
      kind: "co_activation",
      direction: "bidirectional",
      subject: { type: "belief", id: a },
      object: { type: "belief", id: b },
      source,
      config,
      note: "co-activated in the same exchange"
    });
    events.push(...(r.events || []));
  }
  return { events, links: pairs.length };
}

/**
 * A belief was retired. Its co-activation links do not vanish — they move. If a
 * successor belief exists, each link is either merged into an equivalent link
 * the successor already has, or split off into a new one inheriting part of the
 * strength. With no successor, the links weaken. Bounded per retirement.
 */
export async function transferLinksOnRetirement(run, { belief, successorId = null, workspaceId, source = {}, config = {} }) {
  const d = decayConfig(config);
  if (d.maxLinksPerRetirement === 0) return { events: [], moved: 0 };
  const rows = await run(
    `SELECT * FROM relationships
      WHERE workspace_id = $1 AND kind = 'co_activation' AND status IN ('active','weakened')
        AND ((subject_type = 'belief' AND subject_id = $2) OR (object_type = 'belief' AND object_id = $2))
      ORDER BY strength DESC
      LIMIT $3`,
    [workspaceId, belief.id, d.maxLinksPerRetirement]
  );
  if (!rows.length) return { events: [], moved: 0 };
  const events = [];
  let moved = 0;
  for (const rel of rows) {
    const partnerIsSubject = rel.subject_id === belief.id && rel.subject_type === "belief";
    const partner = partnerIsSubject
      ? { type: rel.object_type, id: rel.object_id }
      : { type: rel.subject_type, id: rel.subject_id };

    if (!successorId) {
      const w = await weaken(run, {
        workspaceId, kind: "co_activation", direction: rel.direction,
        subject: { type: rel.subject_type, id: rel.subject_id },
        object: { type: rel.object_type, id: rel.object_id },
        source, config, note: `endpoint belief ${belief.id} retired with no successor`
      });
      events.push(...(w.events || []));
      moved += 1;
      continue;
    }

    const existing = await findRelationship(run, {
      workspaceId, kind: "co_activation", direction: rel.direction,
      subject: { type: "belief", id: successorId }, object: partner
    });
    if (existing) {
      const m = await mergeRelationships(run, { keep: existing, absorb: rel, source, config, note: `retired belief ${belief.id} superseded by ${successorId}` });
      events.push(...(m.events || []));
    } else {
      const s = await splitRelationship(run, {
        rel,
        successors: [{ kind: "co_activation", direction: rel.direction, subject: { type: "belief", id: successorId }, object: partner }],
        source, config, note: `retired belief ${belief.id} superseded by ${successorId}`
      });
      events.push(...(s.events || []));
    }
    moved += 1;
  }
  return { events, moved };
}
