// On-device switch delegation files.
//
// The Autonomy page's switches are dead until an operator hands them over via
// one of five *_UI_CONTROL environment variables (server/autonomy/settings.js),
// and the Settings → Governance page's Critic/Governor switches are dead until
// an operator hands them over via COGNOS_COUNCIL_UI_CONTROL
// (server/council/settings.js). On a phone there is no operator shell, so the
// APK boot (mobile/entry.mjs) reads these files from the data dir instead: a
// file whose trimmed content is exactly "true" sets the matching variable. An
// env var that is already set keeps winning — a real operator's shell outranks
// a file.
//
// Why the handover takes effect at boot (restart required) instead of
// immediately: server/serve.js decides once, at boot, whether to start the
// autonomy heartbeat (it starts when the pin OR the delegation is present). A
// delegation granted mid-process would flip the toggle without starting the
// heartbeat, and the switch would lie — "on", but nothing wakes. So the files
// are read at boot and the page says so honestly.
//
// Delegation names a capability, not a secret, but the files keep mode 600
// like the other device files for consistency.

import fs from "node:fs";
import path from "node:path";

/** name -> the env var it hands over, and the device file that carries it. */
export const AUTONOMY_DELEGATION_FILES = Object.freeze([
  { name: "autonomy", env: "COGNOS_AUTONOMY_UI_CONTROL", file: "autonomy_ui_control.txt" },
  { name: "rungs", env: "COGNOS_AUTONOMY_RUNGS_UI_CONTROL", file: "autonomy_rungs_ui_control.txt" },
  { name: "auto_authorize", env: "COGNOS_AUTONOMY_AUTO_AUTHORIZE_UI_CONTROL", file: "autonomy_auto_authorize_ui_control.txt" },
  { name: "bypass_earning", env: "COGNOS_AUTONOMY_BYPASS_EARNING_UI_CONTROL", file: "autonomy_bypass_earning_ui_control.txt" },
  { name: "outbox", env: "COGNOS_AUTONOMY_OUTBOX_UI_CONTROL", file: "autonomy_outbox_ui_control.txt" },
  // Phase 33b — the council switches (Critic, Governor) get the same handover
  // as the autonomy switches. The file hands over the toggles only; both seats
  // still rest ON (fail-closed), and a pin still outranks everything.
  { name: "council", env: "COGNOS_COUNCIL_UI_CONTROL", file: "council_ui_control.txt" },
]);

/** The allow-list: anything else is not a switch, and is refused. */
export function isDelegationName(name) {
  return AUTONOMY_DELEGATION_FILES.some((s) => s.name === String(name || ""));
}

/** The allow-list entry for a name, or null. */
export function delegationEntry(name) {
  return AUTONOMY_DELEGATION_FILES.find((s) => s.name === String(name || "")) || null;
}

/**
 * Does this delegation file hand the switch over? Only an exact trimmed
 * "true" counts — the same allow-list semantics as envFlag in
 * server/autonomy/settings.js: an unrecognised value must not enable a
 * capability. Absent or unreadable reads as not delegated.
 */
export function readDelegationFile(dataDir, file) {
  try {
    return fs.readFileSync(path.join(dataDir, file), "utf8").trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Apply the delegation files to the environment. Called once at boot
 * (mobile/entry.mjs), before server/serve.js reads anything. An env var that
 * is already set keeps winning. Returns the names that were applied, for the
 * boot log. Never throws — a failed read must not break boot.
 */
export function applyAutonomyDelegationFiles(dataDir) {
  const applied = [];
  if (!dataDir) return applied;
  for (const { name, env, file } of AUTONOMY_DELEGATION_FILES) {
    if (process.env[env]) continue; // an explicit env var keeps winning
    try {
      if (readDelegationFile(dataDir, file)) {
        process.env[env] = "true";
        applied.push(name);
      }
    } catch { /* never break boot for delegation */ }
  }
  return applied;
}
