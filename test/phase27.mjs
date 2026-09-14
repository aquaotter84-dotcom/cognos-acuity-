// Phase 27 — the key path: granting a webhook destination into a goal's scope.
//
// THE CLAIM UNDER TEST. The shadow corpus is earned only by attempts aimed at a
// granted destination (`corpus_aimed`, and would_release verdicts the Governor
// can only give a granted effect). Until now no goal could ever carry that
// grant: the manual goal form sent no scope at all, and the designer's
// firstGoalScope granted notify + optional external_read — read pages only.
// The lock was built (destination judgments, the aimed-corpus gate); the wire
// from an operator's hand to a goal's scope was not.
//
// What this suite proves:
//
//   * validateDestinationGrant refuses, with sentences, every destination the
//     adapter would refuse — at the one moment it can still be fixed, since
//     scope is immutable after creation (pin.goal_scope_immutable);
//   * POST /api/autonomy/goals welds a good grant into scope and refuses a bad
//     one with 400 and every entry named — nothing created;
//   * the designer's create applies grant_destinations to the first goal's
//     scope, only with webhook.post surviving the clamp, and refuses (grant /
//     no skill / no goal) with the draft untouched;
//   * END TO END: a goal granted the approved destination actually fills the
//     corpus aimed at it — while the lock holds: the same attempt WITHOUT the
//     grant is still refused by name. Wiring the key path loosened nothing.

import assert from "node:assert/strict";
import { bootHarness } from "./harness.mjs";
import { validateDestinationGrant } from "../server/autonomy/scopeUrl.js";
import { firstGoalScope } from "../server/autonomy/designer.js";
import { scopeHashes } from "../server/autonomy/authorize.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// ----------------------------------------------------------------- fixtures
const APPROVED = "https://hooks-phase27.example.com/cognos";
process.env.COGNOS_AUTONOMY_LIVE_DESTINATION = APPROVED;

// ---------------------------------------------------- pure: the grant gate
await test("validateDestinationGrant accepts exact URLs and host entries, refusing what the adapter refuses", async () => {
  const good = validateDestinationGrant([
    "https://hooks.example.com/cognos#frag",     // fragment dropped, stored as matched
    "https://hooks.example.com/cognos",          // a duplicate of the normalized first
    "hooks.example.com",                          // host entry — §4.7.1 allows prefix grants
    "hooks.example.com/cognos/incoming"           // host + path prefix
  ]);
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  assert.deepEqual(good.destinations, [
    "https://hooks.example.com/cognos",
    "hooks.example.com",
    "hooks.example.com/cognos/incoming"
  ]);

  for (const [bad, rule] of [
    ["http://hooks.example.com/x", /must be https/],
    ["https://127.0.0.1/x", /literal IP/],
    ["https://user:pass@hooks.example.com/x", /credentials/],
    ["https://hooks.example.com:8443/x", /port 443/],
    ["https://localhost/x", /local or reserved/],
    ["10.0.0.4/hook", /literal IP/],
    ["not a url at all", /whitespace|not a host/],
    [42, /non-empty string/],
    ["", /non-empty string/]
  ]) {
    const check = validateDestinationGrant([bad]);
    assert.equal(check.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
    assert.match(check.errors[0], new RegExp(rule.source, "i"), `${JSON.stringify(bad)} — ${check.errors[0]}`);
    assert.deepEqual(check.destinations, []);
  }

  // Both a refusal and the keeps are reported, so one bad entry cannot silently
  // sink the whole grant nor ride along with it.
  const mixed = validateDestinationGrant(["https://hooks.example.com/cognos", "http://evil.example.com/x"]);
  assert.equal(mixed.ok, false);
  assert.deepEqual(mixed.destinations, ["https://hooks.example.com/cognos"]);
  assert.equal(mixed.errors.length, 1);
});

await test("firstGoalScope: a destination grant only lands with webhook.post, and reads never widen into it", async () => {
  const writeGranted = firstGoalScope({
    skills: ["web.fetch", "webhook.post"],
    grantUrls: ["https://example.com/agenda"],
    webhookDestinations: [APPROVED]
  });
  assert.deepEqual(writeGranted.effectsAllowed, [
    "notify", "external_read", { effect: "webhook.post", destinations: [APPROVED] }
  ]);
  assert.deepEqual(writeGranted.urlAllowlist, ["https://example.com/agenda"]);

  // The skill fell out of the clamp (rung off, or never asked): the grant
  // falls with it. Dead keys are never written.
  const keylessHand = firstGoalScope({
    skills: ["web.fetch"], webhookDestinations: [APPROVED]
  });
  assert.deepEqual(keylessHand, { effectsAllowed: ["notify"] },
    "no webhook.post in the allowlist, no destination grant in scope");

  // Reads stay reads: proposed read URLs never become write destinations — and
  // a write grant without reads is complete on its own.
  const readOnly = firstGoalScope({ skills: ["webhook.post"], grantUrls: ["https://example.com/agenda"] });
  assert.deepEqual(readOnly, { effectsAllowed: ["notify"] },
    "proposed read URLs alone never become a destination grant");
  assert.deepEqual(firstGoalScope({ skills: ["webhook.post"], webhookDestinations: [APPROVED] }).effectsAllowed, [
    "notify", { effect: "webhook.post", destinations: [APPROVED] }
  ]);
});

// ------------------------------------------------------- live: the routes
console.log("phase27: harness — destination grants through the two create routes, then the corpus fills");
const h = await bootHarness({
  COGNOS_AUTONOMY_ENABLED: "true",
  COGNOS_AUTONOMY_RESIDENTS: "true",
  COGNOS_AUTONOMY_NOTICE_MODE: "internal",
  COGNOS_AUTONOMY_EXTERNAL_WRITES: "true",
  COGNOS_AUTONOMY_OUTBOX_MODE: "shadow",
  COGNOS_AUTONOMY_LIVE_DESTINATION: APPROVED
});

const count = async (table, where = "", params = []) =>
  Number((await h.sql(`SELECT COUNT(*)::int AS n FROM ${table}${where}`, params))[0].n);

async function makeAgent(allowlist = ["web.fetch", "note.append", "webhook.post"], slug = null) {
  const created = await h.raw("/api/autonomy/agents", {
    method: "POST",
    body: { name: slug ? `P27 ${slug}` : "P27 Watcher", slug: slug || "p27-watcher",
      purpose: "watch and report", brief: "v1", skill_allowlist: allowlist }
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  return created.json;
}

/** Authorize and retire every other goal, so a tick claims only this one. */
async function authorizeOnly(goalId) {
  const yes = await h.raw(`/api/autonomy/goals/${goalId}/decision`, { method: "POST", body: { decision: "authorize" } });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  await h.sql(
    `UPDATE autonomy_goals SET status='cancelled', park_reason='paused_by_user', ended_ms=$1
      WHERE status IN ('active','parked','awaiting_authorization','proposed') AND id <> $2`,
    [Date.now(), goalId]);
  await h.sql(`UPDATE autonomy_goals SET next_run_at_ms=0 WHERE id=$1`, [goalId]);
  return yes.json;
}

try {
  await test("the manual route welds a good grant into scope, and a malformed grant is a 400 with every entry named", async () => {
    const agent = await makeAgent();

    const made = await h.raw("/api/autonomy/goals", {
      method: "POST",
      body: {
        title: "Granted goal", objective: "Post to the granted destination.",
        agent_id: agent.id,
        scope: { effectsAllowed: ["notify", { effect: "webhook.post", destinations: [`${APPROVED}#frag`, APPROVED] }] }
      }
    });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const stored = made.json.goal.scope;
    assert.deepEqual(stored.effectsAllowed, ["notify", { effect: "webhook.post", destinations: [APPROVED] }],
      "normalized (fragment dropped, duplicate collapsed) before it was ever judged");

    // The authorization hashes cover the SPECIFIC granted scope — the goal
    // can never claim a wider one without a new decision.
    const expected = scopeHashes({ goalId: made.json.goal.id, scope: stored, budget: made.json.goal.budget });
    assert.equal(made.json.hashes.scopeSha256, expected.scopeSha256);

    // Garbage refuses the whole create — nothing halfway-granted is welded in.
    for (const destinations of [
      ["http://insecure.example.com/hook", "https://127.0.0.1/x", "https://hooks.example.com:8443/x"],
      [{ effect: "webhook.post" }.x] // non-string entries are a grant that would silently grant nothing
    ]) {
      const before = await count("autonomy_goals");
      const refused = await h.raw("/api/autonomy/goals", {
        method: "POST",
        body: {
          title: "Bad grant", objective: "must not be created", agent_id: agent.id,
          scope: { effectsAllowed: ["notify", { effect: "webhook.post", destinations }] }
        }
      });
      assert.equal(refused.status, 400, JSON.stringify(refused.json));
      assert.equal(refused.json.code, "invalid_destination_grant");
      assert.match(refused.json.error, /must be https|literal IP|port 443|non-empty string/);
      assert.match(refused.json.error, /Nothing was created/);
      assert.equal(await count("autonomy_goals"), before, "a refused grant creates no goal");
    }
  });

  await test("designer create applies grant_destinations to the first goal — and refuses bad, skill-less and goal-less grants", async () => {
    const agentsBefore = await count("autonomy_agents");
    const goalsBefore = await count("autonomy_goals");

    // A draft whose model asked for everything. The clamp keeps webhook.post
    // because THIS deployment has the rung on — and the proposed read page is
    // ticked in the create, exactly like before.
    const draft = {
      name: "Webhook Herald", slug: "webhook-herald",
      purpose: "Report build events to the hook.",
      brief: "When a build finishes, POST its id to the granted hook.",
      skills: ["web.fetch", "webhook.post"],
      heartbeatMs: 3_600_000,
      budget: { maxSteps: 50 },
      firstGoal: { title: "Herald builds", objective: "POST each finished build to the granted hook." },
      proposedUrls: ["https://example.com/agenda"],
      complete: true
    };

    // A malformed destination list refuses with sentences and creates nothing.
    const badGrant = await h.raw("/api/autonomy/designer/create", {
      method: "POST",
      body: { draft, create_first_goal: true, grant_destinations: ["http://insecure.example.com/hook", APPROVED] }
    });
    assert.equal(badGrant.status, 400, JSON.stringify(badGrant.json));
    assert.equal(badGrant.json.code, "invalid_destination_grant");
    assert.match(badGrant.json.error, /must be https/);
    assert.equal(badGrant.json.draft.slug, "webhook-herald", "the draft comes back, so the click cost nothing");
    assert.equal(await count("autonomy_agents"), agentsBefore);
    assert.equal(await count("autonomy_goals"), goalsBefore);

    // Destinations with the skill absent from the draft: the grant has no hand.
    const keyless = await h.raw("/api/autonomy/designer/create", {
      method: "POST",
      body: {
        draft: { ...draft, slug: "herald-two", skills: ["web.fetch"] },
        create_first_goal: true, grant_destinations: [APPROVED]
      }
    });
    assert.equal(keyless.status, 400);
    assert.equal(keyless.json.code, "grant_without_skill");
    assert.match(keyless.json.error, /not in the draft's skill allowlist|cannot use webhook\.post/);
    assert.equal(await count("autonomy_agents"), agentsBefore, "dragged nothing into existence");

    // Destinations with no first goal: nothing to grant into, named as such.
    const goalless = await h.raw("/api/autonomy/designer/create", {
      method: "POST",
      body: {
        draft: { ...draft, slug: "herald-three" },
        create_first_goal: false, grant_destinations: [APPROVED]
      }
    });
    assert.equal(goalless.status, 400);
    assert.equal(goalless.json.code, "grant_without_goal");
    assert.equal(await count("autonomy_agents"), agentsBefore);

    // The wire itself: read grant AND write grant, both from operator hands.
    const created = await h.raw("/api/autonomy/designer/create", {
      method: "POST",
      body: {
        draft: { ...draft, slug: "webhook-herald" },
        create_first_goal: true,
        grant_urls: ["https://example.com/agenda"],
        grant_destinations: [APPROVED]
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(created.json.goal.status, "awaiting_authorization");
    assert.deepEqual(created.json.goal.scope.effectsAllowed, [
      "notify",
      "external_read",
      { effect: "webhook.post", destinations: [APPROVED] }
    ]);
    assert.deepEqual(created.json.goal.scope.urlAllowlist, ["https://example.com/agenda"],
      "the read grant is untouched — looking and acting stay different authorities");
  });

  await test("END TO END — the corpus fills: a granted attempt is judged aimed at the approved destination", async () => {
    const agent = await makeAgent(undefined, "p27-live");

    const made = await h.raw("/api/autonomy/goals", {
      method: "POST",
      body: {
        title: "Earn the corpus", objective: "Post the build result to the granted hook.",
        agent_id: agent.id,
        scope: { effectsAllowed: ["notify", { effect: "webhook.post", destinations: [APPROVED] }] }
      }
    });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    await authorizeOnly(made.json.goal.id);

    // The planner is told its granted destinations (scopePromptLines) and the
    // mock answers with the one step the grant was cut for.
    let i = 0;
    const script = [
      { thought: "post the result", skill: "webhook.post",
        args: { url: APPROVED, body: JSON.stringify({ event: "build.finished", id: 42 }), reason: "the hook asked" }, done: false },
      { thought: "done", skill: "none", args: {}, done: true }
    ];
    h.model.state.autonomyStep = () => script[Math.min(i++, script.length - 1)];
    const tick = await h.raw("/api/autonomy/tick", { method: "POST", body: { maxGoals: 1 } });
    assert.equal(tick.status, 200, JSON.stringify(tick.json));
    assert.equal(tick.json.frozen, false);

    const rows = await h.sql(
      `SELECT status, destination, tier, verdict FROM autonomy_outbox WHERE goal_id=$1 AND tier='T4'`,
      [made.json.goal.id]);
    assert.equal(rows.length, 1, "one staged, judged, recorded effect");
    assert.equal(rows[0].status, "would_release", "shadow: judged releasable, performed not at all");
    assert.equal(rows[0].destination, APPROVED);

    // The readiness report now counts corpus aimed at the approved destination,
    // and its corpus_aimed condition — which could never be met — is met.
    const rungs = await h.raw("/api/autonomy/rungs");
    assert.equal(rungs.status, 200);
    assert.ok(rungs.json.live.corpus.aimedAtApproved >= 1,
      `corpus aimed at the approved destination: ${JSON.stringify(rungs.json.live.corpus)}`);
    const aimed = rungs.json.live.conditions.find(c => c.id === "corpus_aimed");
    assert.equal(aimed.met, true, "the aimed-corpus condition is satisfied by attempts the grant made possible");
  });

  await test("the lock holds — the same attempt with NO grant is still refused by name", async () => {
    const agent = await makeAgent(undefined, "p27-ungranted");
    const made = await h.raw("/api/autonomy/goals", {
      method: "POST",
      body: {
        title: "No grant", objective: "Try to post with no destination grant.",
        agent_id: agent.id,
        scope: { effectsAllowed: ["notify", "external_write"] } // a class grant: destinations [] grants nothing
      }
    });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    await authorizeOnly(made.json.goal.id);

    let i = 0;
    const script = [
      { thought: "post anyway", skill: "webhook.post",
        args: { url: APPROVED, body: JSON.stringify({ event: "build.finished" }), reason: "no grant" }, done: false },
      { thought: "done", skill: "none", args: {}, done: true }
    ];
    h.model.state.autonomyStep = () => script[Math.min(i++, script.length - 1)];
    await h.raw("/api/autonomy/tick", { method: "POST", body: { maxGoals: 1 } });

    const rows = await h.sql(
      `SELECT status, destination, verdict FROM autonomy_outbox WHERE goal_id=$1 AND tier='T4'`,
      [made.json.goal.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "refused", "staged, judged, refused — the attempt is a row, nothing was performed");
    const failed = (rows[0].verdict?.failed || []).map(f => f.rule);
    assert.ok(failed.includes("DESTINATION_NOT_IN_SCOPE"),
      `refused by name because the grant was never made: ${failed.join(", ")}`);
  });
} finally {
  await h.stop();
}

console.log(`phase27: ${passed} checks passed`);
