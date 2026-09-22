// Read-only surfaces plus the decision points of Phase 19, and Phase 25's two
// additions: the delegated on/off switch, and the conversational designer.
//
// Everything here is either a query over stored rows or an authorization
// decision. Nothing on this route can produce an answer, compose prose, or
// release an effect on its own authority — the outbox and the Action Governor
// do that, and the one send path still owns every sentence the user reads.
//
// The designer is the one route that calls a model for text, and it is bounded
// into a shape that cannot become an answer path: it returns a DRAFT of rows
// (a name, a brief, an allowlist, ceilings) plus a short design note about that
// draft. It creates nothing, and creating goes through the same gated routes a
// manual form uses.
//
// Barriers live here:
//   POST /api/autonomy/settings              — the delegated switch (Phase 25),
//                                              and the outbox mode (Phase 22,
//                                              autonomy row): one request
//                                              changes one switch
//   POST /api/autonomy/goals/:id/decision    — a goal does no work until this
//                                              records consent with scope hashes
//   POST /api/autonomy/outbox/:id/decision   — a staged effect is approved,
//                                              refused or reverted (T2+)
//   POST /api/autonomy/promotions/:id/decide — a promotion request is approved
//                                              (and applied) or refused (Phase 20)

import { autonomyConfig, describeLiveDestination } from "../autonomy/config.js";
import {
  describeSettings, ensureSettingsLoaded, refreshSettings, setSettingsEnabled,
  setAutoAuthorize, setBypassEarning, setRung, isRungKey, RUNG_KEYS,
  listSettingFlips, AUTONOMY_PIN_ENV, AUTONOMY_UI_CONTROL_ENV
} from "../autonomy/settings.js";
import { designTurn, clampDraft, emptyDraft, DESIGNER_LIMITS, firstGoalScope, clampProposedUrls } from "../autonomy/designer.js";
import { scopeHashes, authorizationCovers, isTightening } from "../autonomy/authorize.js";
import { validateDestinationGrant } from "../autonomy/scopeUrl.js";
import { decideEffect, revertEffect, refuseEffect, shadowCorpus } from "../autonomy/outbox.js";
import { RUNGS, RUNG_IDS, recordRungEvidence, rungEvidenceStatus } from "../autonomy/evidenceGate.js";
import { describeLiveReadiness, setOutboxMode, listOutboxModeFlips } from "../autonomy/liveOutbox.js";
import { decidePromotion } from "../autonomy/promote.js";
import { describeSkills } from "../skills/index.js";
import { publicNotice, NOTICE_TEMPLATE_IDS } from "../autonomy/notice.js";
import { runTick } from "../autonomy/tick.js";

const safe = (value, max) => String(value ?? "")
  .replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The slug rule the manual resident form uses, in one place. */
const slugify = (value) => String(value ?? "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

const parseJson = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

/**
 * Phase 27 — validating a destination GRANT at the one moment it can still be
 * fixed. A scope's destination entries are the operator's own grant: nothing
 * is clamped or dropped. But scope is immutable after creation
 * (pin.goal_scope_immutable), so an entry that could never do anything — a
 * shape destinationsForScope would silently ignore, or a URL the adapter would
 * refuse — must not be WELDED IN with a 201: the goal would look keyed while
 * it never was, and the shadow corpus would stay empty behind a lock whose key
 * the operator believes exists.
 *
 * So the create routes REFUSE a malformed grant with every bad entry named,
 * and normalize valid entries (exact URLs to href form, fragment dropped) so
 * what the row grants is exactly what the matcher will compare attempts
 * against. Judges keep tolerating odd scope defensively; grants get sentences.
 *
 * Returns the list of problems (empty when the grant is clean). Valid
 * destination lists are normalized in place while checking — the caller
 * refuses outright on any problem, so an in-place edit can only ever coexist
 * with a scope whose every entry survived.
 */
function destinationGrantProblems(scope) {
  const problems = [];
  const entries = Array.isArray(scope?.effectsAllowed) ? scope.effectsAllowed : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (!Object.prototype.hasOwnProperty.call(entry, "destinations")) continue;
    const name = [entry.effect, entry.skill, entry.effectType, entry.skillId]
      .find(v => typeof v === "string") || "(unnamed effect)";
    if (!Array.isArray(entry.destinations)) {
      problems.push(`${name} — destinations must be a list of URLs or host entries; a grant with none grants nothing`);
      continue;
    }
    const check = validateDestinationGrant(entry.destinations);
    if (check.ok) {
      // Store what the matcher compares: exact URLs in fragment-free href form.
      entry.destinations = check.destinations;
    }
    for (const error of check.errors.slice(0, 6)) problems.push(`${name} — ${error}`);
  }
  return problems;
}

const invalidGrantResponse = (res, problems, extra = {}) => res.status(400).json({
  error: `The destination grant cannot be written as asked: ${problems.join("; ")}. `
    + `Fix the list and create it again — scope cannot be widened or repaired afterwards. Nothing was created.`,
  code: "invalid_destination_grant",
  problems,
  ...extra
});

/**
 * Phase 26 — record consent for a goal without a human click.
 *
 * This is the SAME authorize step POST /api/autonomy/goals/:id/decision
 * performs, with one deliberate difference: `decision_source` is "auto" rather
 * than "app", so an audit can always tell an automatic authorization from a
 * human one. Nothing else is skipped — the scope and budget hashes are computed
 * and stored, the allowlist and ceilings still bind at every later step, and
 * staged effects still wait for their own human approval. "Forgo goal
 * authorization" removes the consent CLICK, never the consent RECORD.
 */
async function autoAuthorizeGoal(db, goal) {
  const scope = parseJson(goal.scope, {});
  const budget = parseJson(goal.budget, {});
  const hashes = scopeHashes({ goalId: goal.id, scope, budget });
  const authorization = await db.GoalAuthorization.append({
    goal_id: goal.id,
    scope_sha256: hashes.scopeSha256,
    budget_sha256: hashes.budgetSha256,
    decision: "authorize",
    reason: "auto-authorized: forgo goal authorization is on",
    decided_ms: Date.now(),
    expires_at_ms: null,
    decision_source: "auto"
  });
  const updated = await db.AutonomyGoal.setStatus(goal.id, {
    status: "active", parkReason: null, startedMs: Date.now()
  });
  await db.AutonomyGoal.nextRunAt(goal.id, Date.now());
  await db.GoalEvent.append({
    goal_id: goal.id, agent_id: goal.agent_id || null,
    event_type: "goal_authorized", from_status: goal.status, to_status: "active",
    detail: { reason: "auto-authorized", decision_source: "auto", ...hashes }
  });
  return { authorization, goal: updated };
}

export function registerAutonomyRoutes(app, { wrap, db, logger }) {
  const config = () => autonomyConfig();

  /**
   * What "autonomy is off" means HERE, in words the reader can act on.
   *
   * Naming a variable is not help: from a browser you cannot set one. So the
   * message says which of the two situations this deployment is in — a switch
   * you can use, or a switch an operator has to hand over — and the UI renders
   * the copyable steps for the second case.
   */
  const frozenError = () => {
    const cfg = config();
    return cfg.canToggleFromUi
      ? "Autonomy is off. Turn it on with the switch at the top of the Autonomy page, then try again."
      : `Autonomy is off. An operator enables it with ${AUTONOMY_PIN_ENV}=true, or hands the switch to this UI with ${AUTONOMY_UI_CONTROL_ENV}=true.`;
  };

  // --- Status: what is on, what is built, what is off -----------------------
  app.get("/api/autonomy/status", wrap(async (req, res) => {
    // Phase 25 — `enabled` is now the effective switch, which may be a stored
    // delegated value. Load it before reading the config, so the first request
    // after a boot does not report an unloaded cache as "off". `?fresh=1` forces
    // a re-read instead, for a multi-instance host where this process's cache may
    // predate a flip another instance served.
    if (req.query.fresh) await refreshSettings(db);
    else await ensureSettingsLoaded(db);
    const cfg = config();
    const ws = await db.Workspace.ensureDefault();
    const [agents, active, parked, awaiting, openPromos, evidenceRows] = await Promise.all([
      db.AutonomyAgent.list(ws.id, 100),
      db.query(`SELECT COUNT(*)::int AS n FROM autonomy_goals WHERE workspace_id=$1 AND status='active'`, [ws.id]),
      db.query(`SELECT COUNT(*)::int AS n FROM autonomy_goals WHERE workspace_id=$1 AND status='parked'`, [ws.id]),
      db.query(`SELECT COUNT(*)::int AS n FROM autonomy_outbox WHERE workspace_id=$1 AND status='staged'`, [ws.id]),
      db.query(`SELECT COUNT(*)::int AS n FROM note_promotions WHERE workspace_id=$1 AND status='requested'`, [ws.id]),
      db.RungEvidence.list(ws.id, { limit: 20 }).catch(() => [])
    ]);
    res.json({
      enabled: cfg.enabled,
      requestedEnabled: cfg.requestedEnabled,
      defaultOff: true,
      // Phase 25 — HOW it is on. Three separate facts, because "is it running",
      // "did an operator force it" and "may I change it from here" are three
      // different questions and the UI has to be able to answer all three.
      enabledSource: cfg.enabledSource,
      pinned: cfg.pinned,
      uiControl: cfg.uiControl,
      canToggleFromUi: cfg.canToggleFromUi,
      toggleRefusal: cfg.toggleRefusal,
      settings: cfg.settings,
      rung: cfg.rung,
      outboxMode: cfg.outboxMode,
      // Phase 22 (autonomy row) — how the mode came about, and whether this API
      // may change it. Same three-questions discipline as `enabledSource`:
      // "what mode is it in", "who decided that" and "may I change it from
      // here" are not one question.
      outboxModeSource: cfg.outboxModeSource,
      outboxModeDelegated: cfg.settings?.outboxModeDelegated === true,
      canSetOutboxMode: cfg.settings?.canSetOutboxMode === true,
      outboxRefusal: cfg.settings?.outboxRefusal || null,
      // The one endpoint a live delivery may target. Hostname only — the
      // resolved URL is what the matcher and the adapter need, not what a
      // served object should carry. describeLiveDestination is the same helper
      // the readiness report uses, so the two surfaces say the same thing.
      liveDestination: describeLiveDestination(cfg.liveDestination),
      notices: cfg.notices,
      builtTiers: cfg.builtTiers,
      counts: {
        residents: (agents || []).length,
        activeGoals: Number(active[0]?.n || 0),
        parkedGoals: Number(parked[0]?.n || 0),
        stagedEffects: Number(awaiting[0]?.n || 0),
        openPromotions: Number(openPromos[0]?.n || 0)
      },
      ceilings: cfg.ceiling,
      shadowGate: cfg.shadow,
      tick: cfg.tick,
      // Phase 21 — what an external write is allowed to look like here, and
      // whether this deployment has earned one. Reported as separate facts:
      // built, rung on, and live are three different questions.
      webhook: cfg.webhook,
      quietHours: cfg.quietHours,
      externalWrites: {
        built: cfg.builtTiers.includes("T4"),
        rungEnabled: cfg.rung.externalWrites === true,
        killSwitch: "COGNOS_AUTONOMY_EXTERNAL_WRITES",
        deliversNow: cfg.rung.externalWrites === true && cfg.outboxMode === "live",
        // An operator's Approve judges the effect in live mode whatever the
        // loop's mode is, so "the loop delivers nothing" is not the same claim
        // as "nothing can leave". Both facts, separately.
        deliversOnApproval: cfg.builtTiers.includes("T4") && cfg.rung.externalWrites === true,
        requiresEvidenceRow: true,
        requiresApprovedDestination: true,
        approvedDestinationConfigured: cfg.liveDestination?.configured === true,
        approvedDestinationMisconfigured: cfg.liveDestination?.misconfigured === true,
        evidence: (evidenceRows || [])
          .filter(row => row.rung === RUNGS.external_writes.rung)
          .slice(0, 5)
          .map(row => ({
            id: row.id, decision: row.decision, tier: row.tier,
            decided_ms: Number(row.decided_ms), decided_by: row.decided_by,
            reason: row.reason, metrics_sha256: row.metrics_sha256,
            samples: parseJson(row.metrics, {}).samples ?? null,
            falseReleases: parseJson(row.metrics, {}).falseReleaseCount ?? null
          }))
      },
      // Phase 22 (autonomy row, second slice) — T5. Built, default-off, and
      // released only by a per-effect human approval. Reported separately from
      // `externalWrites` because the two tiers have different release
      // authorities: T4 is corpus-earned, T5 is approved one effect at a time.
      irreversible: {
        built: cfg.builtTiers.includes("T5"),
        rungEnabled: cfg.rung.irreversible === true,
        killSwitch: "COGNOS_AUTONOMY_IRREVERSIBLE",
        requiresPerEffectHumanApproval: true,
        classAuthorized: false,
        adapters: cfg.builtTiers.includes("T5") ? ["post.publish"] : []
      },
      skills: describeSkills(cfg),
      noticeTemplates: NOTICE_TEMPLATE_IDS,
      law: "phase19.autonomy_default_off",
      note: cfg.pinned
        ? `An operator pinned this on with ${AUTONOMY_PIN_ENV}=true. The UI reports that honestly and cannot override it.`
        : cfg.uiControl
          ? `The switch is delegated to the UI (${AUTONOMY_UI_CONTROL_ENV}=true). Flipping it is recorded and takes effect on the next heartbeat — no restart.`
          : `Durable autonomy is disabled by default. Set ${AUTONOMY_PIN_ENV}=true to pin it on, or ${AUTONOMY_UI_CONTROL_ENV}=true to hand the switch to the UI.`
    });
  }));

  // --- Phase 25: the delegated switch ---------------------------------------
  /**
   * What the switch is, who decided it, and whether this UI may change it.
   * Separate from /status because the banner polls it after a flip and should
   * not drag the whole skill catalogue along.
   */
  app.get("/api/autonomy/settings", wrap(async (req, res) => {
    await refreshSettings(db);
    const settings = describeSettings();
    const ws = await db.Workspace.ensureDefault();
    const cfg = config();
    // Phase 22 (autonomy row) — the mode switch is reported next to the
    // enablement switch, with its own history, so one surface answers "what is
    // on and what may I change?" without a second request.
    //
    // The readiness report is behind `?live=1`, on the same convention
    // `/api/autonomy/status?fresh=1` already sets: measuring the corpus reads up
    // to a thousand outbox rows, and a switch surface that can be polled should
    // not do that on every read. GET /api/autonomy/rungs is the canonical home
    // for the report, and the Autonomy page reads it from there.
    const [flips, outboxFlips, live] = await Promise.all([
      listSettingFlips(db, { limit: Number(req.query.limit) || 10 }),
      listOutboxModeFlips(db, { workspaceId: ws.id, limit: Number(req.query.limit) || 10 }),
      req.query.live
        ? describeLiveReadiness({ db, workspaceId: ws.id, config: cfg }).catch(() => null)
        : Promise.resolve(null)
    ]);
    res.json({
      ...settings,
      flips,
      outboxFlips,
      live
    });
  }));

  /**
   * THE SWITCH. Only works when an operator delegated it, and never against a
   * pin. Both refusals are 409 with the reason in words, because a toggle that
   * silently does nothing is worse than no toggle: the operator believes they
   * turned the system on.
   *
   * The write is write-through — the response carries the new effective state,
   * and any synchronous autonomyConfig() after this point agrees with it.
   */
  app.post("/api/autonomy/settings", wrap(async (req, res) => {
    await ensureSettingsLoaded(db);

    /**
     * Phase 22 (autonomy row) — THE OUTBOX MODE FLIP, on the same surface as
     * the enablement switch because both are operator switches over the same
     * row. One request changes one switch: sending both is a 400 rather than a
     * guess about which one the caller meant, and the two have different guards
     * (enablement needs a delegation; widening to live needs to be EARNED).
     *
     * Phase 26 adds a third switch to the same surface — auto-authorize — with
     * its own guard, so the same one-request-one-switch rule now counts three.
     *
     * Phase 29 adds a fifth — one rung — sent as `rung: { name, enabled }`.
     * It is one switch even though it names one of five rungs, because the
     * request still changes exactly one value on one row.
     */
    const rungBody = req.body?.rung;
    const switchCount = [req.body?.enabled !== undefined,
      req.body?.outboxMode !== undefined && req.body?.outboxMode !== null,
      req.body?.autoAuthorize !== undefined,
      req.body?.bypassEarning !== undefined,
      rungBody !== undefined && rungBody !== null].filter(Boolean).length;
    if (switchCount > 1) {
      return res.status(400).json({
        error: "Send exactly one switch per request: enabled, outboxMode, autoAuthorize, bypassEarning, or rung. Each has its own guard.",
        code: "one_switch_per_request"
      });
    }
    if (req.body?.outboxMode !== undefined && req.body?.outboxMode !== null) {
      const cfg = config();
      const outcome = await setOutboxMode({
        db,
        outboxMode: req.body.outboxMode,
        updatedBy: safe(req.body?.updated_by, 60) || "api",
        config: cfg
      });
      if (!outcome.ok) {
        // 409 with the whole readiness report attached: the refusal is a list
        // of things an operator can do, not a bare "no".
        return res.status(409).json({
          error: outcome.refusal.message,
          code: outcome.refusal.code,
          unmet: outcome.refusal.unmet || [],
          mode: outcome.mode,
          changed: false,
          live: outcome.readiness || null,
          settings: outcome.settings
        });
      }
      if (outcome.changed) {
        logger.info("outbox mode flipped", {
          to: outcome.mode, from: outcome.previousMode,
          widening: outcome.requested === "live",
          evidence: outcome.readiness?.evidence?.metrics_sha256?.slice(0, 12) || null
        });
      }
      return res.json({
        outboxMode: outcome.mode,
        mode: outcome.mode,
        changed: outcome.changed,
        previousMode: outcome.previousMode ?? outcome.mode,
        atMs: outcome.atMs,
        live: outcome.readiness || null,
        settings: outcome.settings,
        note: outcome.note
      });
    }

    /**
     * Phase 26 — THE AUTO-AUTHORIZE FLIP. "Forgo goal authorization": when on,
     * a newly created goal is authorized automatically (its scope/budget hashes
     * recorded with decision_source 'auto') instead of waiting in
     * awaiting_authorization. It forgoes the GOAL consent click and nothing
     * else — allowlists, ceilings and the per-effect Governor still bind, and
     * staged effects still wait for their own human approval. Its guard is its
     * own delegation; the enablement and outbox delegations do not imply it.
     */
    if (req.body?.autoAuthorize !== undefined) {
      const requestedAuth = req.body.autoAuthorize;
      if (typeof requestedAuth !== "boolean") {
        return res.status(400).json({ error: "autoAuthorize must be true or false" });
      }
      const outcome = await setAutoAuthorize(db, {
        enabled: requestedAuth,
        updatedBy: safe(req.body?.updated_by, 60) || "ui"
      });
      if (!outcome.ok) {
        return res.status(409).json({
          error: outcome.refusal.message,
          code: outcome.refusal.code,
          settings: outcome.settings
        });
      }
      logger.info("auto-authorize switch flipped from the UI", {
        to: requestedAuth, from: outcome.previous?.autoAuthorize === true
      });
      res.json({
        settings: outcome.settings,
        autoAuthorize: outcome.settings.autoAuthorize,
        changed: outcome.previous?.autoAuthorize === true !== requestedAuth,
        atMs: outcome.atMs,
        note: outcome.settings.autoAuthorize
          ? "On. New goals are authorized automatically when created — the scope and budget hashes are still recorded, and every staged effect still waits for its own approval."
          : "Off. A new goal is created awaiting_authorization and does no work until you authorize it."
      });
      return;
    }

    /**
     * Phase 28 — THE EARNED-CORPUS BYPASS FLIP. When on, a live T4 release no
     * longer has to earn its way past the shadow corpus; an operator has
     * vouched for the destination instead. It waives the CORPUS and nothing
     * else — the rung flag, the one approved destination, autonomy being on,
     * quiet hours and the per-effect Governor all still bind, and T5 still
     * releases only by a per-effect human approval. Its guard is its own
     * delegation; none of the other three delegations implies it.
     */
    if (req.body?.bypassEarning !== undefined) {
      const requestedBypass = req.body.bypassEarning;
      if (typeof requestedBypass !== "boolean") {
        return res.status(400).json({ error: "bypassEarning must be true or false" });
      }
      const outcome = await setBypassEarning(db, {
        enabled: requestedBypass,
        updatedBy: safe(req.body?.updated_by, 60) || "ui"
      });
      if (!outcome.ok) {
        return res.status(409).json({
          error: outcome.refusal.message,
          code: outcome.refusal.code,
          settings: outcome.settings
        });
      }
      logger.info("earned-corpus bypass flipped from the UI", {
        to: requestedBypass, from: outcome.previous?.bypassEarning === true
      });
      res.json({
        settings: outcome.settings,
        bypassEarning: outcome.settings.bypassEarning,
        changed: outcome.previous?.bypassEarning === true !== requestedBypass,
        atMs: outcome.atMs,
        note: outcome.settings.bypassEarning
          ? "On. A live release no longer waits for a shadow corpus — you have vouched for the approved destination. The rung, the destination, the Governor and every T5 approval still apply."
          : "Off. A live release has to earn its way past the shadow corpus again."
      });
      return;
    }

    /**
     * Phase 29 — THE RUNG FLIP. `rung: { name, enabled }` changes one of the
     * five sign-offs that decide which tiers EXIST here (residents, search,
     * externalWrites, irreversible, inbound). It is the same power the operator
     * used to exercise with a Railway variable and a restart.
     *
     * What it does not do: open a live release on its own. The rung is
     * necessary and not sufficient — the shadow corpus, the one approved
     * destination, the Governor's per-effect verdicts and every T5 approval all
     * still bind, and none of them is writable from here.
     *
     * Its guard is its own delegation (COGNOS_AUTONOMY_RUNGS_UI_CONTROL), which
     * none of the other four delegations implies. A rung the operator pinned in
     * the environment is refused with the variable's name rather than ignored.
     */
    if (rungBody !== undefined && rungBody !== null) {
      const name = typeof rungBody === "string" ? rungBody : rungBody.name;
      const enabled = typeof rungBody === "string" ? req.body?.rungEnabled : rungBody.enabled;
      if (!isRungKey(name)) {
        return res.status(400).json({
          error: `"${String(name).slice(0, 40)}" is not a rung. Known rungs: ${RUNG_KEYS.join(", ")}.`,
          code: "unknown_rung",
          rungs: RUNG_KEYS
        });
      }
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "rung.enabled must be true or false", code: "bad_rung_value" });
      }
      const outcome = await setRung(db, {
        rung: name,
        enabled,
        updatedBy: safe(req.body?.updated_by, 60) || "ui"
      });
      if (!outcome.ok) {
        return res.status(409).json({
          error: outcome.refusal.message,
          code: outcome.refusal.code,
          settings: outcome.settings
        });
      }
      logger.info("rung flipped from the UI", {
        rung: name, to: enabled, from: outcome.previous?.rungs?.[name] === true
      });
      res.json({
        settings: outcome.settings,
        rung: name,
        rungs: outcome.settings.rungs,
        changed: (outcome.previous?.rungs?.[name] === true) !== enabled,
        atMs: outcome.atMs,
        note: enabled
          ? `The ${name} rung is on. The tier exists here — and it is necessary and not sufficient: the shadow corpus, the approved destination, the Governor and every T5 approval still bind.`
          : `The ${name} rung is off. Nothing at that tier runs, whatever the corpus says.`
      });
      return;
    }

    const requested = req.body?.enabled;
    if (typeof requested !== "boolean") {
      return res.status(400).json({ error: "enabled must be true or false, or send outboxMode or autoAuthorize" });
    }
    const outcome = await setSettingsEnabled(db, {
      enabled: requested,
      updatedBy: safe(req.body?.updated_by, 60) || "ui"
    });
    if (!outcome.ok) {
      return res.status(409).json({
        error: outcome.refusal.message,
        code: outcome.refusal.code,
        settings: outcome.settings
      });
    }
    logger.info("autonomy switch flipped from the UI", {
      to: outcome.settings.enabled, from: outcome.previous?.enabled,
      source: outcome.settings.source
    });
    res.json({
      settings: outcome.settings,
      enabled: outcome.settings.enabled,
      changed: outcome.previous?.enabled !== outcome.settings.enabled,
      atMs: outcome.atMs,
      note: outcome.settings.enabled
        ? "On. Residents may wake on the heartbeat; a goal still does no work until you authorize it."
        : "Off. Nothing wakes and nothing new is staged. Goals keep their rows and their authorizations."
    });
  }));

  // --- Phase 25: what does autonomy want from me? ---------------------------
  /**
   * The attention queue. One query, five kinds of thing that are waiting on a
   * human, each with the tab that resolves it. Bounded on both sides: a handful
   * of rows per kind, and every row is something the operator can act on.
   *
   * This is a VIEW, not a new decision surface — each item links to the barrier
   * that already exists (authorize, approve, acknowledge, decide).
   */
  app.get("/api/autonomy/attention", wrap(async (req, res) => {
    await ensureSettingsLoaded(db);
    const ws = await db.Workspace.ensureDefault();
    const perKind = Math.max(1, Math.min(10, Number(req.query.limit) || 5));

    // Rows are bounded (a handful per kind). Count is the full total, so a
    // truncated list cannot pretend there is only one thing waiting. A previous
    // version set count = rows.length, which made `?limit=1` look like an empty
    // inbox.
    const [
      awaiting, parked, staged, notices, promotions,
      awaitingN, parkedN, stagedN, noticesN, promotionsN
    ] = await Promise.all([
      db.AutonomyGoal.list(ws.id, { status: "awaiting_authorization", limit: perKind }),
      db.AutonomyGoal.list(ws.id, { status: "parked", limit: perKind }),
      db.AutonomyOutbox.list(ws.id, { status: "staged", limit: perKind }),
      db.AutonomyNotice.listUnread(ws.id, perKind),
      db.NotePromotion.list(ws.id, { status: "requested", limit: perKind }),
      db.query(`SELECT COUNT(*)::int AS n FROM autonomy_goals WHERE workspace_id=$1 AND status='awaiting_authorization'`, [ws.id]),
      db.query(`SELECT COUNT(*)::int AS n FROM autonomy_goals WHERE workspace_id=$1 AND status='parked'`, [ws.id]),
      db.query(`SELECT COUNT(*)::int AS n FROM autonomy_outbox WHERE workspace_id=$1 AND status='staged'`, [ws.id]),
      db.query(`SELECT COUNT(*)::int AS n FROM autonomy_notices WHERE workspace_id=$1 AND acked_ms IS NULL`, [ws.id]),
      db.query(`SELECT COUNT(*)::int AS n FROM note_promotions WHERE workspace_id=$1 AND status='requested'`, [ws.id])
    ]);

    const groups = [
      {
        kind: "awaiting_authorization",
        tab: "goals",
        label: "Waiting for your authorization",
        hint: "These goals do no work at all until you authorize the scope and budget you are shown.",
        rows: (awaiting || []).map(g => ({
          id: g.id, title: g.title, detail: String(g.objective || "").slice(0, 160),
          atMs: g.created_date ? Date.parse(g.created_date) : null
        }))
      },
      {
        kind: "staged_effect",
        tab: "outbox",
        label: "An action is staged and waiting",
        hint: "The loop wants to do something. Nothing happens until you approve or refuse it here.",
        rows: (staged || []).map(o => ({
          id: o.id, title: `${o.skill_id} · ${o.tier}`,
          detail: o.effect_type ? String(o.effect_type) : null,
          atMs: o.created_date ? Date.parse(o.created_date) : null
        }))
      },
      {
        kind: "unread_notice",
        tab: "notices",
        label: "Unread notices",
        hint: "Why a goal stopped, or what it finished. Templated text, never model prose.",
        rows: (notices || []).map(n => ({
          id: n.id, title: n.template_id, detail: null, atMs: Number(n.created_ms) || null
        }))
      },
      {
        kind: "parked_goal",
        tab: "goals",
        label: "Paused with a reason",
        hint: "A goal stopped itself — a ceiling, a failure, or a pause you asked for. The reason is recorded.",
        rows: (parked || []).map(g => ({
          id: g.id, title: g.title, detail: g.park_reason ? String(g.park_reason) : null,
          atMs: g.updated_date ? Date.parse(g.updated_date) : null
        }))
      },
      {
        kind: "open_promotion",
        tab: "promotions",
        label: "A finding wants to become knowledge",
        hint: "The only route from a working note to durable memory or a belief — and it needs your approval.",
        rows: (promotions || []).map(p => ({
          id: p.id, title: p.target || "promotion", detail: p.reason ? String(p.reason).slice(0, 160) : null,
          atMs: p.created_date ? Date.parse(p.created_date) : null
        }))
      }
    ];
    const totals = [
      Number(awaitingN[0]?.n || 0),
      Number(stagedN[0]?.n || 0),
      Number(noticesN[0]?.n || 0),
      Number(parkedN[0]?.n || 0),
      Number(promotionsN[0]?.n || 0)
    ];
    groups.forEach((group, i) => {
      group.count = totals[i];
      group.truncated = group.count > group.rows.length;
    });

    res.json({
      groups,
      total: groups.reduce((n, g) => n + g.count, 0),
      needsAttention: groups.some(g => g.count > 0),
      enabled: config().enabled
    });
  }));

  // --- Phase 25: the conversational resident designer -----------------------
  /**
   * One turn. Stateless: the client holds the transcript and the current draft,
   * and sends both. The response is the next draft plus a short design note.
   *
   * This route is deliberately reachable while autonomy is frozen — designing a
   * resident is how an operator discovers what they want to enable. It writes
   * nothing.
   */
  app.post("/api/autonomy/designer", wrap(async (req, res) => {
    const cfg = config();
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const incomingDraft = req.body?.draft && typeof req.body.draft === "object" ? req.body.draft : null;

    const outcome = await designTurn({
      config: cfg,
      messages,
      draft: incomingDraft,
      logger
    });

    if (!outcome.ok) {
      // A designer failure is a sentence, never a stack trace and never the raw
      // configuration complaint that callLLM throws. The draft the client sent
      // is untouched, so a failed turn costs nothing.
      const status = outcome.code === "empty_conversation" ? 400
        : outcome.code === "no_model_key" || outcome.code === "misconfigured" ? 503 : 502;
      return res.status(status).json({
        error: outcome.message,
        code: outcome.code,
        draft: incomingDraft ? clampDraft(incomingDraft, { config: cfg }).draft : emptyDraft()
      });
    }

    res.json({
      draft: outcome.draft,
      reply: outcome.reply,
      questions: outcome.questions,
      adjustments: outcome.adjustments,
      droppedSkills: outcome.droppedSkills,
      ignoredFields: outcome.ignoredFields,
      limits: DESIGNER_LIMITS,
      frozen: cfg.enabled !== true,
      note: cfg.enabled !== true
        ? "Nothing was created — and nothing can be created until autonomy is on. Design first, enable, then create."
        : "Nothing was created. Review the draft, then create it."
    });
  }));

  /**
   * CREATE FROM A DRAFT. The explicit click, and the only thing in the designer
   * that writes.
   *
   * The draft is clamped AGAIN here rather than trusted because it arrived from
   * a browser: whatever the client holds could have been edited between turns.
   * Re-clamping server-side is what makes "budgets only ever clamp down" true of
   * the row that is written, not just of the row that was displayed.
   *
   * The resident is created exactly as the manual form creates it, and the first
   * goal (if asked for) lands in awaiting_authorization — it does no work until
   * the operator authorizes its scope and budget.
   */
  app.post("/api/autonomy/designer/create", wrap(async (req, res) => {
    // Creation is rare and it writes, so it reads the switch fresh rather than
    // trusting this process's cache.
    await refreshSettings(db);
    const cfg = config();
    if (cfg.enabled !== true) {
      return res.status(409).json({
        error: cfg.canToggleFromUi
          ? "Autonomy is off, so the resident cannot be created yet. Turn it on with the switch at the top of this page and create it again — your draft is kept."
          : `Autonomy is off, so the resident cannot be created yet. An operator has to enable it (${AUTONOMY_PIN_ENV}=true, or delegate the switch with ${AUTONOMY_UI_CONTROL_ENV}=true). Your draft is kept.`,
        code: "autonomy_disabled",
        canToggleFromUi: cfg.canToggleFromUi,
        draft: clampDraft(req.body?.draft || {}, { config: cfg }).draft
      });
    }

    const clamped = clampDraft(req.body?.draft || {}, { config: cfg });
    const draft = clamped.draft;
    if (!draft.complete) {
      return res.status(400).json({
        error: "The draft has no name yet, so there is nothing to create.",
        code: "incomplete_draft", draft, adjustments: clamped.adjustments
      });
    }

    const ws = await db.Workspace.ensureDefault();
    const slug = draft.slug || slugify(draft.name);
    if (!slug) return res.status(400).json({ error: "The draft needs a name that produces a slug.", code: "incomplete_draft" });

    // A slug already in use is a refusal in words, not a unique-index violation
    // surfacing as a 500. This is likelier from the designer than from the form:
    // the model proposes sensible names, and "Agenda Watcher" is a sensible name
    // twice. The draft comes back so the operator can rename it in the same
    // conversation instead of starting over.
    const existingVersion = await db.AutonomyAgent.latestVersion(ws.id, slug);
    if (existingVersion > 0) {
      return res.status(409).json({
        error: `A resident called “${slug}” already exists. Ask the designer for a different name, or edit that resident's brief instead — a brief change is a new version, never an overwrite.`,
        code: "slug_taken",
        slug,
        draft
      });
    }

    // Phase 27 — webhook destination grants, resolved BEFORE anything writes.
    // grant_destinations is the operator's own list (never the model's draft),
    // so it is refused with named reasons rather than clamped: every refusal
    // returns the draft untouched, so a bad click costs nothing.
    let webhookDestinations = [];
    if (req.body?.grant_destinations !== undefined && req.body?.grant_destinations !== null) {
      if (!Array.isArray(req.body.grant_destinations)) {
        return invalidGrantResponse(res, ["grant_destinations must be a list — the webhook destinations this first goal may POST to"], { draft });
      }
      const check = validateDestinationGrant(req.body.grant_destinations);
      if (!check.ok) return invalidGrantResponse(res, check.errors, { draft });
      webhookDestinations = check.destinations;
    }
    if (webhookDestinations.length && req.body?.create_first_goal !== true) {
      return res.status(400).json({
        error: "Webhook destinations are granted into the first goal's scope — but this create does not make one. "
          + "Create the first goal too, or drop the destinations. Nothing was created.",
        code: "grant_without_goal",
        draft
      });
    }
    if (webhookDestinations.length && !(draft.skills || []).includes("webhook.post")) {
      // The skill could not survive the clamp (rungs are read, not faked) or
      // was never in the draft: either way a grant without the skill is a key
      // nobody can use, and naming WHY is the refusal that teaches.
      const dropped = clamped.droppedSkills.find(d => d.id === "webhook.post");
      return res.status(400).json({
        error: "Webhook destinations were named, but this resident cannot use webhook.post"
          + (dropped ? ` — ${dropped.note}` : ": it is not in the draft's skill allowlist.")
          + " A grant with no skill to use it earns nothing. Name the skill if it can run here, or drop the destinations. Nothing was created.",
        code: "grant_without_skill",
        draft
      });
    }

    const version = existingVersion + 1;
    const conversation = await db.Conversation.create({
      workspace_id: ws.id, title: draft.name.slice(0, 50), last_message_preview: ""
    });

    const agent = await db.AutonomyAgent.create({
      workspace_id: ws.id,
      name: draft.name,
      slug,
      purpose: draft.purpose || null,
      brief: draft.brief,
      brief_version: version,
      skill_allowlist: draft.skills,
      conversation_id: conversation?.id || null,
      default_budgets: draft.budget,
      heartbeat_interval_ms: draft.heartbeatMs,
      enabled: req.body?.enabled !== false
    });

    let goal = null;
    let hashes = null;
    if (req.body?.create_first_goal === true && draft.firstGoal) {
      // Notify is always inside the scope the operator authorizes. Proposed
      // URLs become urlAllowlist + external_read only when the operator ticks
      // them here — a draft URL is not a grant, and a URL the clamp dropped
      // cannot be smuggled back in through grant_urls.
      // Phase 27: webhook destinations likewise become a write grant only from
      // the operator's own list, validated above — looking somewhere and
      // acting there stay different authorities.
      const proposed = new Set(draft.proposedUrls || []);
      const selected = clampProposedUrls(req.body?.grant_urls).filter(url => proposed.has(url));
      const scope = firstGoalScope({ skills: draft.skills, grantUrls: selected, webhookDestinations });
      goal = await db.AutonomyGoal.create({
        workspace_id: ws.id,
        agent_id: agent.id,
        conversation_id: agent.conversation_id,
        title: draft.firstGoal.title,
        objective: draft.firstGoal.objective,
        status: "awaiting_authorization",
        scope,
        budget: draft.budget,
        schedule: { kind: "heartbeat", intervalMs: draft.heartbeatMs }
      });
      hashes = scopeHashes({ goalId: goal.id, scope, budget: draft.budget });
      await db.GoalEvent.append({
        goal_id: goal.id, agent_id: agent.id,
        event_type: "goal_created", to_status: "awaiting_authorization",
        detail: { title: draft.firstGoal.title, origin: "designer", ...hashes }
      });
    }

    // Phase 26 — forgo goal authorization. The designer's first goal goes
    // straight to active when the switch is on; the record is the same as a
    // human authorize except decision_source 'auto'.
    let authorization = null;
    if (goal && cfg.settings.autoAuthorize === true) {
      const out = await autoAuthorizeGoal(db, goal);
      goal = out.goal;
      authorization = out.authorization;
    }

    await db.WorkspaceAudit.append({
      workspaceId: ws.id,
      action: "autonomy.resident_designed",
      resourceId: agent.id,
      detail: {
        slug, skills: draft.skills, droppedSkills: clamped.droppedSkills.map(d => d.id),
        firstGoal: goal?.id || null, via: "designer",
        autoAuthorized: authorization ? true : false
      }
    }).catch(() => {});

    res.status(201).json({
      agent, goal, hashes,
      authorization,
      droppedSkills: clamped.droppedSkills,
      adjustments: clamped.adjustments,
      status: goal ? (authorization ? "active" : "awaiting_authorization") : "created",
      note: goal
        ? (authorization
          ? "Created and auto-authorized — forgo goal authorization is on. Every staged effect still waits for its own approval."
          : "Created. Its first goal is waiting for your authorization — it does no work until you give it.")
        : "Created."
    });
  }));

  // --- Residents ------------------------------------------------------------
  /** One row per resident: the CURRENT version of each brief. */
  app.get("/api/autonomy/agents", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.AutonomyAgent.listCurrent(ws.id, 100);
    res.json(rows.map(a => ({
      id: a.id, name: a.name, slug: a.slug, purpose: a.purpose,
      brief: a.brief, brief_version: a.brief_version, supersedes_id: a.supersedes_id,
      skill_allowlist: parseJson(a.skill_allowlist, []),
      conversation_id: a.conversation_id,
      heartbeat_interval_ms: Number(a.heartbeat_interval_ms),
      enabled: a.enabled === true, created_date: a.created_date
    })));
  }));

  app.get("/api/autonomy/agents/:id", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const agent = await db.AutonomyAgent.get(req.params.id);
    if (!agent || agent.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Resident not found in this workspace" });
    }
    res.json({ agent, history: await db.AutonomyAgent.history(agent.id) });
  }));

  app.post("/api/autonomy/agents", wrap(async (req, res) => {
    if (config().enabled !== true) {
      return res.status(409).json({ error: frozenError(), code: "autonomy_disabled" });
    }
    const ws = await db.Workspace.ensureDefault();
    const name = safe(req.body?.name, 80);
    const slug = safe(req.body?.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), 60);
    if (!name || !slug) return res.status(400).json({ error: "name and slug are required" });

    // A brief is operating text, never identity, and it cannot grant a skill:
    // the allowlist below is the ceiling regardless of what the brief says.
    const allowlist = Array.isArray(req.body?.skill_allowlist) ? req.body.skill_allowlist : [];
    const version = (await db.AutonomyAgent.latestVersion(ws.id, slug)) + 1;

    let conversationId = req.body?.conversation_id || null;
    if (!conversationId) {
      const conversation = await db.Conversation.create({
        workspace_id: ws.id,
        title: name.slice(0, 50),
        last_message_preview: ""
      });
      conversationId = conversation.id;
    }

    const agent = await db.AutonomyAgent.create({
      workspace_id: ws.id,
      name, slug,
      purpose: safe(req.body?.purpose, 240) || null,
      brief: String(req.body?.brief || "").slice(0, 8000),
      brief_version: version,
      skill_allowlist: allowlist,
      conversation_id: conversationId,
      default_scope: req.body?.default_scope || {},
      default_budgets: req.body?.default_budgets || {},
      heartbeat_interval_ms: Number(req.body?.heartbeat_interval_ms) || 900_000,
      enabled: req.body?.enabled === true
    });
    res.status(201).json(agent);
  }));

  app.delete("/api/autonomy/agents/:id", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const agent = await db.AutonomyAgent.get(req.params.id);
    if (!agent || agent.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Resident not found in this workspace" });
    }
    await db.AutonomyAgent.remove(agent.id);
    res.json({ deleted: true, id: agent.id });
  }));

  /**
   * A brief change is a NEW VERSION, never an edit. The previous row stays, so
   * the record always shows what the resident was actually told when it did
   * the thing you are looking at (pin.resident_brief_subordinate).
   */
  app.patch("/api/autonomy/agents/:id", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const agent = await db.AutonomyAgent.get(req.params.id);
    if (!agent || agent.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Resident not found in this workspace" });
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "brief")) {
      const updated = await db.AutonomyAgent.createVersion({
        agent,
        brief: String(req.body.brief || "").slice(0, 8000),
        patch: req.body.patch || {}
      });
      return res.json({ versioned: true, agent: updated, supersedes: agent.id });
    }
    const updated = await db.AutonomyAgent.update(agent.id, req.body || {});
    res.json({ versioned: false, agent: updated });
  }));

  // --- Goals ----------------------------------------------------------------
  app.get("/api/autonomy/goals", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.AutonomyGoal.list(ws.id, {
      status: req.query.status || null,
      agentId: req.query.agentId || null,
      limit: req.query.limit
    });
    res.json(rows.map(g => ({
      id: g.id, agent_id: g.agent_id, conversation_id: g.conversation_id,
      project_id: g.project_id, title: g.title, objective: g.objective,
      status: g.status, park_reason: g.park_reason,
      scope: parseJson(g.scope, {}), budget: parseJson(g.budget, {}),
      spent: parseJson(g.spent, {}),
      next_run_at_ms: g.next_run_at_ms === null ? null : Number(g.next_run_at_ms),
      created_date: g.created_date, updated_date: g.updated_date
    })));
  }));

  app.get("/api/autonomy/goals/:id", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const goal = await db.AutonomyGoal.get(req.params.id);
    if (!goal || goal.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Goal not found in this workspace" });
    }
    const [events, steps, notes, approvals, outbox, subagents, promotions] = await Promise.all([
      db.GoalEvent.list(goal.id, 300),
      db.GoalStep.list(goal.id, 300),
      db.GoalNote.list(goal.id, 300),
      db.GoalAuthorization.list(goal.id),
      db.AutonomyOutbox.list(ws.id, { goalId: goal.id, limit: 100 }),
      db.GoalSubagent.list(goal.id, 100),
      db.NotePromotion.list(ws.id, { goalId: goal.id, limit: 100 })
    ]);
    res.json({ goal, events, steps, notes, approvals, outbox, subagents, promotions });
  }));

  app.post("/api/autonomy/goals", wrap(async (req, res) => {
    if (config().enabled !== true) {
      return res.status(409).json({ error: frozenError(), code: "autonomy_disabled" });
    }
    const ws = await db.Workspace.ensureDefault();
    const title = safe(req.body?.title, 120);
    const objective = String(req.body?.objective || "").slice(0, 10_000);
    if (!title || !objective) return res.status(400).json({ error: "title and objective are required" });

    let agent = null;
    if (req.body?.agent_id) {
      agent = await db.AutonomyAgent.get(req.body.agent_id);
      if (!agent || agent.workspace_id !== ws.id) {
        return res.status(404).json({ error: "Resident not found in this workspace" });
      }
    }

    const cfg = config();
    const budget = { ...cfg.goalBudget, ...parseJson(agent?.default_budgets, {}), ...(req.body?.budget || {}) };
    // A goal that cannot report is a goal that fails silently — you authorize
    // it and then hear nothing when it parks or finishes. Notices are templated
    // and carry no model prose, so the low-risk reporting channel is on by
    // default. It sits inside the scope the operator authorizes, so it is
    // VISIBLE in the authorization and can be removed before consent.
    const scope = {
      effectsAllowed: ["notify"],
      ...parseJson(agent?.default_scope, {}),
      ...(req.body?.scope || {})
    };

    // Phase 27 — the destination grant is the key the shadow corpus is earned
    // with, and it is malformed before it is ever judged. Refuse it with every
    // bad entry named, at the one moment it can still be corrected.
    const grantProblems = destinationGrantProblems(scope);
    if (grantProblems.length) return invalidGrantResponse(res, grantProblems);

    const goal = await db.AutonomyGoal.create({
      workspace_id: ws.id,
      agent_id: agent?.id || null,
      conversation_id: req.body?.conversation_id || agent?.conversation_id || null,
      project_id: req.body?.project_id || null,
      title, objective,
      status: "awaiting_authorization",
      scope, budget,
      schedule: { kind: "heartbeat", intervalMs: Number(agent?.heartbeat_interval_ms || cfg.tick.intervalMs) }
    });

    const hashes = scopeHashes({ goalId: goal.id, scope, budget });
    await db.GoalEvent.append({
      goal_id: goal.id, agent_id: agent?.id || null,
      event_type: "goal_created", to_status: "awaiting_authorization",
      detail: { title, ...hashes }
    });

    // Phase 26 — forgo goal authorization. When delegated AND on, the goal is
    // authorized here instead of waiting; the record is identical to a human
    // authorize except decision_source 'auto'. The resting state is unchanged.
    if (cfg.settings.autoAuthorize === true) {
      const out = await autoAuthorizeGoal(db, goal);
      return res.status(201).json({
        goal: out.goal, hashes, authorization: out.authorization, status: "active",
        note: "Auto-authorized: forgo goal authorization is on. The scope and budget hashes are recorded, and every staged effect still waits for its own approval."
      });
    }
    res.status(201).json({ goal, hashes, status: "awaiting_authorization" });
  }));

  /**
   * THE BARRIER. A goal does no work until this records consent with the
   * hashes of the exact scope and budget it was authorized under. Widening
   * either is a new decision — never an edit (pin.goal_scope_immutable).
   */
  app.post("/api/autonomy/goals/:id/decision", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const goal = await db.AutonomyGoal.get(req.params.id);
    if (!goal || goal.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Goal not found in this workspace" });
    }
    const decision = String(req.body?.decision || "").trim().toLowerCase();
    const reason = safe(req.body?.reason, 300) || null;

    if (["pause", "resume", "cancel"].includes(decision)) {
      const next = decision === "pause" ? "parked"
        : decision === "resume" ? "active" : "cancelled";
      if (next === "active" && !(await db.GoalAuthorization.current(goal.id, Date.now()))) {
        return res.status(409).json({ error: "A cancelled or unauthorized goal cannot be resumed; authorize it again" });
      }
      const row = await db.AutonomyGoal.setStatus(goal.id, {
        status: next,
        parkReason: decision === "pause" ? "paused_by_user" : null,
        endedMs: decision === "cancel" ? Date.now() : null
      });
      await db.GoalEvent.append({
        goal_id: goal.id, event_type: `goal_${decision}d`,
        from_status: goal.status, to_status: next, detail: { reason }
      });
      return res.json({ goal: row, decision });
    }

    if (!["authorize", "decline"].includes(decision)) {
      return res.status(400).json({ error: "decision must be authorize, decline, pause, resume or cancel" });
    }
    if (goal.status !== "awaiting_authorization" && decision === "authorize") {
      return res.status(409).json({ error: `This goal is ${goal.status}; only an awaiting_authorization goal can be authorized` });
    }

    const scope = parseJson(goal.scope, {});
    const budget = parseJson(goal.budget, {});
    const hashes = scopeHashes({ goalId: goal.id, scope, budget });

    const row = await db.GoalAuthorization.append({
      goal_id: goal.id,
      scope_sha256: hashes.scopeSha256,
      budget_sha256: hashes.budgetSha256,
      decision,
      reason,
      decided_ms: Date.now(),
      expires_at_ms: req.body?.expires_at_ms ? Number(req.body.expires_at_ms) : null,
      decision_source: req.body?.decision_source === "pairing_token" ? "pairing_token" : "app"
    });

    if (decision === "decline") {
      const updated = await db.AutonomyGoal.setStatus(goal.id, {
        status: "cancelled", parkReason: "awaiting_approval", endedMs: Date.now()
      });
      await db.GoalEvent.append({
        goal_id: goal.id, event_type: "goal_declined",
        from_status: goal.status, to_status: "cancelled", detail: { reason }
      });
      return res.json({ goal: updated, authorization: row, executed: false });
    }

    // started_ms is stamped on the first activation and never moved, so the
    // wall-clock budget has something to measure.
    const updated = await db.AutonomyGoal.setStatus(goal.id, {
      status: "active", parkReason: null, startedMs: Date.now()
    });
    await db.AutonomyGoal.nextRunAt(goal.id, Date.now());
    await db.GoalEvent.append({
      goal_id: goal.id, event_type: "goal_authorized",
      from_status: goal.status, to_status: "active",
      detail: { reason, ...hashes }
    });
    res.json({ goal: updated, authorization: row });
  }));

  // --- Notices --------------------------------------------------------------
  app.get("/api/autonomy/notices", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const rows = await db.AutonomyNotice.listUnread(ws.id, req.query.limit);
    res.json(rows.map(publicNotice));
  }));

  app.post("/api/autonomy/notices/:id/ack", wrap(async (req, res) => {
    const row = await db.AutonomyNotice.ack(req.params.id);
    if (!row) return res.status(404).json({ error: "Notice not found" });
    res.json(publicNotice(row));
  }));

  // --- Outbox ---------------------------------------------------------------
  app.get("/api/autonomy/outbox", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const [rows, corpus] = await Promise.all([
      db.AutonomyOutbox.list(ws.id, {
        goalId: req.query.goalId || null,
        status: req.query.status || null,
        tier: req.query.tier || null,
        effectType: req.query.effectType || null,
        destination: req.query.destination || null,
        limit: req.query.limit
      }),
      shadowCorpus(db, ws.id)
    ]);
    res.json({ effects: rows, corpus });
  }));

  // --- Rungs (Phase 21): what is built, what is switched on, and what has been
  // EARNED. Three different questions, so three different fields. The evidence
  // measurement is the expensive one (it reads the corpus), which is why the
  // status route reports only the recorded rows and this route re-measures.
  app.get("/api/autonomy/rungs", wrap(async (req, res) => {
    const cfg = config();
    const ws = await db.Workspace.ensureDefault();
    const rungs = [];
    for (const rung of RUNG_IDS) {
      rungs.push(await rungEvidenceStatus({ db, workspaceId: ws.id, rung, config: cfg }));
    }
    // Phase 22 (autonomy row) — the fourth question this surface has to answer.
    // Built, switched on and earned are three facts about the rung; whether a
    // flip to LIVE would be accepted right now is a fourth, and it is the one an
    // operator needs before clicking rather than after a refused delivery.
    const live = await describeLiveReadiness({ db, workspaceId: ws.id, config: cfg });
    res.json({
      rungs,
      outboxMode: cfg.outboxMode,
      outboxModeSource: cfg.outboxModeSource,
      canSetOutboxMode: cfg.settings?.canSetOutboxMode === true,
      outboxRefusal: cfg.settings?.outboxRefusal || null,
      gate: cfg.shadow,
      enabled: cfg.enabled,
      liveDestination: live.destination,
      live,
      note: live.note
    });
  }));

  /**
   * Record the shadow corpus as an evidence row. Append-only: re-measuring
   * writes a new row, so "what did we know when we turned this on" stays
   * answerable. A measurement that does not satisfy the gate is recorded too,
   * as `insufficient` — a failed gate with no record is a gate nobody can
   * prove was ever checked.
   */
  app.post("/api/autonomy/rungs/:rung/evidence", wrap(async (req, res) => {
    if (config().enabled !== true) {
      return res.status(409).json({ error: `${frozenError()} There is also no corpus to measure.`, code: "autonomy_disabled" });
    }
    const rung = String(req.params.rung || "").trim();
    if (!RUNG_IDS.includes(rung)) {
      return res.status(404).json({ error: `Unknown rung. Known rungs: ${RUNG_IDS.join(", ")}` });
    }
    const ws = await db.Workspace.ensureDefault();
    const out = await recordRungEvidence({
      db, workspaceId: ws.id, rung, config: config(),
      decidedBy: safe(req.body?.decided_by, 60) || "operator",
      reason: safe(req.body?.reason, 300) || null
    });
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.status(201).json({
      rung: out.rung, tier: out.tier, decision: out.decision,
      satisfied: out.satisfied, reasons: out.reasons,
      gate: out.gate, metrics: out.metrics, metricsSha256: out.metricsSha256,
      evidence: out.row,
      note: out.decision === "justified"
        ? "Recorded. A live release at this tier now passes the evidence gate — the rung flag and the Governor's per-effect verdicts still apply."
        : "Recorded as insufficient. Nothing is enabled by this row; it is the history of having asked."
    });
  }));

  app.post("/api/autonomy/outbox/:id/decision", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const effect = await db.AutonomyOutbox.get(req.params.id);
    if (!effect || effect.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Effect not found in this workspace" });
    }
    const decision = String(req.body?.decision || "").trim().toLowerCase();

    if (decision === "revert") {
      const out = await revertEffect({ db, effectId: effect.id, reason: req.body?.reason });
      return res.json(out);
    }
    if (decision === "refuse") {
      // A human refusal is its own recorded rule, not a Governor verdict
      // manufactured by withdrawing the authorization.
      const out = await refuseEffect({
        db, effectId: effect.id,
        reason: safe(req.body?.reason, 300) || null,
        decidedBy: "operator"
      });
      if (!out.ok) return res.status(409).json({ error: out.error });
      return res.json(out);
    }
    if (decision !== "approve") {
      return res.status(400).json({ error: "decision must be approve, refuse or revert" });
    }

    const goal = effect.goal_id ? await db.AutonomyGoal.get(effect.goal_id) : null;
    if (!goal) return res.status(409).json({ error: "This effect has no goal" });

    const cfg = config();
    // Approving an external write in a deployment that has not switched the
    // rung on would be a button that does nothing but look like it worked. Say
    // so instead, and leave the row staged and judged.
    if (effect.tier === "T4" && cfg.rung.externalWrites !== true) {
      return res.status(409).json({
        error: "Rung 4 (external writes) is off. Set COGNOS_AUTONOMY_EXTERNAL_WRITES=true to make an approval mean anything; the effect stays staged and judged in shadow.",
        tier: effect.tier,
        killSwitch: "COGNOS_AUTONOMY_EXTERNAL_WRITES"
      });
    }
    // T5 is the one tier where an approval is not optional: an irreversible
    // effect has no class authorization, so the rung switch is necessary and
    // never sufficient. Approving while the rung is off would be a button that
    // looks like it worked; say so instead, and leave the row staged and judged.
    if (effect.tier === "T5" && cfg.rung.irreversible !== true) {
      return res.status(409).json({
        error: "Rung 6 (irreversible acts) is off. Set COGNOS_AUTONOMY_IRREVERSIBLE=true to make an approval mean anything; the effect stays staged and judged in shadow, and even then it releases only by a per-effect human approval naming this exact row.",
        tier: effect.tier,
        killSwitch: "COGNOS_AUTONOMY_IRREVERSIBLE"
      });
    }

    const authorization = await db.GoalAuthorization.current(goal.id, Date.now());
    if (!authorization) return res.status(409).json({ error: "The goal has no unexpired authorization" });

    const scope = parseJson(goal.scope, {});
    const budget = parseJson(goal.budget, {});
    if (!authorizationCovers(authorization, { goalId: goal.id, scope, budget })) {
      return res.status(409).json({
        error: "The goal's scope or budget changed since authorization; re-authorize it"
      });
    }

    // Phase 22 (autonomy row) — per-effect human approval. Recorded BEFORE the
    // decision because the Action Governor's T5 rule is "a human approval row
    // names this exact outbox id". The row is append-only and the only writer
    // is this route, so the loop can never approve itself.
    if (effect.tier === "T5") {
      await db.EffectApproval.append({
        workspace_id: ws.id,
        outbox_id: effect.id,
        goal_id: goal.id,
        agent_id: effect.agent_id || null,
        decision: "approve",
        scope_sha256: authorization?.scope_sha256 || null,
        reason: safe(req.body?.reason, 300) || null,
        decided_by: "operator"
      });
    }

    const out = await decideEffect({
      db, effectId: effect.id, goal, authorization, config: cfg, mode: "live"
    });
    // An already-judged row replays its verdict instead of acting again. For a
    // DELIVERED effect that is the right answer — the receipt is idempotent, and
    // a second approval must not mean a second send. For every other terminal
    // state a 200 would read as "approved and sent" when what happened is
    // "already decided in shadow, performed nothing", which is the one thing an
    // operator clicking approve on Rung 4 must not be allowed to believe.
    if (out?.replayed && out?.row?.status !== "released") {
      return res.status(409).json({
        error: `This effect was already judged '${out.row.status}' and this approval delivered nothing. `
          + (out.row.status === "would_release"
            ? "It was judged in shadow or dry-run mode, where a release verdict is recorded and not performed. For an approval to send, widen the outbox to live — earn it with a recorded evidence row and an approved destination, then flip it on the Outbox tab (or set COGNOS_AUTONOMY_OUTBOX_MODE=live and restart) — or refuse/revert this row."
            : "A terminal row is not re-decidable: refuse or revert it, or let the loop stage a new effect."),
        replayed: true,
        row: out.row,
        verdict: out.verdict
      });
    }
    if (out?.replayed) {
      // Delivered already: return the receipt, and say that it is the earlier
      // delivery being reported rather than a new one.
      return res.json({ ...out, replayed: true });
    }
    // An approval is a request, not a guarantee: the Action Governor still
    // judges the effect, and a refusal is a 409 naming the rules rather than a
    // 200 with a refused row buried in the body.
    if (out?.row?.status === "refused") {
      return res.status(409).json({
        error: `The Action Governor refused this effect: ${(out.verdict?.failed || []).map(f => f.rule).join(", ")}`,
        verdict: out.verdict,
        row: out.row
      });
    }
    if (out?.row?.status === "failed") {
      return res.status(502).json({
        error: out.error || "The delivery failed; the row records what was attempted",
        row: out.row,
        verdict: out.verdict
      });
    }
    res.json(out);
  }));

  // --- Ticks ----------------------------------------------------------------
  // --- Promotions (Phase 20): the human-confirm half of the promotion path --
  // Listing is always visible; deciding needs autonomy on, because an approval
  // applies a knowledge write the moment it lands.
  app.get("/api/autonomy/promotions", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    const status = typeof req.query?.status === "string" && req.query.status ? req.query.status : null;
    const goalId = typeof req.query?.goalId === "string" && req.query.goalId ? req.query.goalId : null;
    const rows = await db.NotePromotion.list(ws.id, { status, goalId, limit: 100 });
    // Join the note and goal each request points at, so the queue renders
    // without N+1. A secret-refused row shows its reason but never its body:
    // the row's whole point is that the text must not move.
    const out = [];
    for (const row of rows || []) {
      const [goal, notes] = await Promise.all([
        db.AutonomyGoal.get(row.goal_id),
        db.GoalNote.list(row.goal_id, 500)
      ]);
      const note = (notes || []).find(n => n.id === row.note_id) || null;
      const secretRefused = row.status === "refused" && String(row.reason || "").startsWith("secret");
      out.push({
        ...row,
        goal_title: goal?.title || null,
        note_ordinal: note?.ordinal ?? null,
        note_kind: note?.kind || null,
        note_body: note && !secretRefused ? String(note.body || "").slice(0, 2000) : null,
        redacted: secretRefused
      });
    }
    res.json(out);
  }));

  app.post("/api/autonomy/promotions/:id/decide", wrap(async (req, res) => {
    if (config().enabled !== true) {
      return res.status(409).json({ error: frozenError(), code: "autonomy_disabled" });
    }
    const ws = await db.Workspace.ensureDefault();
    const row = await db.NotePromotion.get(req.params.id);
    if (!row || row.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Promotion not found in this workspace" });
    }
    const decision = String(req.body?.decision || "").trim().toLowerCase();
    if (!["approve", "refuse"].includes(decision)) {
      return res.status(400).json({ error: "decision must be approve or refuse" });
    }
    const outcome = await decidePromotion({
      db, promotionId: row.id, decision,
      reason: safe(req.body?.reason, 300) || null, actor: "app"
    });
    if (!outcome.ok) {
      return res.status(409).json({ error: outcome.error, status: outcome.status || row.status });
    }
    await db.GoalEvent.append({
      goal_id: row.goal_id, event_type: "promotion_decided",
      detail: { promotionId: row.id, decision, target: row.target, status: outcome.status,
        memoryId: outcome.memoryId || null, beliefId: outcome.beliefId || null }
    });
    res.json({ promotion: await db.NotePromotion.get(row.id), status: outcome.status,
      memoryId: outcome.memoryId || null, beliefId: outcome.beliefId || null });
  }));

  app.get("/api/autonomy/ticks", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    res.json(await db.AutonomyTick.list(ws.id, req.query.limit));
  }));

  /** Run one slice now. Operator surface and the cron fallback. */
  app.post("/api/autonomy/tick", wrap(async (req, res) => {
    // ALWAYS re-read here, not merely ensure-loaded. This is the route that acts
    // on the switch, and the dangerous direction is a stale "on": an operator
    // turns autonomy off and a cron tick on another instance keeps running. One
    // indexed single-row SELECT per tick is a fair price for that, and a host
    // with no heartbeat (Vercel, cron-driven) has nothing else that would read
    // the row at all.
    await refreshSettings(db);
    const cfg = config();
    if (cfg.enabled !== true) {
      return res.json({
        frozen: true, goalsClaimed: 0, stepsExecuted: 0,
        note: `${frozenError()} Nothing ran.`
      });
    }
    const result = await runTick({
      db, config: cfg,
      workerId: req.body?.workerId || "http",
      sliceMs: req.body?.sliceMs ? Number(req.body.sliceMs) : null,
      maxGoals: req.body?.maxGoals ? Number(req.body.maxGoals) : null
    });
    res.json(result);
  }));
}
