# AUTONOMY.md — a design for durable, governed agency in COGNOS

**Status:** proposed design. No code in this document has been written yet.
**Read first:** `server/council/laws.js`, `server/identity.js`, `server/agent/runner.js`,
`server/chatOrchestrate.js`, `DIVERGENCES.md` §14.4.

---

## Decisions locked

| Decision | Choice | Consequence |
|---|---|---|
| **Runtime** | **Railway** (persistent container) | A real daemon is available. In-process heartbeat is the primary mechanism; no 60 s serverless ceiling. Adds SIGTERM/graceful-shutdown and connection-pool duties. |
| **Target** | **Rung 4 — external writes** | The outbox + Action Governor + T4/T5 rules are designed now, not deferred. Rungs still *enable* one at a time. |
| **Shape** | **Shape B — named residents** | `autonomy_agents` is first-class in the first increment, not a later layer. |
| **Findings → user** | **Explicit ask.** "Ask COGNOS about this." | Goal findings are evidence. No agent drafts an answer. The chat surface barely changes. |
| **First external write** | **Webhook** (`webhook.post`, T4) | One adapter reaches Slack, Discord, n8n, Zapier, Make, Home Assistant. Cheapest to build, easiest to test, and it needs an outbound-SSRF boundary. Specified in §4.7.1. |
| **Inbound messaging** | **Yes — build it (Rung 5)** | Bidirectional is in scope. §4.12 is scheduled as Phase 23, default off, shadow-mode replies first. The channel-as-credential trade-off is accepted (§4.12.7). |
| **Build cadence** | **Straight through, gated on shadow** | Phases 19–21 built in one pass. **Nothing goes live** until a shadow corpus justifies each rung. The evidence gate is what carries the risk that building ahead of usage normally adds. |
| **Budget ceilings** | **Conservative defaults, documented** | I pick them (§4.10.1) with the arithmetic shown, on the principle that you should be *annoyed* by hitting a ceiling, not harmed. |
| **Primary risk** | **All four, equally** | Runaway spend, secret exfiltration, false memory promotion, and ungoverned prose get balanced test effort. §8 maps every fear to its tests and names where the suite is thin. |

Everything below is written against those four. Where the earlier draft offered
options, the option is gone and the chosen path is specified.

---

## Status — Phase 19 is built

This document is the design. As of this revision, Phase 19 of it is **implemented
and green**: `npm test` runs `test/autonomy.mjs` (35 checks) alongside the existing
suites, and everything passes.

**What exists:** residents with versioned briefs; goals that do no work until an
authorization row records consent with scope and budget hashes; a resumable,
lease-guarded tick; append-only notes; a code-owned skill registry (T0–T2, four
plus three skills); an outbox that stages and never acts; an Action Governor that
refuses with a named rule; templated notices; an in-process heartbeat started only
by `server/serve.js`; and graceful shutdown that stops the heartbeat, lets an
in-flight tick park, then closes the pool.

**What is deliberately not built:** T3–T5, the webhook adapter, sub-agents, the
promotion path, and inbound messaging. Those are Phases 20–23 and each one
needs its own evidence before it goes live.

**Autonomy is off by default.** `COGNOS_AUTONOMY_ENABLED` unset means the loop is
frozen: no goal wakes, no notice is written, no tick row is recorded.

### Defects the tests found, and why they matter

Building the tests found six real bugs that reading the code did not. Each one is
the same shape: a safety mechanism that looked present but could not fire.

Building the UI found one more: `GET /api/autonomy/agents` listed every brief
version, so after a brief change the page showed the same resident twice, as if
there were two of them. "Current" is not `supersedes_id IS NULL` — that is only
ever true of the first version; it means nothing supersedes the row.

| Defect | Why it was invisible |
|---|---|
| `envFlag` used `value !== "false"`, so `COGNOS_AUTONOMY_ENABLED=` (blank, the most likely host misconfiguration) **turned autonomy on** | the flag read correctly for every value anyone typed while developing |
| Budget keys never matched: `spent.steps` was compared against `budget.maxSteps`, so no line was ever exhausted — the per-goal budget was inert in **both** the tick and the Governor | the loop ran fine; it just never stopped |
| Tick rows were written with `workspace_id = NULL`, and the workspace spend ceiling sums `autonomy_ticks` by workspace — so the daily ceiling could never fire | the ceiling existed, was documented, and was measured from a column nobody populated |
| `tickId` inside the notice payload made the effect idempotency key differ every tick, so a repeated notice would duplicate | dedup worked in a unit test with a fixed payload |
| `config.notices` became an object, but three call sites still tested it for `false` — so `NOTICES_DISABLED` could never fire | the shape change was in one file; the readers were in three |
| A refused step returned before writing anything, so an escalation attempt left no row | the refusal was real; only the evidence of it was missing |

Seven failures, one lesson: **a guard that cannot fire is not a guard.** Every
one of these is now pinned by a test that would fail if it regressed.

---

## 0. The thesis

COGNOS does not have to become less governed in order to become autonomous. It has
to **separate work from authority**.

Today those two are welded together, because the only unit of execution is a turn:

```
one HTTP request → one council run → one Governor verdict → one answer → done
```

Work (thinking, reading, planning) and authority (what reaches the user, what
changes the world) both begin and end inside that bracket. That is why COGNOS is
honest, and why it cannot run for three days.

OpenClaw-class autonomy needs work to outlive the request. It does **not** need
authority to outlive the request. So:

| Plane | Lives | Lifetime | Governed by |
|---|---|---|---|
| **Work** — residents, goals, ticks, sub-agents, notes, skills | durable loop | days/weeks, survives restart and redeploy | budgets, scopes, leases, kill switches |
| **Evidence** — sources, findings, promoted notes | already exists | forever, append-only | `pin.source_untrusted` + provenance |
| **Authority** — prose to the user, effects on the world | unchanged + extended | one decision at a time | **Governor** (prose) + **Action Governor** (effects) |

The loop may *work* as long as its budget holds. It may never *speak* or *act* on
its own authority. Every sentence you read is still composed by the six operators
and still vetoable by the Governor. Every effect on the world is still a staged
proposal a deterministic gate must release.

---

## 1. What is here today

### 1.1 The request-scoped machine

- **One send path.** `Chat.jsx → sendMessage → POST /api/chat → runCouncilTurn`.
  Enforced by `pin.single_send_path`, asserted by `test/identity.mjs`.
- **Lifetime = the SSE connection.** `server/routes/chat.js` builds an
  `AbortController` from `res.on("close")`. Stop or disconnect aborts the active
  model call and records the run `cancelled`. Nothing outlives it.
- **Six operators, one veto.** Observer → Strategist → Specialist → Synthesizer →
  Critic → Governor, with the Coherence Monitor between synthesis and critique.
  Text is released only by `releaseApprovedText()` after the Governor rules.
- **The last gate is deterministic and model-free.** `server/council/governor.js`
  runs regex rulebooks for empty output, secret leakage, minimum-cause floors
  without a surrender phrase, and citations to record authorities never loaded. It
  refuses by default, and its refusals are fixed strings — never model-generated
  substitutes.

### 1.2 The governance core autonomy must not damage

- **`server/council/laws.js`** — 4 charter + 12 operational/scope laws, deeply
  frozen, `LAW_LAYER_VERSION` `1.3.0`. Not runtime-writable.
- **`server/meta/policy.js`** — gates 17 named actions. Anything unnamed is
  refused. Refusals are rows in `improvement_ledger`, not exceptions. **Approved ≠
  applied.**
- **`server/knowledge/`** — append-only `knowledge_events` with `BIGSERIAL seq`,
  fold/replay, beliefs with saturating confidence arithmetic and decay,
  relationships, coherence, analytics.
- **`server/meta/`** — per-run and per-model-call telemetry with attempt
  attribution, a cost rate table (`rates.js`), an offline evaluation harness,
  observe-only adaptive selection, the Improvement Ledger.
- **`server/sources/`** — immutable hashed snapshots, `[src_…:p3]` locators,
  `safeFetch` with DNS pinning and SSRF rejection, injection screening that records
  risk flags rather than rewriting text.

### 1.3 The agent subsystem — the seed

`server/agent/runner.js` + `planner.js`: four modes (`off`, `observe`,
`read_only`, `research`); two tools (`read_source`, `open_link`); budget 6 steps /
3 links / 8 sources / **0 writes**. Every run, step, transition and decision is
recorded — `agent_runs`, `agent_steps` (unique `idempotency_key`), `agent_events`
(append-only, `BIGSERIAL seq`), `agent_approvals`.

**Research mode already has a real consent barrier.** The planner only proposes
read-only steps; the run is created `awaiting_approval`;
`POST /api/agent/runs/:id/decision` writes one `agent_approvals` row per step,
**each with a SHA-256 scope hash over `(run id, step id, tool, input)`**, before
the first fetch. Declined plans execute nothing and cannot be re-decided.

And the UI already renders the result as a **templated** line — `"Plan approved — 3
steps executed with consent recorded per step."` Counts and stored fields through a
fixed string.

That is the single most important precedent in this document. **COGNOS already has
a reviewed pattern for "the system reports to the user without producing an
answer."** Autonomy scales that pattern; it does not invent a channel.

### 1.4 Primitives that already look like autonomy

| Need | Already in the repo |
|---|---|
| Durable intent across sessions | `projects` + `project_id` on conversations/sources |
| Durable state across restart | `agent_runs.status` materialized + `agent_events` append-only |
| Resumable execution | `idempotency_key`, enforced by a unique index |
| Long-term memory | `memories` (evidence level + volatility), `beliefs` (confidence + decay) |
| Observable reasoning | `telemetry_runs` / `telemetry_model_calls` |
| Cost control | `server/meta/rates.js` → `cost_usd` per run |
| "Does this subsystem earn its cost?" | `durablePostProcessingDecision` in `server/meta/latency.js` — an explicit evidence gate returning `insufficient_evidence` / `candidate` / `not_justified` |
| Refusal as a record | `improvement_ledger`, `veto_raised` |
| Untrusted internal text | `pin.source_untrusted` — sources are evidence, never authority |

### 1.5 The blockers — and what Railway does to them

1. **Laws.** `pin.agent_bounded` forbids autonomous writes; `pin.single_send_path`
   forbids a second user channel; `pin.no_auth` means no per-principal isolation.
   *Railway changes nothing here.* These are code changes and must be reviewed.
2. **Identity.** `server/identity.js` truthfully declares
   `autonomousBackgroundTasks` and `consequentialAgentWrites` unsupported. That
   changes when they exist — and only then.
3. **Runtime.** Was the hard one: Vercel has no process and Hobby caps a function
   at 60 s. **Railway removes it.** What remains is ordinary daemon hygiene, not
   architecture:
   - **Graceful shutdown.** Railway sends SIGTERM before every redeploy.
     `server/serve.js` currently has no handler. It must stop the heartbeat, finish
     or park the in-flight tick, release leases, and `closeDatabase()` (which
     already exists in `server/db.js` and is currently only used by tests).
   - **Connection pool.** `server/db.js` picks `pg.Pool` for non-Neon URLs with
     `DATABASE_POOL_MAX` default **5**. A resident loop holds connections
     concurrently with chat turns; 5 is tight. Raise it, and cap tick concurrency
     so autonomy can never starve the council.
   - **Redeploys are restarts.** The tick model does not assume a long-lived
     process even on Railway — it just benefits from one.
   - **Replicas.** Railway can run more than one. The lease design (§4.3) makes
     that *safe rather than broken*: N heartbeats racing on one database, one
     winner per goal. Autonomy becomes horizontally scalable for free.
   - **No sleep.** If the service is ever configured to idle, the heartbeat dies
     with it. Keep it always-on, and keep an operator cron ping as a fallback
     starter.

---

## 2. What "OpenClaw-level" decomposes into

Eight capabilities, with very different relationships to the laws.

| # | OpenClaw capability | COGNOS-native form | Legal today? |
|---|---|---|---|
| 1 | Persistent goals | **Goal** row + append-only events + checkpoint | ✅ additive, no law touched |
| 2 | Heartbeat / cron | **Tick** — in-process on Railway | ⚠️ needs the `COGNOS_AUTONOMY_ENABLED` kill switch, which `phase15.complexity_justification` requires anyway |
| 3 | Long-horizon plans across restarts | tick + lease + idempotent steps | ✅ |
| 4 | Memory that accumulates | **Working notes** (typed, append-only) + governed **promotion** | ✅ if promotion is a labelled transition |
| 5 | Skills marketplace | **Skills**: typed, risk-tiered, **code-owned**, per-agent allowlist | ✅ if the registry is code, not data |
| 6 | Sub-agent dispatch | **Sub-agents**: narrow skill subset, own budget, output is *evidence* | ✅ under a new `pin.subagent_untrusted` |
| 7 | Proactive notices | **Notice**: deterministic templated rendering of stored records | ⚠️ needs a narrow carve-out in `pin.single_send_path` |
| 8 | Acts on external services | **Outbox effect** + deterministic **Action Governor** + granted scope | ❌ today — exactly what `pin.agent_bounded` defers |

**Six of eight are legal today.** The two that are not (7, 8) are the two that make
autonomy *feel* like autonomy, and both are the ones COGNOS's own law text already
names as "not yet — and here is what would have to exist first."

> **`pin.agent_bounded` contains its own upgrade path:**
> *"Autonomous write actions are forbidden **until a separately reviewed approval
> barrier exists**."*
>
> Building that barrier is the first job of this design. Submitting it for review
> is the second.

---

## 3. Architecture

```
                ┌──────────────────────── AUTHORITY PLANE ────────────────────────┐
                │                                                                  │
  ┌──────────┐  │  prose:   council (6 operators) ──► GOVERNOR ──► approvedText     │
  │   USER   │◄─┤           single send path, unchanged                            │
  └────┬─────┘  │                                                                  │
       │        │  effects: OUTBOX ──► ACTION GOVERNOR ──► release │ refuse │ shadow│
       │ asks   │           new; deterministic, refuse-by-default                   │
       ▼        └──────────────────────────────────────────────────────────────────┘
  ┌───────────────────────────── WORK PLANE (Railway process) ─────────────────────┐
  │                                                                                │
  │  RESIDENT (name, brief, skill allowlist, heartbeat, budget)                     │
  │      └── owns ──► GOAL (objective, scope, budget, spent, checkpoint, lease)     │
  │                         ▲ lease/CAS = single writer, safe across replicas       │
  │                         │                                                      │
  │  HEARTBEAT ──► TICK ──► load checkpoint ──► plan ──► validate ──► execute        │
  │                         └──► goal_events ──► spend ──► schedule / park           │
  │                                                                                │
  │  SKILLS (code-owned, T0–T5)      SUB-AGENTS (narrow, budgeted)                  │
  └───────────────┬────────────────────────────────────────────────────────────────┘
                  │ produces
                  ▼
  ┌──────────────────────── EVIDENCE PLANE (already exists) ──────────────────────┐
  │  sources · source_chunks · goal_notes ──► promoted memories/beliefs            │
  │  ALL untrusted by default. ALL cited. ALL replayable.                          │
  └───────────────────────────────────────────────────────────────────────────────┘
```

**Invariants:**

1. Nothing on the work plane emits user-facing prose.
2. Nothing on the work plane performs a consequential effect. It stages one.
3. Everything the work plane produces is untrusted evidence with provenance —
   including the output of its own sub-agents.
4. The council is unchanged: six seats, same prompts, same Governor. The loop
   changes *what work exists to reason about*, never *how the council reasons*.
   `phase15.observe_only` survives intact.
5. Every autonomous model call, step, tick, effect and notice is attributable to an
   `agent_id`, `goal_id`, `tick_id` and skill id.

---

## 4. The design

### 4.1 Residents (Shape B)

Named agents that live in the workspace. Not identities — **workers**.

```
autonomy_agents
  id, workspace_id, name, slug, purpose
  brief                  -- operating text: what to work on, how to report
  brief_version INTEGER  -- brief edits are NEW VERSIONS, never edits (auditable)
  skill_allowlist JSONB  -- the ceiling; a brief can never exceed it
  conversation_id TEXT   -- this resident's own thread (§4.9.1)
  default_scope JSONB, default_budgets JSONB
  heartbeat_interval_ms BIGINT, enabled BOOLEAN
  created_date, updated_date
```

**The brief is operating text, not identity.** This is the rule that keeps
`pin.truthful_self_model` intact:

- A brief shapes *what the resident works on* and *how it reports*. It can never
  change *what COGNOS is*. The self-model is injected after all mutable context,
  exactly as it is today for sources and memories.
- A brief is **untrusted by default**, like a source. It cannot grant a skill the
  `skill_allowlist` does not contain; that check runs against the row in code, never
  against the brief's text.
- A brief cannot raise a goal's budget, widen a scope, or authorize an effect tier.
- **Brief edits are versioned.** The row is appended, not updated, so the record
  always shows what the resident was actually told when it did the thing you are
  looking at. A resident's behaviour is only auditable if its instructions are.

**Scheduling is one timer, not N.** A single workspace heartbeat walks due
residents round-robin. Twenty residents must not mean twenty `setInterval`s.

**Budgets are per-resident *and* workspace-wide.** Each resident gets a default
budget; the workspace also gets a ceiling (`COGNOS_AUTONOMY_MAX_*`) so twenty
enthusiastic residents cannot spend more than you agreed to spend. Per-resident
budgets are carved from the workspace ceiling, and exhaustion of either parks.

**Honest limit, stated in the manifest:** `pin.no_auth` means there are no accounts.
Every resident shares one workspace, one memory, one ledger. Residents are a
single-operator deployment's feature, not a multi-tenant one.

### 4.2 Goals

A turn is bounded by a connection. A goal is bounded by a **scope** and a
**budget**. That is the whole difference.

```
autonomy_goals
  id, workspace_id, agent_id, conversation_id, project_id
  title, objective
  status        -- proposed | awaiting_authorization | active | parked
                -- | completed | cancelled | expired
  park_reason   -- awaiting_approval | budget_exhausted | blocked_on_evidence
                -- | error_backoff | paused_by_user | kill_switch | scope_expired
  scope       JSONB  -- { skills:[], urlAllowlist:[], effectsAllowed:[{effect,recipients,
                     --   maxPerDay,maxPerGoal,approval,expiresAtMs}], dataClasses:[] }
  budget      JSONB  -- { maxSteps, maxModelCalls, maxTokensIn, maxTokensOut, maxCostUsd,
                     --   maxWallClockMs, maxNoticesPerDay, maxExternalEffects, expiresAtMs }
  spent       JSONB  -- same shape; monotonically increasing, decrements refused
  checkpoint  JSONB  -- everything needed to resume
  schedule    JSONB  -- { kind: heartbeat|once, intervalMs, nextRunAtMs,
                     --   maxConsecutiveFailures, jitterMs }
  lease_owner TEXT, lease_expires_at BIGINT
  created_date, updated_date
```

Statuses are **transitions, not edits**. Every change appends a `goal_events` row —
the `agent_events` pattern exactly. A cancelled goal is never deleted; it is
`cancelled`, with its history intact and queryable.

**Birth of a goal** — two routes, both ending at the same barrier:

1. **From chat.** You ask for something long-horizon. The Observer/Strategist emit
   a *goal proposal*. It lands `awaiting_authorization` and the composer shows a
   **Goal Card**: resident, objective, skills requested, URL/domain scope, budgets,
   expiry, and which effect tiers are being requested. Authorize or decline — the
   same two buttons `ResearchDecisionCard` already uses.
2. **From the Autonomy page.** A structured form. Same barrier, same row shape.

**Authorization is a row with a hash.** `goal_authorizations(goal_id, scope_sha256,
budget_sha256, decision, reason, decided_ms, expires_at_ms)` — the `agent_approvals`
precedent applied to a whole goal. **Widening a scope or raising a budget is a new
authorization, never an edit.** That is what makes privilege escalation structurally
impossible rather than merely forbidden.

### 4.3 Tick — resumable, bounded, replica-safe

```js
tick({ workerId, nowMs, sliceMs, maxGoals }) -> {
  ticks: 1, goalsClaimed, stepsExecuted,
  effectsStaged, effectsReleased, effectsRefused,
  goalResults: [{ goalId, outcome, parkReason, nextRunAtMs, spent }]
}
```

1. **Claim (single writer).**
   `UPDATE autonomy_goals SET lease_owner=$1, lease_expires_at=$2 WHERE id=$3
   AND (lease_owner IS NULL OR lease_expires_at < $4)`. A compare-and-set. Two
   replicas, two invocations, one winner. A crashed tick leaves an expired lease
   that the next tick reclaims — **that is the entire crash-recovery mechanism**,
   and it is why no long-lived connection or `LISTEN/NOTIFY` is needed.
2. **Load** the checkpoint.
3. **Slice.** At most `maxStepsPerTick` steps, stopping at the step cap or
   `sliceMs`, whichever comes first. On Railway `sliceMs` can be generous (default
   `120_000`); it still exists so one pathological goal cannot occupy the loop
   forever and so a SIGTERM has a bounded window to land in.
4. **Step.** `plan → validate → execute → record`:
   - **Plan.** One bounded structured model call, `purpose: "autonomyStep"`, through
     `callLLM` — inheriting the single logical deadline, bounded retries, and
     per-attempt telemetry. JSON schema out:
     `{ thought, skill, args, noteEntries[], done, blocked }`.
   - **Validate** (deterministic, before execution): skill ∈ `scope.skills`; args
     satisfy the skill's schema; target ∈ `scope.urlAllowlist` / `recipients`;
     effect tier covered by an unexpired authorization; no budget line exhausted.
     **A skill outside the allowlist is refused even when the model asks for it**,
     and the refusal is recorded. That is what makes "the planner cannot grant
     itself capabilities" true by construction rather than by instruction.
   - **Execute.** Skills are the only thing that touches the world. Reads go through
     `safeFetch`. No new network path exists.
   - **Record.** Append `goal_events`, update `spent`, advance the checkpoint.
5. **Schedule.** `nextRunAt = now + intervalMs + jitter` (jitter prevents a
   thundering herd at midnight).
6. **Release the lease** in a `finally`. Always.

**Failure discipline** — this is where naive agent loops bankrupt people:

- A failed step retries at most once with existing bounded backoff, then parks
  `error_backoff` with the error recorded.
- `maxConsecutiveFailures` exceeded → park permanently; a human decides.
- Budget exhaustion parks. It never silently continues. Resuming needs a new
  authorization row.
- No "loop until done." A goal is a finite state machine with a step ceiling, and
  the ceiling is spendable currency.

**Runtime on Railway:**

| Concern | Mechanism |
|---|---|
| Primary driver | `server/autonomy/heartbeat.js` — one `setInterval`, unref'd, started in `serve.js` only (never `index.js`) |
| Ops / debug / fallback | `POST /api/autonomy/tick` behind `COGNOS_RUNTIME_SECRET` — run one slice on demand |
| Graceful shutdown | `SIGTERM` → stop the timer → let the in-flight tick finish or park → release leases → `closeDatabase()`. Second `SIGTERM` force-exits after the grace window. |
| Restart safety | Leases + idempotent steps. A redeploy mid-step is a routine event, not an incident. |
| Replicas | Safe. N heartbeats, one writer per goal via lease CAS. |
| Sleep risk | Keep the service always-on; optional external cron ping to `POST /api/autonomy/tick` if it ever idles. |

### 4.4 Working notes — and promotion

OpenClaw's answer to memory is markdown files in a directory. COGNOS has a better
substrate; what it lacks is the one thing OpenClaw has — **a scratchpad the loop
re-reads every wake-up**.

```
goal_notes
  id, goal_id, agent_id, tick_id, ordinal, kind, body, refs JSONB,
  confidence, supersedes_note_id, created_date
  kind: finding | question | dead_end | decision | plan_change | evidence_ref | blocker
```

- Append-only. A correction is a new note with `supersedes_note_id`, never an edit.
- Every tick loads a bounded digest (most recent N + pinned) into the step prompt —
  this is the continuity across restarts.
- Notes are **untrusted by default**, the same contract as a fetched page. A note is
  what the agent said, not what is true.
- **Promotion is the only route from note to knowledge, and it is labelled:**
  - note → memory requires a human confirmation **or** a completed goal whose
    findings were carried into a Governor-approved answer. It lands
    `evidence_level: "inferred"` — **never `direct`** — with
    `tags: { origin: "autonomy_goal:<id>", agent: "<slug>" }`.
  - note → belief enters at `config.knowledge.hypothesisConfidenceFloor` (0.6) with
    `hypothesis: true`, so it earns confidence like any other hypothesis.
  - This is what stops a loop from laundering its own hunches into `direct` facts
    about you — the failure that would quietly destroy the memory layer's honesty.

### 4.5 Skills — typed, risk-tiered, code-owned

**Skills are code, not data.** The most important decision in this section.

COGNOS already keeps its laws in code (`server/council/laws.js`), its identity in
code (`server/identity.js`), and its tools in code (`TOOL_REGISTRY`, a frozen object
in `server/agent/runner.js`). A database table of skills that anything could insert
into would be a capability write — a law change wearing a different hat.

```
server/skills/
  index.js          frozen registry: id, tier, argsSchema, effectType, idempotency, killSwitch
  noteAppend.js  evidenceRead.js  memorySearch.js  beliefSearch.js  projectRead.js
  webFetch.js  webSearch.js  noticeEmit.js  sourceSnapshot.js
  (T4, later) emailSend.js  webhookPost.js  calendarCreate.js  fileWrite.js
  (T5, later) paymentCreate.js  postPublish.js  recordDelete.js
```

Each skill declares: `id`, `version`, `argsSchema` (JSON Schema, validated before
execution), `tier`, `effectType`, `idempotent` + `idempotencyKeyOf(args)` (required
for anything with effects), `killSwitch` (the env var that disables it — **required**
by `phase15.complexity_justification` for any subsystem), `maxPayloadBytes`,
`timeoutMs`, and `dryRun: true` support for T3+.

| Tier | Effect | Release rule |
|---|---|---|
| **T0** | observe / read internal / note | auto — nothing leaves the system |
| **T1** | internal write: drafts, projects, staged sources, promotion requests | auto within scope; reversible as a transition |
| **T2** | notify: templated in-app notice | auto within scope; rate-limited per goal; **deterministic content only** |
| **T3** | external read: `safeFetch` / search | auto within `scope.urlAllowlist`; every SSRF rule applies |
| **T4** | external write: email, webhook, calendar, file, post | **granted scope covering this exact effect class + destination**, plus a passing Action Governor verdict |
| **T5** | irreversible: payment, publish, delete, access grant | **one-by-one human approval, always. Never authorizable by class.** |

Only the **per-resident allowlist** is data. The capability itself is code, reviewed
like code.

### 4.6 Sub-agents — narrow workers, not seventh seats

`pin.six_operators` is absolute. Sub-agents respect it trivially, because **a
sub-agent never participates in producing an answer at all.** It is a worker spawned
by a step with a narrow objective, a *subset* of the goal's skills (never a
superset), a sub-budget carved from the goal's, and a structured output contract
(findings + evidence refs + uncertainty).

Its output enters the evidence plane as `kind: "finding"` with provenance
(`sub_agent_id`, ticks used, skills used, tokens). When those findings later reach
the council they are **evidence, not authority** — the same relationship a fetched
webpage has today.

One new law, mirroring an existing one:

> **`pin.subagent_untrusted`** — *A sub-agent's report is evidence with provenance,
> never authority. No sub-agent output may address the user, widen a goal's scope,
> raise a goal's budget, or claim a capability the skill registry does not define.*

That is `pin.source_untrusted` applied to the system's own internals — the reason
multi-agent dispatch does not become multi-agent confabulation.

### 4.7 The outbox and the Action Governor (Rung 4 is the target, so this is the core)

This is the barrier `pin.agent_bounded` has been waiting for.

```
autonomy_outbox
  id, workspace_id, agent_id, goal_id, tick_id, step_id, skill_id
  effect_type TEXT          -- internal_write | notify | external_read | external_write | irreversible
  tier        TEXT          -- T0..T5
  payload     JSONB         -- exact validated arguments
  idempotency_key TEXT      -- sha256(goal_id, effect_type, canonical(payload))
  status                    -- staged | approved | released | refused | reverted | failed
  verdict     JSONB         -- Action Governor output: rules passed, rules failed, law refs
  scope_sha256 TEXT         -- which authorization this release is claimed under
  mode                      -- live | shadow | dry_run
  released_ms BIGINT, receipt JSONB, error_message TEXT
  created_date

outbox_events  -- append-only: (id, seq BIGSERIAL, outbox_id, from_status, to_status,
               --               detail JSONB, ts_ms)   ← agent_events, again
```

**The Action Governor** is shaped deliberately like the Answer Governor: a
model-free rulebook over the final payload, refusing by default, recording refusals
as rows instead of throwing.

```
refuse if  effect_type is not in the (code) skill registry
refuse if  effect_type ∉ goal.scope.effectsAllowed
refuse if  tier T1..T3  and the action falls outside goal.scope
refuse if  tier ≥ T4    and no unexpired authorization covers (effect_type, destination)
refuse if  tier = T5    and no human approval row naming THIS outbox id exists
refuse if  destination ∉ scope.recipients / scope.urlAllowlist
refuse if  any budget line in goal.budget — or the workspace ceiling — is exhausted
refuse if  payload matches SECRET_PATTERNS (the same list the Policy Engine uses)
refuse if  payload exceeds the skill's maxPayloadBytes
refuse if  the URL fails normalizePublicUrl / safeFetch SSRF validation
refuse if  the per-goal or per-day effect rate limit is already reached
refuse if  inside quiet hours defined for the deployment
replay if  idempotency_key already released → return the prior verdict, do NOT re-execute
```

Two properties make the barrier real rather than decorative:

- **Staging is not acting.** A step may stage freely; nothing happens to the world
  until a release succeeds. A buggy planner can fill the outbox. It cannot empty it.
- **Replay safety is structural.** The unique index on `idempotency_key` means a
  retried tick after a crash or redeploy cannot double-send an email. It gets the
  prior verdict back.

**Shadow mode is how Rung 4 gets earned.** Before any T4 skill runs live, the
deployment runs `mode: "shadow"`: the loop behaves identically — plans, stages,
calls the Action Governor — and the Governor returns its verdict and records it, but
**nothing is delivered**. The outbox accumulates a real corpus of
`would_release` / `would_refuse` verdicts you can read on `/autonomy`.

That is the same discipline `server/meta/latency.js` already applies to the durable
outbox question: *need N samples, then decide, and say why.* Rung 4 turns on in
`live` only after a shadow corpus shows the gate is neither too loose nor too
tight — with the count and the verdict distribution recorded as the evidence row
that justifies it. `phase15.complexity_justification` demands exactly this, and it is
the difference between "we enabled autonomy" and "we earned autonomy."

**Reversal is a new row, never an edit** (`pin.ledger_append_only`, already
enforced). An `outbox_events` row with `to_status: "reverted"` plus a receipt for
the reversal attempt; the original stays. `revert_improvement` in the Policy Engine
is the precedent.

**Delivery adapters** (T4/T5) are code modules — `emailSend.js`, `webhookPost.js` —
each with its own env kill switch, credentials read from the environment only
(`pin.secrets_env_only`), mandatory `dryRun` support, and a receipt stored on the
outbox row (provider message id, timestamp, status). No adapter accepts a
destination that is not in the granted scope.

#### 4.7.1 The webhook adapter — the first T4 destination

**Why webhook first.** One adapter buys most of the surface: Slack, Discord, n8n,
Zapier, Make, Home Assistant and any custom endpoint are all `POST` to an https URL.
Five integrations for the price of one review. It is also the easiest to test (a
local sink in the harness captures the exact bytes) and the easiest to bound (no
recipient identity, no thread state, no reply semantics to get wrong).

**Why it is also the sharpest one.** A webhook is not a message, it is a **trigger**.
It can deploy, trade, unlock a door, or post publicly. And an arbitrary outbound URL
is `safeFetch`'s inbound SSRF problem seen in a mirror. So:

| Risk | Mitigation |
|---|---|
| **Outbound SSRF** | Reuse `isPublicAddress` from `server/sources/safeFetch.js`. Resolve DNS, reject any non-public answer, re-resolve and re-check on every redirect (max 2). A model that names a URL cannot reach `169.254.169.254`, `10.0.0.0/8`, or `localhost:8080`. |
| **Downstream consequence** | Destinations are an explicit allowlist on the goal's scope — never a free-form model argument. |
| **Credential leakage** | The payload never carries a secret. Secrets are referenced **by name** (`secret_ref`) and resolved server-side at send time. `pin.secrets_env_only` applies to payloads exactly as it applies to the database. |
| **Amplification** | Per-goal and per-day caps, plus the idempotency key, so a looping planner cannot POST in a loop. |

**Adapter contract.**

```
skill:      webhook.post
tier:       T4
argsSchema: url          string  — https only, must match a scope allowlist entry
                                   (exact URL, or host + path prefix)
            method       "POST"  — POST only, at first
            headers      object  — allowlisted names only; no Authorization from args
            body         string  — <= 32 KiB, JSON or text
            secret_ref   string? — name of an ENV var used to HMAC-sign the body
idempotency: sha256(goal_id, "webhook.post", canonical(url, body))
caps:        maxPerGoal, maxPerDay, maxBodyBytes, timeoutMs (default 8000)
killSwitch:  COGNOS_SKILL_WEBHOOK_POST
mode:        shadow | dry_run | live
```

**Deterministic gates, all before a socket opens:**

1. `url` ∈ `scope.effectsAllowed[{effect:"webhook.post"}].destinations` — exact or
   prefix match. The model never supplies the pattern; it picks from granted rows.
2. `new URL()` → scheme https, port 443, no credentials embedded in the URL.
3. DNS resolve → **every** address must pass `isPublicAddress`; re-check on redirect.
4. Body size cap; header allowlist (`Content-Type`, `X-COGNOS-*`); no
   `Authorization` unless `secret_ref` names an env var that actually exists.
5. Budget lines: per-goal, per-day, workspace ceiling.
6. Idempotency key → already released means replay the verdict, do not resend.
7. `mode`: `shadow` records the verdict and delivers nothing; `dry_run` builds and
   records the exact request and does not send.

**Send.**

- `AbortController` + timeout. One attempt, plus **one** retry only on
  429/502/503/504, honouring `Retry-After` and capped at 2 s — the same retry
  discipline `server/llm.js` already uses. No retry on other 4xx.
- Every request carries `X-COGNOS-Idempotency-Key`, `X-COGNOS-Goal-Id`,
  `X-COGNOS-Tick-Id`, `X-COGNOS-Timestamp`, so the receiver can dedupe and you can
  trace a delivery back to the exact tick that produced it.
- Optional signature: `X-COGNOS-Signature: sha256=<hmac(body)>` using the secret
  named by `secret_ref`. **Only the name is ever stored** — never the value.

**Receipt** (stored on the outbox row):

```
{ status, statusText, latencyMs, attempts, responseBodyDigest,  // sha256, first 4 KiB
  sentHeaderNames: [...],   // names only, never values
  bodyBytes, sentAt }
```

Response bodies are **digest-only**. An endpoint that echoes a secret back must not
write that secret into the ledger, telemetry, or the outbox.

**Refusals** write an `outbox_events` row carrying the rule id that fired and append
to the goal's event log. Refusals are rows, never exceptions — the same rule
everywhere in this design.

**Why not email or file first.** Email needs recipient identity, threading, and a
consent story for an autonomous sender — a far larger ethical and legal surface.
File writes need a filesystem boundary decision, and they are the beginning of "the
agent has a computer." Webhook is the smallest thing that reaches the outside world
and the one most likely to be useful on day one.

**Inbound is a separate design, and it now has its own section: §4.12.** OpenClaw's
magic is bidirectional — you message it and it replies — and an inbound webhook
receiver is a different kind of object: an untrusted **ingress** that can inject text
into the system. It forces the one question this document had to answer rather than
defer: can COGNOS prose leave a browser session at all? §4.12 argues that it can,
because the invariant is **one governance, not one transport** — and then builds the
barrier that makes it true.

### 4.8 Notices — how a background agent speaks without an answer path

The delicate one, so the argument in full.

`pin.single_send_path` protects one thing, clear from its context: **ungoverned
model-generated text arriving as if COGNOS were speaking.** A notice is not that.

```
kind: goal_parked
fields: { goalId, agentSlug, title, status, parkReason, stepsExecuted,
          findings: 3, effectsAwaitingApproval: 1, nextRunAt, lastTickMs }
rendered by: a fixed template in src/components/autonomy/NoticeCard.jsx
model text: none. ever.
```

This is what `Chat.jsx` already renders after a research decision — `"Plan approved
— 3 steps executed with consent recorded per step."` Counts and stored fields
through a fixed string. Reviewed and shipped.

The carve-out is narrow and the test is mechanical:

> **`pin.notice_deterministic`** — *A goal may surface a notice: a deterministic
> rendering of stored records through a fixed template, containing no
> model-generated text. A notice is not an answer. Any sentence COGNOS composes for
> the user is produced by the council and released by the Governor through
> `POST /api/chat`, and nothing may add a second route that emits answer text.*

The regression writes itself: boot the harness with a mock model that returns
`"I have feelings and I booked your flight"`, run a goal, and assert that string
appears in **no** notice payload, **no** outbox release, and **no** SSE `token`
frame. Notices carry template ids and record ids. Falsifiable.

### 4.9 Findings → user: the explicit ask (chosen path)

**No agent ever drafts an answer.** When a goal finishes or parks with findings,
the Autonomy page and the notice card offer **"Ask COGNOS about this."** That is an
ordinary turn:

1. `POST /api/chat` with `goalId` — the one send path, unchanged.
2. The server reads the goal's notes and evidence **from its own rows**, never from
   the browser, and assembles a bounded evidence block — the `buildResearchContext`
   pattern already used for research execution records.
3. Notes are **citable like sources**, with goal-scoped locators:
   `[goal_<id>:n12]`, mirroring `[src_…:p2]`.
4. The Governor's `source_citation_unverifiable` rule is extended to goal-note
   locators, so an invented note citation is refused exactly like an invented page
   citation.
5. The council composes. The Governor rules. `pin.single_send_path` holds
   absolutely.

The consequence is worth naming: **a resident's findings have exactly the epistemic
status of a webpage COGNOS fetched.** Untrusted evidence, cited, never authority.
That is the most conservative possible reading of autonomy, and it is the reason
this design does not erode the product.

#### 4.9.1 One conversation per resident (C5 — decided)

**Each resident owns its own conversation.** Its goals write there, its findings
live there, and "Ask COGNOS about this" happens there.

This turned out to be the better answer, and my earlier framing was wrong about
why. I had argued that a shared transcript gave the explicit-ask path "an obvious
home." It does — but so does a resident's own thread, and it is *cleaner*: when you
ask in the research watcher's conversation, the context is that watcher's history
and nothing else. Sharing would have added noise, not convenience.

**What it buys:**

- **Clean attribution.** The conversation *is* the resident. No ambiguity about who
  said what, and no resident's entries interleaved with another's.
- **Context contention disappears.** `config.orchestrator.maxHistoryMessages` is
  **20** (`server/config.js:25`, read by `Message.recent()` at
  `chatOrchestrate.js:355`). Under a shared transcript those 20 slots were a
  contention surface — one chatty resident could starve the others and crowd out
  your own turns. Per-resident, each conversation has its own window. The problem
  is not mitigated; it does not exist.
- **Scoping is structural.** A resident's context is its own history by default.
- **It matches a pattern already in the app.** Projects already group
  conversations; a resident conversation is an ordinary conversation carrying an
  `agent_id`. Almost no new UI concept.

**What it costs, and the design around it:**

**1. Cross-resident visibility is gone — and that is the right default.**
Residents cannot see each other's findings unless explicitly granted. If you want
one to read another, that is a **subscription**: an explicit row naming the reader
and the writer, consumed as *untrusted, cited evidence* — never as context that just
appears. Isolation by default; subscription by grant. (Deferred to a later
migration; nothing in `0006` needs to change to add it.)

This does make **C4** (who arbitrates contradictory residents) more acute: with
isolation, two residents are *less* likely to notice they disagree. C4 stays open,
and the mechanism — when you want one — is the coherence monitor over promoted
beliefs, or an explicit "other residents' findings" evidence pack.

**2. The `resident` role is still required — this is not an artifact of sharing.**
Even inside its own conversation, a resident's entry must not be
`role: 'assistant'`. If it were, the thread would read as though COGNOS spoke, and
it did not pass the council or the Governor. That is precisely what
`pin.single_send_path` exists to prevent, wearing a different hat.

So a resident entry is **a rendering of a stored `goal_notes` row** — templated,
attributable, no composed prose. `pin.notice_deterministic` applies inside the
conversation exactly as it does to a notice: **a resident entry is a notice that
happens to persist in a thread.** Nothing new becomes possible; only the surface
changes.

`role` is `TEXT NOT NULL` with **no CHECK constraint** (`server/db.js:123`), so the
value is purely additive — no existing row changes meaning, no migration touches
them.

**3. Where a goal reports vs. where it was born.**
A goal authorized from the Goal Card in *your* conversation belongs to a resident
but was born in yours. Both are recorded: `goal.conversation_id` is the origin
(yours), `agent.conversation_id` is the report target (the resident's). "Ask COGNOS
about this" works from either, because the goal id is attached to the turn.

**4. Thread proliferation.**
N residents means N threads. The sidebar groups them under a collapsible
**Autonomy** section, the way projects are grouped today.

**5. Growth is per-thread and still never pruned** — `pin.ledger_append_only`. As
before, the conversation is a **view**; `goal_notes` and `goal_events` remain the
durable record, the Autonomy page reads those, and the chat view reads a bounded
window.

**Schema (additive, migration `0006`):**

```sql
ALTER TABLE autonomy_agents ADD COLUMN IF NOT EXISTS conversation_id TEXT;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id       TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS goal_id        TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS note_id        TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS resident_kind  TEXT;  -- finding|status|question
ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin         TEXT;  -- browser|inbound|autonomy
CREATE INDEX IF NOT EXISTS messages_agent_idx ON messages (agent_id, created_date DESC);
CREATE INDEX IF NOT EXISTS messages_goal_idx  ON messages (goal_id);
```

All nullable, all `IF NOT EXISTS`. (`origin` is shared with the inbound design in
§4.12.8 — one column, two consumers.)

**Consequence for C3.** Per-resident conversations make **scoped** the coherent
default for memory too: a resident reads its own history, subscribes explicitly to
another's, and writes into a shared belief store only through the labelled
promotion path (§4.4). The transcript and the memory layer now agree, which they did
not under the shared option. C3 remains formally open, but the default is no longer
in question.

### 4.10 Budgets, deadmen, and the stop button

The most common real-world failure of autonomous agents is a loop that keeps going.
Stopping is a first-class, tested behaviour here.

| Control | Behaviour |
|---|---|
| `COGNOS_AUTONOMY_ENABLED=false` | **Global kill switch.** Heartbeat stops; every goal parks `kill_switch`; no model calls, effects or notices. Required by `phase15.complexity_justification`. |
| Per-skill kill switch | Each skill names one. Disabling `emailSend` does not disable the loop. |
| Per-goal budget | `maxSteps`, `maxModelCalls`, `maxTokensIn/Out`, `maxCostUsd` (from `server/meta/rates.js`), `maxWallClockMs`, `maxNoticesPerDay`, `maxExternalEffects`, `expiresAtMs` |
| Workspace ceiling | `COGNOS_AUTONOMY_MAX_*` — twenty residents cannot outspend what you agreed to spend |
| `spent` | monotonically increasing; decrements refused |
| Exhaustion | park + one `T2` notice + a **new authorization** to resume |
| Pause / cancel | durable, unlike today's SSE abort — survives restart and redeploy |
| Consecutive failures | park permanently past `maxConsecutiveFailures`; no retry storms |
| Scope expiry | `scope_expired` parks the goal; expired grants cannot authorize anything |
| `sliceMs` | bounds one tick, so SIGTERM always has a window to land in |
| Outbox `mode` | `shadow` / `dry_run` / `live` — the gate between "designed" and "enabled" |

Every one of these needs a test asserting the loop **stopped**, not that it logged.

#### 4.10.1 Concrete default ceilings (and the arithmetic behind them)

Decided: I pick them. The principle — **you should be annoyed by hitting a ceiling,
not harmed.** Every number below is derived, not vibes, and each carries the failure
it is actually guarding against.

**Unit cost, from `server/meta/rates.js`.** A resident step is *one* structured call
(§4.3), not a council turn. With a ~4 k-token prompt (notes digest + manifest) and a
~500-token completion:

| Model | Prompt rate | Completion rate | Cost/step |
|---|---|---|---|
| `openai/gpt-oss-20b` (current default) | $0.05/1M | $0.20/1M | **~$0.0003** |
| `gpt-4o-mini` | $0.15/1M | $0.60/1M | **~$0.0009** |

**Projected normal use**, five residents waking hourly, each running a 5-step slice:
600 steps/day → **~$0.18/day** on `gpt-oss-20b`, **~$0.54/day** on `gpt-4o-mini` —
about **$5–16/month**. Council turns you ask for yourself are the app's existing
cost, not autonomy's.

**The defaults:**

| Setting | Default | Guards against | Derivation |
|---|---|---|---|
| `COGNOS_AUTONOMY_MAX_DAILY_USD` | **2.00** | the blowout | ~2,200–6,600 steps/day. 4–11× projected use. A single runaway loop is caught in hours, and the damage is a rounding error. |
| `COGNOS_AUTONOMY_MAX_MONTHLY_USD` | **25.00** | the slow leak | ~1.5–5× projected use. **Daily and monthly catch different failures** — daily catches one bad day; monthly catches a small leak repeated for thirty days, which a daily ceiling cannot see. |
| `COGNOS_AUTONOMY_MAX_ACTIVE_GOALS` | **10** | accumulation | More non-parked goals than this means goals are being created faster than they finish. |
| `COGNOS_AUTONOMY_MAX_GOALS_PER_TICK` | **3** | DB starvation | With `DATABASE_POOL_MAX=12`: 3 ticks + 8 chat connections + 1 spare. **Tick concurrency and pool size must move together** (B2 in §14). |
| `GOAL_BUDGET.maxSteps` | **500** | the endless goal | ~5 days of hourly 5-step slices for one goal. |
| `GOAL_BUDGET.maxTokensIn` | **5,000,000** | context bloat | ≈$0.75 at `gpt-4o-mini`; consistent with the cost ceiling rather than a second, contradictory limit. |
| `GOAL_BUDGET.maxTokensOut` | **500,000** | verbosity | ≈$0.30. |
| `GOAL_BUDGET.maxCostUsd` | **1.00** | single-goal runaway | Half the daily ceiling, so one goal cannot eat the whole day. |
| `GOAL_BUDGET.maxExternalEffects` | **25** (lifetime) | trigger spam | A webhook is a trigger, not a message (§4.7.1). |
| `GOAL_BUDGET.maxNoticesPerDay` | **3** | narration | More than three interruptions a day from one goal means it is narrating, not reporting. |
| `GOAL_BUDGET.goalTtlMs` | **14 days** | the immortal goal | A goal that is still running after two weeks needs a fresh authorization, not more time. |
| `maxConsecutiveFailures` | **3** | retry storms | Third consecutive failure parks permanently. |

**The shadow-mode gate (D3 — named before a corpus exists):**

| Setting | Default | Why |
|---|---|---|
| `minShadowSamples` | **25** | Matches the instinct behind `server/meta/latency.js`'s 20-sample gate, with a little more room. |
| `maxAcceptableFalseReleases` | **0** | **Zero tolerance, and this is the real gate.** Any verdict that says *release* but that a human reviewer would have refused is a blocker — not a statistic to be averaged. A count alone can be rationalised; a single false release cannot. |
| `minRefusalPrecision` (T5) | **1.0** | For irreversible effects the gate is perfection or nothing. |

**Why these are defaults and not recommendations.** They are sized so that the
*first* thing to happen is a parked goal and a templated notice — annoying, cheap,
and informative, in that order. Every one is a config constant in the same style as
`server/config.js` (editable constants, not env-var soup), and every one is
overridable per goal within the workspace ceiling — never above it.

### 4.11 Observability and UI

```
GET  /api/autonomy/status                 enabled, mode, rung, heartbeat state, active goals
GET  /api/autonomy/agents                 residents + budgets + allowlists
POST /api/autonomy/agents                 create a resident
PATCH /api/autonomy/agents/:id            new brief VERSION (never an edit)
GET  /api/autonomy/goals                  list + status + budget gauge + nextRunAt
GET  /api/autonomy/goals/:id              goal + notes + events + outbox + spend
POST /api/autonomy/goals                  create → awaiting_authorization
POST /api/autonomy/goals/:id/decision     authorize | decline | pause | resume | cancel
GET  /api/autonomy/notices                unread templated notices
POST /api/autonomy/notices/:id/ack
GET  /api/autonomy/outbox                 staged / refused / released / shadowed
POST /api/autonomy/outbox/:id/decision    approve | refuse | revert   (T4/T5)
GET  /api/autonomy/ticks                  tick history: duration, goals, spend, failures
POST /api/autonomy/tick                   run one slice (ops / cron fallback)
GET  /api/agent/tools                     ← extended with the skill registry + tiers
```

UI:

- **New `/autonomy` page.** Residents, goal cards (status, budget gauge, next run,
  last tick, park reason), notices inbox, T4/T5 approvals queue, outbox with
  `shadow` verdicts, tick log, global kill switch.
- **Sidebar** groups **one thread per resident** under a collapsible **Autonomy**
  section (§4.9.1), the way projects already group conversations.
- **Chat** gains a **Goal Card** (authorize/decline) beside `ResearchDecisionCard`,
  templated notice banners, and "Ask COGNOS about this goal."
- **`/system`** gains an Autonomy tab: ticks, spend, refusals, kill-switch state.
- **`/about` + `/api/identity`** change only in that `autonomousBackgroundTasks` and
  `consequentialAgentWrites` move from *unsupported* to *runtime-switch* — reported
  as **off** until a rung is actually enabled. `pin.truthful_self_model` demands
  exactly this: state limits plainly, distinguish built-in from available.

### 4.12 Inbound messaging and the headless turn (Rung 5)

This is the piece that makes COGNOS feel like OpenClaw: you message it, it answers,
and it does not need your browser open. It is also the piece this design most
deliberately deferred, because it is the only feature that puts COGNOS prose outside
a browser session.

#### 4.12.1 The problem, stated precisely

`pin.single_send_path` says there is one path from a user's message to a user's
answer, and today that path is physically welded to an SSE connection:
`server/routes/chat.js` builds an `AbortController` from `res.on("close")`, and
`releaseApprovedText()` pushes approved chunks to `onToken`.

But look at what the SSE connection actually provides: **(a) a transport for approved
text, and (b) a cancellation signal.** It does not provide the governance. The Critic
and the Governor have already ruled *before* `releaseApprovedText()` is called. The
stream is the last mile, not the gate.

So the honest question is not "can we add a second path?" It is: **is the invariant
one transport, or one governance?**

It is one governance. The law exists so that no text reaches a user without passing
the Critic and the Governor. A headless run that executes the *identical*
`runCouncilTurn` — same six operators, same Critic thresholds, same Governor
rulebook, same revision counts, same veto semantics, same `releaseApprovedText`
boundary — satisfies the purpose of the law and violates only its letter.

#### 4.12.2 Not a second council. The same council with a second sink.

```
inbound message
   ├─ verify HMAC, timestamp window, nonce dedupe
   ├─ bind channel → conversation (stored row, never derived from payload text)
   ├─ snapshot the text as an IMMUTABLE SOURCE with risk flags (untrusted evidence)
   ├─ append it to the conversation as a user message, labelled inbound
   │
   ├─ classify: question | work-request
   │      question      → HEADLESS TURN
   │      work-request  → GOAL PROPOSAL → awaiting_authorization (in app, never here)
   │
   └─ HEADLESS TURN
        runCouncilTurn(..., { onToken: null, sink: "effect" })
          identical pipeline → Critic → Governor
          vetoed?  → discard. digest only. nothing delivered. nothing stored.
          approved → stage effect: deliver_answer → ACTION GOVERNOR → webhook.post
```

The single most important property: **this is not a parallel implementation.** It is
the same function with a different sink. There is no "quick model call" shortcut, no
reduced pipeline, and no skipped Critic to save latency on a chat app.

Consequences that follow automatically:

- The Governor's veto keeps its teeth: vetoed text is never delivered and never
  stored (`pin.veto_integrity` completely intact).
- Memory extraction, summarization, knowledge projection and telemetry run as they
  do today. `telemetry_runs.conversation_id` is set, so an inbound turn is
  indistinguishable in the record from a browser turn except for its `origin`.
- Council traces persist on the message row, so the conversation reads identically
  when you open it in the app.

#### 4.12.3 The new invariant: a release sink

> **Amend `pin.single_send_path` (law layer 1.4.0):** *"There is exactly one
> **governance** path from a user's message to a user's answer: `runCouncilTurn`,
> ending at the Governor and the single approved-text release boundary. **Approved**
> text may be carried to the user by the originating SSE stream, or — for a headless
> turn — by one staged effect to a destination the conversation's scope authorizes.
> No subsystem may produce user-facing text by any other means, and no text that has
> not passed the Critic and the Governor may enter any sink."*

> **New law `pin.headless_turn_equivalence`:** *"A turn initiated without a browser
> session executes the identical `runCouncilTurn` pipeline, with identical Critic and
> Governor stages, thresholds, revision counts, veto semantics and post-turn
> knowledge writes. Its approved text is released only as a staged effect to a
> destination authorized for that conversation. A vetoed draft is never delivered and
> never stored; it is represented by its length and digest alone."*

#### 4.12.4 Inbound is the highest-risk text in the system

Anyone who can POST to the endpoint can attempt to instruct COGNOS.

| Threat | Control |
|---|---|
| Forged sender | HMAC-SHA256 over the raw body with a channel secret from env. Unsigned or mismatched → 401, no record beyond a rejection counter. |
| Replay | Timestamp window (±5 min) plus a nonce store; a repeated nonce is rejected and recorded. |
| Injection | The body is stored as an **immutable source snapshot** and screened by the same injection patterns as a document (`server/sources/`). Flags become `risk_flags`; text is never silently rewritten. |
| Instruction smuggling | Inbound text is **evidence, never instructions** — labelled untrusted in the council prompt exactly as sources are. It cannot name a URL the goal opens, cannot select a skill, cannot authorize an effect, cannot raise a budget. |
| Flooding | Per-channel rate limit; excess returns 429 and records a row. |
| Conversation hijack | Channel → conversation binding is a **stored row**, never derived from payload text. |
| Body size | Hard cap; oversize → 413. |

#### 4.12.5 The rule that kills the injection-to-action chain

> **Authorization may never originate from the same untrusted channel as the
> request.**

- An inbound message that asks a **question** gets a governed answer.
- An inbound message that requests **work** creates a **goal proposal**, parked
  `awaiting_authorization`. It is authorized in the app — or not at all.
- An inbound "yes, go ahead" authorizes **nothing**.

Without that rule, prompt injection via a messaging app becomes an authorized
action, and the entire approval barrier in §4.7 is worthless. With it, the worst an
attacker can obtain is a governed answer to a question they asked — which is what
any user of that channel could obtain anyway.

**But that makes remote authorization impossible,** which is most of the point of
messaging your agent. The fix is a **pairing token**:

1. The app mints a signed, single-use, scope-bound token:
   `{ goalId, scopeSha256, budgetSha256, nonce, expiresAtMs }` + HMAC with a server
   secret.
2. You send it into the channel as an ordinary message.
3. The inbound handler verifies the signature, checks expiry and single-use, and
   **consumes** it — appending a `goal_authorizations` row with
   `decision_source: "pairing_token"`, recording that the authorization itself
   originated in the app, not in the channel.

The barrier survives (authorization is still app-originated) and the UX works from a
phone. The token never grants anything beyond the exact scope it was minted for.

#### 4.12.6 Delivery

The approved reply goes out through the T4 `webhook.post` adapter (§4.7.1) to the
channel's bound endpoint, with:

- `idempotency_key = sha256(conversation_id, inbound_message_id)`, so a retry cannot
  double-reply;
- `mode: "shadow"` first — replies are composed, judged and recorded but not sent,
  until the verdict corpus justifies `live` (the same discipline as Rung 4);
- the reply text stored on the assistant message row exactly as a browser turn
  stores it, so the transcript is complete either way.

**Streaming into a channel** (progressive Slack message updates) is deliberately out
of scope for the first cut. It would be safe — the text is post-Governor — but it
adds a partial-delivery state machine for no user-visible benefit at this stage.

#### 4.12.7 The honest limit this introduces

`pin.no_auth` means there are no accounts. A bound channel maps to a conversation in
the single workspace. **The channel is the credential:** anyone who can message it
can talk to COGNOS, read its answers, and consume its budget.

That is a real change to the deployment's security posture, and the manifest must
say it in plain words. It is acceptable for a single-operator, self-hosted
deployment with a private channel. It is not acceptable for anything shared, and the
design should not pretend otherwise.

#### 4.12.8 New schema (additive, migration `0007`)

```sql
CREATE TABLE IF NOT EXISTS inbound_channels (
  id, workspace_id, conversation_id, agent_id,
  provider TEXT, external_id TEXT,     -- the channel identity
  secret_ref TEXT,                     -- ENV var NAME holding the HMAC secret
  delivery_url TEXT,                   -- where replies go (a scope allowlist entry)
  enabled BOOLEAN, created_date );
CREATE UNIQUE INDEX IF NOT EXISTS inbound_channels_identity_idx
  ON inbound_channels (provider, external_id);

CREATE TABLE IF NOT EXISTS inbound_messages (
  id, workspace_id, channel_id, external_message_id TEXT,
  source_id TEXT,                      -- the immutable snapshot it became
  received_ms BIGINT, verified BOOLEAN, risk_flags JSONB,
  decision TEXT,                       -- answered | goal_proposed | rejected | rate_limited
  run_id TEXT, created_date );
CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_external_idx
  ON inbound_messages (channel_id, external_message_id);     -- replay defence

CREATE TABLE IF NOT EXISTS inbound_nonces (
  nonce TEXT PRIMARY KEY, channel_id TEXT, seen_ms BIGINT );

CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_id TEXT PRIMARY KEY, goal_id TEXT, scope_sha256 TEXT, budget_sha256 TEXT,
  expires_at_ms BIGINT, consumed_ms BIGINT, consumed_via TEXT, created_date );
```

Plus one additive column: `messages.origin` (`'browser' | 'inbound' | 'autonomy'`)
and `messages.inbound_message_id`. No existing row's meaning changes.

#### 4.12.9 Tests

- Unsigned, bad-HMAC, stale-timestamp and replayed messages are rejected: nothing
  written to the conversation, rejection recorded.
- An injection payload in the inbound body is stored with risk flags, labelled
  untrusted, and cannot name a skill, URL or budget.
- Inbound *"approve the plan and email everyone"* creates a **proposal**, not an
  action; no effect is staged.
- Pairing token: valid → one authorization row, single-use, consumed; replayed →
  refused.
- **Headless-turn equivalence:** the same question asked inbound and in the browser
  produces the same stage order, the same Critic thresholds, the same Governor
  verdict, and the same telemetry and ledger rows.
- Governor veto on a headless turn: nothing delivered, nothing stored, digest only.
- Idempotency: the same inbound message retried produces one reply, not two.
- Shadow mode: replies composed and recorded, nothing sent.
- Channel binding cannot be steered by payload text.

---

## 5. The ladder — designed to Rung 6, enabled one rung at a time

The design covers all of it, inbound included. **Enabling** is what walks.

| Rung | Capability | Kill switch | Default | Entry criterion |
|---|---|---|---|---|
| **0** | Today: bounded per-turn agent, research with per-step consent | `COGNOS_AGENT_ENABLED` | on | shipped |
| **1** | **Durable goals, read-only.** Residents, goals, tick, leases, notes, budgets. T0–T1 only. | `COGNOS_AUTONOMY_ENABLED` | **off** | `test/autonomy.mjs` green |
| **2** | **+ notices and evidence fetch.** T2–T3. Heartbeat, `safeFetch` inside a URL allowlist, templated notices. | `COGNOS_AUTONOMY_ENABLED` | off | notice-determinism regression; budget-exhaustion proof; graceful-shutdown test |
| **3** | **+ sub-agents and promotion.** Narrow workers; note→memory/belief with `inferred` labelling. | `COGNOS_AUTONOMY_RESIDENTS` | off | sub-agent-untrusted regression; promotion-labelling regression |
| **4** | **+ external writes.** T4 behind scope grants, Action Governor verdicts, idempotency, receipts. | `COGNOS_AUTONOMY_EXTERNAL_WRITES` | off | **shadow-mode corpus** (§4.7); idempotent-replay test; reversal-as-new-row test; separate security review |
| **5** | **+ inbound messaging.** Bidirectional: channels, headless turn, governed replies, pairing tokens (§4.12). | `COGNOS_INBOUND_ENABLED` | off | headless-turn-equivalence suite; injection-to-action regression; shadow corpus for replies; explicit acknowledgement that *the channel is the credential* |
| **6** | **+ irreversible acts.** T5, one-by-one human approval, never class-authorized. | `COGNOS_AUTONOMY_IRREVERSIBLE` | off | explicit operator sign-off |

**Why inbound sits below irreversible acts.** A single irreversible effect is a
bigger *consequence* than one reply. But inbound is a bigger change to the *product*:
it decides who COGNOS talks to, where its voice appears, and what text can leave a
browser session. Consequence and identity are different axes, and identity is the one
this codebase governs hardest.

Rungs 4 and 5 also require **shadow mode first**: run `mode: "shadow"` until the
verdict corpus justifies `live`, and record that corpus as the evidence row.

---

## 6. What changes in the law layer

Laws are code. Changing one is a reviewed commit with a `LAW_LAYER_VERSION` bump —
existing convention (1.1.0 → 1.2.0 → 1.3.0). This is **1.4.0**.

**Amended — `pin.agent_bounded`.** Its statement already points at this design; the
`forbids` list is too blunt to distinguish *staging* from *releasing*.

> **Statement (extended):** "Agent mode is a non-council subsystem with typed
> tools, explicit per-turn or per-goal authorization, finite budgets, cancellation,
> and an append-only action record. Autonomous action is permitted only as a
> **staged effect** in the outbox, released solely inside a recorded scope by a
> deterministic Action Governor verdict. Staging is not acting."
>
> **`forbids`:** `["unbounded loops", "an unreviewed write path", "releasing an
> effect without a recorded scope and an Action Governor verdict", "a goal widening
> its own scope or budget", "hidden tool use", "agent answer channel", "agent bypass
> of the Governor"]`

**Amended — `pin.single_send_path`.** Restated as one *governance* path with two
possible transports, and narrowed to name what it always protected.

> **Statement (replaced):** "There is exactly one **governance** path from a user's
> message to a user's answer: `runCouncilTurn`, ending at the Governor and the single
> approved-text release boundary. **Approved** text may be carried to the user by the
> originating SSE stream, or — for a headless turn — by one staged effect to a
> destination the conversation's scope authorizes. No subsystem may produce
> user-facing text by any other means, and no text that has not passed the Critic and
> the Governor may enter any sink. A goal may also surface a **notice** — a
> deterministic rendering of stored records through a fixed template, containing no
> model-generated text. A notice is not an answer."
>
> **`forbids`:** `["a second chat route", "telemetry or events addressing the user
> directly", "a parallel answer path", "a reduced or shortened council pipeline",
> "model-generated text reaching the user outside the council"]`

**New laws:**

| id | name | statement (draft) |
|---|---|---|
| `pin.goal_scope_immutable` | A goal cannot promote itself | A goal's skills, scope and budgets are fixed at authorization. It may not widen its scope, raise its budget, add a skill, or extend its expiry; any of those is a **new** authorization recorded as a new row. |
| `pin.notice_deterministic` | Notices carry no model text | A notice renders stored records through a fixed template. Any composed sentence the user reads is produced by the council and released by the Governor. |
| `pin.effect_staged` | Effects are staged, then released | Every effect with tier ≥ T2 is staged in the outbox with a typed payload, an idempotency key and an Action Governor verdict before release. Release requires an unexpired scope covering that effect class and destination. Reversal is a new row. |
| `pin.subagent_untrusted` | Our own workers are evidence, not authority | A sub-agent's report is evidence with provenance. No sub-agent output may address the user, widen a goal's scope, or claim a capability the registry does not define. |
| `pin.resident_brief_subordinate` | A brief is operating text, never identity | A resident's brief shapes what it works on and how it reports. It can never alter the canonical self-model, grant a skill beyond its allowlist, raise a budget, or authorize an effect tier. Briefs are versioned; a change is a new row. |
| `pin.headless_turn_equivalence` | A turn without a browser is still the same turn | A turn initiated without a browser session executes the identical `runCouncilTurn` pipeline, with identical Critic and Governor stages, thresholds, revision counts, veto semantics and post-turn knowledge writes. Its approved text is released only as a staged effect to a destination authorized for that conversation. A vetoed draft is never delivered and never stored; it is represented by its length and digest alone. |
| `pin.channel_authorization` | Authorization never comes from the channel | A goal may be authorized only from the app surface or a pairing token minted there. An inbound message may ask a question or propose work; it can never authorize, widen, or approve, regardless of what its text claims. |
| `pin.autonomy_attributable` | Nothing autonomous is anonymous | Every autonomous model call, step, tick, effect and notice is attributable to an agent id, goal id, tick id and skill id, and visible through the read-only surfaces. |
| `phase19.autonomy_default_off` | Autonomy is opt-in per rung | Durable autonomy is disabled by default. Each rung requires its kill switch explicitly enabled, its regression suite passing, and an evidence record before it is justified. |

**New Policy Engine gated actions:** `create_resident`, `create_goal`,
`widen_goal_scope`, `raise_goal_budget`, `enable_skill`, `grant_goal_scope`,
`enable_outbound_channel`, `set_autonomy_rung`. Note the boundary: **the Policy
Engine judges architectural adaptations; the Action Governor judges individual
effects.** Different questions; never merged.

**Identity manifest** changes, and only these: `unsupported.autonomousBackgroundTasks`
and `unsupported.consequentialAgentWrites` become `runtime_switch` reported honestly
as off; `turnFlow` gains a step for authorized goals advancing on their own schedule
and reporting through notices; `boundaries` states that autonomous work is off unless
an operator enables a rung. All code-owned, under `pin.truthful_self_model`.

---

## 7. Schema — additive, migration `0006`

```sql
-- All CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- Nothing dropped, renamed, truncated or rewritten (pin.additive_schema).

CREATE TABLE IF NOT EXISTS autonomy_agents (        -- §4.1
  id, workspace_id, name, slug, purpose, brief, brief_version INTEGER,
  skill_allowlist JSONB, conversation_id TEXT, default_scope JSONB, default_budgets JSONB,
  heartbeat_interval_ms BIGINT, enabled BOOLEAN, created_date, updated_date );

CREATE TABLE IF NOT EXISTS autonomy_goals ( ...as §4.2... );
CREATE INDEX IF NOT EXISTS autonomy_goals_due_idx
  ON autonomy_goals (status, schedule->>'nextRunAtMs');   -- the due-goal scan

CREATE TABLE IF NOT EXISTS goal_events (            -- append-only, mirrors agent_events
  id, seq BIGSERIAL, goal_id, agent_id, step_id, tick_id, event_type,
  from_status, to_status, detail JSONB, ts_ms, created_date );

CREATE TABLE IF NOT EXISTS goal_steps (             -- idempotent, mirrors agent_steps
  id, goal_id, ordinal, skill_id, tier, status,
  input JSONB, output JSONB, error_message TEXT,
  idempotency_key TEXT, started_ms, ended_ms, created_date );
CREATE UNIQUE INDEX IF NOT EXISTS goal_steps_idem_idx ON goal_steps (idempotency_key);

CREATE TABLE IF NOT EXISTS goal_notes ( ...as §4.4... );

CREATE TABLE IF NOT EXISTS goal_authorizations (    -- mirrors agent_approvals
  id, goal_id, scope_sha256, budget_sha256, decision,
  reason, decided_ms, expires_at_ms, created_date );

CREATE TABLE IF NOT EXISTS autonomy_outbox ( ...as §4.7... );
CREATE UNIQUE INDEX IF NOT EXISTS autonomy_outbox_idem_idx ON autonomy_outbox (idempotency_key);
CREATE TABLE IF NOT EXISTS outbox_events (
  id, seq BIGSERIAL, outbox_id, from_status, to_status, detail JSONB, ts_ms, created_date );
CREATE TABLE IF NOT EXISTS autonomy_ticks (
  id, workspace_id, worker_id, started_ms, ended_ms, duration_ms,
  goals_claimed, steps_executed, effects_staged, effects_released,
  effects_refused, model_calls, tokens_total, cost_usd, detail JSONB, created_date );
```

The `messages` additive columns and `autonomy_agents.conversation_id` are specified in
§4.9.1 (one conversation per resident).

`telemetry_runs.conversation_id` is already nullable: a tick records its own run row
with `run_id = "goal:<id>:tick:<n>"` and `conversation_id NULL`, so autonomous model
calls are metered by the same machinery as council calls.

New `knowledge_events` transitions: `resident_created`, `resident_brief_versioned`,
`goal_created`, `goal_authorized`, `goal_tick`, `goal_parked`, `goal_completed`,
`goal_cancelled`, `note_appended`, `note_promoted`, `effect_staged`,
`effect_released`, `effect_refused`. Append-only, replayable at
`/api/knowledge/state/...?at=`.

`npm run migrations:generate` writes `migrations/0006_phase19_autonomy.sql` from
`server/db/schema.js`; `npm run smoke` asserts file and string have not drifted. The
existing convention handles all of this.

---

## 8. Tests — `test/autonomy.mjs`

Real app + PGlite + scriptable mock model via `test/harness.mjs`, with an
**injectable clock** so "three days later" is one call.

1. An unauthorized goal executes nothing — no model calls, effects, notices.
2. A goal survives a simulated crash mid-step: the lease expires, the next tick
   reclaims it, and the idempotent step is **not** re-executed.
3. Slice budget holds: a tick stops at `sliceMs` / `maxStepsPerTick` and leaves the
   goal `active` with a future `nextRunAt`.
4. Budget exhaustion parks the goal; resuming requires a **new** authorization row.
5. `COGNOS_AUTONOMY_ENABLED=false` freezes everything: zero model calls, effects,
   notices; every goal parked.
6. A skill outside the allowlist is refused **even when the mock planner demands
   it**, and the refusal is a row.
7. A resident brief claiming new capabilities grants none; the allowlist row wins.
8. Outbox: no granted scope → refused; same effect after a grant → released;
   duplicate `idempotency_key` → verdict replayed, **not double-executed**.
9. T5 without a human approval row naming that exact outbox id → refused.
10. Shadow mode produces verdicts and rows and **delivers nothing**.
10a. **Webhook gates:** a URL off the destination allowlist → refused.
10b. **Outbound SSRF:** `http://169.254.169.254/`, `http://10.0.0.5/`,
     `http://localhost:8080/` and a public URL that 302s to a private address are all
     refused, with the rule id recorded.
10c. **Secrets:** a payload containing `secret_ref` stores the *name* only; the mock
     env value appears in no outbox row, receipt, ledger event or telemetry record.
     A header named `Authorization` supplied in args → refused.
10d. **Idempotency:** the same `webhook.post` replayed after a crash produces one
     delivery, not two; the sink records a single `X-COGNOS-Idempotency-Key`.
10e. **Receipt:** a sink that echoes a secret in its response body stores only a
     digest — the secret is absent from every row.
10f. **Rate:** `maxPerDay` reached → refused; the goal parks rather than queueing
     silently.
11. Sub-agent output enters as evidence with provenance and cannot widen scope or
    budget.
12. **Notice determinism:** with a mock model emitting adversarial text, no notice
    payload, outbox release, or SSE `token` frame contains a model-generated word.
13. Promotion labelling: a promoted note carries `evidence_level: "inferred"` and
    `origin: "autonomy_goal:<id>"` — never `direct`.
14. Cost: mock usage drives `spent.costUsd` past `maxCostUsd` and the goal parks.
15. Workspace ceiling: twenty residents cannot exceed `COGNOS_AUTONOMY_MAX_*`.
16. Attribution: every `goal_events` row has `agent_id` + `goal_id` + `tick_id`.
17. **Graceful shutdown (Railway):** SIGTERM mid-tick parks the goal, releases the
    lease, and ends the pool; a second tick after restart resumes cleanly.
18. **Regressions:** `POST /api/chat` remains the only route that emits answer
    tokens; the council still has exactly six operators; the Governor still vetoes;
    `npm test` (voice + performance + sources-agent + phase18 + identity +
    integrity + smoke) unchanged and green.

#### 8.1 Fear → test coverage (decided: all four, equally)

You named four failures you are most afraid of. Here is what guards each, so the
coverage is visible rather than assumed.

| Fear | Guarding tests | Verdict |
|---|---|---|
| **Runaway spend** | 3 (slice budget), 4 (exhaustion parks), 5 (kill switch), 14 (cost parks), 15 (workspace ceiling), 10f (effect rate) | **Well covered** — six independent brakes, each asserted to *stop* rather than log. |
| **A secret leaving in a webhook payload** | 10c (`secret_ref` stores the name only; `Authorization` in args refused), 10e (receipt is digest-only), 10b (outbound SSRF) | **Covered, with a gap** — nothing yet asserts that a *source document's* credential text cannot reach a payload via a note. Needs a test: plant a key in a fixture source, run a goal over it, assert it appears in no outbox row. |
| **A wrong fact promoted to memory** | 13 (promotion is `inferred` + `origin`, never `direct`), 11 (sub-agent output is evidence) | **Covered, with a gap** — nothing yet asserts a *false* finding cannot be promoted. Needs a test: a mock model asserts a falsehood confidently, the goal promotes it, and the memory row still carries `evidence_level: "inferred"` and the goal id. |
| **Ungoverned prose reaching the user** | 12 (notice determinism), 18 (chat is the only token-emitting route), §4.12.9 (headless-turn equivalence, veto on headless) | **Thinnest of the four** — because the inbound tests live in a separate file that does not exist yet. **They need their own suite: `test/inbound.mjs`.** |

Two gaps and one thin spot, named rather than papered over. The three extra tests
(secret-in-note, false-promotion, and the whole inbound suite) should be written in
the phase that introduces the risk — not discovered afterwards.

---

## 9. Railway deployment notes

| Item | Action |
|---|---|
| Build/start | Nixpacks detects Node; `npm run build` then `npm start` (`server/serve.js`). No Dockerfile needed, but add one if you want a pinned build. |
| Static SPA | `server/index.js` serves `dist/` whenever `process.env.VERCEL` is unset — already correct on Railway. |
| Database | Railway Postgres URL is non-Neon, so `server/db.js` already selects `pg.Pool`. Set `DATABASE_POOL_MAX` above the default 5 (a resident loop + concurrent chat turns will contend) and cap tick concurrency so autonomy can never starve the council. |
| **Graceful shutdown** | **New.** `serve.js` needs `SIGTERM`/`SIGINT`: stop heartbeat → finish or park the in-flight tick → release leases → `await closeDatabase()` (already exported by `server/db.js`, currently used only by tests). Railway's redeploy sends SIGTERM before SIGKILL; without this, every deploy is a crash. |
| Gate | Set `COGNOS_RUNTIME_SECRET` — the app is publicly reachable. Every `/api/autonomy/*` route sits behind the same gate as everything else. |
| Always-on | Keep the service awake. Optional external cron → `POST /api/autonomy/tick` as a fallback starter. |
| Secrets | All adapter credentials stay in environment variables (`pin.secrets_env_only`). No `VITE_*` variables exist by construction. |
| `.env.example` | Gains `COGNOS_AUTONOMY_ENABLED`, `COGNOS_AUTONOMY_RESIDENTS`, `COGNOS_AUTONOMY_EXTERNAL_WRITES`, `COGNOS_AUTONOMY_IRREVERSIBLE`, `COGNOS_AUTONOMY_OUTBOX_MODE`, `COGNOS_AUTONOMY_MAX_*`, `DATABASE_POOL_MAX`. |
| `DEPLOY.md` | Gains a Railway section next to the existing Neon + Vercel guidance. |

---

## 10. Build order

One migration, one law bump, one test file, one identity bump, one
`DIVERGENCES.md` section per phase — the rhythm this repo already keeps.

| Phase | Delivers | Enables |
|---|---|---|
| **19** | **BUILT.** Residents, goals, tick + lease, notes, budgets, outbox for T0–T2, Action Governor, heartbeat + graceful shutdown, the Autonomy page, laws 1.4.0, `test/autonomy.mjs` (40) | **Rung 1–2**, default off |
| **20** | Sub-agents, promotion path, Goal Card in chat, T3 evidence fetch, `[goal_…:nN]` locators + Governor extension | **Rung 3**, default off |
| **21** | `webhook.post` (§4.7.1) + delivery adapter, destination allowlists, outbound-SSRF gate, `secret_ref` signing, Action Governor in **shadow**, receipts, reversal | shadow corpus; still not live |
| **22** | Outbox → `live` based on the shadow evidence record; T5 with per-effect human approval | **Rung 4–5**, default off, separate security review |
| **23** | Inbound messaging (§4.12): channels, HMAC verification, replay defence, headless turn, pairing tokens, shadow-mode replies | **Rung 5**, default off; requires accepting that the channel is the credential |

---

## 11. What this design refuses to do

- **No autonomous model prose to the user.** Ever. Notices are templates.
- **No seventh council seat.** Sub-agents work; they do not vote or answer.
- **No self-granted capability.** Skills are code; scopes are rows; widening is a
  new authorization.
- **No unbounded loop.** Steps, tokens, cost, wall clock and failures are spendable
  currency; exhaustion parks.
- **No laundering notes into knowledge.** Promotion is labelled, evidence-graded
  `inferred`, traceable to a goal id.
- **No bypass of `safeFetch`.** Autonomous reads use the same DNS-pinned,
  SSRF-guarded fetcher.
- **No editing history.** Outbox reversal is a new row; goal cancellation is a
  transition; a brief change is a new version.
- **No silent background work.** Every tick, spend, refusal and notice is visible on
  `/autonomy` and in the ledger. If it ran while you were away, you can audit it.
- **No live architectural adaptation.** `phase15.observe_only` stays. The loop
  changes what work exists, never how the council thinks.
- **No new identity.** COGNOS stays COGNOS. Residents have briefs, not selves.

---

## 12. The short version

COGNOS is one of very few codebases where OpenClaw-class autonomy could be added
*without becoming a different product*, because the hard parts already exist: an
append-only ledger, replay, provenance, a deterministic final gate, an
evidence-first treatment of every ingested text, an evaluation habit, and a law
layer that refuses complexity it cannot justify.

What is missing is not governance. It is **duration**. Railway supplies the
duration. The design supplies the discipline: work runs for days, authority still
resolves in one deterministic instant — Governor for prose, Action Governor for
effects — and the agent's own output is just another kind of untrusted evidence the
council reasons over.

You get an agent that wakes up, works, remembers, reports, answers when you message
it, and asks before it touches anything. More autonomous than COGNOS today, and more
auditable than OpenClaw today — because every one of those verbs is a row you can
read.

---

## 13. Locked since the first draft

| Question | Answer | Where |
|---|---|---|
| Inbound messaging at all? | **Yes — Rung 5**, Phase 23, default off, shadow first | §4.12 |
| Build cadence? | **Straight through 19–21, gated on shadow** — nothing live until a corpus justifies it | §10 |
| Budget ceilings? | **Conservative defaults, derived** — $2/day, $25/month, 3 goals/tick | §4.10.1 |
| Primary risk? | **All four equally** — spend, secrets, false memory, ungoverned prose | §8.1 |
| First external write? | **Webhook** | §4.7.1 |

## 13b. Still open

These change the design, but none of them block Phase 19 from starting. They are
argued in full in §14 — this is the index.

**Blocks nothing now, but answer before Phase 20:**
- **A3** — what the first resident actually watches (you deferred this to
  "build the mechanism first", which is fair, but a resident needs a success
  condition before it can be evaluated).

**Falsify these before trusting the design:**
- **B1** — is single-operator permanent, or a coincidence? Determines whether
  residents ever need a principal.
- **B2** — tick concurrency and `DATABASE_POOL_MAX` must move together.
- **B3** — resident steps must stay single structured calls, not council turns.
- **B4** — who reviews the law-layer 1.4.0 commit?

**Design tensions I flagged but did not resolve:**
- **C1** — may a note become a memory without a human click? (§4.4 says yes,
  `inferred` only.)
- **C2** — may a goal ask you a question? Interacts directly with
  `pin.notice_deterministic`.
- **C3** — shared memory or scoped per resident? §4.9.1 settles the *default*
  (scoped, per resident); whether a resident may ever write into the shared belief
  store is still open.
- **C4** — who arbitrates contradictory residents? Per-resident conversations mean
  isolation by default, so residents are *less* likely to notice disagreement.
  C4 is more acute than it was, not less. Still open.

**Operational:**
- **D1** — rollback is a brake, not a rewind. Is "read the ledger and live with it"
  acceptable?
- **D2** — alerting on parked goals is one line once Phase 21 exists. Want it?

**Decided:** first external write is **webhook** (§4.7.1). Email and file stay
unbuilt until a real use case names them.

**Now designed:** inbound messaging and the headless turn — §4.12, Rung 5. The
answer to "can COGNOS prose leave a browser session?" turned out to be yes, on one
condition: **not a second council — the same council with a second sink.** Three new
laws carry it (`pin.headless_turn_equivalence`, `pin.channel_authorization`, and the
restatement of `pin.single_send_path` as one governance path with two transports).

**Still open on inbound:** whether you want it at all. It is the single biggest
change to the deployment's security posture in this document, because
`pin.no_auth` means **the channel is the credential** — anyone who can message it can
talk to COGNOS, read its answers, and spend its budget. That is fine for a
single-operator self-hosted deployment with a private channel and unacceptable for
anything shared, and no amount of design makes it otherwise.

---

## 14. Questions to answer before building

Not a to-do list. These are the questions whose answers would **change the design**,
grouped by what they put at risk. Each carries why it matters and what a weak answer
looks like — because the failure mode of a design review is not a missing answer, it
is a confident answer that was never tested.

### A. Appetite and scope

**A1. Do you want inbound at all? — _answered: yes, Rung 5._**
The only feature that puts COGNOS prose outside a browser session, and the only one
that changes your security posture rather than your capability set.
*Weak answer:* "sure, eventually" — inbound is either a deliberate yes with the
channel-as-credential trade-off accepted, or it is not built. "Eventually" means it
gets built accidentally.

**A2. Build-and-use, or straight through? — _answered: straight through, gated on shadow._**
Rung 1–2 built and *used* before Phase 20 starts, or Phase 19–21 built in one pass
with rungs switched on as they land?
*Weak answer:* "straight through, it'll be faster" — the whole design rests on rungs
being *earned by evidence*. Building three phases without using one means the first
real evidence arrives after the most expensive code is written.

**A3. What does the first resident actually watch? — _deferred: build the mechanism first._**
Not "what could it do" — what is the one loop you would miss if it stopped?
*Weak answer:* "a general research assistant" — a goal with no falsifiable success
condition cannot be evaluated, cannot be budgeted, and cannot be trusted.

**A4. What are the actual numbers? — _answered: derived defaults, §4.10.1._**
Daily spend, monthly spend, concurrent goals, webhooks per day, notices per day.
*Weak answer:* "we'll tune it later" — the ceiling is the only control that holds
when the planner is the thing misbehaving. Pick numbers you would be annoyed but not
harmed by hitting.

### B. Assumptions the design makes — falsify these first

**B1. Is single-operator permanent?**
`pin.no_auth` plus residents plus inbound means every resident shares one memory, one
ledger, one channel credential. If this ever becomes shared, that is not a scaling
problem, it is a redesign.
*Weak answer:* "it's just me" — true today. Say whether it is a requirement or a
coincidence, because the answer determines whether residents need a principal.

**B2. Can one process actually hold both?**
The API and the heartbeat share a `pg.Pool` of `DATABASE_POOL_MAX` (default **5**).
A tick mid-step plus two concurrent chat turns is most of that pool.
*Weak answer:* "we'll raise the number" — raising it without capping tick concurrency
just moves the starvation. Both halves need to move together.

**B3. Have you priced a waking resident?**
A full council turn is 5–7 model calls. A resident waking hourly to run one is ~168
turns/day; on BluesMinds Free (300 requests/day) that is dead in under two days.
*Weak answer:* "it's a cheap model" — request *count* is the constraint, not cost per
token. Resident steps are single structured calls, not council turns, and the design
depends on you keeping it that way.

**B4. Who reviews the law-layer 1.4.0 commit?**
The design's integrity rests on laws being reviewed code changes. If the reviewer is
the author, `phase15.law_layer_immutable` is decorative.
*Weak answer:* "I'll be careful" — name a process (a second pair of eyes, a PR
template, a mandatory `DIVERGENCES.md` entry) or accept the reduction explicitly.

### C. Tensions I flagged but did not resolve

**C1. May a note become a memory without a human click?**
§4.4 allows promotion when a finding was carried into a Governor-approved answer,
labelled `inferred`, never `direct`. Tighten it to always-require-a-click?
*Weak answer:* "whatever's easier" — this is the exact channel through which an
autonomous loop could launder hunches into facts about you. Decide deliberately.

**C2. May a goal ask you a question?**
`blocked_on_evidence` is in the park reasons, but a question is *content*, and
content is what `pin.notice_deterministic` forbids in notices. Either questions are
templated choices ("pick one of these three sources"), or they wait for the
explicit-ask path, or the notice rule needs another carve-out.
*Weak answer:* "let it just ask" — that is how a second answer path arrives wearing a
question mark.

**C3. Do residents share memory, or get a scoped view?**
§4.1 assumed one workspace memory for all. A resident that reads every belief can be
polluted by another's bad notes — and can pollute them back.
*Weak answer:* "shared, they're all me" — the promotion path is already the weakest
link; multiply it by N residents writing into one belief store and measure the blast
radius before deciding.

**C4. Who arbitrates contradictory residents?**
The coherence monitor handles conflicting *beliefs*. It says nothing about two
residents reaching opposite conclusions from the same evidence.
*Weak answer:* "the council will figure it out" — only if the design routes
resident-vs-resident conflict there explicitly. Today it does not.

**C5. One conversation per resident, or a shared transcript? — _answered: one per resident, §4.9.1._**
Affects replay, the sidebar, and whether "Ask COGNOS about this" has an obvious home.
*Weak answer:* deferring this to implementation — it is a schema decision and
migration `0006` is the only cheap moment to make it.

### D. Operational readiness

**D1. What is the rollback story?**
The kill switch stops the loop. It does not undo what a resident already wrote,
promoted, or delivered. Is there a purge path, or is the answer "the ledger is
append-only, so you read what happened and live with it"?
*Weak answer:* assuming the kill switch is a rollback. It is a brake, not a rewind.

**D2. Do you want alerting?**
A goal parked on `error_backoff` for three days is invisible unless you open
`/autonomy`. A webhook alert is one line once Phase 21 exists — and it is the first
thing you would actually want the webhook for.
*Weak answer:* "I'll check the page" — you will not check the page.

**D3. How many shadow samples before `live`? — _answered: 25 samples, zero false releases, §4.10.1._**
§4.7 borrows the latency gate's instinct but not its number (20 samples, p50 ≥ 20%).
Name the threshold *before* you have a corpus, or you will rationalise whatever
number you happen to have.
*Weak answer:* "when it looks good" — that is not a gate, it is a mood.

**D4. What is the failure you are most afraid of? — _answered: all four equally, §8.1._**
The meta-question. Runaway spend? A leaked secret in a webhook payload? A wrong fact
promoted to memory and repeated for months? COGNOS saying something ungoverned to a
channel?
*Weak answer:* skipping it. Your answer here decides where the test suite spends its
effort, and it is the single cheapest way to make §8 honest rather than thorough.

---

### The four that gated code — all answered

1. **A1** inbound → **yes, Rung 5.** §4.12 is scheduled, not speculative.
2. **A2** cadence → **straight through 19–21, gated on shadow.** The evidence gate
   carries the risk that building ahead of usage normally adds.
3. **A4** ceilings → **conservative defaults, derived.** §4.10.1.
4. **D4** primary risk → **all four equally.** §8.1 maps coverage and names the gaps.

What remains is indexed in **§13b**. Nothing there blocks Phase 19 from starting;
**C5** (one conversation per resident, or shared?) is the only one with a deadline,
because migration `0006` is the only cheap moment to change it.
