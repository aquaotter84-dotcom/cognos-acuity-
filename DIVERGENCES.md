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
| `server/council/critic.js` | Critic prompt, charter check schema, skip/degrade behaviour |
| `server/council/governor.js` | Sovereignty gate, `SECRET_PATTERNS`, flag logic |
| `server/council/index.js` | Registry wiring |
| `server/shared/*.js` | orchestrator, registry, protocol, runtime, eventBus, errors, logging |
| `server/llm.js` (lower half) | `STYLE_DIRECTIVES`, `styleDirective`, `buildContextSystemPrompt` and the COGNOS identity base prompt |
| `server/chatOrchestrate.js` | Pipeline order, memory-relevance prompt, memory-extraction prompt, summarization prompt, Phase 4 revision loop, Phase 13 adaptive rule |
| `src/components/chat/CouncilTrace.jsx` | Unchanged |

The pipeline order is unchanged:
`contextAssembly → observer → webSearch → strategist → specialist → synthesizer → critic ⟳ → governor → (memory ‖ audit ‖ summary)`

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
