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
// Phase 19 shipped T0–T2 only. Phase 20 added T3 (external READ): web.fetch and
// web.search stage an `external_read` effect the Action Governor judges, and
// subagent.spawn runs a narrow T0/T1-only worker.
//
// Phase 21 adds T4 (external WRITE) — one adapter, `webhook.post`. It is the
// only externally-writing skill in the registry, it is off unless the rung flag
// is set, and even then the Action Governor refuses a LIVE release until a
// recorded shadow corpus justifies it.
//
// Phase 22 (autonomy row, second slice) adds T5 (IRREVERSIBLE) — one adapter,
// `post.publish`. It is off unless the `irreversible` rung is switched on, and
// even then the Action Governor refuses every release until a human approval
// row names that exact outbox id (pin.irreversible_human_approval). A rung
// flag, a scope entry and a shadow corpus are all necessary and none of them
// is ever sufficient.

import { appendNote } from "./noteAppend.js";
import { readEvidence } from "./evidenceRead.js";
import { searchMemory } from "./memorySearch.js";
import { searchBeliefs } from "./beliefSearch.js";
import { snapshotSource } from "./sourceSnapshot.js";
import { requestPromotion } from "./notePromote.js";
import { emitNotice } from "./noticeEmit.js";
import { spawnSubagent } from "./subagentSpawn.js";
import { fetchUrl } from "./webFetch.js";
import { searchWebSkill } from "./webSearch.js";
import { postWebhook } from "./webhookPost.js";
import { publishPost } from "./postPublish.js";

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
    requiresRung: "residents",
    summary: "Request promotion of a note into memory or belief. Lands as 'inferred', never 'direct'; applies only via human confirm or a Governor-approved citing answer.",
    idempotencyRule: "keyed by (note, target): a repeat request resolves to the existing row, not a second decision",
    args: {
      noteId: { type: "string", max: 64, required: true },
      target: { type: "enum", values: ["memory", "belief"], required: false }
    },
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
  }),

  // --- T1: narrow workers (Phase 20, Rung 3) --------------------------------
  "subagent.spawn": def({
    tier: "T1",
    effectType: "internal_write",
    killSwitch: "COGNOS_SKILL_SUBAGENT_SPAWN",
    requiresRung: "residents",
    summary: "Spawn one narrow sub-agent: a declared T0/T1-only subset, a bounded objective, a carved sub-budget.",
    idempotencyRule: "keyed by parent step: the same step's spawn resolves to the existing worker; each spawn is one row",
    args: {
      objective: { type: "string", max: 1000, required: true },
      skills: { type: "array", required: true },
      maxSteps: { type: "number", min: 1, max: 10, required: false },
      maxModelCalls: { type: "number", min: 1, max: 12, required: false },
      maxCostUsd: { type: "number", min: 0.01, max: 0.25, required: false }
    },
    execute: spawnSubagent
  }),

  // --- T3: external read (Phase 20) ------------------------------------------
  // web.fetch is gated by the per-goal URL allowlist, not by a rung: with an
  // empty allowlist it can reach nothing, so the default posture is closed.
  // web.search needs Rung 3's search flag, because a query is a data flow to
  // a third-party provider rather than a read of an allowlisted page.
  "web.fetch": def({
    tier: "T3",
    effectType: "external_read",
    killSwitch: "COGNOS_SKILL_WEB_FETCH",
    summary: "Fetch one allowlisted URL as an immutable, citable snapshot. Judged per read; shadow mode fetches nothing.",
    idempotencyRule: "keyed by (goal, url, scope hash): a re-asked URL replays the verdict and re-reads the immutable snapshot",
    args: {
      url: { type: "string", max: 2000, required: true },
      reason: { type: "string", max: 300, required: false }
    },
    execute: fetchUrl
  }),

  "web.search": def({
    tier: "T3",
    effectType: "external_read",
    killSwitch: "COGNOS_SKILL_WEB_SEARCH",
    requiresRung: "search",
    summary: "Search the web via the configured provider. Results are bounded and transient; nothing is stored.",
    idempotencyRule: "keyed per step: results are transient and never stored, so each step's search is judged fresh",
    args: {
      query: { type: "string", max: 500, required: true }
    },
    execute: searchWebSkill
  }),

  // --- T4: external write (Phase 21, Rung 4) ---------------------------------
  // A webhook is a trigger, not a message: it can deploy, trade, unlock a door
  // or post publicly. So it is judged harder than a read of the same URL —
  // https only, destinations granted in scope rows only, an argument-header
  // allowlist that refuses Authorization, a byte-capped body, signing by
  // secret REFERENCE, and a shadow corpus before any live delivery.
  //
  // maxPayloadBytes is the envelope (body + headers + provenance). The body's
  // own cap is config.webhook.maxBodyBytes, checked separately in bytes, so a
  // multi-byte body that fits the character schema but not the byte cap is
  // refused rather than truncated.
  "webhook.post": def({
    tier: "T4",
    effectType: "external_write",
    killSwitch: "COGNOS_SKILL_WEBHOOK_POST",
    requiresRung: "externalWrites",
    maxPayloadBytes: 40_960,
    timeoutMs: 12_000,
    summary: "POST one body to one destination granted in the goal's scope. https only, judged per delivery, shadow until a corpus earns live.",
    idempotencyRule: "keyed by (goal, url, body): the same trigger stages once however many steps ask for it, and a released key returns its receipt instead of sending again",
    args: {
      url: { type: "string", max: 2000, required: true },
      method: { type: "enum", values: ["POST"], required: false },
      headers: { type: "object", required: false },
      body: { type: "string", max: 32_768, required: true },
      secret_ref: { type: "string", max: 64, required: false },
      reason: { type: "string", max: 300, required: false }
    },
    execute: postWebhook
  }),

  // --- T5: irreversible (Phase 22, autonomy row — second slice) -------------
  // The first act this loop may take that cannot be taken back: publishing
  // content to a granted destination. It is delivered with the same bounded
  // https machinery as a T4 webhook, and it is governed strictly harder: the
  // `irreversible` rung must be on AND a human approval row must name this
  // exact outbox id, one at a time, never by class (pin.irreversible_human_approval).
  "post.publish": def({
    tier: "T5",
    effectType: "irreversible",
    killSwitch: "COGNOS_SKILL_POST_PUBLISH",
    requiresRung: "irreversible",
    maxPayloadBytes: 40_960,
    timeoutMs: 12_000,
    summary: "Publish one body to one destination granted in the goal's scope. Irreversible: it runs only after a human approves this exact effect, one at a time, never by class.",
    idempotencyRule: "keyed by (goal, url, body): the same publish stages once, and a released key returns its receipt instead of publishing again",
    args: {
      url: { type: "string", max: 2000, required: true },
      method: { type: "enum", values: ["POST"], required: false },
      headers: { type: "object", required: false },
      body: { type: "string", max: 32_768, required: true },
      secret_ref: { type: "string", max: 64, required: false },
      reason: { type: "string", max: 300, required: false }
    },
    execute: publishPost
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
  let rung;
  for (let depth = 0; depth < 4; depth++) {
    if (node && typeof node === "object") {
      if (enabled === undefined && typeof node.enabled === "boolean") enabled = node.enabled;
      if (!notices && node.notices && typeof node.notices === "object") notices = node.notices;
      if (!rung && node.rung && typeof node.rung === "object") rung = node.rung;
      if (Object.prototype.hasOwnProperty.call(node, "autonomy")) node = node.autonomy;
      else break;
    } else break;
  }
  return { enabled, notices: notices || {}, rung: rung || {} };
}

export function isSkillEnabled(id, config = null) {
  const skill = getSkill(id);
  if (!skill) return false;
  if (process.env[skill.killSwitch] === "false") return false;
  const { enabled, notices, rung } = resolveAutonomy(config);
  if (enabled === false) return false;
  // A missing rung reading fails closed: a skill that needs a rung the config
  // does not even name is not enabled.
  if (skill.requiresRung && rung[skill.requiresRung] !== true) return false;
  if (skill.tier === "T2" && (notices.mode === "none" || notices.enabled === false)) return false;
  // Phase 21: T4 is BUILT and still off. The rung flag above already gates a
  // skill that declares requiresRung; this repeats the question at the tier so
  // a future T4 skill cannot forget to declare one and slip through.
  if (skill.tier === "T4" && rung.externalWrites !== true) return false;
  // Phase 22 (autonomy row): T5 is BUILT and still off. The rung flag is the
  // operator's sign-off that the tier exists; it is necessary and not
  // sufficient — a release still needs a per-effect human approval.
  if (skill.tier === "T5" && rung.irreversible !== true) return false;
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
      requiresRung: skill.requiresRung || null,
      enabled: isSkillEnabled(id, config)
    };
  });
}
