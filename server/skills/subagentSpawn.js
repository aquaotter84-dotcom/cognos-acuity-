// T1 — spawn one narrow sub-agent for a bounded objective.
//
// The planner proposes the worker's objective, skill subset, and sub-budget;
// the code clamps all three. A refused declaration fails the SPAWN (no worker
// runs on a subset it was not granted); a worker that reaches outside its
// subset is stopped and recorded, but the spawn itself still succeeded — the
// refusal is a row on the sub-agent, not a failure of the parent step.
//
// Rung 3: spawning needs COGNOS_AUTONOMY_RESIDENTS. The tick refuses earlier
// with a recorded row; this re-check is defense in depth.

import { runSubagent, effectiveSubset } from "../autonomy/subagent.js";

export async function spawnSubagent({ db, goal, agent, args, tickId, stepId, config, signal = null }) {
  if (config?.rung?.residents !== true) {
    return { ok: false, error: "sub-agents need Rung 3 (COGNOS_AUTONOMY_RESIDENTS)" };
  }
  const objective = String(args?.objective || "").trim();
  if (!objective) return { ok: false, error: "objective is required" };
  const declared = Array.isArray(args?.skills) ? args.skills : [];
  if (!declared.length) return { ok: false, error: "skills must name at least one skill" };

  const { subset, dropped } = effectiveSubset({ declared, agent, config });
  // Dropped skills fail the spawn loudly. Silently narrowing the subset would
  // leave the planner believing it granted something it did not.
  if (dropped.length) {
    return { ok: false, error: `subset refused: ${dropped.map(d => `${d.id} (${d.reason})`).join("; ").slice(0, 400)}` };
  }
  if (!subset.length) return { ok: false, error: "skills must name at least one runnable skill" };

  try {
    const result = await runSubagent({
      db, goal, agent, subset, objective,
      budget: {
        maxSteps: args?.maxSteps,
        maxModelCalls: args?.maxModelCalls,
        maxCostUsd: args?.maxCostUsd
      },
      tickId, parentStepId: stepId,
      workspaceId: goal.workspace_id,
      config, signal
    });
    return {
      ok: true,
      output: {
        subagentId: result.subagentId,
        status: result.status,
        stepsExecuted: result.stepsExecuted,
        findingsWritten: result.findingsWritten,
        noteIds: result.noteIds,
        skillsUsed: result.skillsUsed,
        modelCalls: result.modelCalls,
        costUsd: result.costUsd,
        ...(result.error ? { note: result.error } : {})
      }
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 400) };
  }
}
