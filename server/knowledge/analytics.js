// Phase 14.6 — Change Analytics. Read-only.
//
// Bare JSON queries over the ledger and the current-state tables: how fast each
// entity changes, how stable it is, and how the whole store churns over time.
// Nothing here writes, and nothing here is on the send path — these are the
// instruments, not the machinery.
//
// Documented formulas (kept in JS rather than exotic SQL so they read the same
// on Neon and anywhere else):
//   change_rate      = events for the entity inside the window / window days
//   volatility       = population stddev of the entity's confidence samples
//   stability_index  = clamp01(1 - volatility/0.5) * clamp01(1 - min(change_rate,5)/5)
//                      (0.5 is the widest a 0..1 confidence can swing; 5 events
//                       per day is treated as fully churned)

import { num, int, clamp01, nowMs } from "../db/util.js";

const DAY_MS = 86_400_000;

function windowOf(days) {
  const d = Math.max(1, Math.min(num(days, 30), 365));
  return { days: d, ms: d * DAY_MS, sinceMs: nowMs() - d * DAY_MS };
}

export async function changeRatePerEntity(db, { workspaceId = null, windowDays = 30, limit = 50 } = {}) {
  const w = windowOf(windowDays);
  const params = [w.sinceMs];
  let scope = "";
  if (workspaceId) { params.push(workspaceId); scope = ` AND (workspace_id = $${params.length} OR workspace_id IS NULL)`; }
  // The LIMIT placeholder has to be whatever index the limit ends up at: with a
  // workspace scope the limit is $3, without it $2.
  params.push(Math.max(1, Math.min(int(limit, 50), 500)));
  const rows = await db.query(
    `SELECT entity_type, entity_id, count(*)::int AS events,
            min(ts_ms) AS first_ts, max(ts_ms) AS last_ts,
            count(*) FILTER (WHERE reversible)::int AS reversible_events,
            count(DISTINCT source_run_id)::int AS runs,
            count(DISTINCT transition)::int AS distinct_transitions
       FROM knowledge_events
      WHERE ts_ms >= $1${scope}
      GROUP BY entity_type, entity_id
      ORDER BY events DESC, last_ts DESC
      LIMIT $${params.length}`,
    params
  );
  return {
    window: { days: w.days, sinceMs: w.sinceMs, since: new Date(w.sinceMs).toISOString() },
    count: rows.length,
    entities: rows.map(r => ({
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      events: int(r.events),
      change_rate_per_day: Number((int(r.events) / w.days).toFixed(4)),
      reversible_events: int(r.reversible_events),
      runs: int(r.runs),
      distinct_transitions: int(r.distinct_transitions),
      first_change: new Date(num(r.first_ts)).toISOString(),
      last_change: new Date(num(r.last_ts)).toISOString(),
      age_days: Number(((nowMs() - num(r.first_ts)) / DAY_MS).toFixed(2))
    }))
  };
}

export async function stabilityIndex(db, { workspaceId = null, windowDays = 30, entityType = "belief", limit = 50 } = {}) {
  const w = windowOf(windowDays);

  // Confidence samples per entity inside the window.
  const sParams = [entityType, w.sinceMs];
  const join = entityType === "belief" ? " JOIN beliefs b ON b.id = h.entity_id"
    : entityType === "relationship" ? " JOIN relationships r ON r.id = h.entity_id"
      : "";
  const alias = entityType === "belief" ? "b" : entityType === "relationship" ? "r" : null;
  let sSql = `SELECT h.entity_id, h.confidence, h.ts_ms FROM confidence_history h${join}
              WHERE h.entity_type = $1 AND h.ts_ms >= $2`;
  if (workspaceId && alias) { sParams.push(workspaceId); sSql += ` AND ${alias}.workspace_id = $${sParams.length}`; }
  sSql += ` ORDER BY h.entity_id, h.ts_ms`;
  const samples = await db.query(sSql, sParams);
  const byEntity = new Map();
  for (const s of samples) {
    if (!byEntity.has(s.entity_id)) byEntity.set(s.entity_id, []);
    byEntity.get(s.entity_id).push(num(s.confidence, 0.5));
  }

  // Ledger churn for the same entities over the same window.
  const cParams = [entityType, w.sinceMs];
  let cScope = "";
  if (workspaceId) { cParams.push(workspaceId); cScope = ` AND (workspace_id = $${cParams.length} OR workspace_id IS NULL)`; }
  const churnRows = await db.query(
    `SELECT entity_id, count(*)::int AS events
       FROM knowledge_events
      WHERE entity_type = $1 AND ts_ms >= $2${cScope}
      GROUP BY entity_id`,
    cParams
  );
  const churn = new Map(churnRows.map(r => [r.entity_id, int(r.events)]));

  const ids = Array.from(new Set([...byEntity.keys(), ...churn.keys()]));
  let labels = new Map();
  if (entityType === "belief" && ids.length) {
    const rows = await db.query(`SELECT id, statement, status, confidence FROM beliefs WHERE id = ANY($1)`, [ids]);
    labels = new Map(rows.map(r => [r.id, r]));
  } else if (entityType === "relationship" && ids.length) {
    const rows = await db.query(`SELECT id, kind, subject_id, object_id, status, strength FROM relationships WHERE id = ANY($1)`, [ids]);
    labels = new Map(rows.map(r => [r.id, r]));
  }

  const entities = ids.map(id => {
    const list = byEntity.get(id) || [];
    const events = churn.get(id) || 0;
    const rate = Number((events / w.days).toFixed(4));
    let volatility = 0;
    if (list.length > 1) {
      const mean = list.reduce((a, b) => a + b, 0) / list.length;
      volatility = Math.sqrt(list.reduce((a, b) => a + (b - mean) ** 2, 0) / list.length);
    }
    const label = labels.get(id) || {};
    return {
      entity_id: id,
      entity_type: entityType,
      label: label.statement || (label.kind ? `${label.kind} ${label.subject_id}→${label.object_id}` : null),
      status: label.status ?? null,
      confidence: num(label.confidence ?? label.strength, null),
      samples: list.length,
      events: events,
      change_rate_per_day: rate,
      volatility: Number(volatility.toFixed(4)),
      stability_index: Number((clamp01(1 - volatility / 0.5) * clamp01(1 - Math.min(rate, 5) / 5)).toFixed(4))
    };
  }).sort((a, b) => b.stability_index - a.stability_index).slice(0, Math.max(1, Math.min(int(limit, 50), 500)));

  const avg = entities.length ? Number((entities.reduce((a, e) => a + e.stability_index, 0) / entities.length).toFixed(4)) : null;
  return {
    window: { days: w.days, since: new Date(w.sinceMs).toISOString() },
    entity_type: entityType,
    count: entities.length,
    average_stability_index: avg,
    reading: avg === null ? "nothing to measure yet"
      : avg >= 0.8 ? "the store is settling"
        : avg >= 0.5 ? "the store is moving but holding shape"
          : "the store is churning",
    entities
  };
}

export async function churnOverTime(db, { workspaceId = null, windowDays = 14, bucketHours = 24 } = {}) {
  const w = windowOf(windowDays);
  const hours = Math.max(1, Math.min(int(bucketHours, 24), 168));
  const params = [w.sinceMs, hours * 3600_000];
  let scope = "";
  if (workspaceId) { params.push(workspaceId); scope = ` AND (workspace_id = $${params.length} OR workspace_id IS NULL)`; }
  const rows = await db.query(
    `SELECT (ts_ms / $2) * $2 AS bucket_ms,
            transition,
            count(*)::int AS n
       FROM knowledge_events
      WHERE ts_ms >= $1${scope}
      GROUP BY bucket_ms, transition
      ORDER BY bucket_ms ASC`,
    params
  );
  const buckets = new Map();
  for (const r of rows) {
    const key = num(r.bucket_ms);
    if (!buckets.has(key)) {
      buckets.set(key, {
        bucket_ms: key,
        bucket: new Date(key).toISOString(),
        total: 0,
        transitions: {}
      });
    }
    const b = buckets.get(key);
    b.total += int(r.n);
    b.transitions[r.transition] = (b.transitions[r.transition] || 0) + int(r.n);
  }
  const list = Array.from(buckets.values()).sort((a, b) => a.bucket_ms - b.bucket_ms);
  const total = list.reduce((a, b) => a + b.total, 0);
  return {
    window: { days: w.days, since: new Date(w.sinceMs).toISOString(), bucketHours: hours },
    total_events: total,
    events_per_day: Number((total / w.days).toFixed(3)),
    buckets: list,
    peak: list.length ? list.reduce((a, b) => (b.total > a.total ? b : a)) : null
  };
}

export async function overview(db, { workspaceId = null } = {}) {
  const params = [];
  let scope = "";
  if (workspaceId) { params.push(workspaceId); scope = ` WHERE workspace_id = $1`; }
  const [events, byTransition, beliefs, relationships, contradictions] = await Promise.all([
    db.query(`SELECT count(*)::int AS n, min(ts_ms) AS first_ts, max(ts_ms) AS last_ts FROM knowledge_events${scope}`, params),
    db.query(`SELECT transition, count(*)::int AS n FROM knowledge_events${scope} GROUP BY transition ORDER BY n DESC`, params),
    db.query(`SELECT status, count(*)::int AS n, avg(confidence)::numeric AS avg_confidence FROM beliefs${scope} GROUP BY status ORDER BY n DESC`, params),
    db.query(`SELECT kind, status, count(*)::int AS n, avg(strength)::numeric AS avg_strength FROM relationships${scope} GROUP BY kind, status ORDER BY n DESC`, params),
    db.query(`SELECT verdict, count(*)::int AS n FROM coherence_reports${workspaceId ? " WHERE workspace_id = $1" : ""} GROUP BY verdict ORDER BY n DESC`, params)
  ]);
  const e = events[0] || {};
  return {
    ledger: {
      events: int(e.n),
      first_event: e.first_ts ? new Date(num(e.first_ts)).toISOString() : null,
      last_event: e.last_ts ? new Date(num(e.last_ts)).toISOString() : null,
      by_transition: byTransition.map(r => ({ transition: r.transition, count: int(r.n) }))
    },
    beliefs: beliefs.map(r => ({ status: r.status, count: int(r.n), avg_confidence: num(r.avg_confidence, null) })),
    relationships: relationships.map(r => ({ kind: r.kind, status: r.status, count: int(r.n), avg_strength: num(r.avg_strength, null) })),
    coherence: contradictions.map(r => ({ verdict: r.verdict, count: int(r.n) })),
    append_only: true
  };
}

/** Everything one endpoint should answer about the knowledge layer. */
export async function analytics(db, { workspaceId = null, windowDays = 30, bucketHours = 24, limit = 50 } = {}) {
  const [summary, rate, stability, churn, relStability] = await Promise.all([
    overview(db, { workspaceId }),
    changeRatePerEntity(db, { workspaceId, windowDays, limit }),
    stabilityIndex(db, { workspaceId, windowDays, entityType: "belief", limit }),
    churnOverTime(db, { workspaceId, windowDays, bucketHours }),
    stabilityIndex(db, { workspaceId, windowDays, entityType: "relationship", limit })
  ]);
  return { generatedAt: new Date().toISOString(), windowDays, summary, change_rate: rate, stability, relationship_stability: relStability, churn };
}

