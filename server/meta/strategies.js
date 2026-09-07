// Phase 15.2 — the Strategy Registry.
//
// FIRST, THE CHECK THE SPEC ASKED FOR: does server/shared/registry.js already
// fit this role? No, and here is the evidence rather than an assertion.
//
//   createRegistry() (server/shared/registry.js) is a Map of stage name ->
//   agent. It is constructed INSIDE runCouncilTurn, per orchestration run, and
//   thrown away when the run returns. It has no persistence, no ids, no
//   descriptions, no selection signals, no enabled/disabled state, and no way
//   to be inspected between runs. Its own header says what it is for: "Phase 1
//   holds stage handlers; later phases register cognitive agents here."
//
//   A strategy registry has to answer a different question — "which whole
//   reasoning approach should this run take, what signals select it, and what
//   evidence do we have about it?" — across runs and across restarts. That
//   needs durable rows. So: shared/registry.js is left exactly as it is (it is
//   still how stages are dispatched), and the durable registry lives here plus
//   the `strategies` table.
//
// SEEDED WITH EXACTLY ONE ROW: the canonical council pipeline that exists
// today. The schema allows future rows; v1 does not invent them. Phase 15's own
// law (phase15.complexity_justification) is the reason: speculative strategy
// diversity would be complexity with no evidence behind it.

import { LAW_LAYER_VERSION } from "../council/laws.js";

export const CANONICAL_STRATEGY_ID = "council_pipeline";

export const CANONICAL_STRATEGY = Object.freeze({
  id: CANONICAL_STRATEGY_ID,
  name: "Council pipeline (canonical)",
  description:
    "The one strategy that exists: contextAssembly → Observer → Web Search → Strategist → Specialist → " +
    "Synthesizer → Coherence Monitor → Critic ⟳ → Governor → (memory ‖ audit ‖ summary ‖ knowledge ‖ telemetry). " +
    "Adaptive reasoning is inside it, not beside it: the Observer's complexity verdict decides whether the " +
    "critic revision loop is allowed to change the answer (simple → maxRevisions 0).",
  selection_signals: Object.freeze({
    complexity: Object.freeze(["simple", "moderate", "complex"]),
    task_types: Object.freeze([
      "conversation", "question_answering", "research", "planning", "coding",
      "analysis", "creative", "decision_support", "action_execution"
    ]),
    needs_decomposition: Object.freeze([true, false]),
    needs_web_search: Object.freeze([true, false]),
    min_history_messages: 0,
    notes: "Matches every signal: this is the default and, in v1, the only path."
  }),
  enabled: true,
  is_default: true,
  evidence: Object.freeze({
    runs: 0,
    note: "Populated from telemetry_runs by recordEvidenceFromTelemetry(). No live switch is made from it in v1 (phase15.observe_only)."
  })
});

let seeded = null;

/** Idempotent, best-effort, and lazy — nothing touches the database at import. */
export async function ensureStrategiesSeeded(db, { logger = null, force = false } = {}) {
  if (seeded && !force) return seeded;
  try {
    const row = await db.Strategy.upsert({ ...CANONICAL_STRATEGY });
    seeded = [row].filter(Boolean);
    return seeded;
  } catch (e) {
    logger?.warn?.("strategy registry seeding failed", { error: String(e) });
    return [];
  }
}

export async function listStrategies(db, { logger = null, includeDisabled = true } = {}) {
  try {
    await ensureStrategiesSeeded(db, { logger });
    return await db.Strategy.list({ includeDisabled });
  } catch (e) {
    logger?.warn?.("strategy listing failed", { error: String(e) });
    return [];
  }
}

/** Fold telemetry into the registry's evidence column. Read-only with respect
 *  to behaviour: it changes what we know, never what runs. */
export async function recordEvidenceFromTelemetry(db, { workspaceId = null, logger = null } = {}) {
  try {
    const summary = await db.TelemetryRun.summary({ workspaceId });
    const strategies = await listStrategies(db, { logger });
    const out = [];
    for (const s of strategies) {
      const row = summary.find(x => x.strategy_id === s.id) || null;
      const evidence = {
        recorded_at: new Date().toISOString(),
        runs: row?.runs ?? 0,
        successes: row?.successes ?? 0,
        errors: row?.errors ?? 0,
        vetoes: row?.vetoes ?? 0,
        veto_rate: row?.veto_rate ?? 0,
        error_rate: row?.error_rate ?? 0,
        avg_latency_ms: row?.avg_latency_ms ?? null,
        avg_cost_usd: row?.avg_cost_usd ?? null,
        avg_confidence: row?.avg_confidence ?? null,
        contradictions: row?.contradictions ?? 0
      };
      out.push(await db.Strategy.recordEvidence(s.id, evidence));
    }
    return out.filter(Boolean);
  } catch (e) {
    logger?.warn?.("strategy evidence refresh failed", { error: String(e) });
    return [];
  }
}

/** The documented registry check, machine-readable, for the smoke log. */
export function describeRegistryCheck() {
  return {
    question: "Does server/shared/registry.js already fit the strategy-registry role?",
    answer: "no",
    reasons: [
      "it is per-run and in-memory (createRegistry() is called inside runCouncilTurn and discarded)",
      "it maps stage name -> agent, not strategy id -> selection policy",
      "it has no persistence, no ids, no descriptions, no selection signals, no enabled state",
      "it cannot be inspected between runs, which a strategy registry must be"
    ],
    decision: "shared/registry.js left untouched and still dispatches stages; the durable registry is the `strategies` table plus this module",
    seededStrategies: 1,
    seeded: [CANONICAL_STRATEGY_ID],
    lawLayerVersion: LAW_LAYER_VERSION
  };
}
