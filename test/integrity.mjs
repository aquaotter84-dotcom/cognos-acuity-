#!/usr/bin/env node
// Focused regressions for the governed SSE boundary, cooperative cancellation,
// and structured domain errors in the browser API client.

import assert from "node:assert/strict";
import { bootHarness } from "./harness.mjs";
import { api, ApiError } from "../src/lib/api.js";

const h = await bootHarness();
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

try {
  check("modular route registrars preserve the complete HTTP surface", async () => {
    const routes = (h.app._router?.stack || [])
      .filter(layer => layer.route)
      .map(layer => `${Object.keys(layer.route.methods).filter(method => layer.route.methods[method]).join(",")}:${String(layer.route.path)}`);
    const nonStatic = routes.filter(route => !route.includes('/^\\/(?!api'));
    assert.equal(nonStatic.length, 42);
    if (!process.env.VERCEL) assert.equal(routes.length, 43);
    for (const route of [
      "post:/api/chat",
      "get:/api/knowledge/events",
      "get:/api/meta/telemetry",
      "post:/api/meta/adaptations"
    ]) assert.ok(routes.includes(route), `missing ${route}`);
  });

  check("only governed final text crosses SSE", async () => {
    const secret = `sk-${"Z".repeat(28)}`;
    h.model.reset({ answer: `Here is a credential that must be vetoed: ${secret}` });
    const turn = await h.chat("Repeat the secret.");

    assert.equal(turn.done?.council?.governor?.approved, false);
    assert.match(turn.done?.response || "", /Governor stopped that reply/);
    assert.equal(turn.tokens, turn.done?.response);
    assert.equal(turn.tokens.includes(secret), false, "vetoed draft crossed the token stream");

    const firstToken = turn.events.findIndex(e => e.event === "token");
    const lastGovernor = turn.events.reduce((at, e, i) => e.event === "governor" ? i : at, -1);
    assert.ok(firstToken > lastGovernor, `first token frame ${firstToken} preceded Governor frame ${lastGovernor}`);
    h.model.reset();
  });

  check("Stop cancels the active model request and creates no assistant answer", async () => {
    h.model.reset({ hang: true });
    const controller = new AbortController();
    const response = await fetch(`${h.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userMessage: "Start a response that I will cancel." }),
      signal: controller.signal
    });
    assert.equal(response.status, 200);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let initial = "";
    // Wait until the Observer's upstream request is active, then cancel. This
    // proves propagation reaches callLLM rather than merely stopping at a stage
    // boundary before any model work began.
    while (!/event: stage\.start[\s\S]*?"stage":"observer"/.test(initial)) {
      const { done, value } = await reader.read();
      if (done) break;
      initial += decoder.decode(value, { stream: true });
    }
    const startFrame = initial.split("\n\n").find(frame => frame.includes("event: start"));
    const dataLine = startFrame?.split("\n").find(line => line.startsWith("data:"));
    const start = JSON.parse(dataLine?.slice(5).trim() || "null");
    assert.ok(start?.runId && start?.conversationId, "start frame did not identify the run");

    controller.abort();
    try { await reader.read(); } catch (error) {
      assert.equal(error.name, "AbortError");
    }

    let run = null;
    for (let i = 0; i < 100 && !run; i++) {
      const rows = await h.sql("SELECT * FROM telemetry_runs WHERE id=$1", [start.runId]);
      run = rows[0] || null;
      if (!run) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(run, "cancelled run was not recorded");
    assert.equal(run.status, "cancelled");
    assert.equal(run.message_id, null);
    assert.ok((run.failures || []).some(f => f.kind === "abort" || /cancel/i.test(f.message || "")));
    const calls = await h.sql(
      "SELECT status, error_class FROM telemetry_model_calls WHERE run_id=$1 ORDER BY seq",
      [start.runId]
    );
    assert.ok(calls.some(call => call.status === "abort" && call.error_class === "abort"), "active model call was not aborted");

    const assistantRows = await h.sql(
      "SELECT id FROM messages WHERE conversation_id=$1 AND role='assistant'",
      [start.conversationId]
    );
    assert.equal(assistantRows.length, 0, "cancellation persisted an assistant answer");
    const memoryRows = await h.sql("SELECT id FROM memories WHERE source=$1", [start.conversationId]);
    assert.equal(memoryRows.length, 0, "cancellation wrote extracted memory");
    h.model.reset({ hang: false });
  });

  check("Policy Engine 409 responses retain their decision body in ApiError", async () => {
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" && input.startsWith("/") ? `${h.base}${input}` : input;
      return nativeFetch(url, init);
    };
    try {
      await assert.rejects(
        api.proposeAdaptation({
          action: "change_model",
          target: "gpt_5_4",
          justification: "The proposed model appears less expensive in a marketing table.",
          law_refs: ["charter.evidence"],
          evidence: { note: "unverified marketing claim" },
          proposed_by: "test:integrity"
        }),
        error => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 409);
          assert.equal(error.body?.decision, "refused");
          assert.ok((error.body?.reasons || []).some(reason => /ban|gpt_5_4/i.test(reason)));
          assert.ok(error.body?.ledger?.id, "Improvement Ledger row was not returned");
          return true;
        }
      );
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  let passed = 0;
  for (const [name, fn] of checks) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  }
  console.log(`\nINTEGRITY RESULT: ${passed} passed, 0 failed`);
} finally {
  h.model.reset({ hang: false });
  await h.stop();
}
