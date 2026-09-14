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

## Phase 20 — Sub-agents, promotion, the Goal Card, T3 evidence fetch — BUILT, default off

Phase 19 split autonomy into work and authority. Phase 20 spends that split:
goals can now delegate bounded slices of work to narrow sub-agents, ask for a
finding to be promoted into memory, fetch evidence from the web under a
per-goal allowlist — and the user can watch and veto all of it from inside
chat. Authority still never leaves the human/Governor pair: workers cannot
widen anything, promotions land `inferred` with origin tags, and every T3 read
is staged, Governor-judged, and replay-deduped before its digest exists.

**Workers are evidence with provenance, not authority.** `subagent.spawn` takes
a declared skill subset and sub-budget and the code clamps both: unknown or
ungranted skills fail the spawn loudly (a dropped skill is an error, never a
silent narrowing), the sub-budget clamps to `COGNOS_SUBAGENT_*` ceilings, and a
worker that reaches outside its subset is stopped with a recorded row. Nesting
refuses. A worker's findings enter the parent goal's notes carrying the
worker's id in their origin tag, so `pin.subagent_untrusted` is checkable per
row rather than merely stated.

**Promotion is a request, never a write.** The skill records a row; the note
applies only through a human confirm or a Governor-approved answer that cites
the finding's locator. Either way it lands `evidence_level: "inferred"` with
`autonomy_goal:<id>` origin tags — the answer-carried path re-reads the note at
apply time, so tampering with the quoted text cannot launder a paraphrase into
memory, and an uncited or unrequested finding never moves. The queue withholds
secret-bearing bodies instead of displaying them, and secret notes refuse at
every gate including the direct route.

**The Goal Card answers who/what/why inside chat.** `?goal=<id>` deep-links
from the Autonomy page into the goal's home conversation (a goal born in a
thread stays in that thread — asking from elsewhere 409s rather than leaking).
The card shows the birth barrier (authorize/decline over the exact scope and
budget the hash will record), findings with their `[goal_<tail>:nN]` locators,
narrow workers with carved budgets, open promotions with approve/refuse, and a
banner when the last answer carried findings into memory. The Autonomy page
grew a Promotions tab with the same queue, including `decision_source` so an
`answer_carried:<message>` application is distinguishable from a human confirm.

**T3 reads respect the scope they were authorized under.** `web.fetch` is
gated by the goal's URL allowlist (exact URLs or host+prefix, never wider)
plus structural SSRF rules that refuse literal IPs even when named; `web.search`
additionally needs the rung flag, because a query is a data flow outward.
Fetches are staged once per URL and replayed to later steps, bodies are
digest-only, secrets in a response refuse rather than persist — and with no
network path the skill fails closed. The Action Governor judges the goal's
*live* scope and then checks the authorization row's hashes still cover it
(`authorizationCovers`), so a scope that changed after consent refuses as stale
rather than executing under words nobody approved.

**Citations are a grammar, not a courtesy.** The Governor audits every
`[goal_<tail>:nN]` in an answer against the locators the turn actually loaded;
a guessed ordinal, another goal's note, or a paraphrase dressed as a locator is
unverifiable and the answer is refused (`pin.cite_loaded_notes`).

Four defects were found by building the tests, all the same shape as Phase
19's — a guard that could not fire. The Governor judged a live scope no
authorization row had ever named, so consent and judgement could silently
disagree (now bound by `authorizationCovers` plus a stale-scope rule); repeated
secret promotions wrote a fresh refused row each time, so the queue filled with
duplicates (requests are now idempotent per note+target); `.env.example`
documented `COGNOS_SKILL_NOTE_PROMOTE_REQUEST`, a switch nothing reads, while
the wired `COGNOS_SKILL_NOTE_PROMOTE` went undocumented — an operator flipping
the documented switch would have changed nothing (the suite now asserts every
registry kill switch appears in `.env.example` under its wired name); and the
test run itself hung on its first all-green pass because the harness server was
never stopped (success, it turns out, was the one path never exercised).

Per the §10 rhythm: migration `0007`, laws `1.5.0` (`pin.promotion_inferred`,
`pin.cite_loaded_notes`), identity `1.4.0` (the autonomy boundary now states
the promotion path instead of claiming read-only), `test/phase20.mjs` (22),
and this section. Rung 3 stays default off behind `COGNOS_AUTONOMY_RESIDENTS`
(workers, promotion) and `COGNOS_AUTONOMY_SEARCH` (web search); Rung 4 stays
behind its shadow corpus, and Rungs 5–6 remain designed but unbuilt.

## Phase 21 — The first external write (Rung 4, T4, `webhook.post`) — BUILT, default off

Phase 20 let a goal read the world under an allowlist. Phase 21 lets it act on
the world, and the entire design of the phase is that acting is not reading with
a different verb: one adapter, `webhook.post`, judged harder than a fetch of the
same URL, staged and Governor-judged like every other effect, and delivered
nowhere. This revision ships Rung 4 **built and off**. `COGNOS_AUTONOMY_EXTERNAL_WRITES`
is unset by default, the outbox still defaults to `shadow`, and a live verdict
additionally refuses with `EVIDENCE_GATE_UNMET` until a recorded corpus earns it.
The distance between "the code exists" and "COGNOS posted to the internet" is
three separate facts, reported separately everywhere they are asked about.

**A webhook is a trigger, not a message.** That is why it is T4 while a fetch of
the same URL is T3: the same POST that reports a build can deploy one, unlock a
door, move money, or post publicly. One adapter buys most of the external-write
surface (Slack, Discord, n8n, Zapier, Make, Home Assistant, any custom endpoint
are all "POST a body to an https URL"), so §4.7.1's four risks each get their own
code path rather than a shared hope. Outbound SSRF: `checkWebhookUrl` refuses
anything that is not https on 443 with no credentials, no literal IP, and no
local or reserved hostname, then `resolvePublicHosts` requires *every* DNS answer
to be public, then the transport is pinned to those addresses and every redirect
is re-validated and re-resolved per hop — a public URL that 302s to
`http://169.254.169.254/` never makes its second hop, and a refusal never names
the private address it found, because that is the reconnaissance the probe was
for. Downstream harm: destinations come from scope rows granted at authorization.
Credential leakage: signing is by `secret_ref`, an environment variable NAME
resolved at send time, used to HMAC the body, and stored nowhere. Amplification:
one attempt plus one bounded retry on a retryable status only, `Retry-After`
honoured under a cap, the idempotency key on the wire so a receiver can dedupe
too, and per-goal/per-day caps judged by the Governor rather than trusted to the
loop.

**Destinations are granted, never chosen — and a read grant is not a write
grant.** `destinationsForScope` returns the entries the goal was authorized for
and nothing else; a class-only grant (`"external_write"` with no destination
list) grants *nothing*, because "you may write" is not "you may write here", and
"here" is the only part an operator can revoke. Phase 20's `urlAllowlist` never
widens into a write destination, so looking somewhere and acting there stay
different authorities. Wiring this found a contract mismatch between two sections
of the design: §4.7.1 writes the gate in terms of the skill (`webhook.post`) and
§7 writes it in terms of the effect class (`external_write`). Matching only the
class would have refused every correctly granted destination with
`EFFECT_NOT_IN_SCOPE`; matching only the skill would have refused every scope
written the other way. Both spellings grant, and the destination check runs
separately either way. An unshaped URL is *staged* and refused by the Governor
rather than rejected in the skill, because a refused SSRF probe that leaves no
row is a probe nobody can count — and the count is what earns the rung. Argument
headers are the one input refused before staging, for the opposite reason: a
refused `Authorization: Bearer …` that was staged first would put the credential
in a payload column.

**Earned, not enabled.** `GET /api/autonomy/rungs` and
`POST /api/autonomy/rungs/:rung/evidence` are the phase's two routes, and the
Autonomy page's Outbox tab grew a Rung 4 panel that reports the flag, the outbox
mode, whether anything delivers now, per-rule refusal counts, the destination
distribution, and the recorded evidence rows. `measureRung` reads the corpus and
answers four questions, all of which must be yes: are there at least
`minShadowSamples` samples *of this tier* (twenty-five notices say nothing about
whether a webhook gate is too loose), are there zero false releases under
`auditRelease`'s re-audit, does the corpus contain at least one release verdict
(a gate that never releases has proven nothing), and at least one refusal (a gate
that never refuses has not been exercised). A measurement that fails is recorded
too, as `insufficient` — refusing to write down a failed gate would leave no
history of having asked. And the recorded metrics must satisfy the gate *as it is
configured now*: raising `minShadowSamples` after the fact invalidates an old
justification instead of grandfathering it, because the alternative is a ratchet
that only turns one way.

**The record is metadata, and reversal admits what it cannot do.** A receipt
holds ids, statuses, counts, timestamps, header NAMES and content digests. The
response body is read, digested and discarded inside the adapter, so a receiver
that echoes the signing secret back — or an instruction — has nowhere to put it:
`test/phase21.mjs` points a live delivery at a sink that does exactly that and
then scans eight tables for the value. Ledger events carry a minimized receipt
(`url`, `status`, `attempts`, `accepted`, `signed`) rather than a copy of it.
Reversing a delivered external write sets `reversal.unsendable: true` with
wording that cannot be read as an un-send ("the delivery already happened; this
row records the reversal, not an undo"), preserves the original receipt, and
appends to both the outbox event log and the goal's own history; reversing a
shadow row says the opposite thing, because nothing was delivered and the
transition is the whole reversal.

**Model prose now leaves the deployment, and that is stated rather than buried.**
A webhook body is composed by the planner, so Phase 21 is the first phase in
which text a model wrote goes somewhere outside it. That does not breach
`pin.single_send_path` or `pin.notice_deterministic` — a webhook is not an answer
and not a notice, and the suite asserts it creates no message row, emits no SSE
token, and reaches no template — but it is a real change in kind, and the bounds
are the reason it is acceptable: the destination is granted row by row and
revocable with the rung, every send is judged individually against eleven rules,
the body is byte-capped, the whole thing is shadow-judged until a corpus earns
live, and the receiver's answer is digested and labelled untrusted. The
`reason` argument is model prose too, and it is stored truncated beside the
destination it argued for — operator-facing evidence in the same class as a goal
note, reaching no notice and no stream.

**Quiet hours brake deliveries, not records.** `COGNOS_AUTONOMY_QUIET_HOURS=22-7`
refuses external deliveries inside the window with `QUIET_HOURS`, honouring a
window that wraps midnight, and treating an unset, malformed, or empty window as
never active — a brake an operator asks for, not one the system invents. Notices
are exempt on purpose: a notice is how an operator learns a goal parked, so
suppressing it at 3am would hide the thing it exists to report.

Seven defects were found by building this, five of them the same shape Phase 19
and Phase 20 kept finding — a guard that could not fire. `spent.effects` and
`spent.externalEffects` were declared as budget lines in Phase 19 and nothing
incremented them, so both ceilings were inert. Spend was then recorded only on
the step's success path: six of `runStep`'s seven exits returned early — a
blocked plan, a done plan, a plan naming no skill, a planning failure, a refusal,
a failed skill — and every one of them had already paid for a planner call and
its tokens, so a failing goal was the one kind of goal that could never exhaust
a budget (the bump now lives in a wrapper, which makes the next early return
somebody adds accounted for by construction; `spent.steps` still counts progress
only, because the planner prompt reads it as "steps used"). `maxNoticesPerDay`
counted rows in `autonomy_notices`, which only exist once a notice is delivered —
so in shadow, the only mode anybody runs before earning live, the notice cap
could not be reached; it now counts judged notify effects from the ledger. A
notice was also counted as an effect against `maxEffectsPerDay`, so a goal that
hit its effect cap was refused the notice reporting the cap: silence by
construction, in the one design that says a goal which cannot report fails
silently. Notices now answer to their own line and are exempt from the two
effect-count lines, with the ledger-based notice cap keeping that exemption from
becoming an unbounded channel. A refused step stored the model's raw arguments,
so a refused `Authorization` header value survived in `goal_steps.input`
*because* the effect was refused; `redactSecrets` now keeps the record's shape
and drops its secrets, including credential-keyed values no pattern would
recognise, while deliberately preserving `secret_ref` — a reference is a name,
and the name is what the ledger is supposed to keep. Approving an already-judged
outbox row answered 200 with the unchanged row, so an operator clicking approve
on a shadow-judged Rung 4 effect got a success response for a delivery that did
not happen; it now answers 409 naming the row's state and the mode that would
make an approval mean something, while a replayed `released` row still returns
its receipt, because that answer is idempotent and correct. And
`test/phase18.mjs` hardcoded identity version `1.4.0`, so this phase's honest
version bump broke a suite about images — a test that fails on truthful change
trains the next reader to edit assertions instead of reading them, so it now
compares against the code-owned constant.

Laws are `1.6.0` with three new pins: `pin.external_write_earned` (a live write
needs a recorded corpus, and a shadow release is not a delivery),
`pin.destination_granted` (destinations are granted entry by entry, re-checked
per hop, and credentials travel by reference), and `pin.receipt_metadata_only`
(the record of an effect is ids, counts and digests). The Policy Engine gained
two gated actions, `enable_outbound_channel` and `set_autonomy_rung`, so a
runtime proposal to open a channel or raise a rung is refused *with a law* rather
than falling through to "unknown action" — a vocabulary gap and a boundary are
different refusals, and only one of them is enforceable. Identity is `1.5.0`:
thirteen capabilities and thirteen subsystems, with `external_effects` and
`action_governor` named, and the runtime block reporting the rung flags, the
outbox mode, the built tiers, and the evidence rows truthfully rather than
asserting a boundary in prose. `unsupported` was restructured to name what is
still true — no T5, no inbound messaging, no writes from a chat turn.

Per the §10 rhythm: migration `0008_phase21_webhook_effects` (the rung-evidence
table plus `autonomy_outbox.destination`), laws `1.6.0`, identity `1.5.0`,
`test/phase21.mjs` (35 checks, including a loopback sink that receives real bytes
through the injected transport seam), and this section. New environment
variables: `COGNOS_AUTONOMY_EXTERNAL_WRITES`, `COGNOS_AUTONOMY_QUIET_HOURS`,
`COGNOS_WEBHOOK_MAX_BODY_BYTES`, `COGNOS_WEBHOOK_TIMEOUT_MS`,
`COGNOS_WEBHOOK_MAX_REDIRECTS`, `COGNOS_WEBHOOK_MAX_RETRY_DELAY_MS`,
`COGNOS_WEBHOOK_MAX_RESPONSE_BYTES`, and the registry's
`COGNOS_SKILL_WEBHOOK_POST`. Rung 4 stays default off; Rungs 5–6 remain designed
but unbuilt. Phase 22 is what turns an earned corpus into deliveries, and it
should not start until this one has been running in shadow long enough to have
something to measure.

## Phase 25 — Hybrid enablement, the resident designer, plain-language autonomy UX — BUILT, default off

Phases 19–21 built a loop that is frozen until an operator flips a variable and
restarts. That is the right resting state. It is the wrong *surface*: the
Autonomy page could show you a frozen system and offer the name of a variable
you cannot set from a browser. A safety property that can only be explained is
a safety property that will be worked around.

Phase 25 does not add a rung, a skill, a write, or a law. It adds **who
decides**, **how you describe a resident**, and **how the page talks**. Autonomy
is still off by default. What changed is that an operator can now decide *who*
decides.

**Hybrid enablement.** Two variables, one row, one precedence order resolved in
exactly one place (`server/autonomy/settings.js`, which `autonomyConfig()` asks):

- `COGNOS_AUTONOMY_ENABLED=true` is a **pin**. Autonomy is on and the UI may not
  turn it off. `POST /api/autonomy/settings` answers 409 and says so.
- `COGNOS_AUTONOMY_UI_CONTROL=true` is a **delegation**. The Autonomy page gets
  a real Enable/Off switch. Delegation is not enablement — the system is still
  off until someone flips it.
- Neither set: the page hands over copyable setup steps instead of a dead toggle.

The stored value lives in `autonomy_settings` (migration `0012`), one row per
workspace, and it can hold **only** the global on/off — there is no column for a
rung, a ceiling, a skill or a budget, so the table cannot widen anything. A flip
takes effect on the next heartbeat with no restart, and every flip is appended
to `workspace_audit` as `autonomy.enabled` with its from/to values and who did
it. Both switches are allow-lists: only `1/true/yes/on/enabled` enable, so
`COGNOS_AUTONOMY_ENABLED=` — the most likely misconfiguration on a real host —
is **off**. An unloaded cache reads `false`; a failed re-read keeps the last
known value and marks itself `stale`. Health already reports `enabledSource` /
`pinned` / `uiControl`; identity 1.8.0 now reports the same facts, plus that the
designer creates nothing and is not an answer path. Optional email/Google
accounts (Phase 24) are a runtime switch, not an absence — the stale "no user
accounts" boundary is gone.

**The conversational designer.** A Bot button in chat and *Design with COGNOS*
on the Autonomy page open the same drawer. Describe what you want watched and
how often; COGNOS drafts the complete resident. Four rules make that safe:

1. A turn creates nothing. Creation is a separate explicit POST that re-clamps
   what the browser sent.
2. Skills are intersected against the registry *and* `isSkillEnabled`, and every
   omission is named. The catalogue in the prompt repeats that verdict — a
   previous version tagged every rung-gated skill as "NOT available here"
   whenever the skill merely *declared* a rung, including when that rung was on.
   The allowlist was still correct, so the lie was invisible in every output the
   tests already checked; it only showed up as the model quietly refusing a
   design the operator was entitled to.
3. Budgets only clamp down against `DEFAULT_GOAL_BUDGET` (the same constant the
   prompt quotes). Zero is the only floor; a negative proposal is nonsense, not
   a special case for cost.
4. Failures are sentences. A missing key, an unreachable provider, or
   unparseable output return a bounded, secret-free message and a code (503/502,
   never a 500), and the previous draft survives. The drawer marks the user
   bubble that already exists as failed rather than appending a second copy of it.

The designer works while autonomy is frozen — that is the point of it. Creation
is what waits. Its model prose is a short design note about the rows it
proposes: `POST /api/chat` remains the only route that composes an answer.

**Attention.** `GET /api/autonomy/attention` answers "what does autonomy want
from me?" in one query: waiting authorizations, staged effects, unread notices,
parked goals, open promotions. Each group names the tab that resolves it. Rows
are bounded; **count is the full total**, so `?limit=1` cannot pretend the inbox
is empty. Statuses read as sentences everywhere — *Waiting for you*, *Paused
with a reason* — from `src/lib/autonomyLabels.js`, with the machine vocabulary
demoted into a Technical details disclosure rather than deleted.

Building this found the same shape of defect Phases 19–21 kept finding — a
guard that could not fire, or a surface that lied while the clamps were honest.
The catalogue annotation ignored `runnable`. Attention `count` was
`rows.length`. Identity still claimed "no user accounts" after Phase 24. All
three are pinned.

Per the §10 rhythm: migration `0012`, identity `1.8.0` (laws stay `1.6.0` —
Phase 25 adds no pin), `test/autonomy-ux.mjs` (17 checks, three harnesses:
delegated / not / pinned), and this section. New environment variable:
`COGNOS_AUTONOMY_UI_CONTROL`. Rungs 5–6 remain designed and unbuilt.

## Phase 22 (autonomy row) — Earning the flip to live, T4 only — FIRST SLICE BUILT, default off

**The number collision is real and this section is the second Phase 22.**
Migration `0009` and `test/phase22.mjs` are the README's Phase 22 — bounded
context plus structured memory — and they shipped. `AUTONOMY.md` §10's Phase 22
is the autonomy row: *outbox → `live` from the shadow evidence record, plus T5
with per-effect human approval.* This section is the **first slice of that row**
and nothing else. T5 shipped later as **Phase 22C** (below). The new test file is
`test/outbox-live.mjs`, not `test/phase22.mjs`, precisely so the collision
cannot produce two files with the same name and different meanings.

**What was true before this.** Live webhooks were not missing code. Phase 21
built `webhook.post` with DNS pinning, per-hop re-validation, `secret_ref`
signing, digest-only receipts and destination grants in scope rows; the Action
Governor judged every T4 effect; `EVIDENCE_GATE_UNMET` refused a live release
with no recorded corpus. What was missing was **permission to perform**, and the
only way to grant it was `COGNOS_AUTONOMY_OUTBOX_MODE=live` plus a restart. That
switch reported nothing at the moment it was thrown. Set it with no corpus and
the deployment sat in a mode where every effect was individually refused — safe,
and not honest: an operator flipped a global switch and got no answer until a
delivery was attempted and refused for a reason the switch had not mentioned.

**Three additions, and deliberately nothing else.**

1. **A readiness report.** `describeLiveReadiness` answers "what would it take to
   go live *right now*?" as eight named conditions, each carrying a sentence to
   read when it is unmet and an empty string when it is met — an invariant
   enforced by the shape of the helper that builds them, not by each condition
   remembering it. It is served by `GET /api/autonomy/rungs` as `live` and by
   `GET /api/autonomy/settings`, so the answer arrives *before* the click
   rather than as a 409 after it, and it is rendered on the Autonomy page's
   Rung 4 panel as a checklist with a Go live button that is disabled until
   every box is ticked.

2. **A guarded flip.** `POST /api/autonomy/settings` accepts `{ outboxMode }`
   and stores it in `autonomy_settings.outbox_mode` (migration `0013`, one
   nullable column on the table Phase 25 created). Widening to `live` is refused
   with `409 live_not_earned` and the whole report attached. **Narrowing is
   refused by nothing** beyond delegation and a pin. A request for the mode
   already in effect writes no row and records no transition, because a flip
   that changed nothing must not look like a decision somebody made. One request
   changes one switch: `{ enabled, outboxMode }` together is a 400, since the
   two have different guards and accepting both would mean guessing.

3. **One approved destination.** `COGNOS_AUTONOMY_LIVE_DESTINATION` names a
   single https endpoint. A live T4 release needs it *in addition to* the
   destination granted in the goal's own scope, and refuses with
   `DESTINATION_NOT_APPROVED` when the goal was granted somewhere the deployment
   did not name. Both gates must hold, so their intersection is strictly
   narrower than either alone — the safe direction for a second gate to be wrong
   in. It is one URL and not a list, because a list is how "one approved
   destination" quietly becomes a class grant.

**Precedence, and the one asymmetry.** The effective mode is the *narrower* of
the environment value and the stored row (`shadow` < `dry_run` < `live` by reach
into the world), resolved in `settings.js` so there is exactly one place that
decides it — the same discipline Phase 25 applied to `enabled`. Absence of both
is `shadow`. The asymmetry: an environment pin holds the mode **down** finally,
but a pinned `live` can still be **narrowed** by a stored `shadow`. Every other
pin in this codebase outranks the UI completely; this one may not, because a
brake an operator cannot reach from a running system is not a brake. The
trade-off is recorded here rather than left to be discovered: an operator who
pins `live` has handed the brake to the API, and only the brake.

**Why the corpus has to be aimed at the destination.** Seven of the eight
conditions are facts about switches and rows. The eighth — `corpus_aimed` — is
the one that makes the evidence mean something: a gate satisfied by twenty-five
shadow deliveries to endpoint A is evidence about A's gate, not about B's. So a
flip is refused when the corpus was earned against other endpoints, and the
sentence says to name the destination *before* earning the corpus. This is the
condition that makes the ordering of the two operator actions matter, and it is
the reason the readiness report counts `aimedAtApproved` and `aimedElsewhere`
separately rather than reporting one number.

**Shadow is exempt from the destination gate, on purpose.** The shadow corpus is
what earns the rung; refusing its samples would starve the gate that decides
whether live is safe. So `DESTINATION_NOT_APPROVED` fires on live verdicts only,
and the readiness report — not the Governor — is where an operator learns that
the corpus they earned is aimed somewhere else.

**Two pins, and the two gated actions that now cite them.**
`pin.live_destination_approved` (a live write goes only where the deployment
named) and `pin.live_mode_earned` (going live is a recorded decision, never a
default) join the law layer at 1.7.0. `enable_outbound_channel` and
`set_autonomy_rung` in the Policy Engine already refused a runtime adaptation
that tried this; they now cite the specific pins, so a refusal names the
boundary that was hit instead of only the general one.

**Audit.** Every flip appends to `workspace_audit` as `autonomy.outbox_mode`
with both values, the effective result, who did it, whether it widened, the rung
flag, the sample and false-release counts, the evidence row's `metrics_sha256`,
and the approved destination's **SHA-256 — never the URL**. An audit row is
readable by anyone who can read the workspace's history; the digest still proves
*which* endpoint was approved at the moment of the flip without carrying the
endpoint around forever. That is `pin.receipt_metadata_only`'s discipline
applied to a configuration value, and `test/outbox-live.mjs` asserts no audit row
and no mode-history entry contains the endpoint.

**The same discipline on served surfaces, which caught a real inconsistency.**
The audit-row reasoning is about durability, so a first reading could keep a
*live* configuration response at full fidelity: it is not stored, and the
operator typed the value themselves. This slice started out doing exactly that —
`GET /api/autonomy/status` returned the resolved destination including its URL,
while the readiness report on `GET /api/autonomy/rungs` returned only the
hostname, each with a comment defending its own choice. Both surfaces are read by
the same audience, so the difference was not a distinction, it was a drift: the
URL was published by whichever route had not thought about it.

Resolved narrow, and through one function rather than two similar blocks.
`describeLiveDestination()` in `server/autonomy/config.js` is the single
definition of what a surface may say about an approved destination —
`configured`, `misconfigured`, `hostname`, `reason`, `env` — and both routes call
it, so they cannot drift again. `resolveLiveDestination()` still returns the
normalized URL, because the scope matcher and the delivery adapter need it; it
simply is not what gets served. What is given up is the ability to see the
approved *path* from the API, which matters when two endpoints share a host. The
hostname plus `configured` plus `reason` answers the question an operator
actually has — did this deployment pick my value up, and if not, why — and
`test/outbox-live.mjs` now asserts the endpoint appears nowhere in the status
body, as a privacy regression rather than a convenience assertion.

**What this slice did not do.** No rung was raised, no ceiling lifted, no skill
added, no budget widened, and T5 was not touched: `tierAllowed` still refuses it
outright, the outbox route still refuses to approve one, and `auditRelease`
still counts any T5 release in a corpus as a false release by definition.
`builtTiers` is still `T0–T4`. Rung 5 inbound messaging is still Phase 23. The
rest of the Phase 22 autonomy row — T5 with per-effect human approval, never
class-authorized, default off, separate security review — was design only when
this slice shipped; it is now **Phase 22C** (below), built and green.

**Two things found while building it, recorded rather than quietly fixed.**

- **`SHADOW_GATE` freezes at module load.** `minShadowSamples` is read from
  `COGNOS_AUTONOMY_MIN_SHADOW_SAMPLES` when `config.js` is first imported, so a
  test file that imports the module statically cannot lower the floor with
  `bootHarness` afterwards — the override silently does nothing and the suite
  measures a gate of 25 while asserting a gate of 6. `test/outbox-live.mjs`
  therefore earns the real 25 samples across five goals, inside the default
  per-goal ceilings, instead of lowering a floor it could not reach. Worth
  knowing for any future suite that wants a smaller corpus.
- **A human Approve can deliver while autonomy is frozen.** `judgeEffect` does
  not consult `config.enabled`, and the outbox decision route does not either;
  both check the rung flag, and the Governor checks the evidence row and now the
  approved destination. So a staged T4 effect can be approved and sent on a
  deployment whose loop is off. This slice did **not** change that: it is Phase
  21 behaviour with its own tests, and narrowing it belongs in a reviewed change
  of its own rather than riding along with a mode switch. What this slice did do
  is stop the surfaces from implying otherwise — `deliversNow` (does the *loop*
  perform release verdicts?) is now reported next to `deliversOnApproval` (is an
  approval a live decision?) on `/api/autonomy/status`, `/api/agent/tools`,
  `/api/identity` and the Autonomy page, where the pill that used to read
  *delivers nothing* now reads *an approval can deliver*.

Per the §10 rhythm: migration `0013`, laws `1.7.0` (two new pins), identity
`1.9.0`, `test/outbox-live.mjs` (18 checks: six pure, twelve against a
harness that delegated the mode and named one destination), and this section.
New environment variables: `COGNOS_AUTONOMY_OUTBOX_UI_CONTROL`,
`COGNOS_AUTONOMY_LIVE_DESTINATION`. `test/phase21.mjs` now names the fixture
endpoint as its approved destination, which is what a real Rung-4 host does
before it can earn a flip at all; its law-version assertions became floors
rather than exact numbers, so a later phase does not have to edit an earlier
phase's test to say something false about itself.

## Phase 22C (autonomy row) — T5, irreversible acts, per-effect human approval — BUILT, default off

The second half of the autonomy-row Phase 22. The first slice earned the flip to
live for **T4** and left T5 design-only; this slice builds T5 and keeps it
strictly off until a human approves one effect at a time.

**T5 is one adapter, judged harder than a webhook.** `post.publish` is a second,
stricter https adapter for irreversible acts (payment, publish, delete). It is
shaped like `webhook.post` — the same SSRF/DNS/redirect checks, `secret_ref`
signing, digest-only receipts — but it is never deliverable by the loop:
`tierAllowed` refuses it unless `COGNOS_AUTONOMY_IRREVERSIBLE` is on, and even
with the rung on the Action Governor refuses with `T5_NEEDS_HUMAN` until an
approval row names that exact outbox id. `pin.irreversible_human_approval` writes
the whole thing down: a T5 release is approved **one effect at a time, by a
human**, never by class — no rung flag, scope entry, shadow corpus, goal budget,
resident brief or model output is a substitute, and the loop can never write its
own approval row (the only writer is the outbox decision route).

**The approval binds the scope it was recorded under.** `effect_approvals`
(migration `0014`) is append-only: the human decision carries the scope SHA-256
and budget SHA-256 at decision time, so an approval cannot outlive the
authorization it was made against, and a replayed or widened effect is judged
against the row that actually exists rather than a remembered yes. A T5 release
with no naming approval counts as a false release by definition, so it can never
silently earn a corpus the way a shadow T4 sample can.

**Why this does not weaken anything.** T5 is built and green, default off, and
release remains a per-effect human approval naming the exact outbox row. The rung
alone is necessary and never sufficient. Laws move to `1.8.0` (adding
`pin.irreversible_human_approval`), identity to `1.10.0` (the `irreversible`
runtime block: `built`, `rungEnabled`, `requiresPerEffectHumanApproval: true`,
`classAuthorized: false`, `adapters: ["post.publish"]`), and `test/outbox-live.mjs`
grew to 20 checks — including the ones that prove a T5 release with a naming
approval is **not** a false release, and that the same approval clears
`T5_NEEDS_HUMAN` exactly once. `builtTiers` is now `T0–T5`; `unbuiltTiers` is
empty for the first time.

## Phase 26 — Delegated Critic/Governor switches and "forgo goal authorization" — BUILT, default on / default off

Phase 26 is user-friendliness work with no new rung, skill, law, or write. It
adds three delegated switches, all on the same model Phase 25 established for
autonomy's on/off switch: **a pin outranks the UI, a delegation hands the switch
over, a stored row holds the delegated value, and every flip is audited.**

### The Critic and Governor toggles

The Critic and Governor kill switches (`COGNOS_CRITIC_ENABLED`,
`COGNOS_GOVERNOR_ENABLED`) predate this work; what was missing was a face. The
pattern from Phase 25 is reused, with the resting state **inverted** because
these are brakes rather than powers:

- An environment value is a **pin**. `false` pins a seat off; any other explicit
  value holds it on; unset is not a pin. `POST /api/council/settings` answers
  `409 pinned_by_operator` rather than pretend.
- `COGNOS_COUNCIL_UI_CONTROL=true` is a **delegation**. It hands both toggles to
  Settings → Governance. Delegation is not disablement.
- Neither set: both seats rest **on** — an unread `council_settings` row
  (migration `0015`) reads on, which is the fail-closed direction for a safety
  mechanism, the mirror image of autonomy's fail-closed off.

Precedence is resolved in exactly one place, `server/council/settings.js`, which
`getSystemConfig()` asks, so the council dispatch, the identity route and the
answer prompt all read the same effective value. A flip is write-through to a
process-local cache and appended to `workspace_audit` as `council.governor` /
`council.critic` with from/to values and who did it. The UI names what turning
the Governor off actually removes — the deterministic veto over empty responses,
secret leakage, minimum-cause floors and citation audits — and keeps saying so
while it is off.

The Governor is still sovereign at the law layer. `pin.governor_sovereign` is
untouched: no model or subsystem may weaken or bypass the Governor, and the
Policy Engine still refuses a runtime adaptation that proposes to disable a seat.
This is an operator's kill switch with a record, never a model's. Laws stay
`1.8.0` — Phase 26 adds no pin.

### Forgo goal authorization

By default a new goal is created `awaiting_authorization` and does no work until
a human authorizes its exact scope and budget. Phase 26 adds the option to forgo
that **one** click, on its own pair of variables so it can never ride along with
the loop's on/off switch or the outbox mode:

- `COGNOS_AUTONOMY_AUTO_AUTHORIZE` is a **pin** (explicit `false` off, explicit
  affirmative on, unset not a pin).
- `COGNOS_AUTONOMY_AUTO_AUTHORIZE_UI_CONTROL=true` is a **delegation**, separate
  from `COGNOS_AUTONOMY_UI_CONTROL` and `COGNOS_AUTONOMY_OUTBOX_UI_CONTROL`.
- The stored value is one nullable column, `autonomy_settings.auto_authorize_goals`
  (migration `0016`), null reads off.

The consent **record** is never skipped, only the click. When on, the goal
creation routes (the manual form and the designer's `create_first_goal`) perform
the same authorize step the human decision route performs, with one deliberate
difference: `decision_source: "auto"` instead of `"app"`. The scope and budget
hashes are computed and stored, the allowlist and ceilings still bind at every
later step, and staged effects still wait for their own human approval. The
switch touches nothing else — research-plan step consent, promotion confirms and
outbox effect approvals (T2+, T4, T5) are unchanged, because the human barriers
this work was not allowed to weaken are not weakened.

Identity moves to `1.11.0`: the governance block now reports the three facts for
each seat (`*Pinned`, `uiControl`, `governorOffRemovesVeto`) alongside the
effective on/off, and the autonomy block reports `autoAuthorize` with its own
pin/delegation facts. `test/council-ux.mjs` (9 checks, three harnesses:
delegated / not / pinned, plus pure pin-precedence probes) pins it all down —
including that a stored `TRUE` cannot beat a pinned `FALSE`, and that an
auto-authorized goal carries `decision_source: "auto"` in both
`goal_authorizations` and the `goal_authorized` event.

Per the §10 rhythm: migrations `0015`/`0016`, identity `1.11.0` (laws stay
`1.8.0`), `test/council-ux.mjs`, and this section. New environment variables:
`COGNOS_COUNCIL_UI_CONTROL`, `COGNOS_AUTONOMY_AUTO_AUTHORIZE`,
`COGNOS_AUTONOMY_AUTO_AUTHORIZE_UI_CONTROL` (the Critic/Governor pins
`COGNOS_CRITIC_ENABLED`/`COGNOS_GOVERNOR_ENABLED` predate this phase and are
re-documented in `.env.example` under their pin semantics).

---

## Phase 27 — The destination grant (the Rung 4 key path) — BUILT, default off

### The divergence this closes

§4.7.1, §5 and the rung table make a shadow corpus **aimed at a granted
destination** the entry criterion for Rung 4, and the implementation enforced
exactly that at every one of its rungs: `DESTINATION_NOT_IN_SCOPE` refused
writes aimed anywhere ungranted, the live flip's `corpus_aimed` condition
refused a corpus aimed nowhere approved, and the scope-hash binding refused a
goal acting under a scope it was never authorized beneath. What was missing was
upstream of all of it: **no operator surface could make the grant those gates
read.** The manual goal form sent no `scope` at all (the route accepted it and
merged it; the UI never sent it), and the designer's `firstGoalScope` granted
`notify` plus optional `external_read` — read pages only. The lock was complete
and the key path unbuilt: `corpus_aimed` could never be met from the UI, the
corpus could never be clicked in, and the rung could never be earned from an
operator's hand. Silence was the failure mode — a goal that could never hold a
key looks exactly like a goal that has one.

### What changed

- **A grant-side gate.** `validateDestinationGrant` in
  `server/autonomy/scopeUrl.js` validates a destination list the way the
  corpus will: exact URLs through the adapter's own `checkWebhookUrl` (so a
  grant can never be looser than a delivery), host and host+path-prefix entries
  against the adapter's blocked-host boundary, bounded and named per bad entry.
  The adapter exports `isLocalOrReservedHost` so the grant path uses the
  adapter's own rule rather than growing a second copy that could drift.
- **The goal form sends scope.** An optional *Webhook destinations* editor on
  Autonomy → Goals lands the entries as
  `{ effect: "webhook.post", destinations: [...] }` in the scope the operator
  then authorizes, rendered in plain words above the JSON at the consent
  barrier. `POST /api/autonomy/goals` refuses a malformed grant with 400 and
  every bad entry named, and normalizes valid ones (fragment-free hrefs) so
  the stored grant is exactly what the matcher compares attempts against.
  Scope is immutable after creation (pin.goal_scope_immutable): refusing at the
  only moment a grant can still be fixed is the whole point of the gate.
- **The designer grants writes as deliberately as reads.** The drawer shows the
  destination editor whenever the clamped draft's allowlist includes
  `webhook.post`; `/api/autonomy/designer/create` accepts `grant_destinations`
  next to `grant_urls`, and `firstGoalScope` welds the grant only when
  `webhook.post` survived the clamp — a grant without the skill is 400 with
  the sentence why, a grant with no first goal is 400, a bad entry is 400, and
  every refusal returns the draft untouched so a bad click costs nothing.

### What execution showed

`test/phase27.mjs` (6 checks), which proves the wire and the lock in the same
breath: the grant-refusal matrices; `firstGoalScope` granting only with
`webhook.post` and never widening reads into writes; both routes refusing
malformed, skill-less and goal-less grants with sentences and no rows created;
and the end-to-end proof this whole phase exists for — a goal granted the
approved destination actually fills the corpus aimed at it (the readiness
report's `corpus_aimed` condition, previously unreachable, reads met), while
the identical attempt with **no** grant is still refused by name. Wiring the
key loosened nothing.

Per the §10 rhythm: no migration, no law bump, no identity bump, no new
environment variables — this phase moves no constraint, it closes one.
`test/phase27.mjs` and this section.
