// Promotion: the only route from a working note to durable knowledge — Phase 20.
//
// A goal's notes are scratchpad. Memory is identity. The distance between them
// is crossed in exactly two ways, both recorded on a note_promotions row:
//
//   * HUMAN-CONFIRM — the worker requests (note.promote.request), the user
//     approves in the Goal Card or the promotions queue, and the note applies.
//   * ANSWER-CARRIED — a Governor-approved chat answer cites a finding's
//     locator ([goal_<tail>:nN]) and the finding had an open request. The
//     approved answer carrying the citation IS the confirmation. Narrow on
//     purpose: findings only, cited only, requested only.
//
// And the landing is always labelled: a memory lands evidence_level
// 'inferred' (never 'direct') with origin tags naming the goal, the note, and
// the worker; a belief enters as a hypothesis at the 0.6 floor. Anything that
// writes a memory row directly would be laundering, not promotion.
//
// Rung 3: requesting, deciding, and applying all need COGNOS_AUTONOMY_RESIDENTS.

import { SECRET_PATTERNS } from "../meta/policy.js";
import { proposeHypothesis } from "../knowledge/beliefs.js";
import { parseNoteLocators } from "./goalEvidence.js";

export const PROMOTION_TARGETS = Object.freeze(["memory", "belief"]);

/** A note that carries something credential-shaped can never promote. Ever. */
export function noteHasSecret(text) {
  const body = String(text || "");
  return SECRET_PATTERNS.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(body);
  });
}

function residentsOn(config) {
  return config?.rung?.residents === true;
}

function originTags({ goalId, note }) {
  // §8 test 13 names the origin literally: `autonomy_goal:<id>`. It rides as a
  // tag alongside the granular goal:/note:/worker: tags.
  const tags = ["autonomy", "promoted", `autonomy_goal:${goalId}`, `goal:${goalId}`, `note:n${note.ordinal}`];
  const worker = Array.isArray(note.refs)
    ? note.refs.find(r => r && typeof r.sub_agent_id === "string")?.sub_agent_id
    : null;
  if (worker) tags.push(`worker:${worker}`);
  return tags;
}

/**
 * Request promotion of one note. Idempotent: a repeat request for the same
 * (note, target) resolves to the existing row instead of queueing a second
 * decision. A secret-bearing note refuses with a RECORDED row — the attempt
 * happened and was stopped, and the row carries no part of the secret.
 */
export async function requestPromotion({ db, goal, agent = null, noteId, target = "memory",
  tickId = null, stepId = null, config = null }) {
  if (!residentsOn(config)) {
    return { ok: false, error: "promotion needs Rung 3 (COGNOS_AUTONOMY_RESIDENTS)" };
  }
  if (!PROMOTION_TARGETS.includes(target)) {
    return { ok: false, error: `target must be one of: ${PROMOTION_TARGETS.join(", ")}` };
  }
  const notes = await db.GoalNote.list(goal.id, 500);
  const note = (notes || []).find(n => n.id === noteId);
  if (!note) return { ok: false, error: "note not found on this goal" };

  // Idempotent by (note, target): a repeat request resolves to the existing
  // row instead of queueing — or refusing — twice. A refused duplicate still
  // FAILS (the verdict stands), it just does not write a second row.
  const latest = await db.NotePromotion.findLatest(note.id, target);
  if (latest?.status === "applied") {
    return { ok: true, promotionId: latest.id, status: "applied", duplicate: true };
  }
  if (latest && ["requested", "approved"].includes(latest.status)) {
    return { ok: true, promotionId: latest.id, status: latest.status, duplicate: true };
  }

  if (noteHasSecret(note.body)) {
    if (latest?.status === "refused") {
      return { ok: false, error: "refused: the note carries something credential-shaped",
        promotionId: latest.id, status: "refused", duplicate: true };
    }
    const refused = await db.NotePromotion.create({
      workspace_id: goal.workspace_id, goal_id: goal.id,
      agent_id: agent?.id || null, note_id: note.id, target,
      status: "refused", reason: "secret: the note carries something credential-shaped",
      decision_source: "secret_scan"
    });
    return { ok: false, error: "refused: the note carries something credential-shaped", promotionId: refused.id, status: "refused" };
  }

  const row = await db.NotePromotion.create({
    workspace_id: goal.workspace_id, goal_id: goal.id,
    agent_id: agent?.id || null, note_id: note.id, target, status: "requested"
  });
  // The planner can see its own request on the scratchpad. The ROW is the
  // decision record; this note is just the worker's memory of asking.
  const requestNote = await db.GoalNote.append({
    goal_id: goal.id, agent_id: agent?.id || null, tick_id: tickId || null,
    kind: "decision",
    body: `Promotion requested for note n${note.ordinal} → ${target}. It awaits a human decision or a Governor-approved answer that cites it; it is not yet memory.`,
    refs: [{ note_id: note.id, promotion_id: row.id }]
  });
  return { ok: true, promotionId: row.id, status: "requested", noteOrdinal: note.ordinal, requestNoteId: requestNote?.id || null };
}

/**
 * Apply one approved promotion row. The note is re-read and re-scanned at
 * apply time: the request-time scan is the gate, this one is the seatbelt.
 */
async function applyPromotionRow(db, row) {
  const notes = await db.GoalNote.list(row.goal_id, 500);
  const note = (notes || []).find(n => n.id === row.note_id);
  if (!note) throw new Error("the promoted note is gone");
  if (noteHasSecret(note.body)) {
    await db.NotePromotion.decide(row.id, {
      status: "refused", reason: "secret: the note carries something credential-shaped",
      decisionSource: "secret_scan"
    });
    throw new Error("refused at apply time: the note carries something credential-shaped");
  }
  const body = String(note.body || "").slice(0, 2000);
  if (!body.trim()) throw new Error("the promoted note is empty");

  if (row.target === "belief") {
    // Confidence 1.0 enters at the 0.6 floor as a hypothesis — the
    // proposeHypothesis contract (confidence × 0.6, status hypothesis).
    const { belief, existing } = await proposeHypothesis(db.query, {
      claim: { claim: body, confidence: 1.0 },
      workspaceId: row.workspace_id,
      source: { kind: "promotion", runId: row.run_id || null, messageId: row.message_id || null },
      config: {}
    });
    if (!belief) throw new Error("the belief could not be proposed");
    await db.NotePromotion.markApplied(row.id, { beliefId: belief.id });
    return { memoryId: null, beliefId: belief.id, existing: existing === true };
  }

  const memory = await db.Memory.create({
    workspace_id: row.workspace_id,
    content: body,
    memory_type: "semantic",
    source: "autonomy_promotion",
    importance: 5,
    evidence_level: "inferred",   // forced: a promotion NEVER lands 'direct'
    volatility: "medium",
    tags: originTags({ goalId: row.goal_id, note })
  }, { ledger: { kind: "autonomy_promotion", runId: row.run_id || null, messageId: row.message_id || null } });
  await db.NotePromotion.markApplied(row.id, { memoryId: memory.id });
  return { memoryId: memory.id, beliefId: null };
}

/**
 * Decide one promotion. Approve applies synchronously: the human's confirm is
 * the last gate, so there is no window where an approval waits to mean
 * something. Approving an 'approved' row resumes an interrupted apply.
 */
export async function decidePromotion({ db, promotionId, decision, reason = null, actor = "user" }) {
  const row = await db.NotePromotion.get(promotionId);
  if (!row) return { ok: false, error: "promotion not found" };
  if (row.status === "applied") return { ok: false, error: "already applied", status: "applied" };

  if (decision === "refuse") {
    if (!["requested", "approved"].includes(row.status)) {
      return { ok: false, error: `cannot refuse a ${row.status} promotion`, status: row.status };
    }
    const decided = await db.NotePromotion.decide(row.id, {
      status: "refused", reason: reason || "refused by the user", decisionSource: `human:${actor}`
    });
    return { ok: true, promotionId: row.id, status: decided.status };
  }

  if (decision !== "approve") return { ok: false, error: "decision must be approve or refuse" };
  if (!["requested", "approved"].includes(row.status)) {
    return { ok: false, error: `cannot approve a ${row.status} promotion`, status: row.status };
  }
  if (row.status === "requested") {
    await db.NotePromotion.decide(row.id, {
      status: "approved", reason: reason || "approved by the user", decisionSource: `human:${actor}`
    });
  }
  try {
    const applied = await applyPromotionRow(db, { ...row, status: "approved" });
    return { ok: true, promotionId: row.id, status: "applied", ...applied };
  } catch (error) {
    // The row stays 'approved' (or flips to 'refused' on a secret): an
    // interrupted apply resumes, it never half-applies.
    return { ok: false, error: String(error?.message || error).slice(0, 300), promotionId: row.id, status: "approved" };
  }
}

/**
 * The answer-carried path. A Governor-approved answer that cites a finding's
 * locator carries that finding into memory — but ONLY when the finding
 * already had an open request. Two signals, not one: the worker asked, and
 * the governed answer agreed it was worth citing. Findings only; questions,
 * decisions, blockers and dead ends are never carried no matter how cited.
 *
 * @returns {{applied: Array<{promotionId, ordinal, target, memoryId, beliefId}>, cited: number}}
 */
export async function applyAnswerCarriedPromotions({ db, goalId, runId = null, messageId = null,
  answerText, workspaceId, config = null }) {
  const outcome = { applied: [], cited: 0 };
  if (!residentsOn(config)) return outcome;
  const goal = await db.AutonomyGoal.get(goalId);
  if (!goal || goal.workspace_id !== workspaceId) return outcome;

  const cited = parseNoteLocators(answerText, { goalId });
  outcome.cited = cited.length;
  if (!cited.length) return outcome;
  const seen = new Set();

  for (const { ordinal } of cited) {
    if (seen.has(ordinal)) continue;
    seen.add(ordinal);
    const note = await db.GoalNote.getByOrdinal(goalId, ordinal);
    // Narrow: findings only, open request only, secret-clean only. Anything
    // else is skipped silently — the answer may cite any note legitimately,
    // and citing is not asking.
    if (!note || note.kind !== "finding") continue;
    if (noteHasSecret(note.body)) continue;
    const open = await db.NotePromotion.findOpen(note.id, "memory")
      || await db.NotePromotion.findOpen(note.id, "belief");
    if (!open || open.status !== "requested") continue;
    if (await db.NotePromotion.findApplied(note.id, open.target)) continue;

    const decided = await db.NotePromotion.decide(open.id, {
      status: "approved",
      reason: "carried by a Governor-approved answer citing this finding",
      decisionSource: `answer_carried:${messageId || runId || "unknown"}`
    });
    // Stamp the carrier before applying so the ledger event points at it.
    if (runId || messageId) {
      await db.NotePromotion.stampCarrier(open.id, { runId, messageId });
    }
    try {
      const applied = await applyPromotionRow(db, { ...decided, run_id: runId, message_id: messageId });
      outcome.applied.push({ promotionId: open.id, ordinal, target: open.target, ...applied });
    } catch {
      // An interrupted carry stays 'approved' and resumes on the next citing
      // answer — or waits for the human queue. Never half-applies.
      continue;
    }
  }
  return outcome;
}
