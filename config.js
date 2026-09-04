// Configuration system — central system configuration.
//
// Structure and knob names are preserved from base44/shared/config.ts. The model
// slugs changed: the originals ("gpt_5_4", "gpt_5_mini") were BluesMinds/Base44
// identifiers. gpt_5_4 is banned outright on this account (503). Everything
// resolves through resolveModel() in llm.js, which enforces the default and the ban.

import { resolveModel } from "./llm.js";

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
    }
  });
}
