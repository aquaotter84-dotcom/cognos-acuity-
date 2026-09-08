// Council operator — Synthesizer (integration / revision). Combines specialist
// sub-task outputs into a single coherent final response. Pass-through on the
// direct path (no decomposition). In Phase 4 it also serves as the reviser: when
// a Critic evaluation is supplied, it rewrites the previous response to address
// the critique, then is re-evaluated by the Critic.

import { defineAgent } from "../shared/runtime.js";
import { callLLM, buildContextSystemPrompt } from "../llm.js";

const SYNTH_BASE = "You are the Synthesizer of the COGNOS council. Integrate the specialist outputs below into a single coherent, well-structured response to the user's original request. Resolve overlaps, remove redundancy, and present a unified answer in markdown. Do not introduce claims beyond what the specialists provided.";

const REVISE_BASE = "You are the Synthesizer of the COGNOS council revising a previous response. The Critic evaluated the previous response and found it inadequate or incorrect. Produce an improved, accurate response that addresses the critique and properly answers the user's underlying request. Output only the revised response in markdown.";

const GOV_REVISE_BASE = "You are the Synthesizer of the COGNOS council revising a previous response. The Governor, the council's sovereignty gate, refused the previous response: its deterministic audit rules found claims that must not ship. Produce a revised response that removes or honestly qualifies every claim the findings name, and that properly answers the user's underlying request. Output only the revised response in markdown.";

export const synthesizerAgent = defineAgent({
  name: "synthesizer",
  type: "stage",
  async handle(message, ctx) {
    const content = message.content;

    // --- Phase 4: revision path — critique supplied, rewrite the response ---
    if (content.critique) {
      const { critique, responseText, userMessage, history, workspace, memories, classification } = content;
      // Clause 3 (enforcement): when the critique comes from the GOVERNOR
      // (source: "governor"), it is a deterministic refusal, not a Critic
      // score — the revision prompt says so, and the refusal text is quoted
      // as findings instead of a 1-10 score.
      const isGovernorRevision = critique.source === "governor";
      const systemPrompt = buildContextSystemPrompt(workspace, memories, classification, isGovernorRevision ? GOV_REVISE_BASE : REVISE_BASE, content.style, content.councilRecord);
      const evalLine = isGovernorRevision
        ? `Governor refusal — deterministic audit findings:\n${critique.reasoning}`
        : `Critic evaluation (score ${critique.score}/10): ${critique.reasoning}`;
      const chatMessages = [
        { role: "system", content: systemPrompt },
        ...history.map(msg => ({ role: msg.role, content: msg.content })),
        { role: "user", content: `Original request:\n${userMessage}\n\nPrevious response:\n${responseText}\n\n${evalLine}\n\nWrite the revised response:` }
      ];
      const revisedText = await callLLM(ctx, { model: ctx.config.models.primary, messages: chatMessages });
      return { ...content, responseText: revisedText, modelUsed: ctx.config.models.primary };
    }

    // --- Normal synthesis ---
    const { needsSynthesis, subTaskOutputs, userMessage, history, workspace, memories, classification } = content;
    if (!needsSynthesis) {
      return { ...content };
    }

    const specialistBrief = subTaskOutputs
      .map((o, i) => `### Sub-task ${i + 1}: ${o.description || o.agent}\n${o.output || "(no output)"}`)
      .join("\n\n");

    const systemPrompt = buildContextSystemPrompt(workspace, memories, classification, SYNTH_BASE, content.style, content.councilRecord);
    const chatMessages = [
      { role: "system", content: systemPrompt },
      ...history.map(msg => ({ role: msg.role, content: msg.content })),
      { role: "user", content: `Original request:\n${userMessage}\n\nSpecialist outputs:\n${specialistBrief}` }
    ];
    const responseText = await callLLM(ctx, { model: ctx.config.models.primary, messages: chatMessages });
    return {
      ...content,
      responseText,
      taskType: classification?.task_type || "conversation",
      modelUsed: ctx.config.models.primary
    };
  }
});