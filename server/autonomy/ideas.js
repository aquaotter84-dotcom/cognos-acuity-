// The Ideas surface (Phase 37, item #3) — OpenMuse's ideas discipline,
// reimplemented in COGNOS idioms.
//
// Ideas are rule-based, evidence-linked suggestions: the missing link between
// the heartbeat/notices and actual action. Rules are deterministic and
// testable; model-derived ideas can come later.
//
// Lifecycle (ported from OpenMuse, concept only):
//   * Content-hash IDs + insert-if-absent — the same idea can never exist twice.
//   * Auto-retire when the source is handled (goal finished, resident gone).
//   * Compare-and-swap on accept — two taps racing produce exactly one task.
//   * Plain-language reason + a ready-to-run prompt on every idea.
//
// Voice: warm and plain. Ideas are suggestions, never nagging.

import { createHash } from "node:crypto";

/** The most ideas one refresh pass will ever add. */
export const MAX_IDEAS_PER_REFRESH = 20;

/**
 * Content-hash idea ID. Hashing kind + sourceKind + sourceId + title means
 * re-running refresh produces the same ID for the same idea — duplicates are
 * impossible by construction, and the DB's primary key is the backstop.
 */
export function ideaIdFor({ kind, sourceKind = null, sourceId = null, title }) {
  return createHash("sha256")
    .update([String(kind), String(sourceKind ?? ""), String(sourceId ?? ""), String(title)].join("\0"))
    .digest("hex");
}

const json = (value, fallback = null) => JSON.stringify(value ?? fallback);
const parse = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

function rowToIdea(row) {
  if (!row) return null;
  return {
    ...row,
    evidence: parse(row.evidence, []),
    input: parse(row.input, {})
  };
}

/**
 * Create an idea (insert-if-absent). Returns the idea row — the existing one
 * when the content-hash ID already exists, so callers don't need to care.
 */
export async function createIdea(db, {
  workspaceId,
  title,
  reason,
  evidence = [],
  prompt,
  kind,
  input = {},
  sourceKind = null,
  sourceId = null
}) {
  if (!workspaceId) throw new Error("createIdea: workspaceId is required");
  if (!title) throw new Error("createIdea: title is required");
  if (!kind) throw new Error("createIdea: kind is required");
  const id = ideaIdFor({ kind, sourceKind, sourceId, title });
  const now = Date.now();
  const rows = await db.query(
    `INSERT INTO cognos_ideas
       (id, workspace_id, title, reason, evidence, prompt, kind, input,
        status, task_id, source_kind, source_id, created_ms, updated_ms)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,'new',NULL,$9,$10,$11,$12)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [id, workspaceId, String(title), String(reason || ""), json(evidence, []),
     String(prompt || ""), String(kind), json(input, {}),
     sourceKind, sourceId, now, now]
  );
  if (rows[0]) return rowToIdea(rows[0]);
  // Conflict: someone already had this idea. Hand it back.
  const existing = await db.query(`SELECT * FROM cognos_ideas WHERE id=$1`, [id]);
  return rowToIdea(existing[0]);
}

/**
 * List ideas for a workspace, newest first. Defaults to status 'new'; pass
 * status=null for every status.
 */
export async function listIdeas(db, workspaceId, { status = "new", limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  if (status) {
    const rows = await db.query(
      `SELECT * FROM cognos_ideas
        WHERE workspace_id=$1 AND status=$2
        ORDER BY created_ms DESC LIMIT $3`,
      [workspaceId, status, safeLimit]
    );
    return rows.map(rowToIdea);
  }
  const rows = await db.query(
    `SELECT * FROM cognos_ideas
      WHERE workspace_id=$1
      ORDER BY created_ms DESC LIMIT $2`,
    [workspaceId, safeLimit]
  );
  return rows.map(rowToIdea);
}

function makeTaskForIdea(idea, workspaceId, now) {
  return {
    id: `task-idea-${String(idea.id).slice(0, 16)}`,
    kind: "durable_task",
    title: idea.title,
    status: "queued",
    leaseId: null,
    leaseUntil: null,
    attempts: 0,
    input: {
      source: "idea",
      ideaId: idea.id,
      ideaKind: idea.kind,
      prompt: idea.prompt,
      ...(idea.input || {})
    },
    result: null,
    error: null,
    createdMs: now,
    updatedMs: now
  };
}

/**
 * Accept an idea — one tap turns it into durable work.
 *
 * Atomic compare-and-swap: the UPDATE only moves a 'new' idea to 'accepted'.
 * The winner writes a durable task row (kind='durable_tasks') carrying the
 * idea's prompt, stamped with the task id. Everyone else gets null — the CAS
 * was lost, someone else already took it. No double-tasks, ever.
 */
export async function acceptIdea(db, workspaceId, id) {
  const now = Date.now();
  const taskId = `task-idea-${String(id).slice(0, 16)}`;

  // The CAS UPDATE and the task INSERT belong to one transaction: a crash in
  // between must never leave an "accepted" idea with no task behind it.
  // (Falls back to sequential statements when handed a bare {query} stub.)
  const tx = typeof db.withTransaction === "function"
    ? (fn) => db.withTransaction(fn)
    : (fn) => fn(db);

  return tx(async (t) => {
    const rows = await t.query(
      `UPDATE cognos_ideas
          SET status='accepted', task_id=$3, updated_ms=$4
        WHERE workspace_id=$1 AND id=$2 AND status='new'
        RETURNING *`,
      [workspaceId, id, taskId, now]
    );
    const accepted = rowToIdea(rows[0]);
    if (!accepted) return null; // already accepted, dismissed or expired
    await t.query(
      `INSERT INTO workflow_records(owner, kind, id, data)
       VALUES ($1, 'durable_tasks', $2, $3::jsonb)
       ON CONFLICT (owner, kind, id) DO NOTHING`,
      [workspaceId, taskId, JSON.stringify(makeTaskForIdea(accepted, workspaceId, now))]
    );
    return accepted;
  });
}

/** Dismiss an idea. CAS: only a 'new' idea moves to 'dismissed'. */
export async function dismissIdea(db, workspaceId, id) {
  const now = Date.now();
  const rows = await db.query(
    `UPDATE cognos_ideas
        SET status='dismissed', updated_ms=$3
      WHERE workspace_id=$1 AND id=$2 AND status='new'
      RETURNING *`,
    [workspaceId, id, now]
  );
  return rowToIdea(rows[0]) || null;
}

// ---------------------------------------------------------------------------
// Refresh: the rule-based, deterministic idea generators.
// ---------------------------------------------------------------------------

/** Source references that already have a live (non-dismissed) idea. */
async function liveSources(db, workspaceId) {
  const rows = await db.query(
    `SELECT source_kind, source_id FROM cognos_ideas
      WHERE workspace_id=$1 AND source_kind IS NOT NULL AND status <> 'dismissed'`,
    [workspaceId]
  );
  const seen = new Set();
  for (const r of rows) seen.add(`${r.source_kind}\0${r.source_id}`);
  return seen;
}

function planIdea(goal) {
  const title = `Let's make a plan for ${goal.title}`;
  return {
    title,
    reason: `${goal.title} has a goal but no steps yet — a quick plan would give it something to work toward. No rush; just a thought.`,
    evidence: [{ kind: "goal", id: goal.id, title: goal.title }],
    prompt: `Draft a short, practical plan for the goal "${goal.title}" (${goal.objective || "no objective written yet"}). ` +
            `Break it into a few concrete steps in plain language. Keep it warm and encouraging, and keep API keys and secrets out of it.`,
    kind: "plan",
    input: { goalId: goal.id },
    sourceKind: "goal",
    sourceId: goal.id
  };
}

function residentIdea(resident) {
  const name = resident.name || resident.slug;
  const title = `Give ${name} something to do`;
  return {
    title,
    reason: `${name} is set up but doesn't have any tools or watches yet — a small first job would make them useful. Only if you'd like.`,
    evidence: [{ kind: "resident", id: resident.id, name }],
    prompt: `Suggest a small, safe first job for the resident "${name}"${resident.purpose ? ` (${resident.purpose})` : ""}. ` +
            `Describe what it would do in plain language and what the resident would need. No secrets, no API keys.`,
    kind: "resident",
    input: { residentId: resident.id, residentSlug: resident.slug },
    sourceKind: "resident",
    sourceId: resident.id
  };
}

/**
 * Run the deterministic idea rules once. Idempotent: content-hash IDs mean a
 * re-run never duplicates. Returns the ideas created this pass (max 20).
 */
export async function refreshIdeas(db, workspaceId) {
  const created = [];
  const live = await liveSources(db, workspaceId);
  const budget = () => MAX_IDEAS_PER_REFRESH - created.length;

  // Rule 1: every active goal with no steps gets a plan idea. (COGNOS's
  // goal_steps are the plan — a goal with none has no milestones to aim at.)
  if (budget() > 0) {
    const goals = await db.query(
      `SELECT id, title, objective FROM autonomy_goals
        WHERE workspace_id=$1 AND status='active'`,
      [workspaceId]
    );
    for (const goal of goals) {
      if (budget() <= 0) break;
      if (live.has(`goal\0${goal.id}`)) continue;
      const steps = await db.query(
        `SELECT 1 FROM goal_steps WHERE goal_id=$1 LIMIT 1`, [goal.id]
      );
      if (steps.length > 0) continue; // already has a plan (milestones)
      const idea = await createIdea(db, { workspaceId, ...planIdea(goal) });
      if (idea) { created.push(idea); live.add(`goal\0${goal.id}`); }
    }
  }

  // Rule 2: every resident with no tools assigned and no watches gets an idea.
  if (budget() > 0) {
    const residents = await db.query(
      `SELECT id, name, slug, purpose FROM autonomy_agents
        WHERE workspace_id=$1 AND supersedes_id IS NULL`,
      [workspaceId]
    );
    for (const resident of residents) {
      if (budget() <= 0) break;
      if (live.has(`resident\0${resident.id}`)) continue;
      const [tools, watches] = await Promise.all([
        db.query(
          `SELECT 1 FROM resident_tool_assignments
            WHERE workspace_id=$1 AND agent_slug=$2 LIMIT 1`,
          [workspaceId, resident.slug]
        ),
        db.query(
          `SELECT 1 FROM resident_watches
            WHERE workspace_id=$1 AND resident_id=$2 LIMIT 1`,
          [workspaceId, resident.id]
        )
      ]);
      if (tools.length > 0 || watches.length > 0) continue; // has something to do
      const idea = await createIdea(db, { workspaceId, ...residentIdea(resident) });
      if (idea) { created.push(idea); live.add(`resident\0${resident.id}`); }
    }
  }

  return created;
}

/**
 * Retire obsolete ideas: any 'new' idea whose source goal is completed or
 * cancelled (or gone), or whose source resident no longer exists, moves to
 * 'expired'. Returns the number retired.
 */
export async function retireObsoleteIdeas(db, workspaceId) {
  const ideas = await db.query(
    `SELECT id, source_kind, source_id FROM cognos_ideas
      WHERE workspace_id=$1 AND status='new' AND source_kind IS NOT NULL`,
    [workspaceId]
  );
  let retired = 0;
  for (const idea of ideas) {
    let dead = false;
    if (idea.source_kind === "goal") {
      const rows = await db.query(
        `SELECT status FROM autonomy_goals WHERE id=$1`, [idea.source_id]
      );
      dead = rows.length === 0 ||
        ["completed", "cancelled", "expired"].includes(rows[0].status);
    } else if (idea.source_kind === "resident") {
      const rows = await db.query(
        `SELECT 1 FROM autonomy_agents WHERE id=$1`, [idea.source_id]
      );
      dead = rows.length === 0;
    }
    if (dead) {
      const res = await db.query(
        `UPDATE cognos_ideas SET status='expired', updated_ms=$3
          WHERE workspace_id=$1 AND id=$2 AND status='new'
          RETURNING id`,
        [workspaceId, idea.id, Date.now()]
      );
      if (res.length > 0) retired++;
    }
  }
  return retired;
}
