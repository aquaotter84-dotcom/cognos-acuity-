// Schema for the Phase 14 (Dynamic Systems) and Phase 15 (Meta-Cognition) tables.
//
// HARD CONSTRAINT: additive only. Nothing here alters the meaning of an existing
// column, drops anything, or rewrites a row. The two ALTER TABLE statements add
// nullable columns with defaults, so every existing row keeps its semantics.
//
// This module is the single source of truth. server/db.js concatenates these
// strings onto its existing idempotent SCHEMA and applies them lazily on first
// query (the established convention); scripts/write-migrations.mjs writes the
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

export const PHASE_SCHEMAS = [
  { id: "0001", phase: 14, name: "phase14_dynamic_systems", sql: PHASE14_SCHEMA },
  { id: "0002", phase: 15, name: "phase15_metacognition", sql: PHASE15_SCHEMA }
];
