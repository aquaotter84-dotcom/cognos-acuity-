// Autonomy configuration — Phase 19, with Phase 25's hybrid enablement.
//
// Every number is an EDITABLE CONSTANT here, following the convention in
// server/config.js: pricing and policy belong in code a reviewer can diff, not
// in an environment variable soup and not in a database row that a subsystem
// could rewrite.
//
// The ceilings are derived in AUTONOMY.md §4.10.1. The principle: hitting one
// should be ANNOYING, not harmful. The first thing that happens when a limit is
// reached is a parked goal and a templated notice — no loop continues, nothing
// is silently queued, and resuming takes a new authorization.
//
// The ONE exception to "no database row decides policy" is `enabled`, and it is
// bounded: Phase 25 lets an operator delegate the on/off switch to the UI
// (COGNOS_AUTONOMY_UI_CONTROL) and that delegation stores a boolean. It cannot
// store a rung, a ceiling, a skill or a budget — settings.js resolves the
// precedence and this file only reads the answer.

// Phase 25 — the enablement decision lives in settings.js so the pin, the
// delegation and the stored switch are resolved in exactly one place. envFlag
// is imported from there as well: two copies of "what counts as true" is how a
// kill switch and a feature flag end up disagreeing about the same variable.
import { envFlag, describeSettings, effectiveOutboxMode, outboxModeSource,
  OUTBOX_MODE_ENV } from "./settings.js";
// Reused rather than reimplemented: "what may a webhook URL look like" already
// has one authority, and a second copy of it here is how an approved
// destination ends up shaped differently from what the adapter would accept.
import { checkWebhookUrl } from "./webhookPost.js";
import { destinationAllowed } from "./scopeUrl.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const envNum = (name, fallback, min, max) => {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

/**
 * Where notices go — and how that answer was reached.
 *
 * Explicit `none` / `internal` / `webhook` always wins. Unset is NOT the same
 * as `none`: when autonomy is on, the in-app channel is the default so a first
 * authorized goal can actually report; when the loop is frozen, unset stays
 * silent. Distinguishing those two is why we read the raw env rather than
 * collapsing an empty value into `none`.
 */
export function resolveNotices(enabled) {
  const raw = process.env.COGNOS_AUTONOMY_NOTICE_MODE;
  const explicit = ["none", "internal", "webhook"].includes(raw);
  const mode = explicit ? raw : (enabled ? "internal" : "none");
  const modeSource = explicit ? "env" : (enabled ? "default-on" : "default-off");
  const webhook = String(process.env.COGNOS_AUTONOMY_NOTICE_WEBHOOK || "").trim() || null;
  return Object.freeze({
    mode,
    webhook,
    enabled: mode !== "none" && envFlag("COGNOS_AUTONOMY_NOTICES", true),
    misconfigured: mode === "webhook" && !webhook,
    modeSource
  });
}

/**
 * Phase 22 (autonomy row) — THE ONE APPROVED DESTINATION.
 *
 * A goal's scope grant answers "where did a human authorize THIS goal to act?".
 * That is necessary and it is not sufficient for a live delivery, because it is
 * per goal and there can be many of them. This is the deployment's answer to a
 * narrower question: "which single endpoint may this COGNOS actually send to,
 * right now?" It is one URL, it is set in the environment, and no request can
 * widen it.
 *
 * Both must hold for a live T4 release — the goal's grant AND this — so the
 * intersection is strictly narrower than either gate alone. Adding a gate that
 * can only refuse is the safe direction to be wrong in.
 *
 * Fail closed on every branch: unset means no live destination exists, so a
 * live delivery is refused and a flip to live is refused. A value that is not
 * a shape the adapter would accept (not https, credentials in the URL, a
 * literal IP, a local or reserved hostname, a port other than 443) is reported
 * `misconfigured` and behaves exactly like unset — a malformed brake is not a
 * brake that happens to allow everything.
 */
export const LIVE_DESTINATION_ENV = "COGNOS_AUTONOMY_LIVE_DESTINATION";

export function resolveLiveDestination() {
  const raw = String(process.env[LIVE_DESTINATION_ENV] || "").trim();
  if (!raw) {
    return Object.freeze({
      configured: false, misconfigured: false, requested: null,
      url: null, hostname: null, reason: null
    });
  }
  const checked = checkWebhookUrl(raw);
  if (!checked.ok) {
    return Object.freeze({
      configured: false, misconfigured: true, requested: raw.slice(0, 300),
      url: null, hostname: null, reason: checked.reason
    });
  }
  return Object.freeze({
    configured: true, misconfigured: false, requested: raw.slice(0, 300),
    // href with the fragment dropped, which is what checkWebhookUrl returns:
    // matching a delivery against it is exact-URL matching, so the stored form
    // has to be the normalized one rather than what the operator typed.
    url: checked.url.href,
    hostname: checked.hostname,
    reason: null
  });
}

/**
 * The PUBLIC shape of an approved destination: what a surface may say about it.
 *
 * resolveLiveDestination keeps the normalized URL because the matcher and the
 * adapter need it. No served object should carry it. Two reasons, and they are
 * different reasons:
 *
 *   - a status route is readable by anyone who can read this deployment's
 *     configuration, and resolveNotices already sets the precedent of naming a
 *     webhook channel without publishing its URL;
 *   - the audit row for a mode flip digests the destination for the same
 *     discipline (pin.receipt_metadata_only, applied to a configuration value).
 *
 * One function so the two surfaces that report it — /api/autonomy/status and
 * the readiness report on /api/autonomy/rungs — cannot drift apart, which is
 * how a "hostname only" comment ends up next to a route that publishes the
 * whole URL.
 */
export function describeLiveDestination(liveDestination) {
  const dest = liveDestination || {};
  return Object.freeze({
    configured: dest.configured === true,
    misconfigured: dest.misconfigured === true,
    hostname: dest.hostname || null,
    reason: dest.reason || null,
    env: LIVE_DESTINATION_ENV
  });
}

/**
 * Does an approved destination cover this delivery URL?
 *
 * Exact-URL or host-plus-path-prefix matching, through the SAME matcher the
 * goal's scope grant uses (scopeUrl.destinationAllowed). Two matchers for two
 * gates would drift, and a drift here widens a live delivery.
 */
export function liveDestinationCovers(liveDestination, candidate) {
  if (!liveDestination?.configured) {
    return { allowed: false, reason: liveDestination?.misconfigured
      ? `the approved destination is misconfigured (${liveDestination.reason})`
      : `no approved destination is set (${LIVE_DESTINATION_ENV} is unset)` };
  }
  if (typeof candidate !== "string" || !candidate.trim()) {
    return { allowed: false, reason: "the delivery names no destination URL" };
  }
  // One entry, matched with the scope matcher. The approved destination is a
  // single URL rather than a list on purpose: a list is how "one approved
  // destination" quietly becomes a class grant.
  return destinationAllowed(candidate, [liveDestination.url]);
}

/** Per-goal default budget. Overridable per goal — only downward, never above. */
export const DEFAULT_GOAL_BUDGET = Object.freeze({
  maxSteps: 500,                 // ~5 days of hourly 5-step slices for one goal
  maxModelCalls: 1_000,
  maxTokensIn: 5_000_000,        // ≈$0.75 at gpt-4o-mini
  maxTokensOut: 500_000,         // ≈$0.30
  maxCostUsd: 1.00,              // half the daily ceiling: one goal cannot eat the day
  maxWallClockMs: 14 * DAY_MS,   // a goal still running after two weeks needs re-authorization
  maxNoticesPerDay: 3,           // more than three a day is narration, not reporting
  maxExternalEffects: 25,        // lifetime; a webhook is a trigger, not a message
  maxEffectsPerDay: 10
});

/** Workspace-wide ceiling. Twenty residents may not outspend what you agreed to. */
export const WORKSPACE_CEILING = Object.freeze({
  maxDailyUsd: envNum("COGNOS_AUTONOMY_MAX_DAILY_USD", 2.00, 0, 10_000),
  maxMonthlyUsd: envNum("COGNOS_AUTONOMY_MAX_MONTHLY_USD", 25.00, 0, 100_000),
  // Daily catches the blowout. Monthly catches the slow leak — a small amount
  // repeated for thirty days, which a daily ceiling cannot see.
  maxActiveGoals: envNum("COGNOS_AUTONOMY_MAX_ACTIVE_GOALS", 10, 1, 200),
  maxGoalsPerTick: envNum("COGNOS_AUTONOMY_MAX_GOALS_PER_TICK", 3, 1, 25),
  maxNoticesPerDay: envNum("COGNOS_AUTONOMY_MAX_NOTICES_PER_DAY", 12, 1, 500)
});

/**
 * The shadow-mode gate, named BEFORE a corpus exists (AUTONOMY.md §4.10.1).
 * A count alone can be rationalised; a single false release cannot.
 */
export const SHADOW_GATE = Object.freeze({
  minShadowSamples: envNum("COGNOS_AUTONOMY_MIN_SHADOW_SAMPLES", 25, 1, 10_000),
  maxAcceptableFalseReleases: 0,      // zero tolerance — this is the real gate
  minRefusalPrecision: 1.0            // for T5, the gate is perfection or nothing
});

/**
 * spent.* -> budget.* mapping.
 *
 * The two sides deliberately do not share names: `spent.steps` is a count and
 * `budget.maxSteps` is a ceiling, and reading `SELECT spent, budget FROM
 * autonomy_goals` should make that obvious. But the mismatch means a naive
 * `for (const [key, limit] of Object.entries(budget))` compares "steps" against
 * "maxSteps", never matches, and reports headroom forever — a budget that can
 * never be exhausted is not a budget. Both the tick and the Action Governor
 * need this mapping, so it lives here once.
 */
export const SPEND_BUDGET_KEYS = Object.freeze({
  steps: "maxSteps",
  modelCalls: "maxModelCalls",
  tokensIn: "maxTokensIn",
  tokensOut: "maxTokensOut",
  costUsd: "maxCostUsd",
  notices: "maxNoticesPerDay",          // cumulative against a per-day cap: stricter, so it fails closed
  effects: "maxEffectsPerDay",
  externalEffects: "maxExternalEffects"
});

/**
 * The first budget line that is at or over its ceiling, or null.
 * Wall-clock is handled separately because it is a clock, not a counter.
 */
export function budgetLineExhausted(spent = {}, budget = {}, nowMs = Date.now()) {
  for (const [spendKey, budgetKey] of Object.entries(SPEND_BUDGET_KEYS)) {
    const limit = budget[budgetKey];
    if (typeof limit !== "number" || !Number.isFinite(limit)) continue;
    const used = Number(spent[spendKey] || 0);
    if (used >= limit) return { key: budgetKey, spendKey, used, limit };
  }
  // A goal still running after its wall-clock ceiling needs re-authorization,
  // not another slice.
  const wallClock = budget.maxWallClockMs;
  if (typeof wallClock === "number" && Number.isFinite(wallClock) && Number(spent.startedMs || 0) > 0) {
    if (nowMs - Number(spent.startedMs) >= wallClock) {
      return { key: "maxWallClockMs", spendKey: "startedMs", used: nowMs - Number(spent.startedMs), limit: wallClock };
    }
  }
  return null;
}

export function autonomyConfig() {
  // Phase 25 — `enabled` is the EFFECTIVE switch: an operator pin, or the
  // delegated value the UI stored, or false. `pinned` and `uiControl` are
  // reported alongside it because "is it on?" and "who decided?" are different
  // questions, and a status surface that only answers the first one cannot tell
  // an operator why the toggle in front of them is disabled.
  const settings = describeSettings();
  const enabled = settings.enabled;
  return Object.freeze({
    // phase19.autonomy_default_off: building a rung is not the same as enabling one.
    // `defaultOff` is a constant, not a reading — the system's resting state is
    // frozen, and `enabled` is a departure from it that an operator has to make.
    enabled,
    defaultOff: true,
    requestedEnabled: process.env.COGNOS_AUTONOMY_ENABLED || "(unset → off)",
    enabledForcedOff: enabled === false,
    // How the current value came about: 'env-pin' | 'ui' | 'default-off'.
    enabledSource: settings.source,
    pinned: settings.pinned,
    uiControl: settings.uiControl,
    canToggleFromUi: settings.canToggle,
    toggleRefusal: settings.refusal,
    settings,

    // Rung switches. Each rung needs its own explicit flag AND its evidence.
    rung: {
      residents: envFlag("COGNOS_AUTONOMY_RESIDENTS", false),
      // Rung 3, second half: T3 web.search. Distinct from residents because a
      // query goes to a third-party provider (a data flow to the outside),
      // while web.fetch stays governed by the per-goal URL allowlist.
      search: envFlag("COGNOS_AUTONOMY_SEARCH", false),
      externalWrites: envFlag("COGNOS_AUTONOMY_EXTERNAL_WRITES", false),
      irreversible: envFlag("COGNOS_AUTONOMY_IRREVERSIBLE", false),
      inbound: envFlag("COGNOS_INBOUND_ENABLED", false)
    },

    // Notice delivery. An object, not a boolean: "can this goal emit a notice
    // at all" and "where does a notice go" are different questions, and a
    // single flag conflating them meant the kill switch was checking a shape
    // the config never produced (so it could never fire).
    notices: resolveNotices(enabled),
    // Phase 22 (autonomy row) — the mode is a RESOLVED value now, not a raw
    // environment read: an operator pin, or the delegated row an earned flip
    // wrote, or the resting state. settings.js owns the precedence, so there is
    // exactly one place that decides what mode the outbox is in.
    outboxMode: effectiveOutboxMode(),
    outboxModeSource: outboxModeSource(),
    outboxModeEnv: OUTBOX_MODE_ENV,
    // The one endpoint a live T4 delivery may target. Reported as an object
    // rather than a boolean because "unset" and "set but malformed" need
    // different sentences, and both fail closed.
    liveDestination: resolveLiveDestination(),

    // Phase 21 — the webhook adapter's bounds. Every number here is a ceiling
    // on an OUTBOUND request the loop decided to make, so each is derived like
    // the budgets in §4.10.1 rather than chosen for convenience.
    webhook: Object.freeze({
      // §4.7.1: body <= 32 KiB. A trigger carries a fact, not a document.
      maxBodyBytes: envNum("COGNOS_WEBHOOK_MAX_BODY_BYTES", 32_768, 1, 32_768),
      // §4.7.1 default 8000ms: long enough for a real endpoint, short enough
      // that one hung receiver cannot eat a whole slice (tick.sliceMs is 120s).
      timeoutMs: envNum("COGNOS_WEBHOOK_TIMEOUT_MS", 8_000, 500, 30_000),
      // Two redirects, and every hop is re-resolved and re-checked. An outbound
      // URL is safeFetch's inbound SSRF problem seen in a mirror.
      maxRedirects: envNum("COGNOS_WEBHOOK_MAX_REDIRECTS", 2, 0, 2),
      // One retry, only on a retryable status, honouring Retry-After capped
      // here — the same discipline server/llm.js uses.
      maxRetryDelayMs: envNum("COGNOS_WEBHOOK_MAX_RETRY_DELAY_MS", 2_000, 0, 5_000),
      // Response bodies are digest-only; this caps how much is even read.
      maxResponseBytes: envNum("COGNOS_WEBHOOK_MAX_RESPONSE_BYTES", 65_536, 1_024, 262_144),
      digestBytes: 4_096,
      // https only. A webhook is a trigger, and a trigger in clear text is a
      // trigger anyone on the path can read and replay.
      schemes: Object.freeze(["https:"]),
      ports: Object.freeze(["443"]),
      retryStatuses: Object.freeze([429, 502, 503, 504])
    }),

    // Quiet hours apply to EXTERNAL deliveries only (T4+). A notice is the
    // record of why a goal stopped, and refusing to write it at 3am would hide
    // the very thing an operator needs to see in the morning.
    quietHours: (() => {
      const raw = String(process.env.COGNOS_AUTONOMY_QUIET_HOURS || "").trim();
      const match = raw.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
      if (!match) {
        return Object.freeze({ enabled: false, requested: raw || null, startHour: null, endHour: null,
          misconfigured: Boolean(raw) });
      }
      const startHour = Number(match[1]);
      const endHour = Number(match[2]);
      if (startHour > 23 || endHour > 23) {
        return Object.freeze({ enabled: false, requested: raw, startHour: null, endHour: null, misconfigured: true });
      }
      return Object.freeze({ enabled: true, requested: raw, startHour, endHour, misconfigured: false });
    })(),

    // The tick. sliceMs is the hard guarantee that one pathological goal cannot
    // occupy the loop, and that a SIGTERM always has a window to land in.
    tick: {
      intervalMs: envNum("COGNOS_AUTONOMY_HEARTBEAT_MS", 60_000, 5_000, 3_600_000),
      sliceMs: envNum("COGNOS_AUTONOMY_SLICE_MS", 120_000, 1_000, 900_000),
      maxStepsPerTick: envNum("COGNOS_AUTONOMY_MAX_STEPS_PER_TICK", 5, 1, 50),
      leaseMs: envNum("COGNOS_AUTONOMY_LEASE_MS", 180_000, 10_000, 3_600_000),
      jitterMs: envNum("COGNOS_AUTONOMY_JITTER_MS", 5_000, 0, 120_000),
      maxConsecutiveFailures: envNum("COGNOS_AUTONOMY_MAX_FAILURES", 3, 1, 25),
      stepBackoffMs: envNum("COGNOS_AUTONOMY_BACKOFF_MS", 60_000, 1_000, 3_600_000)
    },

    goalBudget: DEFAULT_GOAL_BUDGET,
    ceiling: { ...WORKSPACE_CEILING,
      // Same numbers, under the names the rest of the system and AUTONOMY.md
      // use. Duplicated rather than renamed so an existing reader keeps working.
      maxCostPerDayUsd: WORKSPACE_CEILING.maxDailyUsd,
      maxCostPerMonthUsd: WORKSPACE_CEILING.maxMonthlyUsd },
    shadow: SHADOW_GATE,

    // Tiers available in this build. Phase 20 added T3 (external READ).
    // Phase 21 adds T4 (external WRITE): one adapter, `webhook.post`, judged
    // per delivery against a destination allowlist granted at authorization,
    // and gated behind BOTH its rung flag and a recorded shadow-evidence row.
    // Phase 22 (autonomy row, second slice) adds T5 (IRREVERSIBLE): one
    // adapter, `post.publish`, switched off by default, and released only by a
    // per-effect human approval naming the exact outbox row — never by class,
    // and never by the loop itself (pin.irreversible_human_approval).
    builtTiers: Object.freeze(["T0", "T1", "T2", "T3", "T4", "T5"]),

    // Phase 20 — sub-agent bounds. The planner proposes its sub-budget in the
    // spawn arguments; these ceilings clamp it. A planner can ask for less
    // than these, never more — proposing bounds is not granting them.
    subagent: Object.freeze({
      maxSteps: envNum("COGNOS_SUBAGENT_MAX_STEPS", 5, 1, 10),
      maxModelCalls: envNum("COGNOS_SUBAGENT_MAX_MODEL_CALLS", 8, 1, 12),
      maxCostUsd: envNum("COGNOS_SUBAGENT_MAX_COST_USD", 0.10, 0.01, 0.25),
      maxTokensIn: envNum("COGNOS_SUBAGENT_MAX_TOKENS_IN", 200_000, 10_000, 1_000_000)
    })
  });
}

/**
 * Is a tier built and allowed? Used by the Action Governor as a first gate, so
 * "not built yet" and "not authorized" are both refusals with a recorded rule.
 */
export function tierAllowed(tier, config) {
  if (!config.builtTiers.includes(tier)) return false;
  const notices = config.notices ?? {};
  const noticesOff = notices.enabled === false || notices.mode === "none";
  if (tier === "T2" && noticesOff) return false;
  // A webhook notice channel with no URL configured is a misconfiguration; the
  // tier is not allowed until it is fixed, rather than failing open to nowhere.
  if (tier === "T2" && notices.misconfigured) return false;
  // Phase 21: T4 is BUILT, and still off. Building a rung is not enabling one
  // (phase19.autonomy_default_off) — the flag is the difference, and the
  // shadow-evidence gate inside the Governor is the second half.
  if (tier === "T4" && config.rung?.externalWrites !== true) return false;
  // Phase 22 (autonomy row): T5 is BUILT, and still off. The `irreversible`
  // rung is the operator's sign-off that the tier exists; it is necessary and
  // not sufficient — a release also needs a per-effect human approval.
  if (tier === "T5" && config.rung?.irreversible !== true) return false;
  return true;
}

/**
 * Inside the deployment's quiet hours? Applies to external deliveries only.
 * A window that wraps midnight (22-7) is the common case, so the comparison is
 * explicit about it rather than assuming start < end. An unconfigured or
 * misconfigured window is never active: quiet hours are a brake an operator
 * asks for, not one the system invents.
 */
export function insideQuietHours(quietHours, nowMs = Date.now()) {
  const qh = quietHours ?? {};
  if (qh.enabled !== true || qh.misconfigured === true) return false;
  const hour = new Date(nowMs).getHours();
  const start = Number(qh.startHour);
  const end = Number(qh.endHour);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start === end) return false;                 // an empty window is not a window
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}
