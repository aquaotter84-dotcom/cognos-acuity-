// The single chat send path: SSE lifecycle, cancellation, orchestration, and
// the transaction that persists a governed conclusion.

import { newId, ledgerEnabled } from "../db.js";
import { runCouncilTurn } from "../chatOrchestrate.js";
import { isClientAbort, throwIfAborted } from "../shared/cancellation.js";
import { beginRequestTiming, elapsedMs, monotonicNow, timed } from "../shared/performance.js";
import { normalizeAgentMode } from "../agent/runner.js";

export function registerChatRoute(app, { wrap, db, logger }) {
  // --- THE SEND PATH -----------------------------------------------------------
  // One route, front to back. It:
  //   1. resolves/creates the thread,
  //   2. persists the user message,
  //   3. streams council stage events + answer tokens over SSE,
  //   4. persists the assistant message with its council trace,
  //   5. sends a final `done` event carrying the exact same shape the client
  //      would have received from a plain JSON response.
  // There is no second, non-streaming variant. There is no code after this handler
  // that also sends chat.
  app.post("/api/chat", wrap(async (req, res) => {
    const requestTiming = beginRequestTiming();
    const setupStarted = monotonicNow();
    const { userMessage, style, attachments: requestedAttachments, webSearch } = req.body || {};
    if (typeof userMessage !== "string" || !userMessage.trim()) {
      return res.status(400).json({ error: "userMessage is required" });
    }

    const workspaceStep = await timed(() => db.Workspace.ensureDefault());
    const workspace = workspaceStep.value;
    const agentMode = normalizeAgentMode(req.body?.agentMode || "off");

    // Resolve source attachments server-side. Names, hashes, text and URLs from
    // the browser are never trusted into a model prompt or persisted message.
    const requestedSourceIds = [...new Set((Array.isArray(requestedAttachments) ? requestedAttachments : [])
      .map(attachment => attachment?.source_id)
      .filter(id => typeof id === "string" && /^src_[a-z0-9]+$/i.test(id)))]
      .slice(0, 8);
    const sourceStep = await timed(() => db.Source.listByIds(workspace.id, requestedSourceIds));
    const resolvedSources = sourceStep.value;
    const attachments = resolvedSources.map(source => ({
      source_id: source.id,
      name: source.name,
      source_type: source.kind,
      file_type: source.media_type,
      content_sha256: source.content_sha256,
      file_url: null
    }));

    let conversationId = req.body?.conversationId || null;
    let createdConversation = null;
    let conversationMs = 0;
    if (!conversationId) {
      const conversationStep = await timed(() => db.Conversation.create({
        workspace_id: workspace.id,
        title: userMessage.slice(0, 50) + (userMessage.length > 50 ? "..." : ""),
        last_message_preview: userMessage
      }));
      createdConversation = conversationStep.value;
      conversationMs = conversationStep.ms;
      conversationId = createdConversation.id;
    } else {
      const conversationStep = await timed(() => db.Conversation.get(conversationId));
      conversationMs = conversationStep.ms;
      if (!conversationStep.value || conversationStep.value.workspace_id !== workspace.id) {
        return res.status(404).json({ error: "Conversation not found in this workspace" });
      }
    }

    // Phase 15.1: the run is identified here, before the council starts, so both
    // the success path and the failure path can link the persisted message to the
    // telemetry record and to the ledger.
    const runId = newId("run");

    const userMessageStep = await timed(() => db.Message.create({
      conversation_id: conversationId,
      workspace_id: workspace.id,
      role: "user",
      content: userMessage,
      attachments: attachments?.length ? attachments : null,
      processing_status: "complete"
    }));
    const userMsg = userMessageStep.value;
    const preCouncilPerformance = {
      runtime: requestTiming,
      preCouncil: {
        totalMs: elapsedMs(setupStarted),
        workspaceMs: workspaceStep.ms,
        sourceResolveMs: sourceStep.ms,
        conversationMs,
        userMessageMs: userMessageStep.ms
      }
    };

    // The SSE connection is the lifetime of the turn. If the browser presses
    // Stop or disconnects, propagate that cancellation through the orchestrator
    // and into the currently active upstream model request.
    const turnAbort = new AbortController();
    let turnSettled = false;
    const onResponseClose = () => {
      if (!turnSettled && !res.writableEnded && !turnAbort.signal.aborted) {
        turnAbort.abort(new Error("SSE client disconnected"));
      }
    };
    res.once("close", onResponseClose);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const send = (event, data) => {
      if (res.destroyed || res.writableEnded) return false;
      return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send("start", { conversationId, conversation: createdConversation, userMessage: userMsg, runId });

    try {
      const result = await runCouncilTurn(
        { conversationId, workspaceId: workspace.id, userMessage, style, attachments, webSearch, agentMode },
        {
          runId,
          signal: turnAbort.signal,
          performance: preCouncilPerformance,
          emit: (event, payload) => send(event, payload),
          onToken: (delta) => send("token", { delta })
        }
      );
      throwIfAborted(turnAbort.signal);

      // Phase 14.1 — the conclusion, its ledger event, the conversation-metadata
      // write and the telemetry link are ONE transaction: either the answer is
      // stored with its history, or nothing is. `result.response` is the FINAL
      // text — the Governor's veto already decided what that is, and a vetoed
      // draft is not in it (pin.veto_integrity).
      const assistantMsg = await db.withTransaction(async (store) => {
        throwIfAborted(turnAbort.signal);
        const msg = await store.Message.create({
          conversation_id: conversationId,
          workspace_id: workspace.id,
          role: "assistant",
          content: result.response,
          model_used: result.modelUsed,
          task_type: result.taskType,
          council: { ...result.council, modelUsed: result.modelUsed, taskType: result.taskType, latencyMs: result.latencyMs },
          processing_status: "complete"
        });
        if (ledgerEnabled()) {
          await store.KnowledgeEvent.append({
            workspaceId: workspace.id,
            entityType: "message",
            entityId: msg.id,
            transition: "message_recorded",
            toState: {
              role: "assistant",
              conclusion: msg.content,
              processing_status: "complete",
              task_type: result.taskType,
              model_used: result.modelUsed
            },
            delta: { chars: String(result.response || "").length },
            sourceRunId: runId,
            sourceMessageId: msg.id,
            sourceKind: "message",
            reversible: false,
            payload: {
              run_id: runId,
              governor: result.council?.governor ? { approved: result.council.governor.approved, flags: result.council.governor.flags } : null,
              coherence_verdict: result.council?.coherence?.verdict ?? null,
              critic_score: result.council?.critic?.score ?? null,
              ledger_events_this_run: result.council?.knowledge?.ledgerEvents ?? null,
              lineage: "temporal lineage: this conclusion -> source_run_id -> every transition the run caused"
            }
          });
        }
        throwIfAborted(turnAbort.signal);
        await store.TelemetryRun.setMessageId(runId, msg.id).catch(() => null);
        await store.Conversation.update(conversationId, {
          last_message_preview: String(result.response || "").slice(0, 100)
        }, { ledger: { runId, messageId: msg.id, kind: "message" } });
        throwIfAborted(turnAbort.signal);
        return msg;
      });

      // Final payload — the exact shape the client consumes.
      send("done", {
        conversationId,
        runId,
        message: assistantMsg,
        response: result.response,
        taskType: result.taskType,
        modelUsed: result.modelUsed,
        latencyMs: result.latencyMs,
        summary: result.summary,
        council: { ...result.council, modelUsed: result.modelUsed, taskType: result.taskType, latencyMs: result.latencyMs }
      });
    } catch (error) {
      if (isClientAbort(error, turnAbort.signal)) {
        // A deliberate Stop is not an assistant error and must not create an
        // error bubble, conclusion event, memory, or summary. The user message
        // remains as the truthful record of what was sent; telemetry records the
        // run as cancelled.
        logger.info("council turn cancelled", { runId, conversationId });
        return;
      }
      logger.error("council turn failed", { error: String(error) });
      // The Sovereign principle: stay silent rather than lie. No fabricated answer
      // is persisted or streamed — the failure is reported as a failure.
      // Phase 15.1: the failure is already in telemetry (the wrapper in
      // chatOrchestrate finalized the record before rethrowing). What is stored
      // here is the documented failure itself — no fabricated answer, and the
      // ledger records that this run produced an error conclusion, not knowledge.
      const errorMsg = await db.withTransaction(async (store) => {
        const msg = await store.Message.create({
          conversation_id: conversationId,
          workspace_id: workspace.id,
          role: "assistant",
          content: `⚠️ **The council could not answer.**\n\n${error.message || "Unknown error"}`,
          processing_status: "error"
        });
        if (ledgerEnabled()) {
          await store.KnowledgeEvent.append({
            workspaceId: workspace.id,
            entityType: "message",
            entityId: msg.id,
            transition: "message_recorded",
            toState: { role: "assistant", processing_status: "error", conclusion: null },
            delta: { failed: true },
            sourceRunId: runId,
            sourceMessageId: msg.id,
            sourceKind: "message",
            reversible: false,
            payload: { documented_failure: true, error: String(error.message || error).slice(0, 400), note: "no answer was fabricated and nothing was written to memory" }
          });
        }
        await store.TelemetryRun.setMessageId(runId, msg.id).catch(() => null);
        return msg;
      }).catch(() => null);
      send("error", { error: error.message || "Unknown error", message: errorMsg });
    } finally {
      turnSettled = true;
      res.off("close", onResponseClose);
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  }));


}
