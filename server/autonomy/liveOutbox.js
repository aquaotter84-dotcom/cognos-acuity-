// Ask-and-flip live for T4 — Phase 22 (autonomy row), first slice; earning removed in Phase 34.
//
// WHAT WAS TRUE BEFORE THIS. Rung 4 was built in Phase 21 and could not be
// reached. `webhook.post` existed with DNS pinning, hop re-validation,
// `secret_ref` signing and digest-only receipts; the Action Governor judged
// every T4 effect; the shadow-evidence gate refused a live release with
// EVIDENCE_GATE_UNMET. What was missing was not code but PERMISSION TO PERFORM,
// and the only way to grant it was `COGNOS_AUTONOMY_OUTBOX_MODE=live` in the
// environment plus a restart — an unguarded global switch that said nothing at
// flip time about whether the flip meant anything. Set it with no corpus and
// the deployment sits in a mode where every effect is individually refused,
// which is safe and is not honest: the operator flipped a switch and got no
// answer until a delivery was attempted.
//
// WHAT THIS ADDS. Three things, and deliberately nothing else:
//
//   1. A READINESS REPORT. `describeLiveReadiness` answers "what would it take
//      to go live right now?" as a list of named conditions, each with a
//      sentence saying what to do when it is unmet. It is readable before
//      anything is flipped, so the answer arrives at the switch rather than at
//      the first delivery.
//   2. A GUARDED FLIP. `setOutboxMode` writes `autonomy_settings.outbox_mode`
//      and refuses to widen to `live` unless every condition holds. NARROWING
//      is refused by nothing: a brake is not a brake if it takes effort to reach.
//   3. ONE APPROVED DESTINATION. `COGNOS_AUTONOMY_LIVE_DESTINATION` names a
//      single endpoint a live T4 delivery may target. The goal's scope grant
//      (pin.destination_granted) and this must BOTH hold, so the intersection
//      is strictly narrower than either gate alone. The Action Governor
//      enforces it per effect; this module requires it at flip time too.
//      (Phase 34: the earned-corpus conditions are gone. Going live needs no
//      practice runs — every send is still judged per effect and still needs
//      Jeremy's approval.)
//
// WHAT THIS DOES NOT ADD. T5. An irreversible act is a different authority
// than a live T4 delivery: it releases only by a per-effect human approval
// naming the exact outbox row (pin.irreversible_human_approval), one at a
// time, never by class — so it never passes through this module's corpus gate
// at all. No rung is widened here, no ceiling is raised, no skill is added,
// and no law is relaxed. The resting state is still shadow.
//
// WHY A MODULE AND NOT A ROUTE. The guard is policy, and policy in a route
// handler is policy that only one caller has to obey. settings.js holds the
// enablement precedence for exactly the same reason; this holds the mode
// precedence's async half, which settings.js cannot hold because the evidence
// row lives in the database and settings.js is deliberately synchronous and
// leaf-shaped.

import { createHash } from "node:crypto";
import {
  OUTBOX_MODES, OUTBOX_MODE_ENV, OUTBOX_UI_CONTROL_ENV,
  applyOutboxModeCache, describeSettings, effectiveOutboxMode,
  envOutboxMode, isWideningOutboxMode, outboxModeRefusal
} from "./settings.js";
import { LIVE_DESTINATION_ENV, autonomyConfig, liveDestinationCovers, describeLiveDestination } from "./config.js";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

/** The audit action, alongside Phase 25's 'autonomy.enabled'. */
export const OUTBOX_MODE_AUDIT_ACTION = "autonomy.outbox_mode";

/**
 * What would it take to go live right now?
 *
 * Every condition is reported whether or not it holds, because a report that
 * lists only the failures cannot show an operator that the rest are already
 * satisfied — and the whole point of the slice is that the answer arrives
 * before the flip rather than after a refused delivery.
 *
 * Reads only. Records nothing.
 */
export async function describeLiveReadiness({ db, workspaceId, config = null, nowMs = Date.now() }) {
  const cfg = config || autonomyConfig();
  const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
  const dest = cfg.liveDestination || {};

  const env = envOutboxMode();

  // A condition carries a sentence only when it is UNMET, and that is enforced
  // by the shape of this helper rather than by each condition remembering it:
  // the refusal message is exactly the list of things an operator can do, and a
  // met condition has nothing to say. Passing the sentence lazily keeps the
  // unmet-only rule true even for conditions whose wording depends on state.
  const cond = (id, label, met, unmet) => ({ id, label, met: met === true,
    sentence: met === true ? "" : (typeof unmet === "function" ? unmet() : String(unmet || "")) });

  // The LABELS are plain language for the person reading the Outbox tab; the
  // ids stay machine-stable and the note below keeps the precise explanation.
  // Jargon is demoted, not removed — same discipline as autonomyLabels.js.
  // Phase 34: the earned-corpus conditions (evidence_recorded, evidence_current,
  // corpus_aimed) and the rung flag are gone. Going live is a choice, not an
  // achievement: autonomy on, one approved destination, and the flip handed to
  // this API. Every send is still judged per effect and still needs approval.
  const conditions = [
    cond("delegated", "You can flip this switch from here",
      cfg.settings?.canSetOutboxMode === true,
      () => `To hand this switch to the API, set ${OUTBOX_UI_CONTROL_ENV}=true and restart. Until then the outbox mode is controlled only by ${OUTBOX_MODE_ENV}.`),

    cond("not_pinned_down", "No pin is holding the outbox back",
      env === null || !isWideningOutboxMode(env, "live"),
      () => `${OUTBOX_MODE_ENV}=${env} pins the outbox down and a pin outranks the API. Remove it and restart to make live reachable.`),

    cond("autonomy_on", "Autonomy is switched on",
      cfg.enabled === true,
      "Autonomy is off, so the loop wakes for nothing and stages nothing. Turn it on first — a live mode with a frozen loop is a switch that means nothing."),

    cond("destination_approved", "One approved place to send to",
      dest.configured === true,
      () => (dest.misconfigured === true
        ? `${LIVE_DESTINATION_ENV} is set but the adapter would refuse it: ${dest.reason}. Fix the value and restart — a broken brake is no brake.`
        : `Name exactly one endpoint with ${LIVE_DESTINATION_ENV}=https://host/path and restart. A live send with no approved destination has nowhere it is allowed to go.`)),
  ];

  const unmet = conditions.filter(c => !c.met);
  const mode = cfg.outboxMode;

  return {
    ok: true,
    tier: "T4",
    mode,
    modeSource: cfg.outboxModeSource || null,
    alreadyLive: mode === "live",
    ready: unmet.length === 0,
    conditions,
    // Both counts, so a surface can say "2 of 4" without counting the array it
    // was handed and without trusting `ready` to be the only summary.
    met: conditions.length - unmet.length,
    total: conditions.length,
    unmet: unmet.map(c => c.id),
    refusal: unmet.length
      ? { code: "live_not_ready", message: unmet.map(c => c.sentence).join(" "), unmet: unmet.map(c => c.id) }
      : null,
    // The host is reported; the full URL is not. describeLiveDestination is the
    // one definition of what a surface may say, shared with /api/autonomy/status
    // so the two cannot drift.
    destination: describeLiveDestination(dest),
    note: "Two things have to be true before anything goes out live: autonomy is on, and exactly one destination is approved. Even then, every single send is judged on its own and needs Jeremy's approval — the Action Governor never bulk-approves."
  };
}

/** The notes a flip returns, exported so a surface can quote the same words. */
export const OUTBOX_MODE_NOTES = Object.freeze({
  live: "Live. From here on, an approved send is PERFORMED for real — it actually goes out, to the one approved destination, and only after it's judged on its own. Flip back to shadow any time; turning it back down needs no proof.",
  shadow: "Shadow. The loop plans, stages, and judges — but nothing goes out. This is the resting state.",
  dry_run: "Dry run. The exact message is built and written down, and still nothing is sent."
});

/**
 * THE FLIP. The only writer of `autonomy_settings.outbox_mode`.
 *
 * Refusals are returned, not thrown, and they come in three kinds:
 *   not_delegated       — this deployment never handed the mode to the API;
 *   pinned_by_operator  — an environment value holds the mode down, and a pin
 *                         outranks the API (but never blocks a narrowing);
 *   live_not_ready      — every reason a widening to live is refused, as
 *                         sentences, so the response is the readiness report
 *                         rather than a bare 409.
 *
 * Narrowing is refused by nothing beyond delegation and a pin, and a request
 * for the mode already in effect writes no row and records no audit: a flip
 * that changed nothing must not look like a decision somebody made.
 */
export async function setOutboxMode({ db, workspaceId = null, outboxMode,
  updatedBy = "api", config = null, nowMs = Date.now() }) {
  const cfg = config || autonomyConfig();
  const requested = String(outboxMode ?? "").trim();
  // Captured BEFORE any write, so the response can show the transition rather
  // than only its result.
  const previous = describeSettings();
  const current = cfg.outboxMode;
  const env = envOutboxMode();
  const dest = cfg.liveDestination || {};
  // Resolved once and only if a path below needs it: three of the four refusals
  // are decided from the environment and the config alone, and issuing a
  // workspace lookup on the way to a refusal would be work nobody asked for.
  let wsId = workspaceId || null;
  const workspace = async () => (wsId ||= (await db.Workspace.ensureDefault()).id);

  const refuse = (refusal, extra = {}) => ({
    ok: false, changed: false, refusal, mode: effectiveOutboxMode(),
    settings: describeSettings(), ...extra
  });

  if (!OUTBOX_MODES.includes(requested)) {
    return refuse({
      code: "invalid_mode",
      message: `outboxMode must be one of ${OUTBOX_MODES.join(", ")}; '${requested.slice(0, 40) || "(empty)"}' is not a mode.`
    });
  }

  const delegationRefusal = outboxModeRefusal();
  if (delegationRefusal) return refuse(delegationRefusal);

  // A pin may hold the system down. It may not be widened from here, and it
  // may always be narrowed — see effectiveOutboxMode for the one asymmetry.
  if (env !== null && isWideningOutboxMode(env, requested)) {
    return refuse({
      code: "pinned_by_operator",
      message: `${OUTBOX_MODE_ENV}=${env} pins the outbox mode, and '${requested}' reaches further into the world than '${env}'. `
        + `Remove that variable and restart to hand the mode to this API.`
    });
  }

  if (requested === current) {
    // Nothing to decide and nothing to record. Saying "changed: false" is the
    // honest answer; writing a row would put a decision in the audit trail
    // that nobody made.
    return {
      ok: true, changed: false, refusal: null, mode: current,
      previous, settings: previous, atMs: nowMs,
      note: `The outbox is already in '${current}' mode. Nothing was written.`
    };
  }

  // `live` is the only mode that performs anything, so it is the only widening
  // that has to be earned. `dry_run` builds the exact request and records it,
  // and still sends nothing — gating it on a corpus would be gating a record.
  // The second half of the condition is redundant after the early return above
  // and is here anyway: a safety-relevant test should not depend on a reader
  // having followed the control flow to know it holds.
  const widensToLive = requested === "live" && current !== "live";
  let readiness = null;

  if (widensToLive) {
    readiness = await describeLiveReadiness({ db, workspaceId: await workspace(), config: cfg, nowMs });
    if (!readiness.ready) {
      return refuse(readiness.refusal, { readiness, requested });
    }
  }

  const targetWorkspace = await workspace();
  const row = await db.AutonomySettings.setOutboxMode({
    workspace_id: targetWorkspace, outbox_mode: requested, updated_by: updatedBy, updated_ms: nowMs
  });

  // Write-through, so the response to this flip and every synchronous
  // autonomyConfig() after it already see the new mode.
  applyOutboxModeCache(requested, { updatedBy, updatedAtMs: nowMs });
  const mode = effectiveOutboxMode();

  // The audit trail. Append-only, in the table Phase 24 already uses, with both
  // values so the row reads as a transition — and, for a widening, with the
  // digest of the evidence that justified it, so "what did we know when we went
  // live" stays answerable after the corpus moves on.
  try {
    await db.WorkspaceAudit.append({
      workspaceId: targetWorkspace,
      action: OUTBOX_MODE_AUDIT_ACTION,
      resourceId: null,
      detail: {
        from: current,
        to: requested,
        effective: mode,
        via: "api",
        updatedBy,
        widening: widensToLive,
        envPin: env,
        // The destination is digested, not stored. An audit row is readable by
        // anyone who can read this workspace's history, and the row still
        // proves WHICH endpoint was approved at the moment of the flip without
        // carrying the endpoint around forever (pin.receipt_metadata_only's
        // discipline, applied to a configuration value).
        destinationSha256: dest.configured ? sha256(dest.url) : null
      },
      tsMs: nowMs
    });
  } catch {
    // A failed audit row does not undo a flip the operator just made, and
    // pretending otherwise would be worse than the gap — the same judgement
    // setSettingsEnabled makes. The flip is still visible in
    // autonomy_settings.outbox_mode / updated_ms / updated_by.
  }

  return {
    ok: true, changed: true, refusal: null,
    previousMode: current, mode, requested,
    previous, settings: describeSettings(), readiness, row, atMs: nowMs,
    note: OUTBOX_MODE_NOTES[mode] || OUTBOX_MODE_NOTES[requested] || null
  };
}

/** The mode flips recorded for this workspace, newest first. Bounded. */
export async function listOutboxModeFlips(db, { workspaceId = null, limit = 20 } = {}) {
  try {
    const wsId = workspaceId || (await db.Workspace.ensureDefault()).id;
    const rows = await db.WorkspaceAudit.list({
      workspaceId: wsId, action: OUTBOX_MODE_AUDIT_ACTION,
      limit: Math.max(1, Math.min(100, Number(limit) || 20))
    });
    return rows.map(row => ({
      id: row.id,
      atMs: Number(row.ts_ms),
      from: row.detail?.from ?? null,
      to: row.detail?.to ?? null,
      effective: row.detail?.effective ?? row.detail?.to ?? null,
      widening: row.detail?.widening === true,
      via: row.detail?.via || "api",
      updatedBy: row.detail?.updatedBy || row.user_id || null,
      samples: row.detail?.samples ?? null,
      destinationSha256: row.detail?.destinationSha256 || null
    }));
  } catch {
    return [];
  }
}
