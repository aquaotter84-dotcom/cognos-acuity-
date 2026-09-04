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
// Access gate: only active when COGNOS_RUNTIME_SECRET is set. No gate otherwise.

import express from "express";
import cookieParser from "cookie-parser";
import db from "./db.js";
import { isConfigured } from "./db.js";
import { getSystemConfig } from "./config.js";
import { runCouncilTurn } from "./chatOrchestrate.js";
import { createLogger } from "./shared/logging.js";

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
  res.json({
    ok: true,
    model: config.models.primary,
    fastModel: config.models.memory,
    databaseConfigured: isConfigured(),
    searchProvider: config.search.enabled ? config.search.provider : "disabled",
    modelKeyConfigured: Boolean(process.env.BLUESMINDS_API_KEY || process.env.OPENAI_API_KEY),
    gate: Boolean(process.env.COGNOS_RUNTIME_SECRET)
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

  send("start", { conversationId, conversation: createdConversation, userMessage: userMsg });

  try {
    const result = await runCouncilTurn(
      { conversationId, workspaceId: workspace.id, userMessage, style, attachments, webSearch },
      {
        emit: (event, payload) => send(event, payload),
        onToken: (delta) => send("token", { delta })
      }
    );

    const assistantMsg = await db.Message.create({
      conversation_id: conversationId,
      workspace_id: workspace.id,
      role: "assistant",
      content: result.response,
      model_used: result.modelUsed,
      task_type: result.taskType,
      council: { ...result.council, modelUsed: result.modelUsed, taskType: result.taskType, latencyMs: result.latencyMs },
      processing_status: "complete"
    });

    await db.Conversation.update(conversationId, {
      last_message_preview: String(result.response || "").slice(0, 100)
    });

    // Final payload — the exact shape the client consumes.
    send("done", {
      conversationId,
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
    const errorMsg = await db.Message.create({
      conversation_id: conversationId,
      workspace_id: workspace.id,
      role: "assistant",
      content: `⚠️ **The council could not answer.**\n\n${error.message || "Unknown error"}`,
      processing_status: "error"
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
