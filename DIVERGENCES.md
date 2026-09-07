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

Copied byte-for-byte, only import paths and `ctx.base44.entities` → `ctx.db` changed:

| File | Origin |
|---|---|
| `server/council/charter.js` | `base44/shared/council/charter.ts` — the four principles: truth, evidence, agency, dignity |
| `server/council/observer.js` | Observer prompt, task-type list, JSON schema, fallback classification |
| `server/council/strategist.js` | Strategist decomposition prompt, `ALLOWED_AGENTS`, schema |
| `server/council/specialist.js` | All nine `SPECIALIST_PROMPTS`, decomposed + direct paths |
| `server/council/synthesizer.js` | `SYNTH_BASE`, `REVISE_BASE`, synthesis + revision paths |
| `server/council/critic.js` | Critic prompt, charter check schema, skip/degrade behaviour — **prompt text still byte-identical**; Phase 14 appends a data section to the *user* turn (§9.5) |
| `server/council/governor.js` | Sovereignty gate, `SECRET_PATTERNS`, flag logic — **decision logic untouched**; Phase 14 passes coherence through as information only (§9.5) |
| `server/council/index.js` | Registry wiring |
| `server/shared/*.js` | orchestrator, registry, protocol, runtime, eventBus, errors, logging |
| `server/llm.js` (lower half) | `STYLE_DIRECTIVES`, `styleDirective`, `buildContextSystemPrompt` and the COGNOS identity base prompt — **still byte-identical**; only `callLLM` above it gained telemetry (§10.1) |
| `server/chatOrchestrate.js` | Memory-relevance prompt, memory-extraction prompt, summarization prompt, Phase 4 revision loop, Phase 13 adaptive rule — **all verbatim**; the pipeline gained three non-council stages and a veto consequence (§9, §10) |
| `src/components/chat/CouncilTrace.jsx` | Was unchanged; Phase 14/15 add one collapsible section that renders only when the new fields are present (§9.7) |

The Phase 13 pipeline order was:
`contextAssembly → observer → webSearch → strategist → specialist → synthesizer → critic ⟳ → governor → (memory ‖ audit ‖ summary)`

Phase 14/15 insert three **non-council** stages (they do not vote and are not
seats) and keep every existing edge exactly where it was:
`contextAssembly → observer → webSearch → strategist → specialist → synthesizer → coherenceMonitor → critic ⟳ (coherence re-checked after any revision) → governor → (memory ‖ deferred critic) → knowledgeProjection → telemetryRecord ‖ audit ‖ summary`

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

1. **Live streaming.** `POST /api/chat` is Server-Sent Events. Council stage
   start/complete events, the Observer classification, web-search briefing,
   plan, critic score and governor verdict all stream as they happen, and the
   final answer streams token-by-token from the Specialist.
   *The original faked this:* `Chat.jsx` received a complete string and revealed
   it with a `setTimeout` typewriter. That simulation is deleted.
2. **Mobile layout.** `100dvh` instead of `h-screen` (fixes iOS URL-bar clipping),
   `text-base` on the input (stops iOS zoom-on-focus), action buttons always
   visible on touch instead of `opacity-0 group-hover`, safe-area insets on
   header/nav/input, reduced tab bar.
3. **No auth.** App opens straight to chat.

---

## 4. Things removed, stated plainly

These existed **only** because Base44 supplied them. There is no honest
equivalent, so they were removed rather than faked:

- **File attachments, screen share, camera capture.** These needed
  `integrations.Core.UploadFile` — a hosted blob store returning public URLs the
  model could fetch. Rebuilding it means adding S3/R2 and a signed-URL service,
  which is a new subsystem, not a port. The multimodal plumbing survives in
  `llm.js` (`withAttachments` folds image URLs into the user turn), so wiring a
  blob store later is a small change. **The UI controls are gone; a paperclip
  that silently fails would be a lie.**
- **LiveKit voice agent** (`livekit-agent/`, `AgentChat.jsx`, `useVoice`,
  `useConversationMode`, `SpeakButton`). Needs a LiveKit server, tokens, and the
  service-role secret path. Browser-native **speech-to-text dictation is kept**
  (mic button in `ChatInput`); text-to-speech playback is not.
- **Beliefs, Dynamics, Insights, SystemMap, Documents pages** and the
  `deriveBeliefs` / `consolidateMemories` / `runCouncilAutonomous` functions plus
  the `BeliefSnapshot` / `ChangeEvent` / `Insight` / `Document` entities. These
  are a large second subsystem (a 445-line belief-derivation engine with
  confidence propagation, plus two scheduled Base44 workflows). They are
  **preserved in the repo history and not ported here.** Porting them is a
  follow-up of comparable size to this one; say the word.
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

Plus one additive column on an existing table: `memories.confidence NUMERIC`
(and `memories.confidence_set_ms`). No existing table was dropped, renamed,
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
only place instrumented. It gained an optional `purpose` label and a
**report-once** `observeModelCall(...)` on every exit path: success, timeout,
abort, network error, HTTP error, stream error, parse error. Nothing else in the
app was threaded with callbacks. `server/llm.js` also now exports
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
