// Phase 15.5 — the Policy Engine.
//
// Every architectural adaptation goes through here: registry changes, model
// changes, strategy enable/disable, adaptive-mode changes, schema changes. Each
// proposal must carry a law justification, and any proposal that violates a law
// is REFUSED with the law cited and the refusal written to the Improvement
// Ledger (Phase 15.6). Refusals are rows, not exceptions: the record of what the
// system declined to do is part of what makes it observable.
//
// Two honest limits, both deliberate:
//   1. "Approved" means *authorized and recorded*. Nothing in v1 applies an
//      architectural change at runtime — the law layer is not runtime-writable
//      and the adaptive orchestrator makes no live switches. Applying an
//      approved adaptation is still a reviewed code change.
//   2. The engine cannot approve its own removal. `modify_law` is refused
//      unconditionally, before justification is even considered.

import { LAWS, lawById, resolveLawRefs, LAW_LAYER_VERSION } from "../council/laws.js";
import { SWITCH_THRESHOLDS } from "./adaptive.js";
import { CANONICAL_STRATEGY_ID } from "./strategies.js";
// The banned-model list is imported from the model layer itself, so the Policy
// Engine and resolveModel() can never drift apart. llm.js exports the set; its
// resolution logic and defaults are untouched (pin.model_ban).
import { BANNED_MODELS as BANNED_MODEL_IDS } from "../llm.js";

export const DECISIONS = Object.freeze(["approved", "refused", "recorded", "reverted"]);

/** The actions the engine gates. Anything not on this list is refused: an
 *  adaptation nobody defined is not an adaptation the laws can justify. */
export const GATED_ACTIONS = Object.freeze({
  change_model: "Point the council at a different model id (resolution and defaults stay fixed)",
  enable_strategy: "Add or enable a reasoning strategy in the registry",
  disable_strategy: "Disable a reasoning strategy",
  set_adaptive_mode: "Change the adaptive orchestrator's mode",
  schema_change: "Apply an additive schema migration",
  add_subsystem: "Add a subsystem the council consults or that observes it",
  register_operator: "Add a council operator",
  remove_operator: "Remove a council operator",
  modify_law: "Change the law layer",
  modify_identity: "Change the canonical COGNOS self-model at runtime",
  add_auth: "Introduce accounts or authentication",
  store_secret: "Persist a credential outside the environment",
  change_send_path: "Add or replace the path from user message to user answer",
  weaken_veto: "Reduce what the Governor may refuse",
  rewrite_history: "Delete or alter ledger, telemetry or improvement rows",
  enable_agent_write_tool: "Give agent mode a write-capable or consequential tool",
  weaken_source_boundary: "Relax source prompt-injection, citation, or SSRF protections",
  revert_improvement: "Record the reversal of an earlier improvement row"
});

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9]{20,}/i,
  /postgres(ql)?:\/\/[^"\s]*:[^"\s]*@/i
];

// Statements that are additive in the sense pin.additive_schema means.
const ADDITIVE_SQL = /^\s*(CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\s+IF\s+NOT\s+EXISTS|ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS|COMMENT\s+ON)\b/i;
const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|COLUMN|INDEX|SCHEMA)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN|RENAME\s+(TO|COLUMN)|UPDATE\s+\w+\s+SET)\b/i;

function violation(lawId, reason) {
  const law = lawById(lawId);
  return { law: lawId, law_name: law?.name ?? lawId, statement: law?.statement ?? null, reason };
}

/** Does the proposal cite real laws, and does it argue from them? */
function checkJustification(proposal) {
  const violations = [];
  const justification = typeof proposal.justification === "string" ? proposal.justification.trim() : "";
  if (justification.length < 20) {
    violations.push(violation("charter.evidence", "a proposal needs a stated justification of at least 20 characters; this one has " + justification.length));
    violations.push(violation("phase15.complexity_justification", "complexity must justify itself; an unevidenced change is refused, not deferred"));
  }
  const { known, unknown } = resolveLawRefs(proposal.law_refs ?? proposal.lawRefs);
  if (!known.length) {
    violations.push(violation("charter.evidence", "no law was cited. Cite at least one of: " + LAWS.map(l => l.id).join(", ")));
  }
  if (unknown.length) {
    violations.push(violation("charter.evidence", `cited law(s) that do not exist: ${unknown.join(", ")}`));
  }
  return { violations, known, unknown, justification };
}

function hasEvidence(proposal) {
  const e = proposal.evidence;
  if (!e || typeof e !== "object") return false;
  return Object.values(e).some(v => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length));
}

/** Action-specific law checks. Returns violations; empty means the action is
 *  compatible with every law it touches. */
function checkAction(proposal) {
  const action = proposal.action;
  const params = proposal.params || {};
  const violations = [];

  switch (action) {
    case "modify_law":
      violations.push(violation("phase15.law_layer_immutable", "the law layer cannot be modified at runtime, by an endpoint, or by an adaptation. Changing a law is a reviewed code change to server/council/laws.js"));
      break;

    case "modify_identity":
      violations.push(violation("pin.truthful_self_model", "the canonical self-model cannot be rewritten by a prompt, endpoint, memory, source, or runtime adaptation. A truthful identity change requires a reviewed code change to server/identity.js"));
      break;

    case "register_operator":
    case "remove_operator":
      violations.push(violation("pin.six_operators", `the council is six operators plus the web-search tool they consult. '${action}' would change the seats; subsystems may be added instead, and they do not vote`));
      break;

    case "weaken_veto":
      violations.push(violation("pin.veto_integrity", "the Governor's veto is sovereign. Nothing may weaken it, route around it, or ship a draft it refused"));
      break;

    case "add_auth":
      violations.push(violation("pin.no_auth", "no login or account system is added; conversations stay thread-based"));
      break;

    case "store_secret":
      violations.push(violation("pin.secrets_env_only", "credentials live in server environment variables only — never in the database, the bundle, the ledger, or telemetry"));
      break;

    case "change_send_path":
      violations.push(violation("pin.single_send_path", "there is one path from the user's message to the user's answer; observation is a side effect of it, never a second channel"));
      break;

    case "rewrite_history":
      violations.push(violation("pin.ledger_append_only", "the ledger, telemetry and improvement tables are append-only. Correction is a new transition, not an edit"));
      break;

    case "enable_agent_write_tool":
      violations.push(violation("pin.agent_bounded", "Phase 17 agent mode is read-only. A write-capable tool requires a separately reviewed approval barrier, idempotent executor, and cancellation/consistency proof before it can be enabled"));
      break;

    case "weaken_source_boundary":
      violations.push(violation("pin.source_untrusted", "source text remains untrusted evidence; SSRF, exact-locator citation, content, redirect, timeout, and size boundaries cannot be weakened at runtime"));
      break;

    case "change_model": {
      const model = String(params.model || proposal.target || "");
      if (!model) {
        violations.push(violation("charter.evidence", "change_model needs params.model"));
        break;
      }
      if (BANNED_MODEL_IDS.has(model) || BANNED_MODEL_IDS.has(model.toLowerCase())) {
        violations.push(violation("pin.model_ban", `'${model}' is banned outright: it 503s on this account and took a previous deploy down`));
      }
      if (/^BLUESMINDS_MODEL$/i.test(model) || params.envVar === "BLUESMINDS_MODEL") {
        violations.push(violation("pin.model_ban", "BLUESMINDS_MODEL must never be reintroduced; model resolution reads COGNOS_MODEL then OPENAI_MODEL then the default"));
      }
      if (params.changeResolution || params.changeDefaults) {
        violations.push(violation("pin.model_ban", "model resolution and its defaults do not change (COGNOS_MODEL → OPENAI_MODEL → gpt-4o-mini)"));
      }
      if (!violations.length && !hasEvidence(proposal)) {
        violations.push(violation("charter.evidence", "a model change needs evidence: an evaluation id, telemetry over real runs, or a documented upstream failure"));
      }
      break;
    }

    case "set_adaptive_mode": {
      const mode = String(params.mode || proposal.target || "").toLowerCase();
      if (mode && mode !== "observe") {
        violations.push(violation("phase15.observe_only", `mode '${mode}' would make live switches. v1 records which strategy would be selected and why; it changes nothing`));
      }
      if (mode === "auto" && !violations.length) {
        violations.push(violation("phase15.complexity_justification", "auto mode needs evaluation evidence meeting every threshold in SWITCH_THRESHOLDS"));
      }
      break;
    }

    case "disable_strategy": {
      const id = String(params.strategy_id || proposal.target || "");
      if (id === CANONICAL_STRATEGY_ID || params.is_default) {
        violations.push(violation("pin.single_send_path", "disabling the canonical pipeline would leave a run with no path from message to answer"));
      }
      break;
    }

    case "enable_strategy": {
      const trials = Number(params.eval_trials ?? proposal.evidence?.eval_trials ?? 0);
      const runs = Number(params.runs ?? proposal.evidence?.runs ?? 0);
      if (trials < SWITCH_THRESHOLDS.minEvalTrials || runs < SWITCH_THRESHOLDS.minRunsPerArm) {
        violations.push(violation("phase15.complexity_justification",
          `a new strategy needs evidence: ${trials}/${SWITCH_THRESHOLDS.minEvalTrials} evaluation trials and ${runs}/${SWITCH_THRESHOLDS.minRunsPerArm} runs. Nothing is enabled on a single success`));
      }
      if (!hasEvidence(proposal)) {
        violations.push(violation("charter.evidence", "enable_strategy needs an evidence object (evaluation id, trial counts, measured latency/cost/veto rate)"));
      }
      break;
    }

    case "schema_change": {
      // The DDL may arrive as params.sql or, from a simple proposal form, as the
      // target string. Either way it is judged as SQL, statement by statement.
      const sql = String(params.sql || (typeof proposal.target === "string" ? proposal.target : "") || "");
      if (!sql.trim()) {
        violations.push(violation("charter.evidence", "schema_change needs params.sql"));
        break;
      }
      if (params.destructive || DESTRUCTIVE_SQL.test(sql)) {
        violations.push(violation("pin.additive_schema", "the migration is not additive: it drops, truncates, deletes, renames or rewrites existing structure"));
      }
      const statements = sql.split(";").map(s => s.trim()).filter(s => s && !s.startsWith("--"));
      const nonAdditive = statements.filter(s => !ADDITIVE_SQL.test(s));
      if (nonAdditive.length) {
        violations.push(violation("pin.additive_schema", `${nonAdditive.length} statement(s) are not CREATE/ADD COLUMN IF NOT EXISTS: ${nonAdditive[0].slice(0, 120)}`));
      }
      break;
    }

    case "add_subsystem": {
      if (!params.killSwitch) {
        violations.push(violation("phase15.complexity_justification", "a subsystem needs a kill switch (params.killSwitch naming the config/env flag that turns it off)"));
      }
      if (params.councilSeat) {
        violations.push(violation("pin.six_operators", "a subsystem may be consulted by the council; it may not take a seat in it"));
      }
      if (params.userChannel) {
        violations.push(violation("pin.single_send_path", "a subsystem may not open its own channel to the user"));
      }
      if (!hasEvidence(proposal)) {
        violations.push(violation("charter.evidence", "add_subsystem needs evidence that the subsystem earns its cost"));
      }
      break;
    }

    case "revert_improvement": {
      if (!proposal.target) {
        violations.push(violation("charter.evidence", "revert_improvement needs the id of the row it reverses (target)"));
      }
      break;
    }

    default:
      violations.push(violation("phase15.complexity_justification", `'${action}' is not a gated action the Policy Engine knows. Known actions: ${Object.keys(GATED_ACTIONS).join(", ")}`));
  }

  // A credential in the proposal itself is refused whatever the action was.
  const serialized = JSON.stringify(proposal);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      violations.push(violation("pin.secrets_env_only", "the proposal itself contains something that looks like a credential; secrets are never stored, logged or proposed"));
      break;
    }
  }
  return violations;
}

/**
 * Judge a proposal. Pure: no database, no side effects.
 * @returns {{decision:'approved'|'refused', applied:boolean, violations:Array, lawRefs:Array, reasons:Array}}
 */
export function evaluateAdaptation(proposal = {}) {
  const action = String(proposal.action || "");
  const immutable = action === "modify_law";

  const justification = checkJustification(proposal);
  const actionViolations = checkAction(proposal);
  // modify_law is refused on the law alone; piling on "no justification" would
  // obscure the actual reason.
  const violations = immutable ? actionViolations : [...justification.violations, ...actionViolations];

  const knownGated = Object.prototype.hasOwnProperty.call(GATED_ACTIONS, action);
  if (!knownGated && !immutable) {
    violations.push(violation("phase15.complexity_justification", `unknown action '${action || "(none)"}'`));
  }

  const decision = violations.length ? "refused" : "approved";
  return {
    decision,
    applied: false,                       // v1: authorized and recorded, never executed at runtime
    action,
    target: proposal.target ?? null,
    violations,
    reasons: violations.map(v => `${v.law}: ${v.reason}`),
    lawRefs: justification.known.map(l => l.id),
    unknownLawRefs: justification.unknown,
    justification: justification.justification || null,
    evidenceSufficient: hasEvidence(proposal),
    lawLayerVersion: LAW_LAYER_VERSION,
    evaluatedAt: new Date().toISOString()
  };
}

/**
 * Judge a proposal AND record the judgment in the Improvement Ledger.
 * Refusals are recorded too — that is the point of an append-only ledger.
 */
export async function proposeAdaptation(dbRef, proposal = {}, { logger = null, apply = null } = {}) {
  const evaluation = evaluateAdaptation(proposal);

  // Only the caller can say what "apply" means for an action, and in v1 almost
  // nothing is applicable at runtime. Where it is (the strategy registry, which
  // is data in a new table and cannot touch the six seats or the send path), the
  // applied flag on the ledger row tells the truth about what happened.
  let applied = false;
  let applyResult = null;
  if (evaluation.decision === "approved" && typeof apply === "function") {
    try {
      applyResult = await apply(evaluation);
      applied = applyResult?.applied !== false;
    } catch (e) {
      applyResult = { applied: false, error: String(e?.message || e).slice(0, 400) };
      applied = false;
      logger?.warn?.("approved adaptation could not be applied", { action: evaluation.action, error: String(e) });
    }
  }

  let row = null;
  try {
    row = await dbRef.ImprovementLedger.append({
      ts_ms: Date.now(),
      action: evaluation.action || "unknown",
      target: evaluation.target,
      proposal: { ...proposal, action: evaluation.action || "unknown" },
      evidence: proposal.evidence ?? null,
      law_refs: evaluation.lawRefs.length ? evaluation.lawRefs : (proposal.law_refs ?? []),
      justification: evaluation.justification,
      decision: evaluation.decision,
      reasons: evaluation.violations,
      applied,
      reverted: false,
      proposed_by: proposal.proposed_by || "operator"
    });
  } catch (e) {
    logger?.warn?.("improvement ledger append failed", { error: String(e) });
  }

  // A recorded reversal appends its own row; the original is never edited.
  let revertRow = null;
  if (evaluation.decision === "approved" && evaluation.action === "revert_improvement" && evaluation.target) {
    try {
      revertRow = await dbRef.ImprovementLedger.recordRevert(evaluation.target, {
        reason: evaluation.justification,
        evidence: proposal.evidence ?? null,
        lawRefs: evaluation.lawRefs,
        justification: evaluation.justification,
        proposedBy: proposal.proposed_by || "operator"
      });
    } catch (e) {
      logger?.warn?.("improvement revert append failed", { error: String(e) });
    }
  }

  return { ...evaluation, applied, applyResult, ledger: row, revert: revertRow };
}

export function describePolicy() {
  return {
    lawLayerVersion: LAW_LAYER_VERSION,
    laws: LAWS.map(l => ({ id: l.id, layer: l.layer, name: l.name, forbids: l.forbids || [] })),
    gatedActions: GATED_ACTIONS,
    decisions: DECISIONS,
    appliesAtRuntime: false,
    note: "Approved means authorized and recorded. v1 applies no architectural change at runtime: the law layer is not runtime-writable and the adaptive orchestrator makes no live switches."
  };
}
