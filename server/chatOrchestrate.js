// chatOrchestrate — the COGNOS council pipeline.
//
// Ported from base44/functions/chatOrchestrate/entry.ts. The pipeline, the stage
// order, the revision loop, the adaptive-reasoning rule and every prompt are
// preserved. What changed:
//   * No Base44 SDK client, no auth.me(), no service-role branch, no agent secret.
//     There are no accounts, so there is no user to authenticate.
//   * ctx.base44.entities.* became ctx.db.* (Postgres).
//   * The function returns a result object; the HTTP layer (routes/chat.js) owns
//     the response shape and the SSE stream.
//   * SANCTIONED UPGRADE: an optional `emit` callback publishes council stage
//     events live so the UI can watch the council think.

import { createLogger } from "./shared/logging.js";
import { getSystemConfig } from "./config.js";
import { createRegistry } from "./shared/registry.js";
import { createEventBus } from "./shared/eventBus.js";
import { createOrchestrator } from "./shared/orchestrator.js";
import { defineAgent } from "./shared/runtime.js";
import { createMessage } from "./shared/protocol.js";
import { CognosError } from "./shared/errors.js";
import { registerCouncil } from "./council/index.js";
import { callLLM } from "./llm.js";
import db from "./db.js";

const rootLogger = createLogger("chatOrchestrate");

const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          memory_type: { type: "string" },
          importance: { type: "integer" },
          evidence_level: { type: "string" },
          volatility: { type: "string" }
        }
      }
    }
  }
};

const MEMORY_RELEVANCE_SCHEMA = {
  type: "object",
  properties: {
    relevant_ids: { type: "array", items: { type: "string" } }
  }
};

// Phase 7 — relevance-based memory retrieval. When the workspace has more enabled
// memories than the context budget, a lightweight model ranks the pool by relevance
// to the current message and the top-N are used. Falls back to importance order.
async function selectRelevantMemories(ctx, userMessage, pool, maxMemories) {
  if (!pool || pool.length === 0) return [];
  if (pool.length <= maxMemories) return pool;
  try {
    const inventory = pool.map(m => ({ id: m.id, content: m.content }));
    const result = await callLLM(ctx, {
      model: ctx.config.models.memory,
      responseJsonSchema: MEMORY_RELEVANCE_SCHEMA,
      messages: [
        { role: "system", content: `You are a memory relevance agent. Given a user's message and a list of memories (with ids), return the ids of the memories most relevant to the message, in order of relevance, up to ${maxMemories}. Only include ids that genuinely relate to the message; if few are relevant, return fewer.` },
        { role: "user", content: `Message: ${userMessage}\n\nMemories (JSON):\n${JSON.stringify(inventory)}` }
      ]
    });
    if (result && Array.isArray(result.relevant_ids)) {
      const idSet = new Set(inventory.map(m => m.id));
      const seen = new Set();
      const selected = [];
      for (const id of result.relevant_ids) {
        if (!idSet.has(id) || seen.has(id)) continue;
        const m = pool.find(x => x.id === id);
        if (m) { selected.push(m); seen.add(m.id); }
        if (selected.length >= maxMemories) break;
      }
      // top up with highest-importance unused if the model returned fewer than the budget
      for (const m of pool) {
        if (seen.has(m.id)) continue;
        selected.push(m); seen.add(m.id);
        if (selected.length >= maxMemories) break;
      }
      return selected;
    }
  } catch (e) {
    ctx.logger.warn("memory relevance selection failed, using importance fallback", { error: String(e) });
  }
  return pool.slice(0, maxMemories);
}

const SUMMARIZE_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } }
};

// Phase 9 — conversation summarization. After each exchange, a lightweight model
// writes a 1-2 sentence running summary onto the Conversation so the workspace
// retains context continuity. Best-effort; never fails the request.
async function summarizeConversation(ctx, conversationId, history, userMessage, responseText) {
  try {
    const transcript = [
      ...history.map(m => `${m.role}: ${m.content}`),
      `user: ${userMessage}`,
      `assistant: ${responseText}`
    ].join('\n');
    const result = await callLLM(ctx, {
      model: ctx.config.models.memory,
      responseJsonSchema: SUMMARIZE_SCHEMA,
      messages: [
        { role: "system", content: "Summarize the following conversation in 1-2 concise sentences. Capture what the user wanted and the outcome. Return only the summary text." },
        { role: "user", content: transcript }
      ]
    });
    const summary = result?.summary?.trim();
    if (summary) {
      await ctx.db.Conversation.update(conversationId, { summary });
      return summary;
    }
  } catch (e) {
    ctx.logger.warn("conversation summarization failed", { error: String(e) });
  }
  return null;
}

/**
 * Run the council for one turn.
 * @param {object} body    { conversationId, workspaceId, userMessage, style, attachments, webSearch }
 * @param {object} options { emit(event, payload), onToken(delta) }
 */
export async function runCouncilTurn(body, options = {}) {
  const { emit = () => {}, onToken = null } = options;
  const { conversationId, workspaceId, userMessage, style, attachments, webSearch } = body;
  if (!conversationId || !workspaceId || !userMessage) {
    throw new CognosError("Missing required fields", { code: "VALIDATION", category: "input", status: 400 });
  }

  // --- Nervous system setup ---
  const config = getSystemConfig();
  const logger = rootLogger.child("orchestrator");
  const registry = createRegistry();
  const eventBus = createEventBus(logger);
  const orchestrator = createOrchestrator({ registry, eventBus, logger });

  eventBus.subscribe("orchestration.stage.start", (e) => { logger.info("stage.start", e); emit("stage.start", e); });
  eventBus.subscribe("orchestration.stage.complete", (e) => { logger.info("stage.complete", e); emit("stage.complete", e); });

  // --- Stage: context assembly ---
  const contextAgent = defineAgent({
    name: "contextAssembly",
    type: "stage",
    async handle(message, ctx) {
      const { conversationId, workspaceId, userMessage } = message.content;
      const poolSize = ctx.config.orchestrator.memoryPoolSize || ctx.config.orchestrator.maxMemories;
      // DB reads are independent of each other — fetch concurrently.
      const [history, pool, workspace] = await Promise.all([
        ctx.db.Message.recent(conversationId, ctx.config.orchestrator.maxHistoryMessages),
        ctx.db.Memory.filter({ workspace_id: workspaceId, is_enabled: true }, poolSize),
        ctx.db.Workspace.get(workspaceId)
      ]);
      // PERF: memory-relevance ranking is an LLM call that depends only on the
      // user message and the pool — NOT on the Observer. It is returned as an
      // unresolved promise so it can overlap the Observer instead of preceding
      // it. Only the Specialist actually needs the resolved value.
      const memoriesPromise = selectRelevantMemories(ctx, userMessage, pool, ctx.config.orchestrator.maxMemories);
      return { ...message.content, history, memoriesPromise, workspace };
    }
  });

  // --- Stage: LLM response — moved to the council specialist + synthesizer (Phase 3) ---

  // --- Stage: memory extraction (best-effort) ---
  const memoryAgent = defineAgent({
    name: "memoryExtraction",
    type: "post",
    async handle(message, ctx) {
      const { workspaceId, conversationId, userMessage, responseText } = message.content;
      try {
        const memResult = await callLLM(ctx, {
          model: ctx.config.models.memory,
          responseJsonSchema: MEMORY_SCHEMA,
          messages: [
            {
              role: "system",
              content: 'You are a memory extraction agent. Analyze the conversation and extract any important facts, preferences, or information worth remembering for future conversations. Only extract genuinely useful, long-term information — not casual conversation. For each memory, also classify: evidence_level — "direct" (the user explicitly stated it), "repeated" (stated across multiple exchanges), "inferred" (deduced from context), or "assumed" (guessed without a clear basis, use sparingly); and volatility — "low" (name, identity, stable facts), "medium" (job, role, preferences), or "high" (current project phase, living situation, in-progress state that changes often). Be honest about evidence: prefer "direct" only when the user clearly stated it, and "assumed" only when you are guessing. Return a memories array; each memory has content (string), memory_type ("episodic" or "semantic"), importance (1-10 integer), evidence_level (string), and volatility (string). Return an empty array if nothing is worth remembering.'
            },
            { role: "user", content: `User: ${userMessage}\nAssistant: ${responseText}` }
          ]
        });
        if (memResult?.memories && Array.isArray(memResult.memories) && memResult.memories.length > 0) {
          const records = memResult.memories
            .filter(m => m.content && String(m.content).trim().length > 5)
            .map(m => ({
              workspace_id: workspaceId,
              content: String(m.content).trim(),
              memory_type: m.memory_type || 'episodic',
              source: conversationId,
              importance: m.importance || 5,
              evidence_level: ['direct', 'repeated', 'inferred', 'assumed'].includes(m.evidence_level) ? m.evidence_level : 'inferred',
              volatility: ['low', 'medium', 'high'].includes(m.volatility) ? m.volatility : 'medium',
              last_confirmed: new Date().toISOString(),
              is_enabled: true
            }));
          if (records.length > 0) {
            await ctx.db.Memory.bulkCreate(records);
          }
        }
      } catch (e) {
        ctx.logger.warn("memory extraction failed", { error: String(e) });
      }
    }
  });

  // --- Stage: audit log (best-effort) ---
  const auditAgent = defineAgent({
    name: "auditLog",
    type: "post",
    async handle(message, ctx) {
      const { workspaceId, conversationId, modelUsed, taskType, latencyMs, status } = message.content;
      try {
        await ctx.db.AuditEvent.create({
          workspace_id: workspaceId,
          conversation_id: conversationId,
          event_type: 'agent_invocation',
          agent_type: 'orchestrator',
          model_used: modelUsed,
          task_type: taskType,
          latency_ms: latencyMs,
          status: status
        });
      } catch (e) {
        ctx.logger.warn("audit log failed", { error: String(e) });
      }
    }
  });

  registry.register(contextAgent.name, contextAgent);
  registry.register(memoryAgent.name, memoryAgent);
  registry.register(auditAgent.name, auditAgent);
  registerCouncil(registry);

  const ctx = { db, config, logger, timings: {}, stream: Boolean(onToken), onToken };

  const startTime = Date.now();

  // --- Orchestrate the pipeline ---
  const contextMsg = createMessage({
    type: "context.request",
    from: "orchestrator",
    content: { conversationId, workspaceId, userMessage, style, attachments: attachments || [], webSearch: !!webSearch }
  });
  const contextResult = await orchestrator.dispatch("contextAssembly", contextMsg, ctx);

  // --- Phase 2: cognitive layer — perception & planning ---
  const observerMsg = createMessage({
    type: "council.observe",
    from: "orchestrator",
    content: contextResult
  });
  const observerResult = await orchestrator.dispatch("observer", observerMsg, ctx);
  emit("observer", { classification: observerResult.classification });

  // --- Web search tool — pulls current facts when the Observer flags it (or the user toggle is on) ---
  const webSearchMsg = createMessage({
    type: "council.search",
    from: "orchestrator",
    content: observerResult
  });
  const webSearchResult = await orchestrator.dispatch("webSearch", webSearchMsg, ctx);

  // Join the memory-relevance call that has been running alongside the Observer
  // and the web search. Everything downstream sees a plain `memories` array, so
  // the council operators are untouched by this optimization.
  const memories = await (contextResult.memoriesPromise || Promise.resolve([]));
  contextResult.memories = memories;
  webSearchResult.memories = memories;
  delete webSearchResult.memoriesPromise;
  emit("memories", { memoriesUsed: memories.map(m => ({ id: m.id, preview: String(m.content || '').slice(0, 120), evidence: m.evidence_level || null, volatility: m.volatility || null })) });
  if (webSearchResult.searchResults) {
    emit("webSearch", { query: webSearchResult.searchQuery, results: webSearchResult.searchResults, model: webSearchResult.webSearchModel });
  }

  const strategistMsg = createMessage({
    type: "council.plan",
    from: "orchestrator",
    content: webSearchResult
  });
  const strategistResult = await orchestrator.dispatch("strategist", strategistMsg, ctx);
  emit("strategist", { plan: strategistResult.plan, subTasks: strategistResult.taskContext?.sub_tasks || null });

  // --- Phase 3: specialist layer — execute sub-tasks or direct response ---
  const specialistMsg = createMessage({
    type: "council.execute",
    from: "orchestrator",
    content: strategistResult
  });
  const specialistResult = await orchestrator.dispatch("specialist", specialistMsg, ctx);
  emit("specialist", { subTasks: specialistResult.subTaskOutputs || null });

  // --- Phase 3: synthesis — combine specialist outputs (no-op for direct path) ---
  const synthMsg = createMessage({
    type: "council.synthesize",
    from: "orchestrator",
    content: specialistResult
  });
  const synthResult = await orchestrator.dispatch("synthesizer", synthMsg, ctx);

  // --- Phase 4: critic-driven revision loop ---
  // The Critic evaluates the synthesized response; if it flags the response as
  // needing revision (needs_revision && score below threshold), the Synthesizer
  // revises with the critique and is re-evaluated. Capped at maxRevisions.
  let currentResponse = synthResult;

  // Phase 13 — Law 4 (adaptive reasoning) & economic intelligence: the problem
  // determines the reasoning. Simple requests skip the costly critic revision loop;
  // only moderate/complex tasks warrant it. The Strategist already passes through
  // (plan: "direct") when the Observer flags no decomposition needed, so the simple
  // path collapses to observer → specialist → synthesizer → governor.
  const isSimple = observerResult.classification?.complexity === 'simple';
  const maxRevisions = isSimple ? 0 : (ctx.config.council.maxRevisions || 0);
  const revisionScoreThreshold = ctx.config.council.revisionScoreThreshold || 0;
  let revisionCount = 0;
  let revisionTriggered = false;

  // PERF: the Critic can only change the answer when a revision is possible.
  // When maxRevisions is 0 (Phase 13 marks the request "simple"), its verdict is
  // advisory telemetry only — so it is deferred into the post-response batch
  // instead of blocking `done`. The evaluation is still produced, still shown in
  // the trace, and still governs nothing it did not govern before.
  let criticResult;
  let deferredCritic = null;
  if (maxRevisions > 0) {
    criticResult = await orchestrator.dispatch("critic", createMessage({
      type: "council.critique", from: "orchestrator", content: currentResponse
    }), ctx);
    emit("critic", { critic: criticResult.evaluation });
  } else {
    deferredCritic = orchestrator.dispatch("critic", createMessage({
      type: "council.critique", from: "orchestrator", content: currentResponse
    }), ctx).then(r => { emit("critic", { critic: r.evaluation }); return r; });
    criticResult = { evaluation: null };
  }

  while (
    maxRevisions > 0 &&
    revisionCount < maxRevisions &&
    criticResult.evaluation &&
    !criticResult.evaluation.skipped &&
    criticResult.evaluation.needs_revision === true &&
    typeof criticResult.evaluation.score === "number" &&
    criticResult.evaluation.score < revisionScoreThreshold
  ) {
    revisionTriggered = true;
    revisionCount++;
    emit("revision", { count: revisionCount, maxRevisions });
    const reviseMsg = createMessage({
      type: "council.revise",
      from: "orchestrator",
      content: { ...currentResponse, critique: criticResult.evaluation, revision: true }
    });
    currentResponse = await orchestrator.dispatch("synthesizer", reviseMsg, ctx);
    criticResult = await orchestrator.dispatch("critic", createMessage({
      type: "council.critique", from: "orchestrator", content: currentResponse
    }), ctx);
    emit("critic", { critic: criticResult.evaluation });
  }

  const latencyMs = Date.now() - startTime;
  logger.info("stage.timings", { latencyMs, stageTimings: ctx.timings });

  // --- Phase 2: cognitive layer — governance ---
  //
  // PRESERVED BEHAVIOUR: the Governor is the sovereignty layer. It refuses to
  // approve output that is empty or that leaks credentials. It flags rather than
  // fabricates — it will never substitute invented text for a failed response.
  const governorMsg = createMessage({
    type: "council.govern",
    from: "orchestrator",
    content: { responseText: currentResponse.responseText }
  });
  const governorResult = await orchestrator.dispatch("governor", governorMsg, ctx);
  emit("governor", { approved: governorResult.approved, flags: governorResult.flags });

  // --- Post-response stages (best-effort, run concurrently) ---
  // Memory extraction, audit logging, and summarization do not affect the
  // response text. Running them concurrently (instead of serially) cuts the
  // post-response tail to the slowest of the three, while still awaiting the
  // batch so all three are guaranteed to complete before the function returns
  // (memories, audit, and summary are core COGNOS functionality — not dropped).
  const memMsg = createMessage({
    type: "memory.request",
    from: "orchestrator",
    content: { workspaceId, conversationId, userMessage, responseText: currentResponse.responseText }
  });
  const auditMsg = createMessage({
    type: "audit.request",
    from: "orchestrator",
    content: {
      workspaceId,
      conversationId,
      modelUsed: currentResponse.modelUsed,
      taskType: currentResponse.taskType,
      latencyMs,
      status: "success"
    }
  });
  const summaryEnabled = ctx.config.orchestrator.summaryEnabled !== false;
  const [, , summaryResult, deferredCriticResult] = await Promise.allSettled([
    orchestrator.dispatch("memoryExtraction", memMsg, ctx),
    orchestrator.dispatch("auditLog", auditMsg, ctx),
    summaryEnabled
      ? summarizeConversation(ctx, conversationId, contextResult.history, userMessage, currentResponse.responseText)
      : Promise.resolve(null),
    deferredCritic || Promise.resolve(null)
  ]);
  const conversationSummary = summaryResult.status === "fulfilled" ? summaryResult.value : null;
  if (deferredCritic && deferredCriticResult.status === "fulfilled" && deferredCriticResult.value) {
    criticResult = deferredCriticResult.value;
  }

  await eventBus.publish("orchestration.complete", { latencyMs });

  return {
    response: currentResponse.responseText,
    taskType: currentResponse.taskType,
    modelUsed: currentResponse.modelUsed,
    latencyMs,
    summary: conversationSummary,
    council: {
      memoriesUsed: (contextResult.memories || []).map(m => ({ id: m.id, preview: String(m.content || '').slice(0, 120), evidence: m.evidence_level || null, volatility: m.volatility || null })),
      classification: observerResult.classification,
      webSearch: webSearchResult.searchResults ? { query: webSearchResult.searchQuery, results: webSearchResult.searchResults, model: webSearchResult.webSearchModel } : null,
      plan: strategistResult.plan,
      taskContextId: strategistResult.taskContext?.id || null,
      subTasks: specialistResult.subTaskOutputs || null,
      critic: criticResult.evaluation,
      revisions: { count: revisionCount, triggered: revisionTriggered, maxRevisions },
      adaptive: { complexity: observerResult.classification?.complexity, path: isSimple ? 'direct' : 'full' },
      governor: { approved: governorResult.approved, flags: governorResult.flags },
      stageTimings: ctx.timings || {}
    }
  };
}
