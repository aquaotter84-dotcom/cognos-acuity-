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

---

# Changes made in v40 (cleanup + humanizing)

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
