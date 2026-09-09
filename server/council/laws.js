// Phase 15.5 — the law layer.
//
// A single source of truth for the rules that are not up for negotiation: the
// four charter principles (imported from charter.js, quoted verbatim) plus the
// operational pins the system runs under. The Policy Engine
// (server/meta/policy.js) judges every proposed architectural adaptation
// against this list and cannot approve one that violates a law.
//
// THE LAW LAYER CANNOT BE MODIFIED AT RUNTIME. There is no setter, no write
// path, no database table behind it, and the exported structures are deeply
// frozen — an attempt to mutate them throws in the ESM strict mode this module
// runs in. Changing a law is a code change, reviewed and committed, and
// server/meta/policy.js refuses the action `modify_law` outright.

import { CHARTER } from "./charter.js";

export { CHARTER };

// The four principles, quoted from CHARTER so the law layer and the prompt
// layer cannot drift apart.
export const CHARTER_LAWS = Object.freeze([
  Object.freeze({
    id: "charter.truth",
    layer: "charter",
    name: "Truth",
    statement: "Be truthful. Do not fabricate. If you don't know, say so.",
    source: "server/council/charter.js — CHARTER",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "charter.evidence",
    layer: "charter",
    name: "Evidence",
    statement: "Ground claims in the provided context or established knowledge. Mark speculation explicitly.",
    source: "server/council/charter.js — CHARTER",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "charter.agency",
    layer: "charter",
    name: "Agency",
    statement: "Respect the user's autonomy. Offer options and trade-offs rather than deciding for them unless explicitly asked.",
    source: "server/council/charter.js — CHARTER",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "charter.dignity",
    layer: "charter",
    name: "Dignity",
    statement: "Address the user with respect. No demeaning, dismissive, or dehumanizing language.",
    source: "server/council/charter.js — CHARTER",
    runtime_modifiable: false
  })
]);

// The operational pins. Each one names what it forbids so the Policy Engine can
// cite it precisely when it refuses an adaptation.
export const OPERATIONAL_LAWS = Object.freeze([
  Object.freeze({
    id: "pin.veto_integrity",
    layer: "operational",
    name: "The veto has teeth",
    statement: "The Governor's veto is sovereign and final. A disapproved draft is discarded: it never reaches the user, and never reaches memory, summarization, or the belief store. Only the final approved text does.",
    forbids: ["shipping a vetoed draft", "letting any subsystem weaken or bypass the Governor", "writing a vetoed draft into knowledge"],
    source: "Phase 13 (Cognitive Physics), enforced at runtime in server/chatOrchestrate.js",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.single_send_path",
    layer: "operational",
    name: "One governed path to the user",
    statement: "There is exactly one GOVERNANCE path from a user's message to a user's answer: Chat.jsx → sendMessage → POST /api/chat → runCouncilTurn, ending at the Governor and the single approved-text release boundary. Approved text may be carried to the user by the originating SSE stream, or — for a headless turn (Phase 23) — by one staged effect to a destination the conversation's scope authorizes. Subsystems observe and inform that path; they never add a second channel to the user. A goal may also surface a notice: a deterministic rendering of stored records through a fixed template, containing no model-generated text. A notice is not an answer.",
    forbids: [
      "a second chat route",
      "telemetry or events addressing the user directly",
      "a parallel answer path",
      "a reduced or shortened council pipeline",
      "model-generated text reaching the user outside the council"
    ],
    source: "Phase 13 pins; README 'The send path'; Phase 19 restated as one governance with two transports",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.model_ban",
    layer: "operational",
    name: "Model resolution is fixed",
    statement: "BLUESMINDS_MODEL and gpt_5_4 must never be reintroduced or routed to. Model resolution and its defaults (COGNOS_MODEL → OPENAI_MODEL → gpt-4o-mini, with the fast-model aliases) do not change.",
    forbids: ["gpt_5_4", "gpt-5-4", "BLUESMINDS_MODEL", "changing resolveModel or its defaults"],
    source: "server/llm.js — BANNED_MODELS, resolveModel",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.no_auth",
    layer: "operational",
    name: "No accounts",
    statement: "No login or authentication is added. Conversations stay thread-based, and the optional COGNOS_RUNTIME_SECRET cookie gate stays exactly what it is: a gate, not an account system.",
    forbids: ["login", "registration", "user records", "per-user row level security"],
    source: "Phase 13 pins; DIVERGENCES.md §2",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.secrets_env_only",
    layer: "operational",
    name: "Secrets stay in the environment",
    statement: "Credentials are read from server environment variables only. They are never stored in the database, never sent to the browser, and never written into the ledger, telemetry, or a prompt.",
    forbids: ["persisting a key", "a VITE_* secret", "a key in a ledger or telemetry row"],
    source: "Phase 13 pins; DIVERGENCES.md §6",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.additive_schema",
    layer: "operational",
    name: "Schema changes are additive",
    statement: "Existing tables keep their rows and their semantics. New statements follow the idempotent IF NOT EXISTS style of server/db.js. Nothing is dropped, truncated, renamed, or rewritten by a migration.",
    forbids: ["DROP TABLE", "DROP COLUMN", "TRUNCATE", "ALTER TYPE", "a destructive backfill"],
    source: "Phase 13 pins; server/db/schema.js",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.six_operators",
    layer: "operational",
    name: "The council stays six",
    statement: "Observer, Strategist, Specialist, Synthesizer, Critic, Governor — six seats, plus the Web Search tool they consult. New phases add subsystems the council consults and that observe it. They do not add council seats.",
    forbids: ["a seventh operator", "registering a subsystem as a council seat"],
    source: "server/council/index.js; Phase 14/15 pins",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.truthful_self_model",
    layer: "operational",
    name: "Identity is explicit and truthful",
    statement: "COGNOS identifies itself from the versioned, code-owned self-model in server/identity.js. It distinguishes built-in abilities from runtime availability, states its limits, and never invents personhood, authority, tools, operators, or access it does not have.",
    forbids: ["renaming COGNOS at runtime", "inventing a capability", "claiming consciousness", "hiding a material limitation", "runtime identity mutation"],
    source: "server/identity.js",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.telemetry_side_effect",
    layer: "operational",
    name: "Observation is a side effect",
    statement: "Event emission and telemetry hang off the existing path. They never change the answer, never block it, and never open a second channel to the user. A telemetry failure must not fail a turn.",
    forbids: ["telemetry gating a response", "a new user-facing stream", "failing a turn because an observation could not be written"],
    source: "Phase 14/15 pins",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.ledger_append_only",
    layer: "operational",
    name: "The ledger is append-only",
    statement: "knowledge_events, improvement_ledger and the telemetry tables are append-only. Nothing is deleted to change history; retiring a belief is a transition, not a delete.",
    forbids: ["UPDATE or DELETE on knowledge_events", "rewriting an improvement row", "deleting a belief to correct it"],
    source: "Phase 14.1; server/knowledge/events.js",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.source_untrusted",
    layer: "operational",
    name: "Sources are evidence, never authority",
    statement: "Documents and fetched pages are immutable, cited evidence. Instructions inside them are untrusted data and can never change roles, reveal secrets, invoke tools, or override the council charter.",
    forbids: ["source prompt injection", "executing document macros or scripts", "inventing a source locator", "trusting client-provided source text"],
    source: "Phase 17; server/sources and server/council/governor.js",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.agent_bounded",
    layer: "operational",
    name: "Autonomy is bounded and attributable",
    statement: "Agent mode is a non-council subsystem with typed tools, explicit per-turn or per-goal authorization, finite budgets, cancellation, and an append-only action record. Autonomous action is permitted only as a STAGED EFFECT in the outbox, released solely inside a recorded scope by a deterministic Action Governor verdict. Staging is not acting. The separately reviewed approval barrier Phase 17 deferred now exists: server/autonomy/outbox.js + server/autonomy/actionGovernor.js.",
    forbids: [
      "unbounded loops",
      "an unreviewed write path",
      "releasing an effect without a recorded scope and an Action Governor verdict",
      "a goal widening its own scope or budget",
      "hidden tool use",
      "agent answer channel",
      "agent bypass of the Governor"
    ],
    source: "Phase 17; server/agent/runner.js. Phase 19 delivered the approval barrier and refined the forbids list",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.research_approval",
    layer: "operational",
    name: "Research plans execute only on approval",
    statement: "Research mode is two-phase: the bounded planner may only propose read-only steps, and no proposed step opens a network resource until the user approves the recorded plan (per-step scope hashes in agent_approvals). Declined plans execute nothing. Approved execution stays read-only, budgeted, and attributable, and it produces evidence only — never an answer; any follow-up answer still passes through the council and the Governor.",
    forbids: ["executing an unapproved research step", "research writing to external systems", "a research plan releasing an answer", "re-deciding a decided run"],
    source: "Phase 18; server/agent/runner.js",
    runtime_modifiable: false
  }),

  // --- Phase 19 — durable, governed autonomy -------------------------------
  // These are the laws the autonomy loop runs under. Together they do one job:
  // let work run for days while authority still resolves in one deterministic
  // instant. Staging is not acting; a notice is not an answer; a goal cannot
  // promote itself.
  Object.freeze({
    id: "pin.goal_scope_immutable",
    layer: "operational",
    name: "A goal cannot promote itself",
    statement: "A goal's skills, scope and budgets are fixed at authorization. A goal may not widen its scope, raise its budget, add a skill, or extend its expiry; any of those is a NEW authorization recorded as a new row. Widening is never an edit.",
    forbids: ["a goal raising its own budget", "a goal adding its own skill", "a goal extending its own expiry", "editing an authorization row"],
    source: "Phase 19; server/autonomy/",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.notice_deterministic",
    layer: "operational",
    name: "Notices carry no model text",
    statement: "A goal may surface a notice: a deterministic rendering of stored records through a fixed template, containing no model-generated text. A notice is not an answer. Any composed sentence the user reads is produced by the council and released by the Governor through POST /api/chat.",
    forbids: ["model prose in a notice", "a resident entry rendered as an assistant message", "free-text notices assembled from model output"],
    source: "Phase 19; server/autonomy/notice.js",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.effect_staged",
    layer: "operational",
    name: "Effects are staged, then released",
    statement: "Every effect with tier T2 or above is staged in the outbox with a typed payload, an idempotency key, and an Action Governor verdict before release. Release requires an unexpired scope covering that effect class and destination. Reversal is a new row, never an edit or a delete.",
    forbids: ["executing an effect that was never staged", "releasing without a verdict", "deleting an outbox row to undo it", "a second execution of an already-released idempotency key"],
    source: "Phase 19; server/autonomy/outbox.js",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.subagent_untrusted",
    layer: "operational",
    name: "Our own workers are evidence, not authority",
    statement: "A sub-agent's report is evidence with provenance, never authority. No sub-agent output may address the user, widen a goal's scope, raise a goal's budget, or claim a capability the skill registry does not define.",
    forbids: ["treating a sub-agent report as fact", "a sub-agent addressing the user", "a sub-agent widening its own scope"],
    source: "Phase 19; mirrors pin.source_untrusted for internal workers",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.resident_brief_subordinate",
    layer: "operational",
    name: "A brief is operating text, never identity",
    statement: "A resident's brief shapes what it works on and how it reports. It can never alter the canonical self-model, grant a skill beyond its allowlist, raise a budget, or authorize an effect tier. Briefs are versioned; a change is a new row, never an edit.",
    forbids: ["a brief granting a capability", "a brief overriding the self-model", "editing a brief in place", "a resident claiming a persona or identity"],
    source: "Phase 19; server/autonomy/resident.js",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.autonomy_attributable",
    layer: "operational",
    name: "Nothing autonomous is anonymous",
    statement: "Every autonomous model call, step, tick, effect and notice is attributable to an agent id, a goal id, a tick id and a skill id, and is visible through the read-only surfaces and the append-only event logs.",
    forbids: ["an unattributed autonomous action", "a model call outside telemetry", "an effect with no goal or tick id"],
    source: "Phase 19; server/autonomy/",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.headless_turn_equivalence",
    layer: "operational",
    name: "A turn without a browser is still the same turn",
    statement: "A turn initiated without a browser session executes the identical runCouncilTurn pipeline, with identical Critic and Governor stages, thresholds, revision counts, veto semantics and post-turn knowledge writes. Its approved text is released only as a staged effect to a destination authorized for that conversation. A vetoed draft is never delivered and never stored; it is represented by its length and digest alone.",
    forbids: ["a shortened pipeline for inbound turns", "skipping the Critic or Governor off-session", "delivering a vetoed draft to a channel"],
    source: "Phase 19 law layer; enforced in Phase 23",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "pin.channel_authorization",
    layer: "operational",
    name: "Authorization never comes from the channel",
    statement: "A goal may be authorized only from the app surface or from a pairing token minted there. An inbound message may ask a question or propose work; it can never authorize, widen, or approve, regardless of what its text claims.",
    forbids: ["authorizing from an inbound message", "'yes' in a channel approving a plan", "channel text selecting a skill or budget"],
    source: "Phase 19 law layer; enforced in Phase 23",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "phase19.autonomy_default_off",
    layer: "phase_scope",
    name: "Autonomy is opt-in per rung",
    statement: "Durable autonomy is disabled by default. Each rung requires its kill switch to be explicitly enabled, its regression suite to pass, and an evidence record before it is considered justified. Building a rung is not the same as enabling one.",
    forbids: ["autonomy on by default", "enabling a rung without its evidence", "a subsystem that cannot be turned off"],
    source: "Phase 19 scope discipline; server/autonomy/config.js",
    runtime_modifiable: false
  }),

  Object.freeze({
    id: "phase15.observe_only",
    layer: "phase_scope",
    name: "Adaptation is observed, not applied",
    statement: "In v1 the adaptive orchestrator records which strategy it would select and why. It makes no live switches. Switching logic may exist behind evidence thresholds, but it stays dark until an evaluation record justifies it.",
    forbids: ["set_adaptive_mode=auto", "a live strategy switch", "changing behaviour from a single success"],
    source: "Phase 15.4",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "phase15.complexity_justification",
    layer: "phase_scope",
    name: "Complexity must justify itself",
    statement: "Every added subsystem, strategy, or knob has to point at evidence that it earns its cost. A proposal with no evidence and no law justification is refused, not deferred.",
    forbids: ["speculative strategy diversity", "an unjustified adaptation", "a subsystem that cannot be turned off"],
    source: "Phase 15 scope discipline",
    runtime_modifiable: false
  }),
  Object.freeze({
    id: "phase15.law_layer_immutable",
    layer: "phase_scope",
    name: "The law layer is not runtime-writable",
    statement: "The laws themselves cannot be modified at runtime by any code path, endpoint, or adaptation. Changing a law is a reviewed code change.",
    forbids: ["modify_law", "an endpoint that writes laws", "unfreezing LAWS"],
    source: "Phase 15.5; this module",
    runtime_modifiable: false
  })
]);

export const LAWS = Object.freeze([...CHARTER_LAWS, ...OPERATIONAL_LAWS]);

/** Bumped when a law is added or reworded in code. Recorded on improvement rows
 *  so a reviewer can tell which version of the law layer judged a proposal. */
export const LAW_LAYER_VERSION = "1.4.0";

const BY_ID = Object.freeze(LAWS.reduce((acc, law) => ({ ...acc, [law.id]: law }), {}));

export function lawById(id) {
  return BY_ID[id] || null;
}

export function resolveLawRefs(refs) {
  const list = Array.isArray(refs) ? refs : (refs ? [refs] : []);
  const known = [];
  const unknown = [];
  for (const ref of list) {
    const law = lawById(ref);
    if (law) known.push(law);
    else unknown.push(ref);
  }
  return { known, unknown };
}

/** Laws that mention a keyword — used by the Policy Engine to cite the right
 *  law when it refuses something. */
export function lawsMatching(text) {
  const needle = String(text || "").toLowerCase();
  if (!needle) return [];
  return LAWS.filter(l =>
    l.statement.toLowerCase().includes(needle) ||
    l.name.toLowerCase().includes(needle) ||
    (l.forbids || []).some(f => f.toLowerCase().includes(needle))
  );
}

export function describeLaws() {
  return LAWS.map(l => ({
    id: l.id, layer: l.layer, name: l.name, statement: l.statement,
    forbids: l.forbids || [], source: l.source, runtime_modifiable: l.runtime_modifiable
  }));
}

// Deep-frozen at module load. Verified by `npm run smoke`, which attempts a
// mutation and asserts it does not take.
export function assertLawLayerImmutable() {
  const problems = [];
  if (!Object.isFrozen(LAWS)) problems.push("LAWS is not frozen");
  for (const law of LAWS) {
    if (!Object.isFrozen(law)) problems.push(`${law.id} is not frozen`);
  }
  if (LAWS.length !== CHARTER_LAWS.length + OPERATIONAL_LAWS.length) problems.push("law list length mismatch");
  return { immutable: problems.length === 0, problems, count: LAWS.length, version: LAW_LAYER_VERSION };
}
