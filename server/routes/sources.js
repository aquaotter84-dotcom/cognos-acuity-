// Immutable source ingestion and read-only agent observability routes.
// None of these routes returns a conversational answer; /api/chat remains the
// only user-message -> governed-answer path.

import { ingestDocument, ingestLink } from "../sources/index.js";
import { AGENT_MODES, TOOL_REGISTRY } from "../agent/runner.js";

function assertSourcesEnabled() {
  if (process.env.COGNOS_SOURCES_ENABLED === "false") {
    throw Object.assign(new Error("Source ingestion is disabled by COGNOS_SOURCES_ENABLED"), { status: 503 });
  }
}

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const cancel = () => {
    if (!res.writableEnded && !controller.signal.aborted) controller.abort(new Error("Source request disconnected"));
  };
  req.once("aborted", cancel);
  res.once("close", cancel);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off("aborted", cancel);
      res.off("close", cancel);
    }
  };
}

async function workspaceAndConversation(db, conversationId) {
  const workspace = await db.Workspace.ensureDefault();
  if (!conversationId) return { workspace, conversation: null };
  const conversation = await db.Conversation.get(conversationId);
  if (!conversation || conversation.workspace_id !== workspace.id) {
    throw Object.assign(new Error("Conversation not found in this workspace"), { status: 404 });
  }
  return { workspace, conversation };
}

export function registerSourceRoutes(app, { wrap, db }) {
  app.get("/api/sources", wrap(async (req, res) => {
    assertSourcesEnabled();
    const workspace = await db.Workspace.ensureDefault();
    res.json(await db.Source.list(workspace.id, {
      conversationId: req.query.conversationId || null,
      limit: req.query.limit
    }));
  }));

  app.post("/api/sources/documents", wrap(async (req, res) => {
    assertSourcesEnabled();
    const { workspace, conversation } = await workspaceAndConversation(db, req.body?.conversationId);
    if (typeof req.body?.name !== "string" || !req.body.name.trim()) {
      return res.status(400).json({ error: "Document name is required" });
    }
    if (typeof req.body?.base64 !== "string" || !req.body.base64) {
      return res.status(400).json({ error: "Document base64 is required" });
    }
    const source = await ingestDocument(db, {
      workspaceId: workspace.id,
      conversationId: conversation?.id || null,
      name: req.body.name,
      mediaType: req.body.mediaType,
      base64: req.body.base64
    });
    res.status(source.duplicate ? 200 : 201).json(source);
  }));

  app.post("/api/sources/links", wrap(async (req, res) => {
    assertSourcesEnabled();
    const { workspace, conversation } = await workspaceAndConversation(db, req.body?.conversationId);
    if (typeof req.body?.url !== "string" || !req.body.url.trim()) {
      return res.status(400).json({ error: "URL is required" });
    }
    const requestAbort = requestAbortSignal(req, res);
    try {
      const source = await ingestLink(db, {
        workspaceId: workspace.id,
        conversationId: conversation?.id || null,
        url: req.body.url,
        signal: requestAbort.signal
      });
      res.status(source.duplicate ? 200 : 201).json(source);
    } finally {
      requestAbort.cleanup();
    }
  }));

  app.get("/api/sources/:id", wrap(async (req, res) => {
    assertSourcesEnabled();
    const workspace = await db.Workspace.ensureDefault();
    const source = await db.Source.get(req.params.id, workspace.id);
    if (!source) return res.status(404).json({ error: "Source not found" });
    const chunks = await db.SourceChunk.list(source.id);
    res.json({ source, chunks });
  }));

  app.get("/api/agent/tools", (req, res) => {
    res.json({
      enabled: process.env.COGNOS_AGENT_ENABLED !== "false",
      modes: AGENT_MODES,
      tools: TOOL_REGISTRY,
      autonomousWrites: false,
      note: "Agent mode is a bounded read-only subsystem. It cannot release an answer or write memory."
    });
  });

  app.get("/api/agent/runs", wrap(async (req, res) => {
    const workspace = await db.Workspace.ensureDefault();
    res.json(await db.AgentRun.recent(workspace.id, req.query.limit));
  }));

  app.get("/api/agent/runs/:id", wrap(async (req, res) => {
    const workspace = await db.Workspace.ensureDefault();
    const run = await db.AgentRun.get(req.params.id);
    if (!run || run.workspace_id !== workspace.id) return res.status(404).json({ error: "Agent run not found" });
    const [steps, events, approvals] = await Promise.all([
      db.AgentStep.list(run.id),
      db.AgentEvent.list(run.id),
      db.AgentApproval.list(run.id)
    ]);
    res.json({ run, steps, events, approvals });
  }));
}
