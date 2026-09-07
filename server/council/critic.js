// Council operator — Critic (critique). Evaluates the generated response for quality
// and completeness. Best-effort: disabled via config or degrades to "skipped" on any
// failure. Marks the TaskContext complete when present.
//
// PHASE 14 ADDITION (additive, and the only change to this operator): the Critic
// is given two things to act on —
//   1. the Coherence Monitor's report (14.5: contradictions and confirmations
//      against the beliefs the system already stores), and
//   2. the temporal reasoner's digest for those beliefs (14.3: how fast their
//      confidence is moving, whether uncertainty is shrinking, how stable they
//      have been). It calls ctx.temporal itself — the helper is for operators to
//      call, not a new operator.
// Both arrive as a bracketed data section appended to the USER message. The
// system prompt below is byte-for-byte what it was, and when the monitor is off
// or found nothing the appended section is the empty string, so the Critic's
// input is identical to pre-Phase-14. Its schema, its score, its skip/degrade
// behaviour and its governance role are unchanged: on the simple path it is
// still advisory telemetry, and it still cannot touch the Governor's veto.

import { defineAgent } from "../shared/runtime.js";
import { callLLM } from "../llm.js";
import { withCharter } from "./charter.js";
import { coherenceBrief } from "../knowledge/coherence.js";

const CRITIC_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    reasoning: { type: "string" },
    needs_revision: { type: "boolean" },
    charter: {
      type: "object",
      properties: {
        truth: { type: "boolean" },
        evidence: { type: "boolean" },
        agency: { type: "boolean" },
        dignity: { type: "boolean" },
        note: { type: "string" }
      }
    }
  }
};

export const criticAgent = defineAgent({
  name: "critic",
  type: "post",
  async handle(message, ctx) {
    if (!ctx.config.council.criticEnabled) {
      return { evaluation: { skipped: true, reason: "disabled" } };
    }
    const { userMessage, responseText, taskContext, coherence } = message.content;
    try {
      // Phase 14.3 — the Critic asks the temporal reasoner about the beliefs the
      // coherence report implicated. Read-only, bounded (6 beliefs, 2 queries),
      // and null on any failure.
      let temporal = null;
      const beliefIds = (coherence?.beliefIds || []).filter(Boolean);
      if (beliefIds.length && ctx.temporal?.digestForBeliefs) {
        temporal = await ctx.temporal.digestForBeliefs(beliefIds).catch(() => null);
      }
      const brief = coherenceBrief(coherence, temporal);
      const evaluation = await callLLM(ctx, {
        model: ctx.config.council.criticModel,
        purpose: "critic",
        responseJsonSchema: CRITIC_SCHEMA,
        messages: [
          {
            role: "system",
            content: withCharter("You are the Critic, the evaluation agent of the COGNOS council. Assess the assistant response to the user request. Set score to an integer 1-10, reasoning to a short explanation, and needs_revision to true only for clearly inadequate, incorrect, or charter-violating responses. Evaluate the response against the COGNOS charter: set charter.truth, charter.evidence, charter.agency, and charter.dignity to true when upheld or false when violated, and charter.note to a brief explanation.")
          },
          { role: "user", content: `Request: ${userMessage}\n\nResponse: ${responseText}${brief}` }
        ]
      });
      if (!evaluation || typeof evaluation !== "object") {
        return { evaluation: { skipped: true, reason: "malformed" } };
      }
      // Additive: the measurements the Critic was given, so the trace and the
      // telemetry record can show what it had in front of it.
      if (temporal) evaluation.temporal = temporal;
      if (coherence?.verdict) evaluation.coherenceVerdict = coherence.verdict;
      if (taskContext?.id) {
        try {
          await ctx.db.TaskContext.update(taskContext.id, { status: "complete" });
        } catch (e) {
          ctx.logger.warn("critic could not close task context", { error: String(e) });
        }
      }
      return { evaluation };
    } catch (e) {
      ctx.logger.warn("critic failed", { error: String(e) });
      return { evaluation: { skipped: true, reason: "exception" } };
    }
  }
});