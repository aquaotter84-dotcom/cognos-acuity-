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

`/system` in the UI is a read-only window onto both.

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
| `COGNOS_LLM_TIMEOUT_MS` | no | Abort a hung upstream call. Default 60000. |
| `TAVILY_API_KEY` | no | Better web search. Without it, keyless DuckDuckGo. |
| `COGNOS_RUNTIME_SECRET` | no | **Unset = no gate.** Set = visit `/gate?key=<value>` once to set a cookie. |
| `PORT` | no | Default 3000. |
| `COGNOS_LEDGER_ENABLED` | no | Default `true`. Set `false` to stop event-ledger emission entirely (kill switch). |
| `COGNOS_COHERENCE_ENABLED` | no | Default `true`. Set `false` to skip the coherence monitor stage. |
| `COGNOS_TELEMETRY_ENABLED` | no | Default `true`. Set `false` to stop writing reasoning-telemetry records. |
| `COGNOS_ADAPTIVE_MODE` | no | Default `observe`. `auto` is recorded as *requested* and refused: v1 makes no live switches. |

The database initializes lazily — the build and a cold boot both succeed with no
database reachable. The schema is created on the first query that needs it.

The Phase 14/15 tables are part of that same lazy migration. `server/db/schema.js`
is the single source of truth; `migrations/*.sql` is generated from it
(`npm run migrations:generate`) and can be applied explicitly with
`npm run migrate` — that script refuses to run any SQL containing `DROP`,
`TRUNCATE`, `DELETE FROM`, `RENAME` or `UPDATE … SET`, because schema changes
here are additive only.

## Layout

```
api/
  index.js              Vercel serverless entrypoint (imports the Express app)
server/
  index.js              the Express app: routes + the single send path (SSE)
  serve.js              local/self-hosted listener (Vercel does not use this)
  mock-openai.js        local OpenAI-compatible mock (development aid)
  mock-latency.js       local latency injector (development aid)
  chatOrchestrate.js    the council pipeline (port of the Base44 function)
  llm.js                model layer + the verbatim COGNOS identity prompt
                        (the one telemetry capture point: callLLM)
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
                        errors, logging  (all verbatim)
  db/
    schema.js           base + PHASE14_SCHEMA + PHASE15_SCHEMA (source of truth)
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
  meta/                 Phase 15
    telemetry.js        the per-run recorder (subscribes to eventBus)
    rates.js            the editable cost rate table
    strategies.js       the strategy registry (seeded with exactly one row)
    evaluate.js         the offline evaluation harness
    adaptive.js         observe-mode selection + switch thresholds
    policy.js           the Policy Engine
    store.js            createMetaStore(run): telemetry, strategies, ledger
migrations/             generated additive SQL (0001 phase 14, 0002 phase 15)
scripts/
  generate-migrations.mjs  migrations/*.sql from server/db/schema.js
  migrate.mjs              apply them (refuses non-additive SQL)
  evaluate-strategies.mjs  run the offline harness (operator-invoked)
src/
  pages/                Chat, Memory, Activity, System, Settings
  components/chat/      ChatMessage, ChatInput, CouncilTrace, LiveCouncil,
                        Sidebar, MobileNav, WelcomeScreen
  components/CognosLayout.jsx
  lib/api.js            the app's API client + the SSE send path
test/                   harness only — not part of the app
  pglite.mjs            real Postgres wire protocol over PGlite
  mockModel.mjs         scriptable model: contradictions, vetoes, 400s, hangs
  harness.mjs           boots the real app + db + mock model
  smoke.mjs             the Phase 14/15 acceptance run (167 assertions)
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
        → contextAssembly → observer → webSearch → strategist
          → specialist → synthesizer → coherenceMonitor
          → critic ⟳ (coherence re-checked after any revision) → governor
          → (memoryExtraction ‖ deferred critic)
            → knowledgeProjection → telemetryRecord
          ‖ auditLog ‖ summarize
      ← events: start, stage.*, observer, webSearch, strategist,
                specialist, coherence, critic, governor, token,
                knowledge, done | error
```

The conclusion, its ledger event, the conversation preview and the telemetry
link are written in **one transaction** in `server/index.js`. If the Governor
vetoes, the draft is discarded: no memory is extracted, the summary is not
updated, and the ledger records `veto_raised` with the draft's length and digest
only — never its text.

## What the system knows about itself

Read-only JSON, plus one gated write. `/system` renders all of it.

```
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
```

```bash
npm run smoke          # 167 assertions across the Phase 14/15 success criteria
npm run demo           # print the artifacts: ledger rows, telemetry, replay, veto
npm run migrate        # apply migrations/*.sql (refuses non-additive SQL)
npm run migrations:generate
node scripts/evaluate-strategies.mjs --prompt "..." --trials 3
```

## Read these before launch

- `server/council/` — the council's mind
- `server/council/laws.js` — what may never change, and why
- `server/llm.js` — the model call, the identity prompt, the telemetry capture point
- `server/db.js` — the database layer and the transaction boundary
- `server/db/schema.js` — every table, base and additive
- `server/chatOrchestrate.js` — the orchestration
- `server/knowledge/` — the event ledger, replay, coherence, relationships
- `server/meta/` — telemetry, strategies, evaluation, the Policy Engine
- `DIVERGENCES.md` §9 and §10 — the two behavioural changes Phase 14 introduced
- `docs/logs/` — captured build, boot, smoke and demonstration logs
