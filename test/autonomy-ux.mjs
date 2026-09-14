#!/usr/bin/env node
// Phase 25 regressions — the autonomy UX work: hybrid enablement, the
// conversational resident designer, and the attention surface.
//
// Deterministic and local: no test here reaches a real model or the network.
// The properties being checked are the ones that make these features safe to
// ship at all:
//
//   * the switch is real — it takes effect without a restart, and every flip is
//     recorded, because a toggle that silently does nothing is worse than none;
//   * an operator's pin OUTRANKS the UI, and the UI says so instead of lying;
//   * without delegation the page hands over setup steps, not a dead end;
//   * the designer creates NOTHING — a draft is inert until an explicit click;
//   * the draft is clamped: skills that cannot run here are dropped AND NAMED,
//     budgets only ever go down, and a broken model answer is a sentence;
//   * "what does autonomy want from me?" is one bounded query.
//
// THREE HARNESSES, one process. server/autonomy/settings.js caches the stored
// switch at module scope and process.env survives bootHarness, so each harness
// boundary resets BOTH. Forgetting either leaks a switch from one harness into
// the next and every assertion after it becomes fiction.

import assert from "node:assert/strict";
import { autonomyConfig, DEFAULT_GOAL_BUDGET } from "../server/autonomy/config.js";
import {
  AUTONOMY_PIN_ENV, AUTONOMY_UI_CONTROL_ENV, describeSettings, envFlag,
  resetSettingsCache, effectiveEnabled
} from "../server/autonomy/settings.js";
import {
  DESIGNER_LIMITS, clampDraft, clampProposedUrl, describeDesignerError, emptyDraft,
  executableProbe, firstGoalScope, normalizeDraft
} from "../server/autonomy/designer.js";
import { SKILL_IDS, isSkillEnabled } from "../server/skills/index.js";
import { ARCHIVIST } from "../src/lib/archivist.js";
import { bootHarness } from "./harness.mjs";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log("autonomy-ux: pure checks (env semantics, clamps, failure sentences)");

// ------------------------------------------------------------------ pure units
await test("both switches are allow-lists: an empty value is OFF, not ON", async () => {
  const previous = {
    pin: process.env[AUTONOMY_PIN_ENV],
    ui: process.env[AUTONOMY_UI_CONTROL_ENV]
  };
  try {
    // `COGNOS_AUTONOMY_ENABLED=` is the most likely misconfiguration on a real
    // host. Under `value !== "false"` semantics it would turn autonomy ON.
    for (const value of ["", "0", "false", "no", "off", "maybe", "TRUE-ish"]) {
      process.env[AUTONOMY_PIN_ENV] = value;
      process.env[AUTONOMY_UI_CONTROL_ENV] = value;
      assert.equal(envFlag(AUTONOMY_PIN_ENV, false), false, `pin: "${value}" must not enable`);
      assert.equal(envFlag(AUTONOMY_UI_CONTROL_ENV, false), false, `delegation: "${value}" must not enable`);
      assert.equal(effectiveEnabled(), false, `"${value}" must leave the effective switch off`);
    }
    for (const value of ["1", "true", "TRUE", " yes ", "on", "enabled"]) {
      process.env[AUTONOMY_UI_CONTROL_ENV] = value;
      assert.equal(envFlag(AUTONOMY_UI_CONTROL_ENV, false), true, `delegation: "${value}" enables`);
    }
    // Delegation alone turns nothing on: it hands over the switch, it is not the switch.
    process.env[AUTONOMY_PIN_ENV] = "";
    process.env[AUTONOMY_UI_CONTROL_ENV] = "true";
    resetSettingsCache();
    assert.equal(effectiveEnabled(), false, "delegation without a stored value is still off");
    assert.equal(describeSettings().canToggle, true, "and it does make the toggle usable");
    assert.equal(describeSettings().source, "default-off");
    // The pin outranks everything, including an unloaded cache.
    process.env[AUTONOMY_PIN_ENV] = "true";
    assert.equal(effectiveEnabled(), true, "a pin is on whatever the cache says");
    assert.equal(describeSettings().canToggle, false, "and the UI may not override a pin");
    assert.equal(describeSettings().refusal.code, "pinned_by_operator");
    assert.match(describeSettings().refusal.message, /COGNOS_AUTONOMY_ENABLED/);
  } finally {
    resetSettingsCache();
    for (const [name, key] of [["pin", AUTONOMY_PIN_ENV], ["ui", AUTONOMY_UI_CONTROL_ENV]]) {
      if (previous[name] === undefined) delete process.env[key];
      else process.env[key] = previous[name];
    }
  }
});

await test("the clamp only ever narrows a draft: budgets down, skills intersected, fields bounded", async () => {
  const cfg = autonomyConfig();
  const out = clampDraft({
    name: "  Agenda\u0007 Watcher  ".repeat(20),
    purpose: "x".repeat(5000),
    brief: "y".repeat(50_000),
    skills: ["note.append", "note.append", "webhook.post", "web.search", "invented.skill", "note.promote.request"],
    heartbeat_minutes: 0.2,                       // 12 seconds — below the floor
    budget: { maxSteps: 5000, maxCostUsd: 99, maxNoticesPerDay: 1, maxRockets: 3 },
    first_goal: { title: "t", objective: "o" },
    scope: { effectsAllowed: ["external_write"] }, // a draft may never set scope
    tier: "T5"
  }, { config: cfg });

  const d = out.draft;
  assert.equal(d.name.length, DESIGNER_LIMITS.name, "the name is bounded, not trusted");
  assert.ok(!/[\u0000-\u001F]/.test(d.name), "control characters are out");
  assert.equal(d.purpose.length, DESIGNER_LIMITS.purpose);
  assert.equal(d.brief.length, DESIGNER_LIMITS.brief);
  assert.equal(d.complete, true);

  // Budgets clamp DOWN against the deployment default; lowering is allowed.
  assert.equal(d.budget.maxSteps, DEFAULT_GOAL_BUDGET.maxSteps, "5000 steps became the ceiling");
  assert.equal(d.budget.maxCostUsd, DEFAULT_GOAL_BUDGET.maxCostUsd, "$99 became the ceiling");
  assert.equal(d.budget.maxNoticesPerDay, 1, "a lower ceiling is kept — narrowing is the operator's right");
  assert.ok(out.adjustments.some(a => a.code === "clamped_down" && a.field === "budget.maxSteps"));
  assert.ok(out.adjustments.some(a => a.code === "clamped_down" && a.field === "budget.maxCostUsd"));
  assert.ok(out.adjustments.some(a => a.code === "ignored" && a.field === "budget.maxRockets"),
    "an unknown budget line is named, not silently accepted");

  // Skills: kept only what this deployment can run, and every omission is named.
  // note.promote.request is a T1 internal write, and it is STILL dropped: it
  // declares requiresRung 'residents', and that rung is off here. An internal
  // write is not automatically safe, and the clamp does not treat it as one.
  assert.deepEqual(d.skills, ["note.append"]);
  const droppedIds = out.droppedSkills.map(s => s.id);
  assert.ok(droppedIds.includes("webhook.post"), "T4 needs its rung");
  assert.ok(droppedIds.includes("web.search"), "T3 search needs its rung");
  assert.ok(droppedIds.includes("note.promote.request"), "a T1 skill gated on the residents rung is dropped too");
  assert.ok(droppedIds.includes("invented.skill"), "a skill that does not exist is named");
  const promote = out.droppedSkills.find(s => s.id === "note.promote.request");
  assert.equal(promote.reason, "not_executable_here");
  assert.equal(promote.tier, "T1");
  assert.match(promote.note, /residents rung/, "and the reason names the rung that is missing");
  for (const dropped of out.droppedSkills) {
    assert.ok(dropped.note && dropped.note.length > 20, `${dropped.id} comes with a reason in words`);
    assert.ok(dropped.reason, `${dropped.id} carries a machine reason too`);
  }
  assert.equal(new Set(d.skills).size, d.skills.length, "duplicates collapse");

  // The heartbeat floor, and the fields a draft may not set at all.
  assert.equal(d.heartbeatMs, DESIGNER_LIMITS.heartbeatMinMs, "12 seconds became the floor");
  assert.ok(out.ignoredFields.includes("scope"), "scope is named as ignored");
  assert.ok(out.ignoredFields.includes("tier"), "so is a tier");
  assert.equal(d.firstGoal.title, "t");
  assert.deepEqual(d.proposedUrls, []);
});

await test("proposed URLs are clamped, never a grant, and only ticked https pages become scope", async () => {
  assert.equal(clampProposedUrl("http://example.com/x"), null);
  assert.equal(clampProposedUrl("https://127.0.0.1/x"), null);
  assert.equal(clampProposedUrl("https://localhost/secret"), null);
  assert.equal(clampProposedUrl("https://user:pass@example.com/x"), null);
  assert.equal(clampProposedUrl("https://example.com/agenda"), "https://example.com/agenda");

  const cfg = autonomyConfig();
  const out = clampDraft({
    name: "Watcher", purpose: "p", brief: "b", skills: ["web.fetch", "note.append"],
    proposed_urls: ["https://example.com/agenda", "http://evil.example/x", "https://192.168.1.4/admin", "https://example.com/agenda"]
  }, { config: cfg, extraUrls: ["https://county.example/hearings"] });
  assert.deepEqual(out.draft.proposedUrls, ["https://example.com/agenda", "https://county.example/hearings"]);
  assert.ok(out.adjustments.some(a => a.code === "rejected_url"));

  const granted = firstGoalScope({ skills: ["web.fetch", "note.append"], grantUrls: ["https://example.com/agenda"] });
  assert.deepEqual(granted.effectsAllowed, ["notify", "external_read"]);
  assert.deepEqual(granted.urlAllowlist, ["https://example.com/agenda"]);
  const untouched = firstGoalScope({ skills: ["web.fetch"], grantUrls: [] });
  assert.deepEqual(untouched, { effectsAllowed: ["notify"] });
  const noFetch = firstGoalScope({ skills: ["note.append"], grantUrls: ["https://example.com/agenda"] });
  assert.deepEqual(noFetch, { effectsAllowed: ["notify"] });
});

await test("a draft survives the round trip through a browser: clamped shape re-clamps without losing data", async () => {
  const cfg = autonomyConfig();
  const first = clampDraft({
    name: "Ledger", purpose: "p", brief: "b", skills: ["note.append"],
    heartbeat_minutes: 60, budget: { maxSteps: 10 },
    first_goal: { title: "Nightly read", objective: "Read the ledger and note anything new." }
  }, { config: cfg }).draft;

  assert.equal(first.heartbeatMs, 3_600_000);
  assert.equal(first.firstGoal.title, "Nightly read");
  assert.equal(first.complete, true);

  // The create route receives THIS object back from the client. Clamping it as
  // if it were still the model's shape would silently drop the interval and the
  // first goal, and write a resident with defaults nobody read.
  const again = clampDraft(first, { config: cfg }).draft;
  assert.deepEqual(again, first, "normalizeDraft makes re-clamping idempotent");
  assert.equal(again.heartbeatMs, 3_600_000, "the interval survived");
  assert.equal(again.firstGoal?.title, "Nightly read", "and so did the first goal");
  assert.equal(normalizeDraft(first).heartbeat_minutes, 60);
  assert.equal(normalizeDraft(first).first_goal.title, "Nightly read");
  assert.equal("complete" in normalizeDraft(first), false, "bookkeeping is not reported as a smuggled field");
  assert.deepEqual(emptyDraft().skills, []);
  assert.deepEqual(emptyDraft().proposedUrls, []);
});

await test("the executability probe holds the global switch open and nothing else", async () => {
  const cfg = { ...autonomyConfig(), enabled: false };
  const probe = executableProbe(cfg);
  assert.equal(isSkillEnabled("note.append", cfg), false, "a frozen deployment runs nothing");
  assert.equal(isSkillEnabled("note.append", probe), true, "the probe asks the narrower design question");
  // Every rung, notice channel and unbuilt tier is still honoured by the probe.
  assert.equal(isSkillEnabled("webhook.post", probe), cfg.rung.externalWrites === true,
    "T4 still needs its rung flag even in a draft");
  assert.equal(isSkillEnabled("web.search", probe), cfg.rung.search === true, "and T3 search still needs its rung");
  assert.equal(isSkillEnabled("post.publish", probe), cfg.rung.irreversible === true,
    "and T5 still needs its rung — a draft cannot sneak an irreversible skill through");
  // Unset notice mode + the probe's hypothetical "on" → internal, so notice.emit
  // survives a draft made while frozen. Explicit none still drops it.
  const previousNotice = process.env.COGNOS_AUTONOMY_NOTICE_MODE;
  try {
    delete process.env.COGNOS_AUTONOMY_NOTICE_MODE;
    const open = executableProbe({ ...autonomyConfig(), enabled: false });
    assert.equal(isSkillEnabled("notice.emit", open), true, "unset notices become internal in a design probe");
    process.env.COGNOS_AUTONOMY_NOTICE_MODE = "none";
    const closed = executableProbe({ ...autonomyConfig(), enabled: false });
    assert.equal(isSkillEnabled("notice.emit", closed), false, "explicit none still drops T2");
  } finally {
    if (previousNotice === undefined) delete process.env.COGNOS_AUTONOMY_NOTICE_MODE;
    else process.env.COGNOS_AUTONOMY_NOTICE_MODE = previousNotice;
  }
  assert.equal(SKILL_IDS.some(id => isSkillEnabled(id, { ...probe, rung: { ...probe.rung, externalWrites: true } }) && id === "webhook.post"), true,
    "with the rung on, the probe would allow it — so the refusal is about this deployment");
});

await test("designer failures come back as sentences, never as raw configuration text", async () => {
  const cases = [
    [new Error("BLUESMINDS_API_KEY is not configured"), "no_model_key"],
    [new Error("The model provider returned malformed structured output."), "malformed_draft"],
    [Object.assign(new Error("The model provider returned a server error (HTTP 503)."), { code: "MODEL_PROVIDER_HTTP" }), "model_http"],
    [new Error("The model provider could not be reached after 2 attempts."), "model_unreachable"],
    [Object.assign(new Error("Request aborted"), { name: "AbortError" }), "timed_out"],
    [new Error("COGNOS_LLM_SERVICE_TIER must be one of: auto, default"), "misconfigured"],
    [new Error("something nobody anticipated"), "designer_failed"]
  ];
  for (const [error, code] of cases) {
    const described = describeDesignerError(error);
    assert.equal(described.code, code, `${error.message} -> ${code}`);
    assert.ok(described.message.length > 20, "the operator gets a sentence");
    assert.doesNotMatch(described.message, /<[^>]*>/, "no markup reaches the drawer");
  }
  // The no-key case is the one that used to surface as a 500 carrying the config
  // complaint. It has to name the fix, and it has to say nothing was created.
  const noKey = describeDesignerError(new Error("BLUESMINDS_API_KEY is not configured"));
  assert.match(noKey.message, /nothing was created/i);
  assert.match(noKey.message, /BLUESMINDS_API_KEY/);
  // A secret in the thrown message never survives into the sentence.
  const leaky = describeDesignerError(Object.assign(
    new Error("upstream rejected sk-abcdefghijklmnop0123456789 while posting"),
    { code: "MODEL_PROVIDER_HTTP" }));
  assert.ok(!leaky.message.includes("sk-abcdefghijklmnop"), "the key is redacted");
});

// ------------------------------------------------- harness A: the switch is real
// Delegation on, pin off. This is the deployment where the UI toggle exists.
const A = await bootHarness({
  COGNOS_AUTONOMY_UI_CONTROL: "true",
  COGNOS_AUTONOMY_ENABLED: null
});
resetSettingsCache();      // a previous harness in this process may have cached a value

try {
  console.log("autonomy-ux: harness A — delegated switch, designer, attention");

  await test("status reports the switch honestly: off, delegated, and usable from here", async () => {
    const status = await A.raw("/api/autonomy/status");
    assert.equal(status.status, 200);
    assert.equal(status.json.enabled, false, "delegation is not enablement");
    assert.equal(status.json.uiControl, true);
    assert.equal(status.json.pinned, false);
    assert.equal(status.json.canToggleFromUi, true);
    assert.equal(status.json.toggleRefusal, null);
    assert.equal(status.json.enabledSource, "default-off");
    assert.equal(status.json.defaultOff, true, "the resting state is still a constant, not a reading");
    assert.match(status.json.note, /delegated to the UI/);

    const settings = await A.raw("/api/autonomy/settings");
    assert.equal(settings.status, 200);
    assert.equal(settings.json.canToggle, true);
    assert.equal(settings.json.stored.loaded, true, "the row was read, not assumed");
    assert.equal(settings.json.stored.enabled, false);
  });

  await test("the toggle turns autonomy on with no restart, and the loop notices", async () => {
    const before = await A.raw("/api/autonomy/tick", { method: "POST" });
    assert.equal(before.json.frozen, true, "off means the tick does nothing");

    const on = await A.raw("/api/autonomy/settings", { method: "POST", body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.equal(on.json.enabled, true);
    assert.equal(on.json.changed, true);
    assert.equal(on.json.settings.source, "ui");
    assert.ok(on.json.settings.stored.updatedAtMs > 0);

    // Effective immediately: the same process, the same config call sites.
    const status = await A.raw("/api/autonomy/status?fresh=1");
    assert.equal(status.json.enabled, true);
    assert.equal(status.json.enabledSource, "ui");
    assert.equal(autonomyConfig().enabled, true, "the synchronous config agrees with the HTTP response");

    const after = await A.raw("/api/autonomy/tick", { method: "POST" });
    assert.equal(after.json.frozen, false, "the loop ran a slice instead of reporting frozen");
    assert.ok("goalsClaimed" in after.json);
  });

  await test("every flip is recorded in the audit trail, as a transition", async () => {
    const rows = await A.sql(
      `SELECT ts_ms, detail FROM workspace_audit WHERE action='autonomy.enabled' ORDER BY ts_ms ASC`);
    assert.equal(rows.length, 1, "one flip so far, one row");
    assert.equal(rows[0].detail.from, false);
    assert.equal(rows[0].detail.to, true);
    assert.equal(rows[0].detail.via, "ui");
    assert.ok(rows[0].detail.updatedBy, "the row says who did it");

    const off = await A.raw("/api/autonomy/settings", { method: "POST", body: { enabled: false } });
    assert.equal(off.json.enabled, false);
    const after = await A.sql(
      `SELECT detail FROM workspace_audit WHERE action='autonomy.enabled' ORDER BY ts_ms ASC`);
    assert.equal(after.length, 2, "the second flip appended, it did not overwrite");
    assert.equal(after[1].detail.from, true);
    assert.equal(after[1].detail.to, false);

    const settings = await A.raw("/api/autonomy/settings");
    assert.equal(settings.json.flips.length, 2, "and the switch surface can show its own history");
    assert.equal(settings.json.flips[0].enabled, false, "newest first");

    const tick = await A.raw("/api/autonomy/tick", { method: "POST" });
    assert.equal(tick.json.frozen, true, "off means off again — no restart, no stale cache");
  });

  await test("the designer drafts a whole resident and creates nothing", async () => {
    A.model.reset();
    const before = (await A.sql(`SELECT COUNT(*)::int AS n FROM autonomy_agents`))[0].n;

    const turn = await A.raw("/api/autonomy/designer", {
      method: "POST",
      body: { messages: [{ role: "user", content: "Watch the county agenda page each morning and tell me when a hearing is added." }] }
    });
    assert.equal(turn.status, 200);
    assert.ok(turn.json.reply.length > 10, "there is a design note");
    assert.equal(turn.json.draft.name, "Agenda Watcher");
    assert.equal(turn.json.draft.complete, true);
    assert.deepEqual(turn.json.draft.skills, ["web.fetch", "note.append"],
      "web.fetch is executable here — it is governed by the per-goal URL allowlist, not by a rung");
    assert.equal(turn.json.draft.heartbeatMs, 24 * 60 * 60 * 1000, "every morning is 1440 minutes");
    assert.equal(turn.json.draft.budget.maxSteps, 200, "a proposed lower ceiling is kept");
    assert.equal(turn.json.draft.firstGoal.title, "Watch this week's agenda");
    assert.deepEqual(turn.json.draft.proposedUrls, ["https://example.com/agenda"]);
    assert.equal(turn.json.frozen, true, "the drawer is told autonomy is off");
    assert.match(turn.json.note, /nothing can be created until autonomy is on/i);

    const after = (await A.sql(`SELECT COUNT(*)::int AS n FROM autonomy_agents`))[0].n;
    assert.equal(after, before, "a draft is inert: no resident row exists");

    // The prompt the model actually received, so the clamps are not the only guard.
    const request = A.model.requests.filter(r => r.role === "residentDesigner").pop();
    assert.ok(request, "the designer called the model");
    assert.match(request.content, /COGNOS Resident Designer/);
    assert.match(request.content, /HARD RULES/);
    assert.match(request.content, /cannot create anything/);
    assert.match(request.content, /webhook\.post/);
    assert.ok(request.responseFormat?.json_schema?.schema.required.includes("resident"));
  });

  await test("a draft that overreaches is narrowed out loud — every omission is named", async () => {
    A.model.state.residentDraft = {
      reply: "Here is a resident that can also post to a webhook and search the web.",
      questions: [],
      resident: {
        name: "Overeager",
        purpose: "Do everything",
        brief: "Post to the webhook, search the web, emit a notice, and promote your own notes.",
        skills: ["webhook.post", "web.search", "notice.emit", "note.append", "money.send"],
        heartbeat_minutes: 0.2,
        budget: { maxSteps: 100000, maxCostUsd: 500 },
        first_goal: { title: "Everything", objective: "All of it, immediately." }
      }
    };
    const turn = await A.raw("/api/autonomy/designer", {
      method: "POST",
      body: { messages: [{ role: "user", content: "Give it every skill it can have and a big budget." }] }
    });
    assert.equal(turn.status, 200);
    const d = turn.json.draft;
    assert.deepEqual(d.skills, ["notice.emit", "note.append"],
      "notice.emit survives a frozen draft when the notice mode is unset — it will be executable once autonomy is on");
    assert.equal(d.budget.maxSteps, DEFAULT_GOAL_BUDGET.maxSteps, "the ceiling did not move up");
    assert.equal(d.budget.maxCostUsd, DEFAULT_GOAL_BUDGET.maxCostUsd);
    assert.equal(d.heartbeatMs, DESIGNER_LIMITS.heartbeatMinMs);

    const dropped = turn.json.droppedSkills.map(x => x.id);
    for (const id of ["webhook.post", "web.search", "money.send"]) {
      assert.ok(dropped.includes(id), `${id} is named as dropped`);
    }
    assert.equal(dropped.includes("notice.emit"), false, "T2 is not dropped for an unset channel");
    const webhook = turn.json.droppedSkills.find(x => x.id === "webhook.post");
    assert.equal(webhook.reason, "not_executable_here");
    assert.equal(webhook.tier, "T4");
    assert.match(webhook.note, /externalWrites rung|switched off/, "the reason is specific");
    const invented = turn.json.droppedSkills.find(x => x.id === "money.send");
    assert.equal(invented.reason, "no_such_skill");
    assert.match(invented.note, /registry is code/);
    assert.ok(turn.json.adjustments.some(a => a.code === "clamped_down"), "the budget reductions are reported too");

    const stillNothing = (await A.sql(`SELECT COUNT(*)::int AS n FROM autonomy_agents`))[0].n;
    assert.equal(stillNothing, 0, "an overreaching draft still created nothing");
    A.model.reset();
  });

  await test("the catalogue reports an enabled rung as available, and an off one as off", async () => {
    // The prompt used to tag every rung-gated skill as "NOT available here"
    // whenever it merely *declared* a rung. clampSkills still used isSkillEnabled,
    // so the lie never showed up in the draft the tests already checked — it
    // only showed up as the model quietly refusing to propose a design the
    // operator was entitled to. Flip the search rung and assert both sides.
    const previous = process.env.COGNOS_AUTONOMY_SEARCH;
    try {
      A.model.reset();
      A.model.state.residentDraft = {
        reply: "A watcher that searches and notes.",
        questions: [],
        resident: {
          name: "Searcher",
          purpose: "Search",
          brief: "Search the web and note what you find.",
          skills: ["web.search", "note.append", "webhook.post"],
          heartbeat_minutes: 60
        }
      };

      process.env.COGNOS_AUTONOMY_SEARCH = "false";
      const off = await A.raw("/api/autonomy/designer", {
        method: "POST",
        body: { messages: [{ role: "user", content: "Give it search." }] }
      });
      assert.equal(off.status, 200);
      assert.deepEqual(off.json.draft.skills, ["note.append"]);
      assert.ok(off.json.droppedSkills.some(d => d.id === "web.search"));
      const offReq = A.model.requests.filter(r => r.role === "residentDesigner").pop();
      const offSearch = (offReq.content.split("\n").find(l => l.includes("web.search")) || "");
      assert.match(offSearch, /needs the search rung, which is off here/);
      assert.match(offSearch, /NOT executable/);

      process.env.COGNOS_AUTONOMY_SEARCH = "true";
      const on = await A.raw("/api/autonomy/designer", {
        method: "POST",
        body: { messages: [{ role: "user", content: "Give it search." }] }
      });
      assert.equal(on.status, 200);
      assert.deepEqual(on.json.draft.skills, ["web.search", "note.append"]);
      assert.ok(!on.json.droppedSkills.some(d => d.id === "web.search"));
      const onReq = A.model.requests.filter(r => r.role === "residentDesigner").pop();
      const onSearch = (onReq.content.split("\n").find(l => l.includes("web.search")) || "");
      assert.match(onSearch, /search rung is on/);
      assert.doesNotMatch(onSearch, /NOT executable/);
      const webhookLine = (onReq.content.split("\n").find(l => l.includes("webhook.post")) || "");
      assert.match(webhookLine, /NOT executable/);
      assert.match(webhookLine, /externalWrites rung, which is off here/);
    } finally {
      if (previous === undefined) delete process.env.COGNOS_AUTONOMY_SEARCH;
      else process.env.COGNOS_AUTONOMY_SEARCH = previous;
      A.model.reset();
    }
  });

  await test("a broken model answer is a friendly failure, and the previous draft survives", async () => {
    A.model.state.malformed = { roles: ["residentDesigner"], content: "", finishReason: "length" };
    const turn = await A.raw("/api/autonomy/designer", {
      method: "POST",
      body: { messages: [{ role: "user", content: "Now make it hourly." }] }
    });
    assert.equal(turn.status, 502, "a provider failure is a 502, not a 500 with a stack trace");
    assert.equal(turn.json.code, "malformed_draft");
    assert.match(turn.json.error, /could not read/i);
    assert.match(turn.json.error, /nothing changed/i);
    assert.ok(!/<[^>]*>/.test(turn.json.error), "no markup, no raw provider body");
    assert.equal(turn.json.draft.name, "", "the echoed draft is the empty one the client sent");

    // A model that answers with prose where a draft belongs is the same case.
    A.model.state.malformed = { roles: ["residentDesigner"], content: "{\"reply\":\"sure!\"}", finishReason: "stop" };
    const noResident = await A.raw("/api/autonomy/designer", {
      method: "POST",
      body: { messages: [{ role: "user", content: "hello" }] }
    });
    assert.equal(noResident.status, 502);
    assert.equal(noResident.json.code, "malformed_draft");

    // And an empty conversation is the operator's mistake, answered as a 400.
    A.model.reset();
    const empty = await A.raw("/api/autonomy/designer", { method: "POST", body: { messages: [] } });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.code, "empty_conversation");
    assert.match(empty.json.error, /describe the resident/i);

    assert.equal((await A.sql(`SELECT COUNT(*)::int AS n FROM autonomy_agents`))[0].n, 0);
  });

  await test("creating from a draft while autonomy is off is refused with the way out", async () => {
    A.model.reset();
    const turn = await A.raw("/api/autonomy/designer", {
      method: "POST",
      body: { messages: [{ role: "user", content: "Watch the agenda page daily." }] }
    });
    const draft = turn.json.draft;

    const create = await A.raw("/api/autonomy/designer/create", {
      method: "POST", body: { draft, create_first_goal: true }
    });
    assert.equal(create.status, 409);
    assert.equal(create.json.code, "autonomy_disabled");
    assert.equal(create.json.canToggleFromUi, true);
    assert.match(create.json.error, /turn it on with the switch/i, "the refusal says what to do here");
    assert.equal(create.json.draft.name, draft.name, "the draft comes back, so the click cost nothing");
    assert.equal((await A.sql(`SELECT COUNT(*)::int AS n FROM autonomy_agents`))[0].n, 0);

    // A draft with no name cannot be created even once autonomy is on.
    await A.raw("/api/autonomy/settings", { method: "POST", body: { enabled: true } });
    const nameless = await A.raw("/api/autonomy/designer/create", {
      method: "POST", body: { draft: { ...draft, name: "" } }
    });
    assert.equal(nameless.status, 400);
    assert.equal(nameless.json.code, "incomplete_draft");
    assert.equal((await A.sql(`SELECT COUNT(*)::int AS n FROM autonomy_agents`))[0].n, 0);
  });

  await test("the explicit click creates the resident, and its first goal waits for authorization", async () => {
    const create = await A.raw("/api/autonomy/designer/create", {
      method: "POST",
      body: {
        draft: {
          name: "Agenda Watcher", slug: "agenda-watcher",
          purpose: "Watch one page each morning.",
          brief: "Fetch the allowlisted agenda page each morning and note what changed.",
          skills: ["web.fetch", "note.append", "webhook.post"],  // a browser could send anything
          heartbeatMs: 3_600_000,
          budget: { ...DEFAULT_GOAL_BUDGET, maxSteps: 999_999, maxCostUsd: 42 },
          firstGoal: { title: "Watch this week", objective: "Read the page each morning." },
          proposedUrls: ["https://example.com/agenda", "http://127.0.0.1/x"],
          complete: true
        },
        create_first_goal: true,
        grant_urls: ["https://example.com/agenda", "http://127.0.0.1/x", "https://evil.example/not-proposed"]
      }
    });
    assert.equal(create.status, 201);
    assert.equal(create.json.agent.name, "Agenda Watcher");
    assert.equal(create.json.agent.slug, "agenda-watcher");
    // Re-clamped server-side: the row is narrower than the request, not equal to it.
    const stored = await A.sql(`SELECT skill_allowlist, default_budgets, heartbeat_interval_ms FROM autonomy_agents WHERE id=$1`,
      [create.json.agent.id]);
    const skills = typeof stored[0].skill_allowlist === "string"
      ? JSON.parse(stored[0].skill_allowlist) : stored[0].skill_allowlist;
    assert.deepEqual(skills, ["web.fetch", "note.append"], "webhook.post never reached the row");
    const budgets = typeof stored[0].default_budgets === "string"
      ? JSON.parse(stored[0].default_budgets) : stored[0].default_budgets;
    assert.equal(budgets.maxSteps, DEFAULT_GOAL_BUDGET.maxSteps, "the ceiling was re-clamped on the way in");
    assert.equal(budgets.maxCostUsd, DEFAULT_GOAL_BUDGET.maxCostUsd);
    assert.equal(Number(stored[0].heartbeat_interval_ms), 3_600_000, "the interval survived the round trip");
    assert.ok(create.json.droppedSkills.some(d => d.id === "webhook.post"), "and the operator is told");

    // The first goal exists and is waiting — it does no work until authorized.
    assert.ok(create.json.goal, "the goal was created");
    assert.equal(create.json.goal.status, "awaiting_authorization");
    assert.deepEqual(create.json.goal.scope.effectsAllowed, ["notify", "external_read"]);
    assert.deepEqual(create.json.goal.scope.urlAllowlist, ["https://example.com/agenda"],
      "only the operator-ticked https proposal became the allowlist");
    assert.equal(create.json.status, "awaiting_authorization");
    assert.ok(create.json.hashes.scopeSha256, "the authorization hashes are ready");
    const events = await A.sql(`SELECT event_type, detail FROM goal_events WHERE goal_id=$1 ORDER BY seq ASC`,
      [create.json.goal.id]);
    assert.equal(events[0].event_type, "goal_created");
    assert.equal(events[0].detail.origin, "designer", "the audit trail says how it was born");

    // A conversation was opened for the resident, as the manual form does.
    assert.ok(create.json.agent.conversation_id, "the resident has its own conversation");

    // It really does no work: the tick claims it and parks it at the barrier.
    const tick = await A.raw("/api/autonomy/tick", { method: "POST" });
    assert.equal(tick.json.frozen, false);
    const steps = await A.sql(`SELECT COUNT(*)::int AS n FROM goal_steps WHERE goal_id=$1`, [create.json.goal.id]);
    assert.equal(steps[0].n, 0, "an unauthorized goal executed nothing");

    const designed = await A.sql(`SELECT detail FROM workspace_audit WHERE action='autonomy.resident_designed'`);
    assert.equal(designed.length, 1, "the creation is in the audit trail too");
    assert.deepEqual(designed[0].detail.droppedSkills, ["webhook.post"]);

    // Designing the SAME name again is likelier from a conversation than from a
    // form — the model proposes sensible names, and "Agenda Watcher" is sensible
    // twice. It has to be a refusal in words, not a unique-index 500.
    const again = await A.raw("/api/autonomy/designer/create", {
      method: "POST",
      body: { draft: { name: "Agenda Watcher", slug: "agenda-watcher", brief: "b", skills: [], complete: true } }
    });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "slug_taken");
    assert.match(again.json.error, /already exists/);
    assert.match(again.json.error, /different name|edit that resident/, "and it says what to do instead");
    assert.equal(again.json.draft.name, "Agenda Watcher", "the draft comes back, so the click cost nothing");
    assert.equal((await A.sql(`SELECT COUNT(*)::int AS n FROM autonomy_agents`))[0].n, 1,
      "the refused second create wrote no row");
  });

  await test("the attention panel answers 'what does autonomy want from me?' in one query", async () => {
    const attention = await A.raw("/api/autonomy/attention");
    assert.equal(attention.status, 200);
    assert.equal(attention.json.needsAttention, true);
    assert.ok(attention.json.total >= 1);

    const kinds = attention.json.groups.map(g => g.kind);
    for (const kind of ["awaiting_authorization", "staged_effect", "unread_notice", "parked_goal", "open_promotion"]) {
      assert.ok(kinds.includes(kind), `${kind} is one of the things it looks for`);
    }
    const waiting = attention.json.groups.find(g => g.kind === "awaiting_authorization");
    assert.equal(waiting.tab, "goals", "each group names the tab that resolves it");
    assert.equal(waiting.count, 1);
    assert.equal(waiting.truncated, false);
    assert.equal(waiting.rows[0].title, "Watch this week");
    assert.ok(waiting.label.length > 5 && waiting.hint.length > 10, "in words, not codes");

    // Count is the full total, not the page size. A second waiting goal plus
    // ?limit=1 must still say there are two things waiting — otherwise the
    // panel looks empty after the first row.
    const wsId = (await A.sql(`SELECT id FROM workspaces LIMIT 1`))[0].id;
    const agentId = (await A.sql(`SELECT id FROM autonomy_agents LIMIT 1`))[0].id;
    await A.sql(
      `INSERT INTO autonomy_goals (id, workspace_id, agent_id, title, objective, status, scope, budget, spent, created_date, updated_date)
       VALUES ($1, $2, $3, 'Second wait', 'Also waiting.', 'awaiting_authorization', '{}', '{}', '{}', NOW(), NOW())`,
      [`goal_attn_${Date.now()}`, wsId, agentId]
    );
    const bounded = await A.raw("/api/autonomy/attention?limit=1");
    assert.ok(bounded.json.groups.every(g => g.rows.length <= 1));
    const boundedWaiting = bounded.json.groups.find(g => g.kind === "awaiting_authorization");
    assert.equal(boundedWaiting.rows.length, 1);
    assert.equal(boundedWaiting.count, 2, "count is independent of the page size");
    assert.equal(boundedWaiting.truncated, true);

    // Resolving the items empties the panel: decline every waiting goal.
    const waitingIds = (await A.sql(
      `SELECT id FROM autonomy_goals WHERE status='awaiting_authorization'`
    )).map(r => r.id);
    for (const goalId of waitingIds) {
      await A.raw(`/api/autonomy/goals/${goalId}/decision`, { method: "POST", body: { decision: "decline", reason: "test" } });
    }
    const after = await A.raw("/api/autonomy/attention");
    const stillWaiting = after.json.groups.find(g => g.kind === "awaiting_authorization");
    assert.equal(stillWaiting.count, 0, "a declined goal stops waiting on you");
  });

  await test("one-click Archivist uses the existing agent and goal writes and does not authorize", async () => {
    const listed = await A.raw("/api/autonomy/agents");
    let resident = listed.json.find(r => r.slug === ARCHIVIST.slug);
    if (!resident) {
      const made = await A.raw("/api/autonomy/agents", {
        method: "POST",
        body: {
          name: ARCHIVIST.name, slug: ARCHIVIST.slug, purpose: ARCHIVIST.purpose,
          brief: ARCHIVIST.brief, skill_allowlist: ARCHIVIST.skill_allowlist,
          heartbeat_interval_ms: ARCHIVIST.heartbeat_interval_ms, enabled: true
        }
      });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      resident = made.json;
    }
    assert.deepEqual(resident.skill_allowlist, ["belief.search", "note.append"]);
    const goals = await A.raw("/api/autonomy/goals");
    let goal = goals.json.find(g => g.title === ARCHIVIST.goalTitle && g.agent_id === resident.id);
    if (!goal) {
      const made = await A.raw("/api/autonomy/goals", {
        method: "POST",
        body: { title: ARCHIVIST.goalTitle, objective: ARCHIVIST.goalObjective, agent_id: resident.id }
      });
      assert.equal(made.status, 201);
      goal = made.json.goal;
    }
    assert.equal(goal.status, "awaiting_authorization");
    const auths = await A.sql(`SELECT COUNT(*)::int AS n FROM goal_authorizations WHERE goal_id=$1`, [goal.id]);
    assert.equal(auths[0].n, 0, "seeding does not authorize");
    const again = await A.raw("/api/autonomy/goals");
    const copies = again.json.filter(g => g.title === ARCHIVIST.goalTitle && g.agent_id === resident.id);
    assert.equal(copies.length, 1, "the seed is idempotent at the UI layer");
  });
} finally {
  await A.stop();
}

// ------------------------------------------- harness B: nobody delegated the switch
// The module cache and process.env both outlive a harness, so both are reset.
resetSettingsCache();
const B = await bootHarness({
  COGNOS_AUTONOMY_UI_CONTROL: null,
  COGNOS_AUTONOMY_ENABLED: null
});
resetSettingsCache();

try {
  console.log("autonomy-ux: harness B — no delegation, so the page must not be a dead end");

  await test("without delegation the toggle is refused, and the refusal carries the setup", async () => {
    const status = await B.raw("/api/autonomy/status");
    assert.equal(status.json.enabled, false);
    assert.equal(status.json.uiControl, false);
    assert.equal(status.json.canToggleFromUi, false);
    assert.equal(status.json.toggleRefusal.code, "not_delegated");
    assert.match(status.json.toggleRefusal.message, /COGNOS_AUTONOMY_UI_CONTROL/);
    assert.match(status.json.note, /COGNOS_AUTONOMY_ENABLED/, "the status names both variables");

    const attempt = await B.raw("/api/autonomy/settings", { method: "POST", body: { enabled: true } });
    assert.equal(attempt.status, 409, "the UI cannot grant itself a switch nobody delegated");
    assert.equal(attempt.json.code, "not_delegated");
    assert.match(attempt.json.error, /COGNOS_AUTONOMY_UI_CONTROL=true/);
    assert.match(attempt.json.error, /restart/);
    assert.equal(attempt.json.settings.enabled, false, "and the truth is returned with the refusal");

    const stillOff = await B.raw("/api/autonomy/status?fresh=1");
    assert.equal(stillOff.json.enabled, false);
    assert.equal((await B.sql(`SELECT COUNT(*)::int AS n FROM autonomy_settings`))[0].n, 0,
      "a refused flip wrote no row");

    // The rest of the surface is honest about the same thing, in actionable words.
    const create = await B.raw("/api/autonomy/agents", { method: "POST", body: { name: "Nope", brief: "b" } });
    assert.equal(create.status, 409);
    assert.equal(create.json.code, "autonomy_disabled");
    assert.match(create.json.error, /COGNOS_AUTONOMY_ENABLED=true/);
    assert.match(create.json.error, /COGNOS_AUTONOMY_UI_CONTROL=true/);
    assert.ok(!/Autonomy is disabled \(COGNOS_AUTONOMY_ENABLED\)\./.test(create.json.error),
      "the old dead-end message is gone");

    // The designer still works — describing a resident is how you find out what
    // you want to ask an operator for.
    B.model.reset();
    const turn = await B.raw("/api/autonomy/designer", {
      method: "POST", body: { messages: [{ role: "user", content: "Watch the agenda page daily." }] }
    });
    assert.equal(turn.status, 200);
    assert.equal(turn.json.draft.complete, true);
    assert.equal(turn.json.frozen, true);
    const refusedCreate = await B.raw("/api/autonomy/designer/create", {
      method: "POST", body: { draft: turn.json.draft }
    });
    assert.equal(refusedCreate.status, 409);
    assert.equal(refusedCreate.json.canToggleFromUi, false);
    assert.match(refusedCreate.json.error, /an operator has to enable it/i);
    assert.match(refusedCreate.json.error, /your draft is kept/i);
  });
} finally {
  await B.stop();
}

// --------------------------------------------------- harness C: the pin outranks all
resetSettingsCache();
const C = await bootHarness({
  COGNOS_AUTONOMY_ENABLED: "true",
  COGNOS_AUTONOMY_UI_CONTROL: "true",
  COGNOS_AUTONOMY_NOTICE_MODE: "internal"
});
resetSettingsCache();

try {
  console.log("autonomy-ux: harness C — an operator pin outranks the UI");

  await test("a pin is on whatever the stored row says, and the UI cannot turn it off", async () => {
    const status = await C.raw("/api/autonomy/status");
    assert.equal(status.json.enabled, true);
    assert.equal(status.json.pinned, true);
    assert.equal(status.json.uiControl, true, "delegation can coexist with a pin");
    assert.equal(status.json.canToggleFromUi, false, "but it grants nothing while the pin holds");
    assert.equal(status.json.enabledSource, "env-pin");
    assert.equal(status.json.toggleRefusal.code, "pinned_by_operator");
    assert.match(status.json.note, /pinned this on/);

    const off = await C.raw("/api/autonomy/settings", { method: "POST", body: { enabled: false } });
    assert.equal(off.status, 409);
    assert.equal(off.json.code, "pinned_by_operator");
    assert.match(off.json.error, /cannot override a pin/);
    assert.match(off.json.error, /COGNOS_AUTONOMY_ENABLED/);
    assert.equal(off.json.settings.enabled, true, "the refusal reports the truth: still on");

    // Even a row written by something other than the route cannot turn a pinned
    // deployment off: precedence is resolved in code, not by the table.
    const ws = (await C.sql(`SELECT id FROM workspaces LIMIT 1`))[0].id;
    await C.sql(`INSERT INTO autonomy_settings (workspace_id, enabled, source, updated_ms)
                 VALUES ($1, FALSE, 'ui', $2)
                 ON CONFLICT (workspace_id) DO UPDATE SET enabled = FALSE`, [ws, Date.now()]);
    const stillOn = await C.raw("/api/autonomy/status?fresh=1");
    assert.equal(stillOn.json.enabled, true, "a stored false cannot beat a pinned true");
    assert.equal(stillOn.json.settings.stored.enabled, false, "the row is reported as it is");
    assert.equal(stillOn.json.settings.stored.stale, false);

    // And the pinned deployment genuinely runs: the tick is not frozen.
    const tick = await C.raw("/api/autonomy/tick", { method: "POST" });
    assert.equal(tick.json.frozen, false);
    assert.equal(autonomyConfig().enabled, true);
  });
} finally {
  await C.stop();
  resetSettingsCache();
  delete process.env[AUTONOMY_PIN_ENV];
  delete process.env[AUTONOMY_UI_CONTROL_ENV];
  delete process.env.COGNOS_AUTONOMY_NOTICE_MODE;
}

console.log(`autonomy-ux: ${passed} test(s) passed`);
