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
- **Phase 22, bounded context + structured memory** — a deterministic admission
  window keeps more recent dialogue while reserving explicit budgets for
  conversation summaries, immutable evidence, web briefings, and structured
  persistent memory. Memory rows retain readable content and also carry a
  `working` / `episodic` / `semantic` layer, stable key, bounded JSON value,
  evidence/confidence metadata, and optional expiry. Selection is measured in
  the council trace and cannot change governance or write by itself.
- **Phase 17, Governed Sources + Agent Mode** — immutable document and webpage
  snapshots, page/section-aware citation chunks, prompt-injection and SSRF
  boundaries, and explicit per-turn agent modes. Agent mode is a bounded
  read-only subsystem with no autonomous writes and no answer channel.
- **Phase 18, COGNOS Projects** — durable research projects that group
  conversations, immutable evidence, agent runs, decisions, and approvals;
  governed image ingestion (PNG/JPEG/WebP originals, hashes, region-boxed
  vision readings, injection screening, region-aware citations such as
  `[src_…:r2]`); and a research agent mode that proposes a finite plan and
  executes only what the user approves, with every consent recorded per step.
  Research never releases an answer — the council answers from the approved
  fetch results like any other evidence.
- **Phase 23, trust-annotated knowledge graph ("Atlas")** — a user-controlled,
  append-only fabric stitching sessions, sources, and intents. Concept, person,
  source, event, and intent nodes carry provenance seals and `verified` /
  `trusted` / `untrusted` / `flagged` trust; every edge links with its own
  hash. Each turn consults the atlas before drafting and projects the governed
  exchange back after the ruling — a veto projects nothing. Graph citations
  (`[graph_…]`) are audited against the nodes the turn actually loaded;
  invented, retired, or untrusted citations are flagged and redacted. The user
  pins, forks, revises, retires, and re-trusts rows; immutable Merkle snapshots
  diff exactly what moved; `/system → Graph` is the window onto all of it.

`/system` in the UI is a read-only window onto the knowledge and reasoning
records; each completed chat trace also exposes its source and agent provenance.
The **Projects** page lists research folders with their conversations and
hashed evidence; the chat sidebar groups project chats beneath each project.

## Accounts & multi-tenant workspaces (Phase 24)

Sign in **by email or with Google**, get a private, isolated workspace over the
trust-annotated atlas, group workspaces with public/private buckets, sealed
provenance on every row, JWT auth with logout revocation, and an append-only
audit trail. Strictly additive — the single-tenant app above works unchanged.

- `server/accounts/` — scrypt passwords, dependency-free HS256 JWT with
  `sub`/`ws`/`jti` claims and a Postgres revocation blocklist, Google OAuth +
  GIS id_token verification against Google's JWKS (RS256-only, nonce, verified-
  email linking), and the trusted-fact registry: user facts are asserted only
  from trusted Atlas rows (`[graph_mu02br2ofvew5mqm]` seeds the default
  display name "Patches"), never from NOT-truth-bearing context.
- `server/workspaces/` — the isolation gate (namespace `ws-<workspace_id>`,
  `group-public-<gid>`, `group-private-<gid>`), the group role matrix
  (owner writes both buckets; members read public; flagged members read/write
  private), the spec seal `hash(content || timestamp || creator_id ||
  workspace_id)` (mismatch = 422 + audited incident), and soft-delete retire.
- Routes: `/api/accounts/*`, `/api/workspaces/*`, `/api/groups/*` — see
  [docs/WORKSPACES.md](./docs/WORKSPACES.md) and
  [docs/openapi.yaml](./docs/openapi.yaml). UI at `/signin`.
- Tests: `npm run phase24` (40 checks incl. a full Google flow against a local
  mock OIDC provider). Rotate the audit trail with
  `node scripts/audit-rotate.mjs`.

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
capabilities rather than inventing them: private-network browsing,
consequential writes from a chat turn, irreversible autonomous acts,
pixel-level vision inside answer drafts, and image editing are not present.
Optional email/Google accounts and durable autonomy are runtime switches,
reported off until an operator enables them.
Image ingestion is supported but bounded: an image original is the
authoritative artifact, its vision transcript is a labeled model-extracted
reading that can misread, and printed image text is untrusted evidence.

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

## Documents, images, links, and bounded agent mode

The paperclip in Chat opens the evidence-source panel:

- Upload **PDF, DOCX, TXT, Markdown, or CSV** files (4 MB default server
  limit). Parsing is deterministic and executes no document macros or scripts.
- Upload **PNG, JPEG, or WebP images** — screenshots, photographs, scans,
  charts, tables, diagrams, interfaces. The server parses the real image
  format, keeps the immutable original (SHA-256, byte-served with an ETag),
  and, when vision is enabled, records a bounded region-boxed transcript with
  model/time provenance. Region text becomes citable chunks
  (`[src_…:r1]`); printed text is screened for prompt-injection patterns and
  is always untrusted evidence, never instructions.
- Open a public HTTP(S) link. Retrieval uses DNS pinning, rejects credentials,
  local/private/reserved addresses, nonstandard ports, HTTPS downgrades,
  excessive redirects, compression surprises, oversized bodies, and timeouts.
- Attach up to eight immutable source snapshots to a turn. COGNOS selects
  page/section/image-region chunks within a bounded context budget and requires
  exact `[src_id:locator]` citations; the Governor refuses invented source
  locators.

Source text is always labeled **untrusted evidence, not instructions**. Detected
prompt-injection patterns are retained as risk flags for inspection; source
commands are never executed. Browser-provided source names or text are ignored:
the server resolves ids back to its own hashed snapshot.

The composer also has four explicit agent modes:

- **Agent off** — no autonomous tool plan. Manually attached sources still work.
- **Observe** — records the `read_source` / `open_link` plan but executes no
  agent tools. Explicitly attached sources remain ordinary council context.
- **Read only** — may read selected snapshots and safely open up to three URLs
  explicitly present in the user's message, with six total steps maximum.
- **Research** — inspects the conversation's evidence and proposes a finite
  read-only plan (up to `COGNOS_RESEARCH_MAX_STEPS` URLs, each with a stated
  reason). The plan lands `awaiting_approval`; the card under the composer
  shows each exact URL, and only an explicit **Approve** (or **Decline**)
  decision executes (or freezes) it. Approving records one consent row with a
  per-step scope hash before any fetch; declined runs execute nothing and
  cannot be re-decided. The next question in that conversation is then answered
  by the council with the approved fetches attached as ordinary evidence.

Each agent run, step, failure, approval, and status transition is attributable
in `agent_events` / `agent_approvals`. There are no write-capable tools and no
background tasks. Agent preparation finishes before context assembly, so the
council never reasons over an incomplete source snapshot. The six council seats
and the post-Governor answer release point are unchanged.

## Durable research projects

Chrome-free but durable: the sidebar and the **Projects** page create research
folders (name + optional objective). A project groups its conversations and
every document, image, and link uploaded inside them, plus the agent runs and
approval records. Conversations, sources, and provenance survive across
sessions; deleting a project **detaches** its conversations and evidence — it
never deletes them. Within a project, natural chat, uploads, links, image
analysis, and approved research all work exactly as outside, with the project
boundary recorded on every row.

## Durable autonomy (off by default)

`AUTONOMY.md` is the design; Phases 19–21 and 25 of it are built and **green**, and the
subsystem is off until an operator switches it on. A *resident* is a job with a
versioned brief and a narrow skill allowlist. A *goal* does no work until an
authorization row records consent against hashes of the exact scope and budget
granted. A lease-guarded tick runs bounded slices, appends typed notes, and
reports through templated notices — never through model prose.

Everything a goal wants to do to the world goes through an outbox and an Action
Governor that refuses with a named rule and a cited law. Skills are tiered by
consequence:

| Tier | Means | Skills | Status |
|---|---|---|---|
| T0 | observe — nothing leaves the system | `note.append`, `evidence.read`, `memory.search`, `belief.search` | built |
| T1 | internal write — reversible as a transition | `source.snapshot`, `note.promote.request`, `subagent.spawn` | built (`subagent.spawn` rung-gated) |
| T2 | notify — templated, deterministic content only | `notice.emit` | built |
| T3 | external read | `web.fetch`, `web.search` | built (`web.fetch` by the goal's URL allowlist, `web.search` additionally rung-gated) |
| T4 | **external write** | `webhook.post` | **built in Phase 21, off.** Live delivery is now earnable and flippable without a restart (Phase 22, autonomy row) — gated on a recorded corpus aimed at one approved destination |
| T5 | irreversible — payment, publish, delete | — | designed, not built (Phase 22, autonomy row — **not** the bounded-context Phase 22 above) |

Rung 4 is what Phase 21 added, and it is the sharpest edge in the system: the
first time COGNOS can act on something rather than look at it. One adapter, POST
to an https destination **granted row by row in the goal's scope** — a read allowlist never
widens into a write destination, and a grant naming no destination grants
nothing. The URL is re-checked structurally and re-resolved against DNS on every
hop including every redirect; argument headers are allowlisted with
`Authorization` refused outright; signing is by `secret_ref`, an environment
variable *name* resolved at send time and stored nowhere; receipts are ids,
counts and digests, so a receiver that echoes a credential back cannot write it
into the ledger; and reversing a delivered write records `unsendable: true`
rather than pretending a trigger can be un-fired.

Three facts are reported separately everywhere — `/api/autonomy/status`,
`/api/agent/tools`, `/api/identity`, and the Autonomy page: T4 is **built**;
`COGNOS_AUTONOMY_EXTERNAL_WRITES` says whether the rung is **on**; and
`live` plus a recorded evidence row say whether anything **delivers**. The outbox
defaults to `shadow`, where verdicts are recorded and nothing is performed. A
live release additionally refuses with `EVIDENCE_GATE_UNMET` until
`POST /api/autonomy/rungs/:rung/evidence` has recorded a corpus of at least
`COGNOS_AUTONOMY_MIN_SHADOW_SAMPLES` same-tier samples with **zero** false
releases, at least one release and at least one refusal in it. Raising the floor
afterwards invalidates an old justification instead of grandfathering it.

Two of those surfaces report a fourth fact alongside `deliversNow`, because
collapsing them was a way of saying "delivers nothing" while a byte could still
leave: **`deliversOnApproval`**. An operator's Approve on a staged row judges
that effect in live mode whatever the loop's mode is, so `deliversNow: false`
is a claim about the loop and not a claim about the deployment.

### Earning the flip (Phase 22, autonomy row — first slice)

Going live used to be an environment variable and a restart: a switch that said
nothing at the moment you threw it, whose consequences arrived later as
per-effect refusals. It is now a **recorded, guarded decision**.
`POST /api/autonomy/settings` with `{ outboxMode }` widens or narrows the mode
and stores it in `autonomy_settings.outbox_mode`, audited as
`autonomy.outbox_mode` with both values and the digest of the evidence that
justified the widening.

Widening to `live` is refused with `409 live_not_earned` unless **all eight**
conditions hold, and the refusal carries the whole readiness report rather than
a bare no — `GET /api/autonomy/rungs` returns the same report as `live` before
anyone tries:

| Condition | What it asks |
|---|---|
| `delegated` | `COGNOS_AUTONOMY_OUTBOX_UI_CONTROL=true` |
| `not_pinned_down` | no `COGNOS_AUTONOMY_OUTBOX_MODE` value holds the mode below live |
| `autonomy_on` | the loop is running, so there is something to release |
| `rung_flag` | `COGNOS_AUTONOMY_EXTERNAL_WRITES=true` |
| `destination_approved` | exactly one live destination is named and well-formed |
| `evidence_recorded` | a `justified` evidence row exists for the rung |
| `evidence_current` | the corpus *still* satisfies the gate as configured now |
| `corpus_aimed` | the earned corpus was aimed at that destination |

The last one is the reason the destination is named **before** the corpus is
earned: a gate satisfied by deliveries to another endpoint is evidence about
that endpoint. **Narrowing is refused by nothing** beyond delegation and a pin —
a brake an operator has to earn is not a brake — and a request for the mode
already in effect writes no row and records no transition.

The approved destination is also enforced per effect: a live T4 release to a
destination the goal *was* granted but the deployment did *not* name refuses
with `DESTINATION_NOT_APPROVED` (`pin.live_destination_approved`). Both gates
must hold, so their intersection is narrower than either alone. Shadow judging
is untouched, because the shadow corpus is what earns the rung.

This slice adds no rung, no skill, no ceiling and no budget. **T5 is still
design only**: `tierAllowed` refuses it outright, the outbox route refuses to
approve one, and any T5 release in a corpus is a false release by definition.

## Turning it on from the UI, and designing a resident (Phase 25)

Autonomy being off by default is correct. The *only* way to change that being an
environment variable plus a restart is not: the Autonomy page could show you a
frozen system and offer nothing but the name of a variable you cannot set from a
browser. Phase 25 is hybrid enablement — the operator decides **who** decides.

| Variable | Meaning |
|---|---|
| `COGNOS_AUTONOMY_ENABLED=true` | A **pin**. Autonomy is on and the UI may not turn it off. `POST /api/autonomy/settings` answers 409 and says so. |
| `COGNOS_AUTONOMY_UI_CONTROL=true` | A **delegation**. The Autonomy page gets a real Enable/Off switch. Delegation is not enablement — the system is still off until someone flips it. |
| neither | The page shows copyable setup steps instead of a dead toggle. |

The delegated value lives in `autonomy_settings` (migration `0012`), one row per
workspace, and it can hold **only** the global on/off — there is no column for a
rung, a ceiling, a skill or a budget, so the table cannot widen anything. A flip
takes effect on the next heartbeat with no restart, and every flip is appended to
`workspace_audit` as `autonomy.enabled` with its from/to values and who did it.
Precedence is resolved in exactly one place (`server/autonomy/settings.js`),
which `autonomyConfig()` asks, so the tick, the Action Governor and the skill
registry all read the same answer. Both switches are allow-lists: only
`1/true/yes/on/enabled` enable, so `COGNOS_AUTONOMY_ENABLED=` — the most likely
misconfiguration on a real host — is **off**.

An unloaded cache reads `false`, and a failed re-read keeps the last known value
and marks itself `stale`: a database blip cannot silently enable a system, and it
should not silently freeze a running one either.

**Designing a resident is a conversation.** A Bot button in chat and *Design with
COGNOS* on the Autonomy page open the same drawer: describe what you want watched
and how often, and COGNOS drafts the complete resident — name, purpose, brief,
skill allowlist, wake-up interval, budget and an optional first goal. You refine
it by talking, then create it with one click. Four rules make that safe:

1. **A turn creates nothing.** The draft is inert; creation is a separate
   explicit `POST` that re-clamps what the browser sent, because a draft could
   have been edited between turns.
2. **Skills are intersected, and every omission is named.** A skill that does not
   exist, or that this deployment cannot execute (its rung is off, its notice
   channel is unset, its kill switch is closed), is dropped *with the reason
   shown*. A silently shortened allowlist is how an operator ends up authorizing
   something other than what they read.
3. **Budgets only clamp down** against `DEFAULT_GOAL_BUDGET`, and each reduction
   is reported. Scope is not settable from a draft at all — a model proposing its
   own scope would be proposing its own authority.
4. **Failures are sentences.** A missing API key, an unreachable provider, or
   output that will not parse all return a bounded, secret-free message and a
   code (503/502, never a 500 with raw configuration text), and the previous
   draft survives so a failed turn costs nothing.

The designer works while autonomy is frozen — that is the point of it. Creation
is what waits, and the refusal names the switch that unblocks it. Its model prose
is a short design note about the rows it proposes, not an answer to a question:
`POST /api/chat` remains the only route that composes an answer.

The page also answers *"what does autonomy want from me?"* in one glance
(`GET /api/autonomy/attention`): waiting authorizations, staged actions, unread
notices, paused goals and open promotions, each group naming the tab that
resolves it. Rows are bounded; **count is the full total**, so `?limit=1` cannot
pretend the inbox is empty. Statuses read as sentences everywhere — *Waiting for you*, *Paused
with a reason*, *Ran out of budget* — in the page and in the chat Goal Card, with
the machine vocabulary demoted into a **Technical details** disclosure rather
than deleted, and a glossary behind the **?** button. Labels live in
`src/lib/autonomyLabels.js` so the same status cannot read one way on the page
and another way in chat.

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
| `COGNOS_CONTEXT_MAX_TOKENS` | no | Deterministic context admission budget; default 16,000, clamped to 4,000–128,000. The window includes recent dialogue, summary, structured memory, evidence, search context, and the current request. |
| `COGNOS_CONTEXT_MAX_HISTORY_MESSAGES` | no | Recent dialogue ceiling before token budgeting; default 40. Older history is omitted first and the omission is reported in the council trace. |
| `COGNOS_CONTEXT_*_TOKENS` | no | Optional per-layer ceilings for history, summary, memory, source, search, workspace, user input, overhead, and output reserve; all are bounded in `server/contextWindow.js`. |
| `COGNOS_SOURCES_ENABLED` | no | Default `true`; kill switch for source APIs and source context. Existing immutable rows remain. |
| `COGNOS_SOURCE_MAX_BYTES` | no | Raw document limit, clamped to 100 KB–8 MB; default 4 MB. |
| `COGNOS_SOURCE_MAX_TEXT_CHARS` | no | Extracted-text limit, clamped to 50,000–2,000,000; default 750,000. |
| `COGNOS_LINK_MAX_BYTES` | no | Fetched response limit, clamped to 100 KB–5 MB; default 2 MB. |
| `COGNOS_LINK_TIMEOUT_MS` | no | Per-link timeout, clamped to 2–30 seconds; default 12 seconds. |
| `COGNOS_IMAGE_MAX_BYTES` | no | Raw image limit, clamped to 100 KB–8 MB; default 4 MB. |
| `COGNOS_IMAGE_VISION_ENABLED` | no | Default `true`. Set `false` to store image geometry only — no model readings are requested. |
| `COGNOS_IMAGE_MODEL` | no | Vision reading model; defaults to the primary model. |
| `COGNOS_RESEARCH_ENABLED` | no | Default `true`; hides research mode from the agent vocabulary when false. |
| `COGNOS_RESEARCH_MAX_STEPS` | no | Research plan size, clamped to 1–5 steps; default 3. Approving a plan consents only to the listed exact URLs. |
| `COGNOS_AGENT_ENABLED` | no | Default `true`; disables non-off agent modes when false. Agent writes remain unavailable regardless. |
| `COGNOS_AUTONOMY_ENABLED` | no | **Unset = the loop is frozen.** No goal wakes, no notice is written, no tick row is recorded. Set `true` to **pin** it on; the UI cannot override a pin. |
| `COGNOS_AUTONOMY_UI_CONTROL` | no | **Delegation, not enablement.** Set `true` to hand the on/off switch to the Autonomy page. The system stays off until someone flips it. |
| `COGNOS_AUTONOMY_OUTBOX_MODE` | no | `shadow` (default) records verdicts and performs nothing; `dry_run` also records the exact request it declined to send; `live` performs. **A pin over the delegated row**: set, it holds the mode down and the API cannot widen past it, though it can always narrow. Unset, the mode rests at `shadow` and a delegated flip may widen it. |
| `COGNOS_AUTONOMY_OUTBOX_UI_CONTROL` | no | **Delegation, not permission.** Set `true` to hand the *outbox mode* switch to `POST /api/autonomy/settings` and the Autonomy page. Separate from `COGNOS_AUTONOMY_UI_CONTROL`: that one delegates whether the loop **runs**, this one whether it may **act on the world**. Widening to `live` is still refused until it is earned. |
| `COGNOS_AUTONOMY_LIVE_DESTINATION` | no | **The one approved destination.** A live T4 delivery must target this endpoint *in addition to* the destination granted in the goal's own scope. One https URL on 443, no credentials, no literal IP, no local host. Unset, empty or malformed **fails closed**: no live delivery goes anywhere and a flip to `live` is refused. Shadow judging is unaffected. |
| `COGNOS_AUTONOMY_NOTICE_MODE` | no | `none` / `internal` / `webhook`. Unset + autonomy on → `internal`; unset + frozen → `none`. Explicit values always win. Webhook needs `COGNOS_AUTONOMY_NOTICE_WEBHOOK`. Notices are templates with declared fields. |
| `COGNOS_AUTONOMY_RESIDENTS` | no | Rung 3: sub-agents, promotion, and `web.search`. Default off. |
| `COGNOS_AUTONOMY_EXTERNAL_WRITES` | no | **Rung 4.** Default off. On its own it still delivers nothing: the outbox mode, a recorded evidence row, and one approved destination also apply. |
| `COGNOS_AUTONOMY_MIN_SHADOW_SAMPLES` | no | Same-tier samples a corpus needs before a rung can be recorded as justified. Default 25; zero false releases is not configurable. |
| `COGNOS_AUTONOMY_QUIET_HOURS` | no | `22-7` refuses external deliveries inside the window (a wrapping window is a window). Notices are exempt; unset or malformed is never active. |
| `COGNOS_WEBHOOK_MAX_BODY_BYTES` | no | Webhook body cap in **bytes**, clamped to ≤ 32768; default 32768. |
| `COGNOS_WEBHOOK_TIMEOUT_MS` | no | Per-delivery deadline, clamped 500–30000; default 8000. |
| `COGNOS_WEBHOOK_MAX_REDIRECTS` | no | Clamped 0–2; default 2. Every hop is re-validated and re-resolved. |
| `COGNOS_WEBHOOK_MAX_RETRY_DELAY_MS` | no | Cap on the single retry's wait, honouring `Retry-After`; default 2000. |
| `COGNOS_WEBHOOK_MAX_RESPONSE_BYTES` | no | How much of a response is even read before it is digested and discarded; default 65536. |
| `COGNOS_SKILL_<NAME>` | no | Per-skill kill switch, one per registry entry (`COGNOS_SKILL_WEBHOOK_POST`, `COGNOS_SKILL_WEB_FETCH`, …). `.env.example` lists every wired name; the suite asserts the two cannot drift. |

The autonomy subsystem has more knobs than this table (tick cadence, slice and
lease bounds, budgets, workspace ceilings, sub-agent limits). `.env.example` is
the complete list and every name in it is one the code actually reads.

The database initializes lazily — the build and a cold boot both succeed with no
database reachable. The schema is created on the first query that needs it.

The Phase 14/15 tables, Phase 16's nullable performance columns, Phase 17's
source/agent tables, Phase 18's project/image tables, Phase 22's structured
memory columns, and Phase 23's graph tables are part of that same lazy
migration. `server/db/schema.js` is
the single source of truth; `migrations/*.sql` is generated from it
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
    projects.js         Phase 18 durable project CRUD + detail counts
    knowledge.js        Phase 14 read-only query routes
    meta.js             Phase 15 read-only routes + Policy gate
    sources.js          immutable uploads (docs/links/images) + agent runs,
                        image bytes, and the research decision route
    autonomy.js         residents, goals + the authorization barrier, the outbox
                        and its decision route, rungs/evidence, promotions, ticks,
                        the delegated switch, attention queue, resident designer
  serve.js              local/self-hosted listener (Vercel does not use this)
  mock-openai.js        local OpenAI-compatible mock (development aid)
  mock-latency.js       local latency injector (development aid)
  chatOrchestrate.js    the council pipeline (port of the Base44 function)
  contextWindow.js      deterministic token admission for dialogue, memory, and evidence
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
  autonomy/             Phases 19–21 + 25: the loop, hybrid enablement, designer
    tick.js             lease-guarded slice: plan, gate, execute, park, report
    outbox.js           stage / judge / perform, idempotency, reversal, corpus
    actionGovernor.js   the verdict: named rules, cited laws, tier gates
    config.js           rung flags, budgets, ceilings, webhook bounds, quiet hours
    authorize.js        scope+budget hashes and authorizationCovers
    scopeUrl.js         read allowlists and granted write destinations
    webhookPost.js      Phase 21 adapter: shape, DNS pinning, signing, delivery
    externalRead.js  externalWrite.js  evidenceGate.js  store.js  notice.js
    promote.js  subagent.js  goalEvidence.js  heartbeat.js
  skills/               the code-owned registry (11 skills, T0–T4) + validateArgs
  db/
    schema.js           additive Phase 14–22 schemas (source of truth)
  memory/
    structure.js        bounded layers, stable keys, and JSON memory values
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
  sources/              Phase 17/18 extraction, chunking, evidence, image
                        parsing/vision readings + safe fetch
  agent/                bounded agent runner + research planner
  meta/                 Phase 15
    telemetry.js        the per-run recorder (subscribes to eventBus)
    rates.js            the editable cost rate table
    strategies.js       the strategy registry (seeded with exactly one row)
    evaluate.js         the offline evaluation harness
    adaptive.js         observe-mode selection + switch thresholds
    latency.js          p50/p95 analysis + evidence gate for an outbox
    policy.js           the Policy Engine
    store.js            createMetaStore(run): telemetry, strategies, ledger
migrations/             additive SQL (0001 phase 14 through 0012 autonomy settings)
scripts/
  generate-migrations.mjs  migrations/*.sql from server/db/schema.js
  migrate.mjs              apply them (refuses non-additive SQL)
  latency-report.mjs       read-only p50/p95 latency report
  evaluate-strategies.mjs  run the offline harness (operator-invoked)
src/
  pages/                Chat, Projects, Memory, Activity, System, Settings,
                        Autonomy (residents, goals, outbox + Rung 4, promotions),
                        Identity
  components/chat/      ChatMessage, ChatInput, CouncilTrace, LiveCouncil,
                        Sidebar, MobileNav, WelcomeScreen, SourceComposer,
                        ResearchDecisionCard
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
  phase18.mjs           projects, image ingestion, research-approval regressions
  autonomy.mjs          Phase 19: residents, goals, the barrier, tick, outbox (42)
  phase20.mjs           Phase 20: sub-agents, promotion, T3 reads, locators (22)
  phase21.mjs           Phase 21: webhook gates, SSRF, receipts, the evidence
                        gate — with a loopback sink receiving real bytes (35)
  outbox-live.mjs       Phase 22 (autonomy row): the earned flip to live for T4
                        only — mode precedence, the one approved destination,
                        the eight readiness conditions, digested audit (18)
  phase23.mjs           Phase 23: atlas seals, merkle snapshots, curation,
                        turn consult/project, citation audit, veto (24)
  identity.mjs          the immutable self-model, its prompt, and its API
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

GET  /api/autonomy/status             built / rung-on / delivers-now, per tier
GET  /api/autonomy/rungs              rung flags + the shadow-corpus measurement
POST /api/autonomy/rungs/:rung/evidence  record it (append-only; `insufficient` too)
GET  /api/autonomy/agents             residents, with brief versions
POST /api/autonomy/agents             create one (allowlist is code-owned)
GET  /api/autonomy/goals              goals + counters
GET  /api/autonomy/goals/:id          events, steps, notes, outbox, workers, queue
POST /api/autonomy/goals              propose a goal (awaiting_authorization)
POST /api/autonomy/goals/:id/decision THE BARRIER: authorize or decline, by hash
GET  /api/autonomy/outbox             effects + the corpus distribution
POST /api/autonomy/outbox/:id/decision   approve / refuse / revert one effect
GET  /api/autonomy/promotions         the memory-promotion queue
POST /api/autonomy/promotions/:id/decide human confirm (lands `inferred`)
GET  /api/autonomy/notices            templated reports
POST /api/autonomy/tick               run one slice (the heartbeat calls this)
GET  /api/autonomy/settings           the delegated switch: value, pin, may-the-UI-use-it
POST /api/autonomy/settings           flip it (409 against an operator pin or with no delegation)
GET  /api/autonomy/attention          what is waiting on a human, grouped, each with its tab
POST /api/autonomy/designer           one designer turn → a clamped draft (creates nothing)
POST /api/autonomy/designer/create    THE explicit click: re-clamps, then creates
```

```bash
npm test               # every suite: voice, phase22, phase23, phase24,
                       # performance, sources/agent, phase18, autonomy,
                       # autonomy-ux, phase20, phase21, identity, integrity, smoke
npm run autonomy-ux    # Phase 25: the delegated switch, the designer's clamps,
                       # the attention queue (3 harnesses: delegated / not / pinned)
npm run voice          # speech normalization and chunking regressions
npm run performance    # latency instrumentation and no-prompt-change regressions
npm run sources-agent  # extraction, SSRF, prompt injection, citation, agent tests
npm run identity       # immutable self-model, prompt, policy, API, and send-path checks
npm run latency -- --limit=200 --days=7  # read-only p50/p95 production report
npm run integrity      # governed stream, cancellation, structured API errors
npm run autonomy       # Phase 19: the loop, the barrier, the outbox (42 checks)
npm run phase20        # Phase 20: sub-agents, promotion, T3 reads (22 checks)
npm run phase21        # Phase 21: webhook gates, SSRF, receipts, evidence (35)
npm run outbox-live    # Phase 22 (autonomy row): earning and flipping live T4 (18)
npm run phase23        # Phase 23: atlas seals, curation, turn wiring, veto (24)
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
