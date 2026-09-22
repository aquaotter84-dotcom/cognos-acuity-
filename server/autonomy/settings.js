// Hybrid enablement — Phase 25.
//
// THE PROBLEM THIS SOLVES. Autonomy is off by default and the only way to turn
// it on is an environment variable plus a restart (phase19.autonomy_default_off).
// That is the right resting state and the wrong operator experience: the
// Autonomy page could show you a frozen system and give you nothing to do about
// it except the name of a variable you cannot set from a browser.
//
// THE MODEL. Two environment variables, one database row, and a strict
// precedence order:
//
//   COGNOS_AUTONOMY_ENABLED=true      a PIN. Operator-only, outranks everything,
//                                     and the UI may not override it. Trying to
//                                     is answered with a 409 that says so.
//   COGNOS_AUTONOMY_UI_CONTROL=true   a DELEGATION. It hands the on/off switch
//                                     to the UI. It does not turn anything on.
//   autonomy_settings.enabled         the delegated value. Consulted ONLY when
//                                     delegation is set and there is no pin.
//
// So delegation is what makes the toggle real, and the pin is what keeps an
// operator's explicit decision final. Neither variable can be changed from a
// request: this module reads the environment, never writes it.
//
// WHY A CACHE. autonomyConfig() is synchronous and is called from the tick, the
// Action Governor, the skill registry and a dozen routes. The delegated value
// lives in Postgres. Rather than make every one of those call sites async, the
// row is read into a process-local cache and the cache is refreshed at three
// points: boot (serve.js), every heartbeat beat, and immediately after a write
// (write-through, so the response to a flip already reflects it).
//
// FAIL CLOSED. Before the first successful read, `enabled` is false whatever the
// delegation says. An unread setting is not a permission. A failed read keeps the
// last known value rather than silently dropping a running system to frozen —
// that is the one place this module prefers continuity over freshness, and it is
// recorded in the snapshot as `stale` so a status surface can say so honestly.

/** The pin. Explicit affirmatives only — see envFlag. */
export const AUTONOMY_PIN_ENV = "COGNOS_AUTONOMY_ENABLED";
/** The delegation. Same allow-list semantics. */
export const AUTONOMY_UI_CONTROL_ENV = "COGNOS_AUTONOMY_UI_CONTROL";

/**
 * Phase 22 (autonomy row) — the outbox MODE switch, same shape as the two
 * above and deliberately a separate pair of variables.
 *
 * `COGNOS_AUTONOMY_OUTBOX_MODE` is the operator's explicit value: shadow,
 * dry_run or live. `COGNOS_AUTONOMY_OUTBOX_UI_CONTROL` hands the mode switch
 * to this process's API. They are not the same power as the enablement pair:
 * `COGNOS_AUTONOMY_UI_CONTROL` lets the UI decide whether the loop RUNS, and
 * this one lets it decide whether the loop may ACT ON THE WORLD. Delegating
 * the first must not delegate the second, so neither variable implies the
 * other.
 */
export const OUTBOX_MODE_ENV = "COGNOS_AUTONOMY_OUTBOX_MODE";
export const OUTBOX_UI_CONTROL_ENV = "COGNOS_AUTONOMY_OUTBOX_UI_CONTROL";

/**
 * Phase 26 — "forgo goal authorization", the same shape as the pairs above and
 * deliberately a third pair of variables. `COGNOS_AUTONOMY_AUTO_AUTHORIZE` is
 * the operator's explicit value (only explicit affirmatives enable);
 * `COGNOS_AUTONOMY_AUTO_AUTHORIZE_UI_CONTROL` hands the switch to the API.
 * Delegating the on/off switch — or the outbox mode — does NOT delegate this
 * one: it is a different power, and none of the three variables implies another.
 */
export const AUTO_AUTHORIZE_PIN_ENV = "COGNOS_AUTONOMY_AUTO_AUTHORIZE";
export const AUTO_AUTHORIZE_UI_CONTROL_ENV = "COGNOS_AUTONOMY_AUTO_AUTHORIZE_UI_CONTROL";

/**
 * Phase 28 — the EARNED-CORPUS BYPASS, the same shape as the pairs above and
 * deliberately a fourth pair. `COGNOS_AUTONOMY_BYPASS_EARNING` is the operator's
 * explicit value (only explicit affirmatives enable);
 * `COGNOS_AUTONOMY_BYPASS_EARNING_UI_CONTROL` hands the switch to the API.
 *
 * `COGNOS_AUTONOMY_BYPASS_EVIDENCE` is kept as a legacy alias for the pin: it
 * shipped as a second spelling of the same bypass, and an operator who set it
 * must keep the value they set.
 *
 * This is not the same power as any of the other three. Enablement decides
 * whether the loop RUNS; the outbox mode decides whether it may ACT ON THE
 * WORLD; auto-authorize decides whether a goal waits for its own consent click.
 * This one decides whether a live release must first EARN its way past the
 * shadow corpus. Delegating one must not delegate another, so none implies the
 * next.
 */
export const BYPASS_EARNING_PIN_ENV = "COGNOS_AUTONOMY_BYPASS_EARNING";
export const BYPASS_EARNING_LEGACY_ENV = "COGNOS_AUTONOMY_BYPASS_EVIDENCE";
export const BYPASS_EARNING_UI_CONTROL_ENV = "COGNOS_AUTONOMY_BYPASS_EARNING_UI_CONTROL";

/** The only three modes that exist, ordered by how far they reach. */
export const OUTBOX_MODES = Object.freeze(["shadow", "dry_run", "live"]);

/**
 * Reach into the world, as a rank. `shadow` judges and records; `dry_run`
 * judges, records, and builds the exact request without sending it; `live`
 * sends. The rank exists so precedence can be expressed as "the narrower of
 * the two wins" instead of as a table of cases.
 */
const MODE_RANK = Object.freeze({ shadow: 0, dry_run: 1, live: 2 });

const rankOf = (mode) => (Object.prototype.hasOwnProperty.call(MODE_RANK, mode) ? MODE_RANK[mode] : 0);

/**
 * Does moving from one mode to another reach FURTHER into the world? The one
 * question a guarded flip has to ask, exported so liveOutbox.js and the tests
 * ask it in the same terms instead of each keeping an ordering of their own.
 */
export function isWideningOutboxMode(from, to) {
  return rankOf(to) > rankOf(from);
}

/** An explicit, valid mode from the environment, or null when unset/invalid. */
export function envOutboxMode() {
  const raw = process.env[OUTBOX_MODE_ENV];
  if (raw === undefined) return null;
  const value = String(raw).trim();
  return OUTBOX_MODES.includes(value) ? value : null;
}

/** An operator handed the mode switch to this API. */
export function outboxModeDelegated() {
  return envFlag(OUTBOX_UI_CONTROL_ENV, false);
}

/**
 * Read a capability switch from the environment — ALLOW-LIST semantics.
 *
 * `value !== "false"` is wrong for a switch that grants a capability: every
 * unrecognised value would ENABLE, including the empty string. `COGNOS_AUTONOMY_ENABLED=`
 * is the most likely misconfiguration on a real host, and it must not turn
 * durable autonomy on. Only explicit affirmatives enable; everything else is
 * off. server/autonomy/config.js imports this rather than keeping its own copy,
 * so the pin and the delegation cannot drift apart in meaning.
 */
const TRUTHY = new Set(["1", "true", "yes", "on", "enabled"]);

export function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return TRUTHY.has(String(raw).trim().toLowerCase());
}

/** An operator pinned autonomy on in the environment. This outranks the UI. */
export function pinnedOn() {
  return envFlag(AUTONOMY_PIN_ENV, false);
}

/** An operator handed the on/off switch to the UI. */
export function uiControlDelegated() {
  return envFlag(AUTONOMY_UI_CONTROL_ENV, false);
}

/**
 * Phase 26 — a tri-state pin read: `null` when unset, otherwise a boolean.
 * Unlike the on/off pin (where any explicit value enables), auto-authorize is
 * an affirmative feature, so only explicit affirmatives pin ON; an explicit
 * "false" pins OFF, and an unset or empty value is not a pin at all.
 */
function affirmPin(name) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return null;
  return envFlag(name, false);
}

/** An operator pinned "forgo goal authorization" on or off in the environment. */
export function autoAuthorizePinned() {
  return affirmPin(AUTO_AUTHORIZE_PIN_ENV);
}

/** An operator handed the auto-authorize switch to the UI. */
export function autoAuthorizeDelegated() {
  return envFlag(AUTO_AUTHORIZE_UI_CONTROL_ENV, false);
}

/**
 * The effective auto-authorize value, applying precedence. Off is the resting
 * state: an unread row is not a permission. A pin outranks the UI in both
 * directions — an operator who pinned it on cannot be overridden off, and one
 * who pinned it off cannot be overridden on.
 */
export function effectiveAutoAuthorize() {
  const pinned = autoAuthorizePinned();
  if (pinned !== null) return pinned;
  if (!autoAuthorizeDelegated()) return false;
  return cache.loaded === true && cache.autoAuthorize === true;
}

/**
 * Why the API may or may not flip auto-authorize, in words an operator can act
 * on. The same two refusals as the on/off switch: a pin the UI cannot
 * override, and a deployment that never delegated the switch.
 */
export function autoAuthorizeRefusal() {
  if (autoAuthorizePinned() !== null) {
    return {
      code: "pinned_by_operator",
      message: `An operator pinned auto-authorize with ${AUTO_AUTHORIZE_PIN_ENV}, and the UI cannot override a pin. Remove that variable and restart to hand the switch back.`
    };
  }
  if (!autoAuthorizeDelegated()) {
    return {
      code: "not_delegated",
      message: `This deployment has not handed the auto-authorize switch to the UI. Set ${AUTO_AUTHORIZE_UI_CONTROL_ENV}=true and restart; until then a goal is created awaiting_authorization, and nothing changes without a human decision.`
    };
  }
  return null;
}

/**
 * Phase 28 — an operator pinned the earned-corpus bypass in the environment.
 * Tri-state, like auto-authorize: `null` when unset, otherwise a boolean. The
 * legacy spelling is consulted second so the current name wins if both are set.
 */
export function bypassEarningPinned() {
  const primary = affirmPin(BYPASS_EARNING_PIN_ENV);
  if (primary !== null) return primary;
  return affirmPin(BYPASS_EARNING_LEGACY_ENV);
}

/** An operator handed the earned-corpus bypass to the UI. */
export function bypassEarningDelegated() {
  return envFlag(BYPASS_EARNING_UI_CONTROL_ENV, false);
}

/**
 * The effective earned-corpus bypass, applying precedence. Off is the resting
 * state: an unread row is not a permission, so a database blip cannot silently
 * waive the corpus. A pin outranks the UI in both directions.
 *
 * What it waives is exactly one thing: the recorded shadow corpus a live T4
 * release would otherwise have to earn. It does NOT waive the rung flag, the
 * one approved destination, autonomy being on, quiet hours, or the per-effect
 * Governor — those are judged per effect and are unaffected by this switch.
 */
export function effectiveBypassEarning() {
  const pinned = bypassEarningPinned();
  if (pinned !== null) return pinned;
  if (!bypassEarningDelegated()) return false;
  return cache.loaded === true && cache.bypassEarning === true;
}

/**
 * Why the API may or may not flip the earned-corpus bypass, in words an operator
 * can act on. The same two refusals as the other three switches: a pin the UI
 * cannot override, and a deployment that never delegated the switch.
 */
export function bypassEarningRefusal() {
  if (bypassEarningPinned() !== null) {
    return {
      code: "pinned_by_operator",
      message: `An operator pinned the earned-corpus bypass with ${BYPASS_EARNING_PIN_ENV}, and the UI cannot override a pin. Remove that variable and restart to hand the switch back.`
    };
  }
  if (!bypassEarningDelegated()) {
    return {
      code: "not_delegated",
      message: `This deployment has not handed the earned-corpus bypass to the UI. Set ${BYPASS_EARNING_UI_CONTROL_ENV}=true and restart; until then a live release still has to earn its way past the shadow corpus.`
    };
  }
  return null;
}

/**
 * Phase 29 — THE RUNG SWITCHES, as one delegated group.
 *
 * A rung is the operator's sign-off that a tier EXISTS in this deployment
 * (phase19.autonomy_default_off: building a rung is not enabling one). Phase 19
 * read the five of them straight from the environment, so the sign-off that
 * decides whether T4 exists was invisible on the page that reports T4, and
 * moving it meant a Railway variable and a restart.
 *
 * ONE delegation for the group, not five. It is one power — "what may this
 * COGNOS reach for" — with five values, and five more environment variables
 * would be the same soup this change is removing. An operator who wants to hand
 * the page the ability to open a door is already making the larger decision.
 *
 * The five existing variables stay, as PINS, and they are tri-state now:
 * unset or empty is not a decision, an explicit affirmative pins ON, and any
 * other explicit value pins OFF. A pin outranks the stored row in both
 * directions, so an operator who set COGNOS_AUTONOMY_IRREVERSIBLE=false on the
 * host cannot have it turned on from a browser, and the refusal names the
 * variable. This is strictly stronger than the old read: with no delegation the
 * effective value is pin-or-false, which is what envFlag(name, false) already
 * returned for every set and unset value.
 *
 * What this does NOT delegate: the shadow corpus, the approved destination,
 * T5's per-effect human approval, or any Governor verdict. A rung is necessary
 * and not sufficient — the Governor still asks the other half per effect, and
 * nothing a request can write holds an answer to it.
 */
export const RUNG_UI_CONTROL_ENV = "COGNOS_AUTONOMY_RUNGS_UI_CONTROL";

/** The five rungs, in the order the tiers climb. Stable; the API validates against it. */
export const RUNG_KEYS = Object.freeze([
  "residents", "search", "externalWrites", "irreversible", "inbound"
]);

/** rung -> the environment variable that pins it. The inbound rung keeps its
 *  original name (COGNOS_INBOUND_ENABLED); renaming a live variable to tidy a
 *  prefix would silently unset a deployment's existing sign-off. */
export const RUNG_PIN_ENVS = Object.freeze({
  residents: "COGNOS_AUTONOMY_RESIDENTS",
  search: "COGNOS_AUTONOMY_SEARCH",
  externalWrites: "COGNOS_AUTONOMY_EXTERNAL_WRITES",
  irreversible: "COGNOS_AUTONOMY_IRREVERSIBLE",
  inbound: "COGNOS_INBOUND_ENABLED"
});

/** rung -> the column that stores it. The store builds its SQL from this map,
 *  never from request text, and the map is the only place the two sides meet. */
export const RUNG_COLUMNS = Object.freeze({
  residents: "rung_residents",
  search: "rung_search",
  externalWrites: "rung_external_writes",
  irreversible: "rung_irreversible",
  inbound: "rung_inbound"
});

/** Is this a rung we know? Anything else is not a switch, and is refused. */
export function isRungKey(key) {
  return RUNG_KEYS.includes(String(key || ""));
}

/** The tri-state pin for one rung: null when unset, otherwise a boolean. */
export function rungPinned(key) {
  const env = RUNG_PIN_ENVS[key];
  return env ? affirmPin(env) : null;
}

/** An operator handed the rung group to the API. */
export function rungsDelegated() {
  return envFlag(RUNG_UI_CONTROL_ENV, false);
}

/**
 * The effective value of one rung, applying precedence. Off is the resting
 * state: an unread row is not a permission, so a database blip cannot open a
 * tier. A pin outranks the row in both directions.
 *
 * An unknown key is OFF rather than an error here — this is the read path the
 * Governor calls on every effect, and a typo must not widen a deployment.
 * The WRITE path is where an unknown key is refused, loudly.
 */
export function effectiveRung(key) {
  if (!isRungKey(key)) return false;
  const pinned = rungPinned(key);
  if (pinned !== null) return pinned;
  if (!rungsDelegated()) return false;
  return cache.loaded === true && cache.rungs?.[key] === true;
}

/** Every rung, resolved. The shape config.rung has always had. */
export function effectiveRungs() {
  const out = {};
  for (const key of RUNG_KEYS) out[key] = effectiveRung(key);
  return out;
}

/**
 * Why the API may or may not flip one rung, in words an operator can act on.
 * Three refusals, and they are different problems: an unknown rung is not a
 * switch at all, a pin is an operator decision the page cannot override, and
 * no delegation means this deployment never handed the group over.
 */
export function rungRefusal(key) {
  if (!isRungKey(key)) {
    return {
      code: "unknown_rung",
      message: `"${String(key).slice(0, 40)}" is not a rung. Known rungs: ${RUNG_KEYS.join(", ")}.`
    };
  }
  const env = RUNG_PIN_ENVS[key];
  if (rungPinned(key) !== null) {
    return {
      code: "pinned_by_operator",
      message: `An operator pinned the ${key} rung with ${env}, and the page cannot override a pin. Remove that variable and restart to hand the switch back.`
    };
  }
  if (!rungsDelegated()) {
    return {
      code: "not_delegated",
      message: `This deployment has not handed the rung switches to the page. Set ${RUNG_UI_CONTROL_ENV}=true and restart; until then the rungs are controlled only by their own variables (${RUNG_KEYS.map(k => RUNG_PIN_ENVS[k]).join(", ")}).`
    };
  }
  return null;
}

const initialCache = () => ({
  loaded: false,          // has a read ever succeeded in this process?
  enabled: false,         // the delegated value; false until loaded
  outboxMode: null,       // the delegated mode; null means "never flipped here"
  autoAuthorize: false,   // the delegated "forgo goal authorization" value
  bypassEarning: false,   // the delegated "skip the earned corpus" value
  rungs: {},              // rung -> the delegated sign-off; absent reads as off
  source: "default",      // what last wrote it: 'ui' | 'boot' | 'default'
  updatedBy: null,
  updatedAtMs: null,
  stale: false,           // last read failed; this is the previous value
  error: null
});

let cache = initialCache();

/**
 * Drop the cached row. Tests need this: the module is process-global, so a
 * second harness in one process would otherwise inherit the first one's
 * switch and the environment that went with it.
 */
export function resetSettingsCache() {
  cache = initialCache();
  return settingsSnapshot();
}

/** A copy of the cache. Cheap, and callers cannot mutate the module's state. */
export function settingsSnapshot() {
  return { ...cache };
}

/**
 * The effective on/off, applying the precedence order. This is the single
 * function autonomyConfig() asks, so there is exactly one place where "is
 * autonomy on?" is decided.
 */
export function effectiveEnabled() {
  if (pinnedOn()) return true;              // a pin outranks the UI, always
  if (!uiControlDelegated()) return false;  // no delegation: the environment decides
  return cache.loaded === true && cache.enabled === true;
}

/**
 * The effective outbox mode, applying precedence.
 *
 * The rule is one sentence: **an operator's environment value may hold the
 * system DOWN, and a delegated row may hold it down further, but nothing here
 * can hold the system OUT.** So the answer is the narrower of the two, with
 * one deliberate asymmetry — an environment pin of `live` is still brakeable
 * by a stored `shadow`, because a brake an operator cannot reach from the
 * running system is not a brake. Every other pin is final.
 *
 * Cases, in the order they resolve:
 *   env unset,  row null   -> shadow    the resting state; absence is OFF
 *   env unset,  row live   -> live      an earned, delegated flip
 *   env shadow, row live   -> shadow    a pin down is final
 *   env live,   row null   -> live      the Phase 21 behaviour, unchanged
 *   env live,   row shadow -> shadow    the brake still reaches a pinned-live
 *
 * Note what this function does NOT check: the evidence gate, the rung flag and
 * the approved destination. Those are judged per effect by the Action Governor
 * and at flip time by liveOutbox.js. A mode of `live` here means "releases are
 * performed", not "releases are allowed" — the Governor still refuses each one
 * that has not earned it, which is why an unearned `live` fails closed rather
 * than failing open.
 */
export function effectiveOutboxMode() {
  const env = envOutboxMode();
  const stored = cache.loaded === true && OUTBOX_MODES.includes(cache.outboxMode)
    ? cache.outboxMode : null;
  if (env === null) return stored ?? "shadow";
  if (stored !== null && rankOf(stored) < rankOf(env)) return stored;
  return env;
}

/** Where the current mode came from — 'env-pin' | 'ui' | 'default-off'. */
export function outboxModeSource() {
  const env = envOutboxMode();
  const effective = effectiveOutboxMode();
  if (env !== null && env === effective) return "env-pin";
  if (cache.loaded === true && cache.outboxMode === effective) return "ui";
  return "default-off";
}

/**
 * Why the API may or may not flip the mode, in words an operator can act on.
 *
 * This is the SYNCHRONOUS half — delegation and pins. Whether a widening to
 * `live` has been EARNED is database state, so liveOutbox.js answers that half
 * and merges its refusal with this one. Narrowing is never refused here: a
 * delegation is required to write the row at all, but once the row exists the
 * brake is unconditional.
 */
export function outboxModeRefusal() {
  if (outboxModeDelegated()) return null;
  const env = envOutboxMode();
  return {
    code: "not_delegated",
    message: `This deployment has not handed the outbox mode to the API. Set ${OUTBOX_UI_CONTROL_ENV}=true and restart; `
      + (env === null
        ? `until then the mode is controlled only by ${OUTBOX_MODE_ENV}, and it rests at shadow.`
        : `until then the mode stays pinned by ${OUTBOX_MODE_ENV}=${env}.`)
  };
}

/** Why the UI may or may not use the switch, in words a person can act on. */
function toggleRefusal() {
  if (pinnedOn()) {
    return {
      code: "pinned_by_operator",
      message: `An operator pinned autonomy on with ${AUTONOMY_PIN_ENV}=true, and the UI cannot override a pin. `
        + `Remove that variable and restart to hand the switch back.`
    };
  }
  if (!uiControlDelegated()) {
    return {
      code: "not_delegated",
      message: `This deployment has not handed the switch to the UI. Set ${AUTONOMY_UI_CONTROL_ENV}=true and restart; `
        + `until then autonomy is controlled only by ${AUTONOMY_PIN_ENV}.`
    };
  }
  return null;
}

/**
 * The whole picture, for a status surface. Reports the three questions
 * separately, because they are three different questions:
 *   enabled    — is autonomy running right now?
 *   pinned     — did an operator force that in the environment?
 *   canToggle  — may the UI change it?
 */
export function describeSettings() {
  const pinned = pinnedOn();
  const uiControl = uiControlDelegated();
  const enabled = effectiveEnabled();
  // `source` answers "where did the current value come from", and it must not
  // claim the UI decided something the UI never wrote. With delegation but no
  // stored row yet, the value is still the default-off resting state — saying
  // "ui" there would imply an operator had already used the switch.
  const storedByUi = uiControl && cache.loaded === true && cache.source === "ui";
  const source = pinned ? "env-pin" : (storedByUi ? "ui" : "default-off");
  const refusal = toggleRefusal();
  const outboxRefusal = outboxModeRefusal();
  return Object.freeze({
    enabled,
    pinned,
    uiControl,
    source,
    canToggle: refusal === null,
    refusal,
    pinEnv: AUTONOMY_PIN_ENV,
    uiControlEnv: AUTONOMY_UI_CONTROL_ENV,
    // Phase 22 (autonomy row) — the outbox mode, reported as its own set of
    // facts. "What mode is the outbox in" and "may this API change it" are
    // different questions again, and a surface that answers only the first
    // cannot tell an operator why the control in front of them is disabled.
    outboxMode: effectiveOutboxMode(),
    outboxModeSource: outboxModeSource(),
    outboxModeDelegated: outboxModeDelegated(),
    canSetOutboxMode: outboxRefusal === null,
    outboxRefusal,
    outboxModeEnv: OUTBOX_MODE_ENV,
    outboxUiControlEnv: OUTBOX_UI_CONTROL_ENV,
    // Phase 26 — "forgo goal authorization", reported as its own set of facts
    // again: is it on, did an operator pin it, and may the UI change it.
    autoAuthorize: effectiveAutoAuthorize(),
    autoAuthorizePinned: autoAuthorizePinned() !== null,
    autoAuthorizeDelegated: autoAuthorizeDelegated(),
    canSetAutoAuthorize: autoAuthorizeRefusal() === null,
    autoAuthorizeRefusal: autoAuthorizeRefusal(),
    autoAuthorizePinEnv: AUTO_AUTHORIZE_PIN_ENV,
    autoAuthorizeUiControlEnv: AUTO_AUTHORIZE_UI_CONTROL_ENV,
    // Phase 28 — the earned-corpus bypass, reported as its own set of facts
    // again. "Is the corpus still required?" and "may this API change that?"
    // are different questions, and a surface that answers only the first cannot
    // tell an operator why the control in front of them is disabled.
    bypassEarning: effectiveBypassEarning(),
    bypassEarningPinned: bypassEarningPinned() !== null,
    bypassEarningDelegated: bypassEarningDelegated(),
    canSetBypassEarning: bypassEarningRefusal() === null,
    bypassEarningRefusal: bypassEarningRefusal(),
    bypassEarningPinEnv: BYPASS_EARNING_PIN_ENV,
    bypassEarningUiControlEnv: BYPASS_EARNING_UI_CONTROL_ENV,
    // Phase 29 — the rung switches, reported as their own set of facts again.
    // Five values, one delegation, and per-rung pins, because "is the external
    // -writes rung on" and "may this page change it" are different questions
    // and a surface that answers only the first cannot explain a dead toggle.
    rungs: Object.freeze(effectiveRungs()),
    rungPinned: Object.freeze(Object.fromEntries(RUNG_KEYS.map(k => [k, rungPinned(k) !== null]))),
    rungDelegated: rungsDelegated(),
    canSetRungs: rungsDelegated(),
    rungRefusals: Object.freeze(Object.fromEntries(RUNG_KEYS.map(k => [k, rungRefusal(k)]))),
    rungPinEnvs: RUNG_PIN_ENVS,
    rungUiControlEnv: RUNG_UI_CONTROL_ENV,
    stored: Object.freeze({
      loaded: cache.loaded,
      enabled: cache.enabled,
      outboxMode: cache.outboxMode,
      autoAuthorize: cache.autoAuthorize,
      bypassEarning: cache.bypassEarning,
      rungs: Object.freeze({ ...(cache.rungs || {}) }),
      source: cache.source,
      updatedBy: cache.updatedBy,
      updatedAtMs: cache.updatedAtMs,
      stale: cache.stale,
      error: cache.error
    })
  });
}

/**
 * Read the delegated row into the cache. Safe to call often: it is one indexed
 * single-row SELECT. A failure is recorded and the previous value is kept, so a
 * transient database blip cannot silently freeze a running system — but it also
 * cannot silently ENABLE one, because an unloaded cache reads false.
 */
export async function refreshSettings(db, workspaceId = null) {
  try {
    const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
    const row = await db.AutonomySettings.get(wsId);
    cache = {
      loaded: true,
      enabled: row?.enabled === true,
      outboxMode: normalizeStoredMode(row?.outbox_mode),
      autoAuthorize: row?.auto_authorize_goals === true,
      bypassEarning: row?.bypass_earning === true,
      rungs: readStoredRungs(row),
      source: row ? String(row.source || "ui") : "default",
      updatedBy: row?.updated_by || null,
      updatedAtMs: row ? Number(row.updated_ms) || null : null,
      stale: false,
      error: null
    };
  } catch (error) {
    cache = { ...cache, stale: true, error: String(error?.message || error).slice(0, 200) };
  }
  return describeSettings();
}

/**
 * A stored mode is only believed if it is one of the three. Anything else —
 * a column written by an older build, a hand-edited row, a truncated string —
 * reads as null, which resolves to the resting state. An unrecognised value is
 * not a permission.
 */
function normalizeStoredMode(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return OUTBOX_MODES.includes(text) ? text : null;
}

/**
 * Read the five rung columns into a plain object. A stored value is only
 * believed when it is exactly true or exactly false; anything else (null, a
 * column an older build never wrote, a hand-edited row) reads as absent, which
 * resolves to off. An unrecognised value is not a permission.
 */
function readStoredRungs(row) {
  const out = {};
  for (const key of RUNG_KEYS) {
    const value = row?.[RUNG_COLUMNS[key]];
    out[key] = value === true ? true : value === false ? false : null;
  }
  return out;
}

/**
 * Write-through for the mode cache. liveOutbox.js calls this immediately after
 * committing a row, so the response to a flip — and every synchronous
 * autonomyConfig() call after it — already sees the new mode. Reading the row
 * back instead would race the write on a replica and report the state before
 * the click, which is the same reason setSettingsEnabled writes through.
 *
 * This is a cache setter and nothing more: it holds no policy, because the
 * policy that decided whether the write was allowed has already run.
 */
export function applyOutboxModeCache(outboxMode, { updatedBy = null, updatedAtMs = null } = {}) {
  cache = {
    ...cache,
    loaded: true,
    outboxMode: normalizeStoredMode(outboxMode),
    updatedBy: updatedBy ?? cache.updatedBy,
    updatedAtMs: updatedAtMs ?? cache.updatedAtMs
  };
  return describeSettings();
}

/** Load once per process. Routes that must not read an unloaded cache await this. */
let loading = null;
export async function ensureSettingsLoaded(db, workspaceId = null) {
  if (cache.loaded) return describeSettings();
  // Coalesce concurrent first reads: three parallel requests should not issue
  // three SELECTs, and none of them should see a half-written cache.
  if (!loading) {
    loading = refreshSettings(db, workspaceId).finally(() => { loading = null; });
  }
  return loading;
}

/**
 * Flip the delegated switch. The only writer.
 *
 * Refusals are returned, not thrown, and they are the two cases where acting
 * would be dishonest: a pin the UI cannot override, and a deployment that never
 * delegated the switch at all. Both are 409s at the route.
 *
 * On success the cache is updated BEFORE this returns (write-through), so the
 * response to the flip, and any synchronous autonomyConfig() call after it,
 * already see the new value. Reading the row back instead would race the write
 * on a replica and report the state before the click.
 */
export async function setSettingsEnabled(db, { enabled, workspaceId = null, updatedBy = "ui" } = {}) {
  const refusal = toggleRefusal();
  if (refusal) {
    return { ok: false, refusal, settings: describeSettings() };
  }
  const next = enabled === true;
  const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
  const previous = describeSettings();
  const atMs = Date.now();

  const row = await db.AutonomySettings.set({
    workspace_id: wsId, enabled: next, source: "ui", updated_by: updatedBy, updated_ms: atMs
  });

  // Write-through: the value we just committed is the value we now serve.
  // Spread first: this writer owns `enabled` and must not drop the other three
  // delegated values the row also carries. Replacing the object here would make
  // an enable/disable flip silently forget the mode, auto-authorize and the
  // bypass until the next refresh read them back.
  cache = {
    ...cache,
    loaded: true,
    enabled: row?.enabled === true,
    source: row ? String(row.source || "ui") : "ui",
    updatedBy: row?.updated_by || updatedBy,
    updatedAtMs: row ? Number(row.updated_ms) || atMs : atMs,
    stale: false,
    error: null
  };

  // The audit trail. Append-only, in the same table Phase 24 already uses for
  // workspace mutations, with both values so the row reads as a transition.
  try {
    await db.WorkspaceAudit.append({
      workspaceId: wsId,
      action: "autonomy.enabled",
      resourceId: null,
      detail: {
        from: previous.enabled,
        to: next,
        via: "ui",
        updatedBy,
        pinned: previous.pinned,
        uiControl: previous.uiControl,
        previousSource: previous.stored?.source || null
      },
      tsMs: atMs
    });
  } catch {
    // A failed audit row does not undo a switch the operator just flipped, and
    // pretending otherwise would be worse than the gap. The flip is still
    // visible in autonomy_settings.updated_ms/updated_by.
  }

  return { ok: true, refusal: null, previous, settings: describeSettings(), atMs };
}

/**
 * Flip the auto-authorize switch — Phase 26. The third writer on the same row,
 * with the same two refusals and the same write-through. Off is the resting
 * state, so the only direction that needs care is ON: it removes the goal
 * consent click and nothing else, and it is recorded as its own audit action.
 */
export async function setAutoAuthorize(db, { enabled, workspaceId = null, updatedBy = "ui" } = {}) {
  const refusal = autoAuthorizeRefusal();
  if (refusal) {
    return { ok: false, refusal, settings: describeSettings() };
  }
  const next = enabled === true;
  const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
  const previous = describeSettings();
  const atMs = Date.now();

  const row = await db.AutonomySettings.setAutoAuthorizeGoals({
    workspace_id: wsId, auto_authorize: next, updated_by: updatedBy, updated_ms: atMs
  });

  cache = {
    ...cache,
    loaded: true,
    autoAuthorize: row ? row.auto_authorize_goals === true : next,
    updatedBy: row?.updated_by || updatedBy,
    updatedAtMs: row ? Number(row.updated_ms) || atMs : atMs,
    stale: false,
    error: null
  };

  try {
    await db.WorkspaceAudit.append({
      workspaceId: wsId,
      action: "autonomy.auto_authorize",
      resourceId: null,
      detail: {
        from: previous.autoAuthorize === true,
        to: next,
        via: "ui",
        updatedBy,
        pinned: previous.autoAuthorizePinned === true,
        delegated: previous.autoAuthorizeDelegated === true
      },
      tsMs: atMs
    });
  } catch {
    // A failed audit row does not undo a switch the operator just flipped.
  }

  return { ok: true, refusal: null, previous, settings: describeSettings(), atMs };
}

/**
 * Flip the earned-corpus bypass — Phase 28. The fourth writer on the same row,
 * with the same two refusals and the same write-through. Off is the resting
 * state, so the only direction that needs care is ON: it removes the recorded
 * shadow corpus a live T4 release would otherwise have to earn, and nothing
 * else. The rung flag, the approved destination, the per-effect Governor and
 * T5's per-effect human approval all still bind, which is why this is recorded
 * as its own audit action rather than as a mode flip.
 */
export async function setBypassEarning(db, { enabled, workspaceId = null, updatedBy = "ui" } = {}) {
  const refusal = bypassEarningRefusal();
  if (refusal) {
    return { ok: false, refusal, settings: describeSettings() };
  }
  const next = enabled === true;
  const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
  const previous = describeSettings();
  const atMs = Date.now();

  const row = await db.AutonomySettings.setBypassEarning({
    workspace_id: wsId, bypass_earning: next, updated_by: updatedBy, updated_ms: atMs
  });

  cache = {
    ...cache,
    loaded: true,
    bypassEarning: row ? row.bypass_earning === true : next,
    updatedBy: row?.updated_by || updatedBy,
    updatedAtMs: row ? Number(row.updated_ms) || atMs : atMs,
    stale: false,
    error: null
  };

  try {
    await db.WorkspaceAudit.append({
      workspaceId: wsId,
      action: "autonomy.bypass_earning",
      resourceId: null,
      detail: {
        from: previous.bypassEarning === true,
        to: next,
        via: "ui",
        updatedBy,
        pinned: previous.bypassEarningPinned === true,
        delegated: previous.bypassEarningDelegated === true
      },
      tsMs: atMs
    });
  } catch {
    // A failed audit row does not undo a switch the operator just flipped.
  }

  return { ok: true, refusal: null, previous, settings: describeSettings(), atMs };
}

/**
 * Flip ONE rung — Phase 29. The fifth writer on the same row, and like the four
 * before it it touches exactly the column it owns: flipping the external-writes
 * rung must not touch `enabled`, the mode, auto-authorize, the bypass, or the
 * other four rungs. That is why the columns are five booleans rather than one
 * object.
 *
 * ON is the direction that needs care. It is the operator's sign-off that a
 * tier EXISTS here, and it is necessary and not sufficient: the Governor still
 * refuses every effect that has not earned its way past the shadow corpus, the
 * one approved destination still has to cover the delivery, and T5 still
 * releases only by a per-effect human approval. So a rung flip is recorded as
 * its own audit action rather than folded into enablement.
 *
 * An unknown rung key is refused before anything is written — the read path
 * treats a typo as off, and the write path must not treat it as a switch.
 */
export async function setRung(db, { rung, enabled, workspaceId = null, updatedBy = "ui" } = {}) {
  const refusal = rungRefusal(rung);
  if (refusal) {
    return { ok: false, refusal, settings: describeSettings() };
  }
  const key = String(rung);
  const next = enabled === true;
  const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
  const previous = describeSettings();
  const atMs = Date.now();

  const row = await db.AutonomySettings.setRung({
    workspace_id: wsId, rung: key, rung_enabled: next, updated_by: updatedBy, updated_ms: atMs
  });

  // Write-through: the value we just committed is the value we now serve, and
  // spread first so a rung flip never drops the other four delegated values the
  // row also carries.
  const storedValue = row?.[RUNG_COLUMNS[key]];
  cache = {
    ...cache,
    loaded: true,
    rungs: { ...(cache.rungs || {}), [key]: storedValue === true ? true : storedValue === false ? false : next },
    updatedBy: row?.updated_by || updatedBy,
    updatedAtMs: row ? Number(row.updated_ms) || atMs : atMs,
    stale: false,
    error: null
  };

  try {
    await db.WorkspaceAudit.append({
      workspaceId: wsId,
      action: "autonomy.rung",
      resourceId: key,
      detail: {
        rung: key,
        from: previous.rungs?.[key] === true,
        to: next,
        via: "ui",
        updatedBy,
        pinned: previous.rungPinned?.[key] === true,
        delegated: previous.rungDelegated === true
      },
      tsMs: atMs
    });
  } catch {
    // A failed audit row does not undo a switch the operator just flipped.
  }

  return { ok: true, refusal: null, previous, settings: describeSettings(), atMs };
}

/** The flips recorded for this workspace, newest first. Bounded. */
export async function listSettingFlips(db, { workspaceId = null, limit = 20 } = {}) {
  try {
    const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
    const rows = await db.WorkspaceAudit.list({
      workspaceId: wsId, action: "autonomy.enabled",
      limit: Math.max(1, Math.min(100, Number(limit) || 20))
    });
    return rows.map(row => ({
      id: row.id,
      atMs: Number(row.ts_ms),
      enabled: row.detail?.to === true,
      from: row.detail?.from === true,
      via: row.detail?.via || "ui",
      updatedBy: row.detail?.updatedBy || row.user_id || null
    }));
  } catch {
    return [];
  }
}
