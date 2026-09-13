// COGNOS API — the app's own routes. No Base44, no platform functions, no meter.
//
// This module exports the Express app WITHOUT calling listen(). That split is
// deliberate: Vercel imports the app as a serverless handler (api/index.js) and
// never runs a listener, while local/self-hosted runs use server/serve.js.
// Calling listen() here would work locally and silently do nothing on Vercel.
//
// Routes:
//   GET  /api/health                       liveness + config visibility (no secrets)
//   GET  /api/identity                     canonical identity, architecture, capabilities, limits
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
// Phase 17 (Governed Sources + bounded agent provenance):
//   GET/POST /api/sources/*              immutable document/link evidence
//   GET      /api/agent/tools             bounded capability declaration
//   GET      /api/agent/runs*             attributable run/step/event records
// Agent execution itself remains inside POST /api/chat; there is no second
// answer route and no autonomous write endpoint.
//
// Phase 23 (Trust-Annotated Knowledge Graph — the Atlas):
//   GET  /api/graph/overview             node/edge/snapshot/conflict counts
//   GET/POST /api/graph/nodes            list / create (user-curated)
//   GET  /api/graph/nodes/:id            node + edges + lineage + seal
//   POST /api/graph/nodes/:id/pin        pin (mints verified trust)
//   POST /api/graph/nodes/:id/retire     retire (a transition, never a delete)
//   POST /api/graph/nodes/:id/fork       fork into a successor line
//   POST /api/graph/nodes/:id/revise     revise via successor + revision edge
//   POST /api/graph/nodes/:id/trust      move the trust annotation
//   GET/POST /api/graph/edges            list / create
//   POST /api/graph/edges/:id/retire     retire an edge
//   GET  /api/graph/related/:nodeId      bounded traversal (?depth, ?truthOnly)
//   GET  /api/graph/query                relevance query (?q, ?truthOnly)
//   GET  /api/graph/conflicts            contradicts edges for manual resolution
//   GET/POST /api/graph/snapshots        immutable Merkle snapshots
//   GET  /api/graph/snapshots/diff       Merkle diff (?a, ?b)
//   GET  /api/graph/verify               provenance hash-mismatch audit
//   GET  /api/graph/coverage             session-content coverage audit
//
// Access gate: only active when COGNOS_RUNTIME_SECRET is set. No gate otherwise.

import express from "express";
import cookieParser from "cookie-parser";
import db from "./db.js";
import { isConfigured } from "./db.js";
import { getSystemConfig } from "./config.js";
import { describeIdentity, IDENTITY_VERSION } from "./identity.js";
import { createLogger } from "./shared/logging.js";
import { LAWS, LAW_LAYER_VERSION } from "./council/laws.js";
import { CANONICAL_STRATEGY_ID } from "./meta/strategies.js";
import { resolveAdaptiveMode } from "./meta/adaptive.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerAutonomyRoutes } from "./routes/autonomy.js";
import { autonomyConfig } from "./autonomy/config.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerGraphRoutes } from "./routes/graph.js";

const logger = createLogger("server");
export const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.disable("x-powered-by");
// COGNOS query parameters are flat scalars. The simple parser avoids nested
// object construction entirely and keeps query parsing outside `qs`.
app.set("query parser", "simple");

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
    modelRequestPolicy: config.models.requestPolicy,
    contextWindow: config.orchestrator.contextWindow,
    memoryHierarchy: ["working", "episodic", "semantic"],
    databaseConfigured: isConfigured(),
    searchProvider: config.search.enabled ? config.search.provider : "disabled",
    modelKeyConfigured: Boolean(process.env.BLUESMINDS_API_KEY || process.env.OPENAI_API_KEY),
    llmServiceTier: process.env.COGNOS_LLM_SERVICE_TIER || "provider-default",
    promptCacheKeyConfigured: Boolean(process.env.COGNOS_PROMPT_CACHE_KEY),
    sources: config.sources.enabled,
    // Phase 18 — image originals, vision readings, research mode, projects.
    images: {
      enabled: config.sources.enabled,
      visionEnabled: config.sources.enabled && config.sources.vision.enabled !== false,
      formats: config.sources.imageFormats,
      maxImageBytes: config.sources.maxImageBytes
    },
    research: {
      enabled: config.research.enabled !== false,
      maxPlanSteps: config.research.maxPlanSteps,
      approvalGate: true,
      executionTools: ["open_link"]
    },
    projects: true,
    agent: {
      enabled: config.agent.enabled,
      modes: config.agent.modes,
      autonomousWrites: config.agent.autonomousWrites
    },
    // Phase 19 — durable autonomy. Off unless an operator enables a rung.
    autonomy: {
      enabled: autonomyConfig().enabled,
      defaultOff: true,
      outboxMode: autonomyConfig().outboxMode,
      builtTiers: autonomyConfig().builtTiers,
      rung: autonomyConfig().rung
    },
    gate: Boolean(process.env.COGNOS_RUNTIME_SECRET),
    // Phase 23 — the trust-annotated atlas. Consulted before the answer seats
    // run, projected after the Governor rules; curation is user-controlled.
    graph: {
      enabled: config.knowledge.graph.enabled !== false,
      consultEnabled: config.knowledge.graph.consultEnabled !== false,
      projectEnabled: config.knowledge.graph.projectEnabled !== false,
      maxNodesPerTurn: config.knowledge.graph.maxNodesPerTurn,
      nodeTypes: ["concept", "person", "source", "event", "intent"],
      edgeKinds: ["is-about", "in-source", "refines", "contradicts", "supports", "revision", "fork"],
      trustLevels: ["verified", "trusted", "untrusted", "flagged"]
    },
    // Phase 14/15 subsystem state. Additive keys; nothing above changed.
    ledger: config.knowledge.ledgerEnabled,
    coherence: config.knowledge.coherenceEnabled,
    telemetry: config.telemetry.enabled,
    adaptiveMode: adaptive.mode,
    adaptiveModeForced: adaptive.forced,
    strategy: CANONICAL_STRATEGY_ID,
    laws: LAWS.length,
    lawLayerVersion: LAW_LAYER_VERSION,
    identityVersion: IDENTITY_VERSION
  });
});

// Canonical self-description. This is structured transparency data, not a
// conversational response and not a second answer path.
app.get("/api/identity", (req, res) => {
  res.json(describeIdentity(getSystemConfig(), { databaseConfigured: isConfigured() }));
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
  let projectId = req.body?.projectId || null;
  if (projectId) {
    const project = await db.Project.get(projectId);
    if (!project || project.workspace_id !== ws.id) {
      return res.status(404).json({ error: "Project not found in this workspace" });
    }
  }
  res.json(await db.Conversation.create({ workspace_id: ws.id, title, project_id: projectId }));
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

// The one send path is registered as a focused route module.
registerChatRoute(app, { wrap, db, logger });
registerProjectRoutes(app, { wrap, db, logger });

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
    memory_layer: req.body?.memory_layer,
    memory_key: req.body?.memory_key || req.body?.key,
    memory_value: req.body?.memory_value ?? req.body?.value,
    expires_at: req.body?.expires_at || null,
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

// Phase 14/15 routes live in focused modules so the HTTP composition root stays
// auditable without mixing domain query implementations into the chat route.
registerKnowledgeRoutes(app, { wrap, db, logger });
registerMetaRoutes(app, { wrap, db, logger, getSystemConfig });
registerSourceRoutes(app, { wrap, db, logger });
registerAutonomyRoutes(app, { wrap, db, logger });
registerGraphRoutes(app, { wrap, db, logger });

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
