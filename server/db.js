// Database layer.
//
// DIVERGENCE FROM ORIGINAL: the original used Base44 platform entities
// (base44.entities.Conversation/Message/Memory/...) with per-row RLS keyed to a
// logged-in platform user. There are no accounts here, so there is no RLS and no
// owner column. Entities are plain Postgres tables and the app is single-tenant.
//
// Hard constraints honoured here:
//   * DATABASE_URL is read from the environment.
//   * Only the pooled postgres:// / postgresql:// form is accepted. The REST
//     https:// variant hangs ~16s, so it is rejected loudly at connect time
//     rather than silently wedging every request.
//   * Initialization is LAZY. Nothing connects at import time, so `npm run build`
//     and cold boots succeed with no database reachable. The first query that
//     needs the DB triggers connect + schema migration, once.
//
// PHASE 14 ADDITION (additive, same conventions):
//   * Every statement is still CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
//     EXISTS. The Phase 14–17 additive schemas live in server/db/schema.js and
//     are concatenated onto SCHEMA below, so one lazy migration applies them all
//     and migrations/*.sql stays byte-identical to what the app runs.
//   * withTransaction(fn) hands the callback a store whose accessors are bound
//     to ONE connection. Knowledge writes (memories, summaries, task contexts,
//     conversation metadata) append their ledger event on that same connection,
//     inside the same transaction — state and history commit or roll back
//     together. withTransaction is re-entrant: calling it inside a transaction
//     joins the ambient one instead of taking a second connection.
//   * The exported surface is unchanged: db.Workspace / Conversation / Message /
//     Memory / TaskContext / AuditEvent / query / newId / isConfigured, plus the
//     new stores (KnowledgeEvent, Belief, Relationship, Replay, CoherenceReport,
//     ConfidenceHistory, TelemetryRun, TelemetryModelCall, Strategy,
//     StrategyEvaluation, AdaptiveDecision, ImprovementLedger).
//   * No DELETE is issued against knowledge_events, beliefs, relationships,
//     telemetry_* or improvement_ledger. There are no accessors that could.

import pg from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { AsyncLocalStorage } from "node:async_hooks";
import { newId, num } from "./db/util.js";
import { PHASE14_SCHEMA, PHASE15_SCHEMA, PHASE16_SCHEMA, PHASE17_SCHEMA, PHASE18_SCHEMA } from "./db/schema.js";
import { appendEvent, snapshot } from "./knowledge/events.js";
import {
  createKnowledgeStore, TRACKED_FIELDS,
  MEMORY_TRACKED_FIELDS, CONVERSATION_TRACKED_FIELDS, TASK_CONTEXT_TRACKED_FIELDS
} from "./knowledge/store.js";
import { createMetaStore } from "./meta/store.js";
import { createSourceAgentStore } from "./sources/store.js";
import { confidenceFromEvidence, statementKey, projectMemoryWrite, retireBeliefByKey } from "./knowledge/beliefs.js";
import { linkCoActivations } from "./knowledge/relationships.js";

// Neon's serverless driver talks over WebSockets, which is what works from a
// Vercel serverless function (no long-lived TCP socket to keep warm). In Node
// it needs a WebSocket implementation supplied; in edge/browser runtimes the
// platform provides one.
if (typeof WebSocket === "undefined") neonConfig.webSocketConstructor = ws;

let pool = null;
let readyPromise = null;
let schemaPromise = null;

export function isConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/** Phase 14 kill switch. Unset means on, exactly like COGNOS_CRITIC_ENABLED. */
export function ledgerEnabled() {
  return process.env.COGNOS_LEDGER_ENABLED !== "false";
}

function assertPooledUrl(url) {
  if (!url) {
    throw new Error("DATABASE_URL is not set. COGNOS needs the pooled postgres:// connection string from the Neon dashboard.");
  }
  if (/^https?:\/\//i.test(url)) {
    throw new Error(
      "DATABASE_URL is the REST https:// endpoint. COGNOS requires the pooled postgres:// connection string — the https variant hangs (~16s per query)."
    );
  }
  // Neon exposes both a direct and a pooled host. Serverless needs the pooled
  // one (-pooler), or connections exhaust fast under concurrency.
  if (/\.neon\.tech/i.test(url) && !/-pooler\./i.test(url)) {
    console.warn(JSON.stringify({
      level: "warn", component: "db",
      message: "DATABASE_URL is a Neon DIRECT endpoint. Use the pooled '-pooler' host for serverless deployments."
    }));
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error("DATABASE_URL must be a postgres:// or postgresql:// connection string.");
  }
  return url;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  instructions  TEXT,
  color         TEXT DEFAULT '#3B82F6',
  icon          TEXT DEFAULT 'Brain',
  is_default    BOOLEAN DEFAULT FALSE,
  created_date  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  summary              TEXT,
  is_archived          BOOLEAN DEFAULT FALSE,
  last_message_preview TEXT,
  created_date         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_ws_idx ON conversations (workspace_id, updated_date DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL,
  role              TEXT NOT NULL,
  content           TEXT NOT NULL,
  model_used        TEXT,
  task_type         TEXT,
  task_context_id   TEXT,
  attachments       JSONB,
  council           JSONB,
  processing_status TEXT DEFAULT 'complete',
  created_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_id, created_date);

CREATE TABLE IF NOT EXISTS memories (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  content        TEXT NOT NULL,
  memory_type    TEXT DEFAULT 'episodic',
  source         TEXT,
  importance     INTEGER DEFAULT 5,
  evidence_level TEXT DEFAULT 'inferred',
  volatility     TEXT DEFAULT 'medium',
  last_confirmed TIMESTAMPTZ,
  is_enabled     BOOLEAN DEFAULT TRUE,
  tags           JSONB,
  created_date   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_ws_idx ON memories (workspace_id, importance DESC);

CREATE TABLE IF NOT EXISTS task_contexts (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT,
  workspace_id      TEXT,
  goal              TEXT,
  task_type         TEXT,
  sub_tasks         JSONB,
  context_assembled TEXT,
  final_response    TEXT,
  status            TEXT DEFAULT 'in_progress',
  created_date      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT,
  conversation_id TEXT,
  event_type      TEXT NOT NULL,
  agent_type      TEXT,
  model_used      TEXT,
  task_type       TEXT,
  token_count     INTEGER DEFAULT 0,
  latency_ms      INTEGER DEFAULT 0,
  status          TEXT DEFAULT 'success',
  error_message   TEXT,
  created_date    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_events (created_date DESC);
`
// Phase 14 (Dynamic Systems) and Phase 15 (Meta-Cognition). Additive only:
// new tables, new indexes, and two nullable columns on memories.
+ PHASE14_SCHEMA + PHASE15_SCHEMA + PHASE16_SCHEMA + PHASE17_SCHEMA + PHASE18_SCHEMA;

function isNeon(url) {
  return /\.neon\.tech/i.test(url) || /neon\.database/i.test(url);
}

// Lazy: nothing connects at import time, so the build and a cold boot succeed
// with no database reachable. The first query that needs the DB opens the pool.
function getPool() {
  if (pool) return pool;
  const url = assertPooledUrl(process.env.DATABASE_URL || "");
  if (isNeon(url)) {
    // Neon pooled endpoint over WebSockets — correct for Vercel serverless.
    pool = new NeonPool({ connectionString: url });
  } else {
    pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX || 5),
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

// Schema migration runs at most once per warm instance. On Vercel each cold
// start re-runs it; every statement is IF NOT EXISTS, so it is idempotent and
// costs one round trip.
async function ready() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const p = getPool();
    if (process.env.COGNOS_SKIP_MIGRATE === "true") return p;
    if (!schemaPromise) schemaPromise = p.query(SCHEMA);
    await schemaPromise;
    return p;
  })().catch(err => {
    readyPromise = null;  // allow a later retry instead of poisoning the instance
    schemaPromise = null;
    throw err;
  });
  return readyPromise;
}

export async function query(text, params = []) {
  const p = await ready();
  const res = await p.query(text, params);
  return res.rows;
}

/** Graceful lifecycle hook for tests and self-hosted shutdown. */
export async function closeDatabase() {
  const active = pool;
  pool = null;
  readyPromise = null;
  schemaPromise = null;
  if (active?.end) await active.end();
}

export { newId };

function set(fields, allowed, startIndex = 1) {
  const cols = [];
  const values = [];
  let i = startIndex;
  for (const key of allowed) {
    if (fields[key] === undefined) continue;
    cols.push(`${key} = $${i++}`);
    values.push(fields[key]);
  }
  return { clause: cols.join(", "), values, next: i };
}

function projectRow(row, fields) {
  const out = {};
  for (const f of fields) {
    const v = row?.[f];
    out[f] = typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : (v === undefined ? null : snapshot(v));
  }
  return out;
}

// --- Transactions ----------------------------------------------------------
// The ambient transaction, so a knowledge write performed inside another
// knowledge write joins it instead of grabbing a second connection (which would
// deadlock a small pool and would split state from its history).
const txContext = new AsyncLocalStorage();

export function inTransaction() {
  return Boolean(txContext.getStore());
}

/**
 * Run `fn(store)` inside one transaction. `store` has the same accessors as the
 * default export, bound to this transaction's connection. Re-entrant.
 */
export async function withTransaction(fn) {
  const ambient = txContext.getStore();
  if (ambient) return fn(ambient.store);

  const p = await ready();
  const client = await p.connect();
  const run = (text, params = []) => client.query(text, params).then(r => r.rows);
  run.isTransaction = true;
  const store = createStore(run);
  try {
    await client.query("BEGIN");
    const out = await txContext.run({ run, store, client }, () => fn(store));
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* the connection is already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Run fn on a transaction if we are not already in one; otherwise inline. */
async function transacted(run, fn) {
  if (run.isTransaction) return fn(null);
  return withTransaction(fn);
}

// --- Entity accessors ----------------------------------------------------
// Named to mirror the original entity API surface (create/get/filter/update/
// delete/bulkCreate) so the council operators and routes read the same.
//
// They are built by a factory taking a query runner so the very same code runs
// against the pool and against a transaction. The SQL is unchanged from the
// pre-Phase-14 module; what was added is the ledger event appended on the same
// runner, inside the same transaction.

function createCoreStore(run) {
  const ledgerOn = () => ledgerEnabled();
  const sourceOf = (opts) => ({
    runId: opts?.ledger?.runId ?? opts?.ledger?.run_id ?? null,
    messageId: opts?.ledger?.messageId ?? opts?.ledger?.message_id ?? null,
    kind: opts?.ledger?.kind || opts?.ledger?.sourceKind || "api"
  });

  const Workspace = {
    async list() {
      return run(`SELECT * FROM workspaces ORDER BY is_default DESC, created_date ASC`);
    },
    async get(id) {
      const rows = await run(`SELECT * FROM workspaces WHERE id = $1`, [id]);
      return rows[0] || null;
    },
    async create(data) {
      const id = newId("ws");
      const rows = await run(
        `INSERT INTO workspaces (id, name, description, instructions, color, icon, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, data.name, data.description || null, data.instructions || null,
         data.color || "#3B82F6", data.icon || "Brain", !!data.is_default]
      );
      return rows[0];
    },
    async update(id, data) {
      const { clause, values, next } = set(data, ["name", "description", "instructions", "color", "icon", "is_default"]);
      if (!clause) return this.get(id);
      const rows = await run(
        `UPDATE workspaces SET ${clause}, updated_date = now() WHERE id = $${next} RETURNING *`,
        [...values, id]
      );
      return rows[0];
    },
    // Single-tenant bootstrap: guarantees exactly one default workspace exists.
    async ensureDefault() {
      const rows = await run(`SELECT * FROM workspaces ORDER BY is_default DESC, created_date ASC LIMIT 1`);
      if (rows[0]) return rows[0];
      return this.create({ name: "Personal", description: "Your default workspace", is_default: true });
    }
  };

  const Conversation = {
    async list(workspaceId, limit = 50) {
      return run(
        `SELECT * FROM conversations WHERE workspace_id = $1 AND is_archived = FALSE
         ORDER BY updated_date DESC LIMIT $2`,
        [workspaceId, limit]
      );
    },
    async get(id) {
      const rows = await run(`SELECT * FROM conversations WHERE id = $1`, [id]);
      return rows[0] || null;
    },
    async create(data) {
      const id = newId("conv");
      const rows = await run(
        `INSERT INTO conversations (id, workspace_id, title, last_message_preview, project_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, data.workspace_id, data.title, data.last_message_preview || null, data.project_id || null]
      );
      return rows[0];
    },
    // Phase 14.1: a summary write and a conversation-metadata write are stored
    // knowledge, so the transition is appended in the same transaction.
    async update(id, data, opts = {}) {
      const { clause, values, next } = set(data, ["title", "summary", "is_archived", "last_message_preview", "project_id"]);
      if (!clause) return this.get(id);
      return transacted(run, async (store) => {
        const self = store ? store.Conversation : this;
        const r = store ? store.query : run;
        const before = await self.get(id);
        const rows = await r(
          `UPDATE conversations SET ${clause}, updated_date = now() WHERE id = $${next} RETURNING *`,
          [...values, id]
        );
        const after = rows[0];
        if (!after || !ledgerOn()) return after;
        const from = projectRow(before, CONVERSATION_TRACKED_FIELDS);
        const to = projectRow(after, CONVERSATION_TRACKED_FIELDS);
        const changed = CONVERSATION_TRACKED_FIELDS.filter(f => JSON.stringify(from[f] ?? null) !== JSON.stringify(to[f] ?? null));
        if (!changed.length) return after;
        const summaryChanged = data.summary !== undefined && String(before?.summary ?? "") !== String(after.summary ?? "");
        const src = sourceOf(opts);
        await appendEvent(r, {
          workspaceId: after.workspace_id,
          entityType: "conversation",
          entityId: id,
          transition: summaryChanged ? "summary_updated" : "conversation_updated",
          fromState: from,
          toState: to,
          delta: { changed, summary: summaryChanged },
          sourceRunId: src.runId,
          sourceMessageId: src.messageId,
          sourceKind: src.kind,
          payload: { patch: Object.keys(data || {}) }
        });
        return after;
      });
    },
    async delete(id) {
      await run(`DELETE FROM conversations WHERE id = $1`, [id]);
      return { ok: true };
    },
    // Phase 18 — move a conversation into (or out of) a project. The transition
    // is appended to the ledger by the same Conversation.update transaction.
    async move(id, projectId) {
      return this.update(id, { project_id: projectId || null });
    }
  };

  const Project = {
    async list(workspaceId, limit = 100) {
      const safe = Math.max(1, Math.min(500, Number(limit) || 100));
      return run(
        `SELECT p.id, p.workspace_id, p.name, p.objective, p.created_date, p.updated_date,
                (SELECT count(*)::int FROM conversations c
                  WHERE c.project_id = p.id AND c.is_archived = FALSE) AS conversation_count,
                (SELECT count(*)::int FROM sources s WHERE s.project_id = p.id) AS source_count,
                (SELECT count(*)::int FROM agent_runs r
                  WHERE r.conversation_id IN (SELECT id FROM conversations c2 WHERE c2.project_id = p.id)) AS run_count
         FROM projects p WHERE p.workspace_id = $1
         ORDER BY p.updated_date DESC LIMIT $2`,
        [workspaceId, safe]
      );
    },
    async get(id) {
      const rows = await run(`SELECT * FROM projects WHERE id = $1`, [id]);
      return rows[0] || null;
    },
    async create(data) {
      const id = newId("prj");
      const rows = await run(
        `INSERT INTO projects (id, workspace_id, name, objective)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [id, data.workspace_id, data.name, data.objective || null]
      );
      return rows[0];
    },
    async update(id, data) {
      const { clause, values, next } = set(data, ["name", "objective"]);
      if (!clause) return this.get(id);
      const rows = await run(
        `UPDATE projects SET ${clause}, updated_date = now() WHERE id = $${next} RETURNING *`,
        [...values, id]
      );
      return rows[0];
    },
    // A project delete is a DETACH, never a data delete: conversations and
    // immutable sources keep every row and simply lose the grouping. Agent runs
    // are linked through conversations, so they detach with them.
    async delete(id) {
      const conversationResult = await run(
        `UPDATE conversations SET project_id = NULL WHERE project_id = $1`, [id]
      );
      const sourceResult = await run(`UPDATE sources SET project_id = NULL WHERE project_id = $1`, [id]);
      const rows = await run(`DELETE FROM projects WHERE id = $1`, [id]);
      return {
        ok: rows.length > 0,
        detachedConversations: conversationResult.rowCount || 0,
        detachedSources: sourceResult.rowCount || 0
      };
    }
  };

  const Message = {
    async listByConversation(conversationId, limit = 200) {
      return run(
        `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_date ASC LIMIT $2`,
        [conversationId, limit]
      );
    },
    // Newest-first slice used for the model context window.
    async recent(conversationId, limit) {
      const rows = await run(
        `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_date DESC LIMIT $2`,
        [conversationId, limit]
      );
      return rows.reverse();
    },
    async create(data) {
      const id = newId("msg");
      const rows = await run(
        `INSERT INTO messages (id, conversation_id, workspace_id, role, content, model_used, task_type, task_context_id, attachments, council, processing_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [id, data.conversation_id, data.workspace_id, data.role, data.content,
         data.model_used || null, data.task_type || null, data.task_context_id || null,
         data.attachments ? JSON.stringify(data.attachments) : null,
         data.council ? JSON.stringify(data.council) : null,
         data.processing_status || "complete"]
      );
      return rows[0];
    },
    async update(id, data) {
      const patch = { ...data };
      if (patch.council) patch.council = JSON.stringify(patch.council);
      const { clause, values, next } = set(patch, ["content", "processing_status", "council", "model_used", "task_type"]);
      if (!clause) return null;
      const rows = await run(`UPDATE messages SET ${clause} WHERE id = $${next} RETURNING *`, [...values, id]);
      return rows[0];
    }
  };

  const Memory = {
    async filter({ workspace_id, is_enabled }, limit = 100) {
      const clauses = ["workspace_id = $1"];
      const params = [workspace_id];
      if (is_enabled !== undefined) { clauses.push(`is_enabled = $${params.length + 1}`); params.push(is_enabled); }
      params.push(limit);
      return run(
        `SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY importance DESC, created_date DESC LIMIT $${params.length}`,
        params
      );
    },
    async get(id) {
      const rows = await run(`SELECT * FROM memories WHERE id = $1`, [id]);
      return rows[0] || null;
    },
    /**
     * Phase 14.1 + 14.3: a memory write is stored knowledge. In ONE transaction
     * this inserts the row, stamps its confidence, appends `memory_written`,
     * records the confidence sample, and projects the memory into the belief
     * store (creating or strengthening the belief that says the same thing).
     */
    async create(data, opts = {}) {
      return transacted(run, async (store) => {
        const r = store ? store.query : run;
        const id = newId("mem");
        const ts = Date.now();
        const confidence = num(data.confidence, null) ?? confidenceFromEvidence(data);
        const rows = await r(
          `INSERT INTO memories (id, workspace_id, content, memory_type, source, importance, evidence_level, volatility, last_confirmed, is_enabled, tags, confidence, confidence_as_of_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [id, data.workspace_id, data.content, data.memory_type || "episodic", data.source || null,
           data.importance || 5, data.evidence_level || "inferred", data.volatility || "medium",
           data.last_confirmed || new Date().toISOString(), data.is_enabled !== false,
           data.tags ? JSON.stringify(data.tags) : null, confidence, ts]
        );
        const memory = rows[0];
        if (!ledgerOn()) return memory;
        const src = sourceOf(opts);
        const event = await appendEvent(r, {
          workspaceId: memory.workspace_id,
          entityType: "memory",
          entityId: id,
          transition: "memory_written",
          toState: { ...projectRow(memory, MEMORY_TRACKED_FIELDS), id, memory_type: memory.memory_type, source: memory.source },
          delta: { confidence },
          sourceRunId: src.runId,
          sourceMessageId: src.messageId ?? memory.source ?? null,
          sourceKind: src.kind,
          payload: { origin: opts.origin || "memory_write" }
        });
        await r(
          `INSERT INTO confidence_history (id, entity_type, entity_id, confidence, prev_confidence, delta, source_event_id, source_run_id, ts_ms)
           VALUES ($1,'memory',$2,$3,NULL,NULL,$4,$5,$6)`,
          [newId("cfh"), id, confidence, event?.id ?? null, src.runId, ts]
        );
        // 14.2 — project into the belief store on the same connection.
        const projected = await projectMemoryWrite(r, {
          memory,
          source: { runId: src.runId, messageId: src.messageId ?? memory.source ?? null, kind: src.kind },
          config: opts.config || {}
        });
        memory.belief = projected.belief ? { id: projected.belief.id, confidence: num(projected.belief.confidence), status: projected.belief.status, created: !!projected.created } : null;
        return memory;
      });
    },
    /** One transaction for the whole batch, plus the co-activation links
     *  between beliefs written together (Phase 14.4). */
    async bulkCreate(records, opts = {}) {
      if (!records?.length) return [];
      return transacted(run, async (store) => {
        const self = store ? store.Memory : this;
        const out = [];
        for (const rec of records) out.push(await self.create(rec, opts));
        const beliefIds = out.map(m => m.belief?.id).filter(Boolean);
        if (ledgerOn() && beliefIds.length > 1) {
          const src = sourceOf(opts);
          await linkCoActivations(store ? store.query : run, {
            workspaceId: records[0].workspace_id,
            beliefIds,
            source: { runId: src.runId, messageId: src.messageId, kind: src.kind },
            config: opts.config || {}
          });
        }
        return out;
      });
    },
    async update(id, data, opts = {}) {
      const { clause, values, next } = set(data, ["content", "memory_type", "importance", "evidence_level", "volatility", "is_enabled", "confidence"]);
      if (!clause) return null;
      return transacted(run, async (store) => {
        const self = store ? store.Memory : this;
        const r = store ? store.query : run;
        const before = await self.get(id);
        const rows = await r(`UPDATE memories SET ${clause}, updated_date = now() WHERE id = $${next} RETURNING *`, [...values, id]);
        const after = rows[0];
        if (!after || !ledgerOn()) return after;
        const from = projectRow(before, MEMORY_TRACKED_FIELDS);
        const to = projectRow(after, MEMORY_TRACKED_FIELDS);
        const changed = MEMORY_TRACKED_FIELDS.filter(f => JSON.stringify(from[f] ?? null) !== JSON.stringify(to[f] ?? null));
        if (!changed.length) return after;
        const src = sourceOf(opts);
        const wasEnabled = Boolean(before?.is_enabled);
        const isEnabled = Boolean(after.is_enabled);
        const transition = wasEnabled !== isEnabled
          ? (isEnabled ? "memory_enabled" : "memory_disabled")
          : "memory_updated";
        const event = await appendEvent(r, {
          workspaceId: after.workspace_id,
          entityType: "memory",
          entityId: id,
          transition,
          fromState: from,
          toState: to,
          delta: { changed },
          sourceRunId: src.runId,
          sourceMessageId: src.messageId,
          sourceKind: src.kind,
          payload: { patch: Object.keys(data || {}) }
        });
        if (num(after.confidence, null) !== num(before?.confidence, null)) {
          await r(
            `INSERT INTO confidence_history (id, entity_type, entity_id, confidence, prev_confidence, delta, source_event_id, source_run_id, ts_ms)
             VALUES ($1,'memory',$2,$3,$4,$5,$6,$7,$8)`,
            [newId("cfh"), id, num(after.confidence, 0), num(before?.confidence, null),
             Number((num(after.confidence, 0) - num(before?.confidence, 0)).toFixed(4)),
             event?.id ?? null, src.runId, Date.now()]
          );
        }
        // Content changed -> the store now says something else. Project the new
        // statement; the old belief is not deleted, it simply stops being fed.
        if (typeof data.content === "string" && statementKey(data.content) !== statementKey(before?.content)) {
          await projectMemoryWrite(r, {
            memory: after,
            source: { runId: src.runId, messageId: src.messageId, kind: src.kind },
            config: opts.config || {}
          });
        }
        return after;
      });
    },
    /**
     * The row goes (existing semantics preserved) but the knowledge does not
     * vanish: the ledger keeps the prior state, and the belief that rested on it
     * is retired — a transition, not a delete.
     */
    async delete(id, opts = {}) {
      return transacted(run, async (store) => {
        const self = store ? store.Memory : this;
        const r = store ? store.query : run;
        const before = await self.get(id);
        if (ledgerOn() && before) {
          const src = sourceOf(opts);
          await appendEvent(r, {
            workspaceId: before.workspace_id,
            entityType: "memory",
            entityId: id,
            transition: "memory_retired",
            fromState: projectRow(before, MEMORY_TRACKED_FIELDS),
            toState: { ...projectRow(before, MEMORY_TRACKED_FIELDS), is_enabled: false, retired: true },
            delta: { removed_from_current_state: true },
            sourceRunId: src.runId,
            sourceMessageId: src.messageId,
            sourceKind: src.kind,
            reversible: false,
            payload: { memory_type: before.memory_type, source: before.source, prior_state_preserved: true }
          });
          // The belief that rested on this memory is retired too, and its
          // relationships weaken. Both are transitions, logged, never deletes.
          await retireBeliefByKey(r, {
            workspaceId: before.workspace_id,
            key: statementKey(before.content),
            reason: "source memory deleted by the user",
            source: { runId: src.runId, messageId: src.messageId, kind: src.kind },
            config: opts.config || {}
          });
        }
        await r(`DELETE FROM memories WHERE id = $1`, [id]);
        return { ok: true };
      });
    }
  };

  const TaskContext = {
    // Phase 14.1: a task context is a goal, and goals are stored knowledge.
    async create(data, opts = {}) {
      return transacted(run, async (store) => {
        const r = store ? store.query : run;
        const id = newId("task");
        const rows = await r(
          `INSERT INTO task_contexts (id, conversation_id, workspace_id, goal, task_type, sub_tasks, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [id, data.conversation_id || null, data.workspace_id || null, data.goal || null,
           data.task_type || null, JSON.stringify(data.sub_tasks || []), data.status || "in_progress"]
        );
        const row = rows[0];
        if (!ledgerOn()) return row;
        const src = sourceOf(opts);
        await appendEvent(r, {
          workspaceId: row.workspace_id,
          entityType: "task_context",
          entityId: id,
          transition: "goal_updated",
          toState: projectRow(row, TASK_CONTEXT_TRACKED_FIELDS),
          delta: { created: true, sub_tasks: (data.sub_tasks || []).length },
          sourceRunId: src.runId,
          sourceMessageId: src.messageId ?? data.conversation_id ?? null,
          sourceKind: src.kind || "run",
          payload: { sub_tasks: snapshot(data.sub_tasks || []) }
        });
        return row;
      });
    },
    async update(id, data, opts = {}) {
      const patch = { ...data };
      if (patch.sub_tasks) patch.sub_tasks = JSON.stringify(patch.sub_tasks);
      const { clause, values, next } = set(patch, ["goal", "task_type", "sub_tasks", "context_assembled", "final_response", "status"]);
      if (!clause) return null;
      return transacted(run, async (store) => {
        const r = store ? store.query : run;
        const beforeRows = await r(`SELECT * FROM task_contexts WHERE id = $1`, [id]);
        const before = beforeRows[0] || null;
        const rows = await r(`UPDATE task_contexts SET ${clause}, updated_date = now() WHERE id = $${next} RETURNING *`, [...values, id]);
        const after = rows[0];
        if (!after || !ledgerOn()) return after;
        const from = projectRow(before, TASK_CONTEXT_TRACKED_FIELDS);
        const to = projectRow(after, TASK_CONTEXT_TRACKED_FIELDS);
        const changed = TASK_CONTEXT_TRACKED_FIELDS.filter(f => JSON.stringify(from[f] ?? null) !== JSON.stringify(to[f] ?? null));
        const subTasksChanged = JSON.stringify(before?.sub_tasks ?? null) !== JSON.stringify(after.sub_tasks ?? null);
        if (!changed.length && !subTasksChanged) return after;
        const src = sourceOf(opts);
        await appendEvent(r, {
          workspaceId: after.workspace_id,
          entityType: "task_context",
          entityId: id,
          transition: typeof data.goal === "string" && data.goal !== before?.goal ? "goal_updated" : "task_context_updated",
          fromState: from,
          toState: to,
          delta: { changed: subTasksChanged ? [...changed, "sub_tasks"] : changed },
          sourceRunId: src.runId,
          sourceMessageId: src.messageId ?? after.conversation_id ?? null,
          sourceKind: src.kind || "run",
          payload: { patch: Object.keys(data || {}) }
        });
        return after;
      });
    },
    async get(id) {
      const rows = await run(`SELECT * FROM task_contexts WHERE id = $1`, [id]);
      return rows[0] || null;
    }
  };

  const AuditEvent = {
    async create(data) {
      const id = newId("audit");
      const rows = await run(
        `INSERT INTO audit_events (id, workspace_id, conversation_id, event_type, agent_type, model_used, task_type, latency_ms, status, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, data.workspace_id || null, data.conversation_id || null, data.event_type,
         data.agent_type || null, data.model_used || null, data.task_type || null,
         data.latency_ms || 0, data.status || "success", data.error_message || null]
      );
      return rows[0];
    },
    async recent(limit = 100) {
      return run(`SELECT * FROM audit_events ORDER BY created_date DESC LIMIT $1`, [limit]);
    }
  };

  return { Workspace, Conversation, Project, Message, Memory, TaskContext, AuditEvent };
}

// --- Composition root ------------------------------------------------------
// One factory, two bindings: the pool (`db`, the default export) and each
// transaction (the object withTransaction hands its callback).
function createStore(run) {
  const core = createCoreStore(run);
  const knowledge = createKnowledgeStore(run);
  const meta = createMetaStore(run);
  const sources = createSourceAgentStore(run);
  return {
    ...core,
    ...knowledge,
    ...meta,
    ...sources,
    query: run,
    ready,
    withTransaction,
    inTransaction: () => Boolean(run.isTransaction)
  };
}

// The object handed to the council as ctx.db — mirrors the original ctx.base44.entities.
export const db = createStore(query);

export const Workspace = db.Workspace;
export const Conversation = db.Conversation;
export const Project = db.Project;
export const Message = db.Message;
export const Memory = db.Memory;
export const TaskContext = db.TaskContext;
export const AuditEvent = db.AuditEvent;
export const KnowledgeEvent = db.KnowledgeEvent;
export const Belief = db.Belief;
export const Relationship = db.Relationship;
export const Replay = db.Replay;
export const CoherenceReport = db.CoherenceReport;
export const ConfidenceHistory = db.ConfidenceHistory;
// Phase 15 — meta-cognition namespaces (telemetry, strategies, adaptive
// decisions, evaluations, improvement ledger). Same facade, additive names.
export const TelemetryRun = db.TelemetryRun;
export const TelemetryModelCall = db.TelemetryModelCall;
export const Strategy = db.Strategy;
export const AdaptiveDecision = db.AdaptiveDecision;
export const StrategyEvaluation = db.StrategyEvaluation;
export const ImprovementLedger = db.ImprovementLedger;
// Phase 17 — immutable sources and bounded-agent execution records.
export const Source = db.Source;
export const SourceChunk = db.SourceChunk;
export const AgentRun = db.AgentRun;
export const AgentStep = db.AgentStep;
export const AgentEvent = db.AgentEvent;
export const AgentApproval = db.AgentApproval;

export { TRACKED_FIELDS, MEMORY_TRACKED_FIELDS, CONVERSATION_TRACKED_FIELDS, TASK_CONTEXT_TRACKED_FIELDS };

export default db;
