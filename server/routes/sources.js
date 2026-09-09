// Immutable source ingestion, image originals, project scoping, and read-only
// agent observability routes. None of these routes returns a conversational
// answer; /api/chat remains the only user-message -> governed-answer path.
//
// Phase 18: sources can be project-scoped (uploading inside a project
// conversation tags the snapshot with that project), image originals are
// served back by their immutable id for display, and a source detail response
// carries its vision-analysis provenance.

import { ingestDocument, ingestLink, ingestImage } from "../sources/index.js";
import { AGENT_MODES, TOOL_REGISTRY, decideResearchRun } from "../agent/runner.js";
import { autonomyConfig } from "../autonomy/config.js";
import { TIERS, describeSkills } from "../skills/index.js";

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

// The project tag is authoritative server-side: a supplied projectId must be a
// real project of this workspace, and a conversation's own project wins.
async function resolveProject(db, workspace, conversation, requestedProjectId) {
  let projectId = conversation?.project_id || requestedProjectId || null;
  if (!projectId) return null;
  if (conversation?.project_id && requestedProjectId && requestedProjectId !== conversation.project_id) {
    throw Object.assign(new Error("The requested project does not match the conversation's project"), { status: 409 });
  }
  const project = await db.Project.get(projectId);
  if (!project || project.workspace_id !== workspace.id) {
    throw Object.assign(new Error("Project not found in this workspace"), { status: 404 });
  }
  return projectId;
}

const IMAGE_CONTENT_TYPES = Object.freeze({
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp"
});

export function registerSourceRoutes(app, { wrap, db, logger }) {
  app.get("/api/sources", wrap(async (req, res) => {
    assertSourcesEnabled();
    const workspace = await db.Workspace.ensureDefault();
    const projectId = req.query.projectId || null;
    if (projectId) {
      const project = await db.Project.get(projectId);
      if (!project || project.workspace_id !== workspace.id) {
        return res.status(404).json({ error: "Project not found in this workspace" });
      }
    }
    res.json(await db.Source.list(workspace.id, {
      conversationId: req.query.conversationId || null,
      projectId,
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
    const projectId = await resolveProject(db, workspace, conversation, req.body?.projectId);
    const source = await ingestDocument(db, {
      workspaceId: workspace.id,
      conversationId: conversation?.id || null,
      projectId,
      name: req.body.name,
      mediaType: req.body.mediaType,
      base64: req.body.base64
    });
    res.status(source.duplicate ? 200 : 201).json(source);
  }));

  // --- Phase 18: image originals (PNG / JPEG / WebP) ------------------------
  app.post("/api/sources/images", wrap(async (req, res) => {
    assertSourcesEnabled();
    const { workspace, conversation } = await workspaceAndConversation(db, req.body?.conversationId);
    if (typeof req.body?.name !== "string" || !req.body.name.trim()) {
      return res.status(400).json({ error: "Image name is required" });
    }
    if (typeof req.body?.base64 !== "string" || !req.body.base64) {
      return res.status(400).json({ error: "Image base64 is required" });
    }
    const projectId = await resolveProject(db, workspace, conversation, req.body?.projectId);
    const requestAbort = requestAbortSignal(req, res);
    try {
      const source = await ingestImage(db, {
        workspaceId: workspace.id,
        conversationId: conversation?.id || null,
        projectId,
        name: req.body.name,
        mediaType: req.body.mediaType,
        base64: req.body.base64,
        signal: requestAbort.signal,
        logger
      });
      res.status(source.duplicate ? 200 : 201).json(source);
    } finally {
      requestAbort.cleanup();
    }
  }));

  app.get("/api/sources/:id/image", wrap(async (req, res) => {
    assertSourcesEnabled();
    const workspace = await db.Workspace.ensureDefault();
    const source = await db.Source.get(req.params.id, workspace.id);
    if (!source) return res.status(404).json({ error: "Source not found" });
    if (source.kind !== "image") return res.status(404).json({ error: "This source is not an image" });
    const image = await db.SourceImage.getBySource(source.id);
    if (!image) return res.status(404).json({ error: "Image original not found" });
    res.set("Content-Type", IMAGE_CONTENT_TYPES[image.format] || "application/octet-stream");
    res.set("ETag", `"${image.content_sha256}"`);
    // The URL is keyed by an immutable source id whose bytes never change, so
    // the response is safe to cache long-term while staying same-origin.
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    const rows = await db.query("SELECT bytes FROM source_images WHERE source_id=$1", [source.id]);
    res.send(Buffer.isBuffer(rows[0]?.bytes) ? rows[0].bytes : Buffer.from(rows[0]?.bytes || ""));
  }));

  app.post("/api/sources/links", wrap(async (req, res) => {
    assertSourcesEnabled();
    const { workspace, conversation } = await workspaceAndConversation(db, req.body?.conversationId);
    if (typeof req.body?.url !== "string" || !req.body.url.trim()) {
      return res.status(400).json({ error: "URL is required" });
    }
    const projectId = await resolveProject(db, workspace, conversation, req.body?.projectId);
    const requestAbort = requestAbortSignal(req, res);
    try {
      const source = await ingestLink(db, {
        workspaceId: workspace.id,
        conversationId: conversation?.id || null,
        projectId,
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
    const [chunks, image, analyses] = await Promise.all([
      db.SourceChunk.list(source.id),
      db.SourceImage.getBySource(source.id),
      db.ImageAnalysis.recentBySource(source.id)
    ]);
    res.json({ source, chunks, image: image || null, analyses });
  }));

  app.get("/api/agent/tools", wrap(async (req, res) => {
    const researchEnabled = process.env.COGNOS_RESEARCH_ENABLED !== "false";
    const cfg = autonomyConfig();
    res.json({
      enabled: process.env.COGNOS_AGENT_ENABLED !== "false",
      modes: AGENT_MODES,
      tools: TOOL_REGISTRY,
      researchEnabled,
      autonomousWrites: false,
      // Phase 19: the autonomy skill registry. The shape is unchanged — this is
      // an addition, so an existing reader keeps working. Skills are CODE, not
      // data: this list is compiled from server/skills/, and no row in any
      // table can add an entry to it. Only the per-resident allowlist is data.
      autonomy: {
        enabled: cfg.enabled,
        defaultOff: cfg.defaultOff,
        outboxMode: cfg.outboxMode,
        builtTiers: cfg.builtTiers,
        tiers: TIERS,
        skills: describeSkills(cfg),
        // The tiers this build will not execute, named rather than omitted, so
        // the boundary is visible from the outside.
        unbuiltTiers: ["T3", "T4", "T5"]
      },
      note: "Agent mode is a bounded read-only subsystem. Research mode proposes a plan and executes only after the user approves each step. It cannot release an answer or write memory. Autonomy skills are separate: they are code-owned, tier-gated, and every effect they produce is staged and judged before anything happens."
    });
  }));

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

  // Phase 18 — the user decides an awaiting_approval research plan. This is
  // the recorded approval barrier; nothing about a research plan executes
  // until this route records consent (per-step scope hashes) for it.
  app.post("/api/agent/runs/:id/decision", wrap(async (req, res) => {
    const workspace = await db.Workspace.ensureDefault();
    const requestAbort = requestAbortSignal(req, res);
    try {
      const outcome = await decideResearchRun({
        db,
        runId: req.params.id,
        workspaceId: workspace.id,
        decision: req.body?.decision,
        reason: req.body?.reason,
        signal: requestAbort.signal,
        logger
      });
      res.json(outcome);
    } finally {
      requestAbort.cleanup();
    }
  }));
}
