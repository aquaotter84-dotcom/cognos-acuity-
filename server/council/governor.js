// Council operator — Governor (sovereignty). A rule-based policy gate that inspects
// the final response for safety issues (e.g. leaked secrets, empty output). Best-effort
// and synchronous (no model call). Flags issues without blocking in Phase 2.
//
// PHASE 14 ADDITION (informational only): the Governor is handed the Coherence
// Monitor's report as data, and returns it on its verdict so the trace, the
// ledger and the telemetry record all carry what was measured. Its decision
// logic is untouched — `approved` and `flags` are computed exactly as before,
// from the draft text and SECRET_PATTERNS alone. Coherence can never approve
// something the Governor would refuse, and can never refuse something it would
// have approved (pin.veto_integrity: the veto semantics do not change).

import { defineAgent } from "../shared/runtime.js";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9]{20,}/i
];

export const governorAgent = defineAgent({
  name: "governor",
  type: "post",
  async handle(message, ctx) {
    if (!ctx.config.council.governorEnabled) {
      return { approved: true, flags: [] };
    }
    const { responseText, coherence } = message.content;
    const flags = [];
    const text = responseText || "";
    if (!text.trim()) flags.push("empty_response");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        flags.push("potential_secret_leak");
        break;
      }
    }
    // The verdict is decided above, by the rules, before this line runs. The
    // coherence measurement rides along; it does not vote.
    return {
      approved: flags.length === 0,
      flags,
      coherence: coherence
        ? { verdict: coherence.verdict || null, checked: coherence.checked !== false, contradictions: (coherence.contradictions || []).length }
        : null
    };
  }
});