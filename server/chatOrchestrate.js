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
import db, { newId } from "./db.js";
// Phase 14 — Dynamic Systems: the subsystems the council consults.
import { registerKnowledgeStages } from "./knowledge/index.js";
import { createTemporalReasoner } from "./knowledge/temporal.js";
// Phase 15 — Meta-Cognition: the subsystems that observe it.
import { createRunRecorder } from "./meta/telemetry.js";
import { selectStrategy } from "./meta/adaptive.js";

const rootLogger = createLogger("chatOrchestrate");

// Fixed sovereignty refusal, released only when the Governor vetoes a draft
// that would leak a credential. Deliberately NOT model-generated: the council
// never invents substitute answers for a vetoed one.
const SOVEREIGNTY_REFUSAL =
  "The Governor stopped that reply: it looked like it would leak something private, so it never ships. Ask me another way.";

// What the SSE stream and the persisted trace are allowed to see of a coherence
// report: the measurement, not the internal prompt material.
function publicCoherence(report) {
  if (!report) return null;
  return {
    checked: report.checked !== false,
    verdict: report.verdict || "unchecked",
    reason: report.reason || null,
    note: report.note || null,
    beliefsConsidered: report.beliefsConsidered ?? 0,
    contradictions: (report.contradictions || []).map(c => ({ claim: c.claim, beliefId: c.belief_id, confidence: c.confidence, note: c.note })),
    confirmations: (report.confirmations || []).map(c => ({ claim: c.claim, beliefId: c.belief_id, confidence: c.confidence })),
    hypotheses: (report.newClaims || []).map(c => ({ claim: c.claim, confidence: c.confidence, scope: c.scope }))
  };
}

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
      // Phase 15.1: labels this call in the telemetry record. This call overlaps
      // the Observer, so the bus's current stage would misattribute it.
      purpose: "memoryRelevance",
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
      purpose: "summary",           // Phase 15.1: runs concurrently in the post batch
      responseJsonSchema: SUMMARIZE_SCHEMA,
      messages: [
        { role: "system", content: "Summarize the following conversation in 1-2 concise sentences. Capture what the user wanted and the outcome. Return only the summary text." },
        { role: "user", content: transcript }
      ]
    });
    const summary = result?.summary?.trim();
    if (summary) {
      // Phase 14.1: a summary write is stored knowledge, so its transition is
      // appended in the same transaction as the write.
      await ctx.db.Conversation.update(conversationId, { summary }, { ledger: { runId: ctx.runId, messageId: null, kind: "run" } });
      return summary;
    }
  } catch (e) {
    ctx.logger.warn("conversation summarization failed", { error: String(e) });
  }
  return null;
}

/**
 * Run the council for one turn.
 *
 * Phase 15.1 wraps the pipeline so that EVERY run produces exactly one telemetry
 * record — including a run that fails. The wrapper owns the record's lifecycle;
 * the pipeline below is unchanged in what it returns and in how it fails.
 *
 * @param {object} body    { conversationId, workspaceId, userMessage, style, attachments, webSearch }
 * @param {object} options { emit(event, payload), onToken(delta), runId }
 */
export async function runCouncilTurn(body, options = {}) {
  const runId = options.runId || newId("run");
  const config = getSystemConfig();
  const recorder = createRunRecorder({
    runId,
    conversationId: body?.conversationId ?? null,
    workspaceId: body?.workspaceId ?? null,
    userMessage: body?.userMessage ?? null,
    config,
    logger: rootLogger.child("telemetry")
  });
  try {
    return await executeCouncilTurn(body, options, { runId, recorder });
  } catch (error) {
    // A simulated or real upstream failure — bad model name, forced timeout,
    // gateway 5xx — lands here. It becomes a documented failure in telemetry
    // (kind, stage, model, HTTP status, latency) before the error propagates to
    // the existing error path untouched.
    await recorder.finalize({ status: "error", error });
    throw error;
  }
}

async function executeCouncilTurn(body, options = {}, run = {}) {
  const { emit = () => {}, onToken = null } = options;
  const { runId, recorder } = run;
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

  // Phase 15.1 — telemetry subscribes to the SAME bus rather than threading new
  // callbacks through every operator. Stage start/complete, latency and status
  // arrive here without one council operator changing.
  recorder.attachBus(eventBus);

  // Phase 15.4 — the adaptive orchestrator selects a strategy and records why.
  // Observe mode only: this changes nothing about what runs (there is one
  // strategy), it makes the selection visible.
  const selection = await selectStrategy({
    db,
    signals: { workspaceId, messageChars: String(userMessage || "").length },
    logger
  });
  recorder.setSelection(selection);

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
          purpose: "memoryExtraction",   // Phase 15.1: runs concurrently in the post batch
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
            // Phase 14.1: the memory rows, their ledger events, their confidence
            // samples and the beliefs they project into are ONE transaction.
            await ctx.db.Memory.bulkCreate(records, {
              ledger: { runId: ctx.runId, messageId: conversationId, kind: "run" },
              config: ctx.config.knowledge,
              origin: "council_memory_extraction"
            });
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
  // Phase 14/15 subsystems: registered as pipeline stages BESIDE contextAssembly,
  // memoryExtraction and auditLog. They are not council seats and they do not
  // vote — the six operators in registerCouncil() are unchanged.
  registerKnowledgeStages(registry);

  // Token forwarding is wrapped so the recorder can measure time-to-first-token.
  // The wrapper calls the original onToken with the original delta: the stream
  // the user sees is byte-for-byte the one that existed before Phase 15.
  const forwardToken = onToken ? (delta) => { recorder.noteFirstToken(); onToken(delta); } : null;

  const ctx = {
    db, config, logger, timings: {},
    stream: Boolean(forwardToken), onToken: forwardToken,
    // Phase 15.1 — the run's recorder. server/llm.js reports every model call to
    // it, which is how a timeout or a 502 becomes a record instead of a mystery.
    runId, telemetry: recorder,
    // Phase 14.3 — the temporal reasoner. A helper any operator can call during
    // the run (the Critic does, in council/critic.js); NOT a new operator.
    temporal: createTemporalReasoner({ db, workspaceId, runId, logger })
  };

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

  // --- Phase 14.5: the Coherence Monitor ---
  // DETECTS, before the Critic, so the Critic and the Governor both see the
  // report as data they can act on. It writes nothing here: persistence happens
  // after the Governor's verdict, because a vetoed draft must never become
  // knowledge. Best-effort — a failure yields verdict "error" and the pipeline
  // continues exactly as it did before Phase 14.
  let coherenceReport = null;
  const coherenceEnabled = config.knowledge?.coherenceEnabled !== false;
  if (coherenceEnabled) {
    const coherenceResult = await orchestrator.dispatch("coherenceMonitor", createMessage({
      type: "knowledge.coherence", from: "orchestrator", content: currentResponse
    }), ctx);
    currentResponse = coherenceResult;
    coherenceReport = coherenceResult.coherence || null;
    recorder.setCoherence(coherenceReport);
    emit("coherence", publicCoherence(coherenceReport));
  }

  // The Critic's score is the confidence the council already expresses (15.1).
  const noteCritic = (evaluation) => {
    if (evaluation && !evaluation.skipped && typeof evaluation.score === "number") {
      recorder.setConfidence(evaluation.score / 10, "critic.score/10");
    }
    if (evaluation?.temporal) recorder.setKnowledge?.({ criticTemporal: evaluation.temporal.summary ?? null });
  };

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
    noteCritic(criticResult.evaluation);
  } else {
    deferredCritic = orchestrator.dispatch("critic", createMessage({
      type: "council.critique", from: "orchestrator", content: currentResponse
    }), ctx).then(r => { emit("critic", { critic: r.evaluation }); noteCritic(r.evaluation); return r; });
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
    // A revised draft is a new draft: the coherence measurement of the previous
    // one no longer describes it, so the monitor runs again (bounded by
    // maxRevisions, which is 1).
    if (coherenceEnabled) {
      const recheck = await orchestrator.dispatch("coherenceMonitor", createMessage({
        type: "knowledge.coherence", from: "orchestrator", content: currentResponse
      }), ctx);
      currentResponse = recheck;
      coherenceReport = recheck.coherence || null;
      recorder.setCoherence(coherenceReport);
      emit("coherence", publicCoherence(coherenceReport));
    }
    criticResult = await orchestrator.dispatch("critic", createMessage({
      type: "council.critique", from: "orchestrator", content: currentResponse
    }), ctx);
    emit("critic", { critic: criticResult.evaluation });
    noteCritic(criticResult.evaluation);
  }

  const latencyMs = Date.now() - startTime;
  logger.info("stage.timings", { latencyMs, stageTimings: ctx.timings });

  // --- Phase 2: cognitive layer — governance ---
  //
  // PRESERVED BEHAVIOUR: the Governor is the sovereignty layer. It refuses to
  // approve output that is empty or that leaks credentials. It flags rather than
  // fabricates — it will never substitute invented text for a failed response.
  // Phase 14.5: the Governor receives the coherence report as data. Its
  // rule-based decision logic is untouched — coherence can never flip `approved`
  // and can never add a flag. It rides along so the verdict, the trace and the
  // telemetry record all carry what the monitor measured.
  const governorMsg = createMessage({
    type: "council.govern",
    from: "orchestrator",
    content: { responseText: currentResponse.responseText, coherence: coherenceReport, runId }
  });
  const governorResult = await orchestrator.dispatch("governor", governorMsg, ctx);
  emit("governor", { approved: governorResult.approved, flags: governorResult.flags });

  // --- The veto has teeth ---
  // If the Governor refuses, the draft does NOT ship. A flagged text that
  // looks like a leaked credential is replaced with a fixed refusal line
  // (never invented substitute content). An empty draft stays empty: the
  // council would rather be silent than fabricate. Everything downstream
  // (memory extraction, summarization, the HTTP response) sees the final
  // text, never the vetoed one.
  const vetoed = governorResult.approved === false;
  let finalResponseText = currentResponse.responseText;
  if (vetoed && (governorResult.flags || []).includes("potential_secret_leak")) {
    finalResponseText = SOVEREIGNTY_REFUSAL;
  }

  // Phase 15.1 — a veto is recorded with the operator that produced the rejected
  // draft and the Governor's reason. The draft text itself is never stored: the
  // record keeps its length and SHA-256 only (pin.veto_integrity).
  const draftOrigin = revisionCount > 0
    ? "synthesizer (revision)"
    : (synthResult.needsSynthesis ? "synthesizer" : "specialist");
  recorder.setVeto({
    approved: governorResult.approved,
    flags: governorResult.flags,
    draftText: vetoed ? currentResponse.responseText : null,
    draftOrigin,
    finalText: finalResponseText
  });
  recorder.setResult({
    taskType: currentResponse.taskType,
    complexity: observerResult.classification?.complexity ?? null,
    responseChars: String(finalResponseText || "").length
  });

  // --- Post-response stages (best-effort, run concurrently) ---
  // Memory extraction, audit logging, and summarization do not affect the
  // response text. Running them concurrently (instead of serially) cuts the
  // post-response tail to the slowest of the three, while still awaiting the
  // batch so all three are guaranteed to complete before the function returns
  // (memories, audit, and summary are core COGNOS functionality — not dropped).
  const memMsg = createMessage({
    type: "memory.request",
    from: "orchestrator",
    content: { workspaceId, conversationId, userMessage, responseText: finalResponseText }
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
  // Phase 14 — a vetoed draft writes NOTHING to memory and nothing to the
  // summary. The veto has teeth downstream of the answer too: the refusal line
  // is what ships, and it is not treated as a fact about the user.
  const memoryEnabled = !vetoed;
  const summaryEnabled = ctx.config.orchestrator.summaryEnabled !== false && !vetoed;

  // Knowledge writes are serialized (memory -> projection -> telemetry) so two
  // transactions never race over the same belief, while audit, summary and the
  // deferred critic still overlap them.
  const knowledgeChain = (async () => {
    const [memoryOutcome, deferredCriticOutcome] = await Promise.all([
      memoryEnabled
        ? orchestrator.dispatch("memoryExtraction", memMsg, ctx)
        : Promise.resolve({ skipped: "governor_veto" }),
      deferredCritic || Promise.resolve(null)
    ]);
    if (deferredCriticOutcome) {
      criticResult = deferredCriticOutcome;
      noteCritic(criticResult.evaluation);
    }
    const projection = await orchestrator.dispatch("knowledgeProjection", createMessage({
      type: "knowledge.project",
      from: "orchestrator",
      content: {
        workspaceId, conversationId, runId,
        coherence: coherenceReport,
        vetoed,
        governor: { approved: governorResult.approved, flags: governorResult.flags },
        finalText: finalResponseText,
        // The rejected draft reaches the ledger only as a length and a digest.
        draftText: vetoed ? currentResponse.responseText : null,
        draftOrigin
      }
    }), ctx);
    const telemetryStage = await orchestrator.dispatch("telemetryRecord", createMessage({
      type: "meta.telemetry",
      from: "orchestrator",
      content: { runId, vetoed, status: vetoed ? "vetoed" : "success" }
    }), ctx);
    return { memory: memoryOutcome, knowledge: projection.knowledge, telemetry: telemetryStage.telemetry };
  })();

  const [, summaryResult, knowledgeOutcome] = await Promise.allSettled([
    orchestrator.dispatch("auditLog", auditMsg, ctx),
    summaryEnabled
      ? summarizeConversation(ctx, conversationId, contextResult.history, userMessage, finalResponseText)
      : Promise.resolve(null),
    knowledgeChain
  ]);
  const conversationSummary = summaryResult.status === "fulfilled" ? summaryResult.value : null;
  const knowledgeResult = knowledgeOutcome.status === "fulfilled" ? knowledgeOutcome.value : null;
  if (knowledgeOutcome.status === "rejected") {
    logger.warn("knowledge/telemetry chain failed", { error: String(knowledgeOutcome.reason) });
  }

  // Safety net: finalize() is idempotent, so the run is recorded exactly once
  // even if the chain above could not reach the telemetry stage.
  await recorder.finalize({ status: vetoed ? "vetoed" : "success" });

  await eventBus.publish("orchestration.complete", { latencyMs });

  const knowledgeDetail = knowledgeResult?.knowledge ?? null;
  emit("knowledge", knowledgeDetail ? {
    ledgerEvents: knowledgeDetail.ledgerEvents ?? 0,
    coherence: knowledgeDetail.coherence ?? null,
    relationship: knowledgeDetail.relationship ?? null,
    decay: knowledgeDetail.decay ?? null,
    veto: knowledgeDetail.veto ?? null
  } : null);

  return {
    response: finalResponseText,
    taskType: currentResponse.taskType,
    modelUsed: currentResponse.modelUsed,
    latencyMs,
    summary: conversationSummary,
    // Phase 14/15: the run's identity, so the persisted message, the ledger and
    // the telemetry record all point at each other.
    runId,
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
      governor: { approved: governorResult.approved, flags: governorResult.flags, coherence: publicCoherence(coherenceReport) },
      stageTimings: ctx.timings || {},
      // Phase 14 — what the knowledge layer did with this exchange.
      coherence: publicCoherence(coherenceReport),
      knowledge: knowledgeDetail,
      // Phase 15 — this run's telemetry record, as written. runId is repeated
      // here so the council trace in the UI can follow a conclusion back to its
      // ledger events and telemetry record.
      runId,
      telemetry: recorder.summary ? recorder.summary() : null,
      strategy: { id: selection.strategyId, mode: selection.mode, reason: selection.reason, switched: false }
    }
  };
}
