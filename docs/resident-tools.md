# Resident tools (Phase 36)

Jeremy's direction: Orbit-style assignable tools, for COGNOS residents. A tool
is an HTTPS endpoint Jeremy defines by hand — name, method, URL, headers, body
template — and hands to whichever residents should have it. A resident only
ever sees its own tools.

## The split of authority

Three things that must not be confused:

1. **SKILLS ARE CODE.** `tool.invoke` is registered in `server/skills/index.js`:
   the code-owned *mechanism* of invoking an HTTPS endpoint, with its tier
   (T4), idempotency rule, and kill switch. It cannot be added to at runtime —
   the Phase 19 law stands.
2. **TOOLS ARE JEREMY'S DATA.** A tool definition grants nothing by existing.
   Invocation needs a per-resident assignment (by slug, so a brief change
   doesn't strand or grant tools), the kill switch up, and — for writes —
   Jeremy's per-effect approval.
3. **SECRETS ARE WRITE-ONLY.** Typed once in the tool form, stored server-side
   in `resident_tool_secrets`, resolved at send time. No API ever returns a
   value; run history, outbox payloads, and logs carry names and `•••`, never
   values.

## Template language

URLs, header values, and the body template share one language:

- `{{name}}` — a runtime argument (flat string/number/boolean only).
- `{{secret:NAME}}` — a write-only secret, resolved at send time.
- `\{{` — a literal `{{`, for bodies that need braces.

Rendering fails closed: any placeholder with no value, or any stray `{{`,
throws. Placeholders are allowed in the URL's path and query, never the host.

## Reads vs writes

- **GET runs freely.** Still logged per resident (run history in the Studio),
   still structurally checked, still kill-switched — but no approval.
- **Anything else stages an approval.** `invokeTool` stages a `tool_call`
   effect in the outbox (idempotent on tool + goal + canonical args, so a
   double-tap doesn't double-stage) and records the run as
   `awaiting_approval`. Nothing is sent until Jeremy approves in the existing
   approvals inbox.

## One approval story, not two

A tool write is approved exactly like a T5 irreversible: the outbox decision
route appends an `effect_approvals` row naming the exact outbox id (the only
writer is that route — the loop can never approve itself), and the Action
Governor's `tool_call` branch reads it back (`TOOL_WRITE_NEEDS_APPROVAL`
without it). Same inbox, same route, same table, same one-at-a-time rule.

The Governor judges a `tool_call` on its own terms, not the goal-scope
machinery: the destination's authority is Jeremy's hand-typed definition, and
there may be no goal at all (per-resident chat). What it still enforces: the
kill switch (`AUTONOMY_DISABLED`), the assignment (`TOOL_NOT_ASSIGNED`), the
URL's shape and origin (`TOOL_URL_UNSAFE`, `TOOL_DESTINATION_MISMATCH`), the
method (`TOOL_METHOD_MISMATCH`), the header allowlist, the body cap, no
credentials outside `{{secret:…}}`, and the per-effect approval for writes.
Budgets are goal concepts; the approval is the gate for tools.

A refused-for-approval tool write re-opens when the approval lands, exactly
like a T5 refused for `T5_NEEDS_HUMAN` — the outbox replay exception covers
both rules.

## The kill switch

`effectiveEnabled()` is checked at invoke time, at Governor judgement, and
again in the executor just before the socket opens. An approval must not
outlive the master switch: approving while the switch is down refuses the
effect, and a race between judgement and send fails the run rather than
sending.

## SSRF and transport

Tool requests reuse the webhook adapter's safety: `checkWebhookUrl` per hop
(https, no credentials, no literal IP, no local/reserved host, port 443),
DNS pinning with per-redirect re-resolution, one bounded retry, and
metadata-only receipts (response bodies are digested and discarded — an
endpoint echoing a credential must not write it into the ledger). The rendered
request must stay on the definition's origin; the model fills arguments, never
the destination.

Headers follow the webhook allowlist (content-type, `x-cognos-*`) plus one
narrow exception: `x-api-key`, the standard custom-key header. `authorization`,
`cookie`, and session headers stay forbidden — ambient authority is never
hand-typed into a tool. Keys go in Secrets and are referenced as
`{{secret:NAME}}`.

## Per-resident chat

A resident's assigned tools are named in its chat system prompt. The model may
*request* calls (`tool_calls` in its reply JSON, max 2 per turn); the route
re-verifies every request (existence, assignment to *this* resident) and runs
it. Reads return their results inline; writes stage an approval and the chat
says so plainly. Tool runs render as cards in the drawer and join the
transcript as context for the next turn.

## Surfaces

- **Studio → Tools tab**: the library — create, edit, delete, tap-to-assign
   across residents, and the safety summary.
- **Resident cards**: a Tools picker (tap to hand over / take back) and recent
   run history.
- **Approvals inbox**: tool writes appear as `tool_call` effects, approved /
   refused / reverted like everything else.
- **Run history**: `resident_tool_runs` — metadata only (digests, status
   codes, latency, origins). No bodies, no secrets, no query strings.

## Deliberately out of scope

- **Loop-planner integration.** The tick's planner doesn't know about tools
   yet; invocation is per-resident chat, the manual invoke route, and the
   `invokeTool` programmatic entry. Wiring tools into autonomous goal work is
   the next slice.
- **LAN / non-https destinations.** The SSRF boundary is the webhook
   adapter's: public https only. A tool aimed at a LAN device is refused, same
   as a webhook would be.
- **Secret rotation / versioning.** Secrets are write-only upserts. Rotation
   is "type the new value"; there is no history.
