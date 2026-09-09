// Phase 14 store — the knowledge layer's data access, bound to a query runner.
//
// createKnowledgeStore(run) is called twice by server/db.js: once with the pool
// runner (the module-level `db` object) and once per transaction (the object
// handed to withTransaction's callback). Same SQL, same accessors, so a caller
// cannot accidentally write state on one connection and its ledger event on
// another — which is exactly what "in the same transaction" requires.

import { newId, num, int } from "../db/util.js";
import {
  appendEvent, appendEvents, listEvents, recentEvents, countEvents, foldState, diffState, parse,
  TRANSITIONS, ENTITY_TYPES, isTransition, snapshot
} from "./events.js";
import * as beliefs from "./beliefs.js";
import * as relationships from "./relationships.js";

export function createKnowledgeStore(run) {
  return {
    // --- 14.1 the ledger ---------------------------------------------------
    KnowledgeEvent: {
      append: (event) => appendEvent(run, event),
      appendMany: (events) => appendEvents(run, events),
      list: (filter) => listEvents(run, filter),
      recent: (filter) => recentEvents(run, filter),
      forEntity: (entityType, entityId, filter = {}) => listEvents(run, { ...filter, entityType, entityId }),
      forRun: (runId, filter = {}) => listEvents(run, { ...filter, runId }),
      count: (filter = {}) => countEvents(run, filter),
      countForRun: (runId) => countEvents(run, { runId }),
      transitions: () => Object.keys(TRANSITIONS),
      isTransition
    },

    // --- 14.2 state reconstruction ----------------------------------------
    Replay: {
      /** Fold an entity's history up to `atMs` (default: now). */
      async stateAt(entityType, entityId, { atMs = null, trackedFields = null } = {}) {
        const events = await listEvents(run, { entityType, entityId, untilMs: atMs, limit: 2000 });
        const folded = foldState(events, { atMs });
        return {
          entityType,
          entityId,
          asOfMs: atMs === null ? null : Number(atMs),
          asOf: atMs === null ? null : new Date(Number(atMs)).toISOString(),
          exists: folded.exists,
          state: folded.state,
          eventCount: folded.eventCount,
          firstEventAt: folded.firstEventAt,
          lastTransition: folded.lastTransition,
          history: folded.history,
          trackedFields: trackedFields || null
        };
      },
      /** Prove the invariant: folding the whole ledger must reproduce the row. */
      async verify(entityType, entityId, trackedFields) {
        const events = await listEvents(run, { entityType, entityId, limit: 2000 });
        const folded = foldState(events);
        const current = await currentRow(entityType, entityId);
        const projection = current ? pick(current, trackedFields) : null;
        const comparison = diffState(folded.state, projection, trackedFields);
        return {
          entityType, entityId,
          eventCount: folded.eventCount,
          folded: folded.state,
          current: projection,
          ...comparison
        };
      },
      /** Every event behind a conclusion: by message, by run, or by entity. */
      async lineage({ entityType = null, entityId = null, runId = null, messageId = null, limit = 500 } = {}) {
        const events = await listEvents(run, { entityType, entityId, runId, messageId, limit });
        return {
          count: events.length,
          events: events.map(e => ({
            id: e.id, seq: num(e.seq), ts_ms: num(e.ts_ms), at: new Date(num(e.ts_ms)).toISOString(),
            entity_type: e.entity_type, entity_id: e.entity_id, transition: e.transition,
            delta: parse(e.delta), reversible: e.reversible,
            source_run_id: e.source_run_id, source_message_id: e.source_message_id
          })),
          runs: Array.from(new Set(events.map(e => e.source_run_id).filter(Boolean))),
          messages: Array.from(new Set(events.map(e => e.source_message_id).filter(Boolean))),
          transitions: events.reduce((acc, e) => ({ ...acc, [e.transition]: (acc[e.transition] || 0) + 1 }), {})
        };
      }
    },

    // --- 14.3 beliefs, confidence history ---------------------------------
    Belief: {
      list: (workspaceId, opts) => beliefs.listBeliefs(run, workspaceId, opts),
      get: (id) => beliefs.getBelief(run, id),
      findByStatement: (workspaceId, statement) => beliefs.findBelief(run, workspaceId, beliefs.statementKey(statement)),
      pool: (workspaceId, limit) => beliefs.beliefPool(run, workspaceId, limit),
      projectMemoryWrite: (args) => beliefs.projectMemoryWrite(run, args),
      applyContradiction: (args) => beliefs.applyContradiction(run, args),
      applyConfirmation: (args) => beliefs.applyConfirmation(run, args),
      proposeHypothesis: (args) => beliefs.proposeHypothesis(run, args),
      state: beliefs.beliefState,
      statementKey: beliefs.statementKey,
      confidenceFromEvidence: beliefs.confidenceFromEvidence
    },

    ConfidenceHistory: {
      async for(entityType, entityId, limit = 100) {
        const rows = await run(
          `SELECT * FROM confidence_history WHERE entity_type = $1 AND entity_id = $2
           ORDER BY ts_ms DESC LIMIT $3`,
          [entityType, entityId, Math.max(1, Math.min(int(limit, 100), 1000))]
        );
        return rows.reverse();
      },
      async forMany(entityType, entityIds, limit = 500) {
        if (!entityIds?.length) return [];
        const rows = await run(
          `SELECT * FROM confidence_history WHERE entity_type = $1 AND entity_id = ANY($2)
           ORDER BY ts_ms ASC LIMIT $3`,
          [entityType, entityIds.map(String), Math.max(1, Math.min(int(limit, 500), 5000))]
        );
        return rows;
      },
      async add({ entityType, entityId, confidence, prev = null, sourceEventId = null, sourceRunId = null, tsMs = Date.now() }) {
        await run(
          `INSERT INTO confidence_history (id, entity_type, entity_id, confidence, prev_confidence, delta, source_event_id, source_run_id, ts_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [newId("cfh"), entityType, entityId, confidence, prev,
           prev === null ? null : Number((num(confidence, 0) - num(prev, 0)).toFixed(4)),
           sourceEventId, sourceRunId, tsMs]
        );
      }
    },

    // --- 14.4 relationship dynamics ---------------------------------------
    Relationship: {
      list: (workspaceId, opts) => relationships.listRelationships(run, workspaceId, opts),
      get: (id) => relationships.getRelationship(run, id),
      find: (args) => relationships.findRelationship(run, args),
      reinforce: (args) => relationships.reinforce(run, args),
      weaken: (args) => relationships.weaken(run, args),
      merge: (args) => relationships.mergeRelationships(run, args),
      split: (args) => relationships.splitRelationship(run, args),
      decaySweep: (args) => relationships.decaySweep(run, args),
      linkCoActivations: (args) => relationships.linkCoActivations(run, args),
      transferLinksOnRetirement: (args) => relationships.transferLinksOnRetirement(run, args),
      effectiveStrength: relationships.effectiveStrength,
      state: relationships.relationshipState
    },

    // --- 14.5 coherence reports -------------------------------------------
    CoherenceReport: {
      async create(report) {
        const id = newId("coh");
        const rows = await run(
          `INSERT INTO coherence_reports (id, run_id, workspace_id, conversation_id, message_id, checked, verdict,
                                          draft_shipped, persisted, skip_reason, claims, contradictions, confirmations,
                                          belief_ids, confidence_delta, model_used, latency_ms, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
          [id, report.run_id, report.workspace_id ?? null, report.conversation_id ?? null, report.message_id ?? null,
           report.checked !== false, report.verdict || "unchecked",
           report.draft_shipped ?? null, report.persisted === true, report.skip_reason ?? null,
           json(report.claims), json(report.contradictions), json(report.confirmations), json(report.belief_ids),
           report.confidence_delta ?? null, report.model_used ?? null, report.latency_ms ?? null, report.note ?? null]
        );
        return rows[0];
      },
      async update(id, patch) {
        const cols = [];
        const values = [];
        for (const [k, v] of Object.entries(patch || {})) {
          if (v === undefined) continue;
          values.push(["claims", "contradictions", "confirmations", "belief_ids"].includes(k) ? json(v) : v);
          cols.push(`${k} = $${values.length}`);
        }
        if (!cols.length) return this.get(id);
        values.push(id);
        const rows = await run(`UPDATE coherence_reports SET ${cols.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
        return rows[0] || null;
      },
      async get(id) {
        const rows = await run(`SELECT * FROM coherence_reports WHERE id = $1`, [id]);
        return rows[0] || null;
      },
      async byRun(runId) {
        const rows = await run(`SELECT * FROM coherence_reports WHERE run_id = $1 ORDER BY created_date ASC`, [runId]);
        return rows;
      },
      async recent({ verdict = null, workspaceId = null, limit = 50 } = {}) {
        const clauses = [];
        const params = [];
        if (verdict) { params.push(verdict); clauses.push(`verdict = $${params.length}`); }
        if (workspaceId) { params.push(workspaceId); clauses.push(`workspace_id = $${params.length}`); }
        params.push(Math.max(1, Math.min(int(limit, 50), 500)));
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        return run(`SELECT * FROM coherence_reports ${where} ORDER BY created_date DESC LIMIT $${params.length}`, params);
      }
    }
  };

  async function currentRow(entityType, entityId) {
    switch (entityType) {
      case "belief": {
        const rows = await run(`SELECT * FROM beliefs WHERE id = $1`, [entityId]);
        return rows[0] ? beliefs.beliefState(rows[0]) : null;
      }
      case "relationship": {
        const rows = await run(`SELECT * FROM relationships WHERE id = $1`, [entityId]);
        return rows[0] ? relationships.relationshipState(rows[0]) : null;
      }
      case "memory": {
        const rows = await run(`SELECT * FROM memories WHERE id = $1`, [entityId]);
        return rows[0] ? pick(rows[0], MEMORY_TRACKED_FIELDS) : null;
      }
      case "conversation": {
        const rows = await run(`SELECT * FROM conversations WHERE id = $1`, [entityId]);
        return rows[0] ? pick(rows[0], CONVERSATION_TRACKED_FIELDS) : null;
      }
      case "task_context": {
        const rows = await run(`SELECT * FROM task_contexts WHERE id = $1`, [entityId]);
        return rows[0] ? pick(rows[0], TASK_CONTEXT_TRACKED_FIELDS) : null;
      }
      default:
        return null;
    }
  }
}

export const MEMORY_TRACKED_FIELDS = Object.freeze([
  "content", "memory_type", "importance", "evidence_level", "volatility", "is_enabled", "confidence"
]);
export const CONVERSATION_TRACKED_FIELDS = Object.freeze([
  "title", "summary", "is_archived", "last_message_preview", "project_id"
]);
export const TASK_CONTEXT_TRACKED_FIELDS = Object.freeze([
  "goal", "task_type", "status", "final_response"
]);

export const TRACKED_FIELDS = Object.freeze({
  belief: beliefs.BELIEF_TRACKED_FIELDS,
  relationship: relationships.RELATIONSHIP_TRACKED_FIELDS,
  memory: MEMORY_TRACKED_FIELDS,
  conversation: CONVERSATION_TRACKED_FIELDS,
  task_context: TASK_CONTEXT_TRACKED_FIELDS
});

function pick(row, fields) {
  const out = {};
  for (const f of fields) {
    const v = row?.[f];
    out[f] = typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : (v === undefined ? null : snapshot(v));
  }
  return out;
}

function json(value) {
  return value === null || value === undefined ? null : JSON.stringify(snapshot(value));
}

export { ENTITY_TYPES, TRANSITIONS, foldState, snapshot, parse };
