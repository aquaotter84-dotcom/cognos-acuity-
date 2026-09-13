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

const initialCache = () => ({
  loaded: false,          // has a read ever succeeded in this process?
  enabled: false,         // the delegated value; false until loaded
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
  return Object.freeze({
    enabled,
    pinned,
    uiControl,
    source,
    canToggle: refusal === null,
    refusal,
    pinEnv: AUTONOMY_PIN_ENV,
    uiControlEnv: AUTONOMY_UI_CONTROL_ENV,
    stored: Object.freeze({
      loaded: cache.loaded,
      enabled: cache.enabled,
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
