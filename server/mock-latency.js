// Test harness only. Same as mock-openai.js but with realistic per-role latency,
// so we can measure where a council turn actually spends its time.
import http from "node:http";

const L = {
  observer:   Number(process.env.L_OBSERVER   || 900),
  strategist: Number(process.env.L_STRATEGIST || 1200),
  critic:     Number(process.env.L_CRITIC     || 1100),
  memrel:     Number(process.env.L_MEMREL     || 800),
  memext:     Number(process.env.L_MEMEXT     || 1000),
  summary:    Number(process.env.L_SUMMARY    || 900),
  search:     Number(process.env.L_SEARCH     || 1500),
  main:       Number(process.env.L_MAIN       || 2500),  // time to FIRST token
  tokenGap:   Number(process.env.L_TOKENGAP   || 25)
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function classify(system) {
  if (system.includes("You are the Observer")) return "observer";
  if (system.includes("You are the Strategist")) return "strategist";
  if (system.includes("You are the Critic")) return "critic";
  if (system.includes("memory relevance agent")) return "memrel";
  if (system.includes("memory extraction agent")) return "memext";
  if (system.includes("Summarize the following")) return "summary";
  if (system.includes("COGNOS Web Search tool")) return "search";
  return "main";
}

const COMPLEXITY = process.env.MOCK_COMPLEXITY || "simple";
const NEEDS_SEARCH = process.env.MOCK_SEARCH === "true";

http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", async () => {
    const p = JSON.parse(body || "{}");
    const system = p.messages?.find(m => m.role === "system")?.content || "";
    const role = classify(system);
    await sleep(L[role] ?? 500);

    if (p.response_format?.type === "json_schema") {
      const map = {
        observer: { task_type: "question_answering", complexity: COMPLEXITY, needs_decomposition: false, intent: "x", needs_web_search: NEEDS_SEARCH, search_query: NEEDS_SEARCH ? "q" : "" },
        strategist: { sub_tasks: [] },
        critic: { score: 9, reasoning: "ok", needs_revision: false, charter: { truth: true, evidence: true, agency: true, dignity: true, note: "" } },
        memrel: { relevant_ids: [] },
        memext: { memories: [] },
        summary: { summary: "s" }
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(map[role] ?? {}) } }] }));
    }

    const answer = "Answer token stream here for measurement purposes only.";
    if (p.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const w of answer.split(" ")) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w + " " } }] })}\n\n`);
        await sleep(L.tokenGap);
      }
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
  });
}).listen(4998, "127.0.0.1", () => console.log("latency mock on 4998"));
