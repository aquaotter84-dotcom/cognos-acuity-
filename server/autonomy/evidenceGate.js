// The shadow-evidence gate — Phase 21.
//
// AUTONOMY.md §5 makes a shadow corpus the ENTRY CRITERION for Rung 4, and
// §4.7 says why: "that is the difference between 'we enabled autonomy' and 'we
// earned autonomy'." This module is the measurement.
//
// It is deliberately a leaf: it imports no autonomy module that could import it
// back, because the Action Governor consults it. A gate the judged code could
// reach around is not a gate.
//
// What "the corpus justifies the rung" means, mechanically:
//
//   * enough samples of the TIER in question — twenty-five notices say nothing
//     about whether a webhook gate is too loose;
//   * ZERO false releases, where a false release is a recorded `release` verdict
//     that fails a re-audit against the deterministic payload rules (a secret in
//     the payload, a non-https destination, a destination the goal was never
//     granted, a verdict that says release while listing failed rules, a tier
//     that is not built, or a T5 release with no human approval naming the row —
//     an irreversible act is never class-authorized);
//   * the refusal distribution recorded alongside, because "the gate refused
//     everything" is also a failure — a gate that never releases is not earning
//     a rung, it is hiding one.
//
// A count alone can be rationalised; a single false release cannot.

import { createHash } from "node:crypto";
import { SECRET_PATTERNS } from "../meta/policy.js";
import { getSkill } from "../skills/index.js";
import { canonicalize } from "./authorize.js";
import { destinationsForScope } from "./scopeUrl.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const parse = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

/**
 * The rungs that need evidence before they may act. Rungs 1–3 are gated by a
 * flag and a suite; Rung 4 and 5 are gated by a flag, a suite, AND a corpus,
 * because they are the rungs that touch the world.
 */
export const RUNGS = Object.freeze({
  external_writes: Object.freeze({
    rung: "external_writes",
    tier: "T4",
    tiers: Object.freeze(["T4"]),
    effectTypes: Object.freeze(["external_write"]),
    flag: "externalWrites",
    killSwitch: "COGNOS_AUTONOMY_EXTERNAL_WRITES",
    outboxMode: "shadow",
    note: "Rung 4 — external writes. Built in Phase 21, delivered only in live mode after this gate is satisfied."
  }),
  irreversible: Object.freeze({
    rung: "irreversible",
    tier: "T5",
    tiers: Object.freeze(["T5"]),
    effectTypes: Object.freeze(["irreversible"]),
    flag: "irreversible",
    killSwitch: "COGNOS_AUTONOMY_IRREVERSIBLE",
    outboxMode: "shadow",
    note: "Rung 6 — irreversible acts. Built in Phase 22 (autonomy row); a release is a per-effect human approval naming the exact outbox row, never class-authorized."
  })
});

export const RUNG_IDS = Object.freeze(Object.keys(RUNGS));

/** Statuses that mean "the Governor said act", performed or not. */
const RELEASE_STATUSES = Object.freeze(["released", "would_release"]);

/**
 * Re-audit one recorded release. Pure: it reads the row it is given, the goal
 * scope when the caller supplied it, and the set of outbox ids a human
 * approval names (approvals).
 *
 * @returns {string[]} every reason this release should not have happened
 */
export function auditRelease(row, { goal = null, approvals = null } = {}) {
  const reasons = [];
  const payload = parse(row.payload, {});
  const verdict = parse(row.verdict, {});
  const tier = String(row.tier || "");
  const skillId = String(row.skill_id || "");

  const skill = getSkill(skillId);
  if (!skill) reasons.push(`no skill named '${skillId}' is in the code-owned registry`);
  else if (skill.tier !== tier) reasons.push(`the row's tier ${tier} does not match the skill's ${skill.tier}`);

  if (verdict && verdict.decision && verdict.decision !== "release") {
    reasons.push(`the verdict says '${verdict.decision}' but the row is ${row.status}`);
  }
  if (Array.isArray(verdict?.failed) && verdict.failed.length) {
    reasons.push(`the verdict lists ${verdict.failed.length} failed rule(s) but the row is ${row.status}`);
  }

  if (tier === "T5") {
    const approved = approvals instanceof Set ? approvals.has(row.id) : false;
    if (!approved) {
      reasons.push("a T5 effect was released without a human approval naming this exact outbox row");
    }
  }

  const serialized = JSON.stringify(payload);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(serialized)) { reasons.push("the payload contains something that looks like a credential"); break; }
  }

  if (tier === "T4" || row.effect_type === "external_write") {
    const url = typeof payload.url === "string" ? payload.url : "";
    if (!url) reasons.push("an external write with no destination URL");
    else {
      let parsed = null;
      try { parsed = new URL(url); } catch { parsed = null; }
      if (!parsed) reasons.push("the destination URL does not parse");
      else if (parsed.protocol !== "https:") reasons.push(`the destination is ${parsed.protocol}// not https:`);
      else if (parsed.username || parsed.password) reasons.push("the destination carries credentials");
    }
    if (row.destination && url && row.destination !== url) {
      reasons.push("the recorded destination does not match the payload URL");
    }
    // Only checkable when the caller supplied the goal the row belongs to; the
    // measurement says so rather than silently passing.
    if (goal && url) {
      const granted = destinationsForScope(parse(goal.scope, {}), {
        effectType: row.effect_type, skillId
      });
      const covered = granted.some(entry => url === entry || url.startsWith(entry.replace(/\/$/, "")));
      if (!covered) reasons.push(`the destination is not in the goal's granted destinations (${granted.length} granted)`);
    }
  }
  return reasons;
}

/**
 * Measure a corpus against a rung's gate.
 *
 * @param {Array} rows outbox rows for the workspace (already fetched)
 * @param {{minShadowSamples:number, maxAcceptableFalseReleases:number}} gate
 * @param {{goalsById?: Object}} [context] goal rows, for the destination check
 */
export function auditCorpus(rows, gate = {}, { goalsById = null, tiers = null, approvals = null, nowMs = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const tierFilter = Array.isArray(tiers) && tiers.length ? new Set(tiers) : null;
  const byStatus = {};
  const byRule = {};
  const byDestination = {};
  const byTier = {};
  const falseReleases = [];
  let tierSamples = 0;

  for (const row of list) {
    const status = String(row.status || "unknown");
    const tier = String(row.tier || "?");
    byStatus[status] = (byStatus[status] || 0) + 1;
    byTier[tier] = (byTier[tier] || 0) + 1;
    if (row.destination) byDestination[row.destination] = (byDestination[row.destination] || 0) + 1;
    // Only samples OF THIS TIER count toward the floor: twenty-five notices say
    // nothing about whether a webhook gate is too loose.
    if (!tierFilter || tierFilter.has(tier)) tierSamples += 1;

    const verdict = parse(row.verdict, {});
    for (const failure of Array.isArray(verdict?.failed) ? verdict.failed : []) {
      const rule = String(failure?.rule || "unknown");
      byRule[rule] = (byRule[rule] || 0) + 1;
    }
    if (RELEASE_STATUSES.includes(status)) {
      const goal = goalsById && row.goal_id ? goalsById[row.goal_id] : null;
      const reasons = auditRelease(row, { goal, approvals });
      if (reasons.length) falseReleases.push({ id: row.id, tier, status, reasons });
    }
  }

  const minSamples = Number(gate.minShadowSamples ?? 25);
  const maxFalse = Number(gate.maxAcceptableFalseReleases ?? 0);
  const reasons = [];
  if (tierSamples < minSamples) {
    reasons.push(`${tierSamples} sample(s) of this tier is below the ${minSamples}-sample floor`);
  }
  if (falseReleases.length > maxFalse) {
    reasons.push(`${falseReleases.length} false release(s); the tolerance is ${maxFalse}`);
  }
  const wouldRelease = byStatus.would_release || 0;
  const refused = byStatus.refused || 0;
  if (tierSamples >= minSamples && wouldRelease === 0) {
    reasons.push("the corpus contains no release verdict at all — a gate that never releases has proven nothing");
  }
  if (tierSamples >= minSamples && refused === 0) {
    reasons.push("the corpus contains no refusal — a gate that never refuses has not been exercised");
  }

  return {
    samples: tierSamples,
    totalSamples: list.length,
    tiers: tierFilter ? [...tierFilter] : null,
    byStatus,
    byTier,
    byRule,
    byDestination,
    wouldRelease,
    refused,
    released: byStatus.released || 0,
    failed: byStatus.failed || 0,
    staged: byStatus.staged || 0,
    reverted: byStatus.reverted || 0,
    falseReleases,
    falseReleaseCount: falseReleases.length,
    goalScopesChecked: Boolean(goalsById),
    gate: { minSamples, maxFalseReleases: maxFalse },
    satisfied: reasons.length === 0,
    reasons,
    measuredAt: new Date(nowMs).toISOString()
  };
}

/** The stable digest of a measurement — the timestamp is excluded on purpose. */
export function metricsDigest(metrics) {
  const { measuredAt, ...stable } = metrics || {};
  return sha256(canonicalize(stable));
}

async function fetchCorpus(db, workspaceId, tiers, limit = 1000) {
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 1000));
  const rows = await db.query(
    `SELECT id, workspace_id, goal_id, skill_id, effect_type, tier, status, mode,
            payload, verdict, destination, created_date
       FROM autonomy_outbox
      WHERE workspace_id = $1 AND tier = ANY($2::text[])
      ORDER BY created_date DESC LIMIT $3`,
    [workspaceId, tiers, safeLimit]
  );
  return rows || [];
}

async function fetchGoals(db, rows) {
  const ids = [...new Set((rows || []).map(r => r.goal_id).filter(Boolean))];
  if (!ids.length) return {};
  const goals = await db.query(`SELECT id, scope FROM autonomy_goals WHERE id = ANY($1::text[])`, [ids]);
  return Object.fromEntries((goals || []).map(g => [g.id, g]));
}

/**
 * The outbox ids a human approval names, for the rows being audited. T5's
 * release authority is one approval row naming one outbox id, so the
 * re-audit needs this join — without it, every T5 release would look false.
 */
async function fetchApprovals(db, rows) {
  const ids = [...new Set((rows || []).map(r => r.id).filter(Boolean))];
  if (!ids.length) return new Set();
  const rowsOut = await db.query(
    `SELECT outbox_id FROM effect_approvals
      WHERE outbox_id = ANY($1::text[]) AND decision='approve'`, [ids]
  );
  return new Set((rowsOut || []).map(r => r.outbox_id));
}

/**
 * Measure a rung right now. Reads only; records nothing.
 */
export async function measureRung({ db, workspaceId, rung, config, nowMs = Date.now(), limit = 1000 }) {
  const spec = RUNGS[rung];
  if (!spec) return { ok: false, error: `unknown rung: ${rung}`, rungIds: RUNG_IDS };
  const gate = config?.shadow || { minShadowSamples: 25, maxAcceptableFalseReleases: 0 };
  const rows = await fetchCorpus(db, workspaceId, [...spec.tiers], limit);
  const goalsById = await fetchGoals(db, rows);
  const approvals = await fetchApprovals(db, rows);
  const metrics = auditCorpus(rows, gate, { goalsById, tiers: [...spec.tiers], approvals, nowMs });
  return {
    ok: true,
    rung: spec.rung,
    tier: spec.tier,
    tiers: [...spec.tiers],
    flag: Boolean(config?.rung?.[spec.flag]),
    killSwitch: spec.killSwitch,
    outboxMode: config?.outboxMode || "shadow",
    gate: { minShadowSamples: Number(gate.minShadowSamples ?? 25),
      maxAcceptableFalseReleases: Number(gate.maxAcceptableFalseReleases ?? 0) },
    metrics,
    metricsSha256: metricsDigest(metrics),
    satisfied: metrics.satisfied,
    reasons: metrics.reasons,
    note: spec.note
  };
}

/**
 * Record the measurement as an evidence row. Append-only: re-measuring writes a
 * new row, so the record shows what was known when the rung was considered.
 *
 * A measurement that does not satisfy the gate is recorded TOO, as
 * `insufficient` — refusing to write down a failed gate would leave the
 * operator with no history of having asked.
 */
export async function recordRungEvidence({ db, workspaceId, rung, config,
  decidedBy = "operator", reason = null, nowMs = Date.now() }) {
  const measurement = await measureRung({ db, workspaceId, rung, config, nowMs });
  if (!measurement.ok) return measurement;
  const decision = measurement.satisfied ? "justified" : "insufficient";
  const row = await db.RungEvidence.append({
    workspace_id: workspaceId,
    rung: measurement.rung,
    tier: measurement.tier,
    decision,
    gate: measurement.gate,
    metrics: measurement.metrics,
    metrics_sha256: measurement.metricsSha256,
    reason: String(reason || measurement.reasons.join("; ") || "").slice(0, 500) || null,
    decided_by: String(decidedBy || "operator").slice(0, 60),
    decided_ms: nowMs
  });
  return { ok: true, row, decision, ...measurement };
}

/**
 * Does a recorded evidence row currently justify live delivery for this rung?
 *
 * The row is necessary and not sufficient: the rung flag must also be on, and
 * the Action Governor still judges every individual effect. This answers the
 * one question the flag cannot — was the gate ever shown to work?
 */
export async function rungEvidenceStatus({ db, workspaceId, rung, config, nowMs = Date.now() }) {
  const spec = RUNGS[rung];
  if (!spec) return { ok: false, error: `unknown rung: ${rung}` };
  const [evidence, measurement, history] = await Promise.all([
    db.RungEvidence.currentJustified(workspaceId, rung),
    measureRung({ db, workspaceId, rung, config, nowMs }),
    db.RungEvidence.list(workspaceId, { rung, limit: 10 })
  ]);
  return {
    ok: true,
    rung: spec.rung,
    tier: spec.tier,
    flag: Boolean(config?.rung?.[spec.flag]),
    killSwitch: spec.killSwitch,
    outboxMode: config?.outboxMode || "shadow",
    evidence: evidence ? {
      id: evidence.id, decision: evidence.decision, decided_ms: Number(evidence.decided_ms),
      decided_by: evidence.decided_by, reason: evidence.reason,
      metrics_sha256: evidence.metrics_sha256,
      gate: parse(evidence.gate, {}), metrics: parse(evidence.metrics, {})
    } : null,
    justifiedNow: measurement.satisfied,
    measurement,
    history: (history || []).map(row => ({
      id: row.id, decision: row.decision, tier: row.tier,
      decided_ms: Number(row.decided_ms), decided_by: row.decided_by,
      reason: row.reason, metrics_sha256: row.metrics_sha256,
      samples: parse(row.metrics, {}).samples ?? null,
      falseReleases: parse(row.metrics, {}).falseReleaseCount ?? null
    })),
    note: spec.note
  };
}
