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
import { tierAllowed, budgetLineExhausted, insideQuietHours, liveDestinationCovers, dayStartMs } from "./config.js";
// Phase 28 — the earned-corpus bypass is a delegated operator switch now, not a
// raw environment read: settings.js owns the pin/delegation/row precedence.
import { authorizationCovers } from "./authorize.js";
import { urlAllowedByScope, destinationsForScope, scopeEntryFor } from "./scopeUrl.js";
import { checkWebhookUrl, checkWebhookHeaders, resolveSecretRef } from "./webhookPost.js";
import { isAllowedHeaderName } from "./webhookPost.js";
import { effectiveEnabled } from "./settings.js";

/** Every rule, so a refusal names what fired instead of just "no".
 *
 * The VALUES are the sentences Jeremy reads on the Outbox tab, so they are
 * plain everyday language — what happened and what it means for him. The KEYS
 * are the stable machine ids the evidence gate and the tick match on; those
 * never change for wording.
 */
export const RULES = Object.freeze({
  UNKNOWN_SKILL: "there's no skill by that name in this build",
  TIER_NOT_BUILT: "that kind of action isn't built into this deployment",
  TIER_NOT_ALLOWED: "that kind of action isn't switched on here",
  EFFECT_NOT_IN_SCOPE: "the goal's permission doesn't cover this kind of action",
  DESTINATION_NOT_IN_SCOPE: "that address isn't in the goal's permission",
  DESTINATION_NOT_APPROVED: "that isn't the one approved address for live sends",
  GOAL_NOT_AUTHORIZED: "the goal has no current permission",
  T5_NEEDS_HUMAN: "this one needs your personal approval — nothing automatic can approve it",
  GOAL_BUDGET_EXHAUSTED: "the goal used up its budget",
  WORKSPACE_CEILING: "the workspace hit its daily spending cap",
  SCOPE_EXPIRED: "the goal's permission ran out",
  SECRET_IN_PAYLOAD: "the message looks like it contains a password or key",
  PAYLOAD_TOO_LARGE: "the payload is bigger than the skill allows",
  BODY_TOO_LARGE: "the message body is over the size limit",
  RATE_LIMIT: "the per-day action limit is reached",
  UNSAFE_URL: "the URL didn't pass the safety check",
  METHOD_NOT_ALLOWED: "only POST is built for outside messages",
  HEADER_NOT_ALLOWED: "a header in the request isn't on the allowed list",
  SECRET_REF_UNRESOLVED: "the named secret isn't set",
  QUIET_HOURS: "it's quiet hours — outside sends wait",
  EVIDENCE_GATE_UNMET: "the practice runs haven't proved this out yet",
  OPERATOR_REFUSED: "refused by hand in the outbox",
  NOTICES_DISABLED: "notices are turned off",
  SPEND_UNVERIFIABLE: "the spending ledger couldn't be read, so the cap can't be checked",
  // A lookup that errors is not the same as a lookup that finds nothing: the
  // ledger must never record "there is no evidence/approval" when the truth is
  // "the check could not run".
  EVIDENCE_UNREADABLE: "the evidence ledger couldn't be read, so the check couldn't run",
  APPROVAL_UNREADABLE: "the approval ledger couldn't be read, so the approval check couldn't run",
  CONFIG_UNREADABLE: "the autonomy settings couldn't be read, so nothing can be judged safe",
  BODY_REQUIRED: "the message needs a body",
  // Phase 36 — resident tools. Plain language for the approvals inbox.
  AUTONOMY_DISABLED: "autonomy is off — the master switch is down, so nothing runs",
  TOOL_UNKNOWN: "that tool doesn't exist anymore",
  TOOL_NOT_ASSIGNED: "that tool isn't assigned to this resident",
  TOOL_URL_UNSAFE: "the tool's address didn't pass the safety check",
  TOOL_DESTINATION_MISMATCH: "the request goes somewhere the tool's definition doesn't name",
  TOOL_METHOD_MISMATCH: "the method doesn't match the tool's definition",
  TOOL_WRITE_NEEDS_APPROVAL: "a write needs your approval first — it's waiting in the inbox"
});

/**
 * The two scope-binding checks every external effect walks: the staged row
 * must still match the authorization's scope hash, and the authorization must
 * still cover the goal's current scope and budget. T3 reads carry their hash
 * in the payload; T4/T5 writes carry it on the row (falling back to the
 * payload) — the sources differ, the checks don't, so both funnel through
 * here instead of being copied per tier.
 */
function checkScopeBinding(checks, { storedSha, authorization, goal, scope, nowMs }) {
  const { fail, passed } = checks;
  if (storedSha && authorization?.scope_sha256 && storedSha !== authorization.scope_sha256) {
    fail("EFFECT_NOT_IN_SCOPE", "pin.goal_scope_immutable",
      "staged under a different scope than the current authorization");
  }
  // The scope below is read from the live goal row — which is only the
  // AUTHORIZED scope if its hashes still cover it. Same check the outbox
  // decision route runs, because the tick path never passes that route.
  if (authorization
      && !authorizationCovers(authorization, { goalId: goal?.id, scope, budget: goal?.budget || {}, nowMs })) {
    fail("EFFECT_NOT_IN_SCOPE", "pin.goal_scope_immutable",
      "the goal's scope or budget no longer matches the authorization");
  } else if (authorization) {
    passed.push("the authorization still covers the goal's scope and budget");
  }
}

/** Autonomous spend today, measured from the tick ledger. */
async function workspaceSpendToday(db, workspaceId, nowMs, timeZone) {
  if (!db || typeof db.query !== "function" || !workspaceId) return null;
  const start = new Date(dayStartMs(nowMs, timeZone));
  try {
    const rows = await db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM autonomy_ticks
        WHERE workspace_id = $1 AND created_date >= $2`,
      [workspaceId, start.toISOString()]
    );
    return Number(rows[0]?.total || 0);
  } catch {
    return null;
  }
}

/**
 * Notices judged for this goal today, from the ledger.
 *
 * The Governor needs its own count rather than `spent.notices` because two
 * paths emit notices — the `notice.emit` skill and the loop's terminal reports
 * (parked, completed, failed) — and only the first one bumps spend. A cap read
 * from a counter that one path never writes is a cap on that path only.
 */
async function goalNoticesToday(db, goalId, nowMs, timeZone) {
  if (!db || typeof db.query !== "function" || !goalId) return null;
  const start = new Date(dayStartMs(nowMs, timeZone));
  // A query that throws is "could not be read", not zero: the callers already
  // fail closed on null (SPEND_UNVERIFIABLE), so a throw must become null too.
  try {
    const rows = await db.query(
      `SELECT COUNT(*)::int AS n FROM autonomy_outbox
        WHERE goal_id = $1 AND effect_type = 'notify'
          AND status IN ('released','would_release') AND created_date >= $2`,
      [goalId, start.toISOString()]
    );
    return Number(rows[0]?.n || 0);
  } catch {
    return null;
  }
}

/**
 * Effects this goal has had a DELIVERY DECISION on today.
 *
 * `would_release` counts alongside `released`. The cap bounds how often the
 * loop decides to act, and a shadow corpus that ignored the cap would be both
 * unbounded and unrepresentative of the live behaviour it exists to justify.
 */
async function goalEffectsToday(db, goalId, nowMs, timeZone) {
  if (!db || typeof db.query !== "function" || !goalId) return null;
  const start = new Date(dayStartMs(nowMs, timeZone));
  try {
    const rows = await db.query(
      `SELECT COUNT(*)::int AS n FROM autonomy_outbox
        WHERE goal_id = $1 AND status IN ('released','would_release') AND created_date >= $2`,
      [goalId, start.toISOString()]
    );
    return Number(rows[0]?.n || 0);
  } catch {
    return null;
  }
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

    // A malformed config must produce a refusal row, never a throw — the
    // Governor's contract is "recording refusals as rows instead of throwing".
    const builtTiers = Array.isArray(config?.builtTiers) ? config.builtTiers : null;
    if (!builtTiers) {
      fail("CONFIG_UNREADABLE", "phase19.autonomy_default_off");
    } else if (!tierAllowed(tier, config)) {
      const built = builtTiers.includes(tier);
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

  // --- Phase 36: resident tool calls ---------------------------------------
  // A tool_call is judged on its own terms, not the goal-scope machinery: the
  // destination's authority is Jeremy's hand-typed tool definition, and there
  // may be no goal at all (per-resident chat). The Governor still enforces the
  // kill switch, the assignment, the URL's shape and origin, the method, the
  // header allowlist, the body cap, and no credentials outside {{secret:…}} —
  // and for writes, a per-effect human approval naming this exact outbox id.
  // That is the same EffectApproval story as T5: one coherent approval story,
  // not two. Budgets are goal concepts; the approval is the gate for tools.
  if (effect.effect_type === "tool_call") {
    const tp = payload;

    if (!effectiveEnabled()) {
      fail("AUTONOMY_DISABLED", "phase19.autonomy_default_off");
    } else {
      passed.push("autonomy is on — the master switch is up");
    }

    const tool = await db.ResidentTool.get(tp.toolId).catch(() => null);
    if (!tool) {
      fail("TOOL_UNKNOWN", "pin.effect_staged", "the tool definition is gone");
    } else {
      passed.push("the tool definition exists");
    }

    const agent = effect.agent_id
      ? await db.AutonomyAgent.get(effect.agent_id).catch(() => null)
      : null;
    const slug = tp.agentSlug || agent?.slug;
    const assigned = tool && agent && slug
      ? await db.ResidentTool.isAssigned(tp.toolId, slug).catch(() => false)
      : false;
    if (!assigned) {
      fail("TOOL_NOT_ASSIGNED", "pin.effect_staged",
        "the tool is not assigned to the resident that staged this call");
    } else {
      passed.push("the tool is assigned to this resident");
    }

    if (tool && tp.method !== tool.method) {
      fail("TOOL_METHOD_MISMATCH", "pin.effect_staged",
        `staged as ${tp.method || "(none)"}, defined as ${tool.method}`);
    } else if (tool) {
      passed.push("the method matches the tool's definition");
    }

    if (tp.url_origin) {
      const shaped = checkWebhookUrl(`${tp.url_origin}/`);
      if (!shaped.ok) {
        fail("TOOL_URL_UNSAFE", "pin.effect_staged", shaped.reason);
      } else {
        passed.push("the destination passes the structural safety check");
        let defOrigin = null;
        try {
          defOrigin = new URL(String(tool?.url || "").replace(/\{\{[^}]*\}\}/g, "x")).origin;
        } catch { defOrigin = null; }
        if (tool && defOrigin && tp.url_origin !== defOrigin) {
          fail("TOOL_DESTINATION_MISMATCH", "pin.effect_staged",
            "the staged destination is not the tool's own origin");
        } else if (tool && defOrigin) {
          passed.push("the destination is the tool's own origin");
        }
      }
    } else {
      fail("TOOL_URL_UNSAFE", "pin.effect_staged", "the staged call names no destination");
    }

    for (const hname of (Array.isArray(tp.header_names) ? tp.header_names : [])) {
      const lname = String(hname || "").toLowerCase();
      if (lname === "x-api-key" || isAllowedHeaderName(lname)
          || lname.startsWith("x-cognos-") || lname === "user-agent" || lname === "content-type") continue;
      fail("HEADER_NOT_ALLOWED", "pin.secrets_env_only", `header '${lname}' is not allowlisted`);
      break;
    }
    if (!failed.some((f) => f.rule === "HEADER_NOT_ALLOWED")) {
      passed.push("every header name is allowlisted");
    }

    const bodyChars = Number(tp.body_chars || 0);
    if (bodyChars > 32_768) {
      fail("BODY_TOO_LARGE", "pin.effect_staged", `${bodyChars} bytes > the 32768 byte cap`);
    } else {
      passed.push("the body is within the cap");
    }

    // Writes need Jeremy, one at a time, by exact effect id — the T5 story.
    // Reads run freely.
    if (tool && tp.method !== "GET") {
      let approval = null;
      let approvalError = false;
      if (typeof db?.EffectApproval?.current === "function") {
        try { approval = await db.EffectApproval.current(effect.id); }
        catch { approvalError = true; }
      }
      if (approvalError) {
        fail("APPROVAL_UNREADABLE", "pin.irreversible_human_approval");
      } else if (!approval) {
        fail("TOOL_WRITE_NEEDS_APPROVAL", "pin.irreversible_human_approval",
          "no human approval row names this exact effect id");
      } else {
        passed.push("a human approval row names this exact effect id");
      }
    } else if (tool) {
      passed.push("a read runs freely — no approval needed");
    }

    const refuse = failed.length > 0;
    return {
      decision: refuse ? "refuse" : "release",
      passed,
      failed,
      mode: effectiveMode,
      stagedMode: effect.mode || "shadow",
      tier,
      judgedAt: new Date(nowMs).toISOString(),
      law: refuse ? failed[0].law : "pin.effect_staged",
    };
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
  if (effect.effect_type === "external_read") {
    checkScopeBinding({ fail, passed }, {
      storedSha: payload.scopeSha256 || null,
      authorization, goal, scope, nowMs
    });
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
    checkScopeBinding({ fail, passed }, {
      storedSha: effect.scope_sha256 || payload.scopeSha256 || null,
      authorization, goal, scope, nowMs
    });

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
      fail("BODY_REQUIRED", "pin.effect_staged");
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
    if (insideQuietHours(config.quietHours, nowMs, config?.userTimeZone)) {
      const qh = config.quietHours || {};
      fail("QUIET_HOURS", "phase19.autonomy_default_off",
        `external deliveries are quiet between ${qh.startHour}:00 and ${qh.endHour}:00`);
    }

    // Live external writes: no earned corpus required (Phase 34). The checks
    // below are policy, not earning: the destination must be the deployment's
    // one approved live endpoint, and the scope grant above must cover it.
    // T5 does NOT walk an evidence gate either: its release authority is the
    // per-effect human approval below (pin.irreversible_human_approval).
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

      // Phase 34 — the earned requirement is gone (Jeremy: "86 that shit").
      // A live T4 release used to need a recorded shadow corpus justifying it;
      // now the capability is available and the trust model is ASK, not EARN:
      // the Governor's policy checks above, plus Jeremy's per-effect approval
      // in the outbox, are the gates. T5 never walked the evidence gate —
      // its release authority is the per-effect human approval below, unchanged.
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
    // A lookup error is its own rule, never "no approval".
    let approval = null;
    let approvalError = false;
    if (typeof db?.EffectApproval?.current === "function") {
      try {
        approval = await db.EffectApproval.current(effect.id);
      } catch { approvalError = true; }
    }
    if (approvalError) {
      fail("APPROVAL_UNREADABLE", "pin.irreversible_human_approval");
    } else if (!approval) {
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

  const spentToday = await workspaceSpendToday(db, goal?.workspace_id, nowMs, config?.userTimeZone);
  const dailyCeiling = Number(config?.ceiling?.maxDailyUsd);
  if (spentToday === null || !Number.isFinite(dailyCeiling)) {
    fail("SPEND_UNVERIFIABLE", "phase19.autonomy_default_off",
      spentToday === null ? "autonomy_ticks could not be read" : undefined);
  } else if (spentToday >= dailyCeiling) {
    fail("WORKSPACE_CEILING", "phase19.autonomy_default_off",
      `$${spentToday.toFixed(2)} of $${dailyCeiling.toFixed(2)} today`);
  } else {
    passed.push("workspace daily spend is under the ceiling");
  }

  // --- rate limits ---------------------------------------------------------
  const today = await goalEffectsToday(db, goal?.id, nowMs, config?.userTimeZone);
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
    const noticesTodayCount = await goalNoticesToday(db, goal?.id, nowMs, config?.userTimeZone);
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
