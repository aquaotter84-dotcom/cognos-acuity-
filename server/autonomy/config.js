// Autonomy configuration — Phase 19.
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Read a capability switch from the environment — ALLOW-LIST semantics.
 *
 * The obvious implementation (`value !== "false"`) is wrong for a switch that
 * grants a capability: it means every unrecognised value ENABLES, including the
 * empty string. An operator who types `COGNOS_AUTONOMY_ENABLED=` on a host —
 * the most likely misconfiguration there is — would turn durable autonomy on.
 *
 * So only explicit affirmatives enable. Anything else (`""`, "0", "maybe",
 * "TRUE-ish", "yes" in an unexpected case) is OFF, and `requestedEnabled` in
 * the config reports what was actually asked for so the mismatch is visible
 * rather than silent.
 */
const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);
const envFlag = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return TRUTHY.has(String(raw).trim().toLowerCase());
};

const envNum = (name, fallback, min, max) => {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

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
  const enabled = envFlag("COGNOS_AUTONOMY_ENABLED", false);   // default OFF
  return Object.freeze({
    // phase19.autonomy_default_off: building a rung is not the same as enabling one.
    // `defaultOff` is a constant, not a reading — the system's resting state is
    // frozen, and `enabled` is a departure from it that an operator has to make.
    enabled,
    defaultOff: true,
    requestedEnabled: process.env.COGNOS_AUTONOMY_ENABLED || "(unset → off)",
    enabledForcedOff: enabled === false,

    // Rung switches. Each rung needs its own explicit flag AND its evidence.
    rung: {
      residents: envFlag("COGNOS_AUTONOMY_RESIDENTS", false),
      externalWrites: envFlag("COGNOS_AUTONOMY_EXTERNAL_WRITES", false),
      irreversible: envFlag("COGNOS_AUTONOMY_IRREVERSIBLE", false),
      inbound: envFlag("COGNOS_INBOUND_ENABLED", false)
    },

    // Notice delivery. An object, not a boolean: "can this goal emit a notice
    // at all" and "where does a notice go" are different questions, and a
    // single flag conflating them meant the kill switch was checking a shape
    // the config never produced (so it could never fire).
    notices: (() => {
      const mode = ["none", "internal", "webhook"].includes(process.env.COGNOS_AUTONOMY_NOTICE_MODE)
        ? process.env.COGNOS_AUTONOMY_NOTICE_MODE
        : "none";                       // record only, surface nothing, until a rung is earned
      const webhook = String(process.env.COGNOS_AUTONOMY_NOTICE_WEBHOOK || "").trim() || null;
      return Object.freeze({
        mode,
        webhook,
        enabled: mode !== "none" && envFlag("COGNOS_AUTONOMY_NOTICES", true),
        // A webhook mode with no URL is a misconfiguration, not a silent no-op.
        misconfigured: mode === "webhook" && !webhook
      });
    })(),
    outboxMode: ["shadow", "dry_run", "live"].includes(process.env.COGNOS_AUTONOMY_OUTBOX_MODE)
      ? process.env.COGNOS_AUTONOMY_OUTBOX_MODE : "shadow",

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

    // Tiers available in this build. T3–T5 are declared but not built; the
    // skill registry refuses them and the Action Governor refuses them too.
    builtTiers: Object.freeze(["T0", "T1", "T2"])
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
  if (["T4", "T5"].includes(tier)) return false;    // Phases 21–22
  return true;
}
