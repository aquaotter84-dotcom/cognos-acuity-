// Phase 14.3 — the Temporal Reasoner.
//
// A helper the council can call during a run, NOT a new operator: the six seats
// are the six seats. It is put on the orchestration context as `ctx.temporal`,
// so any operator (or subsystem) can ask the questions time makes answerable:
//
//   * how fast is confidence in this belief moving, and which way?
//   * is uncertainty shrinking or growing?
//   * has this pattern stayed stable, or is it churning?
//   * what changed immediately before this conclusion?
//   * what did this entity look like at instant T?   (Phase 14.2 replay)
//
// Every method is read-only, bounded, and best-effort: a failure returns null
// and the council carries on. Time participates in reasoning; it never blocks it.

import { num, int, clamp01, nowMs } from "../db/util.js";
import { parse } from "./events.js";

const DAY_MS = 86_400_000;

export function createTemporalReasoner({ db, workspaceId = null, runId = null, logger = null } = {}) {
  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      logger?.warn?.(`temporal reasoner: ${label} failed`, { error: String(e) });
      return null;
    }
  };

  /** Confidence samples for one or many entities, grouped. */
  async function samples(entityType, entityIds, limit = 500) {
    const rows = await db.ConfidenceHistory.forMany(entityType, entityIds, limit);
    const byEntity = new Map();
    for (const r of rows) {
      if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
      byEntity.get(r.entity_id).push({
        ts_ms: num(r.ts_ms),
        confidence: num(r.confidence, 0.5),
        delta: num(r.delta, null),
        source_run_id: r.source_run_id,
        source_event_id: r.source_event_id
      });
    }
    for (const list of byEntity.values()) list.sort((a, b) => a.ts_ms - b.ts_ms);
    return byEntity;
  }

  // A per-day rate measured over seconds is arithmetic, not evidence. Below this
  // span the number is still returned (nothing is hidden) but flagged as an
  // extrapolation, so the council and the UI can say so instead of implying a
  // trend that has not had time to exist.
  const MIN_SPAN_FOR_RATE_MS = 3600_000;

  function slope(list, windowMs = null) {
    const pts = windowMs ? list.filter(p => p.ts_ms >= nowMs() - windowMs) : list;
    if (pts.length < 2) {
      return {
        perDay: 0, samples: pts.length,
        first: pts[0]?.confidence ?? null, last: pts.at(-1)?.confidence ?? null,
        spanMs: 0, change: 0, reliable: false,
        note: "fewer than two confidence samples; there is no slope to measure"
      };
    }
    const first = pts[0];
    const last = pts.at(-1);
    const spanMs = Math.max(1, last.ts_ms - first.ts_ms);
    const change = Number((last.confidence - first.confidence).toFixed(6));
    const reliable = spanMs >= MIN_SPAN_FOR_RATE_MS;
    return {
      perDay: Number(((change / spanMs) * DAY_MS).toFixed(6)),
      samples: pts.length,
      first: first.confidence,
      last: last.confidence,
      spanMs,
      change,
      reliable,
      note: reliable ? null
        : `span is ${(spanMs / 1000).toFixed(1)}s; the per-day rate extrapolates ${Math.round(DAY_MS / spanMs)}x beyond the observed window`
    };
  }

  /** Uncertainty is 1 - |2c - 1|: 0 at c=0 or c=1, 1 at c=0.5. */
  function uncertaintyTrendOf(list) {
    const u = list.map(p => 1 - Math.abs(2 * p.confidence - 1));
    if (u.length < 2) return { direction: "insufficient", uncertainty: u.at(-1) ?? null, samples: u.length, change: 0 };
    const mid = Math.floor(u.length / 2);
    const mean = (arr) => arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
    const earlier = mean(u.slice(0, mid));
    const recent = mean(u.slice(mid));
    const change = Number((recent - earlier).toFixed(4));
    return {
      direction: Math.abs(change) < 0.02 ? "flat" : (change < 0 ? "shrinking" : "growing"),
      uncertainty: Number(u.at(-1).toFixed(4)),
      earlier: Number(earlier.toFixed(4)),
      recent: Number(recent.toFixed(4)),
      change,
      samples: u.length
    };
  }

  function stabilityOf(list, churn) {
    if (!list.length) return { index: null, stddev: null, range: null, churnPerDay: churn.perDay, samples: 0 };
    const mean = list.reduce((a, p) => a + p.confidence, 0) / list.length;
    const variance = list.reduce((a, p) => a + (p.confidence - mean) ** 2, 0) / list.length;
    const stddev = Math.sqrt(variance);
    const values = list.map(p => p.confidence);
    const range = Math.max(...values) - Math.min(...values);
    // Two independent penalties: how much confidence moved, and how often the
    // entity was touched. Both are clamped, so the index stays in [0,1].
    const index = Number((clamp01(1 - stddev / 0.5) * clamp01(1 - Math.min(churn.perDay, 5) / 5)).toFixed(4));
    return { index, stddev: Number(stddev.toFixed(4)), range: Number(range.toFixed(4)), churnPerDay: churn.perDay, samples: list.length };
  }

  async function churn(entityType, entityIds, windowMs = 7 * DAY_MS) {
    if (!entityIds.length) return new Map();
    const rows = await db.query(
      `SELECT entity_id, count(*)::int AS events, min(ts_ms) AS first_ts, max(ts_ms) AS last_ts
         FROM knowledge_events
        WHERE entity_type = $1 AND entity_id = ANY($2) AND ts_ms >= $3
        GROUP BY entity_id`,
      [entityType, entityIds.map(String), nowMs() - windowMs]
    );
    const out = new Map();
    for (const r of rows) {
      out.set(r.entity_id, {
        events: int(r.events),
        perDay: Number((int(r.events) / (windowMs / DAY_MS)).toFixed(4)),
        first_ts: num(r.first_ts),
        last_ts: num(r.last_ts)
      });
    }
    return out;
  }

  return {
    /** Phase 14.2 — replay: this entity's state at any past instant. */
    stateAt: (entityType, entityId, atMs) => safe("stateAt", () => db.Replay.stateAt(entityType, entityId, { atMs })),

    /** Is the fold of history equal to the materialized row? */
    verify: (entityType, entityId, trackedFields) => safe("verify", () => db.Replay.verify(entityType, entityId, trackedFields)),

    async confidenceVelocity(entityType, entityId, { windowMs = null } = {}) {
      return safe("confidenceVelocity", async () => {
        const byEntity = await samples(entityType, [entityId]);
        return slope(byEntity.get(entityId) || [], windowMs);
      });
    },

    async uncertaintyTrend(entityType, entityId) {
      return safe("uncertaintyTrend", async () => {
        const byEntity = await samples(entityType, [entityId]);
        return uncertaintyTrendOf(byEntity.get(entityId) || []);
      });
    },

    async stability(entityType, entityId, { windowMs = 7 * DAY_MS } = {}) {
      return safe("stability", async () => {
        const byEntity = await samples(entityType, [entityId]);
        const churnMap = await churn(entityType, [entityId], windowMs);
        return stabilityOf(byEntity.get(entityId) || [], churnMap.get(entityId) || { perDay: 0, events: 0 });
      });
    },

    /**
     * What changed immediately before a conclusion. Anchored on a run, a
     * message, or an explicit instant; looks back `windowMs` across the
     * workspace and reports the transitions nearest the anchor.
     */
    async whatChangedBefore({ anchorMs = null, runId: rid = null, messageId = null, windowMs = 6 * 3600_000, limit = 25, excludeRunId = null } = {}) {
      return safe("whatChangedBefore", async () => {
        let anchor = num(anchorMs, null);
        if (anchor === null && (rid || messageId)) {
          const events = await db.KnowledgeEvent.list({ runId: rid ?? null, messageId: messageId ?? null, limit: 5 });
          anchor = events.length ? Math.max(...events.map(e => num(e.ts_ms))) : nowMs();
        }
        if (anchor === null) anchor = nowMs();
        const params = [anchor, anchor - windowMs, Math.min(int(limit, 25), 200)];
        let scope = "";
        if (workspaceId) { params.push(workspaceId); scope = ` AND (workspace_id = $${params.length} OR workspace_id IS NULL)`; }
        const events = await db.query(
          `SELECT id, ts_ms, entity_type, entity_id, transition, delta, source_run_id, source_message_id, reversible
             FROM knowledge_events
            WHERE ts_ms <= $1 AND ts_ms >= $2${scope}
            ORDER BY ts_ms DESC
            LIMIT $3`,
          params
        );
        const filtered = excludeRunId ? events.filter(e => e.source_run_id !== excludeRunId) : events;
        return {
          anchorMs: anchor,
          anchor: new Date(anchor).toISOString(),
          windowMs,
          count: filtered.length,
          immediatelyBefore: filtered.slice(0, 5).map(e => ({
            at: new Date(num(e.ts_ms)).toISOString(),
            transition: e.transition,
            entity: `${e.entity_type}:${e.entity_id}`,
            delta: parse(e.delta),
            run: e.source_run_id
          })),
          events: filtered.map(e => ({
            id: e.id, ts_ms: num(e.ts_ms), at: new Date(num(e.ts_ms)).toISOString(),
            entity_type: e.entity_type, entity_id: e.entity_id, transition: e.transition,
            delta: parse(e.delta), reversible: e.reversible,
            source_run_id: e.source_run_id, source_message_id: e.source_message_id
          }))
        };
      });
    },

    /**
     * The compact brief an operator actually wants: one line per belief with
     * the direction and speed of its confidence, whether uncertainty is
     * shrinking, and how stable the pattern has been. Two bounded queries.
     */
    async digestForBeliefs(beliefIds, { limit = 6 } = {}) {
      return safe("digestForBeliefs", async () => {
        const ids = Array.from(new Set((beliefIds || []).filter(Boolean))).slice(0, Math.max(1, limit));
        if (!ids.length) return null;
        const [byEntity, churnMap, rows] = await Promise.all([
          samples("belief", ids),
          churn("belief", ids),
          db.query(`SELECT id, statement, status, confidence, support_count, contradict_count, last_confirmed_ms FROM beliefs WHERE id = ANY($1)`, [ids])
        ]);
        const beliefs = rows.map(b => {
          const list = byEntity.get(b.id) || [];
          const c = churnMap.get(b.id) || { perDay: 0, events: 0 };
          return {
            id: b.id,
            statement: String(b.statement || "").slice(0, 160),
            status: b.status,
            confidence: num(b.confidence, 0.5),
            ...(() => {
              const v = slope(list);
              return {
                velocity_per_day: v.perDay,
                velocity_change: v.change,
                velocity_span_ms: v.spanMs,
                velocity_reliable: v.reliable,
                velocity_note: v.note
              };
            })(),
            uncertainty: uncertaintyTrendOf(list),
            stability: stabilityOf(list, c),
            events_7d: c.events || 0,
            last_confirmed_ms: num(b.last_confirmed_ms, null),
            age_days: Number(((nowMs() - num(b.last_confirmed_ms, nowMs())) / DAY_MS).toFixed(2)),
            support: int(b.support_count, 0),
            contradictions: int(b.contradict_count, 0)
          };
        });
        return {
          asOf: new Date().toISOString(),
          count: beliefs.length,
          beliefs,
          summary: summarize(beliefs)
        };
      });
    },

    /** Everything the ledger knows about one orchestration run. */
    async digestForRun(rid = runId) {
      return safe("digestForRun", async () => {
        if (!rid) return null;
        const events = await db.KnowledgeEvent.forRun(rid, { limit: 200 });
        return {
          runId: rid,
          eventCount: events.length,
          transitions: events.reduce((acc, e) => ({ ...acc, [e.transition]: (acc[e.transition] || 0) + 1 }), {}),
          entities: Array.from(new Set(events.map(e => `${e.entity_type}:${e.entity_id}`))),
          first: events[0] ? new Date(num(events[0].ts_ms)).toISOString() : null,
          last: events.length ? new Date(num(events.at(-1).ts_ms)).toISOString() : null
        };
      });
    },

    /** Workspace-level sense of time: is the knowledge base settling or churning? */
    async digestForWorkspace({ windowMs = 7 * DAY_MS } = {}) {
      return safe("digestForWorkspace", async () => {
        const rows = await db.query(
          `SELECT transition, count(*)::int AS n
             FROM knowledge_events
            WHERE ts_ms >= $1 ${workspaceId ? "AND (workspace_id = $2 OR workspace_id IS NULL)" : ""}
            GROUP BY transition ORDER BY n DESC`,
          workspaceId ? [nowMs() - windowMs, workspaceId] : [nowMs() - windowMs]
        );
        const total = rows.reduce((a, r) => a + int(r.n), 0);
        return {
          windowMs,
          windowDays: Number((windowMs / DAY_MS).toFixed(2)),
          total,
          perDay: Number((total / (windowMs / DAY_MS)).toFixed(3)),
          transitions: rows.map(r => ({ transition: r.transition, count: int(r.n) }))
        };
      });
    }
  };
}

function summarize(beliefs) {
  if (!beliefs.length) return null;
  const rising = beliefs.filter(b => b.velocity_per_day > 0.005).length;
  const falling = beliefs.filter(b => b.velocity_per_day < -0.005).length;
  const shrinkingUncertainty = beliefs.filter(b => b.uncertainty?.direction === "shrinking").length;
  const stable = beliefs.filter(b => (b.stability?.index ?? 0) >= 0.8).length;
  const avgStability = Number((beliefs.reduce((a, b) => a + (b.stability?.index ?? 0), 0) / beliefs.length).toFixed(3));
  return {
    rising, falling, steady: beliefs.length - rising - falling,
    shrinking_uncertainty: shrinkingUncertainty,
    stable, avg_stability: avgStability,
    reading: falling > rising
      ? "confidence is falling faster than it is rising — the store is being corrected"
      : rising > falling
        ? "confidence is rising — the store is being corroborated"
        : "confidence is holding steady"
  };
}
