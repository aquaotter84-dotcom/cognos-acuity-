// Council operator — Web Search tool. Pulls current information from the web into
// the council's reasoning when the Observer flags the query as needing real-time
// facts (or the user forces it via the web-search toggle). Returns a sourced
// factual briefing that is surfaced in the council trace and fed to the Specialist
// as explicit context — so the council reasons over pulled facts, not opaque
// model-internal grounding. Degrades gracefully: on failure, passes through.
//
// DIVERGENCE FROM ORIGINAL: the original set add_context_from_internet:true on a
// "gemini_3_flash" call and let the platform do the retrieval. That flag was a
// Base44/BluesMinds platform feature and does not exist here. The retrieval is
// now real and explicit: a search provider (Tavily if TAVILY_API_KEY is set,
// otherwise DuckDuckGo, which needs no key) fetches results, and the model
// summarizes them with the ORIGINAL VERBATIM briefing prompt below. That is
// strictly more honest than the original — the council now sees real URLs.

import { defineAgent } from "../shared/runtime.js";
import { callLLM } from "../llm.js";

async function searchTavily(query, apiKey) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 6, search_depth: "basic", include_answer: true })
  });
  if (!res.ok) throw new Error(`Tavily failed (${res.status})`);
  const data = await res.json();
  const lines = [];
  if (data.answer) lines.push(`Provider summary: ${data.answer}`);
  for (const r of data.results || []) {
    lines.push(`- ${r.title} — ${r.url}\n  ${String(r.content || "").slice(0, 500)}`);
  }
  return lines.join("\n");
}

// Keyless fallback. DuckDuckGo's Instant Answer API returns abstracts and related
// topics — thin compared with a paid index, but real and free.
async function searchDuckDuckGo(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
  const res = await fetch(url, { headers: { "User-Agent": "COGNOS/1.0" } });
  if (!res.ok) throw new Error(`DuckDuckGo failed (${res.status})`);
  const data = await res.json();
  const lines = [];
  if (data.AbstractText) lines.push(`- ${data.Heading || query} — ${data.AbstractURL}\n  ${data.AbstractText}`);
  const walk = (topics) => {
    for (const t of topics || []) {
      if (t.Topics) { walk(t.Topics); continue; }
      if (t.Text) lines.push(`- ${t.Text}${t.FirstURL ? ` — ${t.FirstURL}` : ""}`);
      if (lines.length >= 8) return;
    }
  };
  walk(data.RelatedTopics);
  return lines.join("\n");
}

async function runSearch(ctx, query) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (ctx.config.search.provider === "tavily" && tavilyKey) {
    return { raw: await searchTavily(query, tavilyKey), provider: "tavily" };
  }
  return { raw: await searchDuckDuckGo(query), provider: "duckduckgo" };
}

export const webSearchAgent = defineAgent({
  name: "webSearch",
  type: "stage",
  async handle(message, ctx) {
    const content = message.content;
    const classification = content.classification;
    const forced = !!content.webSearch;
    const needed = !!(classification && classification.needs_web_search);
    if (!ctx.config.search.enabled) return { ...content };
    if (!forced && !needed) {
      return { ...content };
    }
    const query = (classification && classification.search_query && String(classification.search_query).trim()) || content.userMessage;
    try {
      const { raw, provider } = await runSearch(ctx, query);
      if (!raw || !raw.trim()) return { ...content };
      const briefing = await callLLM(ctx, {
        model: ctx.config.models.memory,
        messages: [
          {
            role: "system",
            content: "You are the COGNOS Web Search tool. Using real-time web access, answer the search query with a concise factual briefing of the most current, specific information (dates, numbers, names, events). Cite sources as a bulleted list of URLs or source names at the end. If current information is unavailable, say so briefly. Keep it tight — this is reference material for the council to reason over, not the final answer."
          },
          { role: "user", content: `Search query: ${query}\n\nRetrieved results:\n${raw}` }
        ]
      });
      const results = typeof briefing === "string" ? briefing.trim() : "";
      if (!results) return { ...content };
      return { ...content, searchQuery: query, searchResults: results, webSearchModel: `${provider} + ${ctx.config.models.memory}` };
    } catch (e) {
      ctx.logger.warn("web search failed", { error: String(e) });
      return { ...content };
    }
  }
});
