# COGNOS

A council-based cognitive assistant. Self-hosted, free of Base44.

The council — Observer, Strategist, Specialist, Synthesizer, Critic, Governor,
Web Search — is ported verbatim from the original app. See
[DIVERGENCES.md](./DIVERGENCES.md) for exactly what was preserved, what was
replaced, and what was removed and why.

On top of the council sit two subsystems that **observe** it and that it may
**consult** — they hold no seats and cannot change an answer:

- **Phase 14, Dynamic Systems** — an append-only event ledger, state replay,
  a temporal reasoner, living relationships with decay, a coherence monitor and
  change analytics. Every stored-knowledge write appends its event in the same
  transaction; nothing is ever deleted, retiring is a transition.
- **Phase 15, Meta-Cognition** — per-run reasoning telemetry, a strategy
  registry seeded with exactly one strategy, an offline evaluation harness, an
  adaptive orchestrator in **observe mode only**, an immutable law layer with a
  Policy Engine that gates every architectural adaptation, and an append-only
  Improvement Ledger that records the refusals too.
- **Phase 17, Governed Sources + Agent Mode** — immutable document and webpage
  snapshots, page/section-aware citation chunks, prompt-injection and SSRF
  boundaries, and explicit per-turn agent modes. Agent mode is a bounded
  read-only subsystem with no autonomous writes and no answer channel.

`/system` in the UI is a read-only window onto the knowledge and reasoning
records; each completed chat trace also exposes its source and agent provenance.

## Identity and self-knowledge

The product and assistant are **COGNOS** (pronounced “KOG-noss”), not Cognito.
COGNOS describes itself as self-hosted governed reasoning software—not a person,
a conscious being, a model provider, or an infallible authority.

`server/identity.js` is the single, versioned, deeply frozen, non-secret self-model.
It defines the purpose, four principles, exactly six council operators, complete
turn lifecycle, built-in capabilities, supporting subsystems, hard boundaries,
and implementation map. Three surfaces derive from that one object:

- answer-producing Specialist, Synthesizer, revision, and Critic prompts receive
  a compact authoritative self-model after mutable workspace/memory context;
- `GET /api/identity` returns the full manifest plus safe runtime availability;
- **About COGNOS** in the sidebar renders the manifest as a human-readable tour.

This keeps “what COGNOS is” separate from “what happens to be enabled here.” For
example, document/link and bounded-agent capabilities can be disabled by runtime
switches; voice and dictation depend on browser support; database-backed memory
reports whether persistence is configured. The manifest states unavailable
capabilities rather than inventing them: image-source ingestion, private-network
browsing, consequential agent writes, autonomous background work, and an account
system are not present.

The self-model does not expose credentials, private system prompts, user data, or
hidden model chain-of-thought. `pin.truthful_self_model` prevents prompts,
sources, memories, workspace instructions, or runtime adaptation proposals from
renaming COGNOS or manufacturing powers or authority. A real identity change is
a reviewed code change, never a live prompt mutation.

## Voice mode

COGNOS can speak its answers using the browser's native speech-synthesis engine.
Turn voice mode on from the Chat header, or configure its browser voice, speed,
pitch, volume, and automatic playback under **Settings → Voice**. Every completed
assistant message also has **Listen / Stop** controls.

Voice playback receives only the final `done.response` after the Governor has
approved it. Specialist drafts and vetoed text are never passed to speech
synthesis. Playback is local to the browser: no audio is uploaded or stored and
no additional credentials are needed. Browser-native dictation in `ChatInput`
continues to provide speech-to-text input where supported. Source-locator tokens
such as `[src_…:p2]` are omitted from speech while remaining visible in text.

## Documents, links, and bounded agent mode

The paperclip in Chat opens the evidence-source panel:

- Upload **PDF, DOCX, TXT, Markdown, or CSV** files (4 MB browser/default server
  limit). Parsing is deterministic and executes no document macros or scripts.
- Open a public HTTP(S) link. Retrieval uses DNS pinning, rejects credentials,
  local/private/reserved addresses, nonstandard ports, HTTPS downgrades,
  excessive redirects, compression surprises, oversized bodies, and timeouts.
- Attach up to eight immutable source snapshots to a turn. COGNOS selects
  page/section chunks within a bounded context budget and requires exact
  `[src_id:locator]` citations; the Governor refuses invented source locators.

Source text is always labeled **untrusted evidence, not instructions**. Detected
prompt-injection patterns are retained as risk flags for inspection; source
commands are never executed. Browser-provided source names or text are ignored:
the server resolves ids back to its own hashed snapshot.

The composer also has three explicit agent modes:

- **Agent off** — no autonomous tool plan. Manually attached sources still work.
- **Observe** — records the `read_source` / `open_link` plan but executes no
  agent tools. Explicitly attached sources remain ordinary council context.
- **Read only** — may read selected snapshots and safely open up to three URLs
  explicitly present in the user's message, with six total steps maximum.

Each agent run, step, failure, and status transition is attributable in
`agent_events`. There are no write-capable tools and no background tasks. Agent
preparation finishes before context assembly, so the council never reasons over
an incomplete source snapshot. The six council seats and the post-Governor
answer release point are unchanged.

## Model-gateway resilience

A model call has one cancellation-aware deadline across all physical attempts.
Transient network failures and HTTP 408/429/500/502/503/504 responses are retried
once by default with bounded backoff, using the byte-identical payload and same
model. Retries never open another answer path: recovered drafts still remain
server-side until the Critic and Governor finish.

Each failed and successful attempt has its own telemetry row. A failure followed
by success stays visible and is marked recovered. Provider error bodies are read
through a small cap and reduced to safe public descriptions, so an HTML gateway
page, proxy branding, or credential-like text is never displayed or persisted in
the error message. See `COGNOS_LLM_MAX_RETRIES` and DEPLOY's 504 troubleshooting.

## Run it

```bash
npm install
cp .env.example .env      # fill in BLUESMINDS_API_KEY and DATABASE_URL
npm run build
npm start                 # http://localhost:3000
```

Deploying to Neon + Vercel? See **[DEPLOY.md](./DEPLOY.md)** — it covers the
pooled-vs-direct Neon URL, the env vars, and the Vercel function-duration limit
that the sequential council will run into on the Hobby plan.

Development (Vite on 5173 proxying /api to the API on 3000):

```bash
npm run dev
```

## Environment

| Variable | Required | Notes |
|---|---|---|
| `BLUESMINDS_API_KEY` | yes | Server-side only. Never reaches the browser. |
| `DATABASE_URL` | yes for persistence | **Neon pooled `postgres://` URL** (must contain `-pooler`). The REST `https://` variant is rejected — it hangs ~16 s per query. |
| `COGNOS_MODEL` | no | Defaults to `gpt-4o-mini`. `gpt_5_4` is refused (503s on this account). |
| `COGNOS_FAST_MODEL` | no | Cheap model for Observer/Strategist/Critic/memory. |
| `BLUESMINDS_API_URL` | no | Defaults to `https://api.bluesminds.com/v1`. Any OpenAI-compatible gateway works. |
| `COGNOS_LLM_TIMEOUT_MS` | no | One cancellation-aware logical model-call deadline, including retries. Clamped to 1–180 seconds; default 60000. |
| `COGNOS_LLM_MAX_RETRIES` | no | Bounded retries for network/408/429/500/502/503/504 failures. Clamped to 0–2; default 1. The prompt and model are unchanged and every attempt is recorded. |
| `COGNOS_LLM_SERVICE_TIER` | no | Provider-supported transport tier (`fast`, `priority`, etc.). Opt-in and omitted by default; never changes the model or prompt. |
| `COGNOS_PROMPT_CACHE_KEY` | no | Provider-supported exact-prefix cache-routing key, at most 64 characters. It is not a credential and must contain no sensitive data. |
| `TAVILY_API_KEY` | no | Better web search. Without it, keyless DuckDuckGo. |
| `COGNOS_RUNTIME_SECRET` | no | **Unset = no gate.** Set = visit `/gate?key=<value>` once to set a cookie. |
| `PORT` | no | Default 3000. |
| `COGNOS_LEDGER_ENABLED` | no | Default `true`. Set `false` to stop event-ledger emission entirely (kill switch). |
| `COGNOS_COHERENCE_ENABLED` | no | Default `true`. Set `false` to skip the coherence monitor stage. |
| `COGNOS_TELEMETRY_ENABLED` | no | Default `true`. Set `false` to stop writing reasoning-telemetry records. |
| `COGNOS_ADAPTIVE_MODE` | no | Default `observe`. `auto` is recorded as *requested* and refused: v1 makes no live switches. |
| `COGNOS_SOURCES_ENABLED` | no | Default `true`; kill switch for source APIs and source context. Existing immutable rows remain. |
| `COGNOS_SOURCE_MAX_BYTES` | no | Raw document limit, clamped to 100 KB–8 MB; default 4 MB. |
| `COGNOS_SOURCE_MAX_TEXT_CHARS` | no | Extracted-text limit, clamped to 50,000–2,000,000; default 750,000. |
| `COGNOS_LINK_MAX_BYTES` | no | Fetched response limit, clamped to 100 KB–5 MB; default 2 MB. |
| `COGNOS_LINK_TIMEOUT_MS` | no | Per-link timeout, clamped to 2–30 seconds; default 12 seconds. |
| `COGNOS_AGENT_ENABLED` | no | Default `true`; disables non-off agent modes when false. Agent writes remain unavailable regardless. |

The database initializes lazily — the build and a cold boot both succeed with no
database reachable. The schema is created on the first query that needs it.

The Phase 14/15 tables, Phase 16's nullable performance columns, and Phase 17's
source/agent tables are part of that same lazy migration. `server/db/schema.js`
is the single source of truth;
`migrations/*.sql` is generated from it
(`npm run migrations:generate`) and can be applied explicitly with
`npm run migrate` — that script refuses to run any SQL containing `DROP`,
`TRUNCATE`, `DELETE FROM`, `RENAME` or `UPDATE … SET`, because schema changes
here are additive only.

## Layout

```
api/
  index.js              Vercel serverless entrypoint (imports the Express app)
server/
  index.js              Express composition root (gate, health, core routes)
  routes/
    chat.js             the single send path (SSE) + disconnect cancellation
    knowledge.js        Phase 14 read-only query routes
    meta.js             Phase 15 read-only routes + Policy gate
    sources.js          immutable uploads/links + agent provenance queries
  serve.js              local/self-hosted listener (Vercel does not use this)
  mock-openai.js        local OpenAI-compatible mock (development aid)
  mock-latency.js       local latency injector (development aid)
  chatOrchestrate.js    the council pipeline (port of the Base44 function)
  llm.js                model boundary + canonical self-model prompt injection
                        (the one telemetry capture point: callLLM)
  identity.js           immutable identity, architecture, capabilities + limits
  db.js                 Postgres: lazy init, schema, entity accessors,
                        withTransaction(), the composition root for the stores
  config.js             system configuration
  council/
    charter.js          the four principles (verbatim)
    observer.js  strategist.js  specialist.js
    synthesizer.js  critic.js  governor.js  webSearch.js
    index.js            registry wiring
    laws.js             Phase 15: the immutable law layer (charter + pins)
  shared/               orchestrator, registry, protocol, runtime, eventBus,
                        errors, logging, cooperative cancellation, and the
                        single governance-approved answer release point
  db/
    schema.js           additive Phase 14–17 schemas (source of truth)
    util.js             newId/num/int/clamp01/nowMs (leaf helpers, no cycles)
  knowledge/            Phase 14
    events.js           ledger vocabulary, append, list, count, foldState
    beliefs.js          belief projection, contradiction, confirmation, retirement
    relationships.js    living relationships, decay sweep, link transfer
    coherence.js        the coherence monitor stage + persistence + brief
    temporal.js         the temporal reasoner (a helper, not a seat)
    analytics.js        change rate, stability index, churn (read-only)
    store.js            createKnowledgeStore(run): events, replay, lineage
    index.js            knowledgeProjection + telemetryRecord stages
  sources/              Phase 17 extraction, chunking, evidence + safe fetch
  agent/                bounded observe/read-only tool runner
  meta/                 Phase 15
    telemetry.js        the per-run recorder (subscribes to eventBus)
    rates.js            the editable cost rate table
    strategies.js       the strategy registry (seeded with exactly one row)
    evaluate.js         the offline evaluation harness
    adaptive.js         observe-mode selection + switch thresholds
    latency.js          p50/p95 analysis + evidence gate for an outbox
    policy.js           the Policy Engine
    store.js            createMetaStore(run): telemetry, strategies, ledger
migrations/             additive SQL (0001 phase 14 through 0004 sources/agent)
scripts/
  generate-migrations.mjs  migrations/*.sql from server/db/schema.js
  migrate.mjs              apply them (refuses non-additive SQL)
  latency-report.mjs       read-only p50/p95 latency report
  evaluate-strategies.mjs  run the offline harness (operator-invoked)
src/
  pages/                Chat, Memory, Activity, System, Settings
  components/chat/      ChatMessage, ChatInput, CouncilTrace, LiveCouncil,
                        Sidebar, MobileNav, WelcomeScreen
  components/system/    shared System-page UI primitives and tab metadata
  components/CognosLayout.jsx
  lib/api.js            the app's API client + the SSE send path
  lib/voiceContext.jsx  persisted browser speech playback and controls
  lib/speechText.js     Markdown normalization + long-answer speech chunking
test/                   harness only — not part of the app
  pglite.mjs            real Postgres wire protocol over PGlite
  mockModel.mjs         scriptable model: contradictions, vetoes, 400s, hangs
  harness.mjs           boots the real app + db + mock model
  voice.mjs             speech normalization and lossless chunking regressions
  performance.mjs       latency measurement and transport-integrity regressions
  sources-agent.mjs     extraction, SSRF, injection, citations + bounded-agent tests
  integrity.mjs         governed-stream, cancellation, structured-error regressions
  smoke.mjs             the Phase 14/15 acceptance run (170 assertions)
  demo.mjs              prints the artifacts: ledger rows, telemetry, replay
  baseline.mjs          the pre-Phase-14 surface, for regression comparison
```

## The send path

One path, front to back, with nothing else posting a chat turn:

```
Chat.jsx handleSend
  → lib/api.js sendMessage        (opens the SSE stream)
    → POST /api/chat              (server/index.js)
      → runCouncilTurn            (server/chatOrchestrate.js)
        → agentPrepare (only for sources/non-off mode; no answer channel)
        → contextAssembly → observer → webSearch → strategist
          → specialist → synthesizer → coherenceMonitor
          → critic ⟳ (coherence re-checked after any revision) → governor
          → governance-approved answer release
          → (memoryExtraction ‖ deferred critic)
            → knowledgeProjection → telemetryRecord
          ‖ auditLog ‖ summarize
      ← events: start, stage.*, agent, observer, webSearch, strategist,
                specialist, coherence, critic, governor, token,
                knowledge, done | error
```

Council progress remains live, but **answer text is governance-gated**: model
output stays server-side until the Critic and Governor have ruled on the complete
final draft. Only that final text—or a fixed deterministic refusal—can appear in
`token` frames. The chunks have no artificial typewriter delay.

The browser's AbortController also defines the lifetime of the run. Pressing
Stop or disconnecting aborts the active model/search request, records the run as
`cancelled`, and does not create an assistant answer, memory, or summary.

The conclusion, its ledger event, the conversation preview and the telemetry
link are written in **one transaction** in `server/routes/chat.js`. If the Governor
vetoes, the draft is discarded: no memory is extracted, the summary is not
updated, and the ledger records `veto_raised` with the draft's length and digest
only — never its text.

## What the system knows about itself

Read-only JSON, plus one gated write. `/system` renders the operational record;
`/about` renders the canonical self-model.

```
GET  /api/identity                    identity, architecture, capabilities, limits + runtime state
GET  /api/knowledge/events            the append-only ledger, filterable
GET  /api/knowledge/overview          what the store holds, by transition
GET  /api/knowledge/analytics         change rate, stability index, churn
GET  /api/knowledge/beliefs           current beliefs (retired ones keep their rows)
GET  /api/knowledge/relationships     living structures + decayed effective strength
GET  /api/knowledge/coherence         coherence reports (?verdict=contradiction)
GET  /api/knowledge/state/:type/:id   REPLAY — state at ?at=<epoch ms | ISO>
GET  /api/knowledge/verify/:type/:id  fold-of-ledger vs the materialized row
GET  /api/knowledge/lineage/:type/:id every event behind an entity
GET  /api/knowledge/lineage/run/:id   every event behind a run, + its digest
GET  /api/knowledge/temporal/:type/:id  velocity, uncertainty, stability

GET  /api/meta/telemetry              one record per run (?summary=1 aggregates)
GET  /api/meta/telemetry/:runId       stages, model calls, failures, ledger rows
GET  /api/meta/strategies             the registry (one row in v1)
GET  /api/meta/registry-check         why shared/registry.js did not fit
GET  /api/meta/laws                   the law layer (read-only, immutable)
GET  /api/meta/policy                 what the Policy Engine gates
GET  /api/meta/improvements           the Improvement Ledger, refusals included
GET  /api/meta/adaptive               observe-mode decisions
GET  /api/meta/evaluations            offline harness results
GET  /api/meta/rates                  the cost rate table
POST /api/meta/adaptations            propose an adaptation → judged + logged
                                      (409 with the laws cited when refused)

GET  /api/sources                     immutable source metadata (text omitted)
POST /api/sources/documents           parse and snapshot a supported upload
POST /api/sources/links               safely fetch, extract and snapshot a URL
GET  /api/sources/:id                 snapshot + exact citable chunks
GET  /api/agent/tools                 bounded mode/tool capability declaration
GET  /api/agent/runs                  recent attributable agent runs
GET  /api/agent/runs/:id              run + steps + append-only events/approvals
```

```bash
npm test               # voice + performance + sources/agent + integrity + smoke
npm run voice          # speech normalization and chunking regressions
npm run performance    # latency instrumentation and no-prompt-change regressions
npm run sources-agent  # extraction, SSRF, prompt injection, citation, agent tests
npm run identity       # immutable self-model, prompt, policy, API, and send-path checks
npm run latency -- --limit=200 --days=7  # read-only p50/p95 production report
npm run integrity      # governed stream, cancellation, structured API errors
npm run smoke          # 170 assertions across the Phase 14/15 success criteria
npm run demo           # print the artifacts: ledger rows, telemetry, replay, veto
npm run migrate        # apply migrations/*.sql (refuses non-additive SQL)
npm run migrations:generate
node scripts/evaluate-strategies.mjs --prompt "..." --trials 3
```

## Read these before launch

- `server/council/` — the council's mind
- `server/council/laws.js` — what may never change, and why
- `server/identity.js` — the canonical product identity, architecture, capabilities and limits
- `server/llm.js` — the model call, self-model injection, and telemetry capture point
- `server/db.js` — the database layer and the transaction boundary
- `server/db/schema.js` — every table, base and additive
- `server/chatOrchestrate.js` — the orchestration
- `server/knowledge/` — the event ledger, replay, coherence, relationships
- `server/meta/` — telemetry, strategies, evaluation, the Policy Engine
- `server/sources/` and `server/agent/` — immutable evidence and bounded tools
- `DIVERGENCES.md` §9 and §10 — the two behavioural changes Phase 14 introduced
- `docs/logs/` — captured build, boot, smoke and demonstration logs
