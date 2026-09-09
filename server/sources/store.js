// Persistence for immutable evidence snapshots and bounded agent execution.
// Source/source-chunk rows have no update/delete accessors. Agent run/step rows
// are materialized state; every change is also appended to agent_events.

import { newId } from "../db/util.js";

const json = (value, fallback) => JSON.stringify(value ?? fallback);

export function createSourceAgentStore(run) {
  const Source = {
    async create(data) {
      const id = data.id || newId("src");
      const rows = await run(
        `INSERT INTO sources
          (id, workspace_id, conversation_id, project_id, kind, name, canonical_url, final_url,
           media_type, byte_size, content_sha256, extracted_text, extraction,
           risk_flags, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [id, data.workspace_id, data.conversation_id || null, data.project_id || null,
         data.kind, data.name, data.canonical_url || null, data.final_url || null,
         data.media_type, data.byte_size, data.content_sha256, data.extracted_text,
         json(data.extraction, {}), json(data.risk_flags, []), data.fetched_at || null]
      );
      return rows[0];
    },
    async findByHash(workspaceId, sha256, kind = null, canonicalUrl = null) {
      const params = [workspaceId, sha256];
      let where = "workspace_id=$1 AND content_sha256=$2";
      if (kind) {
        params.push(kind);
        where += ` AND kind=$${params.length}`;
      }
      if (canonicalUrl) {
        params.push(canonicalUrl);
        where += ` AND canonical_url=$${params.length}`;
      }
      const rows = await run(
        `SELECT * FROM sources WHERE ${where} ORDER BY created_date ASC LIMIT 1`, params
      );
      return rows[0] || null;
    },
    async findByUrl(workspaceId, canonicalUrl) {
      const rows = await run(
        `SELECT * FROM sources WHERE workspace_id=$1 AND canonical_url=$2
         ORDER BY created_date DESC LIMIT 1`, [workspaceId, canonicalUrl]
      );
      return rows[0] || null;
    },
    async get(id, workspaceId = null) {
      const rows = workspaceId
        ? await run(`SELECT * FROM sources WHERE id=$1 AND workspace_id=$2`, [id, workspaceId])
        : await run(`SELECT * FROM sources WHERE id=$1`, [id]);
      return rows[0] || null;
    },
    async list(workspaceId, { conversationId = null, projectId = null, limit = 100 } = {}) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
      const where = ["workspace_id=$1"];
      const params = [workspaceId];
      if (conversationId) { where.push(`conversation_id=$${params.length + 1}`); params.push(conversationId); }
      if (projectId) { where.push(`project_id=$${params.length + 1}`); params.push(projectId); }
      params.push(safeLimit);
      return run(
        `SELECT id, workspace_id, conversation_id, project_id, kind, name, canonical_url, final_url,
                media_type, byte_size, content_sha256, extraction, risk_flags,
                fetched_at, created_date
         FROM sources WHERE ${where.join(" AND ")}
         ORDER BY created_date DESC LIMIT $${params.length}`, params
      );
    },
    // Phase 18 — the evidence pool of a conversation and, when the conversation
    // is project-scoped, every other conversation in the same project.
    async listEvidenceScope(workspaceId, conversationId, limit = 50) {
      const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
      const rows = conversationId
        ? await run(`SELECT project_id FROM conversations WHERE id=$1 AND workspace_id=$2`, [conversationId, workspaceId])
        : [];
      const projectId = rows[0]?.project_id || null;
      const where = ["workspace_id=$1"];
      const params = [workspaceId];
      if (projectId) {
        where.push(`project_id=$${params.length + 1}`);
        params.push(projectId);
      } else if (conversationId) {
        where.push(`(conversation_id=$${params.length + 1} OR conversation_id IS NULL)`);
        params.push(conversationId);
      } else {
        where.push("conversation_id IS NULL");
      }
      params.push(safeLimit);
      return run(
        `SELECT id, workspace_id, conversation_id, project_id, kind, name, canonical_url, final_url,
                media_type, byte_size, content_sha256, extraction, risk_flags,
                fetched_at, created_date
         FROM sources WHERE ${where.join(" AND ")}
         ORDER BY created_date DESC LIMIT $${params.length}`, params
      );
    },
    async listByIds(workspaceId, ids) {
      const unique = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 12);
      if (!unique.length) return [];
      return run(
        `SELECT * FROM sources WHERE workspace_id=$1 AND id = ANY($2::text[])
         ORDER BY created_date ASC`, [workspaceId, unique]
      );
    }
  };

  const SourceChunk = {
    async bulkCreate(sourceId, chunks) {
      const out = [];
      for (const chunk of chunks || []) {
        const rows = await run(
          `INSERT INTO source_chunks
            (id, source_id, ordinal, locator, content, content_sha256, char_start, char_end)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [newId("chunk"), sourceId, chunk.ordinal, json(chunk.locator, {}),
           chunk.content, chunk.content_sha256, chunk.char_start, chunk.char_end]
        );
        out.push(rows[0]);
      }
      return out;
    },
    async list(sourceId, limit = 1000) {
      return run(
        `SELECT * FROM source_chunks WHERE source_id=$1 ORDER BY ordinal ASC LIMIT $2`,
        [sourceId, Math.max(1, Math.min(2000, Number(limit) || 1000))]
      );
    },
    async listForSources(sourceIds, limit = 2000) {
      const unique = [...new Set((sourceIds || []).map(String).filter(Boolean))].slice(0, 12);
      if (!unique.length) return [];
      return run(
        `SELECT * FROM source_chunks WHERE source_id = ANY($1::text[])
         ORDER BY source_id, ordinal ASC LIMIT $2`,
        [unique, Math.max(1, Math.min(4000, Number(limit) || 2000))]
      );
    }
  };

  const AgentRun = {
    async create(data) {
      const id = data.id || newId("agent");
      const rows = await run(
        `INSERT INTO agent_runs
          (id, council_run_id, workspace_id, conversation_id, objective, mode,
           status, budget, plan, summary, started_ms, ended_ms, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [id, data.council_run_id || null, data.workspace_id, data.conversation_id || null,
         data.objective, data.mode, data.status || "planned", json(data.budget, {}),
         json(data.plan, []), data.summary == null ? null : json(data.summary, {}),
         data.started_ms || Date.now(), data.ended_ms || null, data.error_message || null]
      );
      return rows[0];
    },
    async get(id) {
      const rows = await run(`SELECT * FROM agent_runs WHERE id=$1`, [id]);
      return rows[0] || null;
    },
    async getByCouncilRun(runId) {
      const rows = await run(`SELECT * FROM agent_runs WHERE council_run_id=$1`, [runId]);
      return rows[0] || null;
    },
    async update(id, data) {
      const allowed = ["status", "summary", "ended_ms", "error_message"];
      const clauses = [];
      const values = [];
      for (const key of allowed) {
        if (data[key] === undefined) continue;
        clauses.push(`${key}=$${values.length + 1}`);
        values.push(key === "summary" && data[key] != null ? json(data[key], {}) : data[key]);
      }
      if (!clauses.length) return this.get(id);
      values.push(id);
      const rows = await run(
        `UPDATE agent_runs SET ${clauses.join(", ")}, updated_date=now()
         WHERE id=$${values.length} RETURNING *`, values
      );
      return rows[0] || null;
    },
    async recent(workspaceId, limit = 50) {
      return run(
        `SELECT * FROM agent_runs WHERE workspace_id=$1 ORDER BY created_date DESC LIMIT $2`,
        [workspaceId, Math.max(1, Math.min(100, Number(limit) || 50))]
      );
    }
  };

  const AgentStep = {
    async create(data) {
      const id = data.id || newId("step");
      const rows = await run(
        `INSERT INTO agent_steps
          (id, agent_run_id, ordinal, tool_name, risk_level, requires_approval,
           status, input, output, error_message, idempotency_key, started_ms, ended_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [id, data.agent_run_id, data.ordinal, data.tool_name, data.risk_level || "read",
         !!data.requires_approval, data.status || "proposed", json(data.input, {}),
         data.output == null ? null : json(data.output, {}), data.error_message || null,
         data.idempotency_key, data.started_ms || null, data.ended_ms || null]
      );
      return rows[0];
    },
    async get(id) {
      const rows = await run(`SELECT * FROM agent_steps WHERE id=$1`, [id]);
      return rows[0] || null;
    },
    async update(id, data) {
      const allowed = ["status", "output", "error_message", "started_ms", "ended_ms"];
      const clauses = [];
      const values = [];
      for (const key of allowed) {
        if (data[key] === undefined) continue;
        clauses.push(`${key}=$${values.length + 1}`);
        values.push(key === "output" && data[key] != null ? json(data[key], {}) : data[key]);
      }
      if (!clauses.length) return this.get(id);
      values.push(id);
      const rows = await run(
        `UPDATE agent_steps SET ${clauses.join(", ")}, updated_date=now()
         WHERE id=$${values.length} RETURNING *`, values
      );
      return rows[0] || null;
    },
    async list(agentRunId) {
      return run(`SELECT * FROM agent_steps WHERE agent_run_id=$1 ORDER BY ordinal ASC`, [agentRunId]);
    }
  };

  const AgentEvent = {
    async append(data) {
      const rows = await run(
        `INSERT INTO agent_events
          (id, agent_run_id, step_id, event_type, from_status, to_status, detail, ts_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [newId("agevt"), data.agent_run_id, data.step_id || null, data.event_type,
         data.from_status || null, data.to_status || null, json(data.detail, {}),
         data.ts_ms || Date.now()]
      );
      return rows[0];
    },
    async list(agentRunId) {
      return run(`SELECT * FROM agent_events WHERE agent_run_id=$1 ORDER BY seq ASC`, [agentRunId]);
    }
  };

  const AgentApproval = {
    async append(data) {
      const rows = await run(
        `INSERT INTO agent_approvals
          (id, agent_run_id, step_id, decision, scope_sha256, reason, decided_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [newId("approval"), data.agent_run_id, data.step_id, data.decision,
         data.scope_sha256, data.reason || null, data.decided_ms || Date.now()]
      );
      return rows[0];
    },
    async list(agentRunId) {
      return run(`SELECT * FROM agent_approvals WHERE agent_run_id=$1 ORDER BY decided_ms ASC`, [agentRunId]);
    }
  };

  const SourceImage = {
    async create(data) {
      const rows = await run(
        `INSERT INTO source_images (id, source_id, format, width, height, byte_size, content_sha256, bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, source_id, format, width, height, byte_size, content_sha256, created_date`,
        [newId("img"), data.source_id, data.format, data.width, data.height,
         data.byte_size, data.content_sha256, data.bytes]
      );
      return rows[0];
    },
    async getBySource(sourceId) {
      const rows = await run(
        `SELECT id, source_id, format, width, height, byte_size, content_sha256, created_date
         FROM source_images WHERE source_id=$1`, [sourceId]
      );
      return rows[0] || null;
    },
    async listForSources(sourceIds) {
      const unique = [...new Set((sourceIds || []).map(String).filter(Boolean))].slice(0, 12);
      if (!unique.length) return [];
      return run(
        `SELECT id, source_id, format, width, height, byte_size, content_sha256, created_date
         FROM source_images WHERE source_id = ANY($1::text[])`, [unique]
      );
    }
  };

  const ImageAnalysis = {
    async append(data) {
      const rows = await run(
        `INSERT INTO image_analyses
          (id, source_id, model_used, status, visual_type, summary, regions,
           latency_ms, attempts, usage, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [newId("imgan"), data.source_id, data.model_used, data.status,
         data.visual_type || null, data.summary || null, json(data.regions, []),
         data.latency_ms || null, data.attempts || 1,
         data.usage == null ? null : json(data.usage, {}), data.error_message || null]
      );
      return rows[0];
    },
    async recentBySource(sourceId, limit = 10) {
      return run(
        `SELECT id, source_id, model_used, status, visual_type, summary, regions,
                latency_ms, attempts, usage, error_message, created_date
         FROM image_analyses WHERE source_id=$1
         ORDER BY created_date DESC LIMIT $2`,
        [sourceId, Math.max(1, Math.min(50, Number(limit) || 10))]
      );
    },
    async anyBySource(sourceId) {
      const rows = await run(`SELECT 1 FROM image_analyses WHERE source_id=$1 LIMIT 1`, [sourceId]);
      return rows.length > 0;
    }
  };

  return { Source, SourceChunk, SourceImage, ImageAnalysis, AgentRun, AgentStep, AgentEvent, AgentApproval };
}
