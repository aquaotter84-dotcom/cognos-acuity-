// The Research Planner — a bounded, read-only step PROPOSER (Phase 18).
//
// Governed research mode never executes a step the planner invents. The
// planner inspects the conversation's/project's existing evidence, names the
// gaps it sees, and proposes a finite list of read-only open_link steps, each
// with a short reason. The steps are stored on an agent run in status
// `awaiting_approval`; execution happens only after the user approves the
// recorded plan (agent_approvals rows with a scope hash), and it reuses the
// same safeFetch-guarded runner the read-only mode uses.
//
// The planner output is a PROPOSAL, not an answer and not authority. It is
// model text with bounded length, sanitized, and — like all untrusted input —
// never treated as instructions by the council.

import { normalizePublicUrl } from "../sources/safeFetch.js";
import { cleanText } from "../sources/extract.js";
import { callLLM } from "../llm.js";

const MAX_STEPS = Math.max(1, Math.min(5, Number(process.env.COGNOS_RESEARCH_MAX_STEPS || 3)));
const MAX_MANIFEST_CHARS = 5_000;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    gap_note: { type: "string" },
    plan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          reason: { type: "string" }
        },
        required: ["url", "reason"],
        additionalProperties: false
      }
    }
  },
  required: ["gap_note", "plan"],
  additionalProperties: false
};

function sanitizeStep(step, seen) {
  const url = String(step?.url || "").trim();
  if (!url || seen.has(url)) return null;
  let normalized;
  try {
    normalized = normalizePublicUrl(url).href;
  } catch {
    return null;
  }
  const reason = cleanText(String(step?.reason || "fills an evidence gap")).slice(0, 220);
  seen.add(normalized);
  return { tool: "open_link", input: { url: normalized }, reason };
}

/** Deterministic manifest of the evidence the planner is allowed to see. */
async function evidenceManifest(db, workspaceId, conversationId, sources, query = "") {
  const chunkRows = sources.length
    ? await db.SourceChunk.listForSources(sources.slice(0, 12).map(source => source.id), 400)
    : [];
  const bySource = new Map();
  for (const chunk of chunkRows) {
    if (!bySource.has(chunk.source_id)) bySource.set(chunk.source_id, []);
    const list = bySource.get(chunk.source_id);
    if (list.length < 2 && bySource.size <= 12) list.push(chunk);
  }
  const lines = [];
  let chars = 0;
  for (const source of sources) {
    const meta = [];
    if (source.kind === "image" && source.extraction?.width) {
      meta.push(`${source.extraction.width}×${source.extraction.height} ${source.extraction.format || "image"}`);
      const vision = source.extraction?.vision;
      meta.push(vision?.status === "completed" ? `vision transcript (${vision.regions ?? 0} regions)` : `no transcript (${vision?.status || "unknown"})`);
    }
    if ((source.risk_flags || []).length) meta.push(`flags: ${source.risk_flags.join(",")}`);
    let line = `- [${source.id}] ${source.name} (${source.kind}, ${source.media_type})${meta.length ? ` — ${meta.join("; ")}` : ""}`;
    for (const chunk of bySource.get(source.id) || []) {
      const content = cleanText(chunk.content).slice(0, 300);
      if (content) line += `\n  excerpt: ${content}`;
    }
    line += "\n";
    if (chars + line.length > MAX_MANIFEST_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  const header = [
    `EVIDENCE MANIFEST (conversation ${conversationId || "new"}, all untrusted, read-only):`,
    lines.join("")
  ].join("\n");
  if (!sources.length) {
    return `${header}\n(no evidence sources exist yet in this scope)\nUser question: ${String(query || "").slice(0, 800)}`;
  }
  return `${header}\nUser question: ${String(query || "").slice(0, 800)}`;
}

/**
 * Propose a bounded research plan. Falls back to the deterministic rule "open
 * the explicit URLs written in the request" when the model is unavailable, so
 * a transport failure never blocks the governed chat path.
 */
export async function proposeResearchPlan({
  db,
  config,
  runId = null,
  workspaceId,
  conversationId,
  objective,
  sources = [],
  signal = null,
  logger = null,
  telemetry = null
}) {
  const explicit = [];
  const seen = new Set();
  const manifest = await evidenceManifest(db, workspaceId, conversationId, sources, objective);
  const modelSteps = [];
  let modelNote = null;
  let modelUsed = null;
  try {
    const ctx = { signal, logger, telemetry, config };
    const parsed = await callLLM(ctx, {
      model: config?.models?.primary || process.env.COGNOS_MODEL,
      purpose: "researchPlanner",
      responseJsonSchema: PLAN_SCHEMA,
      messages: [
        {
          role: "system",
          content: [
            "You are the COGNOS Research Planner, a bounded read-only proposer. The user asked a question that existing evidence may not fully answer.",
            "Inspect the evidence manifest, then name the concrete evidence gap that stands between the current evidence and a defensible answer.",
            "Propose at most a few authoritative PUBLIC web pages (URLs) that would fill that gap. Prefer URLs you are confident exist: official listings, government/registry pages, the named source itself. Do NOT invent document-style URLs with random paths; prefer root domains and obvious, well-known paths. If nothing would help, return an empty plan.",
            "For every step give a one-sentence reason tied to the gap. The user must approve each step before it runs, and every fetch goes through an SSRF-guarded read-only fetcher.",
            "This is a proposal, not an answer. Return only the JSON object."
          ].join("\n")
        },
        { role: "user", content: `Question: ${String(objective || "").slice(0, 2000)}\n\n${manifest}` }
      ]
    });
    const proposed = Array.isArray(parsed?.plan) ? parsed.plan : [];
    modelNote = cleanText(String(parsed?.gap_note || "")).slice(0, 400) || null;
    modelUsed = config?.models?.primary || null;
    for (const step of proposed) {
      const cleaned = sanitizeStep(step, seen);
      if (cleaned) modelSteps.push(cleaned);
      if (modelSteps.length >= MAX_STEPS) break;
    }
  } catch (error) {
    logger?.warn?.("research planner model call failed; falling back to explicit URLs in the request", {
      error: String(error?.message || error).slice(0, 240)
    });
    modelUsed = null;
  }

  // Deterministic floor: explicit URLs the user wrote are always eligible.
  const urlMatches = String(objective || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (let raw of urlMatches) {
    raw = raw.replace(/[),.;!?\]}]+$/g, "");
    const cleaned = sanitizeStep({ url: raw, reason: "URL written in the user's request" }, seen);
    if (cleaned) explicit.push(cleaned);
    if (explicit.length + (modelSteps || []).length >= MAX_STEPS) break;
  }

  const steps = [...(modelSteps || []), ...explicit].slice(0, MAX_STEPS);
  const origin = modelUsed ? "planner_model" : (steps.length ? "explicit_urls" : "planner_model_unavailable");
  return {
    steps,
    note: modelNote || (steps.length ? null : "The planner found no additional read-only research worth proposing from the current evidence."),
    origin,
    modelUsed,
    manifest
  };
}
