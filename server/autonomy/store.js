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
// Phase 29 — the rung key -> column map. The store builds its one-column upsert
// from this frozen map, so the SQL has five possible shapes and no request text
// ever reaches the statement.
import { RUNG_COLUMNS } from "./settings.js";

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
    async remove(id) {
      const agent = await AutonomyAgent.get(id);
      if (!agent) return null;
      // Remove the version chain together: a resident is a user-managed agent,
      // not an append-only audit record. Goals and conversations retain their
      // own records where the database permits it.
      await run(`DELETE FROM autonomy_agents WHERE workspace_id=$1 AND slug=$2`, [agent.workspace_id, agent.slug]);
      return agent;
    },

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
    },
    // Phase 20 — resolve a goal-note LOCATOR ([goal_<id>:n<ordinal>]) to its
    // row. Ordinals are unique per goal, so a citation names exactly one note.
    async getByOrdinal(goalId, ordinal) {
      const rows = await run(
        `SELECT * FROM goal_notes WHERE goal_id=$1 AND ordinal=$2 LIMIT 1`,
        [goalId, Number(ordinal)]
      );
      return rows[0] || null;
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
           effect_type, tier, payload, idempotency_key, status, mode, scope_sha256,
           destination)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [id, data.workspace_id, data.agent_id || null, data.goal_id || null,
         data.tick_id || null, data.step_id || null, data.skill_id,
         data.effect_type, data.tier || "T0", json(data.payload, {}),
         data.idempotency_key, "staged", data.mode || "shadow",
         data.scope_sha256 || null, data.destination || null]
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
    async list(workspaceId, { goalId = null, status = null, tier = null,
      effectType = null, destination = null, limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
      const where = ["workspace_id=$1"];
      const params = [workspaceId];
      if (goalId) { params.push(goalId); where.push(`goal_id=$${params.length}`); }
      if (status) { params.push(status); where.push(`status=$${params.length}`); }
      if (tier) { params.push(tier); where.push(`tier=$${params.length}`); }
      if (effectType) { params.push(effectType); where.push(`effect_type=$${params.length}`); }
      if (destination) { params.push(destination); where.push(`destination=$${params.length}`); }
      params.push(safeLimit);
      return run(
        `SELECT * FROM autonomy_outbox WHERE ${where.join(" AND ")}
         ORDER BY created_date DESC LIMIT $${params.length}`, params
      );
    },

    /** Destination breakdown for the shadow corpus (Phase 21). */
    async countByDestination(workspaceId) {
      return run(
        `SELECT COALESCE(destination, '(internal)') AS destination, status, COUNT(*)::int AS n
           FROM autonomy_outbox WHERE workspace_id=$1
          GROUP BY destination, status ORDER BY n DESC LIMIT 100`,
        [workspaceId]
      );
    }
  };

  // -------------------------------------------------------------------------
  // Rung evidence — Phase 21. The row that earns a rung.
  //
  // APPEND ONLY: there is no update or delete accessor. Re-measuring a corpus
  // writes a new row, so the record always shows what was known at the moment
  // a rung was considered (pin.ledger_append_only, and AUTONOMY.md §5's entry
  // criterion for Rung 4).
  // -------------------------------------------------------------------------
  const RungEvidence = {
    async append(data) {
      const id = data.id || newId("rev");
      const rows = await run(
        `INSERT INTO autonomy_rung_evidence
          (id, workspace_id, rung, tier, decision, gate, metrics, metrics_sha256,
           reason, decided_by, decided_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [id, data.workspace_id, data.rung, data.tier || null, data.decision,
         json(data.gate, {}), json(data.metrics, {}), data.metrics_sha256,
         data.reason || null, data.decided_by || "operator",
         num(data.decided_ms, Date.now())]
      );
      return rows[0] || null;
    },
    /** The most recent `justified` row for a rung, or null. */
    async currentJustified(workspaceId, rung) {
      const rows = await run(
        `SELECT * FROM autonomy_rung_evidence
          WHERE workspace_id=$1 AND rung=$2 AND decision='justified'
          ORDER BY decided_ms DESC LIMIT 1`,
        [workspaceId, rung]
      );
      return rows[0] || null;
    },
    async list(workspaceId, { rung = null, limit = 50 } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      const where = ["workspace_id=$1"];
      const params = [workspaceId];
      if (rung) { params.push(rung); where.push(`rung=$${params.length}`); }
      params.push(safeLimit);
      return run(
        `SELECT * FROM autonomy_rung_evidence WHERE ${where.join(" AND ")}
         ORDER BY decided_ms DESC LIMIT $${params.length}`, params
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

  // -------------------------------------------------------------------------
  // Phase 20 — sub-agents. Narrow workers spawned by a step: a subset of the
  // goal's skills, a carved sub-budget, and output that enters as evidence
  // with provenance (pin.subagent_untrusted).
  // -------------------------------------------------------------------------
  const GoalSubagent = {
    async create(data) {
      const id = data.id || newId("sub");
      const rows = await run(
        `INSERT INTO goal_subagents
          (id, workspace_id, goal_id, agent_id, tick_id, parent_step_id,
           objective, skills, budget, spent, status, started_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [id, data.workspace_id, data.goal_id, data.agent_id || null,
         data.tick_id || null, data.parent_step_id || null,
         String(data.objective || ""), json(data.skills, []),
         json(data.budget, {}), json(data.spent, {}),
         data.status || "running", data.started_ms ?? Date.now()]
      );
      return rows[0];
    },
    async get(id) {
      const rows = await run(`SELECT * FROM goal_subagents WHERE id=$1`, [id]);
      return rows[0] || null;
    },
    async list(goalId, limit = 100) {
      const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
      return run(
        `SELECT * FROM goal_subagents WHERE goal_id=$1 ORDER BY created_date ASC LIMIT $2`,
        [goalId, safeLimit]
      );
    },
    async finish(id, { status, output = null, spent = null, error = null }) {
      const rows = await run(
        `UPDATE goal_subagents
            SET status = $2, output = COALESCE($3, output),
                spent = COALESCE($4, spent), error_message = $5,
                ended_ms = $6, updated_date = now()
          WHERE id = $1 RETURNING *`,
        [id, status, output === null ? null : json(output, null),
         spent === null ? null : json(spent, {}),
         error ? String(error).slice(0, 400) : null, Date.now()]
      );
      return rows[0] || null;
    }
  };

  // -------------------------------------------------------------------------
  // Phase 20 — promotion requests. The ONLY route from a working note to
  // durable knowledge, and it is labelled at apply time: a memory lands
  // evidence_level 'inferred' (never 'direct'), a belief enters as a
  // hypothesis. Statuses: requested -> approved|refused; approved -> applied.
  // -------------------------------------------------------------------------
  const NotePromotion = {
    async create(data) {
      const id = data.id || newId("promo");
      const rows = await run(
        `INSERT INTO note_promotions
          (id, workspace_id, goal_id, agent_id, note_id, target, status,
           reason, decision_source, run_id, message_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [id, data.workspace_id, data.goal_id, data.agent_id || null,
         data.note_id, data.target || "memory", data.status || "requested",
         data.reason || null, data.decision_source || null,
         data.run_id || null, data.message_id || null]
      );
      return rows[0];
    },
    async get(id) {
      const rows = await run(`SELECT * FROM note_promotions WHERE id=$1`, [id]);
      return rows[0] || null;
    },
    /**
     * The open request for this (note, target), if any. A repeat request
     * resolves to this row instead of queueing a second decision.
     */
    async findOpen(noteId, target = "memory") {
      const rows = await run(
        `SELECT * FROM note_promotions
          WHERE note_id=$1 AND target=$2 AND status IN ('requested','approved')
          ORDER BY created_date DESC LIMIT 1`,
        [noteId, target]
      );
      return rows[0] || null;
    },
    /** The latest row for this (note, target) in any status — requests dedupe. */
    async findLatest(noteId, target = "memory") {
      const rows = await run(
        `SELECT * FROM note_promotions
          WHERE note_id=$1 AND target=$2
          ORDER BY created_date DESC LIMIT 1`,
        [noteId, target]
      );
      return rows[0] || null;
    },
    /** Any terminal application of this (note, target) — promotion applies once. */
    async findApplied(noteId, target = "memory") {
      const rows = await run(
        `SELECT * FROM note_promotions
          WHERE note_id=$1 AND target=$2 AND status='applied'
          ORDER BY created_date DESC LIMIT 1`,
        [noteId, target]
      );
      return rows[0] || null;
    },
    async list(workspaceId, { status = null, goalId = null, limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
      const where = ["workspace_id=$1"];
      const params = [workspaceId];
      if (status) { params.push(status); where.push(`status=$${params.length}`); }
      if (goalId) { params.push(goalId); where.push(`goal_id=$${params.length}`); }
      params.push(safeLimit);
      return run(
        `SELECT * FROM note_promotions WHERE ${where.join(" AND ")}
         ORDER BY created_date DESC LIMIT $${params.length}`, params
      );
    },
    async decide(id, { status, reason = null, decisionSource = null, decidedMs = null }) {
      const rows = await run(
        `UPDATE note_promotions
            SET status = $2, reason = $3, decision_source = $4,
                decided_ms = $5, updated_date = now()
          WHERE id = $1 RETURNING *`,
        [id, status, reason, decisionSource, decidedMs ?? Date.now()]
      );
      return rows[0] || null;
    },
    /**
     * Stamp the answer that carried this promotion, so the ledger event on the
     * applied memory/belief points at the run and message that confirmed it.
     * COALESCE: a stamp never overwrites a stamp.
     */
    async stampCarrier(id, { runId = null, messageId = null }) {
      const rows = await run(
        `UPDATE note_promotions
            SET run_id = COALESCE($2, run_id), message_id = COALESCE($3, message_id),
                updated_date = now()
          WHERE id = $1 RETURNING *`,
        [id, runId, messageId]
      );
      return rows[0] || null;
    },
    async markApplied(id, { memoryId = null, beliefId = null }) {
      const rows = await run(
        `UPDATE note_promotions
            SET status = 'applied', applied_memory_id = $2, applied_belief_id = $3,
                updated_date = now()
          WHERE id = $1 RETURNING *`,
        [id, memoryId, beliefId]
      );
      return rows[0] || null;
    }
  };

  // -------------------------------------------------------------------------
  // Phase 25 — the delegated switch. One row per workspace, holding ONLY the
  // global on/off an operator handed to the UI. There is deliberately no
  // accessor here for a rung, a ceiling, a skill or a budget: this row cannot
  // widen anything, because the table has no column that could hold one.
  //
  // The row is also not authority. COGNOS_AUTONOMY_ENABLED=true in the
  // environment pins autonomy on and outranks it; server/autonomy/settings.js
  // is what applies that precedence, so the store stays a plain read/write.
  // -------------------------------------------------------------------------
  const AutonomySettings = {
    /** The stored row, or null. Null means "nobody has used the switch yet". */
    async get(workspaceId) {
      const rows = await run(
        `SELECT * FROM autonomy_settings WHERE workspace_id = $1`, [workspaceId]
      );
      return rows[0] || null;
    },

    /**
     * Upsert the delegated value. `updated_ms` comes from the caller so the row
     * lines up with the workspace_audit row written for the same flip.
     */
    /**
     * Upsert ONLY the delegated outbox mode — Phase 22 (autonomy row).
     *
     * Separate from `set` on purpose. Flipping the mode must not touch
     * `enabled`, and flipping `enabled` must not touch the mode: one row, two
     * switches, two writers, and an ON CONFLICT clause that updates exactly the
     * column each one owns. A combined upsert would make every mode flip a
     * statement about enablement too, and `source` would stop meaning anything.
     *
     * A first-ever insert lands `enabled = FALSE`, which is the resting state —
     * absence of a row is OFF, never a default-on.
     *
     * This is a plain write. Whether the mode MAY become live is decided by
     * liveOutbox.js before this is called, and re-decided per effect by the
     * Action Governor after it.
     */
    async setOutboxMode({ workspace_id, outbox_mode, updated_by = null, updated_ms = null }) {
      const atMs = Number(updated_ms) || Date.now();
      const rows = await run(
        `INSERT INTO autonomy_settings (workspace_id, enabled, outbox_mode, source, updated_by, updated_ms)
         VALUES ($1, FALSE, $2, 'ui', $3, $4)
         ON CONFLICT (workspace_id) DO UPDATE
           SET outbox_mode = EXCLUDED.outbox_mode,
               updated_by = EXCLUDED.updated_by,
               updated_ms = EXCLUDED.updated_ms,
               updated_date = now()
         RETURNING *`,
        [workspace_id, outbox_mode ? String(outbox_mode).slice(0, 20) : null,
         updated_by ? String(updated_by).slice(0, 120) : null, atMs]
      );
      return rows[0] || null;
    },

    /**
     * Upsert ONLY the auto-authorize switch — Phase 26. A third writer on the
     * same row as `set` and `setOutboxMode`, and like them it touches exactly
     * the column it owns: flipping auto-authorize must not touch `enabled` or
     * `outbox_mode`. Null is the resting state and reads as off.
     */
    async setAutoAuthorizeGoals({ workspace_id, auto_authorize, updated_by = null, updated_ms = null }) {
      const atMs = Number(updated_ms) || Date.now();
      const rows = await run(
        `INSERT INTO autonomy_settings (workspace_id, enabled, auto_authorize_goals, source, updated_by, updated_ms)
         VALUES ($1, FALSE, $2, 'ui', $3, $4)
         ON CONFLICT (workspace_id) DO UPDATE
           SET auto_authorize_goals = EXCLUDED.auto_authorize_goals,
               updated_by = EXCLUDED.updated_by,
               updated_ms = EXCLUDED.updated_ms,
               updated_date = now()
         RETURNING *`,
        [workspace_id, auto_authorize === true,
         updated_by ? String(updated_by).slice(0, 120) : null, atMs]
      );
      return rows[0] || null;
    },

    /**
     * Upsert ONLY the earned-corpus bypass — Phase 28. A fourth writer on the
     * same row as `set`, `setOutboxMode` and `setAutoAuthorizeGoals`, and like
     * them it touches exactly the column it owns: flipping the bypass must not
     * touch `enabled`, `outbox_mode` or `auto_authorize_goals`. Null is the
     * resting state and reads as off, so absence is never a permission to skip
     * the corpus.
     */
    async setBypassEarning({ workspace_id, bypass_earning, updated_by = null, updated_ms = null }) {
      const atMs = Number(updated_ms) || Date.now();
      const rows = await run(
        `INSERT INTO autonomy_settings (workspace_id, enabled, bypass_earning, source, updated_by, updated_ms)
         VALUES ($1, FALSE, $2, 'ui', $3, $4)
         ON CONFLICT (workspace_id) DO UPDATE
           SET bypass_earning = EXCLUDED.bypass_earning,
               updated_by = EXCLUDED.updated_by,
               updated_ms = EXCLUDED.updated_ms,
               updated_date = now()
         RETURNING *`,
        [workspace_id, bypass_earning === true,
         updated_by ? String(updated_by).slice(0, 120) : null, atMs]
      );
      return rows[0] || null;
    },

    /**
     * Upsert ONE rung switch — Phase 29. The fifth writer on the same row, and
     * like the four before it it updates exactly the column it owns: flipping a
     * rung must not touch `enabled`, `outbox_mode`, `auto_authorize_goals`,
     * `bypass_earning`, or any of the other four rungs.
     *
     * The column name is looked up in RUNG_COLUMNS (a frozen map of five known
     * keys) rather than interpolated from the request, so the SQL text has a
     * fixed set of possible shapes and an unknown rung cannot reach the
     * database. The route validates the key first; this is the second gate, and
     * it throws rather than silently writing nothing.
     *
     * A first-ever insert lands `enabled = FALSE` — the resting state. Absence
     * of a row is OFF, never a default-on.
     */
    async setRung({ workspace_id, rung, rung_enabled, updated_by = null, updated_ms = null }) {
      const column = RUNG_COLUMNS[String(rung)];
      if (!column) throw new Error(`setRung: unknown rung "${String(rung).slice(0, 40)}"`);
      const atMs = Number(updated_ms) || Date.now();
      const rows = await run(
        `INSERT INTO autonomy_settings (workspace_id, enabled, ${column}, source, updated_by, updated_ms)
         VALUES ($1, FALSE, $2, 'ui', $3, $4)
         ON CONFLICT (workspace_id) DO UPDATE
           SET ${column} = EXCLUDED.${column},
               updated_by = EXCLUDED.updated_by,
               updated_ms = EXCLUDED.updated_ms,
               updated_date = now()
         RETURNING *`,
        [workspace_id, rung_enabled === true,
         updated_by ? String(updated_by).slice(0, 120) : null, atMs]
      );
      return rows[0] || null;
    },

    async set({ workspace_id, enabled, source = "ui", updated_by = null, updated_ms = null }) {
      const atMs = Number(updated_ms) || Date.now();
      const rows = await run(
        `INSERT INTO autonomy_settings (workspace_id, enabled, source, updated_by, updated_ms)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (workspace_id) DO UPDATE
           SET enabled = EXCLUDED.enabled, source = EXCLUDED.source,
               updated_by = EXCLUDED.updated_by, updated_ms = EXCLUDED.updated_ms,
               updated_date = now()
         RETURNING *`,
        [workspace_id, enabled === true, String(source).slice(0, 40),
         updated_by ? String(updated_by).slice(0, 120) : null, atMs]
      );
      return rows[0] || null;
    }
  };

  // -------------------------------------------------------------------------
  // Phase 22 (autonomy row, second slice) — T5 per-effect human approval.
  //
  // APPEND ONLY: there is no update or delete accessor, and the only writer is
  // the outbox decision route — the loop never writes here, so an approval can
  // never originate from the thing being approved (pin.irreversible_human_approval).
  // -------------------------------------------------------------------------
  const EffectApproval = {
    async append(data) {
      const id = data.id || newId("eappr");
      const rows = await run(
        `INSERT INTO effect_approvals
          (id, workspace_id, outbox_id, goal_id, agent_id, decision,
           scope_sha256, reason, decided_by, decided_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, data.workspace_id, data.outbox_id, data.goal_id || null,
         data.agent_id || null, data.decision, data.scope_sha256 || null,
         data.reason || null, data.decided_by || "operator",
         num(data.decided_ms, Date.now())]
      );
      return rows[0];
    },
    /** The most recent approval naming this exact outbox id, or null. */
    async current(outboxId) {
      const rows = await run(
        `SELECT * FROM effect_approvals
          WHERE outbox_id=$1 AND decision='approve'
          ORDER BY decided_ms DESC LIMIT 1`, [outboxId]
      );
      return rows[0] || null;
    },
    /** Every decision on one effect, oldest first — the one-by-one record. */
    async list(outboxId, limit = 50) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      return run(
        `SELECT * FROM effect_approvals WHERE outbox_id=$1
         ORDER BY decided_ms ASC LIMIT $2`, [outboxId, safeLimit]
      );
    }
  };

  // -------------------------------------------------------------------------
  // Phase 26 — the delegated council switches (Critic, Governor).
  //
  // One row per workspace, same shape as AutonomySettings but with the resting
  // state INVERTED: these are safety mechanisms, so a missing row reads as ON.
  // The row is inert unless COGNOS_COUNCIL_UI_CONTROL delegates the switches,
  // and server/council/settings.js owns the precedence (env pin > stored row >
  // default-on) — this store is a plain read/write.
  // -------------------------------------------------------------------------
  const CouncilSettings = {
    /** The stored row, or null. Null means "nobody has used the switches yet". */
    async get(workspaceId) {
      const rows = await run(
        `SELECT * FROM council_settings WHERE workspace_id = $1`, [workspaceId]
      );
      return rows[0] || null;
    },

    /**
     * Upsert the two governance switches. One row, two columns, two switches —
     * the caller decides which column to touch. A first-ever insert lands both
     * at their defaults (ON), which is the resting state.
     */
    async set({ workspace_id, governorEnabled = null, criticEnabled = null,
      updated_by = null, updated_ms = null }) {
      const atMs = Number(updated_ms) || Date.now();
      const rows = await run(
        `INSERT INTO council_settings
            (workspace_id, governor_enabled, critic_enabled, source, updated_by, updated_ms)
         VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE), 'ui', $4, $5)
         ON CONFLICT (workspace_id) DO UPDATE
           SET governor_enabled = COALESCE($2, council_settings.governor_enabled),
               critic_enabled   = COALESCE($3, council_settings.critic_enabled),
               updated_by       = EXCLUDED.updated_by,
               updated_ms       = EXCLUDED.updated_ms,
               updated_date     = now()
         RETURNING *`,
        [workspace_id,
         governorEnabled === null ? null : (governorEnabled === true),
         criticEnabled === null ? null : (criticEnabled === true),
         updated_by ? String(updated_by).slice(0, 120) : null, atMs]
      );
      return rows[0] || null;
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
    AutonomyTick,
    GoalSubagent,
    NotePromotion,
    RungEvidence,
    AutonomySettings,
    EffectApproval,
    CouncilSettings
  };
}
