# Memory-layer alignment with Sapphire

Jeremy's direction: keep COGNOS's memory layers as close to Sapphire's design
as possible. Sapphire is [ddxfish/sapphire](https://github.com/ddxfish/sapphire)
("the AI agent you come home to"), AGPL-3.0.

**Hard rule, honored throughout: ideas only. No Sapphire code was copied,
vendored, or pasted.** Everything below is reimplemented in COGNOS's own code
and style, from a reading of Sapphire's public docs and architecture.

**Decision change (v46, 2026-10-04): full transplant.** The v41 posture was
alignment-without-rewrite — a stance Jeremy's own diagnostic then overruled.
His words: *"It has all its memories about me in every response. One time it
might think I just got home from work and the next time it might think I'm
about to take a nap. Like a roll of the dice, what it remembers."* Recall was
indiscriminate and temporally ungrounded: transient states surfaced across
turns as if current, contradicting each other, with no recency weighting or
staleness handling. So the "deliberately not adopted" list below became the
build list, and **Jeremy explicitly approved wiping the existing memories**
for the rebuild. Every item in that section is now adopted, with notes.

## What Sapphire does (from its public repo)

Sapphire's Mind Palace (memory v3) organizes one database into **layers on a
rail** — reserved seed layers plugins may never shadow:

| # | Layer | What lives there |
|---|-------|------------------|
| 0 | `self` | Who she is: the self sheet (typed sections + custom boxes) and free self-notes |
| 1 | `events` | Things that happened. Default write target; the librarian's raw material |
| 2 | `entities` | People / places / things, with tiered chunks and per-kind templates |
| 3 | `knowledge` | Big reference data, sub-chunked |
| 4 | `goals` | Goals + subtasks + progress journal, woven into the graph |

The uniform unit everywhere is **chunks + metadata** (mechanical save-time
stamps: stats, temporal refs, noun candidates, provenance). **Edges** connect
the graph: `mentions` (this memory talks about that entity), `derived_from`
(this chunk was distilled from that one — provenance for every promotion and
atomization), and structural edges.

Recall is a **priced graph walk** (Dijkstra with a budget, depth capped at 2):
important memories cost *less* budget to reach, so the walk spends itself on
what matters and runs dry on noise. Importance comes from librarian ratings
and favorites, and **decays nightly**. Notably, Sapphire records
`recall_count` / `last_recalled` but deliberately does **not** use them for
ranking — instrumentation, not pricing.

The **Librarian** (groundskeeper) runs five passes — dates, link, dedup, sort,
self — with verbs `mark_processed`, `atomize_memory`, `promote_memory` (copy
to the self layer or an entity card), and `prune_memory` (soft-retire,
reversible). Shield rules, enforced in code: favorites and core memories
(importance ≥ 0.9) refuse prune/atomize; a rating can never lower a core pin;
nothing hard-deletes. A **nightly round** runs the decay tick first (day
guarded), then the armed passes, scope by scope.

Sapphire has **no dream journal**. Its closest concept is the `self` layer
itself — "who she is" as a first-class layer with a dedicated `read_self`
path — plus `derived_from` provenance for anything distilled.

## The mapping to COGNOS (v46)

| Sapphire | COGNOS before | COGNOS after the transplant |
|---|---|---|
| `self` layer | added in v41 for dreams | unchanged; dreams now write `memory_type: "self"` too (the type follows the rail) |
| `events` | `episodic` / `working` | **`events`** — both retired values map here; `working` ceases to exist (chat history covers it) |
| `knowledge` | `semantic` | **`knowledge`** — same concept, renamed |
| `entities` | knowledge-graph work (phase 23) + relationships table | **first-class layer** on the rail |
| `goals` | separate autonomy goals tables | **first-class layer** on the rail |
| `mentions` / `derived_from` / structural edges | nothing | **`memory_edges` table**; idempotent links, traversed by the walk |
| priced recall walk | semantic → LLM ranker → importance fallback | **the walk fronts the chain** (see below) |
| librarian passes | `promote.js` (working note → memory) | **nightly librarian**: decay first, then dates/link/dedup/sort/self, rides the heartbeat |
| nightly decay | nothing for memories | **volatility-aware decay**, day-guarded, announced once |
| recall instrumentation | nothing | **`recall_count` / `last_recalled`**, never used for ranking |

Old layer values still map at every boundary (`normalizeMemoryLayer`):
`working` → `events`, `episodic` → `events`, `semantic` → `knowledge`,
`self` → `self`. No data migration was needed — the table was wiped and the
rail starts clean.

## Adopted in v41

1. **The `self` layer** (`server/memory/structure.js`). Dreams are the
   assistant's own inner life — Sapphire files exactly that kind of material
   on its `self` layer, and COGNOS had nowhere for it to live.
2. **Provenance on distillation** (`distillDream`). Sapphire's `derived_from`
   edge, stored inline: each dream's `memory_value` carries
   `distilled_from` (the source fragment ids) and `fragment_count`.
3. **Dream recognition at recall**: admitted dream rows are partitioned
   newest-first, capped at 5, and rendered as a framed **YOUR DREAMS**
   section inside the existing memory token budget.

## Adopted in v46 — the full transplant

### 1. The five-layer rail (`server/memory/structure.js`)

`MEMORY_LAYERS = [self, events, entities, knowledge, goals]`,
`MEMORY_SCHEMA_VERSION = 2`, default write target `events`. `working` is
gone as a layer — short-lived context is what chat history is for, and the
librarian's raw material lands on `events`. The extraction prompt teaches
the new rail plus **stable keys for transient state**: facts about the same
subject (e.g. `user.state.activity`) must reuse one key so a newer state
supersedes the older one.

### 2. Edges + priced recall (`server/memory/edges.js`, `server/memory/recall.js`)

`memory_edges` (from/to memory ids, `mentions` / `derived_from` /
`structural`, metadata, `created_by`; unique index; no self-loops).
**The walk fronts the existing chain rather than replacing it** — and
deliberately so: the semantic → LLM-ranker → importance-fallback chain is
tested, bounded, and provider-independent, and seeds have to come from
somewhere. The walk's job is *grounding*: seeds cost 0, every hop prices
**importance (discount), age (cost), and volatility × staleness (steep
cost)** within a budget of 20, depth ≤ 2. Jeremy's diagnostic is wired in as
first-class pricing, not tiebreakers — a stale-but-important transient state
can never outrank a fresh one on importance alone.

**Contradiction handling** runs after the walk: same-`memory_key`
high-volatility `events` claims collapse to the freshest (`last_confirmed`
beats `created_date`); losers are **excluded, not demoted**. The librarian's
dedup pass retires superseded transient states nightly
(`retired_reason: "superseded_transient_state"`), so the roll-of-the-dice
symptom is tended both at recall time and overnight.

### 3. The librarian (`server/memory/librarian.js`)

Day-guarded, rides the heartbeat after the cleanup audit (never kills the
beat — every pass is individually guarded and journaled to
`librarian_runs`). Decay first, then the five passes: **dates** (stamp
temporal refs), **link** (derived_from from inline provenance, mentions from
token overlap — junk stays unlinked), **dedup** (exact duplicates collapse,
superseded transients retire), **sort** (durable important events promote to
knowledge as a *copy*; tiny stale fragments prune; rerate only ever raises,
never above 8), **self** (guarantees `self.sheet`).

Verbs: `mark_processed`, `atomize` (splits with derived_from edges, original
parked — reversible), `promote` (copy to a target layer, never a move),
`prune` (soft-retire with `retired_reason`, reversible via `reviveMemory`).
Shield rules in code: favorites and core (importance ≥ 9) refuse
prune/atomize; the librarian never lowers importance at all; nothing
hard-deletes. Jeremy can favorite memories from the Memory tab (star toggle);
favorites are shielded from pruning and from decay.

### 4. Nightly importance decay (announced)

Volatility-aware: high-volatility transient states fade with a **12-hour
half-life** ("about to take a nap" fades in hours-to-a-day), medium 7 days,
low 60 days. Favorites and core rows never decay; importance floors at 1.
Because this changes recall behavior, the first night it moves a row Jeremy
gets a plain-language notice: *"memories now gently fade with time unless
they're favorites or pinned"* — fired exactly once
(`memory_decay_live`, guarded by `decay_announced`).

### 5. Recall instrumentation (`recall_count` / `last_recalled`)

Recorded on every recall path (chat orchestration and the memorySearch
skill) — and **never read by any pricing or ranking function**. The update is
best-effort and never fails the turn. Sapphire's restraint, enforced in
code and pinned by test.

### 6. The wipe (Jeremy-approved)

A pure-SQL migration cannot write a backup file — the hosted database
(Supabase) has no server filesystem. So the wipe is **in-app boot code**
(`server/memory/transplant.js`), guarded by a `schema_markers` row so it
runs exactly once:

1. `SELECT * FROM memories` (all workspaces, all layers) → JSON at
   `<appDataDir>/backups/memories-pre-sapphire-<YYYY-MM-DD>.json`
   (`<appDataDir>` = `COGNOS_DATA_DIR` on the APK's internal storage).
2. Verify by re-parsing the file (marker + row count must round-trip).
3. **Only then**: wipe `memories` (and `memory_edges`). Dreams go with it —
   they're memory rows. Conversations/messages are a separate store and
   stay; the ledger/beliefs are append-only audit and stay.
4. Apply the new schema (edges table, tending state, instrumentation
   columns — idempotent, the lazy boot migration applies it too).
5. Set the marker; surface a warm notice naming the exact backup path.

**Fail closed**: no backup dir, a failed write, or a failed verify → nothing
is wiped, no marker is set, it logs loudly and retries next boot. Boot
never throws because of the transplant — a failure leaves the old data
intact and the app running.

## The dream-distills-dreams decision

Stands from v41: a dream distilling a dream is second-order inference
compounding on `evidence_level: "inferred"` — the telephone game. Continuity
comes from *reading* past dreams at recall time (the YOUR DREAMS section,
newest first), not re-distilling them at write time. One-line change if
Jeremy ever wants dream-chains.

## Tests

- `test/memory-transplant.mjs` (38 tests, PGlite-backed): rail
  normalization and retired-layer mapping; edges CRUD (idempotent relink,
  both-direction reads, type/self-loop validation); priced-recall behavior —
  importance pricing, temporal grounding, volatility pricing (stale
  importance-8 vs fresh importance-4), depth cap, budget exhaustion,
  degradation to seeds; **Jeremy's symptom modeled exactly** ("just got
  home from work" older vs "about to take a nap" newer → only the fresh one
  admitted, the stale one excluded); supersede scoping (keys, volatility,
  `last_confirmed`); instrumentation-never-ranks; librarian verbs and
  shield rules; decay rates, shield, floor, day-guard, and the one-time
  announcement; a full librarian night (five passes, journal, day-guard);
  the nightly superseded-transient retirement; backup/verify/exactly-once/
  fail-closed transplant behavior (unwritable dir, missing dir) with
  conversations/messages untouched.
- Updated: `test/phase22.mjs` (rail mapping, v2 schema, events default),
  `test/phase31.mjs` + `test/dream-recognition.mjs` (dream type follows the
  rail), `test/cleanup.mjs` (rail layers in fixtures).
