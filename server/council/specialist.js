// Council operator — Specialist (execution). The cognitive worker layer.
// If the Strategist decomposed the task, runs each sub-task against a role-specific
// specialist prompt in parallel and persists outputs to the TaskContext. Otherwise,
// takes the direct path: a single contextual LLM response (the former llmRespond).

import { defineAgent } from "../shared/runtime.js";
import { callLLM, buildContextSystemPrompt, styleDirective } from "../llm.js";

const SPECIALIST_PROMPTS = {
  research: "You are a Research specialist in the COGNOS council. Investigate the assigned question thoroughly, surface concrete facts, and return well-organized findings in markdown. Focus only on your assigned sub-task.",
  coding: "You are a Coding specialist in the COGNOS council. Produce clear, correct, well-structured code for the assigned sub-task with brief explanations. Focus only on your assigned sub-task.",
  analysis: "You are an Analysis specialist in the COGNOS council. Analyze the assigned sub-task rigorously, surface trade-offs and key insights, and return structured markdown. Focus only on your assigned sub-task.",
  planning: "You are a Planning specialist in the COGNOS council. Produce an actionable, sequenced plan for the assigned sub-task with clear steps. Focus only on your assigned sub-task.",
  creative: "You are a Creative specialist in the COGNOS council. Produce imaginative, original content for the assigned sub-task. Focus only on your assigned sub-task.",
  decision_support: "You are a Decision Support specialist in the COGNOS council. Lay out options, criteria, and a recommendation for the assigned sub-task. Focus only on your assigned sub-task.",
  question_answering: "You are a Question Answering specialist in the COGNOS council. Answer the assigned sub-task accurately and concisely. Focus only on your assigned sub-task.",
  action_execution: "You are an Action Execution specialist in the COGNOS council. Carry out the assigned sub-task and report what was done. Focus only on your assigned sub-task.",
  conversation: "You are a Conversation specialist in the COGNOS council. Respond helpfully to the assigned sub-task. Focus only on your assigned sub-task."
};

export const specialistAgent = defineAgent({
  name: "specialist",
  type: "stage",
  async handle(message, ctx) {
    const { history, memories, workspace, userMessage, classification, taskContext } = message.content;

    // --- Decomposed path: execute sub-tasks in parallel ---
    const subTasks = taskContext?.sub_tasks;
    if (Array.isArray(subTasks) && subTasks.length > 0) {
      const outputs = await Promise.all(subTasks.map(async (st) => {
        const rolePrompt = (SPECIALIST_PROMPTS[st.agent] || SPECIALIST_PROMPTS[classification?.task_type] || SPECIALIST_PROMPTS.conversation) + styleDirective(message.content.style);
        try {
          const output = await callLLM(ctx, {
            model: ctx.config.models.primary,
            messages: [
              { role: "system", content: rolePrompt },
              { role: "user", content: st.input || st.description || userMessage }
            ]
          });
          return { ...st, output, status: "complete" };
        } catch (e) {
          ctx.logger.warn("specialist sub-task failed", { agent: st.agent, error: String(e) });
          return { ...st, output: "", status: "error" };
        }
      }));
      try {
        await ctx.db.TaskContext.update(taskContext.id, { sub_tasks: outputs });
      } catch (e) {
        ctx.logger.warn("specialist could not persist sub-task outputs", { error: String(e) });
      }
      return { ...message.content, subTaskOutputs: outputs, needsSynthesis: true, responseText: null };
    }

    // --- Direct path: single contextual response ---
    // Web search grounding arrives explicitly via searchResults (pulled by the
    // webSearch council tool), surfaced in the trace and fed here as context so
    // the council reasons over pulled facts. Attachments (file_urls) forwarded for
    // multimodal analysis.
    const { attachments, searchResults } = message.content;
    const systemPrompt = buildContextSystemPrompt(workspace, memories, classification, undefined, message.content.style);
    const userContent = searchResults
      ? `${userMessage}\n\n[Web search results — current information pulled by the council web search tool; cite as needed]:\n${searchResults}`
      : userMessage;
    const chatMessages = [
      { role: "system", content: systemPrompt },
      ...history.map(msg => ({ role: msg.role, content: msg.content })),
      { role: "user", content: userContent }
    ];
    // SANCTIONED UPGRADE (streaming): on the direct path the final answer is the
    // user-visible text, so tokens are forwarded to the SSE stream as they arrive.
    // Everything else about this stage is unchanged.
    const responseText = await callLLM(ctx, {
      model: ctx.config.models.primary,
      messages: chatMessages,
      ...(attachments && attachments.length ? { file_urls: attachments.map(a => a.file_url).filter(Boolean) } : {}),
      ...(ctx.stream && ctx.onToken ? { stream: true, onToken: ctx.onToken } : {})
    });
    return {
      ...message.content,
      responseText,
      needsSynthesis: false,
      subTaskOutputs: null,
      taskType: classification?.task_type || "conversation",
      modelUsed: ctx.config.models.primary
    };
  }
});