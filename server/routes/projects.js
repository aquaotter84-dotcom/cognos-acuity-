// Durable research projects (Phase 18).
//
// A project is a folder, not an account boundary: it groups conversations,
// immutable evidence sources, agent runs, and research decisions around one
// investigation. Deleting a project DETACHES its conversations and sources —
// no knowledge row is ever deleted by this module.

function publicProject(project) {
  return project;
}

export function registerProjectRoutes(app, { wrap, db, logger }) {
  app.get("/api/projects", wrap(async (req, res) => {
    const workspace = await db.Workspace.ensureDefault();
    res.json(await db.Project.list(workspace.id, req.query.limit));
  }));

  app.post("/api/projects", wrap(async (req, res) => {
    const workspace = await db.Workspace.ensureDefault();
    const name = String(req.body?.name || "").trim().slice(0, 120);
    if (!name) return res.status(400).json({ error: "Project name is required" });
    const objective = String(req.body?.objective || "").trim().slice(0, 4000) || null;
    const project = await db.Project.create({ workspace_id: workspace.id, name, objective });
    res.status(201).json(project);
  }));

  app.get("/api/projects/:id", wrap(async (req, res) => {
    const workspace = await db.Workspace.ensureDefault();
    const project = await db.Project.get(req.params.id);
    if (!project || project.workspace_id !== workspace.id) {
      return res.status(404).json({ error: "Project not found in this workspace" });
    }
    const [conversations, sources, agentRuns] = await Promise.all([
      db.query(
        `SELECT * FROM conversations WHERE workspace_id=$1 AND project_id=$2 AND is_archived=FALSE
         ORDER BY updated_date DESC LIMIT 200`, [workspace.id, project.id]
      ),
      db.Source.list(workspace.id, { projectId: project.id, limit: 200 }),
      db.query(
        `SELECT r.* FROM agent_runs r
         JOIN conversations c ON c.id = r.conversation_id
         WHERE c.project_id=$1
         ORDER BY r.created_date DESC LIMIT 100`, [project.id]
      )
    ]);
    res.json({ project, conversations, sources, agentRuns });
  }));

  app.patch("/api/projects/:id", wrap(async (req, res) => {
    const workspace = await db.Workspace.ensureDefault();
    const project = await db.Project.get(req.params.id);
    if (!project || project.workspace_id !== workspace.id) {
      return res.status(404).json({ error: "Project not found in this workspace" });
    }
    const data = {};
    if (req.body?.name !== undefined) data.name = String(req.body.name).trim().slice(0, 120) || project.name;
    if (req.body?.objective !== undefined) data.objective = String(req.body.objective).slice(0, 4000);
    res.json(await db.Project.update(project.id, data));
  }));

  app.delete("/api/projects/:id", wrap(async (req, res) => {
    const workspace = await db.Workspace.ensureDefault();
    const project = await db.Project.get(req.params.id);
    if (!project || project.workspace_id !== workspace.id) {
      return res.status(404).json({ error: "Project not found in this workspace" });
    }
    res.json(await db.Project.delete(project.id));
  }));
}
