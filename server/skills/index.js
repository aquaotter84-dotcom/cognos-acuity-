// The skill registry — Phase 19.
//
// SKILLS ARE CODE, NOT DATA. This is deliberate and it is the most important
// decision in this module.
//
// COGNOS already owns its laws in code (server/council/laws.js), its identity in
// code (server/identity.js), and its bounded tools in code (TOOL_REGISTRY in
// server/agent/runner.js). A database table of skills that anything could insert
// into would be a capability write — a law change wearing a different hat. So
// the registry is a frozen object compiled from modules in this directory, and
// only the PER-RESIDENT ALLOWLIST is data (autonomy_agents.skill_allowlist).
//
// A skill cannot be added at runtime. Adding one is a reviewed code change that
// names its tier, its argument schema, its idempotency rule and its kill switch
// — the last of which phase15.complexity_justification requires of every
// subsystem.
//
// Phase 19 ships T0–T2 only. Nothing here can reach the network or the outside
// world; T3 (external read) and T4 (external write) arrive with Phases 20–21.

import { appendNote } from "./noteAppend.js";
import { readEvidence } from "./evidenceRead.js";
import { searchMemory } from "./memorySearch.js";
import { searchBeliefs } from "./beliefSearch.js";
import { snapshotSource } from "./sourceSnapshot.js";
import { requestPromotion } from "./notePromote.js";
import { emitNotice } from "./noticeEmit.js";

/** Effect tiers. The Action Governor speaks this vocabulary. */
export const TIERS = Object.freeze({
  T0: "observe",          // nothing leaves the system
  T1: "internal_write",   // writes to COGNOS's own stores; reversible as a transition
  T2: "notify",           // templated notice to the user; deterministic content only
  T3: "external_read",    // safeFetch network read (Phase 20)
  T4: "external_write",   // email / webhook / calendar / file (Phase 21)
  T5: "irreversible"      // payment / publish / delete (Phase 22)
});

const def = (skill) => Object.freeze({
  version: 1,
  idempotent: true,
  maxPayloadBytes: 32_768,
  timeoutMs: 15_000,
  dryRun: false,
  ...skill
});

export const SKILL_REGISTRY = Object.freeze({
  // --- T0: observe ---------------------------------------------------------
  "note.append": def({
    tier: "T0",
    effectType: "none",
    killSwitch: "COGNOS_SKILL_NOTE_APPEND",
    summary: "Append a typed working note to the goal's scratchpad.",
    idempotencyRule: "content-addressed: sha256(goal_id, kind, body) deduplicates a redelivered step",
    args: {
      kind: { type: "enum", values: ["finding", "question", "dead_end", "decision", "plan_change", "evidence_ref", "blocker"], required: true },
      body: { type: "string", max: 2000, required: true },
      refs: { type: "array", required: false }
    },
    execute: appendNote
  }),

  "evidence.read": def({
    tier: "T0",
    effectType: "none",
    killSwitch: "COGNOS_SKILL_EVIDENCE_READ",
    summary: "Read the conversation's/project's immutable evidence manifest.",
    idempotencyRule: "naturally idempotent: a read has no effect to repeat",
    args: { limit: { type: "number", min: 1, max: 24, required: false } },
    execute: readEvidence
  }),

  "memory.search": def({
    tier: "T0",
    effectType: "none",
    killSwitch: "COGNOS_SKILL_MEMORY_SEARCH",
    summary: "Search enabled workspace memories.",
    idempotencyRule: "naturally idempotent: a read has no effect to repeat",
    args: { query: { type: "string", max: 200, required: true }, limit: { type: "number", min: 1, max: 20, required: false } },
    execute: searchMemory
  }),

  "belief.search": def({
    tier: "T0",
    effectType: "none",
    killSwitch: "COGNOS_SKILL_BELIEF_SEARCH",
    summary: "Search active beliefs and their confidence.",
    idempotencyRule: "naturally idempotent: a read has no effect to repeat",
    args: { query: { type: "string", max: 200, required: true }, limit: { type: "number", min: 1, max: 20, required: false } },
    execute: searchBeliefs
  }),

  // --- T1: internal write --------------------------------------------------
  "source.snapshot": def({
    tier: "T1",
    effectType: "internal_write",
    killSwitch: "COGNOS_SKILL_SOURCE_SNAPSHOT",
    summary: "Store agent-produced text as an immutable, citable source snapshot.",
    idempotencyRule: "content-addressed: sha256(text) — an identical snapshot resolves to the existing source",
    args: {
      name: { type: "string", max: 200, required: true },
      text: { type: "string", max: 60_000, required: true }
    },
    execute: snapshotSource
  }),

  "note.promote.request": def({
    tier: "T1",
    effectType: "internal_write",
    killSwitch: "COGNOS_SKILL_NOTE_PROMOTE",
    summary: "Request promotion of a note into memory. Lands as 'inferred', never 'direct'.",
    idempotencyRule: "keyed by note_id: a repeat request for the same note is a no-op, not a second request",
    args: { noteId: { type: "string", max: 64, required: true } },
    execute: requestPromotion
  }),

  // --- T2: notify ----------------------------------------------------------
  "notice.emit": def({
    tier: "T2",
    effectType: "notify",
    killSwitch: "COGNOS_SKILL_NOTICE_EMIT",
    summary: "Emit a templated notice. Fields are stored records only; no prose.",
    idempotencyRule: "content-addressed: sha256(goal_id, effect_type, canonical(payload)) in autonomy_outbox",
    args: {
      templateId: { type: "enum", values: ["goal_parked", "goal_completed", "finding_ready", "budget_warning"], required: true },
      fields: { type: "object", required: true },
      severity: { type: "enum", values: ["info", "warning", "error"], required: false }
    },
    execute: emitNotice
  })
});

export const SKILL_IDS = Object.freeze(Object.keys(SKILL_REGISTRY));

export function getSkill(id) {
  return Object.prototype.hasOwnProperty.call(SKILL_REGISTRY, id) ? SKILL_REGISTRY[id] : null;
}

/**
 * A skill is enabled when its own kill switch is unset-or-true AND its tier is
 * within the rung the deployment has turned on. Phase 19: T0–T1 always gated
 * only by the global switch and the per-skill switch; T2 additionally needs the
 * notice path allowed.
 */
/**
 * Resolve the autonomy switch out of whichever config shape the caller holds.
 *
 * autonomyConfig() returns a FLAT object ({ enabled, notices, ... }), but a
 * caller that captured a whole system config may hand us { autonomy: {...} } —
 * possibly more than one level deep. Unwrapping only one level is how a kill
 * switch becomes decorative: the wrapper hides the flag, nothing matches, and
 * the skill stays enabled. So walk the wrappers (bounded, so a cyclic object
 * cannot hang the tick) and fail closed on an explicit false at any level.
 */
function resolveAutonomy(config) {
  let node = config && typeof config === "object" ? config : {};
  let enabled;
  let notices;
  for (let depth = 0; depth < 4; depth++) {
    if (node && typeof node === "object") {
      if (enabled === undefined && typeof node.enabled === "boolean") enabled = node.enabled;
      if (!notices && node.notices && typeof node.notices === "object") notices = node.notices;
      if (Object.prototype.hasOwnProperty.call(node, "autonomy")) node = node.autonomy;
      else break;
    } else break;
  }
  return { enabled, notices: notices || {} };
}

export function isSkillEnabled(id, config = null) {
  const skill = getSkill(id);
  if (!skill) return false;
  if (process.env[skill.killSwitch] === "false") return false;
  const { enabled, notices } = resolveAutonomy(config);
  if (enabled === false) return false;
  if (skill.tier === "T2" && (notices.mode === "none" || notices.enabled === false)) return false;
  if (["T3", "T4", "T5"].includes(skill.tier)) return false;   // not built yet
  return true;
}

/**
 * Validate arguments against a skill's declared schema. Deterministic and
 * dependency-free on purpose: this runs before any execution, and a malformed
 * argument must be a recorded refusal, never a thrown surprise.
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateArgs(skillId, args = {}) {
  const skill = getSkill(skillId);
  if (!skill) return { ok: false, errors: [`unknown skill: ${skillId}`] };
  const errors = [];
  const source = args && typeof args === "object" ? args : {};

  for (const [name, rule] of Object.entries(skill.args || {})) {
    const value = source[name];

    if (value === undefined || value === null) {
      if (rule.required) errors.push(`${name} is required`);
      continue;
    }
    if (rule.type === "string") {
      if (typeof value !== "string") errors.push(`${name} must be a string`);
      else if (value.length > (rule.max || 2000)) errors.push(`${name} exceeds ${rule.max} characters`);
    } else if (rule.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) errors.push(`${name} must be a number`);
      else if (n < (rule.min ?? -Infinity) || n > (rule.max ?? Infinity)) errors.push(`${name} out of range`);
    } else if (rule.type === "enum") {
      if (!rule.values.includes(value)) errors.push(`${name} must be one of: ${rule.values.join(", ")}`);
    } else if (rule.type === "array") {
      if (!Array.isArray(value)) errors.push(`${name} must be an array`);
    } else if (rule.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) errors.push(`${name} must be an object`);
    }
  }

  for (const name of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(skill.args || {}, name)) {
      errors.push(`${name} is not an argument of ${skillId}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The capability declaration the /api/agent/tools surface reports. */
export function describeSkills(config = null) {
  return SKILL_IDS.map(id => {
    const skill = SKILL_REGISTRY[id];
    return {
      id,
      version: skill.version,
      tier: skill.tier,
      tierName: TIERS[skill.tier] || skill.tier,
      effectType: skill.effectType,
      summary: skill.summary,
      args: Object.keys(skill.args || {}),
      idempotent: skill.idempotent,
      idempotencyRule: skill.idempotencyRule || null,
      killSwitch: skill.killSwitch,
      enabled: isSkillEnabled(id, config)
    };
  });
}
