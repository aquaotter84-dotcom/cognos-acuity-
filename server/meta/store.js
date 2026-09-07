// Phase 15 store — meta-cognition data access, bound to a query runner.
//
// Same factory shape as the Phase 14 knowledge store: server/db.js binds it once
// to the pool and once per transaction. Append-only tables here (telemetry_runs,
// telemetry_model_calls, adaptive_decisions, improvement_ledger,
// strategy_evaluations) expose no update-or-delete path except the two explicit,
// documented ones: linking a run to the message it produced, and marking an
// improvement as reverted — which is itself a new append-only row.

import { newId, num, int } from "../db/util.js";
import { snapshot, parse } from "../knowledge/events.js";

const json = (v) => (v === null || v === undefined ? null : JSON.stringify(snapshot(v)));

export function createMetaStore(run) {
  return {
    // --- 15.1 reasoning telemetry -----------------------------------------
    TelemetryRun: {
      async create(rec) {
        const rows = await run(
          `INSERT INTO telemetry_runs (
             id, workspace_id, conversation_id, message_id, strategy_id, status, started_ms, ended_ms,
             latency_ms, time_to_first_token_ms, stages, stage_order, models, model_calls,
             tokens_prompt, tokens_completion, tokens_total, tokens_measured, tokens_estimated,
             cost_usd, cost_rate_known, confidence, confidence_source, coherence_verdict,
             coherence_contradictions, vetoed, veto_flags, veto_reason, veto_draft_origin, veto_draft_sha256,
             retries, failures, failure_count, adaptive, ledger_events, knowledge, task_type, complexity,
             response_chars, error_message)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                   $25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40)
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status, ended_ms = EXCLUDED.ended_ms, latency_ms = EXCLUDED.latency_ms,
             time_to_first_token_ms = EXCLUDED.time_to_first_token_ms, stages = EXCLUDED.stages,
             stage_order = EXCLUDED.stage_order, models = EXCLUDED.models, model_calls = EXCLUDED.model_calls,
             tokens_prompt = EXCLUDED.tokens_prompt, tokens_completion = EXCLUDED.tokens_completion,
             tokens_total = EXCLUDED.tokens_total, tokens_measured = EXCLUDED.tokens_measured,
             tokens_estimated = EXCLUDED.tokens_estimated, cost_usd = EXCLUDED.cost_usd,
             cost_rate_known = EXCLUDED.cost_rate_known, confidence = EXCLUDED.confidence,
             confidence_source = EXCLUDED.confidence_source, coherence_verdict = EXCLUDED.coherence_verdict,
             coherence_contradictions = EXCLUDED.coherence_contradictions, vetoed = EXCLUDED.vetoed,
             veto_flags = EXCLUDED.veto_flags, veto_reason = EXCLUDED.veto_reason,
             veto_draft_origin = EXCLUDED.veto_draft_origin, veto_draft_sha256 = EXCLUDED.veto_draft_sha256,
             retries = EXCLUDED.retries, failures = EXCLUDED.failures, failure_count = EXCLUDED.failure_count,
             adaptive = EXCLUDED.adaptive, ledger_events = EXCLUDED.ledger_events, knowledge = EXCLUDED.knowledge,
             task_type = EXCLUDED.task_type, complexity = EXCLUDED.complexity,
             response_chars = EXCLUDED.response_chars, error_message = EXCLUDED.error_message
           RETURNING *`,
          [rec.id, rec.workspace_id ?? null, rec.conversation_id ?? null, rec.message_id ?? null,
           rec.strategy_id || "council_pipeline", rec.status || "success", rec.started_ms, rec.ended_ms ?? null,
           rec.latency_ms ?? null, rec.time_to_first_token_ms ?? null, json(rec.stages ?? {}), json(rec.stage_order ?? []),
           json(rec.models ?? []), int(rec.model_calls, 0),
           int(rec.tokens_prompt, 0), int(rec.tokens_completion, 0), int(rec.tokens_total, 0),
           rec.tokens_measured === true, int(rec.tokens_estimated, 0),
           rec.cost_usd ?? null, rec.cost_rate_known === true, rec.confidence ?? null, rec.confidence_source ?? null,
           rec.coherence_verdict ?? null, int(rec.coherence_contradictions, 0),
           rec.vetoed === true, json(rec.veto_flags ?? null), rec.veto_reason ?? null,
           rec.veto_draft_origin ?? null, rec.veto_draft_sha256 ?? null,
           int(rec.retries, 0), json(rec.failures ?? []), int(rec.failure_count, 0),
           json(rec.adaptive ?? null), int(rec.ledger_events, 0), json(rec.knowledge ?? null),
           rec.task_type ?? null, rec.complexity ?? null, rec.response_chars ?? null, rec.error_message ?? null]
        );
        return rows[0];
      },
      /** Close the lineage loop: the conclusion row now points at its run. */
      async setMessageId(runId, messageId) {
        if (!runId || !messageId) return null;
        const rows = await run(`UPDATE telemetry_runs SET message_id = $1 WHERE id = $2 RETURNING id`, [messageId, runId]);
        return rows[0] || null;
      },
      async get(runId) {
        const rows = await run(`SELECT * FROM telemetry_runs WHERE id = $1`, [runId]);
        return rows[0] || null;
      },
      async withCalls(runId) {
        const rec = await this.get(runId);
        if (!rec) return null;
        return { ...rec, calls: await run(`SELECT * FROM telemetry_model_calls WHERE run_id = $1 ORDER BY seq ASC`, [runId]) };
      },
      async recent({ limit = 50, status = null, conversationId = null, workspaceId = null } = {}) {
        const clauses = [];
        const params = [];
        if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
        if (conversationId) { params.push(conversationId); clauses.push(`conversation_id = $${params.length}`); }
        if (workspaceId) { params.push(workspaceId); clauses.push(`workspace_id = $${params.length}`); }
        params.push(Math.max(1, Math.min(int(limit, 50), 500)));
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        return run(`SELECT * FROM telemetry_runs ${where} ORDER BY started_ms DESC LIMIT $${params.length}`, params);
      },
      /** Aggregate view for /api/meta/telemetry?summary=1 — the numbers the
       *  adaptive orchestrator's evidence thresholds are written against. */
      async summary({ workspaceId = null, sinceMs = null } = {}) {
        const clauses = [];
        const params = [];
        if (workspaceId) { params.push(workspaceId); clauses.push(`workspace_id = $${params.length}`); }
        if (sinceMs) { params.push(Number(sinceMs)); clauses.push(`started_ms >= $${params.length}`); }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const rows = await run(
          `SELECT strategy_id,
                  count(*)::int AS runs,
                  count(*) FILTER (WHERE status = 'success')::int AS successes,
                  count(*) FILTER (WHERE status = 'error')::int AS errors,
                  count(*) FILTER (WHERE vetoed)::int AS vetoes,
                  count(*) FILTER (WHERE failure_count > 0)::int AS with_failures,
                  avg(latency_ms)::numeric AS avg_latency_ms,
                  avg(cost_usd)::numeric AS avg_cost_usd,
                  sum(cost_usd)::numeric AS total_cost_usd,
                  avg(confidence)::numeric AS avg_confidence,
                  sum(coherence_contradictions)::int AS contradictions
             FROM telemetry_runs ${where}
            GROUP BY strategy_id
            ORDER BY runs DESC`,
          params
        );
        return rows.map(r => ({
          strategy_id: r.strategy_id,
          runs: int(r.runs),
          successes: int(r.successes),
          errors: int(r.errors),
          vetoes: int(r.vetoes),
          with_failures: int(r.with_failures),
          veto_rate: int(r.runs) ? Number((int(r.vetoes) / int(r.runs)).toFixed(4)) : 0,
          error_rate: int(r.runs) ? Number((int(r.errors) / int(r.runs)).toFixed(4)) : 0,
          avg_latency_ms: num(r.avg_latency_ms, 0),
          avg_cost_usd: num(r.avg_cost_usd, 0),
          total_cost_usd: num(r.total_cost_usd, 0),
          avg_confidence: num(r.avg_confidence, null),
          contradictions: int(r.contradictions)
        }));
      }
    },

    TelemetryModelCall: {
      async bulkCreate(calls) {
        const list = (calls || []).filter(Boolean);
        if (!list.length) return [];
        const cols = ["id", "run_id", "seq", "stage", "purpose", "model", "requested_model", "status", "http_status",
          "latency_ms", "streamed", "tokens_prompt", "tokens_completion", "tokens_total", "tokens_measured",
          "chars_out", "cost_usd", "error_class", "error_message", "attempt"];
        const values = [];
        const tuples = list.map((c, i) => {
          const base = i * cols.length;
          cols.forEach((col, j) => values.push(c[col] === undefined ? null : c[col]));
          return `(${cols.map((_, j) => `$${base + j + 1}`).join(",")})`;
        });
        return run(`INSERT INTO telemetry_model_calls (${cols.join(", ")}) VALUES ${tuples.join(", ")} RETURNING *`, values);
      },
      forRun: (runId) => run(`SELECT * FROM telemetry_model_calls WHERE run_id = $1 ORDER BY seq ASC`, [runId]),
      async recent({ limit = 100, status = null } = {}) {
        const params = [];
        const clauses = [];
        if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
        params.push(Math.max(1, Math.min(int(limit, 100), 1000)));
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        return run(`SELECT * FROM telemetry_model_calls ${where} ORDER BY created_date DESC LIMIT $${params.length}`, params);
      }
    },

    // --- 15.2 strategy registry -------------------------------------------
    Strategy: {
      async list({ includeDisabled = true } = {}) {
        const where = includeDisabled ? "" : "WHERE enabled = TRUE";
        return run(`SELECT * FROM strategies ${where} ORDER BY is_default DESC, created_date ASC`);
      },
      async get(id) {
        const rows = await run(`SELECT * FROM strategies WHERE id = $1`, [id]);
        return rows[0] || null;
      },
      async getByName(name) {
        const rows = await run(`SELECT * FROM strategies WHERE name = $1`, [name]);
        return rows[0] || null;
      },
      async upsert(strategy) {
        const rows = await run(
          `INSERT INTO strategies (id, name, description, selection_signals, enabled, is_default, evidence, policy_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (name) DO UPDATE SET
             description = EXCLUDED.description,
             selection_signals = EXCLUDED.selection_signals,
             evidence = COALESCE(strategies.evidence, EXCLUDED.evidence),
             updated_date = now()
           RETURNING *`,
          [strategy.id || newId("str"), strategy.name, strategy.description ?? null, json(strategy.selection_signals ?? {}),
           strategy.enabled !== false, strategy.is_default === true, json(strategy.evidence ?? null), strategy.policy_ref ?? null]
        );
        return rows[0];
      },
      /** Only the Policy Engine calls this, and only after a recorded decision. */
      async setEnabled(id, enabled, { policyRef = null } = {}) {
        const rows = await run(
          `UPDATE strategies SET enabled = $1, policy_ref = COALESCE($2, policy_ref), updated_date = now()
            WHERE id = $3 RETURNING *`,
          [enabled === true, policyRef, id]
        );
        return rows[0] || null;
      },
      async recordEvidence(id, evidence) {
        const rows = await run(`UPDATE strategies SET evidence = $1, updated_date = now() WHERE id = $2 RETURNING *`, [json(evidence), id]);
        return rows[0] || null;
      }
    },

    // --- 15.3 evaluation harness ------------------------------------------
    StrategyEvaluation: {
      async create(row) {
        const rows = await run(
          `INSERT INTO strategy_evaluations (id, evaluation_id, strategy_id, arm, prompt, trial, run_id,
                                             latency_ms, cost_usd, vetoed, coherence_verdict, status, score, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [row.id || newId("sev"), row.evaluation_id, row.strategy_id, row.arm, row.prompt, int(row.trial, 1),
           row.run_id ?? null, row.latency_ms ?? null, row.cost_usd ?? null, row.vetoed === true,
           row.coherence_verdict ?? null, row.status ?? null, row.score ?? null, json(row.detail ?? null)]
        );
        return rows[0];
      },
      async forEvaluation(evaluationId) {
        return run(`SELECT * FROM strategy_evaluations WHERE evaluation_id = $1 ORDER BY arm, trial`, [evaluationId]);
      },
      async recent(limit = 50) {
        return run(`SELECT * FROM strategy_evaluations ORDER BY created_date DESC LIMIT $1`, [Math.max(1, Math.min(int(limit, 50), 500))]);
      }
    },

    // --- 15.4 adaptive orchestrator (observe mode) -------------------------
    AdaptiveDecision: {
      async create(decision) {
        const rows = await run(
          `INSERT INTO adaptive_decisions (id, run_id, mode, selected_strategy_id, would_select_id, reason,
                                           signals, switched, switch_blocked_by, evidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [decision.id || newId("adp"), decision.run_id, decision.mode || "observe", decision.selected_strategy_id,
           decision.would_select_id || decision.selected_strategy_id, decision.reason, json(decision.signals ?? {}),
           decision.switched === true, decision.switch_blocked_by ?? null, json(decision.evidence ?? null)]
        );
        return rows[0];
      },
      async recent(limit = 50) {
        return run(`SELECT * FROM adaptive_decisions ORDER BY created_date DESC LIMIT $1`, [Math.max(1, Math.min(int(limit, 50), 500))]);
      },
      async forRun(runId) {
        const rows = await run(`SELECT * FROM adaptive_decisions WHERE run_id = $1`, [runId]);
        return rows[0] || null;
      }
    },

    // --- 15.6 improvement ledger ------------------------------------------
    ImprovementLedger: {
      async append(entry) {
        const rows = await run(
          `INSERT INTO improvement_ledger (id, ts_ms, action, target, proposal, evidence, law_refs, justification,
                                           decision, reasons, applied, reverted, revert_of, proposed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [entry.id || newId("imp"), entry.ts_ms || Date.now(), entry.action, entry.target ?? null,
           json(entry.proposal ?? {}), json(entry.evidence ?? null), json(entry.law_refs ?? null),
           entry.justification ?? null, entry.decision, json(entry.reasons ?? null),
           entry.applied === true, entry.reverted === true, entry.revert_of ?? null, entry.proposed_by ?? null]
        );
        return rows[0];
      },
      async recent({ limit = 100, decision = null, action = null } = {}) {
        const clauses = [];
        const params = [];
        if (decision) { params.push(decision); clauses.push(`decision = $${params.length}`); }
        if (action) { params.push(action); clauses.push(`action = $${params.length}`); }
        params.push(Math.max(1, Math.min(int(limit, 100), 500)));
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        return run(`SELECT * FROM improvement_ledger ${where} ORDER BY seq DESC LIMIT $${params.length}`, params);
      },
      async get(id) {
        const rows = await run(`SELECT * FROM improvement_ledger WHERE id = $1`, [id]);
        return rows[0] || null;
      },
      /** Reverting is an append, not a mutation: the original row keeps its
       *  decision and a new row records the reversal. */
      async recordRevert(originalId, { reason = null, evidence = null, lawRefs = null, justification = null, proposedBy = null } = {}) {
        const original = await this.get(originalId);
        if (!original) return null;
        return this.append({
          ts_ms: Date.now(),
          action: original.action,
          target: original.target,
          proposal: { ...parse(original.proposal), reverted: true },
          evidence,
          law_refs: lawRefs ?? parse(original.law_refs),
          justification: justification || reason,
          decision: "reverted",
          reasons: [{ reason: reason || "reverted", original_id: originalId }],
          applied: false,
          reverted: true,
          revert_of: originalId,
          proposed_by: proposedBy || original.proposed_by
        });
      }
    }
  };
}
