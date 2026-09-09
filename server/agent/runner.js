// Bounded agent mode. This is a tool-using subsystem, not a seventh council
// operator and not another answer path. It can inspect selected immutable
// sources and, in read-only mode, open explicit URLs from the user's objective.
// No write-capable tool is registered for autonomous execution.

import { createHash } from "node:crypto";
import { ingestLink } from "../sources/index.js";
import { isClientAbort, throwIfAborted } from "../shared/cancellation.js";

export const AGENT_MODES = Object.freeze(["off", "observe", "read_only"]);
export const TOOL_REGISTRY = Object.freeze({
  read_source: Object.freeze({ risk: "read", requiresApproval: false, sideEffect: false }),
  open_link: Object.freeze({ risk: "network_read", requiresApproval: false, sideEffect: "immutable_source_snapshot" })
});

export function normalizeAgentMode(value) {
  const mode = String(value || "off").trim().toLowerCase().replace(/-/g, "_");
  if (!AGENT_MODES.includes(mode)) {
    throw Object.assign(new Error(`agentMode must be one of: ${AGENT_MODES.join(", ")}`), { status: 400 });
  }
  return mode;
}

export function extractExplicitUrls(value, limit = 3) {
  const matches = String(value || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
  const unique = [];
  for (let raw of matches) {
    raw = raw.replace(/[),.;!?\]}]+$/g, "");
    try {
      const normalized = new URL(raw).href;
      if (!unique.includes(normalized)) unique.push(normalized);
    } catch { /* malformed links remain ordinary message text */ }
    if (unique.length >= limit) break;
  }
  return unique;
}

function key(runId, ordinal, tool, input) {
  return createHash("sha256").update(JSON.stringify([runId, ordinal, tool, input])).digest("hex");
}

async function transition(db, runId, stepId, eventType, fromStatus, toStatus, detail = {}) {
  return db.AgentEvent.append({
    agent_run_id: runId,
    step_id: stepId,
    event_type: eventType,
    from_status: fromStatus,
    to_status: toStatus,
    detail
  });
}

async function changeStep(db, { runId, stepId, fromStatus, toStatus, eventType, patch = {}, detail = {} }) {
  return db.withTransaction(async store => {
    const step = await store.AgentStep.update(stepId, { ...patch, status: toStatus });
    await transition(store, runId, stepId, eventType, fromStatus, toStatus, detail);
    return step;
  });
}

async function changeRun(db, { runId, fromStatus, toStatus, eventType, patch = {}, detail = {} }) {
  return db.withTransaction(async store => {
    const run = await store.AgentRun.update(runId, { ...patch, status: toStatus });
    await transition(store, runId, null, eventType, fromStatus, toStatus, detail);
    return run;
  });
}

function publicStep(step) {
  return {
    id: step.id,
    ordinal: step.ordinal,
    tool: step.tool_name,
    risk: step.risk_level,
    requiresApproval: step.requires_approval,
    status: step.status,
    input: step.input,
    output: step.output,
    error: step.error_message || null,
    startedMs: step.started_ms,
    endedMs: step.ended_ms
  };
}

export async function prepareAgentTurn({
  db,
  runId,
  workspaceId,
  conversationId,
  objective,
  mode: requestedMode,
  sourceIds = [],
  signal = null,
  logger = null
}) {
  const mode = normalizeAgentMode(requestedMode);
  const selectedSourceIds = [...new Set((sourceIds || []).map(String).filter(Boolean))].slice(0, 8);
  if (mode === "off") {
    return { mode, runId: null, plan: [], steps: [], sourceIds: selectedSourceIds, status: "off", autonomousWrites: false };
  }
  if (process.env.COGNOS_AGENT_ENABLED === "false") {
    throw Object.assign(new Error("Agent mode is disabled by COGNOS_AGENT_ENABLED"), { status: 503 });
  }
  if (process.env.COGNOS_SOURCES_ENABLED === "false") {
    throw Object.assign(new Error("Agent source tools are disabled by COGNOS_SOURCES_ENABLED"), { status: 503 });
  }

  const budget = Object.freeze({ maxSteps: 6, maxLinks: 3, maxSources: 8, writeActions: 0 });
  const urls = extractExplicitUrls(objective, budget.maxLinks);
  const plan = [
    ...selectedSourceIds.map(sourceId => ({ tool: "read_source", input: { sourceId } })),
    ...urls.map(url => ({ tool: "open_link", input: { url } }))
  ].slice(0, budget.maxSteps);
  const started = Date.now();
  const { agentRun, stepRows } = await db.withTransaction(async store => {
    const createdRun = await store.AgentRun.create({
      council_run_id: runId,
      workspace_id: workspaceId,
      conversation_id: conversationId,
      objective: String(objective || "").slice(0, 10_000),
      mode,
      status: mode === "observe" ? "planned" : "running",
      budget,
      plan,
      started_ms: started
    });
    await transition(store, createdRun.id, null, "run_created", null, createdRun.status, {
      mode, plannedSteps: plan.length, councilRunId: runId, autonomousWrites: false
    });

    const createdSteps = [];
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      const tool = TOOL_REGISTRY[item.tool];
      const step = await store.AgentStep.create({
        agent_run_id: createdRun.id,
        ordinal: i + 1,
        tool_name: item.tool,
        risk_level: tool.risk,
        requires_approval: tool.requiresApproval,
        status: "proposed",
        input: item.input,
        idempotency_key: key(createdRun.id, i + 1, item.tool, item.input)
      });
      createdSteps.push(step);
      await transition(store, createdRun.id, step.id, "step_proposed", null, "proposed", {
        tool: item.tool, risk: tool.risk, requiresApproval: tool.requiresApproval
      });
    }
    return { agentRun: createdRun, stepRows: createdSteps };
  });

  if (mode === "observe") {
    await changeRun(db, {
      runId: agentRun.id,
      fromStatus: "planned",
      toStatus: "planned",
      eventType: "run_planned",
      patch: {
        summary: { proposed: plan.length, executed: 0, note: "observe mode never executes tools" },
        ended_ms: Date.now()
      },
      detail: { executed: 0 }
    });
    return {
      mode, runId: agentRun.id, status: "planned", plan,
      steps: stepRows.map(publicStep), sourceIds: selectedSourceIds,
      autonomousWrites: false
    };
  }

  const outputSourceIds = [...selectedSourceIds];
  const completed = [];
  const failures = [];
  try {
    for (const original of stepRows) {
      throwIfAborted(signal);
      const startedMs = Date.now();
      await changeStep(db, {
        runId: agentRun.id,
        stepId: original.id,
        fromStatus: "proposed",
        toStatus: "running",
        eventType: "step_started",
        patch: { started_ms: startedMs },
        detail: { tool: original.tool_name }
      });
      try {
        let output;
        if (original.tool_name === "read_source") {
          const source = await db.Source.get(original.input.sourceId, workspaceId);
          if (!source) throw Object.assign(new Error("Selected source was not found in this workspace"), { status: 404 });
          output = { sourceId: source.id, name: source.name, kind: source.kind, contentSha256: source.content_sha256 };
        } else if (original.tool_name === "open_link") {
          const source = await ingestLink(db, {
            workspaceId,
            conversationId,
            url: original.input.url,
            signal
          });
          output = { sourceId: source.id, name: source.name, finalUrl: source.final_url, duplicate: source.duplicate };
          if (!outputSourceIds.includes(source.id)) outputSourceIds.push(source.id);
        } else {
          throw new Error(`Unregistered agent tool: ${original.tool_name}`);
        }
        const endedMs = Date.now();
        const updated = await changeStep(db, {
          runId: agentRun.id,
          stepId: original.id,
          fromStatus: "running",
          toStatus: "completed",
          eventType: "step_completed",
          patch: { output, ended_ms: endedMs },
          detail: output
        });
        completed.push(updated);
      } catch (error) {
        if (isClientAbort(error, signal)) {
          await changeStep(db, {
            runId: agentRun.id,
            stepId: original.id,
            fromStatus: "running",
            toStatus: "cancelled",
            eventType: "step_cancelled",
            patch: { error_message: "Cancelled by client", ended_ms: Date.now() },
            detail: { cancelled: true }
          }).catch(() => null);
          throw error;
        }
        const message = String(error?.message || error).slice(0, 400);
        const endedMs = Date.now();
        const updated = await changeStep(db, {
          runId: agentRun.id,
          stepId: original.id,
          fromStatus: "running",
          toStatus: "failed",
          eventType: "step_failed",
          patch: { error_message: message, ended_ms: endedMs },
          detail: { error: message }
        });
        failures.push(updated);
        logger?.warn?.("bounded agent read failed", { tool: original.tool_name, error: message });
      }
    }
    const status = failures.length ? (completed.length ? "partial" : "failed") : "completed";
    const summary = { proposed: plan.length, completed: completed.length, failed: failures.length, sourceIds: outputSourceIds };
    await changeRun(db, {
      runId: agentRun.id,
      fromStatus: "running",
      toStatus: status,
      eventType: "run_finished",
      patch: { summary, ended_ms: Date.now() },
      detail: summary
    });
    const steps = await db.AgentStep.list(agentRun.id);
    return { mode, runId: agentRun.id, status, plan, steps: steps.map(publicStep), sourceIds: outputSourceIds, autonomousWrites: false };
  } catch (error) {
    const cancelled = isClientAbort(error, signal);
    const status = cancelled ? "cancelled" : "failed";
    const message = String(error?.message || error).slice(0, 400);
    await changeRun(db, {
      runId: agentRun.id,
      fromStatus: "running",
      toStatus: status,
      eventType: cancelled ? "run_cancelled" : "run_failed",
      patch: { ended_ms: Date.now(), error_message: message },
      detail: { error: message }
    }).catch(() => null);
    throw error;
  }
}
