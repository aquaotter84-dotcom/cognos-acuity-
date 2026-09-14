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

// ---------------------------------------------------------------------------
// Phase 19 — Durable, governed autonomy: residents, goals, ticks, notes, the
// outbox, and the append-only records that make all of it attributable.
//
// Design invariants carried by this schema (AUTONOMY.md):
//   * Work is durable; authority is not. Nothing here can release an answer.
//   * A notice is a template id plus stored fields — there is no column that
//     could hold model-generated prose (pin.notice_deterministic).
//   * Scopes and budgets are granted by rows, never edited (pin.goal_scope_immutable).
//   * Every append-only log carries the ids that make an action attributable
//     (pin.autonomy_attributable).
// ---------------------------------------------------------------------------
export const PHASE19_SCHEMA = `
CREATE TABLE IF NOT EXISTS autonomy_agents (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  name                  TEXT NOT NULL,
  slug                  TEXT NOT NULL,
  purpose               TEXT,
  brief                 TEXT NOT NULL DEFAULT '',
  brief_version         INTEGER NOT NULL DEFAULT 1,
  supersedes_id         TEXT,
  skill_allowlist       JSONB NOT NULL DEFAULT '[]'::jsonb,
  conversation_id       TEXT,
  default_scope         JSONB NOT NULL DEFAULT '{}'::jsonb,
  default_budgets       JSONB NOT NULL DEFAULT '{}'::jsonb,
  heartbeat_interval_ms BIGINT NOT NULL DEFAULT 900000,
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Only the LIVE row for a slug is unique. A brief change inserts a new row
-- chained by supersedes_id (never an edit), so a plain unique index here would
-- make versioning impossible — and "what was this resident told when it did
-- that?" has to stay answerable (pin.resident_brief_subordinate).
CREATE UNIQUE INDEX IF NOT EXISTS autonomy_agents_slug_idx
  ON autonomy_agents (workspace_id, slug) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS autonomy_agents_version_idx
  ON autonomy_agents (workspace_id, slug, brief_version);
CREATE INDEX IF NOT EXISTS autonomy_agents_workspace_idx ON autonomy_agents (workspace_id, created_date DESC);

CREATE TABLE IF NOT EXISTS autonomy_goals (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  agent_id              TEXT,
  conversation_id       TEXT,
  project_id            TEXT,
  title                 TEXT NOT NULL,
  objective             TEXT NOT NULL,
  status                TEXT NOT NULL,
  park_reason           TEXT,
  scope                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  budget                JSONB NOT NULL DEFAULT '{}'::jsonb,
  spent                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  checkpoint            JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule              JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_run_at_ms        BIGINT,
  lease_owner           TEXT,
  lease_expires_at_ms   BIGINT,
  started_ms            BIGINT,
  ended_ms              BIGINT,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autonomy_goals_ws_status_idx ON autonomy_goals (workspace_id, status);
CREATE INDEX IF NOT EXISTS autonomy_goals_due_idx ON autonomy_goals (status, next_run_at_ms);
CREATE INDEX IF NOT EXISTS autonomy_goals_agent_idx ON autonomy_goals (agent_id, status);

CREATE TABLE IF NOT EXISTS goal_events (
  id                    TEXT PRIMARY KEY,
  seq                   BIGSERIAL,
  goal_id               TEXT NOT NULL,
  agent_id              TEXT,
  step_id               TEXT,
  tick_id               TEXT,
  event_type            TEXT NOT NULL,
  from_status           TEXT,
  to_status             TEXT,
  detail                JSONB,
  ts_ms                 BIGINT NOT NULL,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS goal_events_seq_idx ON goal_events (seq);
CREATE INDEX IF NOT EXISTS goal_events_goal_idx ON goal_events (goal_id, seq);

CREATE TABLE IF NOT EXISTS goal_steps (
  id                    TEXT PRIMARY KEY,
  goal_id               TEXT NOT NULL REFERENCES autonomy_goals(id) ON DELETE RESTRICT,
  agent_id              TEXT,
  tick_id               TEXT,
  ordinal               INTEGER NOT NULL,
  skill_id              TEXT NOT NULL,
  tier                  TEXT NOT NULL,
  status                TEXT NOT NULL,
  input                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  output                JSONB,
  error_message         TEXT,
  idempotency_key       TEXT NOT NULL,
  started_ms            BIGINT,
  ended_ms              BIGINT,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS goal_steps_ordinal_idx ON goal_steps (goal_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS goal_steps_idem_idx ON goal_steps (idempotency_key);

CREATE TABLE IF NOT EXISTS goal_notes (
  id                    TEXT PRIMARY KEY,
  goal_id               TEXT NOT NULL REFERENCES autonomy_goals(id) ON DELETE RESTRICT,
  agent_id              TEXT,
  tick_id               TEXT,
  ordinal               INTEGER NOT NULL,
  kind                  TEXT NOT NULL,
  body                  TEXT NOT NULL,
  refs                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence            NUMERIC,
  supersedes_note_id    TEXT,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS goal_notes_ordinal_idx ON goal_notes (goal_id, ordinal);
CREATE INDEX IF NOT EXISTS goal_notes_goal_idx ON goal_notes (goal_id, created_date DESC);

CREATE TABLE IF NOT EXISTS goal_authorizations (
  id                    TEXT PRIMARY KEY,
  goal_id               TEXT NOT NULL,
  scope_sha256          TEXT NOT NULL,
  budget_sha256         TEXT NOT NULL,
  decision              TEXT NOT NULL,
  reason                TEXT,
  decided_ms            BIGINT NOT NULL,
  expires_at_ms         BIGINT,
  decision_source       TEXT,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goal_authorizations_goal_idx ON goal_authorizations (goal_id, decided_ms DESC);

CREATE TABLE IF NOT EXISTS autonomy_outbox (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  agent_id              TEXT,
  goal_id               TEXT,
  tick_id               TEXT,
  step_id               TEXT,
  skill_id              TEXT NOT NULL,
  effect_type           TEXT NOT NULL,
  tier                  TEXT NOT NULL,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key       TEXT NOT NULL,
  status                TEXT NOT NULL,
  verdict               JSONB,
  scope_sha256          TEXT,
  mode                  TEXT NOT NULL DEFAULT 'shadow',
  released_ms           BIGINT,
  receipt               JSONB,
  error_message         TEXT,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS autonomy_outbox_idem_idx ON autonomy_outbox (idempotency_key);
CREATE INDEX IF NOT EXISTS autonomy_outbox_goal_idx ON autonomy_outbox (goal_id, created_date DESC);
CREATE INDEX IF NOT EXISTS autonomy_outbox_status_idx ON autonomy_outbox (status, created_date DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  id                    TEXT PRIMARY KEY,
  seq                   BIGSERIAL,
  outbox_id             TEXT NOT NULL,
  from_status           TEXT,
  to_status             TEXT,
  detail                JSONB,
  ts_ms                 BIGINT NOT NULL,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_seq_idx ON outbox_events (seq);
CREATE INDEX IF NOT EXISTS outbox_events_outbox_idx ON outbox_events (outbox_id, seq);

CREATE TABLE IF NOT EXISTS autonomy_notices (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  agent_id              TEXT,
  goal_id               TEXT,
  template_id           TEXT NOT NULL,
  fields                JSONB NOT NULL DEFAULT '{}'::jsonb,
  severity              TEXT NOT NULL DEFAULT 'info',
  created_ms            BIGINT NOT NULL,
  acked_ms              BIGINT,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autonomy_notices_ws_idx ON autonomy_notices (workspace_id, created_date DESC);

CREATE TABLE IF NOT EXISTS autonomy_ticks (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT,
  worker_id             TEXT NOT NULL,
  started_ms            BIGINT NOT NULL,
  ended_ms              BIGINT,
  duration_ms           INTEGER,
  goals_claimed         INTEGER NOT NULL DEFAULT 0,
  steps_executed        INTEGER NOT NULL DEFAULT 0,
  effects_staged        INTEGER NOT NULL DEFAULT 0,
  effects_released      INTEGER NOT NULL DEFAULT 0,
  effects_refused       INTEGER NOT NULL DEFAULT 0,
  model_calls           INTEGER NOT NULL DEFAULT 0,
  tokens_total          INTEGER NOT NULL DEFAULT 0,
  cost_usd              NUMERIC,
  detail                JSONB,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autonomy_ticks_created_idx ON autonomy_ticks (created_date DESC);

-- A resident's own conversation, and the origin of every message
-- (AUTONOMY.md §4.9.1). All nullable; no existing row changes meaning.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id        TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS goal_id         TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS note_id         TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS resident_kind   TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin          TEXT;
CREATE INDEX IF NOT EXISTS messages_agent_idx ON messages (agent_id, created_date DESC);
CREATE INDEX IF NOT EXISTS messages_goal_idx  ON messages (goal_id);
`;

// ---------------------------------------------------------------------------
// Phase 20 — Rung 3: sub-agents and the promotion path.
//
// Design invariants carried by this schema (AUTONOMY.md §4.4, §4.6):
//   * A sub-agent is a worker, not a seat. Its output is evidence with
//     provenance — never authority (pin.subagent_untrusted).
//   * Promotion is the only route from note to knowledge, and it is labelled:
//     a promoted memory lands evidence_level 'inferred', never 'direct', and a
//     promoted belief enters as a hypothesis (AUTONOMY.md §4.4).
//   * One open request per (note, target). A repeat request for the same note
//     resolves to the existing row instead of queueing a second decision.
// ---------------------------------------------------------------------------
export const PHASE20_SCHEMA = `
CREATE TABLE IF NOT EXISTS goal_subagents (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  goal_id               TEXT NOT NULL REFERENCES autonomy_goals(id) ON DELETE RESTRICT,
  agent_id              TEXT,
  tick_id               TEXT,
  parent_step_id        TEXT,
  objective             TEXT NOT NULL,
  skills                JSONB NOT NULL DEFAULT '[]'::jsonb,
  budget                JSONB NOT NULL DEFAULT '{}'::jsonb,
  spent                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                TEXT NOT NULL,
  output                JSONB,
  error_message         TEXT,
  started_ms            BIGINT,
  ended_ms              BIGINT,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goal_subagents_goal_idx ON goal_subagents (goal_id, created_date DESC);

CREATE TABLE IF NOT EXISTS note_promotions (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  goal_id               TEXT NOT NULL,
  agent_id              TEXT,
  note_id               TEXT NOT NULL,
  target                TEXT NOT NULL,
  status                TEXT NOT NULL,
  reason                TEXT,
  decided_ms            BIGINT,
  decision_source       TEXT,
  applied_memory_id     TEXT,
  applied_belief_id     TEXT,
  run_id                TEXT,
  message_id            TEXT,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS note_promotions_ws_idx ON note_promotions (workspace_id, status, created_date DESC);
CREATE INDEX IF NOT EXISTS note_promotions_goal_idx ON note_promotions (goal_id, created_date DESC);
CREATE INDEX IF NOT EXISTS note_promotions_note_idx ON note_promotions (note_id, target);
`;

// ---------------------------------------------------------------------------
// Phase 21 — Rung 4 groundwork: the webhook effect, the shadow evidence gate,
// and destination-level accounting.
//
//   * `autonomy_outbox.destination` lifts the one field an operator actually
//     approves — WHERE an external write goes — out of a payload that can be
//     32 KiB of body text, so the outbox can be listed, grouped and audited by
//     destination without expanding a payload. Nullable: every pre-Phase-21 row
//     keeps its meaning, and an internal effect has no destination.
//   * `autonomy_rung_evidence` is the row that earns a rung. AUTONOMY.md §5 makes
//     a shadow corpus the ENTRY CRITERION for Rung 4; this table is where that
//     corpus is measured and recorded, with the gate it was measured against.
//     Append-only: re-measuring writes a new row, so "what did we know when we
//     turned this on" stays answerable (pin.ledger_append_only).
// ---------------------------------------------------------------------------
export const PHASE21_SCHEMA = `
ALTER TABLE autonomy_outbox ADD COLUMN IF NOT EXISTS destination TEXT;
CREATE INDEX IF NOT EXISTS autonomy_outbox_destination_idx
  ON autonomy_outbox (destination, created_date DESC);

CREATE TABLE IF NOT EXISTS autonomy_rung_evidence (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  rung                  TEXT NOT NULL,
  tier                  TEXT,
  decision              TEXT NOT NULL,
  gate                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics               JSONB NOT NULL DEFAULT '{}'::jsonb,
  metrics_sha256        TEXT NOT NULL,
  reason                TEXT,
  decided_by            TEXT,
  decided_ms            BIGINT NOT NULL,
  created_date          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autonomy_rung_evidence_ws_idx
  ON autonomy_rung_evidence (workspace_id, rung, decided_ms DESC);
`;

// ---------------------------------------------------------------------------
// Phase 22 — bounded token window + structured memory hierarchy.
//
// The existing `content` column remains the human-readable memory. These
// nullable/additive fields make the layer, stable key, and machine-readable
// value explicit without rewriting old rows. A working record is short-lived
// context, episodic is conversation-derived history, and semantic is durable
// persistent knowledge. The context assembler decides what is admitted to a
// prompt; no memory row can bypass the Governor or become an instruction.
// ---------------------------------------------------------------------------
export const PHASE22_SCHEMA = `
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_layer TEXT NOT NULL DEFAULT 'semantic';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_key TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_value JSONB;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS memories_layer_idx ON memories (workspace_id, memory_layer, is_enabled, importance DESC, created_date DESC);
CREATE INDEX IF NOT EXISTS memories_key_idx ON memories (workspace_id, memory_key);
`;

// ---------------------------------------------------------------------------
// Phase 23 — Persistent, Trust-Annotated Knowledge-Graph Layer ("Atlas").
//
// The one-shot evolution: a system-wide, user-controlled, immutable memory
// fabric that stitches every session, every source, every intent, and every
// footstep into a single queryable, provenance-driven graph.
//
//   * Nodes: Concept, Person, Source, Event, Intent. Edges: is-about,
//     in-source, refines, contradicts, plus lifecycle kinds (supports,
//     revision, fork) that chain every curation act to its predecessor.
//   * Every node and edge carries a provenance block (timestamp, actor,
//     version, cryptographic hash). Hashes are recomputable; snapshots carry
//     a Merkle root so concurrent edits merge without data loss and drift is
//     detectable.
//   * Nothing is ever deleted. Pin/fork/retire/revise are transitionslogged
//     in knowledge_events; retiring is a status change, forking is a new node
//     with a fork edge, revising is a successor plus a revision edge.
//   * Trust is data, not authority: verified/trusted rows may satisfy a truth
//     query; untrusted/flagged rows are visible but never load-bearing until
//     a user approves them. The Governor enforces that boundary.
// ---------------------------------------------------------------------------
export const PHASE23_SCHEMA = `
-- 23.1 Graph nodes: the durable atlas of sessions, sources, intents, people.
CREATE TABLE IF NOT EXISTS graph_nodes (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  project_id        TEXT,
  conversation_id   TEXT,
  type              TEXT NOT NULL,
  label             TEXT NOT NULL,
  node_key          TEXT NOT NULL,
  content           TEXT NOT NULL,
  content_sha256    TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  trust             TEXT NOT NULL DEFAULT 'untrusted',
  confidence        NUMERIC NOT NULL DEFAULT 0.5,
  version           INTEGER NOT NULL DEFAULT 1,
  predecessor_id    TEXT,
  successor_id      TEXT,
  provenance        JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_memory_id  TEXT,
  source_message_id TEXT,
  source_run_id     TEXT,
  source_ids        JSONB NOT NULL DEFAULT '[]'::jsonb,
  retired_at_ms     BIGINT,
  created_date      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS graph_nodes_ws_idx ON graph_nodes (workspace_id, status, trust, updated_date DESC);
CREATE INDEX IF NOT EXISTS graph_nodes_type_idx ON graph_nodes (workspace_id, type, status);
CREATE INDEX IF NOT EXISTS graph_nodes_key_idx ON graph_nodes (workspace_id, node_key);
CREATE INDEX IF NOT EXISTS graph_nodes_conv_idx ON graph_nodes (conversation_id, created_date DESC);
CREATE INDEX IF NOT EXISTS graph_nodes_project_idx ON graph_nodes (project_id, created_date DESC);
CREATE INDEX IF NOT EXISTS graph_nodes_pred_idx ON graph_nodes (predecessor_id);
CREATE INDEX IF NOT EXISTS graph_nodes_succ_idx ON graph_nodes (successor_id);
CREATE INDEX IF NOT EXISTS graph_nodes_sha_idx ON graph_nodes (workspace_id, content_sha256);

-- 23.2 Graph edges: provenance-carrying relations between nodes.
CREATE TABLE IF NOT EXISTS graph_edges (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  src_node_id       TEXT NOT NULL,
  dst_node_id       TEXT NOT NULL,
  kind              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  trust             TEXT NOT NULL DEFAULT 'untrusted',
  weight            NUMERIC NOT NULL DEFAULT 0.5,
  version           INTEGER NOT NULL DEFAULT 1,
  predecessor_id    TEXT,
  successor_id      TEXT,
  provenance        JSONB NOT NULL DEFAULT '{}'::jsonb,
  edge_sha256       TEXT NOT NULL,
  source_run_id     TEXT,
  source_message_id TEXT,
  retired_at_ms     BIGINT,
  created_date      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS graph_edges_ws_idx ON graph_edges (workspace_id, kind, status);
CREATE INDEX IF NOT EXISTS graph_edges_src_idx ON graph_edges (src_node_id, status);
CREATE INDEX IF NOT EXISTS graph_edges_dst_idx ON graph_edges (dst_node_id, status);
CREATE INDEX IF NOT EXISTS graph_edges_pair_idx ON graph_edges (workspace_id, kind, src_node_id, dst_node_id);
CREATE INDEX IF NOT EXISTS graph_edges_trust_idx ON graph_edges (workspace_id, trust, status);

-- 23.3 Immutable snapshots: a Merkle root over the sorted node+edge hashes,
-- so "what did the atlas look like when we decided that" stays answerable.
-- Append-only: no accessor UPDATEd or DELETEd these rows.
CREATE TABLE IF NOT EXISTS graph_snapshots (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  merkle_root       TEXT NOT NULL,
  node_count        INTEGER NOT NULL DEFAULT 0,
  edge_count        INTEGER NOT NULL DEFAULT 0,
  node_ids          JSONB NOT NULL DEFAULT '[]'::jsonb,
  edge_ids          JSONB NOT NULL DEFAULT '[]'::jsonb,
  leaf_hashes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  provenance        JSONB NOT NULL DEFAULT '{}'::jsonb,
  note              TEXT,
  created_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS graph_snapshots_ws_idx ON graph_snapshots (workspace_id, created_date DESC);
CREATE INDEX IF NOT EXISTS graph_snapshots_root_idx ON graph_snapshots (workspace_id, merkle_root);
`;

// ---------------------------------------------------------------------------
// Phase 24 — Accounts, multi-tenant workspaces, and sealed provenance.
//
// ADDITIVE ONLY. Every statement is IF NOT EXISTS. These tables sit BESIDE the
// existing single-tenant stack, never over it:
//   * accounts        — one row per person. workspace_id -> their default
//                       private workspace (a real row in the existing
//                       `workspaces` table, so the whole stack works per-user).
//   * account_groups  — the brief's groups table (group_id, group_name,
//                       owner_id, members as a JSON array) plus the flag the
//                       role matrix needs (private_writers).
//   * jwt_blocklist   — the logout revocation list (jti until token expiry).
//                       Postgres stands in for Redis; expiry semantics match.
//   * google_auth_states — single-use CSRF state/nonce for "Sign in with
//                       Google" (10-minute TTL, consumed once).
//   * workspace_audit — append-only audit trail (<ts, user_id, workspace_id,
//                       action, resource_id>). The app issues INSERT/SELECT
//                       only; rotation is a maintenance script's job.
// ---------------------------------------------------------------------------
export const PHASE24_SCHEMA = `
-- 24.1 Accounts. Emails are stored normalized (lowercased) and unique.
-- password_hash is nullable: Google-only accounts have none. google_sub is
-- the immutable Google identity; linking an existing account REQUIRES a
-- verified Google email (enforced in server/accounts/service.js).
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  display_name   TEXT,
  password_hash  TEXT,
  auth_provider  TEXT NOT NULL DEFAULT 'email',
  google_sub     TEXT,
  google_email   TEXT,
  avatar_url     TEXT,
  workspace_id   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  last_login_at  TIMESTAMPTZ,
  created_date   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_idx ON accounts (email);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_google_sub_idx ON accounts (google_sub) WHERE google_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS accounts_workspace_idx ON accounts (workspace_id);

-- 24.2 Groups (brief §2.3). members is the JSON array of user ids; the
-- optional private_writers array carries the "read/write private bucket"
-- flag the role matrix gates on.
CREATE TABLE IF NOT EXISTS account_groups (
  id              TEXT PRIMARY KEY,
  group_name      TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  members         JSONB NOT NULL DEFAULT '[]'::jsonb,
  private_writers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_date    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_groups_owner_idx ON account_groups (owner_id);

-- 24.3 JWT revocation list. On logout the token's jti lands here until the
-- token's own exp passes (a TTL, Redis-style, in Postgres form).
CREATE TABLE IF NOT EXISTS jwt_blocklist (
  jti          TEXT PRIMARY KEY,
  user_id      TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jwt_blocklist_expiry_idx ON jwt_blocklist (expires_at);

-- 24.4 Google OAuth single-use state + nonce (CSRF / replay defence).
CREATE TABLE IF NOT EXISTS google_auth_states (
  state        TEXT PRIMARY KEY,
  nonce        TEXT NOT NULL,
  consumed     BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS google_auth_states_expiry_idx ON google_auth_states (expires_at);

-- 24.5 Append-only audit trail (brief §4). One row per mutation or denial:
-- <timestamp, user_id, workspace_id, action, resource_id>. No accessor in the
-- app ever UPDATEs or DELETEs these rows; rotation is a maintenance script.
CREATE TABLE IF NOT EXISTS workspace_audit (
  id           TEXT PRIMARY KEY,
  ts_ms        BIGINT NOT NULL,
  user_id      TEXT,
  workspace_id TEXT,
  action       TEXT NOT NULL,
  resource_id  TEXT,
  detail       JSONB,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_audit_ws_time_idx ON workspace_audit (workspace_id, ts_ms DESC);
CREATE INDEX IF NOT EXISTS workspace_audit_user_idx ON workspace_audit (user_id, ts_ms DESC);
CREATE INDEX IF NOT EXISTS workspace_audit_action_idx ON workspace_audit (action, ts_ms DESC);
`;

// ---------------------------------------------------------------------------
// Phase 25 — the delegated autonomy switch (hybrid enablement).
//
// One row per workspace holding the value an operator handed to the UI. It is
// a SETTING, not authority:
//
//   * `COGNOS_AUTONOMY_ENABLED=true` in the environment is a PIN and outranks
//     this row completely. A row can never turn a pinned deployment off, and
//     the route that would try answers 409 rather than lying about it.
//   * The row is only consulted when `COGNOS_AUTONOMY_UI_CONTROL=true`. Without
//     that delegation the table is inert: the environment decides, exactly as
//     it did before this migration.
//   * A row can only ever hold the global on/off. No rung, no ceiling, no
//     skill and no budget is settable here — those stay in code and in the
//     environment (phase19.autonomy_default_off, pin.autonomy_attributable).
//
// Absence of a row is OFF, never a default-on: the resting state of this
// system is frozen, and a fresh deployment with UI control delegated starts
// frozen with a switch the operator can use.
//
// Flips are recorded in workspace_audit as action 'autonomy.enabled' with the
// previous and next value in `detail`, so "who turned it on, and when" stays
// answerable without adding a second log table.
// ---------------------------------------------------------------------------
export const PHASE25_SCHEMA = `
CREATE TABLE IF NOT EXISTS autonomy_settings (
  workspace_id TEXT PRIMARY KEY,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  source       TEXT NOT NULL DEFAULT 'ui',
  updated_by   TEXT,
  updated_ms   BIGINT NOT NULL,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// ---------------------------------------------------------------------------
// Phase 22 (autonomy row) — the delegated OUTBOX MODE.
//
// NOTE ON THE NAME. The repository has two Phase 22s and this is the second
// one: migration 0009 is README's Phase 22 (bounded context + structured
// memory) and shipped; AUTONOMY.md §10's Phase 22 is the autonomy row —
// outbox → live from the shadow evidence record, plus T5. This block is the
// FIRST SLICE of that autonomy row and nothing else: it makes a live T4
// delivery earnable and flippable. T5 is left to the SECOND SLICE (PHASE22C,
// migration 0014, immediately below); no column here could hold one.
//
// One nullable column on the table Phase 25 already created. Null means
// "nobody has flipped the mode from here", which resolves to the resting
// state (shadow) unless an operator pinned the mode in the environment.
// Absence is OFF, exactly as it is for `enabled`.
//
// The value is bounded by the writer in server/autonomy/liveOutbox.js: it may
// only ever be one of shadow | dry_run | live, and widening it to live is
// refused unless a recorded evidence row currently satisfies the gate AND the
// deployment named exactly one approved destination. A row cannot widen a
// rung, a ceiling, a skill or a budget — same bound Phase 25 states for
// `enabled`, and for the same reason: this is the one exception to "no
// database row decides policy", so it is kept narrow enough to review.
//
// Flips are recorded in workspace_audit as action 'autonomy.outbox_mode' with
// both values, the gate digest that justified the widening, and the approved
// destination's SHA-256 (never the URL) in `detail`.
// ---------------------------------------------------------------------------
export const PHASE22B_SCHEMA = `
ALTER TABLE autonomy_settings ADD COLUMN IF NOT EXISTS outbox_mode TEXT;
`;

// ---------------------------------------------------------------------------
// Phase 22 (autonomy row, second slice) — T5 irreversible effects: per-effect
// human approval.
//
// T5 is the first tier an autonomous loop may touch that cannot be taken back
// (payment, publish, delete, access grant). Its one release rule is the reason
// this table exists: a T5 effect is released ONLY by a human approval row
// naming that exact outbox id, recorded at decision time — never by a class
// grant, a scope entry, a rung flag, a corpus, or anything the loop itself can
// write (pin.irreversible_human_approval).
//
// The row is append-only: there is no update or delete accessor. The only
// writer is the outbox decision route (a human click), so an approval can
// never originate from the loop. `scope_sha256` binds the approval to the
// scope the effect was staged under, so a decision does not outlive the
// authorization it was made against.
// ---------------------------------------------------------------------------
export const PHASE22C_SCHEMA = `
CREATE TABLE IF NOT EXISTS effect_approvals (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  outbox_id      TEXT NOT NULL,
  goal_id        TEXT,
  agent_id       TEXT,
  decision       TEXT NOT NULL,
  scope_sha256   TEXT,
  reason         TEXT,
  decided_by     TEXT,
  decided_ms     BIGINT NOT NULL,
  created_date   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS effect_approvals_outbox_idx
  ON effect_approvals (outbox_id, decided_ms DESC);
CREATE INDEX IF NOT EXISTS effect_approvals_ws_idx
  ON effect_approvals (workspace_id, decided_ms DESC);
`;

// ---------------------------------------------------------------------------
// Phase 26 — the delegated COUNCIL switches (Critic, Governor).
//
// One row per workspace, holding ONLY the two governance switches an operator
// handed to the UI. The resting state is ON for both, because they are safety
// mechanisms: an unread row reads as on (fail closed toward safety), unlike the
// autonomy switch where an unread row reads off. The row is inert unless
// COGNOS_COUNCIL_UI_CONTROL delegates the switches, and an environment pin
// (COGNOS_CRITIC_ENABLED / COGNOS_GOVERNOR_ENABLED set explicitly) outranks it.
// ---------------------------------------------------------------------------
export const PHASE26_SCHEMA = `
CREATE TABLE IF NOT EXISTS council_settings (
  workspace_id      TEXT PRIMARY KEY,
  governor_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  critic_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  source            TEXT NOT NULL DEFAULT 'ui',
  updated_by        TEXT,
  updated_ms        BIGINT NOT NULL,
  created_date      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// ---------------------------------------------------------------------------
// Phase 26 (second half) — "forgo goal authorization": one nullable column on
// autonomy_settings. A null reads as off, which is the resting state. Inert
// unless COGNOS_AUTONOMY_AUTO_AUTHORIZE_UI_CONTROL delegates the switch, and an
// environment pin (COGNOS_AUTONOMY_AUTO_AUTHORIZE) outranks it. When on, a
// newly created goal is authorized automatically — the scope/budget hashes are
// still computed and stored, the allowlist and ceilings still bind, and staged
// effects still wait for their own human approval. It forgoes the GOAL consent
// click and nothing else.
// ---------------------------------------------------------------------------
export const PHASE26B_SCHEMA = `
ALTER TABLE autonomy_settings ADD COLUMN IF NOT EXISTS auto_authorize_goals BOOLEAN;
`;

export const PHASE_SCHEMAS = [
  { id: "0001", phase: 14, name: "phase14_dynamic_systems", sql: PHASE14_SCHEMA },
  { id: "0002", phase: 15, name: "phase15_metacognition", sql: PHASE15_SCHEMA },
  { id: "0003", phase: 16, name: "phase16_latency_observability", sql: PHASE16_SCHEMA },
  { id: "0004", phase: 17, name: "phase17_sources_and_agents", sql: PHASE17_SCHEMA },
  { id: "0005", phase: 18, name: "phase18_research_projects_images", sql: PHASE18_SCHEMA },
  { id: "0006", phase: 19, name: "phase19_autonomy", sql: PHASE19_SCHEMA },
  { id: "0007", phase: 20, name: "phase20_subagents_promotion", sql: PHASE20_SCHEMA },
  { id: "0008", phase: 21, name: "phase21_webhook_effects", sql: PHASE21_SCHEMA },
  { id: "0009", phase: 22, name: "phase22_context_and_structured_memory", sql: PHASE22_SCHEMA },
  { id: "0010", phase: 23, name: "phase23_trust_annotated_graph", sql: PHASE23_SCHEMA },
  { id: "0011", phase: 24, name: "phase24_accounts_and_workspaces", sql: PHASE24_SCHEMA },
  { id: "0012", phase: 25, name: "phase25_autonomy_settings", sql: PHASE25_SCHEMA },
  { id: "0013", phase: 22, name: "phase22b_live_outbox_destination", sql: PHASE22B_SCHEMA },
  { id: "0014", phase: 22, name: "phase22c_irreversible_effects", sql: PHASE22C_SCHEMA },
  { id: "0015", phase: 26, name: "phase26_council_settings", sql: PHASE26_SCHEMA },
  { id: "0016", phase: 26, name: "phase26_auto_authorize_goals", sql: PHASE26B_SCHEMA }
];
