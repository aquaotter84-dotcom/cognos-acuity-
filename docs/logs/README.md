# Captured logs

Evidence for the Phase 14 / Phase 15 work, captured in this sandbox on
2026-09-07 (Node v20, PGlite standing in for Postgres over the real wire
protocol, a scriptable mock model standing in for BluesMinds).

| File | Command | What it shows |
|---|---|---|
| `build.log` | `npm run build` | the production build, green: 2124 modules, `dist/assets/index-*.js` |
| `boot.log` | `npm run demo` | the app's own structured logger during a real turn — every stage, including the three Phase 14/15 non-council stages (`coherenceMonitor`, `knowledgeProjection`, `telemetryRecord`) |
| `smoke.log` | `npm run smoke` | **167 assertions, 0 failures** across the ten success-criteria scenarios |
| `demo.log` | `npm run demo` | the artifacts themselves: one exchange's SSE frames, its ledger rows, its telemetry record stage by stage, a replay at a past instant, a contradiction measured as a transition, a veto that wrote nothing to memory, a simulated upstream failure, and eleven Policy Engine judgments |

Reproduce any of them:

```bash
npm run build
npm run smoke
npm run demo
```

The harness (`test/`) boots the real Express app, the real database layer and
the real council. It needs no network access and no credentials: PGlite speaks
the Postgres wire protocol to `server/db.js`, and `test/mockModel.mjs` speaks
OpenAI-compatible HTTP to `server/llm.js`. Nothing in `test/` or `scripts/` is
imported by the application.

Interleaved `{"ts":…}` logger lines are filtered out of `smoke.log` and
`demo.log` for readability; `boot.log` is those same lines, unedited.
