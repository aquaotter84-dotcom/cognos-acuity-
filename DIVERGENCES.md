# DIVERGENCES from the original COGNOS

Source of truth: `github.com/aquaotter84-dotcom/cognitive-acuity`.

**Important finding first.** The `main` branch is damaged. `base44/shared/llm.ts` on
`main` had been hand-edited into a mangled, mis-indented file that **does not export
`buildContextSystemPrompt` or `styleDirective`** — yet `specialist.ts` and
`synthesizer.ts` both import them. `main`'s council could not have run. The intact
council lives on **`origin/cognos/full-integration`** (also `feature/bluesminds-gateway`,
`feature/openai-proxy`, `codespace-organic-eureka-...`). **This rebuild is ported from
`cognos/full-integration`.** That is where the COGNOS identity prompt and the charter
injection survive intact.

---

## 1. Preserved verbatim (the mind)

Originally copied byte-for-byte except import/storage bindings; later governed
changes are named explicitly in the final column and in the cited sections:

| File | Origin |
|---|---|
| `server/council/charter.js` | `base44/shared/council/charter.ts` — the four principles: truth, evidence, agency, dignity |
| `server/council/observer.js` | Observer prompt, task-type list, JSON schema, fallback classification |
| `server/council/strategist.js` | Strategist decomposition, `ALLOWED_AGENTS`, schema; Phase 17 adds source names—not source contents—to planning (§14) |
| `server/council/specialist.js` | All nine `SPECIALIST_PROMPTS`, decomposed + direct paths; source turns add untrusted-evidence instructions and excerpts (§14) |
| `server/council/synthesizer.js` | `SYNTH_BASE`, `REVISE_BASE`, synthesis + revision paths; source evidence follows drafts through synthesis/revision (§14) |
| `server/council/critic.js` | Critic schema and skip/degrade behaviour; Phase 15 adds the epistemic audit and Phase 17 adds source/citation review (§9.5, §14) |
| `server/council/governor.js` | Sovereignty gate and `SECRET_PATTERNS`; later deterministic audits add enforceable epistemic and exact-source-citation vetoes (§11, §14) |
| `server/council/index.js` | Registry wiring |
| `server/shared/*.js` | orchestrator, registry, protocol, runtime, eventBus, errors, logging |
| `server/llm.js` (lower half) | `STYLE_DIRECTIVES`, `styleDirective`, and the COGNOS identity base prompt remain; source turns add one higher-priority untrusted-evidence clause (§14) |
| `server/chatOrchestrate.js` | Memory relevance, summarization, Phase 4 revision, and Phase 13 adaptive rule remain; memory extraction now distinguishes source claims from user facts and the pipeline gained governed non-council stages (§9, §10, §14) |
| `src/components/chat/CouncilTrace.jsx` | Was unchanged; Phase 14/15 add one collapsible section that renders only when the new fields are present (§9.7) |

The Phase 13 pipeline order was:
`contextAssembly → observer → webSearch → strategist → specialist → synthesizer → critic ⟳ → governor → (memory ‖ audit ‖ summary)`

Phase 14/15 insert three **non-council** stages (they do not vote and are not
seats) and keep every existing edge exactly where it was:
`contextAssembly → observer → webSearch → strategist → specialist → synthesizer → coherenceMonitor → critic ⟳ (coherence re-checked after any revision) → governor → (memory ‖ deferred critic) → knowledgeProjection → telemetryRecord ‖ audit ‖ summary`

Phase 17 conditionally prefixes `agentPrepare` when a source is attached or a
non-off agent mode is selected. It prepares evidence only and has no answer edge.

---

## 2. Base44 dependencies catalogued and removed

| Base44 thing | What it did | Replacement |
|---|---|---|
| `@base44/sdk`, `@base44/vite-plugin` | SDK + build plugin | **Deleted.** Plain Vite + React. |
| `base44.functions.invoke('chatOrchestrate')` | Metered platform function — this was the 402 meter | `POST /api/chat` in `server/index.js`, calling `runCouncilTurn` in-process |
| `ctx.base44.asServiceRole.integrations.Core.InvokeLLM` | Platform-keyed model call | `callLLM` in `server/llm.js` → **BluesMinds** `/v1/chat/completions` directly, key from `BLUESMINDS_API_KEY` |
| `base44.entities.*` (11 entities, RLS) | Platform database | `server/db.js` — **Neon** Postgres, 6 tables, serverless driver |
| `base44.auth.me()`, `AuthContext`, `ProtectedRoute`, Login/Register/Forgot/Reset/OAuthConsent | Account system | **Deleted.** No accounts. |
| `VITE_BASE44_APP_ID`, `VITE_BASE44_APP_BASE_URL`, `src/lib/app-params.js` | App identity vars | **Deleted.** No `VITE_*` vars exist. |
| `cognosruntime.vercel.app` proxy hop | Middleman runtime the old `api/chat.js` forwarded to | **Deleted.** The council runs in-process; BluesMinds is called directly, not through a relay. |
| `X-Agent-Secret` / `COGNOS_AGENT_SECRET` service-role branch | LiveKit voice agent bypass | **Deleted** with the voice agent. |
| `media.base44.com` logo | Welcome art | Inline SVG mark |
| `integrations.Core.UploadFile` | Hosted blob store | **Removed** — see §4 |
| Stripe deps, `deleteAccount` function | Billing / account deletion | **Deleted.** No billing, no accounts. |

Verified: `grep -rin "base44\|bluesminds\|VITE_"` over `server/`, `src/`, configs returns nothing but explanatory comments.

---

## 3. Sanctioned upgrades

1. **Live council stream, governance-gated answer.** `POST /api/chat` is
   Server-Sent Events. Council stage start/complete events, the Observer
   classification, web-search briefing, plan, critic score and Governor verdict
   stream as they happen. Draft answer text does **not**: it remains server-side
   until the Governor has ruled on the complete final draft. Only the governed
   final text (or a fixed deterministic refusal) is then released in chunks,
   with no artificial typewriter delay. The original faked typing by revealing
   an already-complete, ungoverned string with `setTimeout`; that simulation is
   still deleted.
2. **Mobile layout.** `100dvh` instead of `h-screen` (fixes iOS URL-bar clipping),
   `text-base` on the input (stops iOS zoom-on-focus), action buttons always
   visible on touch instead of `opacity-0 group-hover`, safe-area insets on
   header/nav/input, reduced tab bar.
3. **No auth.** App opens straight to chat.

---

## 4. Things removed, stated plainly

These existed **only** because Base44 supplied them. There is no honest
equivalent, so they were removed rather than faked:

- **Screen share and camera capture** remain removed. They depended on
  `integrations.Core.UploadFile`, a hosted blob store returning public URLs the
  model could fetch. Phase 17 added server-extracted PDF/DOCX/text/Markdown/CSV
  evidence and public links. **Phase 18 restores uploaded-image evidence without
  that blob store**: the browser sends a bounded base64 payload, the server
  stores the immutable hashed original and serves its bytes itself
  (`/api/sources/:id/image`, ETag = content SHA-256); the model never receives
  a pixel stream or a private URL — it reasons over region-boxed transcripts
  and always from server-owned rows (§14.6).
- **Hosted LiveKit voice agent** (`livekit-agent/`, `AgentChat.jsx`,
  `useConversationMode`, the original `SpeakButton`). It needs a LiveKit server,
  tokens, and the service-role secret path, so the full-duplex agent remains
  removed. Browser-native **speech-to-text dictation is kept** (mic button in
  `ChatInput`), and browser-native **speech output is now implemented** without
  new credentials. Output receives only the final Governor-approved SSE
  `done.response`; it never receives council drafts or vetoed text.
- **Beliefs, Dynamics, Insights, SystemMap, Documents pages** and the
  `deriveBeliefs` / `consolidateMemories` / `runCouncilAutonomous` functions plus
  the `BeliefSnapshot` / `ChangeEvent` / `Insight` / `Document` entities. These
  are a large second subsystem (a 445-line belief-derivation engine with
  confidence propagation, plus two scheduled Base44 workflows). They are
  **preserved in the repo history and not ported here.** Porting them is a
  Phase 17 does not resurrect those workflows: its source snapshots and bounded
  read-only agent are new, smaller governed subsystems (§14).
- **Multi-user workspaces, sharing, `member_ids`, RLS.** All of it keyed to
  platform user IDs. With no accounts there is one workspace and no row-level
  security. `WorkspaceMembers`, `ShareMemoryModal` are gone.
- **About / Contact / Privacy pages** — marketing pages for the hosted product.

---

## 5. Honest changes inside preserved code

- **Web search.** The original called `gemini_3_flash` with
  `add_context_from_internet: true` and let the platform retrieve. That flag was
  a platform feature that does not exist off-platform — passing it through would
  do nothing and the council would silently reason on stale model memory.
  Retrieval is now **real**: Tavily if `TAVILY_API_KEY` is set, otherwise
  DuckDuckGo (keyless). The council's briefing prompt is **verbatim**; it now
  summarizes actual fetched results with actual URLs. This is strictly more
  honest than the original.
- **Model slugs.** `gpt_5_4` / `gpt_5_mini` / `gemini_3_flash` were
  Base44/BluesMinds identifiers. They are aliased in `llm.js`. **`gpt_5_4` is
  hard-banned** — requested explicitly or via env, it resolves to the default.
- **JSON schema envelope.** The council passes bare JSON Schema; OpenAI requires
  a named `json_schema` wrapper. `schemaEnvelope()` wraps it. Schemas unchanged.
- **Council traces now persist.** The original kept them in React state only, so
  reopening a thread lost them. They are stored on the message row.
- **Memory `member_ids`** dropped from extracted records (no users to scope to).

---

## 6. Constraint compliance (all verified by execution)

| Constraint | Status |
|---|---|
| Model from env override, default `gpt-4o-mini` | ✅ `resolveModel()` — no env → `gpt-4o-mini`; `COGNOS_MODEL=gpt-4o` → `gpt-4o` |
| **Never route to `gpt_5_4`** | ✅ `COGNOS_MODEL=gpt_5_4` → `gpt-4o-mini`; explicit request → `gpt-4o-mini` |
| Pooled `postgres://` only, reject `https` | ✅ rejects in **0.13 s** with an explicit message, never hangs |
| Lazy DB init so build passes with no DB | ✅ `vite build` succeeds with `DATABASE_URL` unset; nothing connects at import |
| Secrets env-only, never in bundle | ✅ 0 occurrences of any key name in `dist/assets/*.js` |
| Gate only when `COGNOS_RUNTIME_SECRET` set | ✅ unset → open; set → 401 without cookie, 200 after `/gate?key=`; `/api/health` always open |
| One clean send path, no dead code | ✅ `handleSend` → `sendMessage` → `POST /api/chat` → `runCouncilTurn`. One route, one client function, no alternate path |
| Frontend/backend response shapes agree | ✅ the `done` event carries exactly `{ response, taskType, modelUsed, latencyMs, summary, council }` |
| Sovereign stays silent rather than lie | ✅ model unreachable → `event: error` and a message marked `processing_status: 'error'`. No fabricated answer is streamed or persisted |


---

## 7. Deployment-shape changes (Neon + Vercel + BluesMinds)

These came after the initial rebuild, when the target platform was confirmed.

- **Provider is BluesMinds.** `server/llm.js` reads `BLUESMINDS_API_KEY` and
  defaults to `https://api.bluesminds.com/v1`, which is OpenAI-compatible, so the
  call shape is unchanged. `OPENAI_API_KEY` / `OPENAI_BASE_URL` still work as
  aliases for any other compatible gateway. Unlike the original's
  `cognos-external-runtime` branch, there is **no relay hop** — no
  `cognosruntime.vercel.app`, no Base44 `externalLLM` function in the path.
- **Upstream calls are now time-bounded** (`COGNOS_LLM_TIMEOUT_MS`, default 60 s).
  A hung provider must not silently consume the whole serverless budget.
- **Neon serverless driver.** `server/db.js` detects a `*.neon.tech` URL and uses
  `@neondatabase/serverless` (WebSocket-based, correct for serverless) instead of
  a TCP `pg.Pool`; non-Neon URLs still use `pg`, so local Postgres is unaffected.
  It also warns when given a Neon **direct** (non-`-pooler`) host.
- **Listener split from app.** `server/index.js` now *exports* the Express app
  and never calls `listen()`. `api/index.js` is the Vercel serverless entrypoint;
  `server/serve.js` is the local/self-hosted listener. This matters: the previous
  structure called `app.listen()` at import time, which works locally and does
  **nothing** on Vercel — the deploy would have served the SPA and 404'd every
  API route.
- **Static serving is conditional** on `!process.env.VERCEL`; on Vercel the CDN
  serves `dist/` via `vercel.json` rewrites.
- **Schema migration is per-instance memoized** and idempotent, so repeated cold
  starts cost one `IF NOT EXISTS` round trip rather than re-running work.

### Known constraint, not a defect

The council is **sequential by design** — ~6 model calls per turn. On Vercel
**Hobby** that is capped at 60 s regardless of the `maxDuration: 300` in
`vercel.json`, and a slow turn will be killed mid-stream. This is a platform
limit meeting an architectural property of the council, not a bug in the port.
Options are in [DEPLOY.md](./DEPLOY.md) §3. Similarly, BluesMinds' Free tier
(20 RPM / 300 req/day) works out to roughly **3 turns/minute, ~45 turns/day**.

## 8. Council scheduling (measured, not guessed)

The council's *reasoning* is unchanged: every operator still runs, in the same
order of data dependency, on the same prompts. Only the **scheduling** of work
that does not feed the next operator was changed. Measured A/B on a latency mock
(observer 900ms, specialist 2500ms + 25ms/token, critic 1100ms, memory calls
800/1000ms), identical database state, 3 runs each:

| | sequential | scheduled | delta |
|---|---|---|---|
| time to first token | 4262 ms | 3460 ms | **-19%** |
| time to done | 6578 ms | 4769 ms | **-27%** |

These measurements predate the governance-gated answer boundary in §11. The
scheduling comparison remains valid as a historical A/B of the same two
pipelines, but current `time_to_first_token_ms` means time to the first
**governed** answer chunk, after the Governor's verdict.

Three changes, each justified:

1. **contextAssembly DB reads batched.** `Message.recent`, `Memory.filter` and
   `Workspace.get` are independent reads; they now share one `Promise.all`.
   Worth ~800 ms against a real network database (it was ~5 ms against local
   Postgres, ~806 ms against the latency mock's round trips).
2. **Memory-relevance ranking overlaps the Observer.** The relevance LLM call
   ranks the memory pool; the Observer classifies the user's message. Neither
   reads the other's output, so they now run concurrently and are joined right
   after the web-search gate. Downstream operators still receive
   `memories` as a plain resolved array — no operator was modified.
3. **The critic no longer blocks `done` when `maxRevisions === 0`.** On the
   simple path the orchestrator sets `maxRevisions = 0`, so the critic's verdict
   *cannot* trigger a revision — it is advisory telemetry. It now runs in the
   post-response batch and still emits its `critic` SSE event with the full
   charter evaluation. When `maxRevisions > 0` (the complex path) the critic
   stays blocking exactly as before, because there its verdict can change the
   answer.

**What was deliberately NOT parallelized.** The Observer→Specialist edge is a
real data dependency, not an accident of coding order: the classification is
interpolated into the Specialist's system prompt by `buildContextSystemPrompt`
("TASK CONTEXT: The Observer classified this as...") and it gates whether web
search runs at all. Running them concurrently would mean the Specialist answers
without knowing what kind of question it was asked. That would make the council
faster by making it think less, which is not a speed-up — it is a different
council. Left serial.

**Honest limit on Vercel.** Deferring the critic shortens the *user-visible*
window, not total function wall-time: the post-response batch still runs inside
the same invocation. This improves perceived latency; it does not by itself
avoid the Hobby 60 s cap discussed in §7.

---

## 9. Phase 14 — Dynamic Systems (what changed, what did not)

Everything in this phase is a **subsystem the council consults, or that observes
it**. No new council seat was added: the six operators are still six
(`pin.six_operators`), and event emission is a side effect of the existing send
path, never a second channel to the user (`pin.telemetry_side_effect`).

### 9.1 New storage (additive only)

`server/db/schema.js` is the single source of truth; `migrations/*.sql` is
generated from it by `scripts/generate-migrations.mjs`.

| Table | Purpose |
|---|---|
| `knowledge_events` | the append-only event ledger (14.1) |
| `beliefs` | current-state projection of what the system holds to be true |
| `confidence_history` | one row per confidence/strength change, for any entity |
| `relationships` | living structures with strength, direction and decay (14.4) |
| `coherence_reports` | the monitor's measurement per run (14.5) |

Plus two additive columns on one existing table: `memories.confidence NUMERIC`
and `memories.confidence_as_of_ms BIGINT`. No existing table was dropped, renamed,
truncated or rewritten; `audit_events` remains its own separate log and is not
the ledger.

Every statement is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` /
`ADD COLUMN IF NOT EXISTS`, applied by the same lazy migration the base app
already ran. `scripts/migrate.mjs` refuses to execute any migration containing
`DROP`, `TRUNCATE`, `DELETE FROM`, `RENAME` or `UPDATE … SET`.

### 9.2 Writes are transactional with their events

`server/db.js` gained `withTransaction(fn)` (re-entrant through an
`AsyncLocalStorage` ambient-transaction guard, so nested calls join instead of
deadlocking) and `createStore(run)`, which hands every caller the same accessors
bound to the same runner. Memory writes, belief projections, relationship
changes, summary updates, conversation metadata and the persisted conclusion
each append their ledger event **inside the same transaction** as the row they
describe. If the write rolls back, the event rolls back with it.

**Kill switch:** `COGNOS_LEDGER_ENABLED=false` disables ledger emission
entirely; the app then behaves as it did before this phase.

### 9.3 Two behavioural changes, stated plainly

These are the only places where Phase 14 changes what the app *does* rather than
what it *records*:

1. **A vetoed run no longer writes memory or updates the conversation summary.**
   The Governor's veto already decided that the draft never ships; Phase 14
   makes the store agree with that decision. On a vetoed run the pipeline skips
   `memoryExtraction` and the summary write, records `veto_raised` in the ledger
   (entity type `run`, digest-only — the refused text is never stored, only its
   length and SHA-256) and still stores the sovereignty refusal the user sees.
   Before: a vetoed run could still extract memories from the exchange.
   This is required by the success criteria ("a vetoed run records the veto in
   telemetry and writes nothing to memory") and is asserted in `test/smoke.mjs`
   scenario 4.
2. **A streaming abort now surfaces as a timeout error, not a raw `AbortError`.**
   `server/llm.js` rethrows the streaming-path abort as
   `Error("Model request timed out after <n>ms")` so the failure is classified
   the same way on the streaming and non-streaming paths. Before, the user-facing
   message for that case was `This operation was aborted`. The non-streaming
   path's message is unchanged.

### 9.4 What the coherence monitor is, and is not

`server/knowledge/coherence.js` registers `coherenceMonitor` as a **non-council
stage** — the same kind of participant as `contextAssembly` or `auditLog`. It
has no vote, no seat, no ability to change the answer. It compares the draft
against the beliefs the store already holds and reports measurements:
`coherent | confirmation | contradiction | mixed | unverified | unchecked | error`.

A contradiction is **not an error**. It is appended as `contradiction_detected`
(`reversible = false` — it happened and cannot un-happen) with both claims, the
belief's lineage, and the confidence delta. The belief is weakened by
`0.25 × claim confidence`, a successor hypothesis may be proposed, and the
belief's row is never deleted: retirement is a status transition.

Persistence is gated on the draft actually shipping. If the Governor vetoes, the
contradiction is not written as knowledge — the veto is.

### 9.5 The two operator touch-points

* `server/council/critic.js` — the Critic's **system prompt is byte-identical**.
  A bracketed data section is appended to the *user* turn containing the
  coherence measurement and the temporal digest for the implicated beliefs
  (the Critic calls `ctx.temporal.digestForBeliefs(...)` itself — the temporal
  reasoner is a helper operators may call, not an operator). When the monitor is
  off or found nothing, the appended string is empty, so the Critic's input is
  identical to pre-Phase-14. Its schema, score, skip/degrade behaviour and
  governance role are unchanged; `evaluation.temporal` and
  `evaluation.coherenceVerdict` are additive fields.
* `server/council/governor.js` — receives the coherence report and returns it on
  its verdict. `approved` and `flags` are computed exactly as before, from the
  draft text and `SECRET_PATTERNS` alone. Coherence can never approve what the
  Governor would refuse, nor refuse what it would have approved.

### 9.6 Relationship dynamics

`server/knowledge/relationships.js` maintains living structures (user↔system,
concept↔concept co-activations) with strength and direction. Effective strength
decays exponentially from `strength_as_of_ms` with a 14-day half-life and a 0.05
floor, so a stale link weakens with no writer involved. A bounded sweep
(`sweepLimit` 25 per run) logs each weakening as `relationship_decayed`;
retiring a belief transfers its co-activation links to the successor
(`transferLinksOnRetirement`) rather than dropping them.

### 9.7 Query surfaces (read-only) and the one UI addition

Bare JSON endpoints under `/api/knowledge/*` (events, overview, analytics,
beliefs, relationships, coherence, `state/:type/:id` for replay,
`verify/:type/:id`, `lineage/…`, `temporal/…`) and `/api/meta/*` (telemetry,
strategies, laws, policy, improvements, adaptive, evaluations, rates). One
gated write exists: `POST /api/meta/adaptations`, answered by the Policy Engine.

`src/pages/System.jsx` is a new read-only page (route `/system`, one extra
sidebar link and one extra mobile tab) that renders those endpoints, including
replay-at-an-instant and the Policy Engine's refusals. `CouncilTrace.jsx` gained
a "Knowledge & telemetry" section that renders only when the new council fields
are present, so an older persisted message draws exactly what it drew before.
`MobileNav.jsx` item padding changed `px-3` → `px-2 sm:px-3` so five tabs fit a
360 px screen; that is the only cosmetic change to an existing component.

`/api/health` gained additive keys (`ledger`, `coherence`, `telemetry`,
`adaptiveMode`, `adaptiveModeForced`, `strategy`, `laws`, `lawLayerVersion`);
`start` and `done` SSE frames gained `runId`. No existing key or frame changed
shape.

---

## 10. Phase 15 — Meta-Cognition (what changed, what did not)

### 10.1 The single telemetry capture point

`server/llm.js`'s `callLLM` is the only place a model is called, so it is the
only place instrumented. It has an optional `purpose` label and reports every
physical request attempt exactly once on every exit path: success, timeout,
abort, network error, HTTP error, stream error, parse error. A bounded retry is
therefore two attributable call rows rather than one failure being overwritten.
Nothing else in the app is threaded with callbacks. `server/llm.js` also exports
`BANNED_MODELS` so the Policy Engine and `resolveModel()` cannot drift apart —
the ban list, the alias table, the resolution order and the defaults are
unchanged (`pin.model_ban`).

Token usage is captured from the model response where the provider exposes it;
streaming responses do not, so those calls record estimates from character
counts with `tokens_measured = false`. Cost comes from the editable rate table
in `server/meta/rates.js` (constants, not config service). A failed call records
the estimated cost of the prompt that was sent — providers do not bill for 4xx,
so treat cost on a failed run as an upper bound.

The recorder (`server/meta/telemetry.js`) subscribes to
`server/shared/eventBus.js`, which already published per-run lifecycle events.
It finalizes **once**, in one transaction (run row + per-call rows + the
adaptive observation), and is idempotent: the error path and the success path
can both call it.

### 10.2 One strategy, measured rigorously

`server/shared/registry.js` was checked first and does **not** fit the strategy
registry role: it is per-run and in-memory, maps stage name → agent, has no ids,
descriptions, selection signals, enabled state or persistence, and cannot be
inspected between runs. It is left untouched and still dispatches stages.
`GET /api/meta/registry-check` returns that reasoning.

The `strategies` table is seeded with exactly one row, `council_pipeline` (the
canonical path), and its schema allows future rows. The evaluation harness
(`server/meta/evaluate.js`, `scripts/evaluate-strategies.mjs`) is offline and
operator-invoked; there is no route that runs an evaluation on a user's turn.
With one strategy, both arms are the same strategy and the harness says so
(`identical_arms`) instead of declaring a meaningless winner.

### 10.3 Observe mode, and why it cannot be turned off at runtime

The adaptive orchestrator records which strategy it would select and why
(`adaptive_decisions`, one row per run) and switches nothing.
`resolveAdaptiveMode()` refuses `auto` citing `phase15.observe_only`;
`evaluateSwitch()` returns `switch: false` unconditionally in v1 and reports
which evidence thresholds are unmet (20 runs per arm, 10 evaluation trials,
20% latency improvement, error-rate and contradiction deltas). A single success
changes nothing — that guard is stated in the response, not implied.

### 10.4 The law layer

`server/council/laws.js` imports `CHARTER` and lists the four charter laws
(Truth, Evidence, Agency, Dignity) plus twelve operational pins, deep-frozen at
module load, with `assertLawLayerImmutable()` verified by the smoke run (which
attempts `LAWS.push(...)` and a property rewrite and asserts neither takes).
It is not runtime-writable: `modify_law` is refused before justification is even
considered.

`server/meta/policy.js` gates fifteen actions. Every judgment — refusal and
approval — is appended to `improvement_ledger` with the action, target,
proposal, evidence, cited laws, justification, decision and `applied` flag.
"Approved" means **authorized and recorded**: in v1 the only thing actually
applied at runtime is a strategy-registry row (data in a new table that cannot
touch the six seats or the send path). A model change, a schema change or a new
subsystem stays a reviewed code change. A revert appends a new row; nothing is
edited.

### 10.5 New environment variables

All optional; every one defaults to the behaviour described above.

| Variable | Default | Purpose |
|---|---|---|
| `COGNOS_LEDGER_ENABLED` | `true` | set `false` to stop ledger emission entirely (kill switch) |
| `COGNOS_COHERENCE_ENABLED` | `true` | set `false` to skip the coherence monitor stage |
| `COGNOS_TELEMETRY_ENABLED` | `true` | set `false` to stop writing telemetry records |
| `COGNOS_ADAPTIVE_MODE` | `observe` | recorded as requested; v1 forces `observe` and says why |

No secret is read from anywhere but the environment, and no new secret was
added. No auth, no accounts, no login route.

---

## 11. Integrity boundary, cancellation, and route modularization

This evolution closes three gaps discovered after Clause 3 made the Governor a
real final-text gate.

### 11.1 No draft text crosses SSE before governance

The direct Specialist previously used provider streaming and forwarded each
model delta immediately. The Governor ran only after the complete draft existed,
so a vetoed draft was absent from `done`, memory and persistence but had already
crossed the network. The old smoke scenario explicitly tolerated that buffer.
That did not satisfy `pin.veto_integrity` strongly enough.

The Specialist now produces a server-side draft. After all Critic and Governor
revision passes, `server/shared/approvedStream.js` is the sole answer release
point. It emits only the exact final response: an approved draft, a fixed
sovereignty/epistemic refusal, or nothing for an empty response. It yields
between bounded chunks for cancellation but adds no typewriter delay. Regression
tests assert that the first token frame follows the last Governor frame, that
concatenated token frames equal `done.response`, and that a secret-like vetoed
draft never occurs anywhere in the SSE stream.

### 11.2 Stop is cooperative cancellation, not just a hidden browser

`server/routes/chat.js` binds an AbortController to the SSE response lifetime.
A browser Stop/disconnect propagates through `runCouncilTurn`, every orchestrator
stage boundary, `callLLM`, and direct web-search retrieval. An active upstream
request is aborted immediately. Telemetry distinguishes `abort` from `timeout`
and records the run as `cancelled`; the HTTP layer quietly creates no assistant
error message, conclusion event, extracted memory or summary. The already-sent
user message remains as the truthful record of the request.

### 11.3 Structured domain errors survive the API client

The browser request helper now throws `ApiError` with `status` and the parsed
response on `body`. In particular, a Policy Engine `409` reaches the System page
with its decision, reasons, cited laws and Improvement Ledger row intact instead
of degrading to the HTTP phrase `Conflict`.

### 11.4 Modular composition, unchanged route surface

The former all-in-one Express module was split into focused registrars:
`server/routes/chat.js`, `server/routes/knowledge.js`, and
`server/routes/meta.js`. `server/index.js` is now the composition root. Phase 17
adds a focused `server/routes/sources.js` registrar. The later read-only identity
manifest adds `GET /api/identity`, bringing the reviewed surface to 51 local
routes while retaining exactly one `POST /api/chat` answer route.
Cancellation, governed release, and shared query parsing are isolated leaf
modules; reusable System-page UI primitives moved to
`src/components/system/SystemUi.jsx`. `test/integrity.mjs` pins the complete
route surface, while the expanded smoke run retains the full earlier regression
surface.

---

## 12. Browser-native voice mode

The removed LiveKit agent has not been restored: there is still no hosted voice
session, service-role bypass, extra answer route, or audio persistence. Instead,
`src/lib/voiceContext.jsx` provides a replaceable browser speech-synthesis layer.
Its preferences are local to the browser and include mode, automatic playback,
voice, speed, pitch, and volume. Long responses are normalized from Markdown and
split into bounded utterances by the pure helpers in `src/lib/speechText.js`.

Automatic speech is called only from the existing chat SSE `done` callback, with
`done.response`. It is never called from `stage`, `token`, or Specialist output.
That keeps the speech boundary downstream of the same Governor decision that
gates visible answer text. Disabling voice mode while a turn is running is checked
again when `done` arrives, so the pending answer stays silent.

Starting a new turn, changing conversations, leaving Chat, or disabling voice
mode cancels active playback. Completed assistant messages retain explicit
**Listen / Stop** controls, and Settings has a local preview. Browsers without the
Web Speech synthesis API receive normal text behavior and disabled voice controls.
`test/voice.mjs` pins speech-text normalization and lossless chunking; the existing
integrity suite continues to pin the upstream governance boundary.

---

## 13. Latency without reducing reasoning

This pass changes measurement and scheduling, not the council's thought. No
operator, prompt, model default, context budget, revision rule, or Governor rule
was removed or weakened.

### 13.1 Evidence before adaptation

`npm run latency -- --limit=200 --days=7` reads persisted telemetry and reports
p50/p95 for run orchestration, governed-answer readiness, post-processing,
pre-council database setup, individual stages, and model calls by purpose. It
also separates first-request cold-instance candidates from known-warm requests.
`server/meta/latency.js` contains the pure percentile/report logic so the report
is regression-tested and does not need a mutating HTTP route.

Phase 16 adds nullable `performance` metadata to `telemetry_runs` and response
header/decode, returned service-tier, and cached-token measurements to
`telemetry_model_calls`. Migration `0003` is additive and idempotent; old rows
remain valid with NULL fields.

### 13.2 One proven critical-path removal

The adaptive strategy registry remains observe-only and still selects exactly
the canonical council pipeline. Its database reads now begin alongside context
assembly and are joined immediately afterward. The selection, explanation, and
adaptive decision are unchanged, but their independent wait no longer precedes
the context database reads.

### 13.3 Runtime, database, and provider timing

Each chat turn records process age, request ordinal, a conservative
`coldInstanceCandidate` flag, and the separate workspace/conversation/user-message
setup times. Every model call records time to response headers separately from
response body decoding. These are observations only; they are never input to an
operator or adaptive runtime switch.

### 13.4 Provider acceleration is explicit and transport-only

`COGNOS_LLM_SERVICE_TIER` and `COGNOS_PROMPT_CACHE_KEY` are omitted unless an
operator explicitly configures them for a gateway that supports the corresponding
OpenAI-compatible fields. They are request routing hints only. Tests submit the
same messages with and without the hints and require byte-identical prompt
content and the same response. Returned `service_tier` and
`usage.prompt_tokens_details.cached_tokens` are captured so the latency report
can prove whether the provider honored them. No undocumented BluesMinds support
is assumed.

### 13.5 Why a durable post-processing outbox is not silently enabled

An outbox could send `done` before memory extraction, summary, knowledge
projection, deferred Critic telemetry, and final telemetry settle. That would
change immediate consistency and the completed council trace unless a durable,
idempotent worker and next-turn barrier were designed and operated. Doing it
without production evidence would violate the request to sacrifice nothing.

The latency report therefore applies an explicit evidence floor: at least 20
completed instrumented runs, with post-processing occupying at least 20% of p50
run latency, before it labels an outbox a `candidate`. It never enables
one. A candidate still requires a separately reviewed additive design; fewer
samples produce `insufficient_evidence`, and a smaller tail produces
`not_justified`. This completes the requested assessment without turning an
unmeasured optimization into a consistency regression.

### 13.6 Validation contract

`test/performance.mjs` pins percentile arithmetic, the outbox evidence floor,
strategy/context overlap, opt-in provider fields, unchanged prompt content,
and persistence of cold/DB/model/cache/service-tier measurements. The existing
integrity suite continues to prove that no pre-Governor answer text crosses SSE,
Stop cancels active work without persistence, and the single send path remains
unchanged.

---

## 14. Governed documents, links, and bounded agent mode

### 14.1 Documents are immutable evidence snapshots, not executable files

Phase 17 restores document analysis without restoring the removed Base44 blob or
file APIs. The browser sends a bounded base64 payload to COGNOS; the server
validates the file signature/media type and extracts PDF, DOCX, UTF-8 text,
Markdown, or CSV without executing scripts or macros. DOCX central-directory
sizes are checked before decompression and macro-bearing containers are refused.
PDF extraction preserves page locators. Raw bytes are not retained: the durable
snapshot is the exact extracted text, its SHA-256 digest, extraction metadata,
and immutable page/section chunks. Re-uploading the same extracted content in a
workspace reuses the existing snapshot rather than creating mutable copies.

`source_snapshot_created` is appended to the knowledge ledger in the same
transaction as a new source and its chunks. The source/chunk stores expose no
update or delete accessor. Client-provided names, URLs, or source text never
enter prompts from a chat attachment; `/api/chat` resolves the submitted source
id back to server-owned rows.

### 14.2 Links are retrieval, not an open proxy

`server/sources/safeFetch.js` deliberately does not call global `fetch`. It
resolves every hostname, rejects the entire result set if any address is local,
private, link-local, reserved, documentation-only, multicast, or otherwise
non-public, and pins the actual connection to the validated DNS answer. Every
redirect is revalidated. URL credentials, non-HTTP(S) schemes, nonstandard
ports, redirect loops, HTTPS-to-HTTP downgrades, unexpected content encoding,
large bodies, and slow responses are refused. Cookies and authorization headers
are never forwarded.

HTML scripts, styles, iframes, embeds, forms, and similar executable containers
are removed before readable-text extraction. Explicit linked PDF/DOCX/text
content uses the same bounded document extractors. The resulting page is an
immutable source snapshot, never live authority.

### 14.3 Prompt injection is treated as evidence about the source

Deterministic scanners record common instruction-override, system-prompt,
role-impersonation, tool-coercion, and credential-exfiltration patterns as
`risk_flags`; the source text is not silently rewritten. Every model that sees
source excerpts receives a higher-priority instruction that sources are
untrusted data, not commands. Strategists receive source names only; Specialists,
the Synthesizer, and the Critic receive citable evidence. Memory extraction is
explicitly told not to turn document claims into facts about the user.

Evidence packs label every excerpt with a server-produced locator such as
`[src_…:p3]`. A deterministic Governor audit rejects any source id or locator
that was not supplied to that turn. `source_citation_unverifiable` participates
in the existing one-pass Governor revision/fixed-refusal path, so fabricated
provenance cannot cross the governed release point.

### 14.4 Agent mode is useful autonomy with a deliberately hard ceiling

Agent mode is integrated into the existing chat composer and existing
`POST /api/chat` path. It is a subsystem (`agentPrepare`), not a seventh council
seat. It has three explicit per-turn modes:

- `off`: no autonomous plan;
- `observe`: persist proposed reads but execute no agent tools;
- `read_only`: read attached snapshots and open at most three explicit URLs,
  within six total sequential steps.

The typed registry contains only `read_source` and `open_link`. There is no shell,
filesystem, arbitrary HTTP, memory-write, message-send, or generic function tool.
The budget advertises zero writes. Every run and step has an idempotency key and
materialized status; every transition is also appended to `agent_events`.
Failures are contained and visible. Cancellation marks the run cancelled and
stops before another step. Agent preparation is awaited before context assembly,
so there is no background or next-turn visibility race.

Phase 18 adds a fourth mode, `research`, whose consent barrier is real: the run
is created `awaiting_approval` with one step per proposed URL (exact URL +
stated reason), and `POST /api/agent/runs/:id/decision` records an
`agent_approvals` row — decision, reason, and a per-step SHA-256 scope hash over
the run id, step, tool, and input — for every step *before* the first fetch.
Declining records consent and executes nothing; decided runs cannot be
re-decided. Executed research steps attach their fetched pages as ordinary
immutable evidence for the next council turn, and the model-boundary text always
labels them untrusted. The Policy Engine refuses both `enable_agent_write_tool`
and `weaken_source_boundary`, citing the immutable laws `pin.agent_bounded`,
`pin.source_untrusted`, and (Phase 18) `pin.research_approval`. Phase 17 raised
the law layer to 1.1.0, the truthful-self-model pin to 1.2.0, and Phase 18 to
1.3.0. Consequential autonomy — write-capable tools, outbound email/purchases/
publication, background runs, or answers without the Governor — remains
intentionally unavailable.

### 14.5 Voice and existing council integrity

Source locator tokens stay visible in answer text but are stripped from browser
speech so citations do not degrade voice mode. All source-informed drafts still
flow through the same Specialist/Synthesizer, Coherence Monitor, Critic,
Governor, and sole approved-text release function. Source ingestion and agent
status routes return evidence/provenance, never a conversational answer.

`test/sources-agent.mjs` exercises real PDF/text extraction, HTML executable
removal, archive/chunk boundaries, prompt-injection flags, URL and SSRF rules,
exact Governor citations, immutable persistence, server-owned attachment
resolution, observe mode, read-only partial failure, cancellation, Policy Engine
refusals, and the one chat route. The voice, latency, integrity, and 170-assertion
smoke suites remain separate regression gates.

---

### 14.6 Governed image ingestion and durable research projects (Phase 18)

Images are evidence with the same untrusted-data contract as documents. The
browser sends bounded base64 (PNG/JPEG/WebP only); the server validates the
signature and real dimensions, keeps the immutable original (source_images:
bytes, SHA-256, media type, geometry; served at `/api/sources/:id/image` with an
ETag), and deduplicates byte-identically. When the Image Desk is enabled it
makes one bounded JSON-schema reading (≤ 24 regions, no file or tool access)
whose transcript is stored in `image_analyses` with model, latency, and attempt
provenance — a labeled interpretation that can misread, never a replacement for
the hashed original. Recognized text is screened for the same prompt-injection
patterns as documents, and any `instruction_override`/`injection` pattern is a
risk flag on the source row. Each region becomes an immutable citable chunk with
an `image_region` locator rendered as `[src_…:rN]`; manifests and the identity
self-model both tell the council that image transcripts are model-extracted
readings and that printed image text is not instructions.

Projects (migrations/0005) are durable folders — not accounts and not council
seats: `projects` plus optional `project_id` columns on conversations and
sources keep every chat, immutable snapshot, agent run, step, and approval
grouped across sessions. Deleting a project detaches rows; it never deletes
evidence. The UI exposes projects in the sidebar, a Projects page, and a
project chip in each project chat.

## 15. Canonical identity and self-knowledge

The old prompt contained only the generic sentence “You are COGNOS, an
intelligent AI reasoning assistant.” That named the assistant but did not give it
a grounded account of its own architecture, authority boundaries, runtime
capabilities, or limits. A model asked how the product worked therefore had to
infer details from incidental prompt context and could confidently invent them.

`server/identity.js` is now the single versioned source of truth for public
self-knowledge. Its deeply frozen manifest names **COGNOS** (not Cognito), states
that it is software rather than a person or model provider, explains all six
operators and their authority, describes the twelve-step turn lifecycle, lists
capabilities and supporting subsystems, records hard boundaries, and maps each
major implementation area to its repository location. Runtime availability is
constructed separately from `getSystemConfig()`, so “built in” never silently
means “enabled in this deployment.” The manifest contains no credentials, user
data, private prompt text, or hidden model chain-of-thought.

A compact form is appended after mutable workspace, memory, and source context in
every answer-producing Specialist/Synthesizer prompt and in the Critic's audit
prompt. This ordering and explicit precedence prevent a workspace instruction,
memory, document, webpage, or tool result from renaming COGNOS or inventing a
capability. Decomposed Specialist calls receive the same self-model, avoiding a
gap where only direct answers knew the architecture.

`GET /api/identity` exposes the full manifest and safe runtime state as read-only
transparency data. It is not a conversational endpoint and cannot create an
answer. The new lazy-loaded **About COGNOS** page renders the exact same object as
a readable architecture tour: identity rules, principles, six operators, turn
flow, capabilities and availability, subsystems, runtime facts, hard limits, and
implementation map. The Welcome screen links naturally into a governed
self-explanation through the existing chat path.

The law layer adds `pin.truthful_self_model` and is now version **1.2.0**. The
Policy Engine recognizes and refuses `modify_identity`: changing identity is a
reviewed code change, never a live adaptation. `test/identity.mjs` pins the name,
deep immutability, exactly six operators, Governor sovereignty, complete flow,
runtime-state distinction, prompt precedence, non-secret API response, Policy
refusal, and the continued existence of exactly one `POST /api/chat` answer
route. The complete local Express surface is now 51 routes, 50 excluding the
local static-file fallback.

---

## 16. Bounded recovery from transient model-gateway failures

The model boundary previously failed a complete council turn immediately when
the configured OpenAI-compatible endpoint returned a transient HTTP 504. It also
placed the provider's raw response body in the persisted assistant error; an
OpenResty HTML error page therefore appeared verbatim in Chat. This was truthful
but neither resilient nor an appropriate public error boundary.

`server/llm.js` now retries transient network failures and HTTP
408/429/500/502/503/504 responses once by default (`COGNOS_LLM_MAX_RETRIES`,
clamped to 0–2). The retry is transport-only: it serializes the payload once and
reuses the exact bytes, model, service tier, and prompt-cache key. Backoff is
bounded (250 ms exponential, at most two seconds), honors a short `Retry-After`,
and starts another attempt only when at least one second remains after the wait.
The existing `COGNOS_LLM_TIMEOUT_MS` is one logical deadline across all attempts,
so recovery cannot multiply a 60-second call into a 120-second function overrun.
Client cancellation aborts the active attempt or backoff immediately. A provider
stream can be retried only before any candidate delta exists, preventing a
partial draft from being duplicated.

Provider error bodies are read through an 8 KiB cap. Public errors map gateway,
rate-limit, credential, and server statuses to concise descriptions; raw HTML,
proxy branding, bearer values, API-key patterns, and database URLs never enter
the user-visible error or telemetry. Non-transient request errors are not
retried. A persistent 504 now reads “The model provider gateway timed out (HTTP
504) after 2 attempts,” rather than rendering an HTML document.

Telemetry records each physical attempt with its attempt number. When a later
attempt succeeds, the earlier failure remains in the run but is marked
`recovered: true` with the recovering attempt, preserving both the incident and
the successful outcome. Health, Settings, `/api/identity`, and About COGNOS show
the active logical deadline and retry count. The canonical self-model is bumped
to version 1.1.0 because model transport and recovery are now part of what
COGNOS truthfully knows about itself.

`test/performance.mjs` reproduces the reported HTML 504, proves the second request
uses identical prompt/model content, validates recovery and persistent-failure
bounds, rejects HTML leakage, and verifies durable attempt/recovery attribution
through a complete governed turn. Retries do not create another answer path and
all recovered candidate text still passes through the Critic and Governor before
release.

---

## Phase 19 — Durable autonomy (residents, goals, tick) — BUILT, default off

Autonomy in this codebase is split into **work** and **authority**, because
mixing them is what makes other autonomous agents dangerous and what would
break COGNOS's governance. A resident may do unbounded amounts of *work* —
read, note, plan, search, summarise. It may never exercise *authority*: every
effect it wants to produce is staged, judged by a model-free Action Governor,
and released only through the outbox. The Governor does not deliberate, so
there is no seventh seat; it checks fourteen named rules and refuses with the
rule that fired.

**Skills are code, not data.** A database table of skills would be a capability
write — a law change in a different hat. The registry is a frozen object
compiled from `server/skills/`, and only the per-resident `skill_allowlist` is
data. Adding a skill is a reviewed code change that names its tier, argument
schema, idempotency rule and kill switch.

**A goal does nothing until it is authorized.** Authorization is a row carrying
the SHA-256 of the exact scope and budget consented to. Widening either is a
new decision, never an edit, so `pin.goal_scope_immutable` is enforceable and
not merely stated.

**Findings are evidence, not answers.** A goal's notes never reach the send
path; a goal cannot propose a draft answer. Findings surface only when the user
asks, through the council, through the Governor.

Six defects were found by building the tests rather than by reading the code,
and each was a guard that could not fire: a blank `COGNOS_AUTONOMY_ENABLED`
enabled autonomy; budget keys never matched their spend keys, so no budget was
ever exhausted; tick rows carried a null workspace, so the workspace ceiling
could not be measured; a tick id inside the notice payload defeated effect
deduplication; three call sites tested a now-object `config.notices` for
`false`; and a refused step wrote no row, so an escalation attempt left no
trace. All six are pinned by regressions.

**Deployment.** The heartbeat starts only in `server/serve.js`; `server/index.js`
never starts it, because Vercel imports that file as a serverless handler and a
timer there would do nothing but leak. Graceful shutdown stops the heartbeat,
gives an in-flight tick a bounded window to park and release its lease, then
closes the HTTP server and the pool — so a redeploy is not a crash.

Autonomy is **off by default** (`phase19.autonomy_default_off`). Unset means
frozen: no goal wakes, no notice is written, no tick row is recorded. Rungs 3–6
(Phases 20–23) are designed but unbuilt, and Rung 4 stays behind a shadow-mode
corpus until that corpus justifies going live.

**The Autonomy page.** The UI is an operator surface, not a chat surface. It
reads stored rows and offers exactly two decisions — authorizing a goal, and
approving/refusing/reverting a staged effect. A goal's findings appear under an
explicit "Untrusted findings" heading, never as COGNOS speaking, and the only
way to turn them into an answer is the "Ask COGNOS about this" turn that opens
the resident's conversation. When autonomy is frozen the page says so first and
disables creation, because frozen is the resting state, not a degraded one.
