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
// Phase 21 extends it with T4 — the first EXTERNAL WRITE. A write is judged
// harder than a read: https only, destinations from granted scope rows only
// (never the read allowlist, never a free-form argument), argument headers
// against an allowlist that refuses `Authorization` outright, a body byte cap,
// a `secret_ref` that must name an environment variable that actually exists,
// quiet hours, and — for a LIVE release — a recorded shadow-evidence row. The
// last one is what makes Rung 4 earned rather than enabled.
//
// The two properties that make the barrier real rather than decorative:
//   * STAGING IS NOT ACTING. A step may stage freely; nothing happens to the
//     world until a release succeeds. A buggy planner can fill the outbox; it
//     cannot empty it.
//   * REPLAY SAFETY IS STRUCTURAL. A released idempotency key returns its prior
//     verdict instead of executing again.

import { getSkill, TIERS } from "../skills/index.js";
import { SECRET_PATTERNS } from "../meta/policy.js";
import { tierAllowed, budgetLineExhausted, insideQuietHours, liveDestinationCovers } from "./config.js";
// Phase 28 — the earned-corpus bypass is a delegated operator switch now, not a
// raw environment read: settings.js owns the pin/delegation/row precedence, so
// there is exactly one place that decides whether the corpus is still required.
import { effectiveBypassEarning } from "./settings.js";
import { authorizationCovers } from "./authorize.js";
import { urlAllowedByScope, destinationsForScope, scopeEntryFor } from "./scopeUrl.js";
import { checkWebhookUrl, checkWebhookHeaders, resolveSecretRef } from "./webhookPost.js";
import { RUNGS, rungEvidenceStatus } from "./evidenceGate.js";

/** Every rule, so a refusal names what fired instead of just "no". */
export const RULES = Object.freeze({
  UNKNOWN_SKILL: "the skill is not in the code-owned registry",
  TIER_NOT_BUILT: "that effect tier is not built in this deployment",
  TIER_NOT_ALLOWED: "that effect tier is not authorized here",
  EFFECT_NOT_IN_SCOPE: "the goal's scope does not allow this effect type",
  DESTINATION_NOT_IN_SCOPE: "the destination is not in the goal's scope",
  DESTINATION_NOT_APPROVED: "the destination is not the one live destination this deployment approved",
  GOAL_NOT_AUTHORIZED: "the goal has no unexpired authorization",
  T5_NEEDS_HUMAN: "an irreversible effect needs a human approval naming this exact effect",
  GOAL_BUDGET_EXHAUSTED: "a per-goal budget line is exhausted",
  WORKSPACE_CEILING: "the workspace ceiling is reached",
  SCOPE_EXPIRED: "the authorization covering this effect has expired",
  SECRET_IN_PAYLOAD: "the payload contains something that looks like a credential",
  PAYLOAD_TOO_LARGE: "the payload exceeds the skill's limit",
  BODY_TOO_LARGE: "the delivery body exceeds the adapter's byte cap",
  RATE_LIMIT: "the per-goal or per-day effect limit is reached",
  UNSAFE_URL: "the URL fails the SSRF boundary",
  METHOD_NOT_ALLOWED: "only POST is built for external writes",
  HEADER_NOT_ALLOWED: "a supplied header is not allowlisted",
  SECRET_REF_UNRESOLVED: "secret_ref does not name a set environment variable",
  QUIET_HOURS: "external deliveries are inside the deployment's quiet hours",
  EVIDENCE_GATE_UNMET: "no recorded shadow corpus justifies a live release at this tier",
  OPERATOR_REFUSED: "an operator refused this effect by hand",
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

/**
 * Effects this goal has had a DELIVERY DECISION on today.
 *
 * `would_release` counts alongside `released`. The cap bounds how often the
 * loop decides to act, and a shadow corpus that ignored the cap would be both
 * unbounded and unrepresentative of the live behaviour it exists to justify.
 */
/**
 * Notices judged for this goal today, from the ledger.
 *
 * The Governor needs its own count rather than `spent.notices` because two
 * paths emit notices — the `notice.emit` skill and the loop's terminal reports
 * (parked, completed, failed) — and only the first one bumps spend. A cap read
 * from a counter that one path never writes is a cap on that path only.
 */
async function goalNoticesToday(db, goalId, nowMs) {
  if (!db || typeof db.query !== "function" || !goalId) return null;
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const rows = await db.query(
    `SELECT COUNT(*)::int AS n FROM autonomy_outbox
      WHERE goal_id = $1 AND effect_type = 'notify'
        AND status IN ('released','would_release') AND created_date >= $2`,
    [goalId, start.toISOString()]
  );
  return Number(rows[0]?.n || 0);
}

async function goalEffectsToday(db, goalId, nowMs) {
  if (!db || typeof db.query !== "function" || !goalId) return null;
  const start = new Date(nowMs);
  start.setHours(0, 0, 0, 0);
  const rows = await db.query(
    `SELECT COUNT(*)::int AS n FROM autonomy_outbox
      WHERE goal_id = $1 AND status IN ('released','would_release') AND created_date >= $2`,
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
export async function judgeEffect({ db, effect, goal, authorization, config, nowMs = Date.now(), mode = null }) {
  const passed = [];
  const failed = [];
  const fail = (rule, law, reason) => failed.push({ rule, law, reason: reason || RULES[rule] });

  const skill = getSkill(effect.skill_id);
  const tier = effect.tier || skill?.tier || "T0";
  const payload = effect.payload || {};
  // The mode a release would run in. decideEffect passes the effective mode; a
  // direct caller gets the row's own. The evidence gate needs it, because a
  // shadow verdict is the corpus and a live verdict is the consequence.
  const effectiveMode = mode || effect.mode || "shadow";

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
  // An entry may name the effect TYPE ("external_write") or the SKILL that
  // produces it ("webhook.post"), because AUTONOMY.md §4.7.1 writes the write
  // gate in terms of the skill — the entry that carries a destination list has
  // to be findable by whichever name the operator used. A string entry still
  // grants the class exactly as it did before.
  const effectAllowedByScope = effectsAllowed.some(entry =>
    (typeof entry === "string" ? entry : (entry?.effect ?? entry?.skill)) === effect.effect_type)
    || Boolean(scopeEntryFor(scope, { effectType: effect.effect_type, skillId: effect.skill_id }));

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

  // --- T4 external writes (Phase 21) / T5 irreversible (Phase 22) -------------
  // A write is judged harder than a read. The destination is not the model's to
  // choose: it picks from rows granted at authorization, and a grant that names
  // no destination grants nothing. Read allowlists never widen into write
  // destinations — looking somewhere and acting there are different authorities.
  //
  // T5 is judged through the SAME shape rules as T4 (the destination, the body
  // and the socket are identical; only the release authority differs), then
  // held to the additional rule below: a human approval row must name THIS
  // exact outbox id. It does NOT inherit T4's shadow-evidence gate or the one
  // approved live destination — those are Rung 4's earning mechanics. Rung 6's
  // entry criterion is explicit operator sign-off plus per-effect approval.
  if (effect.effect_type === "external_write" || effect.effect_type === "irreversible") {
    const storedSha = effect.scope_sha256 || payload.scopeSha256 || null;
    if (storedSha && authorization?.scope_sha256 && storedSha !== authorization.scope_sha256) {
      fail("EFFECT_NOT_IN_SCOPE", "pin.goal_scope_immutable",
        "staged under a different scope than the current authorization");
    }
    if (authorization
        && !authorizationCovers(authorization, { goalId: goal?.id, scope, budget: goal?.budget || {}, nowMs })) {
      fail("EFFECT_NOT_IN_SCOPE", "pin.goal_scope_immutable",
        "the goal's scope or budget no longer matches the authorization");
    }

    const href = typeof payload.url === "string" ? payload.url : "";
    const shaped = checkWebhookUrl(href);
    if (!shaped.ok) {
      fail("UNSAFE_URL", "pin.effect_staged", shaped.reason);
    } else {
      passed.push("the destination is https on 443, carries no credentials, and names no literal IP or local host");
    }

    const granted = destinationsForScope(scope, { effectType: effect.effect_type, skillId: effect.skill_id });
    if (!granted.length) {
      fail("DESTINATION_NOT_IN_SCOPE", "pin.goal_scope_immutable",
        "the goal's scope grants no destination for this write skill");
    } else if (shaped.ok) {
      const grant = urlAllowedByScope(href, granted);
      if (!grant.allowed) {
        fail("DESTINATION_NOT_IN_SCOPE", "pin.goal_scope_immutable",
          `the destination is not granted (${grant.reason}); ${granted.length} destination(s) are`);
      } else {
        passed.push(`the destination is granted by a scope entry (${grant.reason})`);
      }
    }

    const method = String(payload.method || "POST").toUpperCase();
    if (method !== "POST") {
      fail("METHOD_NOT_ALLOWED", "pin.effect_staged", `method '${method}' — POST is the only method built`);
    } else {
      passed.push("the method is POST");
    }

    const headers = checkWebhookHeaders(payload.headers);
    if (!headers.ok) {
      fail("HEADER_NOT_ALLOWED", "pin.secrets_env_only", headers.errors.join("; "));
    } else {
      passed.push(`every supplied header is allowlisted (${headers.names.length} named)`);
    }

    const bodyText = typeof payload.body === "string" ? payload.body : "";
    const bodyBytes = Buffer.byteLength(bodyText, "utf8");
    const bodyCap = Number(config.webhook?.maxBodyBytes ?? 32_768);
    if (!bodyText.trim()) {
      fail("BODY_TOO_LARGE", "pin.effect_staged", "a webhook body is required");
    } else if (bodyBytes > bodyCap) {
      fail("BODY_TOO_LARGE", "pin.effect_staged", `${bodyBytes} bytes > the ${bodyCap} byte cap`);
    } else {
      passed.push(`the body is ${bodyBytes} byte(s), within the cap`);
    }

    // The NAME is judged; the value is read at send time and stored nowhere.
    const secret = resolveSecretRef(payload.secretRef ?? payload.secret_ref ?? null);
    if (!secret.ok) {
      fail("SECRET_REF_UNRESOLVED", "pin.secrets_env_only", secret.reason);
    } else if (secret.name) {
      passed.push(`the body is signed with the secret named '${secret.name}' (the value is never stored)`);
    } else {
      passed.push("the delivery is unsigned (no secret_ref named)");
    }

    // Quiet hours are a brake on deliveries, not on records: a notice is how an
    // operator learns a goal parked, so suppressing it would hide the thing it
    // exists to report. Only external writes observe the window.
    if (insideQuietHours(config.quietHours, nowMs)) {
      const qh = config.quietHours || {};
      fail("QUIET_HOURS", "phase19.autonomy_default_off",
        `external deliveries are quiet between ${qh.startHour}:00 and ${qh.endHour}:00`);
    }

    // The earned-not-enabled gate. A live release at T4 requires a recorded
    // shadow corpus that satisfied the gate, and the recorded metrics must
    // still satisfy the gate as it is configured NOW — raising minShadowSamples
    // after the fact invalidates an old justification instead of grandfathering
    // it. T5 does NOT walk this gate: Rung 6's release authority is the
    // per-effect human approval below, never a corpus (pin.irreversible_human_approval).
    if (effect.effect_type === "external_write" && effectiveMode === "live") {
      // Phase 22 (autonomy row) — THE ONE APPROVED DESTINATION. The scope grant
      // above answers "did a human authorize THIS goal to act here?". This
      // answers a narrower question about the deployment rather than the goal:
      // "which single endpoint may a live delivery reach?" Both must hold, so
      // the intersection is strictly narrower than either gate alone — the safe
      // direction for a second gate to be wrong in.
      //
      // Live only. Shadow samples are the corpus that earns the rung, and
      // refusing them here would starve the gate; the readiness report says how
      // much of an earned corpus is aimed at the approved destination instead,
      // and a flip to live is refused if none of it is.
      const approved = liveDestinationCovers(config.liveDestination, href);
      if (!approved.allowed) {
        fail("DESTINATION_NOT_APPROVED", "pin.live_destination_approved", approved.reason);
      } else {
        passed.push(`the destination is the deployment's one approved live endpoint (${approved.entry})`);
      }

      const bypassEarning = effectiveBypassEarning();
      if (!bypassEarning) {
        const evidence = typeof db?.RungEvidence?.currentJustified === "function"
          ? await db.RungEvidence.currentJustified(goal?.workspace_id, RUNGS.external_writes.rung).catch(() => null)
          : null;
        if (!evidence) {
          fail("EVIDENCE_GATE_UNMET", "pin.live_mode_earned",
            "no recorded shadow corpus justifies a live release at this tier");
        } else {
          const gate = config?.shadow || { minShadowSamples: 25, maxAcceptableFalseReleases: 0 };
          const minSamples = Number(gate.minShadowSamples ?? 25);
          const maxFalse = Number(gate.maxAcceptableFalseReleases ?? 0);
          let metrics = {};
          if (typeof evidence.metrics === "string") {
            try { metrics = JSON.parse(evidence.metrics); } catch { metrics = {}; }
          } else if (evidence.metrics && typeof evidence.metrics === "object") {
            metrics = evidence.metrics;
          }
          if (Number(metrics.samples ?? 0) < minSamples || Number(metrics.falseReleaseCount ?? 0) > maxFalse) {
            fail("EVIDENCE_GATE_UNMET", "pin.live_mode_earned",
              "the recorded shadow corpus no longer satisfies the gate as configured now");
          } else {
            passed.push("a recorded shadow corpus justifies live delivery");
          }
        }
      } else {
        passed.push("external delivery does not require earned evidence when bypass is enabled");
      }
    }
  }

  // --- authorization -------------------------------------------------------
  // T5 is authorized, judged, and THEN held for a per-effect human approval.
  // The authorization check below is shared with T1–T4 (an unexpired scope
  // covering this class and destination); the approval check is T5's alone.
  if (["T1", "T2", "T3", "T4", "T5"].includes(tier)) {
    if (!authorization) {
      fail("GOAL_NOT_AUTHORIZED", "pin.goal_scope_immutable",
        "no unexpired authorization row for this goal");
    } else if (authorization.expires_at_ms && Number(authorization.expires_at_ms) <= nowMs) {
      fail("SCOPE_EXPIRED", "pin.goal_scope_immutable");
    } else {
      passed.push("an unexpired authorization covers this goal");
    }
  }

  if (tier === "T5") {
    // Irreversible: one-by-one human approval naming THIS outbox id. Never
    // authorizable by class, never by the loop — the only writer of an
    // approval row is the outbox decision route, which is a human click.
    const approval = typeof db?.EffectApproval?.current === "function"
      ? await db.EffectApproval.current(effect.id).catch(() => null)
      : null;
    if (!approval) {
      fail("T5_NEEDS_HUMAN", "pin.irreversible_human_approval",
        "no human approval row names this exact effect id");
    } else {
      // The approval is bound to the scope it was made under: an approval must
      // not outlive the authorization it was recorded against.
      if (approval.scope_sha256 && authorization?.scope_sha256
          && approval.scope_sha256 !== authorization.scope_sha256) {
        fail("T5_NEEDS_HUMAN", "pin.irreversible_human_approval",
          "the approval names this effect but was recorded under a different scope");
      } else {
        passed.push("a human approval row names this exact effect id");
      }
    }
  }

  // --- budgets -------------------------------------------------------------
  // A notice is counted as an effect, and that double count has a failure mode:
  // a goal that exhausts maxEffectsPerDay would be refused the notice reporting
  // the exhaustion, so the operator sees a goal go quiet for a reason recorded
  // nowhere they look. Silence is the one outcome this design treats as worse
  // than a stopped goal — the goal route authorizes `notify` by default for
  // exactly this reason. Notices therefore answer to their OWN line,
  // maxNoticesPerDay, enforced from the ledger just below, and are exempt from
  // the two effect-count lines. Every other budget line still applies to them.
  const isNotice = effect.effect_type === "notify";
  const EFFECT_CAP_LINES = ["maxEffectsPerDay", "maxExternalEffects"];
  const over = budgetLineExhausted(goal?.spent || {}, goal?.budget || {}, nowMs);
  if (over && isNotice && EFFECT_CAP_LINES.includes(over.key)) {
    passed.push(`a notice is bounded by maxNoticesPerDay, not by the ${over.key} line it exists to report`);
  } else if (over) {
    fail("GOAL_BUDGET_EXHAUSTED", "pin.goal_scope_immutable",
      `${over.key} at ${over.used} of ${over.limit}`);
  } else {
    passed.push("every per-goal budget line has headroom");
  }

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
  } else if (today >= perDay && !isNotice) {
    fail("RATE_LIMIT", "pin.effect_staged", `${today} effect(s) today, limit ${perDay}`);
  } else if (today >= perDay) {
    passed.push(`the per-day effect limit is reached (${today}/${perDay}), and a notice is how that is reported`);
  } else {
    passed.push("under the per-day effect limit");
  }

  // The notice cap, read from the ledger so it binds on the terminal-report path
  // as well as on `notice.emit`. This is the line that keeps the exemption above
  // from becoming an unbounded channel: three notices a day by default, and
  // "more than three a day is narration, not reporting".
  if (isNotice) {
    const noticesTodayCount = await goalNoticesToday(db, goal?.id, nowMs);
    const noticesPerDay = Number(goal?.budget?.maxNoticesPerDay || 3);
    if (noticesTodayCount === null) {
      fail("SPEND_UNVERIFIABLE", "pin.effect_staged", "the notice ledger could not be read");
    } else if (noticesTodayCount >= noticesPerDay) {
      fail("RATE_LIMIT", "pin.notice_deterministic",
        `${noticesTodayCount} notice(s) today, limit ${noticesPerDay}`);
    } else {
      passed.push(`under the per-day notice limit (${noticesTodayCount}/${noticesPerDay})`);
    }
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
    // The mode this verdict was judged FOR, which decideEffect passes down. A
    // live judgement carries the evidence gate; a shadow one does not, because
    // the shadow judgement is the evidence.
    mode: effectiveMode,
    stagedMode: effect.mode || "shadow",
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
