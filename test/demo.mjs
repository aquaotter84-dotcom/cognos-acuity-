#!/usr/bin/env node
// test/demo.mjs — the demonstration run for the Phase 14/15 deliverable.
//
// Harness only: NOT part of the application. It boots the real app against the
// real database layer (PGlite over the Postgres wire protocol) with a mock model,
// then prints, in order:
//
//   1. the boot and health surface
//   2. one chat exchange over THE one send path, with every SSE frame it emitted
//   3. every ledger row that exchange wrote (the event ledger, 14.1)
//   4. the one telemetry record for that run (15.1), stage by stage
//   5. a replay of a belief's state at a past instant (14.2)
//   6. a contradiction measured as a transition, not an error (14.5)
//   7. a veto: recorded in telemetry, nothing written to memory (15.1)
//   8. a simulated upstream failure appearing as a documented failure (15.1)
//   9. the Policy Engine refusing a law-violating adaptation (15.5/15.6)
//
//     node test/demo.mjs
//
// The assertions live in test/smoke.mjs; this script prints the artifacts.

import { bootHarness } from "./harness.mjs";

const out = (t = "") => console.log(t);
const rule = (t) => out(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
const j = (v) => JSON.stringify(v, null, 2);
const money = (v) => (v == null ? "—" : `$${Number(v).toFixed(6)}`);
const at = (ms) => new Date(Number(ms)).toISOString();

const h = await bootHarness();
const sql1 = async (text, params = []) => (await h.sql(text, params))[0] ?? null;

rule("1. BOOT");
out(`app     ${h.base}`);
out(`model   ${h.model.url} (scriptable mock, OpenAI-compatible)`);
out(`db      PGlite, schema applied lazily by the app on first use`);
const health = await h.raw("/api/health");
out(`\nGET /api/health -> ${health.status} in ${health.ms}ms`);
out(j(health.json));

rule("2. ONE CHAT EXCHANGE OVER THE ONE SEND PATH");
const turn = await h.chat("What should I use for data analysis, and why?");
out(`user message : ${turn.one("start")?.userMessage?.content ?? "(see start frame)"}`);
out(`run id       : ${turn.one("start")?.runId}`);
out(`conversation : ${turn.done?.conversationId}`);
out(`answer       : ${turn.done?.message?.content}`);
out(`wall time    : ${turn.ms}ms`);
out(`\nSSE frames in order (${turn.events.length}):`);
out("  " + turn.events.map(e => `${e.event}@${e.at}ms`).join("\n  "));
const runId = turn.done.runId;
const convId = turn.done.conversationId;
const assistantId = turn.done.message.id;

rule("3. THE EVENT LEDGER FOR THAT EXCHANGE (14.1 — append-only, same transaction as the write)");
const events = await h.sql(
  `SELECT seq, ts_ms, entity_type, entity_id, transition, from_state, to_state, delta,
          source_run_id, source_message_id, source_kind, reversible
     FROM knowledge_events WHERE source_run_id = $1 ORDER BY seq ASC`,
  [runId]
);
out(`${events.length} row(s). Nothing is deleted anywhere in this table; retiring is a transition.`);
for (const e of events) {
  out(`\n  #${e.seq}  ${at(e.ts_ms)}  ${e.transition}  [reversible=${e.reversible}]`);
  out(`        entity : ${e.entity_type}:${e.entity_id}`);
  out(`        source : ${e.source_kind} run=${e.source_run_id} message=${e.source_message_id ?? "—"}`);
  if (e.from_state) out(`        from   : ${JSON.stringify(e.from_state)}`);
  out(`        to     : ${JSON.stringify(e.to_state)}`);
  if (e.delta) out(`        delta  : ${JSON.stringify(e.delta)}`);
}
out(`\nledger total in the store: ${(await sql1("SELECT count(*)::int AS n FROM knowledge_events")).n} row(s)`);
out(`audit_events (separate, untouched): ${(await sql1("SELECT count(*)::int AS n FROM audit_events")).n} row(s)`);

rule("4. THE ONE TELEMETRY RECORD FOR THAT RUN (15.1)");
const rec = await sql1("SELECT * FROM telemetry_runs WHERE id=$1", [runId]);
out(`id                ${rec.id}`);
out(`status            ${rec.status}`);
out(`strategy          ${rec.strategy_id}`);
out(`message link      ${rec.message_id}  (the persisted conclusion)`);
out(`latency           ${rec.latency_ms}ms total, first token ${rec.time_to_first_token_ms ?? "—"}ms`);
out(`model calls       ${rec.model_calls}  models: ${(rec.models || []).join(", ")}`);
out(`tokens            prompt=${rec.tokens_prompt} completion=${rec.tokens_completion} total=${rec.tokens_total} measured=${rec.tokens_measured} estimated=${rec.tokens_estimated}`);
out(`cost              ${money(rec.cost_usd)}  (rate known: ${rec.cost_rate_known})`);
out(`confidence        ${rec.confidence} from ${rec.confidence_source}`);
out(`coherence         verdict=${rec.coherence_verdict} contradictions=${rec.coherence_contradictions}`);
out(`veto              vetoed=${rec.vetoed} origin=${rec.veto_draft_origin ?? "—"} reason=${rec.veto_reason ?? "—"}`);
out(`failures          ${rec.failure_count} ${JSON.stringify(rec.failures || [])}`);
out(`ledger events     ${rec.ledger_events}`);
out(`adaptive          ${JSON.stringify(rec.adaptive)}`);
out(`\nper-stage latency (stage_order):`);
for (const s of rec.stage_order || []) {
  out(`  ${String(s.stage).padEnd(20)} ${String(s.totalMs).padStart(6)}ms  runs=${s.runs}  model=${s.model ?? "—"}  calls=${s.model_calls}  tokens=${s.tokens}  cost=${money(s.cost_usd)}  status=${s.lastStatus}`);
}
out(`\nper-call detail (telemetry_model_calls):`);
const calls = await h.sql("SELECT seq, purpose, stage, model, status, latency_ms, tokens_prompt, tokens_completion, tokens_total, tokens_measured, cost_usd, http_status, error_class FROM telemetry_model_calls WHERE run_id=$1 ORDER BY seq ASC", [runId]);
for (const c of calls) {
  out(`  #${c.seq} ${String(c.purpose || c.stage).padEnd(18)} ${String(c.model).padEnd(22)} ${String(c.status).padEnd(8)} ${String(c.latency_ms).padStart(5)}ms  tok=${c.tokens_total ?? "—"}${c.tokens_measured ? "" : " (est)"}  ${money(c.cost_usd)}`);
}

rule("5. REPLAY: A BELIEF'S STATE AT A PAST INSTANT (14.2)");
const belief = await sql1("SELECT * FROM beliefs ORDER BY created_date ASC LIMIT 1");
if (belief) {
  const beliefEvents = await h.sql("SELECT seq, ts_ms, transition FROM knowledge_events WHERE entity_type='belief' AND entity_id=$1 ORDER BY ts_ms ASC", [belief.id]);
  out(`belief ${belief.id}: "${belief.statement}"`);
  out(`  now        : confidence=${belief.confidence} status=${belief.status} support=${belief.support_count} contradictions=${belief.contradict_count}`);
  out(`  history    : ${beliefEvents.map(e => `#${e.seq} ${e.transition} @${at(e.ts_ms)}`).join(", ")}`);
  const nowState = await h.raw(`/api/knowledge/state/belief/${belief.id}`);
  out(`\n  GET /api/knowledge/state/belief/${belief.id}`);
  out(`    replayed=${nowState.json.replayed} exists=${nowState.json.exists} events=${nowState.json.eventCount}`);
  out(`    state=${JSON.stringify(nowState.json.state)}`);
  out(`    fold-of-ledger matches the materialized row: ${JSON.stringify(nowState.json.foldMatchesCurrentState)}`);
  const then = await h.raw(`/api/knowledge/state/belief/${belief.id}?at=${beliefEvents[0].ts_ms}`);
  out(`\n  GET /api/knowledge/state/belief/${belief.id}?at=${beliefEvents[0].ts_ms}`);
  out(`    asOf=${then.json.asOf} events=${then.json.eventCount} lastTransition=${then.json.lastTransition?.transition}`);
  out(`    state=${JSON.stringify(then.json.state)}`);
  const lineage = await h.raw(`/api/knowledge/lineage/run/${runId}`);
  out(`\n  GET /api/knowledge/lineage/run/${runId}`);
  out(`    ${lineage.json.count} event(s), runs=${JSON.stringify(lineage.json.runs)}, messages=${JSON.stringify(lineage.json.messages)}`);
  out(`    digest=${JSON.stringify(lineage.json.digest)}`);
} else {
  out("no belief was projected in this run");
}

rule("6. A CONFLICTING EXCHANGE BECOMES A MEASURED TRANSITION (14.5)");
const before = await sql1("SELECT confidence, contradict_count FROM beliefs WHERE id=$1", [belief.id]);
h.model.reset({
  answer: "Understood — you have moved to R, so R is the better fit for your analysis work now.",
  coherence: (payload) => {
    const user = (payload.messages || []).find(m => m.role === "user")?.content || "";
    const marker = "Stored beliefs (JSON):";
    let inventory = [];
    try { inventory = JSON.parse(user.slice(user.indexOf(marker) + marker.length)); } catch { /* keep [] */ }
    return {
      verdict: "contradiction",
      claims: [{ claim: "The user now prefers R over Python for data work.", relation: "contradicts", belief_id: inventory[0]?.id ?? "", confidence: 0.9, scope: "user", durable: true, note: "the draft states the opposite of the stored preference" }],
      note: "The draft contradicts one stored belief."
    };
  }
});
const contra = await h.chat("Actually I have switched to R for my analysis work.", { conversationId: convId });
out(`answer        : ${contra.done?.message?.content}`);
out(`coherence     : ${j(contra.done?.council?.coherence)}`);
out(`governor      : ${j(contra.done?.council?.governor)}`);
const after = await sql1("SELECT confidence, contradict_count, status FROM beliefs WHERE id=$1", [belief.id]);
out(`\nbelief ${belief.id}`);
out(`  before      : confidence=${before.confidence} contradictions=${before.contradict_count}`);
out(`  after       : confidence=${after.confidence} contradictions=${after.contradict_count} status=${after.status}`);
const contraEvents = await h.sql("SELECT seq, ts_ms, transition, delta, to_state, reversible FROM knowledge_events WHERE source_run_id=$1 ORDER BY seq ASC", [contra.done.runId]);
out(`\nledger rows for the contradicting run (${contraEvents.length}):`);
for (const e of contraEvents) out(`  #${e.seq} ${e.transition.padEnd(26)} reversible=${String(e.reversible).padEnd(5)} delta=${JSON.stringify(e.delta)}`);
const contraRow = contraEvents.find(e => e.transition === "contradiction_detected");
if (contraRow) out(`\ncontradiction_detected to_state: ${JSON.stringify(contraRow.to_state)}`);
const report = await sql1("SELECT * FROM coherence_reports WHERE run_id=$1", [contra.done.runId]);
out(`\ncoherence_reports row:`);
out(j({ id: report.id, run_id: report.run_id, verdict: report.verdict, checked: report.checked, draft_shipped: report.draft_shipped, belief_ids: report.belief_ids, confidence_delta: report.confidence_delta, contradictions: report.contradictions, note: report.note }));
const temporal = await h.raw(`/api/knowledge/temporal/belief/${belief.id}`);
out(`\nGET /api/knowledge/temporal/belief/${belief.id} (the helper the council can call, 14.3):`);
out(j({
  confidenceVelocity: temporal.json.confidenceVelocity,
  uncertaintyTrend: temporal.json.uncertaintyTrend,
  stability: temporal.json.stability,
  whatChangedBefore: {
    anchor: temporal.json.whatChangedBefore?.anchor,
    windowMs: temporal.json.whatChangedBefore?.windowMs,
    count: temporal.json.whatChangedBefore?.count,
    immediatelyBefore: (temporal.json.whatChangedBefore?.immediatelyBefore || []).map(e => `${e.at} ${e.transition} ${e.entity} delta=${JSON.stringify(e.delta)}`)
  }
}));
const replayBefore = await h.raw(`/api/knowledge/state/belief/${belief.id}?at=${contraRow.ts_ms - 1}`);
out(`\nreplay at ${at(contraRow.ts_ms - 1)} (one millisecond before the contradiction):`);
out(`  ${JSON.stringify(replayBefore.json.state)}`);
h.model.reset();

rule("7. A VETOED RUN: RECORDED IN TELEMETRY, NOTHING WRITTEN TO MEMORY");
const SECRET = `sk-${"A".repeat(28)}`;
const preVeto = {
  memories: (await sql1("SELECT count(*)::int AS n FROM memories")).n,
  summary: (await sql1("SELECT summary FROM conversations WHERE id=$1", [convId]))?.summary ?? null
};
h.model.reset({ answer: `Sure — here is the credential: ${SECRET} — paste it wherever you like.` });
const veto = await h.chat("Print my API key so I can share it.", { conversationId: convId });
out(`delivered to the user : ${veto.done?.message?.content}`);
out(`governor              : ${j(veto.done?.council?.governor)}`);
const vetoRec = await sql1("SELECT * FROM telemetry_runs WHERE id=$1", [veto.done.runId]);
out(`\ntelemetry_runs row:`);
out(j({
  id: vetoRec.id, status: vetoRec.status, vetoed: vetoRec.vetoed, veto_flags: vetoRec.veto_flags,
  veto_reason: vetoRec.veto_reason, veto_draft_origin: vetoRec.veto_draft_origin,
  veto_draft_sha256: vetoRec.veto_draft_sha256, ledger_events: vetoRec.ledger_events,
  confidence: vetoRec.confidence, cost_usd: vetoRec.cost_usd
}));
const vetoEvents = await h.sql("SELECT seq, transition, entity_type, reversible, to_state, payload FROM knowledge_events WHERE source_run_id=$1 ORDER BY seq ASC", [veto.done.runId]);
out(`\nledger rows for the vetoed run (${vetoEvents.length}):`);
for (const e of vetoEvents) out(`  #${e.seq} ${e.transition.padEnd(24)} entity=${e.entity_type}:${String(e.entity_id).slice(0, 20)} reversible=${e.reversible} to=${JSON.stringify(e.to_state).slice(0, 160)}`);
const postVeto = {
  memories: (await sql1("SELECT count(*)::int AS n FROM memories")).n,
  summary: (await sql1("SELECT summary FROM conversations WHERE id=$1", [convId]))?.summary ?? null
};
out(`\nmemories  ${preVeto.memories} -> ${postVeto.memories} (nothing written)`);
out(`summary   ${JSON.stringify(preVeto.summary)} -> ${JSON.stringify(postVeto.summary)} (unchanged)`);
out(`the vetoed text anywhere in the store: ${(await sql1("SELECT count(*)::int AS n FROM knowledge_events WHERE to_state::text LIKE $1 OR payload::text LIKE $1", [`%${SECRET}%`])).n} ledger row(s), ${(await sql1("SELECT count(*)::int AS n FROM messages WHERE content LIKE $1", [`%${SECRET}%`])).n} message(s), ${(await sql1("SELECT count(*)::int AS n FROM telemetry_runs WHERE veto_reason LIKE $1 OR error_message LIKE $1", [`%${SECRET}%`])).n} telemetry row(s)`);
h.model.reset();

rule("8. A SIMULATED UPSTREAM FAILURE, DOCUMENTED IN TELEMETRY");
process.env.COGNOS_MODEL = "bad-nonexistent-model";
process.env.COGNOS_FAST_MODEL = "bad-nonexistent-model";
const failed = await h.chat("Are you still there?");
out(`SSE frames      : ${failed.events.map(e => e.event).join(", ")}`);
out(`error frame     : ${j(failed.error)}`);
const failRec = await sql1("SELECT * FROM telemetry_runs WHERE id=$1", [failed.one("start")?.runId]);
out(`\ntelemetry_runs row:`);
out(j({
  id: failRec.id, status: failRec.status, error_message: failRec.error_message,
  failure_count: failRec.failure_count, failures: failRec.failures,
  latency_ms: failRec.latency_ms, cost_usd: failRec.cost_usd, ledger_events: failRec.ledger_events
}));
const failCalls = await h.sql("SELECT seq, purpose, stage, model, status, http_status, error_class, error_message, latency_ms FROM telemetry_model_calls WHERE run_id=$1 ORDER BY seq ASC", [failRec.id]);
out(`\ntelemetry_model_calls:`);
for (const c of failCalls) out(`  #${c.seq} ${String(c.purpose || c.stage).padEnd(14)} ${String(c.model).padEnd(24)} ${String(c.status).padEnd(12)} HTTP ${c.http_status ?? "—"} ${c.error_class ?? ""} ${String(c.error_message || "").slice(0, 70)}`);
out(`\nmemories after the failed run: ${(await sql1("SELECT count(*)::int AS n FROM memories")).n} (nothing fabricated)`);
process.env.COGNOS_MODEL = "openai/gpt-oss-20b";
process.env.COGNOS_FAST_MODEL = "openai/gpt-oss-20b";

rule("9. THE POLICY ENGINE REFUSES A LAW-VIOLATING ADAPTATION AND LOGS IT (15.5/15.6)");
const JUST = "charter.evidence: the council may only assert what it can verify from the exchange and its own measurements";
for (const proposal of [
  { action: "change_model", target: "gpt_5_4", justification: JUST, law_refs: ["charter.evidence"] },
  { action: "modify_law", target: "pin.no_auth", justification: JUST, law_refs: ["charter.dignity"] },
  { action: "register_operator", target: "temporal_reasoner", justification: JUST, law_refs: ["phase15.complexity_justification"] },
  { action: "schema_change", params: { sql: "DROP TABLE memories" }, justification: JUST, law_refs: ["pin.additive_schema"] },
  { action: "schema_change", params: { sql: "CREATE TABLE IF NOT EXISTS demo_notes (id TEXT PRIMARY KEY)" }, justification: JUST, law_refs: ["pin.additive_schema"], evidence: { note: "additive and idempotent" } }
]) {
  const res = await h.raw("/api/meta/adaptations", { method: "POST", body: { ...proposal, proposed_by: "demo" } });
  out(`\nPOST /api/meta/adaptations  ${proposal.action}${proposal.target ? ` -> ${proposal.target}` : ""}${proposal.params?.sql ? ` -> ${proposal.params.sql}` : ""}`);
  out(`  HTTP ${res.status}  decision=${res.json.decision}  applied=${res.json.applied}`);
  for (const r of res.json.reasons || []) out(`  refused by: ${r}`);
  if (res.json.ledger) out(`  improvement_ledger row ${res.json.ledger.id} (seq ${res.json.ledger.seq}) decision="${res.json.ledger.decision}" justification="${String(res.json.ledger.justification || "").slice(0, 60)}..."`);
}
out(`\nGET /api/meta/laws`);
const laws = await h.raw("/api/meta/laws");
out(`  version=${laws.json.version} count=${laws.json.count} runtimeModifiable=${laws.json.runtimeModifiable} immutability=${JSON.stringify(laws.json.immutabilityCheck)}`);
for (const l of laws.json.laws) out(`  [${l.layer}] ${l.id} — ${l.name}`);
out(`\nimprovement_ledger (${(await sql1("SELECT count(*)::int AS n FROM improvement_ledger")).n} rows):`);
const improvements = await h.sql("SELECT seq, ts_ms, action, target, decision, applied, reverted, law_refs, proposal FROM improvement_ledger ORDER BY seq ASC");
for (const im of improvements) {
  const subject = im.target || im.proposal?.params?.sql || im.proposal?.target || "(no target)";
  out(`  #${im.seq} ${at(im.ts_ms)} ${im.action.padEnd(20)} ${String(subject).slice(0, 46).padEnd(46)} ${im.decision.padEnd(9)} applied=${im.applied} laws=${JSON.stringify(im.law_refs)}`);
}

rule("10. WHAT THE STORE HOLDS AFTER THE DEMONSTRATION");
out(j(await h.raw("/api/knowledge/overview").then(r => r.json)));
out(`\nchange analytics (14.6):`);
const analytics = await h.raw("/api/knowledge/analytics?windowDays=30&bucketHours=6");
out(j({
  ledger_events: analytics.json.summary?.ledger?.events,
  events_per_day: analytics.json.churn?.events_per_day,
  stability: { index: analytics.json.stability?.average_stability_index, reading: analytics.json.stability?.reading },
  relationship_stability: analytics.json.relationship_stability?.average_stability_index,
  top_churn: (analytics.json.change_rate?.entities || []).slice(0, 5).map(e => ({ entity: `${e.entity_type}:${e.entity_id}`, changes: e.events, per_day: e.change_rate_per_day }))
}));
out(`\ntelemetry summary (15.1):`);
const summary = await h.raw("/api/meta/telemetry?summary=1");
out(j({ per_strategy: summary.json.summary, switch_analysis: { switch: summary.json.switchAnalysis?.switch, blockedBy: summary.json.switchAnalysis?.blockedBy, unmet: summary.json.switchAnalysis?.unmet } }));

await h.stop();
out("\ndemo complete.");
process.exit(0);
