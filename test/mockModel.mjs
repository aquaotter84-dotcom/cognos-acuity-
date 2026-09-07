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
  ["Coherence Monitor", "coherence"]
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
    hang: false,              // never respond -> exercises the AbortController
    failStatus: null,         // e.g. 500 / 504 -> upstream HTTP failure
    failRoles: null,          // null = every role, else a Set of roles to fail
    rejectUnknownModel: true, // 400 model_not_found for model ids matching /nonexistent|bad-/
    requests: []
  };

  const reset = (patch = {}) => {
    Object.assign(state, {
      answer: "This is the council's answer. The charter was applied.",
      memories: [{ content: "The user prefers Python for data work.", memory_type: "semantic", importance: 7, evidence_level: "direct", volatility: "medium" }],
      coherence: null, observer: { ...state.observer }, critic: { ...state.critic },
      hang: false, failStatus: null, failRoles: null
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
        at: Date.now(),
        content: (payload.messages || [])
          .map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n---\n")
      });

      if (state.rejectUnknownModel && /nonexistent|bad-/i.test(String(payload.model || ""))) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: `The model '${payload.model}' does not exist`, type: "invalid_request_error", code: "model_not_found" } }));
      }
      if (state.failStatus && (!state.failRoles || state.failRoles.includes(role))) {
        res.writeHead(state.failStatus, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: `upstream ${state.failStatus}`, type: "server_error" } }));
      }
      if (state.hang) return;             // hold the socket open: the client must abort

      await new Promise(r => setTimeout(r, state.latencyMs));

      const json = (obj) => {
        const content = JSON.stringify(obj);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          model: payload.model,
          choices: [{ message: { content }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: (payload.messages || []).reduce((n, m) => n + approxTokens(m.content), 0),
            completion_tokens: approxTokens(content),
            total_tokens: (payload.messages || []).reduce((n, m) => n + approxTokens(m.content), 0) + approxTokens(content)
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
        choices: [{ message: { content: String(answer) }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: (payload.messages || []).reduce((n, m) => n + approxTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content)), 0),
          completion_tokens: approxTokens(answer),
          total_tokens: 0
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
