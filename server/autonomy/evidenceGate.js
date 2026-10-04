// Release re-audit — Phase 21, narrowed in Phase 34.
//
// Phase 34 removed the earned requirement (the shadow corpus, the rungs, the
// evidence rows): there is nothing to earn and no rung to climb. What stays is
// the honest re-audit — `auditRelease` checks a recorded release against the
// deterministic rules (a secret in the payload, a non-https destination, a
// destination the goal was never granted, a verdict that says release while
// listing failed rules, a T5 release with no human approval naming the row).
// It is audit, not a gate: it reads the ledger after the fact and names what
// should not have happened.
//
// It is deliberately a leaf: it imports no autonomy module that could import it
// back, because the Action Governor consults it. A gate the judged code could
// reach around is not a gate.

import { createHash } from "node:crypto";
import { SECRET_PATTERNS } from "../meta/policy.js";
import { getSkill } from "../skills/index.js";
import { canonicalize } from "./authorize.js";
import { destinationsForScope, urlAllowedByScope } from "./scopeUrl.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const parse = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

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
      // The audit judges with the SAME matcher the Governor judges with.
      // A naive string-prefix check here would pass destinations the live
      // matcher refuses (a /docs grant covering /docs2-evil), so the audit
      // could miss exactly the false releases it exists to catch.
      const covered = urlAllowedByScope(url, granted).allowed;
      if (!covered) reasons.push(`the destination is not in the goal's granted destinations (${granted.length} granted)`);
    }
  }
  return reasons;
}

/** The stable digest of a measurement — the timestamp is excluded on purpose. */
export function metricsDigest(metrics) {
  const { measuredAt, ...stable } = metrics || {};
  return sha256(canonicalize(stable));
}
