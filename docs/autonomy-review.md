# Autonomy Layer Review — 2026-10-03

Scope: `server/autonomy/` (21 files, ~8,500 lines) — the agentic loop that does
bounded background work for Jeremy: goals with leases, a skill registry, an
outbox of staged effects judged by an Action Governor, an evidence gate that
makes live external writes *earned*, templated notices, a heartbeat, a
personality layer, and a conversational resident designer.

Three parallel read-only reviews covered the whole set (governance, outbox +
notifications, engine + config + settings). This doc consolidates their
findings, ranked. Line numbers refer to the pre-v40 tree.

The safety architecture is genuinely well-thought-out: refuse-by-default,
replay-safe, earned-not-enabled, honest receipts. The findings below are
places where the code doesn't live up to its own design — not places where
the design is wrong. **Governance keeps its full authority throughout.**

---

## High severity

### H1. A non-identity Content-Encoding wedges a live tick (`webhookPost.js:353`)
`response.destroy()` on an unexpected encoding emits neither `'error'` nor
`'end'`, so the `finish` guard never fires and the `pinnedTransport` promise
never settles. A webhook receiver answering with `Content-Encoding: gzip`
hangs `deliverWebhook` indefinitely — inside `decideEffect` (`outbox.js:447`)
in live mode, which wedges the tick. Fix: reject explicitly with a named rule
instead of bare-destroying.

### H2. The Governor throws instead of refusing on malformed config
`actionGovernor.js` promises "refusing by default, recording refusals as rows
instead of throwing." Two spots break it: `tierAllowed(tier, config)`
(`config.js:394`) does `config.builtTiers.includes(tier)` unguarded, called at
`actionGovernor.js:174`; `config.ceiling.maxDailyUsd` at line 481 is likewise
unguarded. Nothing wraps `judgeEffect` in try/catch (`outbox.js:343`,
`externalRead/Write/Irreversible.js`), so a malformed config propagates as a
throw instead of a verdict row. Same shape: `db.query` throws inside
`workspaceSpendToday` / `goalEffectsToday` / `goalNoticesToday` propagate,
even though null returns are already handled fail-closed
(`SPEND_UNVERIFIABLE` et al). Fix: guard config access with a
`CONFIG_UNREADABLE` rule; catch lookup throws and return null so the existing
fail-closed paths fire.

### H3. Swallowed lookup errors impersonate absence (`actionGovernor.js:395-398, 439-440`)
`db.RungEvidence.currentJustified(...).catch(() => null)` and
`db.EffectApproval.current(...).catch(() => null)` turn a database error into
"no evidence" / "no approval", and the refusal reasons then *assert the
negative* ("no recorded shadow corpus justifies a live release at this tier",
"no human approval row names this exact effect id"). A transient DB blip
becomes a recorded verdict claiming the corpus or the human approval doesn't
exist — the exact kind of misleading row this ledger exists to prevent. For T5
it can block a legitimately-approved release with a false reason. Fix: lookup
errors get their own rules (`EVIDENCE_UNREADABLE`, `APPROVAL_UNREADABLE`),
never an impersonation of absence.

### H4. Replayed released *search* is misreported as a refusal (`externalRead.js:93-101`)
The replay branch handles released-fetch and would_release, but a `released`
search row falls through to `effects.refused += 1` with
"read refused on replay". A genuine success is reported to the loop as a
refusal, and the tick's ceiling-vs-obstacle logic reads a garbage rule list.
Related: replayed `reverted` rows in all three `external*.js` files fall
through to the same "refused on replay" branch — a reverted effect is not a
refused one. Fix: handle released-search replay honestly (result not stored,
not re-fetched), and give `reverted` its own branch that doesn't bump
`refused`.

### H5. The `maxTokensOut` budget line can never fire (`config.js:216`, `tick.js:~443`, `subagent.js:258-261`)
`SPEND_BUDGET_KEYS` maps `tokensOut → maxTokensOut` and the default budget
sets `maxTokensOut: 500_000`, but nothing ever writes `spent.tokensOut`:
`runStep` bumps `tokensIn` with the recorder's *whole-call* token count, and
the subagent does the same. Output tokens are counted against the input line
and the output line is an inert guard — the "guard that cannot fire" defect
class this codebase otherwise fixes diligently. Fix: split in/out at the
accounting site once the recorder's fields are confirmed.

---

## Medium severity

- **M1. Empty body refused under the wrong rule name** (`actionGovernor.js:335-336`):
  `if (!bodyText.trim()) fail("BODY_TOO_LARGE", ...)` — a *missing* body is
  recorded as *too large*. Add a `BODY_REQUIRED` rule.
- **M2. "Today" and quiet hours use server-local time, not Jeremy's**
  (`actionGovernor.js:78, 103-104, 115-116`; `config.js:420-424`;
  `tick.js:124`). On a UTC host these are 4–5 hours off America/New_York:
  budget lines, the workspace ceiling, rate limits, and the quiet-hours brake
  all shift relative to his day. A goal could exhaust "today's" budget at 8 PM
  EDT and get a fresh one at 8 PM. Fix with one user-timezone day-boundary
  helper used everywhere.
- **M3. `auditRelease`'s grant check is looser than the Governor's matcher**
  (`evidenceGate.js:128-131` vs `scopeUrl.js:48-53`): the re-audit uses naive
  string-prefix matching while the live matcher enforces a segment boundary.
  A grant of `https://example.com/docs` lets the re-audit pass
  `https://example.com/docs2-evil` while the Governor would refuse it live —
  the audit can miss exactly the false releases it exists to catch. Fix: reuse
  the segment-boundary matcher.
- **M4. T5 re-judgment assumes an object verdict** (`outbox.js:361-364` reads
  `effect.verdict?.failed`, but `shadowCorpus` in the same file JSON-parses
  `row.verdict` because the DB may return a string). A string verdict makes a
  legitimately-approved T5 take the terminal-replay branch instead of being
  re-judged — the human-approval path fails closed silently. Fix: normalize
  the verdict (parse if string) before the check.
- **M5. `isTightening` ignores removed keys** (`authorize.js:43-52`): deleting a
  budget line passes as "tightening" while removing the cap. Fix: a missing key
  in `proposed` fails the tightening check.
- **M6. Effect counters double-count when a skill both self-reports and returns stages**
  (`tick.js:630-634` then `693-704`): nothing enforces the one-or-other
  assumption, so `effects`/`externalEffects` spend inflates — in the
  fail-closed direction, but corrupting the numbers rate limits are checked
  against. Fix: when stages were judged, ignore the self-report (or vice
  versa), and say which in a comment.
- **M7. Config refusals and the failure brake** (`tick.js:556-559` →
  `338-344`): a rung-gate/kill-switch/allowlist refusal sets `out.failed`,
  so three ticks of refusals park the goal as `error_backoff`. Considered
  changing this (refusals aren't transient failures), but **deliberately kept**:
  `test/autonomy.mjs` ("the planner cannot grant itself a skill the allowlist
  does not have") asserts that a repeated escalation attempt parks via the
  brake — that IS the anti-escalation property, and removing refusals from the
  counter would let an escalation loop burn model calls until budget
  exhaustion. The refusal reason is preserved on the step row and in the park
  detail; `error_backoff` is the coarse category, not a cover-up.
- **M8. `listSettingFlips` under-reports the audit trail**
  (`settings.js:~925-946`): queries only `action: "autonomy.enabled"`, so mode
  flips, auto-authorize flips, bypass flips, and all five rung flips never
  appear despite the docstring "The flips recorded for this workspace."
- **M9. `releasedMs` recorded when nothing was released** (`outbox.js:412-417`):
  the shadow/`dry_run` path stamps `releasedMs` on a `would_release` row.
  The field name asserts a release happened. Fix: don't stamp it when nothing
  was performed.
- **M10. Reversal comment contradicts the code** (`outbox.js:8`, `555-559`
  vs `589-592`): the header and `revertEffect` docstring claim "reversal is a
  new row" (pin.ledger_append_only), but `setVerdict` is an in-place UPDATE
  (`store.js:528`). What *is* append-only is the `autonomy_outbox_event`
  history — every transition gets its own event row, and the reversal receipt
  keeps `revertedFrom`. Fix the comments to describe the real (sound) design,
  not the imagined one.
- **M11. `minimizeReceipt` drops the failure rule** (`outbox.js:~330-350`): a
  failed delivery receipt `{failed, attempts, redirects, rule}` falls through
  to `{keys: [...]}` — the event stream loses the actionable rule
  (TIMEOUT/UNSAFE_URL) that the catch block's own comment calls "the part an
  operator acts on." Fix: keep `{failed, rule, attempts, redirects}`.
- **M12. Dead/duplicate code worth removing**: `STALL_MS` defined but unused
  (`personality.js:39` — `stalledGoalLine` hardcodes `4`); dead `decision`
  helper + unused `rungEvidenceStatus` import (`actionGovernor.js:58, 41`);
  `dayKey` unused (`tick.js:69`); `out.effectsReleased += 0` no-op
  (`tick.js:704`); orphaned docstrings (`actionGovernor.js:86-92`,
  `tick.js:111`); triplicated `rulesOf`/`rulesList`
  (`externalRead/Write/Irreversible.js`); duplicated scope-binding checks
  (`actionGovernor.js:227-241` vs `283-295`); duplicated `STEP_SCHEMA` /
  `SUB_STEP_SCHEMA` and `ALLOWED_NOTE_KINDS` (`tick.js` vs `subagent.js`).
- **M13. Grant-time vs match-time host case** (`scopeUrl.js`): the review
  flagged uppercase hosts being rejected at grant time but accepted at match
  time. **Checked against the current tree — not an issue:** both
  `destinationEntryProblem` and `splitEntry` lowercase the host before the
  `HOST_SHAPE` test, and `checkWebhookUrl` lowercases too. `Example.com`
  validates and matches. No change made.
- **M14. `isBlockedProposalHost` accepts octets > 255** (`designer.js:~63-72`):
  `999.1.2.3` passes as "public". Proposal-time only (safeFetch re-checks at
  fetch), but the gate's contract is broken for malformed literals.

## Low / sharp edges

- `heartbeat.js:45` dereferences `lastResult.goalsClaimed` with no null guard —
  a null-resolving `runTick` throws a spurious "autonomy tick failed".
- `heartbeat.js:32` silently floors sub-5s intervals to 5s.
- `renderNotice` (`notice.js:178-187`) returns null on unknown template /
  failed validation / throwing renderer, with no signal distinguishing the
  cases; `publicNotice.text` can be null and surfaces must handle it.
- `notice.js` sanitization differs between `validateNoticeFields` (strips
  control chars) and `buildNoticeFields` (plain slice) — same templates,
  different hygiene.
- `webhookPost.js` DNS lookup catch discards the underlying error (transient
  vs permanent indistinguishable in the ledger); declared content-length is
  recorded but never compared; empty idempotency header sent instead of
  omitted.
- `tick.js`: stale `nowMs` (tick-entry timestamp) used for wall-clock and
  authorization-expiry checks while everything else uses `Date.now()`;
  `out.shadowed` counted but never surfaced in the tick summary;
  `settingsSnapshot` shallow-copies `rungs` by reference; `bumpSpent`'s
  null-guard is dead code and negative deltas would un-count a "monotonic"
  counter; `tryNotice` swallows everything under a header claiming "nothing
  fails silently"; negative sub-budgets fail instantly (`subagent.js`);
  a blocked sub-run reports `completed` (`subagent.js:282`); `GoalNote.append`
  ordinal is read-then-insert; `requestPromotion` find-then-create race.
- `liveOutbox.js:~320`: narrowed-flip note describes the effective mode, not
  what was asked — fine once you know, confusing at a glance.
- Greeting dedupe race (`personality.js` `serveGreeting`): check-then-write is
  non-transactional, so two concurrent app opens can both serve a greeting.
  Cosmetic (the dream path has a memory-key backstop); documented here rather
  than fixed with a lock the store doesn't offer.

## Deliberate non-findings (verified sound)

- Refuse-by-default Governor, replay-safe external writes (idempotency key
  excludes scope hash; prior receipt returned; receiver rejection reported as
  released-but-not-accepted), `recordRungEvidence` recording failed gates as
  `insufficient`, `auditCorpus` anti-gaming checks, `authorizationCovers`,
  `urlAllowedByScope` segment-boundary matching, the notice exemption from
  effect-count budget lines, `checkWebhookUrl`/`isLocalOrReservedHost` reuse,
  `describeLiveDestination` as the single destination-description definition.

---

# Proposal: the autonomy layer as "the Orbit app inside Cognos"

Jeremy's direction (2026-10-03, thinking out loud — **proposal, not a build
order**): the autonomy layer shouldn't be invisible background machinery; it
should become a visible agent studio like Orbit, living inside the COGNOS app.

## What Orbit is (studied from `aquaotter84-dotcom/Punch-Out`, cloned 2026-10-03)

Orbit is a client-side agent studio (~2,000 lines of React + Capacitor):
seven screens over one local workspace.

- **Overview** — "everything your agents are up to," one greeting.
- **Agents** — "Meet your agents." Cards for Atlas (research), Piper
  (writing), Scout (briefings); create/edit with instructions and a schedule.
- **Agent detail** — per-agent chat plus run history.
- **Memory** — "What they know, stays." User-reviewed: suggested memories are
  saved or discarded by hand; up to 20 saved memories per agent feed the
  model; pending suggestions are never used as context.
- **Integrations** — webhooks and custom HTTPS APIs; POST tools ask for
  approval by default ("allow once or reject"); unattended runs never grant
  permission.
- **Activity** — "A running story." Every run, how it got there.
- **Settings** — provider key, background runs (Android WorkManager calls the
  model directly, no tools, no approvals unattended), export/import JSON.

Its trust model is the interesting part: nothing runs unattended that can
reach the world, approvals are per-use, memory is opt-in by the human. That
rhymes with COGNOS's governor — Orbit just says it in plain language.

## What COGNOS's autonomy already has

The engine side is ahead of Orbit: residents with leased goals, a tick loop,
a staged-effect outbox judged by a refuse-by-default Action Governor, an
evidence gate that makes live external writes *earned*, deterministic
notices, a promotion pipeline from notes to memory, and Postgres persistence.
And the app already has an Autonomy page (`src/pages/Autonomy.jsx`, ~2,600
lines) with goal cards, a resident designer drawer, authorization consent,
and `autonomyLabels.js` — the "jargon demoted, not removed" discipline the
v40 humanizing pass extends.

What's missing is the *studio* shape: the autonomy page reads like an
operator console (statuses, tiers, budgets, verdicts). Orbit reads like a
team you manage.

## What maps cleanly

| Orbit surface | COGNOS equivalent (exists today) |
|---|---|
| Agent cards | Residents + their goals (`store.js` residents/goals) |
| Approvals ("allow once / reject") | Outbox staged effects (`POST /api/autonomy/outbox/:id/decision`) |
| Memory review (save / don't save) | Promotion requests (`POST /api/autonomy/promotions/:id/decide`) + semantic memory |
| Activity feed | Goal events + outbox events + notices (three APIs; need one unified feed) |
| Tool permissions | Governor tiers + URL/destination grants (read-only display) |
| Scheduled runs | Heartbeat + tick config |
| Morning overview | Personality greeting + notices |

## What's hard

1. **Per-resident chat doesn't exist.** Orbit's agent detail is a
   conversation. COGNOS has a chat (the main one) and a tick planner, but no
   conversational endpoint over a goal's state (brief, notes, findings).
   Building it means a new route that loads goal context and chats with the
   model — new surface, new prompt, new tests. This is the single biggest
   build item.
2. **Two state models.** Orbit keeps everything in `localStorage` on the
   device; COGNOS keeps it in Postgres (Supabase/PGlite) behind an API.
   Porting Orbit's components verbatim means porting its state model too —
   two sources of truth. The components should not be imported; the *shape*
   should be copied onto COGNOS's APIs.
3. **Two design languages.** Orbit has its own aesthetic; COGNOS has its own.
   Verbatim ports read as a visual Frankenstein. Rebuild in COGNOS's idioms.
4. **Governance has no Orbit equivalent.** Rungs, evidence gates, shadow
   mode, tiers — Orbit never needed them because it never acts unattended
   with tools. COGNOS's safety story is stricter and must be *presented*,
   not hidden. The v40 wording pass (plain language + technical disclosure)
   is the foundation this presentation stands on.
5. **Background story differs.** Orbit's WorkManager calls the model
   directly on-device; COGNOS's loop is the server-side tick. On Jeremy's
   setup the server already runs on the phone in-process, so the "studio"
   is mostly a UI job — but push-style background notifications are a
   separate project if he wants them.

## Recommended path (for Jeremy to react to)

- **v40 (this release):** cleanup + humanizing. The language foundation the
  studio will speak. No structural changes.
- **Phase 2 — "Studio" tab:** reshape the existing Autonomy page
  Orbit-style: resident cards ("meet your residents"), an approvals inbox
  (outbox, approve/refuse inline), a memory-review surface (promotions),
  a unified activity feed (new: one endpoint over events + notices).
  No Orbit code imported; Orbit's UX shape copied. Engine untouched.
- **Phase 3 — per-resident chat:** new conversational route over goal state.
  The only real new build.
- **Phase 4 (only if wanted):** background/push parity — probably
  unnecessary, since the tick already runs on-device.

Deliberately **not** proposed: merging the repos, running two loops, or
loosening any governance so the studio feels simpler. The studio is a window
into the loop, not a second loop.

## Design directive: "agents you can see and talk to, not switches to flip"

Jeremy's follow-up directive (2026-10-03): the merger is **not** the Orbit
studio bolted onto the existing maze of settings/toggles/switches — the
studio **replaces** that maze. Today the autonomy layer exposes its machinery
as configuration (heartbeat toggles, dream on/off, check-in settings, governor
knobs). In the integrated future, Jeremy talks to agents instead of flipping
switches. Simplicity is the acceptance criterion: as easy to use as Ara.

That means every current toggle needs a verdict: which agent interaction
replaces it, and which (if any) genuinely need to survive as settings.

| Today's switch | Where it lives | Replaced by (agent interaction) | Survives as a switch? |
|---|---|---|---|
| Morning greeting on/off | Personality settings | Tell the greeter: "skip the mornings" / "say good morning again" | No — it's a conversation with the resident that greets you |
| Dream journal on/off | Personality settings | "Stop writing dreams" / "start again" — the journal is an agent behavior, configured by talking to it | No |
| Check-ins on/off | Personality settings | "Check in with me less" / "don't check in unless something's wrong" | No |
| Agent mode (Off/Read/Write/Research) | Chat input dropdown | Already conversational-shaped (a mode picker, not a config page); the dropdown stays, default Research | Yes — a mode picker is a control, not a maze; keep it visible |
| Outbox mode (shadow/dry_run/live) | Autonomy settings | Tell the resident: "practice in the background, don't touch anything yet" (= shadow); "show me before you act" (= live + approvals). The mode becomes *how you talk to it*, not a setting you set | No — expressed as instructions to the agent |
| Rungs (earned capabilities) | Evidence gate | "What are you allowed to do yet?" — the resident answers from its own earned state. Earning stays automatic; the manual rung knobs go away | No — governance is presented, not configured |
| Auto-authorize ("forgo goal authorization") | Autonomy settings | Per-goal: "you don't need to ask me for this one" — the existing authorization consent, conversational | No — it's a per-goal conversation, not a global toggle |
| Bypass earning (evidence gate) | Env pin + UI delegation | Nothing. This was never a preference; in the studio world it has no user-facing surface at all (env pin for emergencies only) | No — removed from any UI |
| **Autonomy on/off (kill switch)** | Autonomy settings | — | **Yes — the one switch that survives.** When Jeremy wants everything to stop, he must not have to negotiate with the thing he's stopping. A master stop is a control, not a conversation. |

The principle: **preferences become conversations; governance becomes
presentation; the kill switch stays a switch.** A preference ("greet me",
"check in", "practice quietly") is something you'd naturally say to a
resident — so the toggle is just a worse UI for a sentence. Governance
(rungs, evidence, tiers) was never really configurable by Jeremy in a
meaningful way — the knobs existed for the builders, not for him — so the
studio shows it as "what I'm allowed to do and why," in the resident's own
words. And the kill switch survives precisely because it is the opposite of
a preference: it's the guarantee that the conversation can always be ended.

Sharp edge this resolves: today's settings page mixes all three categories
(preferences, governance internals, and the kill switch) in one undifferentiated
list, which is why it reads as a maze. The studio sorts them by nature.

### The cleanup agent is the first citizen of the studio

The cleanup agent (Phase 33, ships v41 — see below) is the natural first
resident of this studio shape: it already speaks in the warm plain-language
voice ("I tidied up 12 things — 3 more want your call"), it already has a
review queue shaped like Orbit's approvals inbox ("allow once / reject"),
and its Cleanup tab is already a studio card rather than an operator
console. When the studio lands, the cleanup agent doesn't need redesigning —
it needs neighbors.

---

# Gateway hardening audit (BluesMinds) — v42

Jeremy pasted outside advice on hardening the agent loop for the BluesMinds
gateway. Audited with judgment; findings below.

## 1. Strict JSON audit — complete, with prompt hardening added

Walked every `callLLM` in the agent/autonomy loop. Every call whose result is
parsed as JSON already enforces `responseJsonSchema` (sent as a
`json_schema` response_format *and* `JSON.parse`d with a named
"malformed structured output" error). The two calls that intentionally
return prose are not crash vectors:

- `server/council/webSearch.js` (briefing) — consumed as a plain string for
  the council to reason over; any string is valid output.
- `server/routes/heartbeat.js` compose (dream distillation, greeting) —
  prose journal entries with a deterministic fallback
  ("The day held N memories."); `cleanLine(..., 900)` bounds it.

What was missing: the explicit "return ONLY the JSON object, no
conversational filler" prompt line. The schema envelope does the heavy
lifting, but a model that ignores the envelope and chats anyway turns into
a parse throw. Added the hardening line to: Observer, Strategist, Critic,
Coherence Monitor, resident designer (its prose lives *inside* the JSON
`reply` field, so the line points there), memory relevance, conversation
summarizer (its prompt said "return only the summary text" while the
schema wants `{ summary }` — fixed to match), and memory extraction. The
planner, tick worker, subagent, and vision calls already had it. Every one
of these calls already degrades gracefully (fallbacks or caught errors),
so a chatty model degrades the turn, never crashes the loop.

Deliberately **not** done: `strict: true` on the schema envelope, and
retrying malformed JSON. Strict mode is unverified against the BluesMinds
gateway (a 400 there would break every schema call at once), and the
parse-throw path with caller fallbacks is the safer posture until Jeremy
wants to test strict against his account.

## 2. Gateway retry — the main client was already solid; embeddings was the gap

`server/llm.js` (the BluesMinds chat-completions client) already had the
full treatment: transient statuses (408/429/500/502/503/504), `Retry-After`
header honored, exponential backoff (250ms × 2^attempt, capped), one logical
deadline across retries, client-abort always winning. The "most likely real
gap" was already closed.

The actual gap was `server/memory/embeddings.js`: a single 429/502
returned null and every caller silently fell back to no-embeddings. Added
a bounded retry (3 attempts, 250ms→2s backoff) for transient HTTP statuses
and network blips; hard 4xx still fails fast, aborts stay terminal, and the
never-throws contract is unchanged. 4 new tests in `test/memory-semantic.mjs`
(transient-then-success, persistent 503, hard 400, network blip).

## 3. Model selection — noted, not changed

Agent-loop models (`primary`, `memory`/`fast`, and all council seats)
resolve to `openai/gpt-oss-20b` unless `COGNOS_MODEL` / `COGNOS_FAST_MODEL`
override — verified live against Jeremy's BluesMinds account 2026-09-27
(~1.5s completions). The pasted advice names Claude 3.5 Sonnet/3.6, GPT-4o
Mini, and DeepSeek V4.1 Flash, but **GPT-4o Mini is confirmed "model not
found" on his account** and the others are unconfirmed on his plan — so
none of them is an available alternative today. No provider or plan change
made, per the directive. If structured output ever proves weak on
gpt-oss-20b (a reasoning-first model; the code already handles its
`reasoning_content` fallbacks), the lever is the two env vars above,
pointed at whatever his BluesMinds plan actually lists.

---

# Changes made in v40 (cleanup + humanizing)

> **v41 addendum** — after v40 shipped, Jeremy approved four features that
> rode the next build:
>
> - **Dream recognition** — dreams render as a framed "your dreams" section:
>   the assistant's own inner life, not generic episodic rows.
> - **Sapphire memory-layer alignment** — new `self` layer,
>   `distilled_from` provenance on dreams. Full write-up:
>   [docs/memory-alignment.md](./memory-alignment.md), including the
>   deliberate decision that dreams distill from the day's memories, never
>   from previous dreams.
> - **Cleanup agent (Phase 33)** — a daily housekeeping audit over every
>   store COGNOS persists, with the per-store policy below. Exact duplicates
>   tidy themselves (logged, reversible); everything else waits for
>   Jeremy's call in a review queue shaped like the promotions UI.
> - **Agent-mode default → Research** — the chat mode dropdown already
>   existed (Off / Read / Write / Research); the default is now Research,
>   and read-only web access in Research mode is pre-authorized. Writes,
>   external actions, and irreversible acts still go through the
>   actionGovernor — untouched.
> - **About page + self-model refresh** (identity v1.12.0) — the About page
>   (`/about`, rendered from the canonical manifest in `server/identity.js`)
>   and the model's own self-description now tell the v41 truth: ten
>   personas, heartbeat with personality (greetings, dream journal,
>   check-ins), agent modes defaulting to Research with pre-authorized
>   read-only web access, the cleanup agent, and the four memory layers
>   including `self` (dreams as the assistant's own inner life). The stale
>   "research plans await approval" lines are gone everywhere they appeared
>   (manifest, prompt, turn flow, subsystem list, decision-route comment,
>   phase18 tests).

## The cleanup agent's per-store policy

One audit, every store, three buckets. This is the policy the audit applies;
the review queue is Jeremy's.

| Store | Auto-tidy (safe, logged, reversible) | Review queue (Jeremy decides) | Hands-off (never touched) |
|---|---|---|---|
| Memories — all layers (working, episodic, semantic, self) | Exact duplicates (soft-disable via `is_enabled=false`, canonical = most important then newest); expired TTL rows | Near-duplicates (embedding similarity ≥ 0.92), redundant keys (one key, different content), subsumed rows, fragment merges, stale high-volatility entries untouched 30+ days | Dreams are never fragments and never auto-merged |
| Knowledge graph | Duplicate edges (same `edge_sha256`, retired) | Orphaned nodes (7-day grace), dead-end subgraphs (all-untrusted, 30+ days old), contradictions flagged for review | — |
| Telemetry (telemetry_runs, telemetry_model_calls) | Rows older than 90 days, hard-deleted (bloat control) | — | — |
| Notices (autonomy_notices) | Acked notices older than 90 days, hard-deleted | — | Unread notices: never touched |
| Autonomy stores (heartbeat_state, outbox, goal evidence) | — | Orphaned goal notes (parent goal gone) | The outbox itself, heartbeat_state, the audit trail (goal_events, outbox_events, note_promotions, cleanup_proposals, graph_snapshots, confidence_history, knowledge_events, improvement_ledger), beliefs, relationships, conversations/messages, sources and their chunks (Jeremy's research library) |

Notes on the policy:

- **Nothing irreplaceable is destroyed silently.** Auto-tidy is logged on
  the `cleanup_runs` row and, where a ledger exists, as a ledger event
  (`memory_disabled`, edge retired). The one hard delete that isn't
  telemetry/notices is an `orphan_note` proposal Jeremy explicitly
  approves — recorded on the proposal row, never the agent's own call.
- **Dreams are protected from the audit's own logic**: excluded from
  fragment detection, stale-volatile detection, and exact-duplicate
  auto-merge keying is content-based (a repeated dream line would group,
  but dreams distill once per day per key, so this is a non-issue in
  practice).
- **The audit is day-guarded in the heartbeat** (one pass per day), behind
  the same kill switch as the tick: autonomy frozen means no audit. A
  failed audit logs and retries the next day — it never kills the beat.
- **Reporting is a notice**, in the warm voice:
  "I did a little housekeeping and tidied up 12 things — mostly duplicates
  and old clutter. Nothing you care about was touched. 3 things need your
  call before I do anything with them — take a look when you have a minute."
  (`cleanup_report` template in `notice.js`, deterministic like the rest).

All items below are in the v40 tree. Governance keeps full authority —
nothing was loosened; refusals still refuse, the evidence gate still gates,
T5 still needs a per-effect human approval.

## Bugs fixed

- **webhookPost.js**: a non-identity `Content-Encoding` now rejects with rule
  `UNSAFE_ENCODING` instead of destroying the socket and leaving the promise
  unsettled forever (which wedged live ticks). [H1]
- **actionGovernor.js**: malformed config now records a `CONFIG_UNREADABLE`
  refusal instead of throwing out of the "never throws" Governor; a missing
  spend ceiling is `SPEND_UNVERIFIABLE`; ledger-query throws become
  fail-closed nulls. [H2]
- **actionGovernor.js**: evidence/approval lookup errors are now
  `EVIDENCE_UNREADABLE` / `APPROVAL_UNREADABLE` — never a false claim that the
  corpus or approval doesn't exist. [H3]
- **externalRead.js**: a replayed released *search* is reported as a replay,
  not a refusal; replayed *reverted* rows in all three `external*.js` files
  get their own branch instead of being miscounted as refusals. [H4]
- **tick.js**: prompt/completion tokens are now accounted separately, so the
  `maxTokensOut` budget line can actually fire (it was counting whole-call
  tokens as input). [H5]
- **actionGovernor.js**: an empty webhook body is refused as `BODY_REQUIRED`,
  not `BODY_TOO_LARGE`. [M1]
- **config.js / actionGovernor.js / tick.js**: "today" boundaries and quiet
  hours now follow the human's timezone (`config.userTimeZone`, env
  `COGNOS_USER_TZ`, default America/New_York) instead of the server's —
  budgets no longer reset at 8 PM EDT on a UTC host. The bare
  `insideQuietHours(qh, ms)` keeps its documented server-local default. [M2]
- **evidenceGate.js**: the re-audit now uses the Governor's own
  segment-boundary URL matcher instead of a naive string prefix. [M3]
- **outbox.js**: the T5 re-judgment path normalizes a string verdict before
  reading it, so an approved T5 can't silently take the terminal-replay
  branch. [M4]
- **authorize.js**: `isTightening` now fails when a budget line is *removed*,
  not just raised. [M5]
- **tick.js**: a skill that both self-reports effects and returns stages no
  longer double-counts against budgets/rate limits (one source per step).
  [M6]
- **outbox.js**: `would_release` rows no longer carry a `releasedMs` stamp;
  failed receipts keep their actionable `rule` in the minimized event form.
  [M9/M11]
- **designer.js**: malformed IPv4 literals (octet > 255) are blocked at
  proposal time. [M14]
- **settings.js**: `listSettingFlips` now covers every flip (master,
  auto-authorize, bypass, all rungs, outbox mode), not just the master
  switch; `settingsSnapshot` deep-copies `rungs`. [M8]
- **store.js**: `bumpSpent` clamps negative deltas (monotonic counters don't
  go down); the "Upsert the delegated value" docstring moved onto the
  function it describes. [low]
- **subagent.js**: a blocked worker now finishes as `blocked`
  (`subagent_blocked`), not `completed`. [low]
- **heartbeat.js**: null-guarded the tick-result dereference. [low]
- **tick.js**: budget/authorization-expiry checks use a fresh clock, not the
  tick-entry timestamp; `tryNotice` failures are logged instead of swallowed;
  the tick summary now surfaces `effectsShadowed`. [low]

## Dead code / duplication removed

- `STALL_MS` wired into `stalledGoalLine` (was defined, never used);
  dead `decision` helper and unused import in actionGovernor.js; unused
  `dayKey`, orphaned docstrings, the `out.effectsReleased += 0` no-op;
  `rulesOf`/`rulesList` deduplicated into outbox.js; the two scope-binding
  check blocks merged into one helper.

## Deliberately kept

- **Refusals still feed the failure brake.** Reconsidering M7 against
  `test/autonomy.mjs` ("the planner cannot grant itself a skill the allowlist
  does not have"): the brake parking a repeated escalation attempt IS the
  anti-escalation property. The refusal reason is preserved on the step row
  and in the park detail.
- **Reversal stays a recorded transition on the row** (M10): the comments
  claiming "a new row" were corrected — the append-only event log is the
  history, and the receipt keeps `revertedFrom`.
- **Uppercase hosts** (M13): verified not a bug — both sides lowercase.

## Humanizing (the "like Ara" pass)

- **Notices** (`notice.js`): all four templates rewritten in plain language —
  `"X" is on pause — it ran out of budget. 12 steps done, 3 findings saved.
  2 things are waiting on your word.` — with proper plurals and a
  dollar-formatted spend warning. Deterministic discipline unchanged.
- **Refusal reasons** (`actionGovernor.js` RULES): plain sentences
  ("the goal used up its budget", "it's quiet hours — outside sends wait");
  rule keys stable for the evidence gate and tick.
- **Go-live checklist** (`liveOutbox.js`): labels rewritten ("Practice runs
  have proved it out", "One approved place to send to"); sentences kept
  actionable, warmed where stiff.
- **Outbox mode pills** (`Autonomy.jsx`): "Shadow (practice)" instead of raw
  `shadow`; new `outboxModeLabel` helper next to the existing label maps.
- **Sanitization** unified between the two notice field builders.

## Regression tests

New `test/autonomy-v40.mjs` (13 tests, wired into `npm test`): isTightening
removal, timezone day boundaries, CONFIG_UNREADABLE / SPEND_UNVERIFIABLE /
EVIDENCE_UNREADABLE paths, reverted replay, no releasedMs on shadow rows,
minimized failure receipts, shared rulesOf/rulesList, notice wording +
bounds + determinism, STALL_MS wiring, snapshot isolation, RULES stability.
Two existing tests updated to the corrected behavior (`BODY_REQUIRED`;
quiet-hours windows built in the config's timezone).

New `test/dream-recognition.mjs` (11 tests): dream detection by key/source,
newest-first ordering, the 5-entry cap, framing text, exclusion from ordinary
episodic rendering, `self` layer on distilled dreams.

New `test/agent-mode.mjs` (6 tests): Research is the default;
`researchStepsPreauthorized` fails closed on unknown/non-read-only tools;
the mode is visible in the model context.

New `test/cleanup.mjs` (13 tests, this release): pure detection for every
detector (exact dupes, canonical pick, near-dupe pairs in-layer only,
redundant keys, subsumed pairs, fragments with dream exclusion, stale
volatile, graph orphans/dupes/dead-ends/contradictions); proposal
idempotency; approve-applies/refuse-stands against a fake db; fragment
merge; `cleanupDue` day-guard; `cleanup_report` wording.
