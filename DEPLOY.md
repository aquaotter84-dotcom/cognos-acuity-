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

No migration step. The schema is created lazily on first query, and every
statement is `IF NOT EXISTS`, so it is safe on every cold start.

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
| `TAVILY_API_KEY` | optional | better web search; DuckDuckGo without it |
| `COGNOS_RUNTIME_SECRET` | optional | set → gate on; unset → app opens straight to chat |

None of these are exposed to the browser — there are no `VITE_*` variables in
this app, so nothing can leak into the bundle by construction.

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
  "databaseConfigured": true,
  "modelKeyConfigured": true,
  "searchProvider": "duckduckgo",
  "gate": false
}
```

If `modelKeyConfigured` or `databaseConfigured` is `false`, the env var is
missing or scoped to the wrong environment. Then open the app and send one
message — you should see council stages appear live, and the thread should
still be there after a refresh.
