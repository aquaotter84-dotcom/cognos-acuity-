// Read-only surfaces plus the two decision points of Phase 19.
//
// Everything here is either a query over stored rows or an authorization
// decision. Nothing on this route can produce an answer, compose prose, or
// release an effect on its own authority — the outbox and the Action Governor
// do that, and the one send path still owns every sentence the user reads.
//
// Two barriers live here:
//   POST /api/autonomy/goals/:id/decision   — a goal does no work until this
//                                             records consent with scope hashes
//   POST /api/autonomy/outbox/:id/decision  — a staged effect is approved,
//                                             refused or reverted (T2+)

import { autonomyConfig } from "../autonomy/config.js";
import { scopeHashes, authorizationCovers, isTightening } from "../autonomy/authorize.js";
import { decideEffect, revertEffect, shadowCorpus } from "../autonomy/outbox.js";
import { describeSkills } from "../skills/index.js";
import { publicNotice, NOTICE_TEMPLATE_IDS } from "../autonomy/notice.js";
import { runTick } from "../autonomy/tick.js";

const safe = (value, max) => String(value ?? "")
  .replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const parseJson = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

export function registerAutonomyRoutes(app, { wrap, db, logger }) {
  const config = () => autonomyConfig();

  // --- Status: what is on, what is built, what is off -----------------------
  app.get("/api/autonomy/status", wrap(async (req, res) => {
    const cfg = config();
    const ws = await db.Workspace.ensureDefault();
    const [agents, active, parked, awaiting] = await Promise.all([
      db.AutonomyAgent.list(ws.id, 100),
      db.query(`SELECT COUNT(*)::int AS n FROM autonomy_goals WHERE workspace_id=$1 AND status='active'`, [ws.id]),
      db.query(`SELECT COUNT(*)::int AS n FROM autonomy_goals WHERE workspace_id=$1 AND status='parked'`, [ws.id]),
      db.query(`SELECT COUNT(*)::int AS n FROM autonomy_outbox WHERE workspace_id=$1 AND status='staged'`, [ws.id])
    ]);
    res.json({
      enabled: cfg.enabled,
      requestedEnabled: cfg.requestedEnabled,
      defaultOff: true,
      rung: cfg.rung,
      outboxMode: cfg.outboxMode,
      notices: cfg.notices,
      builtTiers: cfg.builtTiers,
      counts: {
        residents: (agents || []).length,
        activeGoals: Number(active[0]?.n || 0),
        parkedGoals: Number(parked[0]?.n || 0),
        stagedEffects: Number(awaiting[0]?.n || 0)
      },
      ceilings: cfg.ceiling,
      shadowGate: cfg.shadow,
      tick: cfg.tick,
      skills: describeSkills(cfg),
      noticeTemplates: NOTICE_TEMPLATE_IDS,
      law: "phase19.autonomy_default_off",
      note: "Durable autonomy is disabled by default. Enabling it is an operator decision per rung."
    });
  }));

  // --- Residents ------------------------------------------------------------
  /** One row per resident: the CURRENT version of each brief. */
  app.get("/api/autonomy/agents", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.AutonomyAgent.listCurrent(ws.id, 100);
    res.json(rows.map(a => ({
      id: a.id, name: a.name, slug: a.slug, purpose: a.purpose,
      brief: a.brief, brief_version: a.brief_version, supersedes_id: a.supersedes_id,
      skill_allowlist: parseJson(a.skill_allowlist, []),
      conversation_id: a.conversation_id,
      heartbeat_interval_ms: Number(a.heartbeat_interval_ms),
      enabled: a.enabled === true, created_date: a.created_date
    })));
  }));

  app.get("/api/autonomy/agents/:id", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const agent = await db.AutonomyAgent.get(req.params.id);
    if (!agent || agent.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Resident not found in this workspace" });
    }
    res.json({ agent, history: await db.AutonomyAgent.history(agent.id) });
  }));

  app.post("/api/autonomy/agents", wrap(async (req, res) => {
    if (config().enabled !== true) {
      return res.status(409).json({ error: "Autonomy is disabled (COGNOS_AUTONOMY_ENABLED)." });
    }
    const ws = await db.Workspace.ensureDefault();
    const name = safe(req.body?.name, 80);
    const slug = safe(req.body?.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), 60);
    if (!name || !slug) return res.status(400).json({ error: "name and slug are required" });

    // A brief is operating text, never identity, and it cannot grant a skill:
    // the allowlist below is the ceiling regardless of what the brief says.
    const allowlist = Array.isArray(req.body?.skill_allowlist) ? req.body.skill_allowlist : [];
    const version = (await db.AutonomyAgent.latestVersion(ws.id, slug)) + 1;

    let conversationId = req.body?.conversation_id || null;
    if (!conversationId) {
      const conversation = await db.Conversation.create({
        workspace_id: ws.id,
        title: name.slice(0, 50),
        last_message_preview: ""
      });
      conversationId = conversation.id;
    }

    const agent = await db.AutonomyAgent.create({
      workspace_id: ws.id,
      name, slug,
      purpose: safe(req.body?.purpose, 240) || null,
      brief: String(req.body?.brief || "").slice(0, 8000),
      brief_version: version,
      skill_allowlist: allowlist,
      conversation_id: conversationId,
      default_scope: req.body?.default_scope || {},
      default_budgets: req.body?.default_budgets || {},
      heartbeat_interval_ms: Number(req.body?.heartbeat_interval_ms) || 900_000,
      enabled: req.body?.enabled === true
    });
    res.status(201).json(agent);
  }));

  /**
   * A brief change is a NEW VERSION, never an edit. The previous row stays, so
   * the record always shows what the resident was actually told when it did
   * the thing you are looking at (pin.resident_brief_subordinate).
   */
  app.patch("/api/autonomy/agents/:id", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const agent = await db.AutonomyAgent.get(req.params.id);
    if (!agent || agent.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Resident not found in this workspace" });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "brief")) {
      const updated = await db.AutonomyAgent.createVersion({
        agent,
        brief: String(req.body.brief || "").slice(0, 8000),
        patch: req.body.patch || {}
      });
      return res.json({ versioned: true, agent: updated, supersedes: agent.id });
    }
    const updated = await db.AutonomyAgent.update(agent.id, req.body || {});
    res.json({ versioned: false, agent: updated });
  }));

  // --- Goals ----------------------------------------------------------------
  app.get("/api/autonomy/goals", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.AutonomyGoal.list(ws.id, {
      status: req.query.status || null,
      agentId: req.query.agentId || null,
      limit: req.query.limit
    });
    res.json(rows.map(g => ({
      id: g.id, agent_id: g.agent_id, conversation_id: g.conversation_id,
      project_id: g.project_id, title: g.title, objective: g.objective,
      status: g.status, park_reason: g.park_reason,
      scope: parseJson(g.scope, {}), budget: parseJson(g.budget, {}),
      spent: parseJson(g.spent, {}),
      next_run_at_ms: g.next_run_at_ms === null ? null : Number(g.next_run_at_ms),
      created_date: g.created_date, updated_date: g.updated_date
    })));
  }));

  app.get("/api/autonomy/goals/:id", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const goal = await db.AutonomyGoal.get(req.params.id);
    if (!goal || goal.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Goal not found in this workspace" });
    }
    const [events, steps, notes, approvals, outbox] = await Promise.all([
      db.GoalEvent.list(goal.id, 300),
      db.GoalStep.list(goal.id, 300),
      db.GoalNote.list(goal.id, 300),
      db.GoalAuthorization.list(goal.id),
      db.AutonomyOutbox.list(ws.id, { goalId: goal.id, limit: 100 })
    ]);
    res.json({ goal, events, steps, notes, approvals, outbox });
  }));

  app.post("/api/autonomy/goals", wrap(async (req, res) => {
    if (config().enabled !== true) {
      return res.status(409).json({ error: "Autonomy is disabled (COGNOS_AUTONOMY_ENABLED)." });
    }
    const ws = await db.Workspace.ensureDefault();
    const title = safe(req.body?.title, 120);
    const objective = String(req.body?.objective || "").slice(0, 10_000);
    if (!title || !objective) return res.status(400).json({ error: "title and objective are required" });

    let agent = null;
    if (req.body?.agent_id) {
      agent = await db.AutonomyAgent.get(req.body.agent_id);
      if (!agent || agent.workspace_id !== ws.id) {
        return res.status(404).json({ error: "Resident not found in this workspace" });
      }
    }

    const cfg = config();
    const budget = { ...cfg.goalBudget, ...parseJson(agent?.default_budgets, {}), ...(req.body?.budget || {}) };
    // A goal that cannot report is a goal that fails silently — you authorize
    // it and then hear nothing when it parks or finishes. Notices are templated
    // and carry no model prose, so the low-risk reporting channel is on by
    // default. It sits inside the scope the operator authorizes, so it is
    // VISIBLE in the authorization and can be removed before consent.
    const scope = {
      effectsAllowed: ["notify"],
      ...parseJson(agent?.default_scope, {}),
      ...(req.body?.scope || {})
    };

    const goal = await db.AutonomyGoal.create({
      workspace_id: ws.id,
      agent_id: agent?.id || null,
      conversation_id: req.body?.conversation_id || agent?.conversation_id || null,
      project_id: req.body?.project_id || null,
      title, objective,
      status: "awaiting_authorization",
      scope, budget,
      schedule: { kind: "heartbeat", intervalMs: Number(agent?.heartbeat_interval_ms || cfg.tick.intervalMs) }
    });

    const hashes = scopeHashes({ goalId: goal.id, scope, budget });
    await db.GoalEvent.append({
      goal_id: goal.id, agent_id: agent?.id || null,
      event_type: "goal_created", to_status: "awaiting_authorization",
      detail: { title, ...hashes }
    });
    res.status(201).json({ goal, hashes, status: "awaiting_authorization" });
  }));

  /**
   * THE BARRIER. A goal does no work until this records consent with the
   * hashes of the exact scope and budget it was authorized under. Widening
   * either is a new decision — never an edit (pin.goal_scope_immutable).
   */
  app.post("/api/autonomy/goals/:id/decision", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const goal = await db.AutonomyGoal.get(req.params.id);
    if (!goal || goal.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Goal not found in this workspace" });
    }
    const decision = String(req.body?.decision || "").trim().toLowerCase();
    const reason = safe(req.body?.reason, 300) || null;

    if (["pause", "resume", "cancel"].includes(decision)) {
      const next = decision === "pause" ? "parked"
        : decision === "resume" ? "active" : "cancelled";
      if (next === "active" && !(await db.GoalAuthorization.current(goal.id, Date.now()))) {
        return res.status(409).json({ error: "A cancelled or unauthorized goal cannot be resumed; authorize it again" });
      }
      const row = await db.AutonomyGoal.setStatus(goal.id, {
        status: next,
        parkReason: decision === "pause" ? "paused_by_user" : null,
        endedMs: decision === "cancel" ? Date.now() : null
      });
      await db.GoalEvent.append({
        goal_id: goal.id, event_type: `goal_${decision}d`,
        from_status: goal.status, to_status: next, detail: { reason }
      });
      return res.json({ goal: row, decision });
    }

    if (!["authorize", "decline"].includes(decision)) {
      return res.status(400).json({ error: "decision must be authorize, decline, pause, resume or cancel" });
    }
    if (goal.status !== "awaiting_authorization" && decision === "authorize") {
      return res.status(409).json({ error: `This goal is ${goal.status}; only an awaiting_authorization goal can be authorized` });
    }

    const scope = parseJson(goal.scope, {});
    const budget = parseJson(goal.budget, {});
    const hashes = scopeHashes({ goalId: goal.id, scope, budget });

    const row = await db.GoalAuthorization.append({
      goal_id: goal.id,
      scope_sha256: hashes.scopeSha256,
      budget_sha256: hashes.budgetSha256,
      decision,
      reason,
      decided_ms: Date.now(),
      expires_at_ms: req.body?.expires_at_ms ? Number(req.body.expires_at_ms) : null,
      decision_source: req.body?.decision_source === "pairing_token" ? "pairing_token" : "app"
    });

    if (decision === "decline") {
      const updated = await db.AutonomyGoal.setStatus(goal.id, {
        status: "cancelled", parkReason: "awaiting_approval", endedMs: Date.now()
      });
      await db.GoalEvent.append({
        goal_id: goal.id, event_type: "goal_declined",
        from_status: goal.status, to_status: "cancelled", detail: { reason }
      });
      return res.json({ goal: updated, authorization: row, executed: false });
    }

    // started_ms is stamped on the first activation and never moved, so the
    // wall-clock budget has something to measure.
    const updated = await db.AutonomyGoal.setStatus(goal.id, {
      status: "active", parkReason: null, startedMs: Date.now()
    });
    await db.AutonomyGoal.nextRunAt(goal.id, Date.now());
    await db.GoalEvent.append({
      goal_id: goal.id, event_type: "goal_authorized",
      from_status: goal.status, to_status: "active",
      detail: { reason, ...hashes }
    });
    res.json({ goal: updated, authorization: row });
  }));

  // --- Notices --------------------------------------------------------------
  app.get("/api/autonomy/notices", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.AutonomyNotice.listUnread(ws.id, req.query.limit);
    res.json(rows.map(publicNotice));
  }));

  app.post("/api/autonomy/notices/:id/ack", wrap(async (req, res) => {
    const row = await db.AutonomyNotice.ack(req.params.id);
    if (!row) return res.status(404).json({ error: "Notice not found" });
    res.json(publicNotice(row));
  }));

  // --- Outbox ---------------------------------------------------------------
  app.get("/api/autonomy/outbox", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const [rows, corpus] = await Promise.all([
      db.AutonomyOutbox.list(ws.id, {
        goalId: req.query.goalId || null,
        status: req.query.status || null,
        limit: req.query.limit
      }),
      shadowCorpus(db, ws.id)
    ]);
    res.json({ effects: rows, corpus });
  }));

  app.post("/api/autonomy/outbox/:id/decision", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const effect = await db.AutonomyOutbox.get(req.params.id);
    if (!effect || effect.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Effect not found in this workspace" });
    }
    const decision = String(req.body?.decision || "").trim().toLowerCase();

    if (decision === "revert") {
      const out = await revertEffect({ db, effectId: effect.id, reason: req.body?.reason });
      return res.json(out);
    }
    if (decision === "refuse") {
      const goal = effect.goal_id ? await db.AutonomyGoal.get(effect.goal_id) : null;
      const out = await decideEffect({
        db, effectId: effect.id, goal,
        authorization: null,              // no authorization → the Governor refuses
        config: config(), mode: "shadow"
      });
      return res.json(out);
    }
    if (decision !== "approve") {
      return res.status(400).json({ error: "decision must be approve, refuse or revert" });
    }

    const goal = effect.goal_id ? await db.AutonomyGoal.get(effect.goal_id) : null;
    if (!goal) return res.status(409).json({ error: "This effect has no goal" });

    const authorization = await db.GoalAuthorization.current(goal.id, Date.now());
    if (!authorization) return res.status(409).json({ error: "The goal has no unexpired authorization" });

    const scope = parseJson(goal.scope, {});
    const budget = parseJson(goal.budget, {});
    if (!authorizationCovers(authorization, { goalId: goal.id, scope, budget })) {
      return res.status(409).json({
        error: "The goal's scope or budget changed since authorization; re-authorize it"
      });
    }
    const out = await decideEffect({
      db, effectId: effect.id, goal, authorization, config: config(), mode: "live"
    });
    res.json(out);
  }));

  // --- Ticks ----------------------------------------------------------------
  app.get("/api/autonomy/ticks", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await db.AutonomyTick.list(ws.id, req.query.limit));
  }));

  /** Run one slice now. Operator surface and the cron fallback. */
  app.post("/api/autonomy/tick", wrap(async (req, res) => {
    const cfg = config();
    if (cfg.enabled !== true) {
      return res.json({
        frozen: true, goalsClaimed: 0, stepsExecuted: 0,
        note: "Autonomy is disabled (COGNOS_AUTONOMY_ENABLED). Nothing ran."
      });
    }
    const result = await runTick({
      db, config: cfg,
      workerId: req.body?.workerId || "http",
      sliceMs: req.body?.sliceMs ? Number(req.body.sliceMs) : null,
      maxGoals: req.body?.maxGoals ? Number(req.body.maxGoals) : null
    });
    res.json(result);
  }));
}
