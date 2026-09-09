// Bounded agent mode. This is a tool-using subsystem, not a seventh council
// operator and not another answer path. It can inspect selected immutable
// sources and, in read-only mode, open explicit URLs from the user's objective.
// No write-capable tool is registered for autonomous execution.

import { createHash } from "node:crypto";
import { ingestLink } from "../sources/index.js";
import { isClientAbort, throwIfAborted } from "../shared/cancellation.js";
import { proposeResearchPlan } from "./planner.js";

// Phase 18: research joins the mode vocabulary. Unlike observe/read_only it is
// two-phase — PROPOSE (an awaiting_approval run with per-step scope hashes) and
// EXECUTE (only after the user approves the recorded plan) — so a research run
// is the reviewed approval barrier pin.agent_bounded requires before any step
// opens a network resource the model itself suggested.
export const AGENT_MODES = Object.freeze(["off", "observe", "read_only", "research"]);
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
  logger = null,
  config = null,
  telemetry = null
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
  if (mode === "research" && process.env.COGNOS_RESEARCH_ENABLED === "false") {
    throw Object.assign(new Error("Research mode is disabled by COGNOS_RESEARCH_ENABLED"), { status: 503 });
  }

  // --- Phase 18: research mode — propose first, execute only on approval ----
  if (mode === "research") {
    const evidenceScope = await db.Source.listEvidenceScope(workspaceId, conversationId, 12);
    const byId = new Map([...evidenceScope, ...selectedSourceIds.length
      ? await db.Source.listByIds(workspaceId, selectedSourceIds) : []]
      .map(source => [source.id, source]));
    const evidenceSources = [...byId.values()];
    const proposal = await proposeResearchPlan({
      db,
      config,
      runId,
      workspaceId,
      conversationId,
      objective: String(objective || ""),
      sources: evidenceSources,
      signal,
      logger,
      telemetry
    });
    const started = Date.now();
    const created = await db.withTransaction(async store => {
      const runRow = await store.AgentRun.create({
        council_run_id: runId,
        workspace_id: workspaceId,
        conversation_id: conversationId,
        objective: String(objective || "").slice(0, 10_000),
        mode: "research",
        status: proposal.steps.length ? "awaiting_approval" : "completed",
        budget: Object.freeze({ maxSteps: proposal.steps.length, maxLinks: proposal.steps.length, maxSources: 12, writeActions: 0, execution: "on_user_approval" }),
        plan: proposal.steps,
        summary: { note: proposal.note, origin: proposal.origin, modelUsed: proposal.modelUsed },
        started_ms: started,
        ended_ms: proposal.steps.length ? null : Date.now()
      });
      await transition(store, runRow.id, null, "run_created", null, runRow.status, {
        mode: "research", proposedSteps: proposal.steps.length, councilRunId: runId,
        autonomousWrites: false, executionGate: "awaiting_user_approval"
      });
      const rows = [];
      for (let i = 0; i < proposal.steps.length; i++) {
        const step = proposal.steps[i];
        const stepRow = await store.AgentStep.create({
          agent_run_id: runRow.id,
          ordinal: i + 1,
          tool_name: step.tool,
          risk_level: TOOL_REGISTRY[step.tool]?.risk || "read",
          requires_approval: true,
          status: "awaiting_approval",
          input: { ...step.input, reason: step.reason || null },
          idempotency_key: key(runRow.id, i + 1, step.tool, step.input)
        });
        rows.push(stepRow);
        await transition(store, runRow.id, stepRow.id, "step_proposed", null, "awaiting_approval", {
          tool: step.tool, risk: TOOL_REGISTRY[step.tool]?.risk, requiresApproval: true, reason: step.reason || null
        });
      }
      return { runRow, rows };
    });
    if (!proposal.steps.length) {
      await changeRun(db, {
        runId: created.runRow.id,
        fromStatus: "completed",
        toStatus: "completed",
        eventType: "run_finished",
        patch: { summary: { ...created.runRow.summary, proposed: 0, executed: 0 } },
        detail: { executed: 0, note: "nothing to approve" }
      });
    }
    return {
      mode,
      runId: created.runRow.id,
      status: created.runRow.status,
      plan: proposal.steps,
      steps: created.rows.map(publicStep),
      sourceIds: selectedSourceIds,
      autonomousWrites: false,
      research: { note: proposal.note, origin: proposal.origin }
    };
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

// ---------------------------------------------------------------------------
// Phase 18 — the approval decision point. A research run stores a plan whose
// steps are all requires_approval; the user decides on the WHOLE recorded plan
// (approval rows are still written per step, each with a scope hash). Approve
// executes the recorded steps with the exact read-only, budgeted execution the
// read_only mode uses; decline executes nothing and freezes the plan.
// ---------------------------------------------------------------------------

const scopeHash = (runId, step) => createHash("sha256")
  .update(JSON.stringify([runId, step.id, step.tool_name, step.input]))
  .digest("hex");

function guardDecisionRequest(run, steps) {
  if (!run) throw Object.assign(new Error("Agent run not found"), { status: 404 });
  if (run.mode !== "research") {
    throw Object.assign(new Error("Only research-mode runs await approval"), { status: 409 });
  }
  if (run.status !== "awaiting_approval") {
    throw Object.assign(new Error(`This research run is already ${run.status} and cannot be decided again`), { status: 409 });
  }
  if (!steps.length || steps.some(step => step.status !== "awaiting_approval" || !step.requires_approval)) {
    throw Object.assign(new Error("The research run has no approvable steps"), { status: 409 });
  }
}

/**
 * Decide an awaiting_approval research run.
 * @param {{decision: "approve"|"decline", reason?: string}} opts
 * @returns {Promise<{run, steps, approvals}>}
 */
export async function decideResearchRun({ db, runId, workspaceId, decision, reason = null, signal = null, logger = null }) {
  const wanted = String(decision || "").trim().toLowerCase();
  if (!["approve", "decline"].includes(wanted)) {
    throw Object.assign(new Error("decision must be approve or decline"), { status: 400 });
  }
  const run = await db.AgentRun.get(runId);
  if (!run || run.workspace_id !== workspaceId) {
    throw Object.assign(new Error("Agent run not found in this workspace"), { status: 404 });
  }
  const stepRows = await db.AgentStep.list(run.id);
  guardDecisionRequest(run, stepRows);
  const cleanReason = String(reason || "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 300) || null;
  const decidedMs = Date.now();

  if (wanted === "decline") {
    await db.withTransaction(async store => {
      for (const step of stepRows) {
        await store.AgentApproval.append({
          agent_run_id: run.id,
          step_id: step.id,
          decision: "decline",
          scope_sha256: scopeHash(run.id, step),
          reason: cleanReason,
          decided_ms: decidedMs
        });
        await transition(store, run.id, step.id, "step_declined", "awaiting_approval", "declined", { reason: cleanReason });
      }
      await transition(store, run.id, null, "run_declined", "awaiting_approval", "declined", { reason: cleanReason });
      await store.AgentRun.update(run.id, { status: "declined", summary: { note: run.summary?.note ?? null, declined: true, declined_ms: decidedMs }, ended_ms: decidedMs });
    });
    const approvals = await db.AgentApproval.list(run.id);
    const steps = await db.AgentStep.list(run.id);
    return { run: await db.AgentRun.get(run.id), steps, approvals };
  }

  // approve — record consent for every step BEFORE any network read begins.
  await db.withTransaction(async store => {
    for (const step of stepRows) {
      await store.AgentApproval.append({
        agent_run_id: run.id,
        step_id: step.id,
        decision: "approve",
        scope_sha256: scopeHash(run.id, step),
        reason: cleanReason,
        decided_ms: decidedMs
      });
      await transition(store, run.id, step.id, "step_approved", "awaiting_approval", "approved", { reason: cleanReason });
      await store.AgentStep.update(step.id, { status: "approved" });
    }
    await transition(store, run.id, null, "run_approved", "awaiting_approval", "running", {
      approvedSteps: stepRows.length, decided_ms: decidedMs
    });
    await store.AgentRun.update(run.id, { status: "running" });
  });

  const createdSources = [];
  const completed = [];
  const failures = [];
  for (const original of stepRows) {
    throwIfAborted(signal);
    if (original.tool_name !== "open_link") {
      const message = `Research plans may only open approved public links; unregistered tool: ${original.tool_name}`;
      const ended = Date.now();
      await changeStep(db, {
        runId: run.id, stepId: original.id, fromStatus: "approved", toStatus: "failed",
        eventType: "step_failed", patch: { error_message: message, ended_ms: ended }, detail: { error: message }
      });
      failures.push(original);
      continue;
    }
    const startedMs = Date.now();
    await changeStep(db, {
      runId: run.id, stepId: original.id, fromStatus: "approved", toStatus: "running",
      eventType: "step_started", patch: { started_ms: startedMs }, detail: { tool: original.tool_name }
    });
    try {
      const source = await ingestLink(db, {
        workspaceId,
        conversationId: run.conversation_id,
        url: original.input.url,
        signal
      });
      const output = { sourceId: source.id, name: source.name, finalUrl: source.final_url, duplicate: source.duplicate };
      if (!source.duplicate) createdSources.push(source.id);
      const endedMs = Date.now();
      const updated = await changeStep(db, {
        runId: run.id, stepId: original.id, fromStatus: "running", toStatus: "completed",
        eventType: "step_completed", patch: { output, ended_ms: endedMs }, detail: output
      });
      completed.push(updated);
    } catch (error) {
      if (isClientAbort(error, signal)) {
        await changeStep(db, {
          runId: run.id, stepId: original.id, fromStatus: "running", toStatus: "cancelled",
          eventType: "step_cancelled", patch: { error_message: "Cancelled by client", ended_ms: Date.now() }, detail: { cancelled: true }
        }).catch(() => null);
        throw error;
      }
      const message = String(error?.message || error).slice(0, 400);
      const endedMs = Date.now();
      const updated = await changeStep(db, {
        runId: run.id, stepId: original.id, fromStatus: "running", toStatus: "failed",
        eventType: "step_failed", patch: { error_message: message, ended_ms: endedMs }, detail: { error: message }
      });
      failures.push(updated);
      logger?.warn?.("approved research read failed", { tool: original.tool_name, error: message });
    }
  }
  const status = failures.length ? (completed.length ? "partial" : "failed") : "completed";
  const summary = { note: run.summary?.note ?? null, approved: true, proposed: stepRows.length, completed: completed.length, failed: failures.length, sourceIds: createdSources, decided_ms: decidedMs };
  await changeRun(db, {
    runId: run.id, fromStatus: "running", toStatus: status,
    eventType: "run_finished", patch: { summary, ended_ms: Date.now() }, detail: summary
  });
  const approvals = await db.AgentApproval.list(run.id);
  const steps = await db.AgentStep.list(run.id);
  return { run: await db.AgentRun.get(run.id), steps, approvals, createdSources };
}
