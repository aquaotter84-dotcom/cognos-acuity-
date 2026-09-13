# Phase 24 — Accounts & Multi-Tenant Workspaces

A clear, append-only, isolation-aware **workspace system** layered over the
existing trust-annotated Atlas graph (Phase 23). Every person gets a private
workspace (`ws-<workspace_id>`); groups get public/private buckets; every
mutation is sealed, scoped by a JWT claim, and audited. **Sign-in is by email
or by Google.**

```
┌───────────────────────────────┐
│        REST API (Express)     │
│  /api/accounts/*              │   email + password  ─┐
│  /api/accounts/auth/google/*  │   Sign in with Google ─┤─► JWT {sub, ws, jti}
│  /api/workspaces/*  /api/groups/*                      │
└──────────────┬────────────────┘                        ▼
        Auth (Bearer JWT)          Workspace Manager (shards the atlas per user)
        + jti blocklist            namespaced keys · isolation gate · seals
        ▼                                     ▼
   accounts / groups /                graph_nodes / graph_edges
   jwt_blocklist / workspace_audit    (append-only, provenance-sealed)
```

---

## 1. Key provenance references (registered facts)

The account service **only** asserts user facts that come from trusted Atlas
rows. The registry lives in `server/accounts/facts.js`; the pure test
(`test/phase24.mjs`) enforces that nothing untrusted ever enters it.

| ID | Registered Fact | Note |
|---|-----------------|------|
| `[graph_mu02bqyvnd1cmlmv]` | user.name.full – “Jeremy Bryan Perritt” | Trusted, truth-bearing |
| `[graph_mu02bqun6vptjczp]` | user.role – developer of the assistant | Trusted |
| `[graph_mu02br2ofvew5mqm]` | user.preferred.name – “Patches” | Trusted; seeds the default `display_name` |
| `[graph_mu02br6ged2v5219]` | user.values – autonomy, deep work, maker mindset, subtractive innovation, opposes bureaucracy & merit-ocracy | Trusted |
| `[graph_mu02bra9qiw2n5kp]` | user.name.variant – “Jeremy Brian Perritt” | Trusted |
| `[graph_mu01yzi4hosh3erz]` | user.name.middle – spelled “Bryan” | Trusted |
| `[graph_mtzt7k3ei9ozy2ci]` | Conservative duplicate of the name (Jeremy Brian Perritt) | Trusted |
| `[graph_mtzt7jzlg5oklort]` | Assistant no longer tied to the Base 44 integration layer | Trusted |

**Rule.** The system references these rows as *ground truth* only. Rows marked
NOT truth-bearing are contextual and are never used to generate assertions —
the registry structurally cannot hold them, and the test pins that.

---

## 2. Sign-in

### Email + password
- `POST /api/accounts/register` `{ email, password, display_name? }` → 201, JWT
- `POST /api/accounts/login` `{ email, password }` → 200, JWT
- Passwords: Node-built-in **scrypt** (N=16384, r=8, p=1, 16-byte random salt),
  versioned wire format, timing-safe compare. Unknown emails run the same
  scrypt work against a dummy hash so login timing cannot enumerate accounts.
  A bounded in-memory throttle (10 failures / 15 min / email+ip → 429) blunts
  brute force. *Divergence:* the brief said “Bcrypt/Argon2”; scrypt is the same
  memory-hard KDF family with zero native dependencies on serverless. The hash
  format is versioned so a future argon2id migration is per-row.
- Default `display_name` comes from trusted row `[graph_mu02br2ofvew5mqm]`
  (“Patches”) unless the caller passes one or sets `COGNOS_DEFAULT_DISPLAY_NAME`.

### Google
- `GET /api/accounts/auth/google/start` → 302 to Google consent (or `?format=json`
  for API/SPA clients). A single-use `state` + `nonce` pair is persisted
  (10-minute TTL) before the redirect leaves the server.
- `GET /api/accounts/auth/google/callback?code&state` → code exchanged at
  Google's token endpoint; `state` consumed atomically (replay = 401).
- `POST /api/accounts/auth/google/verify` `{ credential, nonce? }` → the
  Google Identity Services / One Tap path.
- The `id_token` is **verified locally** against Google's JWKS: RS256 only
  (every other `alg` refused), `kid`-selected key, signature via `node:crypto`,
  `iss` restricted to Google's two issuer values, `aud == GOOGLE_CLIENT_ID`
  (`azp` checked when present), `exp` with 60 s leeway, future `iat` refused,
  and the `nonce` must match the one the flow started with.
- **Account linking rule:** a Google identity may only attach to an existing
  local account when `email_verified === true` — Google's documented defence
  against account squatting. Otherwise a distinct account is created. A
  conflicting `google_sub` is a 409.
- Config: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (+ optional
  `GOOGLE_OAUTH_REDIRECT_URI`, `COGNOS_OAUTH_REDIRECT_TO` for frontend
  handoff via URL fragment). Unconfigured deployments answer 501 with a clear
  message; nothing half-works.

### Tokens
- HS256 JWT signed with `COGNOS_JWT_SECRET` (falls back to
  `COGNOS_RUNTIME_SECRET`; with neither, an ephemeral per-process secret is
  minted and a loud warning logged — dev/preview only).
- Claims: `sub` (user_id), `ws` (workspace_id — the ONLY workspace the bearer
  can touch), `jti` (unique — logout revocable), `iss`, `aud`, `iat`, `exp`.
- `POST /api/accounts/logout` writes the `jti` to the `jwt_blocklist` until
  the token's natural expiry. *Divergence:* the brief suggested Redis; the
  blocklist is a Postgres table whose expired rows are purged on write —
  Redis-TTL semantics without a second running system. (Swap-in point:
  `server/accounts/store.js → AuthBlocklist`.)
- The auth middleware also re-checks the account's current workspace binding;
  a token whose `ws` claim no longer matches the account is refused (stale
  binding), so revoking/reassigning a workspace cannot be outlived by old tokens.

---

## 3. Workspaces

### Namespaces
| Namespace | Atlas `workspace_id` | Node-key prefix | Who |
|---|---|---|---|
| `ws-<workspace_id>` | the workspace row's UUID | `ws-<workspace_id>:` | the account it belongs to |
| `group-public-<group_id>` | the bucket token itself | `group-public-<group_id>:` | group members (read) / owner (write) |
| `group-private-<group_id>` | the bucket token itself | `group-private-<group_id>:` | owner + flagged members |

A private workspace is a real row in the existing `workspaces` table created
in the same transaction as the account, so the whole single-tenant stack
(conversations, memories, the atlas projection) works per-user unchanged.

### Append-only store
`createNamespacedNode` (server/knowledge/graph.js) uses the exact Phase 23
machinery — insert + provenance seal + ledger event — with the namespace
prefix folded into `node_key`. There is no update-in-place and no delete:
"delete" is `POST .../nodes/:id/retire`, a transition that keeps the row and
its lineage. Deduplicated creates return the existing live head.

### Sealed provenance (brief §2.2, §3.2)
Every node carries BOTH witnesses:
- `provenance.ws_seal` — `sha256` over canonical
  `("cognos.ws_node_v1", content, timestamp, creator_id, workspace_id)` —
  the brief's `hash(content || timestamp || creator_id || workspace_id)`;
- `content_sha256` — the atlas seal, recomputable from stored columns
  (`verifyNodeSeal`), which also covers the provenance block where the run id
  (`run_id`) and source atlas row (`source_graph_id`, e.g.
  `"[graph_mu01yzi4hosh3erz]"`) live.

A client-claimed seal that fails any segment → **422** plus a
`provenance.mismatch` incident in the audit trail. `GET
/api/workspaces/:ns/verify` audits the whole namespace against both seals.

### Isolation policy (brief §4)
The single gate is `resolveAccess()` in `server/workspaces/manager.js`. The
`ws` claim comes from the verified JWT, never from the request; group access
resolves through membership + the role matrix. Every read and write passes
through it; anything outside the bearer's namespaces is a **403** with an
`isolation.denied` incident logged on the *caller's* trail (never on the
target's — audit reads never leak another user's activity).

### Group role matrix (brief §2.3)
| Role | public bucket | private bucket |
|---|---|---|
| owner | read + write | read + write |
| member | read | — |
| member flagged `can_write_private` | read | read + write |

Groups: `POST /api/groups`, membership managed by the owner only
(`POST /api/groups/:id/members`, `POST .../members/:userId/flag`,
`DELETE .../members/:userId`).

---

## 4. Audit log

`workspace_audit` — one immutable row per mutation or denial:
`<ts_ms, user_id, workspace_id, action, resource_id, detail>`. The app issues
INSERT/SELECT only. `GET /api/workspaces/:ns/audit` is the read function
(owners see a group bucket's whole trail; members see their own rows).
`node scripts/audit-rotate.mjs` moves rows older than
`COGNOS_AUDIT_RETENTION_DAYS` (default 35) into `workspace_audit_archive` in
one transaction (`--dry-run` supported) — the single sanctioned mover.

## 5. Relationship to the legacy single-tenant surface

Nothing above changed. `/api/chat`, `/api/graph/*`, and the rest still work
against the default workspace exactly as before (behind the cookie gate when
`COGNOS_RUNTIME_SECRET` is set). The Phase 24 surface is exempt from that
cookie gate because it *is* the authentication layer and carries its own
Bearer controls. Multi-tenancy is strictly additive.

## 6. API docs

`docs/openapi.yaml` — OpenAPI 3.1, every fact-asserting response annotated
with the Atlas row ids it is allowed to cite. Serve it in any Swagger editor,
e.g. `npx @redocly/cli preview-docs docs/openapi.yaml`.

## 7. Tests

`npm run phase24` — 40 checks: scrypt round-trips, JWT tamper/expiry/alg
refusals, spec-seal segment flips, namespace parsing, the full role matrix,
Google id_token verification against local RSA JWKS (signature, algorithm,
audience, issuer, expiry, nonce, key rotation), then a live-app run over
PGlite covering registration (workspace + “Patches”), seals, 422 incidents,
403 isolation, logout revocation, audit uniqueness, the group buckets, and a
full Google OAuth code flow against an in-process mock OIDC provider
(state single-use, verified-email linking, unverified refusal).
