// The Action Governor — Phase 19.
//
// The approval barrier pin.agent_bounded has been waiting for since Phase 17.
//
// It is deliberately shaped like the Answer Governor (server/council/governor.js):
// a model-free rulebook over the final payload, refusing by default, recording
// refusals as rows instead of throwing. It contains no model call and cannot be
// argued with. The difference is only what it judges — an effect rather than a
// sentence.
//
// Phase 20 extends it with T3 destination rules: a fetch URL is checked
// structurally (shape, literal IP, credentials) and against the goal's
// urlAllowlist, and the staged scope binding refuses an effect approved after
// its scope changed.
//
// The two properties that make the barrier real rather than decorative:
//   * STAGING IS NOT ACTING. A step may stage freely; nothing happens to the
//     world until a release succeeds. A buggy planner can fill the outbox; it
//     cannot empty it.
//   * REPLAY SAFETY IS STRUCTURAL. A released idempotency key returns its prior
//     verdict instead of executing again.

import { getSkill, TIERS } from "../skills/index.js";
import { SECRET_PATTERNS } from "../meta/policy.js";
import { tierAllowed, budgetLineExhausted } from "./config.js";
import { authorizationCovers } from "./authorize.js";
import { urlAllowedByScope } from "./scopeUrl.js";

/** Every rule, so a refusal names what fired instead of just "no". */
export const RULES = Object.freeze({
  UNKNOWN_SKILL: "the skill is not in the code-owned registry",
  TIER_NOT_BUILT: "that effect tier is not built in this deployment",
  TIER_NOT_ALLOWED: "that effect tier is not authorized here",
  EFFECT_NOT_IN_SCOPE: "the goal's scope does not allow this effect type",
  DESTINATION_NOT_IN_SCOPE: "the destination is not in the goal's scope",
  GOAL_NOT_AUTHORIZED: "the goal has no unexpired authorization",
  T5_NEEDS_HUMAN: "an irreversible effect needs a human approval naming this exact effect",
  GOAL_BUDGET_EXHAUSTED: "a per-goal budget line is exhausted",
  WORKSPACE_CEILING: "the workspace ceiling is reached",
  SCOPE_EXPIRED: "the authorization covering this effect has expired",
  SECRET_IN_PAYLOAD: "the payload contains something that looks like a credential",
  PAYLOAD_TOO_LARGE: "the payload exceeds the skill's limit",
  RATE_LIMIT: "the per-goal or per-day effect limit is reached",
  UNSAFE_URL: "the URL fails the SSRF boundary",
  NOTICES_DISABLED: "notices are disabled",
  SPEND_UNVERIFIABLE: "the spend ledger could not be read, so the ceiling cannot be checked"
});

const decision = (verdict, law) => ({ rule: verdict, law });

/** Autonomous spend today, measured from the tick ledger. */
async function workspaceSpendToday(db, workspaceId, nowMs) {
  if (!db || typeof db.query !== "function" || !workspaceId) return null;
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const rows = await db.query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM autonomy_ticks
      WHERE workspace_id = $1 AND created_date >= $2`,
    [workspaceId, start.toISOString()]
  );
  return Number(rows[0]?.total || 0);
}

/** Effects released for this goal today. */
async function goalEffectsToday(db, goalId, nowMs) {
  if (!db || typeof db.query !== "function" || !goalId) return null;
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const rows = await db.query(
    `SELECT COUNT(*)::int AS n FROM autonomy_outbox
      WHERE goal_id = $1 AND status = 'released' AND created_date >= $2`,
    [goalId, start.toISOString()]
  );
  return Number(rows[0]?.n || 0);
}

/**
 * A hostname that is already an address. WHATWG URL parsing normalizes exotic
 * IPv4 spellings (hex, octal, short, single-integer) before we see them, so a
 * dotted-quad test on the PARSED hostname plus the bracketed-v6 test covers
 * every literal spelling. DNS-resolved names are safeFetch's problem at
 * perform time; literals never get that far.
 */
function isLiteralIpHost(hostname) {
  const host = String(hostname || "");
  if (!host || host.includes(":")) return host.includes(":");
  const parts = host.split(".");
  if (parts.length === 4 && parts.every(segment => /^\d{1,3}$/.test(segment) && Number(segment) <= 255)) return true;
  return /^\d+$/.test(host);
}

function describeUnsafeUrl(href, parsed, literalIp) {
  if (!parsed) return "the fetch URL does not parse";
  if (parsed.username || parsed.password) return "the fetch URL carries credentials";
  if (!["http:", "https:"].includes(parsed.protocol)) return `the fetch URL uses ${parsed.protocol} instead of http(s)`;
  if (literalIp) return "the fetch URL names a literal IP address";
  return `the fetch URL is rejected: ${String(href).slice(0, 120)}`;
}

/**
 * Judge one staged effect. Pure with respect to the world: it reads, it never
 * performs.
 *
 * @returns {{decision:'release'|'refuse'|'replay', passed:string[], failed:Array, mode:string}}
 */
export async function judgeEffect({ db, effect, goal, authorization, config, nowMs = Date.now() }) {
  const passed = [];
  const failed = [];
  const fail = (rule, law, reason) => failed.push({ rule, law, reason: reason || RULES[rule] });

  const skill = getSkill(effect.skill_id);
  const tier = effect.tier || skill?.tier || "T0";
  const payload = effect.payload || {};

  // --- identity of the effect ---------------------------------------------
  if (!skill) {
    fail("UNKNOWN_SKILL", "pin.effect_staged", `no skill named ${effect.skill_id}`);
  } else {
    passed.push("skill is in the code-owned registry");

    if (!tierAllowed(tier, config)) {
      const built = config.builtTiers.includes(tier);
      fail(built ? "TIER_NOT_ALLOWED" : "TIER_NOT_BUILT", "pin.effect_staged",
        `tier ${tier} (${TIERS[tier] || "unknown"})`);
    } else {
      passed.push(`tier ${tier} is built and allowed`);
    }

    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (bytes > skill.maxPayloadBytes) {
      fail("PAYLOAD_TOO_LARGE", "pin.effect_staged", `${bytes} bytes > ${skill.maxPayloadBytes}`);
    } else {
      passed.push("payload within the skill's size limit");
    }
  }

  // --- scope ---------------------------------------------------------------
  const scope = goal?.scope || {};
  const effectsAllowed = Array.isArray(scope.effectsAllowed) ? scope.effectsAllowed : [];
  const effectAllowedByScope = effectsAllowed.some(entry =>
    (typeof entry === "string" ? entry : entry?.effect) === effect.effect_type);

  // T0 and T1 are internal and need no explicit scope entry; T2 and above do.
  if (["T2", "T3", "T4", "T5"].includes(tier) && !effectAllowedByScope) {
    fail("EFFECT_NOT_IN_SCOPE", "pin.effect_staged",
      `tier ${tier} effect '${effect.effect_type}' is not in the goal's effectsAllowed`);
  } else if (effectAllowedByScope) {
    passed.push("effect type is in the goal's scope");
  } else {
    passed.push(`tier ${tier} is internal and needs no scope entry`);
  }

  // config.notices is an object ({ mode, enabled, ... }), so testing it for
  // `false` never matched and this rule could never fire. Ask the same
  // question tierAllowed asks, in the same terms.
  const notices = config.notices ?? {};
  if (tier === "T2" && (notices.enabled === false || notices.mode === "none")) {
    fail("NOTICES_DISABLED", "phase19.autonomy_default_off",
      `notices are off (mode: ${notices.mode ?? "unset"})`);
  }
  if (tier === "T2" && notices.misconfigured) {
    fail("NOTICES_DISABLED", "phase19.autonomy_default_off",
      "notices are set to webhook but no COGNOS_AUTONOMY_NOTICE_WEBHOOK is configured");
  }

  // --- T3 destinations (Phase 20) -------------------------------------------
  // The model names the URL, so the URL is judged structurally AND against the
  // authorized scope. Search has no destination (the provider is code-owned),
  // so only fetches walk this path; a pasted credential in a query still
  // refuses below under SECRET_IN_PAYLOAD.
  if (effect.effect_type === "external_read" && payload.scopeSha256
      && authorization?.scope_sha256 && payload.scopeSha256 !== authorization.scope_sha256) {
    fail("EFFECT_NOT_IN_SCOPE", "pin.goal_scope_immutable",
      "staged under a different scope than the current authorization");
  }
  // The allowlist below is read from the live goal row — which is only the
  // AUTHORIZED scope if its hashes still cover it. Same check the outbox
  // decision route runs, because the tick path never passes that route.
  if (effect.effect_type === "external_read" && authorization
      && !authorizationCovers(authorization, { goalId: goal?.id, scope, budget: goal?.budget || {}, nowMs })) {
    fail("EFFECT_NOT_IN_SCOPE", "pin.goal_scope_immutable",
      "the goal's scope or budget no longer matches the authorization");
  }
  if (effect.effect_type === "external_read" && payload.op === "fetch") {
    const href = typeof payload.url === "string" ? payload.url : "";
    let parsed = null;
    try {
      parsed = new URL(href);
    } catch {
      parsed = null;
    }
    const literalIp = parsed ? isLiteralIpHost(parsed.hostname) : false;
    if (!parsed || !["http:", "https:"].includes(parsed?.protocol) || literalIp || parsed.username || parsed.password) {
      fail("UNSAFE_URL", "pin.effect_staged", describeUnsafeUrl(href, parsed, literalIp));
    } else {
      passed.push("fetch URL passes the structural SSRF boundary (DNS pinning re-checks at perform time)");
    }
    // The authorization row carries hashes, not the scope itself — so the
    // allowlist is read from the live goal row, and the covers check above
    // refuses anything staged or judged after a scope change. Scope is
    // immutable after creation (pin.goal_scope_immutable); the binding is the
    // seatbelt, not the steering.
    const entries = Array.isArray(scope.urlAllowlist) ? scope.urlAllowlist : [];
    const grant = parsed ? urlAllowedByScope(href, entries) : null;
    if (parsed && !grant.allowed) {
      fail("DESTINATION_NOT_IN_SCOPE", "pin.goal_scope_immutable",
        `the fetch URL is not in the goal's urlAllowlist (${grant.reason})`);
    } else if (parsed) {
      passed.push(`fetch URL is granted by allowlist entry (${grant.reason})`);
    }
  }

  // --- authorization -------------------------------------------------------
  if (tier === "T5") {
    // Irreversible: one-by-one human approval naming THIS outbox id. Never
    // authorizable by class.
    fail("T5_NEEDS_HUMAN", "pin.effect_staged", "no approval row names this effect id");
  } else if (["T1", "T2", "T3", "T4"].includes(tier)) {
    if (!authorization) {
      fail("GOAL_NOT_AUTHORIZED", "pin.goal_scope_immutable",
        "no unexpired authorization row for this goal");
    } else if (authorization.expires_at_ms && Number(authorization.expires_at_ms) <= nowMs) {
      fail("SCOPE_EXPIRED", "pin.goal_scope_immutable");
    } else {
      passed.push("an unexpired authorization covers this goal");
    }
  }

  // --- budgets -------------------------------------------------------------
  const over = budgetLineExhausted(goal?.spent || {}, goal?.budget || {}, nowMs);
  if (over) fail("GOAL_BUDGET_EXHAUSTED", "pin.goal_scope_immutable",
    `${over.key} at ${over.used} of ${over.limit}`);
  else passed.push("every per-goal budget line has headroom");

  const spentToday = await workspaceSpendToday(db, goal?.workspace_id, nowMs);
  if (spentToday === null) {
    fail("SPEND_UNVERIFIABLE", "phase19.autonomy_default_off", "autonomy_ticks could not be read");
  } else if (spentToday >= config.ceiling.maxDailyUsd) {
    fail("WORKSPACE_CEILING", "phase19.autonomy_default_off",
      `$${spentToday.toFixed(2)} of $${config.ceiling.maxDailyUsd.toFixed(2)} today`);
  } else {
    passed.push("workspace daily spend is under the ceiling");
  }

  // --- rate limits ---------------------------------------------------------
  const today = await goalEffectsToday(db, goal?.id, nowMs);
  const perDay = Number(goal?.budget?.maxEffectsPerDay || 10);
  if (today === null) {
    fail("SPEND_UNVERIFIABLE", "pin.effect_staged", "the effect ledger could not be read");
  } else if (today >= perDay) {
    fail("RATE_LIMIT", "pin.effect_staged", `${today} effect(s) today, limit ${perDay}`);
  } else {
    passed.push("under the per-day effect limit");
  }

  // --- secrets -------------------------------------------------------------
  const serialized = JSON.stringify(payload);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      fail("SECRET_IN_PAYLOAD", "pin.secrets_env_only");
      break;
    }
  }
  if (!failed.some(f => f.rule === "SECRET_IN_PAYLOAD")) passed.push("payload carries no credential");

  const refuse = failed.length > 0;
  return {
    decision: refuse ? "refuse" : "release",
    passed,
    failed,
    mode: effect.mode || "shadow",
    tier,
    judgedAt: new Date(nowMs).toISOString(),
    law: refuse ? failed[0].law : "pin.effect_staged"
  };
}

/**
 * Should a released verdict actually be performed? Shadow and dry_run produce
 * verdicts and rows and deliver nothing — that is how Rung 4 earns its way in.
 */
export function shouldExecute(verdict, mode) {
  if (verdict.decision !== "release") return false;
  return mode === "live";
}
