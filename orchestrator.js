// Orchestrator — the dispatcher. Runs a registered agent against a protocol message,
// emitting lifecycle events on the bus and routing results/errors back to the caller.
// Phase 1: sequential dispatch. Later phases add parallel/branching collaboration.

import { runAgent } from "./runtime.js";

export function createOrchestrator({ registry, eventBus, logger }) {
  function recordTiming(ctx, stageName, ms, status) {
    if (!ctx.timings) ctx.timings = {};
    const prev = ctx.timings[stageName] || { totalMs: 0, runs: 0, lastStatus: "success" };
    prev.totalMs += ms;
    prev.runs += 1;
    prev.lastStatus = status;
    ctx.timings[stageName] = prev;
  }

  async function dispatch(stageName, message, ctx) {
    if (!registry.has(stageName)) throw new Error(`Stage not registered: ${stageName}`);
    const agent = registry.get(stageName);
    await eventBus.publish("orchestration.stage.start", { stage: stageName, messageId: message.id });
    const t0 = Date.now();
    try {
      const result = await runAgent(agent, message, ctx);
      const ms = Date.now() - t0;
      recordTiming(ctx, stageName, ms, "success");
      logger?.debug?.("stage.timing", { stage: stageName, ms });
      await eventBus.publish("orchestration.stage.complete", { stage: stageName, messageId: message.id, status: "success", ms });
      return result;
    } catch (e) {
      const ms = Date.now() - t0;
      recordTiming(ctx, stageName, ms, "error");
      logger?.debug?.("stage.timing", { stage: stageName, ms, error: String(e) });
      await eventBus.publish("orchestration.stage.complete", { stage: stageName, messageId: message.id, status: "error", ms, error: String(e) });
      throw e;
    }
  }

  return { dispatch };
}