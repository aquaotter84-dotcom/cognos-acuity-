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

import pg from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

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
`;

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

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

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

// --- Entity accessors ----------------------------------------------------
// Named to mirror the original entity API surface (create/get/filter/update/
// delete/bulkCreate) so the council operators and routes read the same.

export const Workspace = {
  async list() {
    return query(`SELECT * FROM workspaces ORDER BY is_default DESC, created_date ASC`);
  },
  async get(id) {
    const rows = await query(`SELECT * FROM workspaces WHERE id = $1`, [id]);
    return rows[0] || null;
  },
  async create(data) {
    const id = newId("ws");
    const rows = await query(
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
    const rows = await query(
      `UPDATE workspaces SET ${clause}, updated_date = now() WHERE id = $${next} RETURNING *`,
      [...values, id]
    );
    return rows[0];
  },
  // Single-tenant bootstrap: guarantees exactly one default workspace exists.
  async ensureDefault() {
    const rows = await query(`SELECT * FROM workspaces ORDER BY is_default DESC, created_date ASC LIMIT 1`);
    if (rows[0]) return rows[0];
    return this.create({ name: "Personal", description: "Your default workspace", is_default: true });
  }
};

export const Conversation = {
  async list(workspaceId, limit = 50) {
    return query(
      `SELECT * FROM conversations WHERE workspace_id = $1 AND is_archived = FALSE
       ORDER BY updated_date DESC LIMIT $2`,
      [workspaceId, limit]
    );
  },
  async get(id) {
    const rows = await query(`SELECT * FROM conversations WHERE id = $1`, [id]);
    return rows[0] || null;
  },
  async create(data) {
    const id = newId("conv");
    const rows = await query(
      `INSERT INTO conversations (id, workspace_id, title, last_message_preview)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, data.workspace_id, data.title, data.last_message_preview || null]
    );
    return rows[0];
  },
  async update(id, data) {
    const { clause, values, next } = set(data, ["title", "summary", "is_archived", "last_message_preview"]);
    if (!clause) return this.get(id);
    const rows = await query(
      `UPDATE conversations SET ${clause}, updated_date = now() WHERE id = $${next} RETURNING *`,
      [...values, id]
    );
    return rows[0];
  },
  async delete(id) {
    await query(`DELETE FROM conversations WHERE id = $1`, [id]);
    return { ok: true };
  }
};

export const Message = {
  async listByConversation(conversationId, limit = 200) {
    return query(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_date ASC LIMIT $2`,
      [conversationId, limit]
    );
  },
  // Newest-first slice used for the model context window.
  async recent(conversationId, limit) {
    const rows = await query(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_date DESC LIMIT $2`,
      [conversationId, limit]
    );
    return rows.reverse();
  },
  async create(data) {
    const id = newId("msg");
    const rows = await query(
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
    const rows = await query(`UPDATE messages SET ${clause} WHERE id = $${next} RETURNING *`, [...values, id]);
    return rows[0];
  }
};

export const Memory = {
  async filter({ workspace_id, is_enabled }, limit = 100) {
    const clauses = ["workspace_id = $1"];
    const params = [workspace_id];
    if (is_enabled !== undefined) { clauses.push(`is_enabled = $${params.length + 1}`); params.push(is_enabled); }
    params.push(limit);
    return query(
      `SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY importance DESC, created_date DESC LIMIT $${params.length}`,
      params
    );
  },
  async create(data) {
    const id = newId("mem");
    const rows = await query(
      `INSERT INTO memories (id, workspace_id, content, memory_type, source, importance, evidence_level, volatility, last_confirmed, is_enabled, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id, data.workspace_id, data.content, data.memory_type || "episodic", data.source || null,
       data.importance || 5, data.evidence_level || "inferred", data.volatility || "medium",
       data.last_confirmed || new Date().toISOString(), data.is_enabled !== false,
       data.tags ? JSON.stringify(data.tags) : null]
    );
    return rows[0];
  },
  async bulkCreate(records) {
    const out = [];
    for (const r of records) out.push(await this.create(r));
    return out;
  },
  async update(id, data) {
    const { clause, values, next } = set(data, ["content", "memory_type", "importance", "evidence_level", "volatility", "is_enabled"]);
    if (!clause) return null;
    const rows = await query(
      `UPDATE memories SET ${clause}, updated_date = now() WHERE id = $${next} RETURNING *`,
      [...values, id]
    );
    return rows[0];
  },
  async delete(id) {
    await query(`DELETE FROM memories WHERE id = $1`, [id]);
    return { ok: true };
  }
};

export const TaskContext = {
  async create(data) {
    const id = newId("task");
    const rows = await query(
      `INSERT INTO task_contexts (id, conversation_id, workspace_id, goal, task_type, sub_tasks, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, data.conversation_id || null, data.workspace_id || null, data.goal || null,
       data.task_type || null, JSON.stringify(data.sub_tasks || []), data.status || "in_progress"]
    );
    return rows[0];
  },
  async update(id, data) {
    const patch = { ...data };
    if (patch.sub_tasks) patch.sub_tasks = JSON.stringify(patch.sub_tasks);
    const { clause, values, next } = set(patch, ["goal", "task_type", "sub_tasks", "context_assembled", "final_response", "status"]);
    if (!clause) return null;
    const rows = await query(
      `UPDATE task_contexts SET ${clause}, updated_date = now() WHERE id = $${next} RETURNING *`,
      [...values, id]
    );
    return rows[0];
  }
};

export const AuditEvent = {
  async create(data) {
    const id = newId("audit");
    const rows = await query(
      `INSERT INTO audit_events (id, workspace_id, conversation_id, event_type, agent_type, model_used, task_type, latency_ms, status, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, data.workspace_id || null, data.conversation_id || null, data.event_type,
       data.agent_type || null, data.model_used || null, data.task_type || null,
       data.latency_ms || 0, data.status || "success", data.error_message || null]
    );
    return rows[0];
  },
  async recent(limit = 100) {
    return query(`SELECT * FROM audit_events ORDER BY created_date DESC LIMIT $1`, [limit]);
  }
};

// The object handed to the council as ctx.db — mirrors the original ctx.base44.entities.
export const db = { Workspace, Conversation, Message, Memory, TaskContext, AuditEvent, query, ready };
export default db;
