// Phase 15 route module — read-only meta-cognition plus the Policy gate.

import { LAWS, LAW_LAYER_VERSION, describeLaws, assertLawLayerImmutable } from "../council/laws.js";
import { proposeAdaptation, describePolicy } from "../meta/policy.js";
import { CANONICAL_STRATEGY_ID, listStrategies, recordEvidenceFromTelemetry, describeRegistryCheck } from "../meta/strategies.js";
import { resolveAdaptiveMode, SWITCH_THRESHOLDS, evaluateSwitch } from "../meta/adaptive.js";
import { describeRateTable } from "../meta/rates.js";
import { runDetail } from "../meta/telemetry.js";
import { num } from "../db/util.js";
import { parseInstant as parseAt } from "../http/query.js";

export function registerMetaRoutes(app, { wrap, db, logger, getSystemConfig }) {
  // ===========================================================================
  // Phase 15 — Meta-Cognition. The system studying its own reasoning.
  // ===========================================================================

  app.get("/api/meta/telemetry", wrap(async (req, res) => {
    const ws = await db.Workspace.ensureDefault();
    if (req.query.summary) {
      const [summary, strategies] = await Promise.all([
        db.TelemetryRun.summary({ workspaceId: ws.id, sinceMs: parseAt(req.query.since) }),
        listStrategies(db, { logger })
      ]);
      return res.json({ summary, strategies, thresholds: SWITCH_THRESHOLDS, switchAnalysis: evaluateSwitch({ baseline: summary[0], candidate: summary[1] }) });
    }
    const rows = await db.TelemetryRun.recent({
      limit: Number(req.query.limit || 50),
      status: req.query.status || null,
      conversationId: req.query.conversationId || null,
      workspaceId: req.query.scope === "all" ? null : ws.id
    });
    res.json({
      count: rows.length,
      runs: rows.map(r => ({
        ...r,
        cost_usd: num(r.cost_usd),
        confidence: num(r.confidence),
        stages: r.stages || null,
        failures: r.failures || [],
        adaptive: r.adaptive || null
      }))
    });
  }));

  app.get("/api/meta/telemetry/:runId", wrap(async (req, res) => {
    const detail = await runDetail(db, req.params.runId);
    if (!detail) return res.status(404).json({ error: "No telemetry record for that run" });
    res.json({ ...detail, cost_usd: num(detail.cost_usd), confidence: num(detail.confidence) });
  }));

  app.get("/api/meta/model-calls", wrap(async (req, res) => {
    const rows = await db.TelemetryModelCall.recent({ limit: Number(req.query.limit || 100), status: req.query.status || null });
    res.json({ count: rows.length, calls: rows.map(c => ({ ...c, cost_usd: num(c.cost_usd) })) });
  }));

  app.get("/api/meta/strategies", wrap(async (req, res) => {
    const strategies = await listStrategies(db, { logger });
    const evidence = await recordEvidenceFromTelemetry(db, { logger }).catch(() => []);
    res.json({ count: strategies.length, seededWithOneRow: strategies.length === 1, strategies, refreshedEvidence: evidence });
  }));

  app.get("/api/meta/registry-check", wrap(async (req, res) => {
    res.json(describeRegistryCheck());
  }));

  app.get("/api/meta/laws", wrap(async (req, res) => {
    res.json({
      version: LAW_LAYER_VERSION,
      count: LAWS.length,
      runtimeModifiable: false,
      immutabilityCheck: assertLawLayerImmutable(),
      laws: describeLaws()
    });
  }));

  app.get("/api/meta/policy", wrap(async (req, res) => {
    res.json(describePolicy());
  }));

  app.get("/api/meta/improvements", wrap(async (req, res) => {
    const rows = await db.ImprovementLedger.recent({ limit: Number(req.query.limit || 100), decision: req.query.decision || null, action: req.query.action || null });
    res.json({ count: rows.length, appendOnly: true, improvements: rows });
  }));

  /**
   * The gate. Every architectural adaptation is judged against the law layer and
   * the judgment is appended to the Improvement Ledger — refusals included.
   * A refusal answers 409 with the laws it violated; that is the answer, not an
   * error. In v1 an approved adaptation is authorized and recorded: only strategy
   * registry rows are actually applied, because a model change, a schema change or
   * a new subsystem is a reviewed code change, not a runtime mutation.
   */
  app.post("/api/meta/adaptations", wrap(async (req, res) => {
    const proposal = req.body || {};
    const action = String(proposal.action || "");
    const apply = (action === "enable_strategy" || action === "disable_strategy")
      ? async (evaluation) => {
        const id = String(proposal.params?.strategy_id || evaluation.target || "");
        if (!id) return { applied: false, reason: "no strategy_id" };
        if (id === CANONICAL_STRATEGY_ID && action === "disable_strategy") return { applied: false, reason: "refused by pin.single_send_path" };
        const row = await db.Strategy.setEnabled(id, action === "enable_strategy", { policyRef: `policy:${Date.now()}` });
        return row ? { applied: true, strategy: row } : { applied: false, reason: "no such strategy" };
      }
      : null;
    const result = await proposeAdaptation(db, proposal, { logger, apply });
    res.status(result.decision === "refused" ? 409 : 200).json(result);
  }));

  app.get("/api/meta/adaptive", wrap(async (req, res) => {
    const config = getSystemConfig();
    const mode = resolveAdaptiveMode(config.telemetry.requestedAdaptiveMode);
    const rows = await db.AdaptiveDecision.recent(Number(req.query.limit || 50));
    res.json({ mode: mode.mode, requestedMode: mode.requested, forced: mode.forced, law: mode.law, reason: mode.reason, switchedRuns: 0, thresholds: SWITCH_THRESHOLDS, decisions: rows });
  }));

  app.get("/api/meta/evaluations", wrap(async (req, res) => {
    const rows = await db.StrategyEvaluation.recent(Number(req.query.limit || 100));
    const byEvaluation = {};
    for (const r of rows) {
      byEvaluation[r.evaluation_id] = byEvaluation[r.evaluation_id] || [];
      byEvaluation[r.evaluation_id].push({ ...r, score: num(r.score), cost_usd: num(r.cost_usd) });
    }
    res.json({
      count: rows.length,
      note: "Offline and operator-invoked: node scripts/evaluate-strategies.mjs. There is no route that runs an evaluation on a user's turn.",
      evaluations: Object.entries(byEvaluation).map(([id, trials]) => ({ evaluation_id: id, trials }))
    });
  }));

  app.get("/api/meta/rates", wrap(async (req, res) => {
    res.json(describeRateTable());
  }));


}
