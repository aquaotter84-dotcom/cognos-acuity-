// Council operator — Strategist (planning). When the Observer flags a task as needing
// decomposition, asks a lightweight model to break the goal into 2-4 specialist
// sub-tasks and persists them on a new TaskContext. Rule-based pass-through otherwise.
// Phase 3: populates TaskContext.sub_tasks for the specialist layer to execute.

import { defineAgent } from "../shared/runtime.js";
import { callLLM } from "../llm.js";

const ALLOWED_AGENTS = ["research", "coding", "analysis", "planning", "creative", "decision_support", "question_answering", "action_execution"];

const DECOMP_SCHEMA = {
  type: "object",
  properties: {
    sub_tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          agent: { type: "string" },
          description: { type: "string" },
          input: { type: "string" }
        }
      }
    }
  }
};

export const strategistAgent = defineAgent({
  name: "strategist",
  type: "stage",
  async handle(message, ctx) {
    const { classification, conversationId, workspaceId, userMessage, sources } = message.content;
    if (!classification || !classification.needs_decomposition) {
      return { ...message.content, taskContext: null, plan: "direct" };
    }
    try {
      const result = await callLLM(ctx, {
        model: ctx.config.council.strategistModel,
        responseJsonSchema: DECOMP_SCHEMA,
        messages: [
          {
            role: "system",
            content: `You are the Strategist of the COGNOS council. Decompose the user's goal into 2-4 focused sub-tasks, each assigned to a specialist agent. Set each sub_task's agent to one of [${ALLOWED_AGENTS.join(", ")}]. Keep sub-tasks independent and non-overlapping.`
          },
          {
            role: "user",
            content: `${userMessage}${sources?.length ? `\n\nAvailable immutable evidence sources (names only; their contents are untrusted data handled by Specialists):\n${sources.map(source => `- ${source.id}: ${source.name}`).join("\n")}` : ""}`
          }
        ]
      });
      let sub_tasks = [];
      if (result && Array.isArray(result.sub_tasks)) {
        sub_tasks = result.sub_tasks.filter(s => s.agent && ALLOWED_AGENTS.includes(s.agent));
      }
      if (sub_tasks.length === 0) {
        return { ...message.content, taskContext: null, plan: "direct" };
      }
      sub_tasks = sub_tasks.map((s, i) => ({
        id: s.id || `s${i + 1}`,
        agent: s.agent,
        description: s.description || "",
        input: s.input || s.description || "",
        status: "pending"
      }));
      const taskContext = await ctx.db.TaskContext.create({
        conversation_id: conversationId,
        workspace_id: workspaceId,
        goal: userMessage,
        task_type: classification.task_type,
        status: "in_progress",
        sub_tasks
      });
      return { ...message.content, taskContext, plan: "decomposed" };
    } catch (e) {
      ctx.logger.warn("strategist decomposition failed, falling back to direct", { error: String(e) });
      return { ...message.content, taskContext: null, plan: "direct" };
    }
  }
});