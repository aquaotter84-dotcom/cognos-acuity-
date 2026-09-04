// Test harness only — a minimal OpenAI-compatible endpoint used to exercise the
// full council pipeline without spending real tokens. Not part of the app.
import http from "node:http";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const system = payload.messages?.find(m => m.role === "system")?.content || "";
    const isJson = payload.response_format?.type === "json_schema";

    let content;
    if (isJson) {
      if (system.includes("You are the Observer")) {
        content = JSON.stringify({ task_type: "question_answering", complexity: "moderate", needs_decomposition: false, intent: "test intent", needs_web_search: false, search_query: "" });
      } else if (system.includes("You are the Strategist")) {
        content = JSON.stringify({ sub_tasks: [] });
      } else if (system.includes("You are the Critic")) {
        content = JSON.stringify({ score: 9, reasoning: "Solid.", needs_revision: false, charter: { truth: true, evidence: true, agency: true, dignity: true, note: "ok" } });
      } else if (system.includes("memory extraction agent")) {
        content = JSON.stringify({ memories: [{ content: "The user is testing the COGNOS council pipeline.", memory_type: "episodic", importance: 6, evidence_level: "direct", volatility: "high" }] });
      } else if (system.includes("memory relevance agent")) {
        content = JSON.stringify({ relevant_ids: [] });
      } else if (system.includes("Summarize the following conversation")) {
        content = JSON.stringify({ summary: "The user tested the council and it responded." });
      } else {
        content = "{}";
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }

    const answer = "This is the council's answer. The charter was applied.";
    if (payload.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const word of answer.split(" ")) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word + " " } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
  });
});

server.listen(4999, "127.0.0.1", () => console.log("mock openai on 4999"));
