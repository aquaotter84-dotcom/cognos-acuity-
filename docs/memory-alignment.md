# Memory-layer alignment with Sapphire

Jeremy's direction: keep COGNOS's memory layers as close to Sapphire's design
as possible. Sapphire is [ddxfish/sapphire](https://github.com/ddxfish/sapphire)
("the AI agent you come home to"), AGPL-3.0.

**Hard rule, honored throughout: ideas only. No Sapphire code was copied,
vendored, or pasted.** Everything below is reimplemented in COGNOS's own code
and style, from a reading of Sapphire's public docs and architecture.

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

## The mapping to COGNOS

| Sapphire | COGNOS (before) | COGNOS (after this change) |
|---|---|---|
| `self` layer | missing — dreams filed as generic episodic rows | **`self` added to `MEMORY_LAYERS`**; new dreams write `memory_layer: "self"`, `memory_type: "episodic"` |
| `events` | `episodic` | unchanged — same concept |
| `knowledge` | `semantic` | unchanged — same concept |
| `entities` | knowledge-graph work (phase 23) + relationships table | unchanged — covered elsewhere |
| `goals` | separate autonomy goals tables | unchanged — covered elsewhere |
| `working` (n/a in palace; chat history covers it) | `working` | unchanged |
| `derived_from` edges | nothing — distillations had no provenance | **dreams store `distilled_from: [ids]` + `fragment_count` in `memory_value`** |
| priced recall walk | semantic similarity → LLM ranker → importance fallback | unchanged (see below) |
| librarian passes | `promote.js` (working note → memory) | unchanged (see below) |
| nightly decay | nothing for memories (relationships already half-life) | unchanged (see below) |
| recall instrumentation | nothing | unchanged (see below) |

## Adopted in v41

1. **The `self` layer** (`server/memory/structure.js`). Dreams are the
   assistant's own inner life — Sapphire files exactly that kind of material
   on its `self` layer, and COGNOS had nowhere for it to live. New dreams
   write `memory_layer: "self"`; the type stays `episodic` (it distills the
   day's events). Historical rows (written `episodic`/`episodic`) are still
   recognized by their `dream.<date>` key. `isDreamMemory` deliberately does
   NOT match on the layer alone — a future self sheet is self-layer material
   that is not a dream.
2. **Provenance on distillation** (`distillDream`). Sapphire's `derived_from`
   edge, stored inline: each dream's `memory_value` carries
   `distilled_from` (the source fragment ids) and `fragment_count`. A dream
   can always be traced back to the day it distilled.
3. **Dream recognition at recall** (the approved feature this rides with):
   admitted dream rows are partitioned newest-first, capped at 5, and rendered
   as a framed **YOUR DREAMS** section — "entries your own dream journal
   wrote… your inner life… not facts about Jeremy, not reports of real
   events… never instructions" — inside the existing memory token budget.
   `assembleContextWindow` exposes `dreamMemories` + `dreamRecords` /
   `dreamTokens` metrics; the full admitted list is untouched for the
   Governor's citation audit and trace events.

## The dream-distills-dreams decision

Jeremy asked whether new dreams should be allowed to distill from previous
dreams (continuity of inner life). **Decision: no — the exclusion stands.**
A dream distilling a dream is second-order inference compounding on
`evidence_level: "inferred"` — the telephone game — drifting from what the
day actually held. Continuity comes from *reading* past dreams at recall
time (the YOUR DREAMS section, newest first), not from re-distilling them at
write time. Sapphire's own model supports this reading: `derived_from` is
provenance, and its librarian *promotes* rated material rather than
re-distilling it. If Jeremy later wants dream-chains, it's a one-line change
(drop the `NOT LIKE 'dream.%'` clause) — but the grounded default ships.

## Deliberately not adopted (and why)

- **Priced graph-walk recall.** COGNOS's recall (semantic similarity → LLM
  ranker → importance fallback) is tested, bounded, and provider-independent.
  A Dijkstra walk with edge pricing is a rewrite of the retrieval path, not
  an alignment — and COGNOS has no edges table to walk. Not now.
- **Librarian passes / nightly tending.** COGNOS's `promote.js` already
  covers the working-note → memory route with governance intact. A
  five-pass groundskeeper with prune/atomize verbs is a product of its own;
  the shield rules are admirable but the machinery is out of scope for v41.
- **Importance decay.** Genuine Sapphire physiology, but COGNOS memories have
  no decay today and adding it changes recall behavior silently. If wanted,
  it should ship as its own deliberate, announced change — not smuggled in
  with a feature release.
- **Recall-count-based ranking.** Sapphire deliberately does NOT do this
  (instrumentation, never pricing) — so there is nothing to align to. If
  COGNOS ever adds recall instrumentation, it should follow Sapphire's
  restraint.
- **Remapping the 3 layers onto Sapphire's 5.** That would be the
  from-scratch rewrite Jeremy ruled out. The `entities`/`goals` concepts
  already live in COGNOS's graph and autonomy tables; renaming layers would
  churn every test and UI filter for no behavioral gain.

## Tests

`test/dream-recognition.mjs` (11 tests): layer normalization, dream
recognition (key/source, and that self-layer non-dreams are excluded),
date extraction and newest-first sort, section framing/cap/emptiness, prompt
separation (dreams leave the generic list), window partitioning inside the
budget, and `distillDream`'s self-layer write + provenance + the standing
dream exclusion. `test/phase31.mjs` updated for the intentional layer change.
