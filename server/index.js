// COGNOS API — the app's own routes. No Base44, no platform functions, no meter.
//
// This module exports the Express app WITHOUT calling listen(). That split is
// deliberate: Vercel imports the app as a serverless handler (api/index.js) and
// never runs a listener, while local/self-hosted runs use server/serve.js.
// Calling listen() here would work locally and silently do nothing on Vercel.
//
// Routes:
//   GET  /api/health                       liveness + config visibility (no secrets)
//   GET  /api/workspace                    the single default workspace (lazily created)
//   PATCH/api/workspace                    edit name/instructions
//   GET  /api/conversations                thread list for the sidebar
//   POST /api/conversations                create a thread
//   PATCH/DELETE /api/conversations/:id    rename / archive / delete
//   GET  /api/conversations/:id/messages   full transcript (with saved council traces)
//   POST /api/chat                         THE send path — SSE stream of the council
//   GET  /api/memories                     memory view
//   POST/PATCH/DELETE /api/memories        add / toggle / edit / delete
//   GET  /api/activity                     audit log view
//
// Phase 14 (Dynamic Systems) — read-only query surfaces over the event ledger:
//   GET  /api/knowledge/events             the ledger, filtered
//   GET  /api/knowledge/overview           what the store holds, by transition
//   GET  /api/knowledge/analytics          change rate, stability index, churn
//   GET  /api/knowledge/beliefs            current beliefs
//   GET  /api/knowledge/relationships      living structures + effective strength
//   GET  /api/knowledge/coherence          coherence reports (?verdict=contradiction)
//   GET  /api/knowledge/state/:type/:id    REPLAY: state at ?at=<ms|ISO>
//   GET  /api/knowledge/verify/:type/:id   fold-of-history vs materialized row
//   GET  /api/knowledge/lineage/:type/:id  every event behind an entity
//   GET  /api/knowledge/lineage/run/:runId every event behind a run
//   GET  /api/knowledge/temporal/:type/:id the temporal reasoner's digest
//
// Phase 15 (Meta-Cognition) — the system studying itself:
//   GET  /api/meta/telemetry               run records (?summary=1 aggregates)
//   GET  /api/meta/telemetry/:runId        one run: stages, model calls, ledger
//   GET  /api/meta/strategies              the strategy registry (one row in v1)
//   GET  /api/meta/registry-check          why shared/registry.js did not fit
//   GET  /api/meta/laws                    the law layer (read-only)
//   GET  /api/meta/policy                  what the Policy Engine gates
//   GET  /api/meta/improvements            the Improvement Ledger
//   POST /api/meta/adaptations             propose an adaptation -> judged + logged
//   GET  /api/meta/adaptive                observe-mode selection decisions
//   GET  /api/meta/evaluations             offline harness results
//   GET  /api/meta/rates                   the cost rate table
//
// Access gate: only active when COGNOS_RUNTIME_SECRET is set. No gate otherwise.

import express from "express";
import cookieParser from "cookie-parser";
import db, { newId, ledgerEnabled } from "./db.js";
import { isConfigured } from "./db.js";
import { getSystemConfig } from "./config.js";
import { runCouncilTurn } from "./chatOrchestrate.js";
import { createLogger } from "./shared/logging.js";
// Phase 14
import { createTemporalReasoner } from "./knowledge/temporal.js";
import { analytics, changeRatePerEntity, stabilityIndex, churnOverTime, overview } from "./knowledge/analytics.js";
import { effectiveStrength } from "./knowledge/relationships.js";
import { TRACKED_FIELDS } from "./knowledge/store.js";
import { num } from "./db/util.js";
// Phase 15
import { LAWS, LAW_LAYER_VERSION, describeLaws, assertLawLayerImmutable } from "./council/laws.js";
import { proposeAdaptation, describePolicy, GATED_ACTIONS } from "./meta/policy.js";
import { CANONICAL_STRATEGY_ID, listStrategies, recordEvidenceFromTelemetry, describeRegistryCheck } from "./meta/strategies.js";
import { resolveAdaptiveMode, SWITCH_THRESHOLDS, evaluateSwitch } from "./meta/adaptive.js";
import { describeRateTable } from "./meta/rates.js";
import { runDetail } from "./meta/telemetry.js";

const logger = createLogger("server");
export const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.disable("x-powered-by");

// --- Optional access gate ---------------------------------------------------
// Activates ONLY when COGNOS_RUNTIME_SECRET is set. It is a cookie check, not an
// account system: visit /gate?key=<secret> once and the cookie is set. When the
// variable is unset there is no gate at all and the app opens straight to chat.
const GATE_COOKIE = "cognos_gate";

app.get("/gate", (req, res) => {
  const secret = process.env.COGNOS_RUNTIME_SECRET;
  if (!secret) return res.redirect("/");
  if (req.query.key === secret) {
    res.cookie(GATE_COOKIE, secret, { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 24 * 365 });
    return res.redirect("/");
  }
  res.status(401).type("html").send("<h1>COGNOS</h1><p>Access key required.</p>");
});

app.use((req, res, next) => {
  const secret = process.env.COGNOS_RUNTIME_SECRET;
  if (!secret) return next();                       // no gate configured
  if (req.path === "/gate" || req.path === "/api/health") return next();
  if (req.cookies?.[GATE_COOKIE] === secret) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Unauthorized" });
  res.status(401).type("html").send("<h1>COGNOS</h1><p>Access key required.</p>");
});

function wrap(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch(err => {
    logger.error("route error", { path: req.path, error: String(err) });
    if (res.headersSent) return res.end();
    res.status(err.status || 500).json({ error: err.message || "Internal error" });
  });
}

// --- Health -----------------------------------------------------------------
app.get("/api/health", (req, res) => {
  const config = getSystemConfig();
  const adaptive = resolveAdaptiveMode(config.telemetry.requestedAdaptiveMode);
  res.json({
    ok: true,
    model: config.models.primary,
    fastModel: config.models.memory,
    databaseConfigured: isConfigured(),
    searchProvider: config.search.enabled ? config.search.provider : "disabled",
    modelKeyConfigured: Boolean(process.env.BLUESMINDS_API_KEY || process.env.OPENAI_API_KEY),
    gate: Boolean(process.env.COGNOS_RUNTIME_SECRET),
    // Phase 14/15 subsystem state. Additive keys; nothing above changed.
    ledger: config.knowledge.ledgerEnabled,
    coherence: config.knowledge.coherenceEnabled,
    telemetry: config.telemetry.enabled,
    adaptiveMode: adaptive.mode,
    adaptiveModeForced: adaptive.forced,
    strategy: CANONICAL_STRATEGY_ID,
    laws: LAWS.length,
    lawLayerVersion: LAW_LAYER_VERSION
  });
});

// --- Workspace ---------------------------------------------------------------
app.get("/api/workspace", wrap(async (req, res) => {
  res.json(await db.Workspace.ensureDefault());
}));

app.patch("/api/workspace", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  res.json(await db.Workspace.update(ws.id, req.body || {}));
}));

// --- Conversations -----------------------------------------------------------
app.get("/api/conversations", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  res.json(await db.Conversation.list(ws.id, 100));
}));

app.post("/api/conversations", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  const title = (req.body?.title || "New conversation").slice(0, 120);
  res.json(await db.Conversation.create({ workspace_id: ws.id, title }));
}));

app.patch("/api/conversations/:id", wrap(async (req, res) => {
  res.json(await db.Conversation.update(req.params.id, req.body || {}));
}));

app.delete("/api/conversations/:id", wrap(async (req, res) => {
  res.json(await db.Conversation.delete(req.params.id));
}));

app.get("/api/conversations/:id/messages", wrap(async (req, res) => {
  const conversation = await db.Conversation.get(req.params.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  const messages = await db.Message.listByConversation(req.params.id);
  res.json({ conversation, messages });
}));

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
  const { userMessage, style, attachments, webSearch } = req.body || {};
  if (typeof userMessage !== "string" || !userMessage.trim()) {
    return res.status(400).json({ error: "userMessage is required" });
  }

  const workspace = await db.Workspace.ensureDefault();

  let conversationId = req.body?.conversationId || null;
  let createdConversation = null;
  if (!conversationId) {
    createdConversation = await db.Conversation.create({
      workspace_id: workspace.id,
      title: userMessage.slice(0, 50) + (userMessage.length > 50 ? "..." : ""),
      last_message_preview: userMessage
    });
    conversationId = createdConversation.id;
  }

  // Phase 15.1: the run is identified here, before the council starts, so both
  // the success path and the failure path can link the persisted message to the
  // telemetry record and to the ledger.
  const runId = newId("run");

  const userMsg = await db.Message.create({
    conversation_id: conversationId,
    workspace_id: workspace.id,
    role: "user",
    content: userMessage,
    attachments: attachments?.length ? attachments : null,
    processing_status: "complete"
  });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send("start", { conversationId, conversation: createdConversation, userMessage: userMsg, runId });

  try {
    const result = await runCouncilTurn(
      { conversationId, workspaceId: workspace.id, userMessage, style, attachments, webSearch },
      {
        runId,
        emit: (event, payload) => send(event, payload),
        onToken: (delta) => send("token", { delta })
      }
    );

    // Phase 14.1 — the conclusion, its ledger event, the conversation-metadata
    // write and the telemetry link are ONE transaction: either the answer is
    // stored with its history, or nothing is. `result.response` is the FINAL
    // text — the Governor's veto already decided what that is, and a vetoed
    // draft is not in it (pin.veto_integrity).
    const assistantMsg = await db.withTransaction(async (store) => {
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
      await store.TelemetryRun.setMessageId(runId, msg.id).catch(() => null);
      await store.Conversation.update(conversationId, {
        last_message_preview: String(result.response || "").slice(0, 100)
      }, { ledger: { runId, messageId: msg.id, kind: "message" } });
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
    res.end();
  }
}));

// --- Memory ------------------------------------------------------------------
app.get("/api/memories", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  res.json(await db.Memory.filter({ workspace_id: ws.id }, 200));
}));

app.post("/api/memories", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "content is required" });
  res.json(await db.Memory.create({
    workspace_id: ws.id,
    content,
    memory_type: req.body?.memory_type || "semantic",
    importance: req.body?.importance ?? 5,
    evidence_level: "direct",
    volatility: req.body?.volatility || "medium"
  }));
}));

app.patch("/api/memories/:id", wrap(async (req, res) => {
  res.json(await db.Memory.update(req.params.id, req.body || {}));
}));

app.delete("/api/memories/:id", wrap(async (req, res) => {
  res.json(await db.Memory.delete(req.params.id));
}));

// --- Activity ----------------------------------------------------------------
app.get("/api/activity", wrap(async (req, res) => {
  res.json(await db.AuditEvent.recent(100));
}));

// ===========================================================================
// Phase 14 — Dynamic Systems. Read-only query surfaces over the event ledger.
// Bare JSON, as the phase allows: these are instruments for an operator, not a
// UI. Nothing here writes, and nothing here is on the send path.
// ===========================================================================

/** Accept either epoch milliseconds or an ISO instant. */
function parseAt(value) {
  if (value === undefined || value === null || value === "") return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 1e11) return Math.trunc(asNumber);
  const asDate = Date.parse(String(value));
  return Number.isFinite(asDate) ? asDate : null;
}

const hydrateEvent = (e) => ({
  ...e,
  seq: num(e.seq),
  ts_ms: num(e.ts_ms),
  at: new Date(num(e.ts_ms)).toISOString(),
  reversible: Boolean(e.reversible)
});

app.get("/api/knowledge/events", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  const rows = await db.KnowledgeEvent.recent({
    workspaceId: req.query.scope === "all" ? null : ws.id,
    entityType: req.query.entityType || null,
    entityId: req.query.entityId || null,
    transition: req.query.transition || null,
    runId: req.query.runId || null,
    messageId: req.query.messageId || null,
    sinceMs: parseAt(req.query.since),
    untilMs: parseAt(req.query.until),
    limit: Number(req.query.limit || 100)
  });
  res.json({ count: rows.length, appendOnly: true, transitions: db.KnowledgeEvent.transitions(), events: rows.map(hydrateEvent) });
}));

app.get("/api/knowledge/overview", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  res.json(await overview(db, { workspaceId: ws.id }));
}));

app.get("/api/knowledge/analytics", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  res.json(await analytics(db, {
    workspaceId: ws.id,
    windowDays: Number(req.query.windowDays || 30),
    bucketHours: Number(req.query.bucketHours || 24),
    limit: Number(req.query.limit || 50)
  }));
}));

app.get("/api/knowledge/analytics/change-rate", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  res.json(await changeRatePerEntity(db, { workspaceId: ws.id, windowDays: Number(req.query.windowDays || 30), limit: Number(req.query.limit || 50) }));
}));

app.get("/api/knowledge/analytics/stability", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  res.json(await stabilityIndex(db, { workspaceId: ws.id, windowDays: Number(req.query.windowDays || 30), entityType: req.query.entityType || "belief", limit: Number(req.query.limit || 50) }));
}));

app.get("/api/knowledge/analytics/churn", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  res.json(await churnOverTime(db, { workspaceId: ws.id, windowDays: Number(req.query.windowDays || 14), bucketHours: Number(req.query.bucketHours || 24) }));
}));

app.get("/api/knowledge/beliefs", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  const rows = await db.Belief.list(ws.id, { status: req.query.status || null, limit: Number(req.query.limit || 100) });
  const at = Date.now();
  res.json({
    count: rows.length,
    note: "Nothing is deleted: a retired belief keeps its row and its history.",
    beliefs: rows.map(b => ({ ...b, confidence: num(b.confidence), lineage: b.lineage || null }))
  });
}));

app.get("/api/knowledge/relationships", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  const at = Date.now();
  const rows = await db.Relationship.list(ws.id, { kind: req.query.kind || null, status: req.query.status || null, limit: Number(req.query.limit || 100), at });
  res.json({
    count: rows.length,
    at,
    note: "effective_strength applies exponential decay from strength_as_of_ms, so a stale link weakens with no writer involved.",
    relationships: rows.map(r => ({ ...r, strength: num(r.strength), effective_strength: Number(num(r.effective_strength, 0).toFixed(6)) }))
  });
}));

app.get("/api/knowledge/coherence", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  const rows = await db.CoherenceReport.recent({ verdict: req.query.verdict || null, workspaceId: ws.id, limit: Number(req.query.limit || 50) });
  res.json({ count: rows.length, reports: rows.map(r => ({ ...r, confidence_delta: num(r.confidence_delta) })) });
}));

// --- 14.2 REPLAY: any entity's state at any past instant --------------------
app.get("/api/knowledge/state/:entityType/:entityId", wrap(async (req, res) => {
  const { entityType, entityId } = req.params;
  const at = parseAt(req.query.at);
  const replay = await db.Replay.stateAt(entityType, entityId, { atMs: at });
  const tracked = TRACKED_FIELDS[entityType] || null;
  const verification = tracked ? await db.Replay.verify(entityType, entityId, tracked) : null;
  res.json({
    entityType, entityId,
    asOf: replay.asOf ?? new Date().toISOString(),
    replayed: replay.asOf !== null,
    exists: replay.exists,
    state: replay.state,
    eventCount: replay.eventCount,
    firstEventAt: replay.firstEventAt,
    lastTransition: replay.lastTransition,
    history: replay.history,
    trackedFields: tracked,
    // Proof that current state IS the fold: folding the whole ledger with no
    // cut-off must reproduce the materialized row, field for field.
    foldMatchesCurrentState: verification ? { consistent: verification.consistent, drift: verification.drift, current: verification.current } : null
  });
}));

app.get("/api/knowledge/verify/:entityType/:entityId", wrap(async (req, res) => {
  const { entityType, entityId } = req.params;
  const tracked = TRACKED_FIELDS[entityType];
  if (!tracked) return res.status(400).json({ error: `No tracked projection for entity type '${entityType}'. Known: ${Object.keys(TRACKED_FIELDS).join(", ")}` });
  res.json(await db.Replay.verify(entityType, entityId, tracked));
}));

// --- temporal lineage -------------------------------------------------------
app.get("/api/knowledge/lineage/run/:runId", wrap(async (req, res) => {
  const temporal = createTemporalReasoner({ db, logger });
  const [lineage, runDigest] = await Promise.all([
    db.Replay.lineage({ runId: req.params.runId, limit: 500 }),
    temporal.digestForRun(req.params.runId)
  ]);
  res.json({ runId: req.params.runId, ...lineage, digest: runDigest });
}));

app.get("/api/knowledge/lineage/:entityType/:entityId", wrap(async (req, res) => {
  const { entityType, entityId } = req.params;
  const lineage = await db.Replay.lineage({ entityType, entityId, limit: 500 });
  res.json({ entityType, entityId, ...lineage });
}));

app.get("/api/knowledge/temporal/:entityType/:entityId", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  const { entityType, entityId } = req.params;
  const temporal = createTemporalReasoner({ db, workspaceId: ws.id, logger });
  const [velocity, trend, stability, before] = await Promise.all([
    temporal.confidenceVelocity(entityType, entityId),
    temporal.uncertaintyTrend(entityType, entityId),
    temporal.stability(entityType, entityId),
    temporal.whatChangedBefore({ anchorMs: Date.now(), limit: 10 })
  ]);
  res.json({ entityType, entityId, confidenceVelocity: velocity, uncertaintyTrend: trend, stability, whatChangedBefore: before });
}));

app.get("/api/knowledge/temporal", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  const temporal = createTemporalReasoner({ db, workspaceId: ws.id, logger });
  const ids = String(req.query.beliefs || "").split(",").map(x => x.trim()).filter(Boolean);
  const [workspaceDigest, beliefs] = await Promise.all([
    temporal.digestForWorkspace({ windowDays: Number(req.query.windowDays || 7) }),
    ids.length ? temporal.digestForBeliefs(ids) : Promise.resolve(null)
  ]);
  res.json({ workspace: workspaceDigest, beliefs });
}));

// ===========================================================================
// Phase 15 — Meta-Cognition. The system studying its own reasoning.
// ===========================================================================

app.get("/api/meta/telemetry", wrap(async (req, res) => {
  const ws = await db.Workspace.ensureDefault();
  if (req.query.summary) {
    const [summary, strategies] = await Promise.all([
      db.TelemetryRun.summary({ workspaceId: ws.id, sinceMs: parseAt(req.query.since) }),
      listStrategies(db, { logger })
    ]);
    return res.json({ summary, strategies, thresholds: SWITCH_THRESHOLDS, switchAnalysis: evaluateSwitch({ baseline: summary[0], candidate: summary[1] }) });
  }
  const rows = await db.TelemetryRun.recent({
    limit: Number(req.query.limit || 50),
    status: req.query.status || null,
    conversationId: req.query.conversationId || null,
    workspaceId: req.query.scope === "all" ? null : ws.id
  });
  res.json({
    count: rows.length,
    runs: rows.map(r => ({
      ...r,
      cost_usd: num(r.cost_usd),
      confidence: num(r.confidence),
      stages: r.stages || null,
      failures: r.failures || [],
      adaptive: r.adaptive || null
    }))
  });
}));

app.get("/api/meta/telemetry/:runId", wrap(async (req, res) => {
  const detail = await runDetail(db, req.params.runId);
  if (!detail) return res.status(404).json({ error: "No telemetry record for that run" });
  res.json({ ...detail, cost_usd: num(detail.cost_usd), confidence: num(detail.confidence) });
}));

app.get("/api/meta/model-calls", wrap(async (req, res) => {
  const rows = await db.TelemetryModelCall.recent({ limit: Number(req.query.limit || 100), status: req.query.status || null });
  res.json({ count: rows.length, calls: rows.map(c => ({ ...c, cost_usd: num(c.cost_usd) })) });
}));

app.get("/api/meta/strategies", wrap(async (req, res) => {
  const strategies = await listStrategies(db, { logger });
  const evidence = await recordEvidenceFromTelemetry(db, { logger }).catch(() => []);
  res.json({ count: strategies.length, seededWithOneRow: strategies.length === 1, strategies, refreshedEvidence: evidence });
}));

app.get("/api/meta/registry-check", wrap(async (req, res) => {
  res.json(describeRegistryCheck());
}));

app.get("/api/meta/laws", wrap(async (req, res) => {
  res.json({
    version: LAW_LAYER_VERSION,
    count: LAWS.length,
    runtimeModifiable: false,
    immutabilityCheck: assertLawLayerImmutable(),
    laws: describeLaws()
  });
}));

app.get("/api/meta/policy", wrap(async (req, res) => {
  res.json(describePolicy());
}));

app.get("/api/meta/improvements", wrap(async (req, res) => {
  const rows = await db.ImprovementLedger.recent({ limit: Number(req.query.limit || 100), decision: req.query.decision || null, action: req.query.action || null });
  res.json({ count: rows.length, appendOnly: true, improvements: rows });
}));

/**
 * The gate. Every architectural adaptation is judged against the law layer and
 * the judgment is appended to the Improvement Ledger — refusals included.
 * A refusal answers 409 with the laws it violated; that is the answer, not an
 * error. In v1 an approved adaptation is authorized and recorded: only strategy
 * registry rows are actually applied, because a model change, a schema change or
 * a new subsystem is a reviewed code change, not a runtime mutation.
 */
app.post("/api/meta/adaptations", wrap(async (req, res) => {
  const proposal = req.body || {};
  const action = String(proposal.action || "");
  const apply = (action === "enable_strategy" || action === "disable_strategy")
    ? async (evaluation) => {
      const id = String(proposal.params?.strategy_id || evaluation.target || "");
      if (!id) return { applied: false, reason: "no strategy_id" };
      if (id === CANONICAL_STRATEGY_ID && action === "disable_strategy") return { applied: false, reason: "refused by pin.single_send_path" };
      const row = await db.Strategy.setEnabled(id, action === "enable_strategy", { policyRef: `policy:${Date.now()}` });
      return row ? { applied: true, strategy: row } : { applied: false, reason: "no such strategy" };
    }
    : null;
  const result = await proposeAdaptation(db, proposal, { logger, apply });
  res.status(result.decision === "refused" ? 409 : 200).json(result);
}));

app.get("/api/meta/adaptive", wrap(async (req, res) => {
  const config = getSystemConfig();
  const mode = resolveAdaptiveMode(config.telemetry.requestedAdaptiveMode);
  const rows = await db.AdaptiveDecision.recent(Number(req.query.limit || 50));
  res.json({ mode: mode.mode, requestedMode: mode.requested, forced: mode.forced, law: mode.law, reason: mode.reason, switchedRuns: 0, thresholds: SWITCH_THRESHOLDS, decisions: rows });
}));

app.get("/api/meta/evaluations", wrap(async (req, res) => {
  const rows = await db.StrategyEvaluation.recent(Number(req.query.limit || 100));
  const byEvaluation = {};
  for (const r of rows) {
    byEvaluation[r.evaluation_id] = byEvaluation[r.evaluation_id] || [];
    byEvaluation[r.evaluation_id].push({ ...r, score: num(r.score), cost_usd: num(r.cost_usd) });
  }
  res.json({
    count: rows.length,
    note: "Offline and operator-invoked: node scripts/evaluate-strategies.mjs. There is no route that runs an evaluation on a user's turn.",
    evaluations: Object.entries(byEvaluation).map(([id, trials]) => ({ evaluation_id: id, trials }))
  });
}));

app.get("/api/meta/rates", wrap(async (req, res) => {
  res.json(describeRateTable());
}));

// --- Static frontend (self-hosted only) -------------------------------------
// On Vercel the built SPA is served by the CDN via vercel.json rewrites, so this
// is skipped there. Locally, `npm start` serves dist/ from the same process.
if (!process.env.VERCEL) {
  const { default: path } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(dir, "../dist");
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(distDir, "index.html")));
}

export default app;
