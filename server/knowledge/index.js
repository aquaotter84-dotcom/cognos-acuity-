// Phase 14 / 15 pipeline stages — the subsystems the council consults and that
// observe it.
//
// THESE ARE NOT COUNCIL SEATS. The six operators (Observer, Strategist,
// Specialist, Synthesizer, Critic, Governor) plus the Web Search tool are
// registered by server/council/index.js and are unchanged. These stages are
// registered beside the other non-council stages (contextAssembly,
// memoryExtraction, auditLog) that server/chatOrchestrate.js has always owned.
//
//   coherenceMonitor    DETECTS conflict between the draft and stored beliefs,
//                       before the Critic, so the Critic and Governor see it.
//                       Writes nothing.
//   knowledgeProjection RECORDS, after the Governor's verdict, in one
//                       transaction: coherence transitions, the veto event,
//                       relationship dynamics, the bounded decay sweep.
//   telemetryRecord     PREPARES the run's final telemetry counts. The
//                       orchestration wrapper writes once the run is known not
//                       to have been cancelled.

import { createHash } from "node:crypto";
import { defineAgent } from "../shared/runtime.js";
import db from "../db.js";
import { num } from "../db/util.js";
import { coherenceMonitorAgent, persistCoherence } from "./coherence.js";

const sha256 = (text) => createHash("sha256").update(String(text ?? "")).digest("hex");

const USER_SYSTEM = Object.freeze({
  kind: "user_system",
  direction: "directed",
  subject: (workspaceId) => ({ type: "workspace", id: workspaceId }),
  object: () => ({ type: "system", id: "cognos" })
});

export const knowledgeProjectionAgent = defineAgent({
  name: "knowledgeProjection",
  type: "post",
  async handle(message, ctx) {
    const content = message.content;
    const cfg = ctx.config.knowledge || {};
    const { workspaceId, conversationId, runId, coherence, vetoed, governor, finalText, draftText, draftOrigin } = content;

    if (cfg.ledgerEnabled === false) {
      return { ...content, knowledge: { enabled: false, ledgerEvents: 0, reason: "COGNOS_LEDGER_ENABLED=false" } };
    }

    const source = { runId, messageId: content.messageId ?? null, kind: "run" };
    try {
      const detail = await db.withTransaction(async (store) => {
        let events = 0;
        const out = { veto: null, coherence: null, relationship: null, decay: null };

        // --- The veto is a transition of the run's knowledge state. The
        // rejected draft itself is never stored: only its length and digest, so
        // the lineage is real without the vetoed text becoming knowledge.
        if (vetoed) {
          const flags = governor?.flags || [];
          const vetoEvent = await store.KnowledgeEvent.append({
            workspaceId,
            entityType: "run",
            entityId: runId,
            transition: "veto_raised",
            fromState: { approved: true, draft_origin: draftOrigin || null },
            toState: { approved: false, flags, draft_origin: draftOrigin || null, shipped: false },
            delta: { approved: false, flags: flags.length },
            sourceRunId: runId,
            sourceMessageId: source.messageId,
            sourceKind: "run",
            reversible: false,
            payload: {
              flags,
              draft_chars: draftText == null ? null : String(draftText).length,
              draft_sha256: draftText == null ? null : sha256(draftText),
              final_text_kind: finalText && String(finalText).trim() ? "sovereignty_refusal" : "empty",
              note: "the rejected draft is not stored; a vetoed draft never becomes knowledge"
            }
          });
          events += vetoEvent ? 1 : 0;
          out.veto = { flags, draftOrigin: draftOrigin || null, draftChars: draftText == null ? null : String(draftText).length };

          // A veto is a bad interaction: the user↔system relationship weakens.
          const weakened = await store.Relationship.weaken({
            workspaceId,
            kind: USER_SYSTEM.kind,
            direction: USER_SYSTEM.direction,
            subject: USER_SYSTEM.subject(workspaceId),
            object: USER_SYSTEM.object(),
            source,
            config: cfg,
            note: `governor veto (${flags.join(", ") || "unspecified"})`
          });
          events += (weakened.events || []).length;
          out.relationship = { direction: "weakened", events: (weakened.events || []).length };
        }

        // --- Coherence. Persisted only for a draft that shipped.
        const persisted = await persistCoherence(store, {
          report: coherence || null,
          workspaceId,
          conversationId,
          runId,
          messageId: source.messageId,
          vetoed: !!vetoed,
          config: { knowledge: cfg },
          finalText
        });
        events += persisted.events || 0;
        out.coherence = persisted.detail || null;
        out.coherenceReportId = persisted.report?.id ?? null;

        // --- A shipped answer is a good interaction: the relationship strengthens.
        if (!vetoed) {
          const reinforced = await store.Relationship.reinforce({
            workspaceId,
            kind: USER_SYSTEM.kind,
            direction: USER_SYSTEM.direction,
            subject: USER_SYSTEM.subject(workspaceId),
            object: USER_SYSTEM.object(),
            source,
            config: cfg,
            note: coherence?.verdict === "contradiction" ? "exchange completed, but the draft contradicted a stored belief" : "exchange completed"
          });
          events += (reinforced.events || []).length;
          out.relationship = { direction: "strengthened", events: (reinforced.events || []).length, strength: num(reinforced.relationship?.strength, null) };
        }

        // --- Time passes on its own. Bounded sweep (config.decay.sweepLimit rows).
        const sweep = await store.Relationship.decaySweep({ workspaceId, config: cfg, source: { runId } });
        events += (sweep.events || []).length;
        out.decay = { swept: sweep.swept || 0, decayed: sweep.decayed || 0 };

        return { ledgerEvents: events, ...out };
      });

      ctx.telemetry?.noteLedger?.(detail.ledgerEvents || 0);
      ctx.telemetry?.setKnowledge?.({
        ledgerEvents: detail.ledgerEvents || 0,
        coherence: detail.coherence || null,
        veto: detail.veto || null,
        relationship: detail.relationship || null,
        decay: detail.decay || null,
        coherenceReportId: detail.coherenceReportId || null
      });
      return { ...content, knowledge: { enabled: true, ...detail } };
    } catch (e) {
      // pin.telemetry_side_effect / best-effort knowledge: a failed projection is
      // logged. It never reaches the user and never changes the answer.
      ctx.logger.warn("knowledge projection failed", { error: String(e), runId });
      return { ...content, knowledge: { enabled: true, ledgerEvents: 0, error: String(e).slice(0, 300) } };
    }
  }
});

export const telemetryRecordAgent = defineAgent({
  name: "telemetryRecord",
  type: "post",
  async handle(message, ctx) {
    const content = message.content;
    const recorder = ctx.telemetry;
    if (!recorder) return { ...content, telemetry: null };
    try {
      // The ledger is the authority on how many transitions this run caused.
      const total = await ctx.db.KnowledgeEvent.countForRun(ctx.runId).catch(() => null);
      if (total != null) recorder.setLedgerTotal(total);
      // Do not finalize inside this concurrent post-processing chain. The
      // orchestrator checks its AbortSignal after every post stage and only then
      // writes the terminal status, so a late Stop cannot be frozen as success.
    } catch (e) {
      ctx.logger.warn("telemetry record failed", { error: String(e) });
    }
    return { ...content, telemetry: recorder.summary ? recorder.summary() : null };
  }
});

export { coherenceMonitorAgent };

export function registerKnowledgeStages(registry) {
  registry.register(coherenceMonitorAgent.name, coherenceMonitorAgent);
  registry.register(knowledgeProjectionAgent.name, knowledgeProjectionAgent);
  registry.register(telemetryRecordAgent.name, telemetryRecordAgent);
}

export const KNOWLEDGE_STAGES = Object.freeze([
  coherenceMonitorAgent.name,
  knowledgeProjectionAgent.name,
  telemetryRecordAgent.name
]);
