// Test harness only — NOT part of the app.
//
// Boots the real Express app (server/index.js) against the real database layer
// (server/db.js -> PGlite over the Postgres wire protocol) and a scriptable mock
// model, then hands back helpers for driving the one send path and for asserting
// on stored rows. Nothing here is imported by the application.

import { startPglite } from "./pglite.mjs";
import { createMockModel } from "./mockModel.mjs";

export async function bootHarness(env = {}) {
  const dbServer = await startPglite({ port: 0 });
  const model = await createMockModel({ port: 0 });

  process.env.DATABASE_URL = dbServer.url;
  process.env.BLUESMINDS_API_URL = model.url;
  process.env.BLUESMINDS_API_KEY = "sk-harness-not-a-real-key";
  process.env.COGNOS_MODEL = process.env.COGNOS_MODEL || "openai/gpt-oss-20b";
  process.env.COGNOS_FAST_MODEL = process.env.COGNOS_FAST_MODEL || "openai/gpt-oss-20b";
  process.env.COGNOS_LLM_TIMEOUT_MS = process.env.COGNOS_LLM_TIMEOUT_MS || "4000";
  process.env.COGNOS_SEARCH_ENABLED = "false";       // the smoke run does not leave the sandbox
  delete process.env.COGNOS_RUNTIME_SECRET;          // no gate during the harness
  for (const [k, v] of Object.entries(env)) {
    if (v === null || v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const { default: app } = await import("../server/index.js");
  const http = await new Promise(resolve => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${http.address().port}`;

  async function raw(path, options = {}) {
    const t0 = Date.now();
    const res = await fetch(base + path, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, ms: Date.now() - t0 };
  }

  /** Drive THE send path and collect every SSE frame it emits. */
  async function chat(userMessage, { conversationId = null, style = "balanced", webSearch = false, attachments = [], agentMode = "off", researchRunId = null, projectId = null } = {}) {
    const t0 = Date.now();
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userMessage, conversationId, style, webSearch, attachments, agentMode, researchRunId, projectId })
    });
    if (!res.ok || !res.body) {
      return { ok: false, status: res.status, events: [], ms: Date.now() - t0 };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        let event = "message";
        const dataLines = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        let data = null;
        try { data = JSON.parse(dataLines.join("\n")); } catch { /* skip */ }
        events.push({ event, data, at: Date.now() - t0 });
      }
    }
    const of = (name) => events.filter(e => e.event === name).map(e => e.data);
    return {
      ok: true,
      status: res.status,
      events,
      of,
      one: (name) => of(name)[0] ?? null,
      tokens: of("token").map(d => d.delta).join(""),
      done: of("done")[0] ?? null,
      error: of("error")[0] ?? null,
      ms: Date.now() - t0
    };
  }

  // The server applies its schema lazily, on its first database operation. A
  // harness that asserts with direct SQL would otherwise query tables the app
  // has not created yet, so warm the app's own migration path first: this is the
  // same code path production takes on its first request.
  const warm = await raw("/api/workspace");
  if (warm.status !== 200) throw new Error(`harness warm-up failed: GET /api/workspace -> ${warm.status} ${warm.text?.slice(0, 200)}`);

  /** Direct SQL against the harness database, for assertions. */
  async function sql(text, params = []) {
    const res = await dbServer.pglite.query(text, params);
    return res.rows;
  }

  async function stop() {
    await new Promise(r => http.close(r));
    await model.stop();
    // Close the app pool before stopping the PostgreSQL wire server; otherwise
    // pg correctly reports its idle socket being terminated as an unhandled
    // pool error in test processes that do not call process.exit immediately.
    const { closeDatabase } = await import("../server/db.js");
    await closeDatabase();
    await dbServer.stop();
  }

  return { base, app, chat, raw, sql, model, dbServer, stop, env: process.env };
}
