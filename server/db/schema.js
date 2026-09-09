// Schema for Phase 14 (Dynamic Systems), Phase 15 (Meta-Cognition), and
// Phase 16's additive latency-observability columns, Phase 17's governed
// source-ingestion and bounded-agent records, and Phase 18's durable research
// projects, immutable image originals, and vision-analysis provenance.
//
// HARD CONSTRAINT: additive only. Nothing here alters the meaning of an existing
// column, drops anything, or rewrites a row. ALTER TABLE statements only add
// nullable columns, so every existing row keeps its semantics.
//
// This module is the single source of truth. server/db.js concatenates these
// strings onto its existing idempotent SCHEMA and applies them lazily on first
// query (the established convention); scripts/generate-migrations.mjs writes the
// exact same text out to migrations/*.sql for reviewers and for a manual apply.
// `npm run smoke` asserts the files and the strings have not drifted.

// ---------------------------------------------------------------------------
// Phase 14 — Dynamic Systems: the knowledge layer becomes event-driven.
// ---------------------------------------------------------------------------
export const PHASE14_SCHEMA = `
-- 14.1 Event Ledger. Append-only. Nothing is ever UPDATEd or DELETEd here:
-- retiring a belief is a transition, not a delete. This is NOT audit_events
-- (which stays exactly as it was); the ledger sits alongside it.
CREATE TABLE IF NOT EXISTS knowledge_events (
  id                TEXT PRIMARY KEY,
  seq               BIGSERIAL,
  ts_ms             BIGINT NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_id      TEXT,
  entity_type       TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  transition        TEXT NOT NULL,
  from_state        JSONB,
  to_state          JSONB,
  delta             JSONB,
  source_kind       TEXT,
  source_message_id TEXT,
  source_run_id     TEXT,
  reversible        BOOLEAN NOT NULL DEFAULT TRUE,
  payload           JSONB,
  created_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_events_seq_idx ON knowledge_events (seq);
CREATE INDEX IF NOT EXISTS knowledge_events_entity_idx ON knowledge_events (entity_type, entity_id, ts_ms);
CREATE INDEX IF NOT EXISTS knowledge_events_run_idx ON knowledge_events (source_run_id);
CREATE INDEX IF NOT EXISTS knowledge_events_transition_idx ON knowledge_events (transition, occurred_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_events_ws_time_idx ON knowledge_events (workspace_id, ts_ms DESC);

-- 14.2/14.3 Beliefs: current state, maintained transactionally for fast reads.
-- The authoritative history lives in knowledge_events; this row is the fold's
-- materialized head, and replay() can reconstruct it at any past millisecond.
CREATE TABLE IF NOT EXISTS beliefs (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  statement          TEXT NOT NULL,
  statement_key      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active',
  hypothesis         BOOLEAN NOT NULL DEFAULT FALSE,
  confidence         NUMERIC NOT NULL DEFAULT 0.5,
  evidence_level     TEXT DEFAULT 'inferred',
  volatility         TEXT DEFAULT 'medium',
  source_memory_id   TEXT,
  support_count      INTEGER NOT NULL DEFAULT 1,
  contradict_count   INTEGER NOT NULL DEFAULT 0,
  first_seen_ms      BIGINT NOT NULL,
  last_confirmed_ms  BIGINT NOT NULL,
  retired_at_ms      BIGINT,
  successor_id       TEXT,
  lineage            JSONB,
  created_date       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS beliefs_ws_key_idx ON beliefs (workspace_id, statement_key);
CREATE INDEX IF NOT EXISTS beliefs_ws_status_idx ON beliefs (workspace_id, status, confidence DESC);

-- 14.3 Confidence history: one row per confidence change, for any entity that
-- carries confidence (beliefs, memories, relationships).
CREATE TABLE IF NOT EXISTS confidence_history (
  id              TEXT PRIMARY KEY,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  confidence      NUMERIC NOT NULL,
  prev_confidence NUMERIC,
  delta           NUMERIC,
  source_event_id TEXT,
  source_run_id   TEXT,
  ts_ms           BIGINT NOT NULL,
  created_date    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS confidence_history_entity_idx ON confidence_history (entity_type, entity_id, ts_ms);

-- 14.4 Relationship Dynamics: living structures with strength and direction.
-- strength is materialized as of strength_as_of_ms; the effective strength at
-- any later instant is strength * exp(-ln2 * age / half_life), so stale links
-- weaken on their own without a writer having to touch them.
CREATE TABLE IF NOT EXISTS relationships (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  subject_type        TEXT NOT NULL,
  subject_id          TEXT NOT NULL,
  object_type         TEXT NOT NULL,
  object_id           TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'association',
  direction           TEXT NOT NULL DEFAULT 'bidirectional',
  strength            NUMERIC NOT NULL DEFAULT 0.5,
  strength_as_of_ms   BIGINT NOT NULL,
  interactions        INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'active',
  merged_into         TEXT,
  split_into          JSONB,
  decay_half_life_ms  BIGINT,
  lineage             JSONB,
  created_date        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS relationships_pair_idx
  ON relationships (workspace_id, kind, subject_type, subject_id, object_type, object_id);
CREATE INDEX IF NOT EXISTS relationships_ws_idx ON relationships (workspace_id, status, strength DESC);

-- 14.5 Coherence Monitor reports: one per council cycle that checked. A
-- contradiction is a measurement, not an error, so it is stored as data.
CREATE TABLE IF NOT EXISTS coherence_reports (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  workspace_id     TEXT,
  conversation_id  TEXT,
  message_id       TEXT,
  checked          BOOLEAN NOT NULL DEFAULT FALSE,
  verdict          TEXT NOT NULL DEFAULT 'unchecked',
  draft_shipped    BOOLEAN,
  persisted        BOOLEAN NOT NULL DEFAULT FALSE,
  skip_reason      TEXT,
  claims           JSONB,
  contradictions   JSONB,
  confirmations    JSONB,
  belief_ids       JSONB,
  confidence_delta NUMERIC,
  model_used       TEXT,
  latency_ms       INTEGER,
  note             TEXT,
  created_date     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coherence_reports_run_idx ON coherence_reports (run_id);
CREATE INDEX IF NOT EXISTS coherence_reports_verdict_idx ON coherence_reports (verdict, created_date DESC);

-- 14.3 ADDITIVE: memory rows carry a confidence and the instant it was set.
-- Existing rows get NULL confidence (unknown) and keep every other value.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence NUMERIC;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS confidence_as_of_ms BIGINT;
`;

// ---------------------------------------------------------------------------
// Phase 15 — Meta-Cognition: the system studies its own reasoning.
// ---------------------------------------------------------------------------
export const PHASE15_SCHEMA = `
-- 15.1 Reasoning telemetry: exactly one record per orchestration run.
CREATE TABLE IF NOT EXISTS telemetry_runs (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT,
  conversation_id        TEXT,
  message_id             TEXT,
  strategy_id            TEXT NOT NULL,
  status                 TEXT NOT NULL,
  started_ms             BIGINT NOT NULL,
  ended_ms               BIGINT,
  latency_ms             INTEGER,
  time_to_first_token_ms INTEGER,
  stages                 JSONB NOT NULL,
  stage_order            JSONB,
  models                 JSONB,
  model_calls            INTEGER NOT NULL DEFAULT 0,
  tokens_prompt          INTEGER NOT NULL DEFAULT 0,
  tokens_completion      INTEGER NOT NULL DEFAULT 0,
  tokens_total           INTEGER NOT NULL DEFAULT 0,
  tokens_measured        BOOLEAN NOT NULL DEFAULT FALSE,
  tokens_estimated       INTEGER NOT NULL DEFAULT 0,
  cost_usd               NUMERIC,
  cost_rate_known        BOOLEAN NOT NULL DEFAULT FALSE,
  confidence             NUMERIC,
  confidence_source      TEXT,
  coherence_verdict      TEXT,
  coherence_contradictions INTEGER NOT NULL DEFAULT 0,
  vetoed                 BOOLEAN NOT NULL DEFAULT FALSE,
  veto_flags             JSONB,
  veto_reason            TEXT,
  veto_draft_origin      TEXT,
  veto_draft_sha256      TEXT,
  retries                INTEGER NOT NULL DEFAULT 0,
  failures               JSONB,
  failure_count          INTEGER NOT NULL DEFAULT 0,
  adaptive               JSONB,
  ledger_events          INTEGER NOT NULL DEFAULT 0,
  knowledge              JSONB,
  task_type              TEXT,
  complexity             TEXT,
  response_chars         INTEGER,
  error_message          TEXT,
  created_date           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telemetry_runs_created_idx ON telemetry_runs (created_date DESC);
CREATE INDEX IF NOT EXISTS telemetry_runs_conv_idx ON telemetry_runs (conversation_id, created_date DESC);
CREATE INDEX IF NOT EXISTS telemetry_runs_status_idx ON telemetry_runs (status, created_date DESC);

-- 15.1 Per model call, including every failure the layer can see: timeouts,
-- aborts, upstream HTTP errors, malformed JSON. One row per callLLM().
CREATE TABLE IF NOT EXISTS telemetry_model_calls (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  seq               INTEGER NOT NULL DEFAULT 1,
  stage             TEXT,
  purpose           TEXT,
  model             TEXT,
  requested_model   TEXT,
  status            TEXT NOT NULL,
  http_status       INTEGER,
  latency_ms        INTEGER,
  streamed          BOOLEAN NOT NULL DEFAULT FALSE,
  tokens_prompt     INTEGER,
  tokens_completion INTEGER,
  tokens_total      INTEGER,
  tokens_measured   BOOLEAN NOT NULL DEFAULT FALSE,
  chars_out         INTEGER,
  cost_usd          NUMERIC,
  error_class       TEXT,
  error_message     TEXT,
  attempt           INTEGER NOT NULL DEFAULT 1,
  created_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telemetry_model_calls_run_idx ON telemetry_model_calls (run_id, seq);
CREATE INDEX IF NOT EXISTS telemetry_model_calls_status_idx ON telemetry_model_calls (status, created_date DESC);

-- 15.2 Strategy registry. server/shared/registry.js was checked first and does
-- NOT fit this role: it is a per-run in-process map of stage name -> agent
-- (createRegistry() is called inside runCouncilTurn and thrown away), it holds
-- no selection signals, no persistence and no enable/disable state. This table
-- is the durable registry. Seeded with exactly one row: the canonical pipeline.
CREATE TABLE IF NOT EXISTS strategies (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  selection_signals JSONB NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  is_default        BOOLEAN NOT NULL DEFAULT FALSE,
  evidence          JSONB,
  policy_ref        TEXT,
  created_date      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS strategies_name_idx ON strategies (name);

-- 15.3 Evaluation harness results (offline, operator-invoked).
CREATE TABLE IF NOT EXISTS strategy_evaluations (
  id                TEXT PRIMARY KEY,
  evaluation_id     TEXT NOT NULL,
  strategy_id       TEXT NOT NULL,
  arm               TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  trial             INTEGER NOT NULL,
  run_id            TEXT,
  latency_ms        INTEGER,
  cost_usd          NUMERIC,
  vetoed            BOOLEAN,
  coherence_verdict TEXT,
  status            TEXT,
  score             NUMERIC,
  detail            JSONB,
  created_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS strategy_evaluations_eval_idx ON strategy_evaluations (evaluation_id, arm, trial);

-- 15.4 Adaptive orchestrator decisions. Observe mode only in v1: switched is
-- always FALSE and the row records what WOULD have been selected, and why.
CREATE TABLE IF NOT EXISTS adaptive_decisions (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL,
  mode                   TEXT NOT NULL DEFAULT 'observe',
  selected_strategy_id   TEXT NOT NULL,
  would_select_id        TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  signals                JSONB NOT NULL,
  switched               BOOLEAN NOT NULL DEFAULT FALSE,
  switch_blocked_by      TEXT,
  evidence               JSONB,
  created_date           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS adaptive_decisions_run_idx ON adaptive_decisions (run_id);
CREATE INDEX IF NOT EXISTS adaptive_decisions_created_idx ON adaptive_decisions (created_date DESC);

-- 15.6 Improvement Ledger: append-only record of architectural change
-- proposals, the law that constrains each one, the justification, and whether
-- it was applied or reverted. Refusals are rows too.
CREATE TABLE IF NOT EXISTS improvement_ledger (
  id            TEXT PRIMARY KEY,
  seq           BIGSERIAL,
  ts_ms         BIGINT NOT NULL,
  action        TEXT NOT NULL,
  target        TEXT,
  proposal      JSONB NOT NULL,
  evidence      JSONB,
  law_refs      JSONB,
  justification TEXT,
  decision      TEXT NOT NULL,
  reasons       JSONB,
  applied       BOOLEAN NOT NULL DEFAULT FALSE,
  reverted      BOOLEAN NOT NULL DEFAULT FALSE,
  revert_of     TEXT,
  proposed_by   TEXT,
  created_date  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS improvement_ledger_seq_idx ON improvement_ledger (seq);
CREATE INDEX IF NOT EXISTS improvement_ledger_decision_idx ON improvement_ledger (decision, ts_ms DESC);
CREATE INDEX IF NOT EXISTS improvement_ledger_action_idx ON improvement_ledger (action, ts_ms DESC);
`;

// ---------------------------------------------------------------------------
// Phase 16 — Latency and model-transport observability. Measurements only: no
// reasoning decision, prompt, operator, or stored conclusion changes. Existing
// rows remain valid with NULL performance/provider/request-correlation fields.
// ---------------------------------------------------------------------------
export const PHASE16_SCHEMA = `
ALTER TABLE telemetry_runs ADD COLUMN IF NOT EXISTS performance JSONB;

ALTER TABLE telemetry_model_calls ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE telemetry_model_calls ADD COLUMN IF NOT EXISTS response_headers_ms INTEGER;
ALTER TABLE telemetry_model_calls ADD COLUMN IF NOT EXISTS response_decode_ms INTEGER;
ALTER TABLE telemetry_model_calls ADD COLUMN IF NOT EXISTS prompt_cached_tokens INTEGER;
ALTER TABLE telemetry_model_calls ADD COLUMN IF NOT EXISTS requested_service_tier TEXT;
ALTER TABLE telemetry_model_calls ADD COLUMN IF NOT EXISTS service_tier TEXT;
`;

// ---------------------------------------------------------------------------
// Phase 17 — Sources + bounded agent mode. Source snapshots and chunks are
// immutable evidence. Agent runs/steps are materialized state; agent_events and
// agent_approvals are append-only records of every transition and decision.
// No table grants an agent a council seat or a user-facing answer channel.
// ---------------------------------------------------------------------------
export const PHASE17_SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  conversation_id    TEXT,
  kind               TEXT NOT NULL,
  name               TEXT NOT NULL,
  canonical_url      TEXT,
  final_url          TEXT,
  media_type         TEXT NOT NULL,
  byte_size          INTEGER NOT NULL,
  content_sha256     TEXT NOT NULL,
  extracted_text     TEXT NOT NULL,
  extraction         JSONB NOT NULL,
  risk_flags         JSONB NOT NULL,
  fetched_at         TIMESTAMPTZ,
  created_date       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_workspace_created_idx ON sources (workspace_id, created_date DESC);
CREATE INDEX IF NOT EXISTS sources_conversation_idx ON sources (conversation_id, created_date DESC);
CREATE INDEX IF NOT EXISTS sources_sha_idx ON sources (workspace_id, content_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS sources_workspace_kind_sha_unique_idx ON sources (workspace_id, kind, content_sha256, COALESCE(canonical_url, ''));
CREATE INDEX IF NOT EXISTS sources_url_idx ON sources (workspace_id, canonical_url);

CREATE TABLE IF NOT EXISTS source_chunks (
  id                 TEXT PRIMARY KEY,
  source_id          TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  ordinal            INTEGER NOT NULL,
  locator            JSONB NOT NULL,
  content            TEXT NOT NULL,
  content_sha256     TEXT NOT NULL,
  char_start         INTEGER NOT NULL,
  char_end           INTEGER NOT NULL,
  created_date       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS source_chunks_ordinal_idx ON source_chunks (source_id, ordinal);
CREATE INDEX IF NOT EXISTS source_chunks_source_idx ON source_chunks (source_id, ordinal);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                 TEXT PRIMARY KEY,
  council_run_id     TEXT,
  workspace_id       TEXT NOT NULL,
  conversation_id    TEXT,
  objective          TEXT NOT NULL,
  mode               TEXT NOT NULL,
  status             TEXT NOT NULL,
  budget             JSONB NOT NULL,
  plan               JSONB NOT NULL,
  summary            JSONB,
  started_ms         BIGINT NOT NULL,
  ended_ms           BIGINT,
  error_message      TEXT,
  created_date       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_council_run_idx ON agent_runs (council_run_id);
CREATE INDEX IF NOT EXISTS agent_runs_workspace_idx ON agent_runs (workspace_id, created_date DESC);

CREATE TABLE IF NOT EXISTS agent_steps (
  id                 TEXT PRIMARY KEY,
  agent_run_id       TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  ordinal            INTEGER NOT NULL,
  tool_name          TEXT NOT NULL,
  risk_level         TEXT NOT NULL,
  requires_approval  BOOLEAN NOT NULL DEFAULT FALSE,
  status             TEXT NOT NULL,
  input              JSONB NOT NULL,
  output             JSONB,
  error_message      TEXT,
  idempotency_key    TEXT NOT NULL,
  started_ms         BIGINT,
  ended_ms           BIGINT,
  created_date       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_steps_ordinal_idx ON agent_steps (agent_run_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS agent_steps_idempotency_idx ON agent_steps (idempotency_key);

CREATE TABLE IF NOT EXISTS agent_events (
  id                 TEXT PRIMARY KEY,
  seq                BIGSERIAL,
  agent_run_id       TEXT NOT NULL,
  step_id            TEXT,
  event_type         TEXT NOT NULL,
  from_status        TEXT,
  to_status          TEXT,
  detail             JSONB,
  ts_ms              BIGINT NOT NULL,
  created_date       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_events_seq_idx ON agent_events (seq);
CREATE INDEX IF NOT EXISTS agent_events_run_idx ON agent_events (agent_run_id, seq);

CREATE TABLE IF NOT EXISTS agent_approvals (
  id                 TEXT PRIMARY KEY,
  agent_run_id       TEXT NOT NULL,
  step_id            TEXT NOT NULL,
  decision           TEXT NOT NULL,
  scope_sha256       TEXT NOT NULL,
  reason             TEXT,
  decided_ms         BIGINT NOT NULL,
  created_date       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_approvals_step_idx ON agent_approvals (step_id, decided_ms DESC);
`;


// ---------------------------------------------------------------------------
// Phase 18 — Governed research projects: durable project groupings, immutable
// image originals with vision-analysis provenance, and per-source project
// scope. Additive only; every image byte is stored once and never rewritten.
// ---------------------------------------------------------------------------
export const PHASE18_SCHEMA = `
-- 18.1 Durable projects. A project groups conversations, immutable evidence,
-- agent runs, and research decisions around one investigation. It is a folder,
-- not an account boundary: the app stays single-workspace and single-tenant.
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  objective    TEXT,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects (workspace_id, updated_date DESC);

-- 18.1 Conversations and sources become optionally project-scoped. Existing
-- rows stay NULL (ungrouped) and keep every previous meaning. Deleting a
-- project detaches, never deletes, its conversations and sources.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id TEXT;
CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations (project_id, updated_date DESC);

ALTER TABLE sources ADD COLUMN IF NOT EXISTS project_id TEXT;
CREATE INDEX IF NOT EXISTS sources_project_idx ON sources (project_id, created_date DESC);

-- 18.2 Immutable image originals. The bytes are stored once, keyed 1:1 to the
-- hashed source row; nothing here is ever UPDATEd or DELETEd by an accessor.
CREATE TABLE IF NOT EXISTS source_images (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL UNIQUE REFERENCES sources(id) ON DELETE RESTRICT,
  format         TEXT NOT NULL,
  width          INTEGER NOT NULL,
  height         INTEGER NOT NULL,
  byte_size      INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  bytes          BYTEA NOT NULL,
  created_date   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS source_images_sha_idx ON source_images (content_sha256);

-- 18.3 Vision-analysis provenance: one row per model reading of an immutable
-- image original. A reading is a recorded interpretation, not the artifact:
-- the artifact is the hashed bytea above, and the reading is labeled as such
-- in evidence packs. Rows are append-only; a re-analysis is a new row.
CREATE TABLE IF NOT EXISTS image_analyses (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  model_used    TEXT NOT NULL,
  status        TEXT NOT NULL,
  visual_type   TEXT,
  summary       TEXT,
  regions       JSONB NOT NULL DEFAULT '[]'::jsonb,
  latency_ms    INTEGER,
  attempts      INTEGER NOT NULL DEFAULT 1,
  usage         JSONB,
  error_message TEXT,
  created_date  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS image_analyses_source_idx ON image_analyses (source_id, created_date DESC);
`;

export const PHASE_SCHEMAS = [
  { id: "0001", phase: 14, name: "phase14_dynamic_systems", sql: PHASE14_SCHEMA },
  { id: "0002", phase: 15, name: "phase15_metacognition", sql: PHASE15_SCHEMA },
  { id: "0003", phase: 16, name: "phase16_latency_observability", sql: PHASE16_SCHEMA },
  { id: "0004", phase: 17, name: "phase17_sources_and_agents", sql: PHASE17_SCHEMA },
  { id: "0005", phase: 18, name: "phase18_research_projects_images", sql: PHASE18_SCHEMA }
];
