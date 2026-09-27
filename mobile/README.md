# COGNOS on Android — on-device database

The APK runs the **real COGNOS server inside the app** (embedded Node.js via
`capacitor-nodejs`) and keeps its database in the phone's **internal storage**.
No Neon, no Vercel needed at runtime.

## How it works

1. The app launches a boot page (`mobile/boot-index.html`).
2. The boot page resolves the app's internal files dir, then starts the
   embedded Node runtime in manual mode with env:
   - `COGNOS_DATA_DIR=<files>/cognos`
   - `PORT=39391`
3. `mobile/entry.mjs` boots the regular `server/serve.js`.
4. `server/localdb.js` sees `COGNOS_DATA_DIR` with no `DATABASE_URL` and
   starts **PGlite (Postgres-as-WASM) with a file-backed `dataDir`** at
   `<files>/cognos/pglite`, fronted by the Postgres wire-protocol socket
   server. `server/db.js` connects with the ordinary `pg` driver — the same
   SQL, transactions and JSONB as production, zero data-layer changes. This
   is the exact pattern `test/pglite.mjs` already proves.
5. The boot page polls `http://127.0.0.1:39391/` and navigates the WebView
   into it, same-origin, so auth cookies and relative `/api/*` calls work.

Everything the app stores — conversations, memories, the Atlas knowledge
graph, projects, telemetry — lives in `<files>/cognos/pglite` on the device.
The schema is created lazily on first launch, exactly like a fresh server
deploy.

## What still needs the internet

The **model gateway** (`BLUESMINDS_API_KEY` / `OPENAI_API_KEY` in
`server/llm.js`) and web search still call out. The database is local; the
brains still phone home.

To provide the key, just launch the app: on first run (or any run where
no key is saved yet) it asks for your BluesMinds / OpenAI-compatible API key
and stores it privately in `<files>/cognos/bluesminds_api_key.txt`
(app-internal storage — no other app can read it). `mobile/entry.mjs` picks
it up at boot. To change it later, reinstall the app and enter the new key
when prompted.

## Building

Pushing to `main` (or running the workflow manually) builds the APK:

1. `npm ci`, `npm run build`
2. `node mobile/make-nodejs-project.mjs` — assembles `mobile-dist/`:
   boot page + pruned embedded Node project (server-only deps)
3. `npx cap add android` / `npx cap sync android`
4. `./gradlew assembleDebug` → artifact **`cognos-apk`**

Install it over any previous COGNOS APK; the data dir survives updates
(Android keeps internal storage on reinstall of the same app id).

## Files

- `server/localdb.js` — file-backed PGlite boot (also usable on desktop:
  `COGNOS_DATA_DIR=./data node server/serve.js`)
- `server/serve.js` — one additive `await bootLocalDatabase(logger)` line
- `mobile/entry.mjs` — embedded-Node entry point
- `mobile/boot-index.html` — launch page (becomes `mobile-dist/index.html`)
- `mobile/make-nodejs-project.mjs` — CI/local assembler
- `capacitor.config.ts` — app id `app.cognos.acuity`, manual Node start
- `.github/workflows/android.yml` — the build
