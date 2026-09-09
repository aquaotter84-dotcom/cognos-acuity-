// Persistence for durable, governed autonomy (Phase 19).
//
// Same conventions as the Phase 14/15/17 stores: a factory over one `run`
// binding, so the same accessors work against the pool and inside a transaction.
//
// Three rules this file enforces structurally, not by convention:
//
//   1. Logs are append-only. GoalEvent, OutboxEvent, GoalNote and
//      GoalAuthorization have no update or delete accessor at all. A correction
//      is a new row (pin.ledger_append_only).
//   2. A brief is never edited. AutonomyAgent.update() refuses `brief`;
//      a brief change goes through createVersion(), which writes a new row and
//      chains supersedes_id (pin.resident_brief_subordinate).
//   3. A goal is claimed by a compare-and-set on its lease. Two workers racing
//      produce exactly one winner — that is the crash-recovery and
//      multi-replica mechanism, and it is one UPDATE, not a read-then-write.

import { newId, num, int } from "../db/util.js";

const json = (value, fallback) => JSON.stringify(value ?? fallback);
const parse = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

/** Statuses a goal may occupy. Transitions are appended, never applied silently. */
export const GOAL_STATUSES = Object.freeze([
  "proposed",            // created, not yet authorized
  "awaiting_authorization",
  "active",              // leased and advancing
  "parked",              // stopped with a reason; resumable with authorization
  "completed",
  "cancelled",
  "expired"
]);

export const PARK_REASONS = Object.freeze([
  "awaiting_approval",
  "budget_exhausted",
  "blocked_on_evidence",
  "error_backoff",
  "paused_by_user",
  "kill_switch",
  "scope_expired"
]);

export function createAutonomyStore(run) {
  // -------------------------------------------------------------------------
  // Residents. A brief change is a NEW ROW with a new version, never an edit,
  // so the record always shows what the resident was actually told.
  // -------------------------------------------------------------------------
  const AutonomyAgent = {
    async create(data) {
      const id = data.id || newId("agt");
      const rows = await run(
        `INSERT INTO autonomy_agents
          (id, workspace_id, name, slug, purpose, brief, brief_version, supersedes_id,
           skill_allowlist, conversation_id, default_scope, default_budgets,
           heartbeat_interval_ms, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [id, data.workspace_id, data.name, data.slug, data.purpose || null,
         String(data.brief || ""), int(data.brief_version, 1), data.supersedes_id || null,
         json(data.skill_allowlist, []), data.conversation_id || null,
         json(data.default_scope, {}), json(data.default_budgets, {}),
         int(data.heartbeat_interval_ms, 900_000), data.enabled === true]
      );
      return rows[0];
    },

    async get(id) {
      const rows = await run(`SELECT * FROM autonomy_agents WHERE id=$1`, [id]);
      return rows[0] || null;
    },

    /**
     * The CURRENT version of each resident — one row per slug.
     *
     * list() returns every version ever written, which is right for an audit
     * trail and wrong for a list of residents: after a brief change it shows
     * the same resident twice, as if there were two of them. "Current" is not
     * `supersedes_id IS NULL` — that is only ever true of the FIRST version.
     * It means nothing supersedes this row.
     */
    async listCurrent(workspaceId, limit = 100) {
      const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
      return run(
        `SELECT * FROM autonomy_agents a
          WHERE a.workspace_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM autonomy_agents s WHERE s.supersedes_id = a.id
            )
          ORDER BY a.created_date DESC
          LIMIT $2`,
        [workspaceId, safeLimit]
      );
    },

    /** Every version of one resident's brief, oldest first. */
    async history(id, limit = 100) {
      const row = await run(`SELECT workspace_id, slug FROM autonomy_agents WHERE id = $1`, [id]);
      if (!row[0]) return [];
      const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
      return run(
        `SELECT * FROM autonomy_agents
          WHERE workspace_id = $1 AND slug = $2
          ORDER BY brief_version ASC
          LIMIT $3`,
        [row[0].workspace_id, row[0].slug, safeLimit]
      );
    },

    async list(workspaceId, limit = 100) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
      return run(
        `SELECT * FROM autonomy_agents WHERE workspace_id=$1
         ORDER BY created_date DESC LIMIT $2`, [workspaceId, safeLimit]
      );
    },

    async listEnabled(workspaceId) {
      return run(
        `SELECT * FROM autonomy_agents
         WHERE workspace_id=$1 AND enabled=TRUE
         ORDER BY created_date ASC`, [workspaceId]
      );
    },

    /** The highest brief version for this slug. New residents start at 1. */
    async latestVersion(workspaceId, slug) {
      const rows = await run(
        `SELECT MAX(brief_version) AS v FROM autonomy_agents WHERE workspace_id=$1 AND slug=$2`,
        [workspaceId, slug]
      );
      return int(rows[0]?.v, 0);
    },

    /**
     * A brief change. Writes a NEW row at version+1 chained to the old one.
     * The previous row is never touched, so "what was it told when it did
     * that?" is always answerable.
     */
    async createVersion({ agent, brief, patch = {} }) {
      const version = int(agent.brief_version, 1) + 1;
      const created = await AutonomyAgent.create({
        workspace_id: agent.workspace_id,
        name: patch.name || agent.name,
        slug: agent.slug,
        purpose: patch.purpose ?? agent.purpose,
        brief: String(brief || ""),
        brief_version: version,
        supersedes_id: agent.id,
        skill_allowlist: patch.skill_allowlist ?? parse(agent.skill_allowlist, []),
        conversation_id: patch.conversation_id ?? agent.conversation_id,
        default_scope: patch.default_scope ?? parse(agent.default_scope, {}),
        default_budgets: patch.default_budgets ?? parse(agent.default_budgets, {}),
        heartbeat_interval_ms: patch.heartbeat_interval_ms ?? int(agent.heartbeat_interval_ms, 900_000),
        enabled: patch.enabled ?? agent.enabled === true
      });
      return created;
    },

    /**
     * Operational fields only. `brief` is rejected here by design — using this
     * to change a brief would erase what the resident was told.
     */
    async update(id, patch = {}) {
      const allowed = ["name", "purpose", "conversation_id", "skill_allowlist",
        "default_scope", "default_budgets", "heartbeat_interval_ms", "enabled"];
      const sets = [];
      const values = [];
      for (const key of allowed) {
        if (patch[key] === undefined) continue;
        values.push(["skill_allowlist", "default_scope", "default_budgets"].includes(key)
          ? json(patch[key], key === "skill_allowlist" ? [] : {})
          : patch[key]);
        sets.push(`${key} = $${values.length}`);
      }
      if (!sets.length) return AutonomyAgent.get(id);
      values.push(id);
      const rows = await run(
        `UPDATE autonomy_agents SET ${sets.join(", ")}, updated_date = now()
         WHERE id = $${values.length} RETURNING *`, values
      );
      return rows[0] || null;
    }
  };

  // -------------------------------------------------------------------------
  // Goals.
  // -------------------------------------------------------------------------
  const AutonomyGoal = {
    async create(data) {
      const id = data.id || newId("goal");
      const rows = await run(
        `INSERT INTO autonomy_goals
          (id, workspace_id, agent_id, conversation_id, project_id, title, objective,
           status, park_reason, scope, budget, spent, checkpoint, schedule,
           next_run_at_ms, started_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [id, data.workspace_id, data.agent_id || null, data.conversation_id || null,
         data.project_id || null, data.title, data.objective,
         data.status || "awaiting_authorization", data.park_reason || null,
         json(data.scope, {}), json(data.budget, {}), json(data.spent, {}),
         json(data.checkpoint, {}), json(data.schedule, {}),
         data.next_run_at_ms ?? null, data.started_ms ?? null]
      );
      return rows[0];
    },

    async get(id) {
      const rows = await run(`SELECT * FROM autonomy_goals WHERE id=$1`, [id]);
      return rows[0] || null;
    },

    async list(workspaceId, { status = null, agentId = null, limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
      const where = ["workspace_id=$1"];
      const params = [workspaceId];
      if (status) { params.push(status); where.push(`status=$${params.length}`); }
      if (agentId) { params.push(agentId); where.push(`agent_id=$${params.length}`); }
      params.push(safeLimit);
      return run(
        `SELECT * FROM autonomy_goals WHERE ${where.join(" AND ")}
         ORDER BY created_date DESC LIMIT $${params.length}`, params
      );
    },

    /**
     * THE CLAIM. A single compare-and-set UPDATE: the only way to take
     * ownership of a goal. Two workers racing produce exactly one winner, and
     * an expired lease from a crashed tick is reclaimable by the next one.
     */
    async claim({ goalId, workerId, nowMs, leaseMs }) {
      const rows = await run(
        `UPDATE autonomy_goals
            SET lease_owner = $2, lease_expires_at_ms = $3, updated_date = now()
          WHERE id = $1
            AND status = 'active'
            AND (lease_owner IS NULL OR lease_expires_at_ms < $4)
          RETURNING *`,
        [goalId, workerId, nowMs + leaseMs, nowMs]
      );
      return rows[0] || null;
    },

    async releaseLease(goalId, workerId) {
      const rows = await run(
        `UPDATE autonomy_goals
            SET lease_owner = NULL, lease_expires_at_ms = NULL, updated_date = now()
          WHERE id = $1 AND lease_owner = $2
          RETURNING *`, [goalId, workerId]
      );
      return rows[0] || null;
    },

    /**
     * startedMs is set once, on the first transition into active. The
     * wall-clock budget is measured from it, so a goal that never records when
     * it started has a wall-clock ceiling that can never fire.
     */
    async setStatus(id, { status, parkReason = null, endedMs = null, startedMs = null }) {
      const rows = await run(
        `UPDATE autonomy_goals
            SET status = $2, park_reason = $3,
                ended_ms = COALESCE($4, ended_ms),
                started_ms = COALESCE(started_ms, $5),
                updated_date = now()
          WHERE id = $1 RETURNING *`,
        [id, status, parkReason, endedMs, startedMs]
      );
      return rows[0] || null;
    },

    async nextRunAt(id, atMs) {
      const rows = await run(
        `UPDATE autonomy_goals SET next_run_at_ms = $2, updated_date = now()
         WHERE id = $1 RETURNING *`, [id, atMs]
      );
      return rows[0] || null;
    },

    async setCheckpoint(id, checkpoint) {
      const rows = await run(
        `UPDATE autonomy_goals SET checkpoint = $2, updated_date = now()
         WHERE id = $1 RETURNING *`, [id, json(checkpoint, {})]
      );
      return rows[0] || null;
    },

    /** Monotonic: spent values may only rise. Decrements are ignored. */
    async bumpSpent(id, deltas = {}) {
      const rows = await run(`SELECT spent FROM autonomy_goals WHERE id=$1`, [id]);
      const current = parse(rows[0]?.spent, {}) || {};
      const next = { ...current };
      for (const [key, value] of Object.entries(deltas)) {
        const add = num(value, 0);
        if (add === null) continue;
        next[key] = Math.max(num(current[key], 0), 0) + add;
      }
      const updated = await run(
        `UPDATE autonomy_goals SET spent = $2, updated_date = now()
         WHERE id = $1 RETURNING *`, [id, json(next, {})]
      );
      return updated[0] || null;
    }
  };

  // -------------------------------------------------------------------------
  // Append-only logs. No update, no delete — by construction.
  // -------------------------------------------------------------------------
  const GoalEvent = {
    async append(data) {
      const id = data.id || newId("gevt");
      const rows = await run(
        `INSERT INTO goal_events
          (id, goal_id, agent_id, step_id, tick_id, event_type,
           from_status, to_status, detail, ts_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [id, data.goal_id, data.agent_id || null, data.step_id || null,
         data.tick_id || null, data.event_type, data.from_status || null,
         data.to_status || null, json(data.detail, {}), data.ts_ms ?? Date.now()]
      );
      return rows[0];
    },
    async list(goalId, limit = 200) {
      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
      return run(
        `SELECT * FROM goal_events WHERE goal_id=$1 ORDER BY seq ASC LIMIT $2`,
        [goalId, safeLimit]
      );
    }
  };

  const GoalStep = {
    async create(data) {
      const id = data.id || newId("gstp");
      const rows = await run(
        `INSERT INTO goal_steps
          (id, goal_id, agent_id, tick_id, ordinal, skill_id, tier, status,
           input, idempotency_key, started_ms, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [id, data.goal_id, data.agent_id || null, data.tick_id || null,
         int(data.ordinal, 1), data.skill_id, data.tier || "T0",
         data.status || "running", json(data.input, {}), data.idempotency_key,
         data.started_ms ?? null, data.error_message ?? null]
      );
      return rows[0] || null;
    },
    /**
     * The next step ordinal for a goal — one past the highest already written.
     *
     * It deliberately does NOT come from spent.steps. A refused or failed step
     * does not count as progress, so spent.steps does not move, and an ordinal
     * derived from it would be reused by the next tick — colliding with the
     * (goal_id, ordinal) unique index and turning "this step was refused" into
     * a 500. Only one worker holds a goal's lease at a time, so the read is
     * safe; replay safety is the idempotency key's job, not the ordinal's.
     */
    async nextOrdinal(goalId) {
      const rows = await run(
        `SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM goal_steps WHERE goal_id = $1`,
        [goalId]
      );
      return Number(rows[0]?.next || 1);
    },

    /** Returns the existing row when the key was already used — replay safety. */
    async findByIdempotency(key) {
      const rows = await run(`SELECT * FROM goal_steps WHERE idempotency_key=$1`, [key]);
      return rows[0] || null;
    },
    async update(id, patch = {}) {
      const allowed = ["status", "output", "error_message", "ended_ms", "started_ms"];
      const sets = [];
      const values = [];
      for (const key of allowed) {
        if (patch[key] === undefined) continue;
        values.push(key === "output" ? json(patch[key], null) : patch[key]);
        sets.push(`${key} = $${values.length}`);
      }
      if (!sets.length) return null;
      values.push(id);
      const rows = await run(
        `UPDATE goal_steps SET ${sets.join(", ")}, updated_date = now()
         WHERE id = $${values.length} RETURNING *`, values
      );
      return rows[0] || null;
    },
    async list(goalId, limit = 200) {
      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
      return run(
        `SELECT * FROM goal_steps WHERE goal_id=$1 ORDER BY ordinal ASC LIMIT $2`,
        [goalId, safeLimit]
      );
    }
  };

  const GoalNote = {
    async append(data) {
      const rows = await run(
        `SELECT COALESCE(MAX(ordinal), 0) AS n FROM goal_notes WHERE goal_id=$1`,
        [data.goal_id]
      );
      const ordinal = int(rows[0]?.n, 0) + 1;
      const id = data.id || newId("gnote");
      const created = await run(
        `INSERT INTO goal_notes
          (id, goal_id, agent_id, tick_id, ordinal, kind, body, refs,
           confidence, supersedes_note_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [id, data.goal_id, data.agent_id || null, data.tick_id || null, ordinal,
         data.kind || "finding", String(data.body || ""), json(data.refs, []),
         data.confidence ?? null, data.supersedes_note_id || null]
      );
      return created[0];
    },
    async list(goalId, limit = 200) {
      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
      return run(
        `SELECT * FROM goal_notes WHERE goal_id=$1 ORDER BY ordinal ASC LIMIT $2`,
        [goalId, safeLimit]
      );
    },
    /** The bounded digest a tick loads into its prompt. */
    async digest(goalId, limit = 12) {
      const safeLimit = Math.max(1, Math.min(50, Number(limit) || 12));
      const rows = await run(
        `SELECT * FROM goal_notes WHERE goal_id=$1
         ORDER BY ordinal DESC LIMIT $2`, [goalId, safeLimit]
      );
      return rows.reverse();
    }
  };

  const GoalAuthorization = {
    async append(data) {
      const id = data.id || newId("gauth");
      const rows = await run(
        `INSERT INTO goal_authorizations
          (id, goal_id, scope_sha256, budget_sha256, decision, reason,
           decided_ms, expires_at_ms, decision_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [id, data.goal_id, data.scope_sha256, data.budget_sha256, data.decision,
         data.reason || null, data.decided_ms ?? Date.now(),
         data.expires_at_ms ?? null, data.decision_source || "app"]
      );
      return rows[0];
    },
    async list(goalId) {
      return run(
        `SELECT * FROM goal_authorizations WHERE goal_id=$1 ORDER BY decided_ms DESC`,
        [goalId]
      );
    },
    /** The decision currently in force, or null. Expired grants do not count. */
    async current(goalId, nowMs = Date.now()) {
      const rows = await run(
        `SELECT * FROM goal_authorizations
          WHERE goal_id=$1 AND decision='authorize'
            AND (expires_at_ms IS NULL OR expires_at_ms > $2)
          ORDER BY decided_ms DESC LIMIT 1`, [goalId, nowMs]
      );
      return rows[0] || null;
    }
  };

  // -------------------------------------------------------------------------
  // The outbox. Effects are staged here and released only by a verdict.
  // -------------------------------------------------------------------------
  const AutonomyOutbox = {
    async stage(data) {
      const id = data.id || newId("eff");
      const rows = await run(
        `INSERT INTO autonomy_outbox
          (id, workspace_id, agent_id, goal_id, tick_id, step_id, skill_id,
           effect_type, tier, payload, idempotency_key, status, mode, scope_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [id, data.workspace_id, data.agent_id || null, data.goal_id || null,
         data.tick_id || null, data.step_id || null, data.skill_id,
         data.effect_type, data.tier || "T0", json(data.payload, {}),
         data.idempotency_key, "staged", data.mode || "shadow",
         data.scope_sha256 || null]
      );
      return rows[0] || null;
    },
    async findByIdempotency(key) {
      const rows = await run(`SELECT * FROM autonomy_outbox WHERE idempotency_key=$1`, [key]);
      return rows[0] || null;
    },
    async get(id) {
      const rows = await run(`SELECT * FROM autonomy_outbox WHERE id=$1`, [id]);
      return rows[0] || null;
    },
    async setVerdict(id, { status, verdict, receipt = null, releasedMs = null, error = null }) {
      const rows = await run(
        `UPDATE autonomy_outbox
            SET status = $2, verdict = $3, receipt = $4, released_ms = $5,
                error_message = $6, updated_date = now()
          WHERE id = $1 RETURNING *`,
        [id, status, json(verdict, {}), json(receipt, null), releasedMs, error]
      );
      return rows[0] || null;
    },
    async list(workspaceId, { goalId = null, status = null, limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
      const where = ["workspace_id=$1"];
      const params = [workspaceId];
      if (goalId) { params.push(goalId); where.push(`goal_id=$${params.length}`); }
      if (status) { params.push(status); where.push(`status=$${params.length}`); }
      params.push(safeLimit);
      return run(
        `SELECT * FROM autonomy_outbox WHERE ${where.join(" AND ")}
         ORDER BY created_date DESC LIMIT $${params.length}`, params
      );
    }
  };

  const OutboxEvent = {
    async append(data) {
      const id = data.id || newId("oevt");
      const rows = await run(
        `INSERT INTO outbox_events (id, outbox_id, from_status, to_status, detail, ts_ms)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, data.outbox_id, data.from_status || null, data.to_status || null,
         json(data.detail, {}), data.ts_ms ?? Date.now()]
      );
      return rows[0];
    },
    async list(outboxId, limit = 200) {
      const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
      return run(
        `SELECT * FROM outbox_events WHERE outbox_id=$1 ORDER BY seq ASC LIMIT $2`,
        [outboxId, safeLimit]
      );
    }
  };

  // -------------------------------------------------------------------------
  // Notices. A template id plus stored fields — there is no column here that
  // could hold composed prose. That is the point (pin.notice_deterministic).
  // -------------------------------------------------------------------------
  const AutonomyNotice = {
    async create(data) {
      const id = data.id || newId("note");
      const rows = await run(
        `INSERT INTO autonomy_notices
          (id, workspace_id, agent_id, goal_id, template_id, fields, severity, created_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, data.workspace_id, data.agent_id || null, data.goal_id || null,
         data.template_id, json(data.fields, {}), data.severity || "info",
         data.created_ms ?? Date.now()]
      );
      return rows[0];
    },
    async listUnread(workspaceId, limit = 50) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      return run(
        `SELECT * FROM autonomy_notices
         WHERE workspace_id=$1 AND acked_ms IS NULL
         ORDER BY created_ms DESC LIMIT $2`, [workspaceId, safeLimit]
      );
    },
    async ack(id) {
      const rows = await run(
        `UPDATE autonomy_notices SET acked_ms = $2 WHERE id = $1 RETURNING *`,
        [id, Date.now()]
      );
      return rows[0] || null;
    }
  };

  // -------------------------------------------------------------------------
  // Ticks — one row per slice, so the loop is observable even when idle.
  // -------------------------------------------------------------------------
  const AutonomyTick = {
    async start(data) {
      const id = data.id || newId("tick");
      const rows = await run(
        `INSERT INTO autonomy_ticks (id, workspace_id, worker_id, started_ms, detail)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, data.workspace_id || null, data.worker_id, data.started_ms ?? Date.now(),
         json(data.detail, {})]
      );
      return rows[0];
    },
    async finish(id, patch = {}) {
      const rows = await run(
        `UPDATE autonomy_ticks
            SET ended_ms = $2, duration_ms = $3, goals_claimed = $4,
                steps_executed = $5, effects_staged = $6, effects_released = $7,
                effects_refused = $8, model_calls = $9, tokens_total = $10,
                cost_usd = $11, detail = $12
          WHERE id = $1 RETURNING *`,
        [id, patch.ended_ms ?? Date.now(), patch.duration_ms ?? null,
         int(patch.goals_claimed, 0), int(patch.steps_executed, 0),
         int(patch.effects_staged, 0), int(patch.effects_released, 0),
         int(patch.effects_refused, 0), int(patch.model_calls, 0),
         int(patch.tokens_total, 0), patch.cost_usd ?? null, json(patch.detail, {})]
      );
      return rows[0] || null;
    },
    async list(workspaceId, limit = 50) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      return run(
        `SELECT * FROM autonomy_ticks WHERE workspace_id=$1
         ORDER BY created_date DESC LIMIT $2`, [workspaceId, safeLimit]
      );
    }
  };

  return {
    AutonomyAgent,
    AutonomyGoal,
    GoalEvent,
    GoalStep,
    GoalNote,
    GoalAuthorization,
    AutonomyOutbox,
    OutboxEvent,
    AutonomyNotice,
    AutonomyTick
  };
}
