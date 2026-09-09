// Test harness only — NOT part of the app.
//
// A scriptable OpenAI-compatible model endpoint. server/mock-openai.js already
// exists for a happy-path run; this one adds what the Phase 14/15 success
// criteria need: deterministic contradiction text, a draft that trips the
// Governor, real upstream failures (HTTP 500, unknown model) and a hang that
// forces the AbortController path in server/llm.js. It also returns `usage` on
// non-streaming calls so token capture can be demonstrated against a provider
// that exposes it.

import http from "node:http";

const ROLES = [
  ["You are the Observer", "observer"],
  ["You are the Strategist", "strategist"],
  ["You are the Critic", "critic"],
  ["memory extraction agent", "memoryExtraction"],
  ["memory relevance agent", "memoryRelevance"],
  ["Summarize the following conversation", "summary"],
  ["COGNOS Web Search tool", "webSearch"],
  ["Coherence Monitor", "coherence"],
  ["COGNOS Image Desk", "imageDesk"],
  ["COGNOS Research Planner", "researchPlanner"],
  ["You are a bounded autonomous worker", "autonomyStep"]
];

function roleOf(payload) {
  const system = payload.messages?.find(m => m.role === "system")?.content || "";
  for (const [needle, role] of ROLES) if (system.includes(needle)) return role;
  return "final";           // specialist / synthesizer — the user-visible answer
}

const approxTokens = (s) => Math.max(1, Math.ceil(String(s || "").length / 4));

export async function createMockModel({ port = 0, host = "127.0.0.1", latencyMs = 3 } = {}) {
  const state = {
    latencyMs,
    answer: "This is the council's answer. The charter was applied.",
    memories: [{ content: "The user prefers Python for data work.", memory_type: "semantic", importance: 7, evidence_level: "direct", volatility: "medium" }],
    summary: "The user tested the council and it responded.",
    critic: { score: 9, reasoning: "Solid, charter-compliant.", needs_revision: false, charter: { truth: true, evidence: true, agency: true, dignity: true, note: "ok" } },
    coherence: null,          // null -> derive a coherent verdict
    observer: { task_type: "question_answering", complexity: "moderate", needs_decomposition: false, intent: "harness intent", needs_web_search: false, search_query: "" },
    imageDesk: {
      visual_type: "screenshot",
      summary: "A test screenshot region transcript.",
      regions: [
        { id: "r1", kind: "text", x1: 0.05, y1: 0.05, x2: 0.95, y2: 0.2, text: "Contract value: $480,000", uncertain: false },
        { id: "r2", kind: "text", x1: 0.05, y1: 0.3, x2: 0.95, y2: 0.45, text: "Closing date: March 1", uncertain: false }
      ]
    },
    researchPlan: { plan: [], note: "No further research proposed." },
    // The plan the bounded worker returns. A function lets a test script a
    // sequence: escalate to a write skill, emit prose, try to widen scope.
    autonomyStep: { thought: "nothing useful to add", skill: null, args: {}, done: true },
    hang: false,              // never respond -> exercises the AbortController
    failStatus: null,         // e.g. 500 / 504 -> upstream HTTP failure
    failRoles: null,          // null = every role, else a Set of roles to fail
    failCount: null,          // null = keep failing; number = fail this many matching attempts
    failBody: null,           // optional raw body, including proxy HTML for sanitization tests
    failContentType: null,
    rejectUnknownModel: true, // 400 model_not_found for model ids matching /nonexistent|bad-/
    cachedTokens: 0,
    requests: []
  };

  const reset = (patch = {}) => {
    Object.assign(state, {
      answer: "This is the council's answer. The charter was applied.",
      memories: [{ content: "The user prefers Python for data work.", memory_type: "semantic", importance: 7, evidence_level: "direct", volatility: "medium" }],
      coherence: null, observer: { ...state.observer }, critic: { ...state.critic },
      imageDesk: { ...state.imageDesk }, researchPlan: { ...state.researchPlan },
      hang: false, failStatus: null, failRoles: null, failCount: null,
      failBody: null, failContentType: null
    }, patch);
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      const payload = JSON.parse(body || "{}");
      const role = roleOf(payload);
      // Test-only instrumentation: keep the prompt text so scenarios can assert
      // what an operator was actually given (e.g. that the Critic received the
      // coherence brief). Nothing in the app reads this.
      state.requests.push({
        role,
        model: payload.model,
        stream: !!payload.stream,
        serviceTier: payload.service_tier || null,
        promptCacheKey: payload.prompt_cache_key || null,
        at: Date.now(),
        content: (payload.messages || [])
          .map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n---\n")
      });

      if (state.rejectUnknownModel && /nonexistent|bad-/i.test(String(payload.model || ""))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: `The model '${payload.model}' does not exist`, type: "invalid_request_error", code: "model_not_found" } }));
      }
      const matchingFailure = state.failStatus && (!state.failRoles || state.failRoles.includes(role));
      const failureRemaining = state.failCount === null || Number(state.failCount) > 0;
      if (matchingFailure && failureRemaining) {
        if (state.failCount !== null) state.failCount = Math.max(0, Number(state.failCount) - 1);
        const body = state.failBody ?? JSON.stringify({ error: { message: `upstream ${state.failStatus}`, type: "server_error" } });
        res.writeHead(state.failStatus, { "Content-Type": state.failContentType || "application/json" });
        return res.end(body);
      }
      if (state.hang) return;             // hold the socket open: the client must abort

      await new Promise(r => setTimeout(r, state.latencyMs));

      const json = (obj) => {
        const content = JSON.stringify(obj);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          model: payload.model,
          service_tier: payload.service_tier || "default",
          choices: [{ message: { content }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: (payload.messages || []).reduce((n, m) => n + approxTokens(m.content), 0),
            completion_tokens: approxTokens(content),
            total_tokens: (payload.messages || []).reduce((n, m) => n + approxTokens(m.content), 0) + approxTokens(content),
            prompt_tokens_details: { cached_tokens: state.cachedTokens }
          }
        }));
      };

      if (payload.response_format?.type === "json_schema") {
        if (role === "observer") return json(state.observer);
        if (role === "strategist") return json({ sub_tasks: [] });
        if (role === "critic") return json(state.critic);
        if (role === "memoryRelevance") return json({ relevant_ids: [] });
        if (role === "memoryExtraction") return json({ memories: state.memories });
        if (role === "summary") return json({ summary: state.summary });
        if (role === "coherence") {
          if (state.coherence) return json(typeof state.coherence === "function" ? state.coherence(payload) : state.coherence);
          return json({ verdict: "coherent", claims: [], note: "No conflict with stored beliefs." });
        }
        if (role === "imageDesk") return json(typeof state.imageDesk === "function" ? state.imageDesk(payload) : state.imageDesk);
        if (role === "researchPlanner") return json(typeof state.researchPlan === "function" ? state.researchPlan(payload) : state.researchPlan);
        if (role === "autonomyStep") {
          const step = typeof state.autonomyStep === "function" ? state.autonomyStep(payload) : state.autonomyStep;
          return json(step);
        }
        return json({});
      }

      // Non-JSON call: the specialist/synthesizer answer.
      const answer = typeof state.answer === "function" ? state.answer(payload) : state.answer;
      if (payload.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const word of String(answer).split(" ")) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word + " " } }] })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        model: payload.model,
        service_tier: payload.service_tier || "default",
        choices: [{ message: { content: String(answer) }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: (payload.messages || []).reduce((n, m) => n + approxTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content)), 0),
          completion_tokens: approxTokens(answer),
          total_tokens: 0,
          prompt_tokens_details: { cached_tokens: state.cachedTokens }
        }
      }));
    });
  });

  await new Promise(resolve => server.listen(port, host, resolve));
  const bound = server.address().port;
  return {
    url: `http://${host}:${bound}/v1`,
    port: bound,
    state,
    reset,
    requests: state.requests,
    async stop() { await new Promise(r => server.close(r)); }
  };
}
