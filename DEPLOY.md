# Deploying COGNOS — Neon + Vercel + BluesMinds

## 1. Neon

1. Create a project and a database named `cognos`.
2. Dashboard → **Connection string** → select **Pooled connection**.
3. Copy the `postgresql://…` URL. It must contain **`-pooler`** in the host:

   ```
   postgresql://user:pass@ep-xxx-pooler.us-east-2.aws.neon.tech/cognos?sslmode=require
   ```

**Two ways to get this wrong, both guarded in code:**

- The **direct** (non-pooler) host works locally but exhausts connections under
  serverless concurrency. `server/db.js` logs a loud warning if it sees one.
- The **REST `https://`** endpoint (Neon Data API) is *rejected outright* —
  it hangs ~16 s per query. You get a clear error in 0.09 s instead.

No migration step is required. The schema is created lazily on first query, and
every statement is `IF NOT EXISTS`, so it is safe on every cold start — including
the Phase 14/15 tables (`knowledge_events`, `beliefs`, `confidence_history`,
`relationships`, `coherence_reports`, `telemetry_runs`, `telemetry_model_calls`,
`strategies`, `strategy_evaluations`, `adaptive_decisions`,
`improvement_ledger`), the additive memory-confidence fields, Phase 16's
nullable latency-observability fields, Phase 17's `sources`,
`source_chunks`, `agent_runs`, `agent_steps`, `agent_events`, and
`agent_approvals` tables, and Phase 18's `projects`, `source_images`, and
`image_analyses` tables (plus the `project_id` columns on conversations and
sources).

If you would rather apply the DDL explicitly before traffic arrives:

```bash
DATABASE_URL='postgresql://…-pooler…' npm run migrate          # apply + verify
DATABASE_URL='postgresql://…-pooler…' node scripts/migrate.mjs --dry-run
```

`scripts/migrate.mjs` refuses to execute any migration containing `DROP`,
`TRUNCATE`, `DELETE FROM`, `RENAME` or `UPDATE … SET`, wraps each migration in
its own transaction, and then verifies the tables exist. Schema changes here are
**additive only**: existing tables keep their rows and their semantics.
`migrations/*.sql` is generated from `server/db/schema.js`
(`npm run migrations:generate`) so the files and the running schema cannot
drift apart.

## 2. BluesMinds

1. [api.bluesminds.com/console](https://api.bluesminds.com/console) → **Tokens** → create a key (`sk-…`).
2. Base URL is `https://api.bluesminds.com/v1` (OpenAI-compatible; the app's default).
3. Pick a model id from their catalogue and set `COGNOS_MODEL`.

⚠️ **Check your plan's RPM.** One council turn is **5–7 requests**
(observer → [search] → strategist → specialist → synthesizer → critic → memory →
summary). BluesMinds' Free tier is 20 RPM / 300 requests per day — that is
roughly **3 chat turns per minute and ~45 turns per day**. On the Free tier you
may also hit ~50% context truncation. If the council starts erroring under load,
that is rate limiting, not a bug. Set `COGNOS_FAST_MODEL` to a cheap model to
reduce cost, but note it does not reduce the *request count*.

## 3. Vercel

Import the repo. Vercel reads `vercel.json`; the defaults are already correct:

- Build `npm run build` → static SPA in `dist/`, served by the CDN.
- `api/index.js` is the serverless function; `/api/*` and `/gate` route to it.
- Everything else rewrites to `index.html` for client-side routing.

### Environment variables

Project → Settings → Environment Variables (Production **and** Preview):

| Variable | Required | Value |
|---|---|---|
| `BLUESMINDS_API_KEY` | ✅ | your `sk-…` key |
| `DATABASE_URL` | ✅ | Neon **pooled** URL (`-pooler`) |
| `COGNOS_MODEL` | recommended | e.g. `gpt-4o-mini` |
| `COGNOS_FAST_MODEL` | optional | cheap model for Observer/Critic/memory |
| `BLUESMINDS_API_URL` | optional | defaults to `https://api.bluesminds.com/v1` |
| `COGNOS_LLM_TIMEOUT_MS` | optional | one logical model-call deadline including retries; default `60000`, clamp 1–180 seconds |
| `COGNOS_LLM_MAX_RETRIES` | optional | retries transient network/408/429/5xx gateway failures; default `1`, clamp 0–2; same prompt and model |
| `COGNOS_LLM_SERVICE_TIER` | optional | provider-supported transport tier; leave unset unless verified |
| `COGNOS_PROMPT_CACHE_KEY` | optional | provider-supported exact-prefix routing key; max 64 chars, never sensitive |
| `TAVILY_API_KEY` | optional | better web search; DuckDuckGo without it |
| `COGNOS_SOURCES_ENABLED` | optional | source-ingestion kill switch; default `true` |
| `COGNOS_SOURCE_MAX_BYTES` | optional | document bytes, default `4000000` (platform request-body limits still apply) |
| `COGNOS_SOURCE_MAX_TEXT_CHARS` | optional | extracted characters, default `750000` |
| `COGNOS_LINK_MAX_BYTES` | optional | fetched bytes, default `2000000` |
| `COGNOS_LINK_TIMEOUT_MS` | optional | safe link fetch timeout, default `12000` |
| `COGNOS_AGENT_ENABLED` | optional | non-off bounded agent modes; default `true`; does not enable writes |
| `COGNOS_RUNTIME_SECRET` | optional | set → gate on; unset → app opens straight to chat |

None of these are exposed to the browser — there are no `VITE_*` variables in
this app, so nothing can leak into the bundle by construction.

Document uploads are base64 JSON requests so the platform's request-body cap is
reached before the server's decoded-byte cap on some plans. Keep the default
4 MB browser limit or lower `COGNOS_SOURCE_MAX_BYTES` if the deployment platform
has a smaller cap. Link retrieval happens server-side and permits only public
HTTP(S) destinations on ports 80/443; do not add a generic proxy rewrite around
it, because that would bypass the DNS-pinned SSRF boundary.

### ⚠️ Function duration — read this

The council is **sequential by design**: ~6 model calls per turn. With a
reasoning model that is commonly **30–90 s**. Vercel's limits:

| Plan | Default | Max (`maxDuration`) |
|---|---|---|
| Hobby | 10 s | **60 s** |
| Pro | 15 s | 300 s |

`vercel.json` requests `maxDuration: 300`. **On Hobby that is silently capped at
60 s**, and a slow turn will be killed mid-stream. Options:

1. **Pro** — the honest fix for the full council.
2. **Stay on Hobby** and lower cost per turn: set `COGNOS_FAST_MODEL` to a fast
   model, and optionally `COGNOS_CRITIC_ENABLED=false` (removes the critic and
   its revision loop — 1–2 fewer calls). This trades council depth for latency.
3. **Self-host** the API (`npm start`, which runs `server/serve.js`) on a box
   with no timeout, and point Vercel's SPA at it.

Note that SSE keeps the connection open, so the user *sees* progress the whole
time — but the platform still kills the function at the cap.

### Diagnosing HTTP 504

A council error that says **“model provider gateway timed out (HTTP 504)”** means
the configured OpenAI-compatible model endpoint returned the 504. COGNOS now
retries that transient response once by default after 250 ms, using the exact
same prompt and model, inside the original logical deadline. Raw proxy HTML such
as an OpenResty error page is discarded and never persisted or shown to users.
Set `COGNOS_LLM_MAX_RETRIES=0` to disable or `2` for two retries; do not raise it
beyond the enforced bound.

Inspect `/system` or `/api/meta/telemetry/<runId>`: a recovered incident has an
attempt-1 `http_error`/`gateway`, an attempt-2 `success`, and the retained failure
is marked `recovered: true`. Repeated final 504s indicate provider/model
availability or a request the upstream gateway cannot finish before its own
limit. Changing `COGNOS_LLM_TIMEOUT_MS` cannot extend an upstream proxy's timeout.
If Vercel itself ends the request before COGNOS emits an SSE error, use the plan
or self-hosting options above; an application retry cannot outlive the platform
function.

## 4. Local development

```bash
npm install
cp .env.example .env      # fill in BLUESMINDS_API_KEY + DATABASE_URL
npm run dev               # Vite on 5173, API on 3000, /api proxied
```

Production-style single process:

```bash
npm run build && npm start   # http://localhost:3000
```

## 5. Verify a deploy

```bash
curl https://<your-app>.vercel.app/api/health
```

```json
{
  "ok": true,
  "model": "gpt-4o-mini",
  "modelRequestPolicy": { "timeoutMs": 60000, "maxRetries": 1 },
  "databaseConfigured": true,
  "modelKeyConfigured": true,
  "llmServiceTier": "provider-default",
  "promptCacheKeyConfigured": false,
  "searchProvider": "duckduckgo",
  "sources": true,
  "agent": {
    "enabled": true,
    "modes": ["off", "observe", "read_only"],
    "autonomousWrites": false
  },
  "gate": false,
  "ledger": true,
  "coherence": true,
  "telemetry": true,
  "adaptiveMode": "observe",
  "adaptiveModeForced": false,
  "strategy": "council_pipeline",
  "laws": 19,
  "lawLayerVersion": "1.2.0",
  "identityVersion": "1.1.0"
}
```

If `modelKeyConfigured` or `databaseConfigured` is `false`, the env var is
missing or scoped to the wrong environment. Then open the app and send one
message — you should see council stages appear live, and the thread should
still be there after a refresh.

### Verifying governed subsystems on a deploy

Send one message, then:

```bash
curl 'https://<your-app>.vercel.app/api/meta/telemetry?limit=1'   # one record for that run
curl 'https://<your-app>.vercel.app/api/knowledge/events?limit=20' # its ledger rows
curl 'https://<your-app>.vercel.app/api/knowledge/overview'
curl 'https://<your-app>.vercel.app/api/meta/laws'
curl 'https://<your-app>.vercel.app/api/identity'                    # canonical self-model + runtime state
curl 'https://<your-app>.vercel.app/api/sources?limit=5'
curl 'https://<your-app>.vercel.app/api/agent/tools'
```

Open **About COGNOS** and confirm the runtime facts match `/api/identity`; ask
“what are you and how do you work?” in Chat and confirm the answer says COGNOS,
identifies six operators, names the Governor as final authority, and states its
runtime limits without exposing any environment values.

Upload a small TXT/Markdown file through the Chat paperclip, attach it to a turn,
and confirm its council trace lists the immutable source id and citable chunks.
Use **Observe** with an explicit URL and confirm the plan remains proposed; use
**Read only** and confirm the trace records each bounded read. A private address
such as `http://127.0.0.1/` must fail inside the agent step and must never be
fetched.

The telemetry record's `message_id` should equal the assistant message the
browser received, and `ledger_events` should equal the number of rows the run
wrote before the record was finalized. `/system` in the UI shows the same thing
with replay and the Policy Engine.

After at least 20 representative production turns, run the read-only evidence
report from a trusted operator environment using the same `DATABASE_URL`:

```bash
npm run latency -- --limit=200 --days=7
```

It separates known-warm and cold-instance candidates, database setup, stage and
provider response latency, and reports whether prompt caching or a requested
service tier was actually observed. It will not recommend a post-processing
outbox before its evidence floor is met.

**Cost note.** Telemetry adds no model calls on the happy path — the coherence
monitor is one extra call per turn (cheap model, `COGNOS_COHERENCE_ENABLED=false`
turns it off), and everything else is bookkeeping inside the turn that already
happened. Document parsing and link retrieval add no model call, but attached
source excerpts increase prompt tokens and a read-only agent link adds bounded
network latency before context assembly. Set `COGNOS_LEDGER_ENABLED=false` and `COGNOS_TELEMETRY_ENABLED=false`
to fall back to pre-Phase-14 behaviour without a redeploy of code.

**Vercel function duration.** The post-response batch now includes the knowledge
projection and the telemetry write. Both are local database work (a handful of
inserts in one transaction), not model calls, so they add milliseconds — but the
sequential-council Hobby-plan ceiling described in §3 is unchanged and still the
thing to watch.
