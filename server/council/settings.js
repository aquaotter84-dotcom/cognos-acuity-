// Delegated council switches (Critic, Governor) — Phase 26.
//
// The Critic and the Governor are safety mechanisms: the Critic scores and
// gates quality/epistemic claims, and the Governor is the deterministic final
// veto (empty text, secret leakage, minimum-cause floors, citation audits).
// They have existed as operator KILL SWITCHES since the council shipped:
// setting COGNOS_CRITIC_ENABLED=false or COGNOS_GOVERNOR_ENABLED=false turns
// one off. This module adds the user-friendly half — a UI toggle — on the same
// strict model the autonomy switch already uses:
//
//   COGNOS_GOVERNOR_ENABLED / COGNOS_CRITIC_ENABLED set in the environment
//       = a PIN. Operator-only, outranks everything, and the UI may not
//       override it (409). "false" pins OFF; any other explicit value pins ON,
//       exactly the kill-switch semantics the council has always used.
//   COGNOS_COUNCIL_UI_CONTROL=true
//       = a DELEGATION. It hands the two toggles to the UI. It changes nothing
//       by itself.
//   council_settings.governor_enabled / critic_enabled
//       = the delegated values, consulted ONLY when delegated and not pinned.
//
// The resting state is ON, not off, because these are brakes rather than
// powers: an unread or missing row reads as on, which is the fail-closed
// direction for a safety mechanism (the opposite of the autonomy switch, where
// an unread row reads off).
//
// WHY A CACHE. getSystemConfig() is synchronous and called from every turn, the
// identity route, and the answer prompt. The delegated values live in Postgres,
// so the row is read into a process-local cache, refreshed at boot, on the
// heartbeat, and write-through immediately after a flip. Before the first
// successful read, both effective values are ON (safe).
//
// This is a DESCRIPTION of an operator's switches, not a new authority. The
// laws are untouched: pin.governor_sovereign still forbids a MODEL or a
// subsystem from weakening or bypassing the Governor, and the Policy Engine
// still refuses a runtime adaptation that proposes to disable one. An operator
// turning a seat off from the UI is the same power the kill switches always
// held, now recorded and reversible.

import { envFlag } from "../autonomy/settings.js";

/** The delegation. Explicit affirmatives only. */
export const COUNCIL_UI_CONTROL_ENV = "COGNOS_COUNCIL_UI_CONTROL";

export const GOVERNOR_PIN_ENV = "COGNOS_GOVERNOR_ENABLED";
export const CRITIC_PIN_ENV = "COGNOS_CRITIC_ENABLED";

/**
 * Read a kill-switch pin. `null` = unset (not pinned). Otherwise a boolean,
 * with the council's original kill-switch semantics: only the literal string
 * "false" disables; every other explicit value enables.
 */
function pinTriState(name) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return null;
  return String(raw).trim().toLowerCase() !== "false";
}

const initialCache = () => ({
  loaded: false,           // has a read ever succeeded in this process?
  governorEnabled: true,   // resting state, and the value served until loaded
  criticEnabled: true,
  updatedBy: null,
  updatedAtMs: null,
  stale: false,
  error: null
});

let cache = initialCache();

/** Drop the cached row. Tests need this: the module is process-global. */
export function resetCouncilSettingsCache() {
  cache = initialCache();
  return councilSnapshot();
}

/** A copy of the cache. Callers cannot mutate the module's state. */
export function councilSnapshot() {
  return { ...cache };
}

/** An operator handed the switches to the API. */
export function councilUiControlDelegated() {
  return envFlag(COUNCIL_UI_CONTROL_ENV, false);
}

/** The effective Governor switch, applying precedence. */
export function effectiveGovernorEnabled() {
  const pin = pinTriState(GOVERNOR_PIN_ENV);
  if (pin !== null) return pin;                       // a pin outranks the UI
  if (!councilUiControlDelegated()) return true;      // no delegation: resting state
  return cache.loaded === true ? cache.governorEnabled === true : true;
}

/** The effective Critic switch, applying precedence. */
export function effectiveCriticEnabled() {
  const pin = pinTriState(CRITIC_PIN_ENV);
  if (pin !== null) return pin;
  if (!councilUiControlDelegated()) return true;
  return cache.loaded === true ? cache.criticEnabled === true : true;
}

/** Why the UI may not flip ONE switch, in words an operator can act on. */
function toggleRefusal(which) {
  const pinEnv = which === "governor" ? GOVERNOR_PIN_ENV : CRITIC_PIN_ENV;
  if (pinTriState(pinEnv) !== null) {
    return {
      code: "pinned_by_operator",
      message: `An operator pinned ${which === "governor" ? "the Governor" : "the Critic"} with ${pinEnv}, and the UI cannot override a pin. Remove that variable and restart to hand the switch back.`
    };
  }
  if (!councilUiControlDelegated()) {
    return {
      code: "not_delegated",
      message: `This deployment has not handed the council switches to the UI. Set ${COUNCIL_UI_CONTROL_ENV}=true and restart; until then ${which === "governor" ? "the Governor" : "the Critic"} is controlled only by ${pinEnv} and rests ON.`
    };
  }
  return null;
}

/**
 * The whole picture for a status surface — the three questions separately,
 * because they are three different questions: what is on, did an operator pin
 * it, and may the UI change it.
 */
export function describeCouncilSettings() {
  const governorPinned = pinTriState(GOVERNOR_PIN_ENV) !== null;
  const criticPinned = pinTriState(CRITIC_PIN_ENV) !== null;
  return Object.freeze({
    governorEnabled: effectiveGovernorEnabled(),
    criticEnabled: effectiveCriticEnabled(),
    governorPinned,
    criticPinned,
    uiControl: councilUiControlDelegated(),
    canToggleGovernor: toggleRefusal("governor") === null,
    canToggleCritic: toggleRefusal("critic") === null,
    governorRefusal: toggleRefusal("governor"),
    criticRefusal: toggleRefusal("critic"),
    governorPinEnv: GOVERNOR_PIN_ENV,
    criticPinEnv: CRITIC_PIN_ENV,
    uiControlEnv: COUNCIL_UI_CONTROL_ENV,
    note: governorPinned || criticPinned
      ? `An operator pinned one or both switches in the environment; those pins outrank this page.`
      : councilUiControlDelegated()
        ? "The switches are delegated to the UI. Every flip is recorded in the workspace audit."
        : `The switches rest ON and are not delegated to the UI. Set ${COUNCIL_UI_CONTROL_ENV}=true and restart to turn them on or off from here.`,
    stored: Object.freeze({
      loaded: cache.loaded,
      governorEnabled: cache.governorEnabled,
      criticEnabled: cache.criticEnabled,
      updatedBy: cache.updatedBy,
      updatedAtMs: cache.updatedAtMs,
      stale: cache.stale,
      error: cache.error
    })
  });
}

/**
 * Read the delegated row into the cache. A failure keeps the previous value
 * (so a transient blip cannot drop a running system) but cannot ENABLE a seat
 * an operator turned off: an unloaded cache reads ON, which is the safe
 * resting state and is reported as `stale` so a surface can say so.
 */
export async function refreshCouncilSettings(db, workspaceId = null) {
  try {
    const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
    const row = await db.CouncilSettings.get(wsId);
    cache = {
      loaded: true,
      governorEnabled: row ? row.governor_enabled === true : true,
      criticEnabled: row ? row.critic_enabled === true : true,
      updatedBy: row?.updated_by || null,
      updatedAtMs: row ? Number(row.updated_ms) || null : null,
      stale: false,
      error: null
    };
  } catch (error) {
    cache = { ...cache, stale: true, error: String(error?.message || error).slice(0, 200) };
  }
  return describeCouncilSettings();
}

/** Load once per process. Routes that must not read an unloaded cache await this. */
let loading = null;
export async function ensureCouncilSettingsLoaded(db, workspaceId = null) {
  if (cache.loaded) return describeCouncilSettings();
  if (!loading) {
    loading = refreshCouncilSettings(db, workspaceId).finally(() => { loading = null; });
  }
  return loading;
}

/**
 * Flip one switch. The only writer.
 *
 * Refusals are returned, not thrown — a pin the UI cannot override, and a
 * deployment that never delegated the switches. On success the cache is
 * updated write-through, so the response and any synchronous getSystemConfig()
 * call after it already see the new value.
 */
export async function setCouncilToggle(db, { which, enabled, workspaceId = null, updatedBy = "ui" } = {}) {
  if (!["governor", "critic"].includes(which)) {
    return { ok: false, error: "switch must be governor or critic", settings: describeCouncilSettings() };
  }
  const refusal = toggleRefusal(which);
  if (refusal) {
    return { ok: false, refusal, settings: describeCouncilSettings() };
  }
  const next = enabled === true;
  const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
  const previous = describeCouncilSettings();
  const atMs = Date.now();

  const row = await db.CouncilSettings.set({
    workspace_id: wsId,
    governorEnabled: which === "governor" ? next : null,
    criticEnabled: which === "critic" ? next : null,
    updated_by: updatedBy,
    updated_ms: atMs
  });

  cache = {
    loaded: true,
    governorEnabled: row ? row.governor_enabled === true : cache.governorEnabled,
    criticEnabled: row ? row.critic_enabled === true : cache.criticEnabled,
    updatedBy: row?.updated_by || updatedBy,
    updatedAtMs: row ? Number(row.updated_ms) || atMs : atMs,
    stale: false,
    error: null
  };

  try {
    await db.WorkspaceAudit.append({
      workspaceId: wsId,
      action: `council.${which}`,
      resourceId: null,
      detail: {
        from: which === "governor" ? previous.governorEnabled : previous.criticEnabled,
        to: next,
        via: "ui",
        updatedBy,
        pinned: which === "governor" ? previous.governorPinned : previous.criticPinned,
        uiControl: previous.uiControl
      },
      tsMs: atMs
    });
  } catch {
    // A failed audit row does not undo a switch the operator just flipped.
  }

  return { ok: true, which, previous, settings: describeCouncilSettings(), atMs };
}

/** The flips recorded for this workspace, newest first. Bounded. */
export async function listCouncilFlips(db, { workspaceId = null, limit = 20 } = {}) {
  try {
    const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
    const rows = await db.WorkspaceAudit.list({
      workspaceId: wsId, action: "council.governor",
      limit: Math.max(1, Math.min(100, Number(limit) || 20))
    });
    const criticRows = await db.WorkspaceAudit.list({
      workspaceId: wsId, action: "council.critic",
      limit: Math.max(1, Math.min(100, Number(limit) || 20))
    });
    const all = [...rows, ...criticRows].sort((a, b) => Number(b.ts_ms) - Number(a.ts_ms));
    return all.slice(0, Math.max(1, Math.min(100, Number(limit) || 20))).map(row => ({
      id: row.id,
      atMs: Number(row.ts_ms),
      which: String(row.action || "").startsWith("council.critic") ? "critic" : "governor",
      to: row.detail?.to === true,
      from: row.detail?.from === true,
      via: row.detail?.via || "ui",
      updatedBy: row.detail?.updatedBy || row.user_id || null
    }));
  } catch {
    return [];
  }
}
