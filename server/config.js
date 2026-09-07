// Configuration system — central system configuration.
//
// Structure and knob names are preserved from base44/shared/config.ts. The model
// slugs changed: the originals ("gpt_5_4", "gpt_5_mini") were BluesMinds/Base44
// identifiers. gpt_5_4 is banned outright on this account (503). Everything
// resolves through resolveModel() in llm.js, which enforces the default and the ban.
//
// PHASE 14/15 ADDITIONS: `knowledge` (event ledger, coherence monitor, belief
// confidence arithmetic, relationship decay) and `telemetry` (run records and the
// adaptive orchestrator's mode). They follow the existing convention exactly:
// a knob is ON unless its environment variable is the string "false", and every
// number is an editable constant here rather than another environment variable.
// New subsystems are all switchable — that is what phase15.complexity_justification
// requires ("a subsystem that cannot be turned off" is refused).

import { resolveModel } from "./llm.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function getSystemConfig() {
  const primary = resolveModel(process.env.COGNOS_MODEL);
  const fast = resolveModel(process.env.COGNOS_FAST_MODEL || process.env.COGNOS_MODEL);
  return Object.freeze({
    orchestrator: {
      maxHistoryMessages: 20,
      maxMemories: 10,
      memoryPoolSize: 20,
      summaryEnabled: true
    },
    models: {
      primary,
      memory: fast
    },
    council: {
      observerModel: fast,
      strategistModel: fast,
      criticModel: fast,
      criticEnabled: process.env.COGNOS_CRITIC_ENABLED !== "false",
      governorEnabled: process.env.COGNOS_GOVERNOR_ENABLED !== "false",
      maxRevisions: 1,
      revisionScoreThreshold: 6
    },
    search: {
      enabled: process.env.COGNOS_SEARCH_ENABLED !== "false",
      provider: process.env.COGNOS_SEARCH_PROVIDER || (process.env.TAVILY_API_KEY ? "tavily" : "duckduckgo")
    },

    // --- Phase 14: Dynamic Systems -----------------------------------------
    knowledge: {
      // 14.1 the ledger, and every knowledge write that feeds it.
      ledgerEnabled: process.env.COGNOS_LEDGER_ENABLED !== "false",
      // 14.5 the Coherence Monitor. One extra fast-model call per cycle, before
      // the Critic, so the Critic and the Governor can see what it found.
      coherenceEnabled: process.env.COGNOS_COHERENCE_ENABLED !== "false",
      coherenceModel: fast,
      maxBeliefsPerRun: 12,
      maxNewHypotheses: 2,
      hypothesisConfidenceFloor: 0.6,

      // 14.3 confidence arithmetic. Starting confidence comes from the evidence
      // level the memory extractor already assigns; importance nudges it ±0.1.
      confidenceFromEvidence: { direct: 0.85, repeated: 0.75, inferred: 0.55, assumed: 0.35 },
      confirmationGain: 0.10,       // saturating: c' = c + gain * (1 - c)
      contradictionPenalty: 0.25,   // scaled by how strongly the draft asserts the conflict
      weakenBelow: 0.5,             // confidence under this -> status 'weakened'
      retireBelow: 0.2,             // confidence under this -> retired (never deleted)

      // 14.4 relationship dynamics. Decay is exponential with a half-life, so a
      // stale relationship weakens on its own; the sweep only materializes it.
      decay: {
        enabled: true,
        halfLifeMs: 14 * DAY_MS,
        floor: 0.05,
        sweepLimit: 25,             // rows per run — bounded, never a full-table scan
        reinforceGain: 0.15,
        weakenPenalty: 0.20,
        inheritFactor: 0.70,        // strength a successor link inherits on a split
        maxPairsPerRun: 6,
        maxLinksPerRetirement: 8
      }
    },

    // --- Phase 15: Meta-Cognition ------------------------------------------
    telemetry: {
      enabled: process.env.COGNOS_TELEMETRY_ENABLED !== "false",
      // 15.4 observe mode only. Anything else is refused here and by the Policy
      // Engine (law phase15.observe_only); v1 makes no live switches.
      adaptiveMode: "observe",
      requestedAdaptiveMode: process.env.COGNOS_ADAPTIVE_MODE || "observe",
      recordModelCalls: true
    }
  });
}
