// Agent-mode selector: Research is the default; research-mode read-only web
// access is pre-authorized (Jeremy's standing decision). Writes, external
// actions, and irreversible acts stay behind the actionGovernor — untouched.
import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_MODES, TOOL_REGISTRY, RESEARCH_PREAUTH_REASON,
  researchStepsPreauthorized, normalizeAgentMode,
  approveAndExecuteResearchRun, decideResearchRun
} from "../server/agent/runner.js";
import { buildContextSystemPrompt } from "../server/llm.js";

// ---------------------------------------------------------------------------
// The predicate: read-only tools pre-authorize; anything else fails closed.
// ---------------------------------------------------------------------------
await test("researchStepsPreauthorized admits only registry read-only tools", async () => {
  assert.equal(researchStepsPreauthorized([{ tool: "open_link" }]), true);
  assert.equal(researchStepsPreauthorized([{ tool: "read_source" }, { tool: "open_link" }]), true);
  assert.equal(researchStepsPreauthorized([{ tool_name: "open_link" }]), true,
    "step rows use tool_name");
  assert.equal(researchStepsPreauthorized([{ tool: "open_link" }, { tool: "write_file" }]), false,
    "one non-read-only step blocks pre-authorization");
  assert.equal(researchStepsPreauthorized([{ tool: "mystery_tool" }]), false,
    "unknown tools fail closed");
  assert.equal(researchStepsPreauthorized([]), false, "empty is not pre-authorized");
  assert.equal(researchStepsPreauthorized(null), false);
  assert.ok(typeof RESEARCH_PREAUTH_REASON === "string" && RESEARCH_PREAUTH_REASON.length > 0);
  assert.ok(AGENT_MODES.includes("research"), "research is a mode");
  assert.equal(TOOL_REGISTRY.open_link.requiresApproval, false);
});

// ---------------------------------------------------------------------------
// Fake agent store for the decision paths (no network: decline executes
// nothing; the unregistered-tool step fails before any fetch).
// ---------------------------------------------------------------------------
function makeAgentDb() {
  let seq = 0;
  const runs = new Map();
  const steps = new Map();
  const approvals = [];
  const events = [];
  const db = {
    AgentRun: {
      async get(id) { return runs.get(id) || null; },
      async create(data) {
        const id = `ar_${++seq}`;
        const row = { id, status: "awaiting_approval", ...data };
        runs.set(id, row); return row;
      },
      async update(id, patch) { Object.assign(runs.get(id), patch); return runs.get(id); }
    },
    AgentStep: {
      async list(runId) { return [...steps.values()].filter(s => s.agent_run_id === runId); },
      async create(data) {
        const id = `as_${++seq}`;
        const row = { id, ...data }; steps.set(id, row); return row;
      },
      async update(id, patch) { Object.assign(steps.get(id), patch); return steps.get(id); }
    },
    AgentApproval: {
      async append(data) {
        const row = { id: `aa_${++seq}`, ...data }; approvals.push(row); return row;
      },
      async list(runId) { return approvals.filter(a => a.agent_run_id === runId); }
    },
    AgentEvent: {
      async append(data) { events.push(data); return data; }
    },
    async withTransaction(fn) { return fn(db); }
  };
  return { db, runs, steps, approvals, events };
}

async function seedRun(db, { steps }) {
  const run = await db.AgentRun.create({
    workspace_id: "ws1", conversation_id: "conv1", mode: "research",
    status: "awaiting_approval", objective: "test objective", summary: {}
  });
  for (const s of steps) {
    await db.AgentStep.create({
      agent_run_id: run.id, ordinal: 1, tool_name: s.tool,
      risk_level: "network_read", requires_approval: s.requiresApproval,
      status: "awaiting_approval", input: s.input || {}
    });
  }
  return run;
}

// ---------------------------------------------------------------------------
// Pre-authorized execution: approval rows carry the standing reason, the
// audit trail keeps step_preauthorized / run_preauthorized events, and the
// run completes without any user click.
// ---------------------------------------------------------------------------
await test("pre-authorized research executes with standing approval recorded", async () => {
  const { db, approvals, events } = makeAgentDb();
  const run = await seedRun(db, {
    steps: [{ tool: "unregistered_tool", requiresApproval: false }]
  });
  const out = await approveAndExecuteResearchRun({
    db, runId: run.id, workspaceId: "ws1", preauthorized: true
  });
  assert.equal(out.run.status, "failed", "unregistered tool fails the step without network");
  assert.equal(approvals.length, 1, "an approval row exists for the read");
  assert.equal(approvals[0].decision, "approve");
  assert.equal(approvals[0].reason, RESEARCH_PREAUTH_REASON,
    "the row records the standing pre-authorization, not a click");
  assert.ok(events.some(e => e.event_type === "step_preauthorized"), "step event marked pre-authorized");
  assert.ok(events.some(e => e.event_type === "run_preauthorized"), "run event marked pre-authorized");
  assert.ok(!events.some(e => e.event_type === "step_approved"), "no user-approval events");
});

await test("user approval still records a user reason on the classic path", async () => {
  const { db, approvals, events } = makeAgentDb();
  const run = await seedRun(db, {
    steps: [{ tool: "unregistered_tool", requiresApproval: true }]
  });
  const out = await decideResearchRun({
    db, runId: run.id, workspaceId: "ws1", decision: "approve", reason: "looks good"
  });
  assert.equal(out.run.status, "failed");
  assert.equal(approvals[0].reason, "looks good", "user reason preserved");
  assert.ok(events.some(e => e.event_type === "step_approved"), "classic user-approval event");
});

// ---------------------------------------------------------------------------
// The mixed-step guard: pre-authorized steps ride along; a run with nothing
// approvable cannot be decided.
// ---------------------------------------------------------------------------
await test("decline works on a mixed run; approval needs an approvable step", async () => {
  const { db } = makeAgentDb();
  const run = await seedRun(db, {
    steps: [
      { tool: "open_link", requiresApproval: true },
      { tool: "open_link", requiresApproval: false }
    ]
  });
  const declined = await decideResearchRun({
    db, runId: run.id, workspaceId: "ws1", decision: "decline", reason: "nope"
  });
  assert.equal(declined.run.status, "declined", "mixed run declines cleanly");

  const { db: db2 } = makeAgentDb();
  const run2 = await seedRun(db2, {
    steps: [{ tool: "open_link", requiresApproval: false }]
  });
  await assert.rejects(
    decideResearchRun({ db: db2, runId: run2.id, workspaceId: "ws1", decision: "approve" }),
    /no approvable steps/,
    "a fully pre-authorized run has nothing for a human to decide"
  );
});

// ---------------------------------------------------------------------------
// The mode is visible in the model-facing context, per mode.
// ---------------------------------------------------------------------------
await test("the system prompt carries the agent mode", async () => {
  const research = buildContextSystemPrompt(null, [], { task_type: "research", agentMode: "research" });
  assert.ok(research.includes("AGENT MODE: Research"), "research block present");
  assert.ok(research.includes("pre-authorized"), "names the pre-authorization");
  assert.ok(research.includes("Jeremy's approval"), "writes still need Jeremy");

  const readOnly = buildContextSystemPrompt(null, [], { task_type: "conversation", agentMode: "read_only" });
  assert.ok(readOnly.includes("AGENT MODE: Read-only"), "read-only block present");

  const observe = buildContextSystemPrompt(null, [], { task_type: "conversation", agentMode: "observe" });
  assert.ok(observe.includes("AGENT MODE: Observe"), "observe block present");

  const off = buildContextSystemPrompt(null, [], { task_type: "conversation", agentMode: "off" });
  assert.ok(!off.includes("AGENT MODE"), "plain chat has no mode block");

  const missing = buildContextSystemPrompt(null, [], { task_type: "conversation" });
  assert.ok(!missing.includes("AGENT MODE"), "missing mode degrades to plain chat");
});

// ---------------------------------------------------------------------------
// normalizeAgentMode is unchanged: the vocabulary didn't move, only the default.
// ---------------------------------------------------------------------------
await test("agent mode vocabulary is unchanged", async () => {
  assert.deepEqual([...AGENT_MODES], ["off", "observe", "read_only", "research"]);
  assert.equal(normalizeAgentMode("research"), "research");
  assert.throws(() => normalizeAgentMode("bogus"), /agentMode must be one of/);
});
