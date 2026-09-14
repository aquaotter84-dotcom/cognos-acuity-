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

const initialCache = () => ({
  loaded: false,          // has a read ever succeeded in this process?
  enabled: false,         // the delegated value; false until loaded
  outboxMode: null,       // the delegated mode; null means "never flipped here"
  autoAuthorize: false,   // the delegated "forgo goal authorization" value
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
    stored: Object.freeze({
      loaded: cache.loaded,
      enabled: cache.enabled,
      outboxMode: cache.outboxMode,
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
  cache = {
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
