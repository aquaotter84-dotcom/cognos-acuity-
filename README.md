# COGNOS

A council-based cognitive assistant. Self-hosted, free of Base44.

The council — Observer, Strategist, Specialist, Synthesizer, Critic, Governor,
Web Search — is ported verbatim from the original app. See
[DIVERGENCES.md](./DIVERGENCES.md) for exactly what was preserved, what was
replaced, and what was removed and why.

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

The database initializes lazily — the build and a cold boot both succeed with no
database reachable. The schema is created on the first query that needs it.

## Layout

```
api/
  index.js              Vercel serverless entrypoint (imports the Express app)
server/
  index.js              the Express app: routes + the single send path (SSE)
  serve.js              local/self-hosted listener (Vercel does not use this)
  chatOrchestrate.js    the council pipeline (port of the Base44 function)
  llm.js                model layer + the verbatim COGNOS identity prompt
  db.js                 Postgres: lazy init, schema, entity accessors
  config.js             system configuration
  council/
    charter.js          the four principles (verbatim)
    observer.js  strategist.js  specialist.js
    synthesizer.js  critic.js  governor.js  webSearch.js
    index.js            registry wiring
  shared/               orchestrator, registry, protocol, runtime, eventBus,
                        errors, logging  (all verbatim)
src/
  pages/                Chat, Memory, Activity, Settings
  components/chat/      ChatMessage, ChatInput, CouncilTrace, LiveCouncil,
                        Sidebar, MobileNav, WelcomeScreen
  components/CognosLayout.jsx
  lib/api.js            the app's API client + the SSE send path
test/mock-openai.js     test harness only — not part of the app
```

## The send path

One path, front to back, with nothing else posting a chat turn:

```
Chat.jsx handleSend
  → lib/api.js sendMessage        (opens the SSE stream)
    → POST /api/chat              (server/index.js)
      → runCouncilTurn            (server/chatOrchestrate.js)
        → contextAssembly → observer → webSearch → strategist
          → specialist → synthesizer → critic ⟳ → governor
          → (memoryExtraction ‖ auditLog ‖ summarize)
      ← events: start, stage.*, observer, webSearch, strategist,
                specialist, critic, governor, token, done | error
```

## Read these before launch

- `server/council/` — the council's mind
- `server/llm.js` — the model call and the identity prompt
- `server/db.js` — the database layer
- `server/chatOrchestrate.js` — the orchestration
