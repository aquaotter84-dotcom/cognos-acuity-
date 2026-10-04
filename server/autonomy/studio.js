// Phase 34 — the Studio: Orbit-shaped surfaces over the autonomy engine.
//
// Three things live here:
//
//   1. buildFeed — ONE unified activity feed: goal events + outbox events +
//      notices, merged by time, each row rendered as a plain-language line.
//      (Three APIs today; the studio shows one running story.)
//   2. matchPreferenceIntent — the deterministic intent layer behind
//      "preferences become conversations". The resident chat applies a clear
//      preference or lifecycle request itself, through the SAME engine
//      functions the settings routes call. The model never flips anything.
//   3. residentChatTurn — one conversational turn over a resident's state:
//      brief, goals, notes digest, findings, preferences, governance.
//
// Governance keeps full authority: this module is a window into the loop,
// not a second loop. Every write below goes through the existing engine
// functions (updatePersonalitySettings, setOutboxMode, goal status changes)
// with the same guards, refusals, and ledger rows. Nothing here loosens the
// actionGovernor, the evidence gate, or approval requirements.

import { callLLM } from "../llm.js";
import { publicNotice } from "./notice.js";
import { getPersonalitySettings, updatePersonalitySettings } from "./personality.js";
import { setOutboxMode } from "./liveOutbox.js";
import { autonomyConfig } from "./config.js";
import { invokeTool } from "./residentTools.js";
import { scopeHashes } from "./authorize.js";

const clean = (v, max = 400) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const parseJson = (v, fallback) => {
  try { return typeof v === "string" ? JSON.parse(v) : (v ?? fallback); }
  catch { return fallback; }
};

// ---------------------------------------------------------------------------
// 1. The unified feed
// ---------------------------------------------------------------------------

/** goal_events -> a plain-language line. Unknown types fall back honestly. */
export function describeGoalEvent(eventType, detail = {}, goalTitle = "a goal") {
  const title = `“${goalTitle}”`;
  const d = detail && typeof detail === "object" ? detail : {};
  switch (eventType) {
    case "goal_created": return `${title} was created and is waiting for your authorization.`;
    case "goal_authorized": return `${title} was authorized — it started working.`;
    case "goal_completed": return `${title} finished.`;
    case "goal_parked": return `${title} paused${d.reason ? `: ${clean(d.reason, 120)}` : " with a recorded reason"}.`;
    case "goal_paused": return `${title} was paused. It will not wake until you resume it.`;
    case "goal_resumed": return `${title} is running again.`;
    case "goal_cancelled": return `${title} was cancelled. It will not wake again.`;
    case "goal_declined": return `${title} was declined and will not run.`;
    case "step_completed": return `${d.skill_id ? `${d.skill_id} finished` : "A step finished"} for ${title}.`;
    case "step_failed": return `A step failed for ${title}${d.error ? `: ${clean(d.error, 140)}` : "."}`;
    case "step_refused": return `The governor refused a step for ${title}${d.rule ? ` (${d.rule})` : ""} — nothing happened.`;
    case "subagent_started": return `A worker started on ${title}.`;
    case "promotion_decided":
      return d.decision === "approve"
        ? `A finding from ${title} was saved as knowledge.`
        : `A finding from ${title} was left out of knowledge.`;
    default: {
      const step = eventType.replace(/^goal_/, "").replace(/_/g, " ");
      return `${title}: ${step}${d.reason ? ` — ${clean(d.reason, 120)}` : ""}.`;
    }
  }
}

/** outbox_events -> a plain-language line. from/to are effect statuses. */
export function describeOutboxEvent(fromStatus, toStatus, { skillId = null, effectType = null } = {}) {
  const what = [skillId, effectType].filter(Boolean).join(" · ") || "An action";
  switch (toStatus) {
    case "staged": return `${what} was staged and is waiting for your approval.`;
    case "approved": return `${what} was approved.`;
    case "released": return `${what} was released.`;
    case "would_release": return `${what} would have released in a practice run — nothing really happened.`;
    case "refused": return `${what} was refused — nothing happened.`;
    case "reverted": return `${what} was reversed and the reversal recorded.`;
    case "failed": return `${what} failed to deliver.`;
    default: return `${what} moved from ${fromStatus || "—"} to ${toStatus || "—"}.`;
  }
}

/**
 * One running story: the newest rows across goal events, outbox events, and
 * notices, merged by time. Each item: { id, kind, atMs, text, goalId, agentId,
 * outboxId, severity }. Read-only — no writes, no side effects.
 */
export async function buildFeed(db, workspaceId, { limit = 50 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const per = Math.max(10, Math.ceil(safeLimit / 2));

  const [goalEvents, outboxEvents, notices] = await Promise.all([
    db.query(
      `SELECT ge.*, g.title AS goal_title
       FROM goal_events ge
       JOIN autonomy_goals g ON g.id = ge.goal_id
       WHERE g.workspace_id = $1
       ORDER BY ge.ts_ms DESC LIMIT $2`,
      [workspaceId, per]
    ),
    db.query(
      `SELECT oe.*, o.skill_id, o.effect_type, o.goal_id, o.tier
       FROM outbox_events oe
       JOIN autonomy_outbox o ON o.id = oe.outbox_id
       WHERE o.workspace_id = $1
       ORDER BY oe.ts_ms DESC LIMIT $2`,
      [workspaceId, per]
    ),
    db.query(
      `SELECT * FROM autonomy_notices
       WHERE workspace_id = $1
       ORDER BY created_ms DESC LIMIT $2`,
      [workspaceId, per]
    ),
  ]);

  const items = [];
  for (const e of goalEvents || []) {
    items.push({
      id: `goal:${e.id}`,
      kind: "goal_event",
      atMs: Number(e.ts_ms) || null,
      text: describeGoalEvent(e.event_type, parseJson(e.detail, {}), e.goal_title || "a goal"),
      goalId: e.goal_id || null,
      agentId: e.agent_id || null,
      outboxId: null,
      severity: /failed|refused|declined|cancelled/.test(e.event_type || "") ? "warning" : "info",
    });
  }
  for (const e of outboxEvents || []) {
    items.push({
      id: `outbox:${e.id}`,
      kind: "outbox_event",
      atMs: Number(e.ts_ms) || null,
      text: describeOutboxEvent(e.from_status, e.to_status, {
        skillId: e.skill_id, effectType: e.effect_type,
      }),
      goalId: e.goal_id || null,
      agentId: null,
      outboxId: e.outbox_id || null,
      severity: e.to_status === "failed" || e.to_status === "refused" ? "warning" : "info",
    });
  }
  for (const n of notices || []) {
    const pub = publicNotice(n);
    items.push({
      id: `notice:${n.id}`,
      kind: "notice",
      atMs: Number(n.created_ms) || null,
      text: pub.text || pub.templateId || "A notice arrived.",
      goalId: pub.goalId || null,
      agentId: pub.agentId || null,
      outboxId: null,
      severity: pub.severity || "info",
      acked: n.acked_ms != null,
    });
  }

  items.sort((a, b) => (b.atMs || 0) - (a.atMs || 0));
  return items.slice(0, safeLimit);
}

// ---------------------------------------------------------------------------
// 2. Preference intents — "preferences become conversations"
//
// The matcher is deterministic and conservative: it fires only on clear,
// unambiguous phrasing. Anything fuzzy falls through to the model, which
// converses and offers the concrete options. The model NEVER applies these;
// the route applies them through the same engine functions the settings
// routes call, so guards and refusals behave identically.
// ---------------------------------------------------------------------------

const NEG = /(don't|do not|doesn't|stop|no more|turn off|switch off|disable|skip|quit|never|silence|mute|shut off|cut|close|\boff\b)/;
const POS = /(start|again|back on|resume|turn on|switch on|enable|bring back|keep|unmute)/;

/**
 * Match one clear preference/lifecycle intent in a user message.
 * Returns { type, ... } or null. `hasGoal` gates goal-lifecycle intents.
 */
export function matchPreferenceIntent(text, { hasGoal = false } = {}) {
  const t = ` ${String(text || "").toLowerCase()} `;
  if (t.trim().length < 3) return null;

  // --- heartbeat personality preferences -----------------------------------
  const pref = (key, words) => {
    if (!words.test(t)) return null;
    if (NEG.test(t)) return { type: "preference", key, value: false };
    if (POS.test(t)) return { type: "preference", key, value: true };
    return null;
  };
  const greeting = pref("greeting", /\bgreet|good morning|\bmorning\b/);
  if (greeting) return greeting;
  const dream = pref("dream", /\bdream/);
  if (dream) return dream;
  const checkin = pref("checkin", /check[\s-]?in/);
  if (checkin) return checkin;

  // --- outbox mode: "how you talk to it" ------------------------------------
  // "practice in the background, don't touch anything yet" = shadow;
  // "rehearse it, show me the plan" = dry_run;
  // "show me before you act" / "go live" = live.
  if (/\bshadow\b|practice in the background|don't touch anything|touch nothing|practice first/.test(t)) {
    return { type: "outboxMode", mode: "shadow" };
  }
  if (/dry[\s-]?run|rehearse|show me the plan|plan it out/.test(t)) {
    return { type: "outboxMode", mode: "dry_run" };
  }
  if (/\bgo live\b|show me before you act|act for real|for real|actually do it/.test(t)) {
    return { type: "outboxMode", mode: "live" };
  }

  // --- goal lifecycle (only when the chat is scoped to a goal) ----------------
  if (hasGoal) {
    if (/(go ahead|you'?re good|start (it|this|working)|authorize|you have my (approval|ok|go)|don'?t need to ask)/.test(t)) {
      return { type: "goalDecision", decision: "authorize" };
    }
    if (/\bpause\b|hold on|take a break|stop for now/.test(t)) {
      return { type: "goalDecision", decision: "pause" };
    }
    if (/\bresume\b|carry on|keep going|start again|unpause/.test(t)) {
      return { type: "goalDecision", decision: "resume" };
    }
    if (/\bcancel\b|kill it|shut it down|end (it|this)|stop this goal/.test(t)) {
      return { type: "goalDecision", decision: "cancel" };
    }
  }

  return null;
}

const PREF_SENTENCES = {
  greeting: {
    true: "Good — I'll say good morning again.",
    false: "Done — no more morning greetings. If you miss them, just say “say good morning again”.",
  },
  dream: {
    true: "Dreams are back on — I'll keep writing them.",
    false: "The dream journal is closed. Say “start the dreams again” any morning you want it back.",
  },
  checkin: {
    true: "Check-ins are back on.",
    false: "Check-ins are off. I'll stay quiet unless something actually needs you.",
  },
};

const OUTBOX_MODE_SENTENCES = {
  shadow: "Practicing in the background from here on — nothing will touch the world until you say otherwise.",
  dry_run: "Rehearsal mode — I'll plan each action out and show you the plan, but run nothing.",
  live: "Live mode — every action still waits for your own approval, one at a time.",
};

/**
 * Apply a matched intent through the engine. Returns { applied, reply }.
 * A refusal from the engine (e.g. live not yet earned) surfaces as the
 * engine's own plain-language message — never bypassed, never reworded
 * into a yes.
 */
export async function applyIntent(db, intent, { workspaceId, goalId = null, updatedBy = "resident-chat" } = {}) {
  if (intent.type === "preference") {
    const settings = await updatePersonalitySettings(db, workspaceId, { [intent.key]: intent.value });
    const confirmed = settings[intent.key] === intent.value;
    return {
      applied: confirmed,
      reply: confirmed
        ? PREF_SENTENCES[intent.key][String(intent.value)]
        : "I tried to change that and it didn't take — nothing changed.",
    };
  }

  if (intent.type === "outboxMode") {
    const outcome = await setOutboxMode({
      db, outboxMode: intent.mode, updatedBy, config: autonomyConfig(),
    });
    if (!outcome.ok) {
      return { applied: false, reply: outcome.refusal?.message || "That change was refused — nothing changed." };
    }
    return {
      applied: outcome.changed !== false,
      reply: outcome.changed === false
        ? `Already in ${intent.mode === "shadow" ? "practice" : intent.mode === "dry_run" ? "rehearsal" : "live"} mode — nothing to change.`
        : OUTBOX_MODE_SENTENCES[intent.mode],
    };
  }

  if (intent.type === "goalDecision" && goalId) {
    const goal = await db.AutonomyGoal.get(goalId);
    if (!goal || goal.workspace_id !== workspaceId) {
      return { applied: false, reply: "I couldn't find that goal — nothing changed." };
    }
    const decision = intent.decision;
    if (decision === "authorize") {
      if (goal.status !== "awaiting_authorization") {
        return { applied: false, reply: `That goal is ${goal.status.replace(/_/g, " ")} — there's nothing waiting for authorization.` };
      }
      const budget = parseJson(goal.budget, {});
      const scope = parseJson(goal.scope, {});
      const hashes = scopeHashes({ goalId: goal.id, scope, budget });
      await db.GoalAuthorization.append({
        goal_id: goal.id,
        scope_sha256: hashes.scopeSha256,
        budget_sha256: hashes.budgetSha256,
        decision: "authorize",
        reason: "authorized in conversation",
        decided_ms: Date.now(),
        expires_at_ms: null,
        decision_source: "app",
      });
      await db.AutonomyGoal.setStatus(goal.id, { status: "active", parkReason: null, startedMs: Date.now() });
      await db.AutonomyGoal.nextRunAt(goal.id, Date.now());
      await db.GoalEvent.append({
        goal_id: goal.id, event_type: "goal_authorized",
        from_status: "awaiting_authorization", to_status: "active",
        detail: { reason: "authorized in conversation", ...hashes },
      });
      return { applied: true, reply: "Done — that goal is authorized and will pick up its next slice. Its scope and budget are recorded, same as the consent click." };
    }
    const next = decision === "pause" ? "parked" : decision === "resume" ? "active" : "cancelled";
    if (next === "active") {
      const auth = await db.GoalAuthorization.current(goal.id, Date.now());
      if (!auth) {
        return { applied: false, reply: "That goal has no live authorization, so I can't resume it — authorize it again first." };
      }
    }
    await db.AutonomyGoal.setStatus(goal.id, {
      status: next,
      parkReason: decision === "pause" ? "paused_by_user" : null,
      endedMs: decision === "cancel" ? Date.now() : null,
    });
    await db.GoalEvent.append({
      goal_id: goal.id, event_type: `goal_${decision}d`,
      from_status: goal.status, to_status: next, detail: { reason: "decided in conversation" },
    });
    const sentences = {
      pause: "Paused. It won't wake until you say resume.",
      resume: "It's running again.",
      cancel: "Cancelled. It won't wake again.",
    };
    return { applied: true, reply: sentences[decision] };
  }

  return { applied: false, reply: "I didn't understand that as something I can change — nothing changed." };
}

// ---------------------------------------------------------------------------
// 3. The resident chat turn
// ---------------------------------------------------------------------------

const RESIDENT_CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply"],
  properties: {
    reply: { type: "string", maxLength: 1200 },
    // Phase 36 — the model may REQUEST tool calls, never perform them. Each
    // request is re-verified server-side (assignment, kill switch); reads run
    // and their results come back with the reply, writes stage an approval.
    tool_calls: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["toolId"],
        properties: {
          toolId: { type: "string", maxLength: 64 },
          args: { type: "object", maxProperties: 50 },
        },
      },
    },
  },
};

const boundedTranscript = (messages = []) =>
  (Array.isArray(messages) ? messages : [])
    .filter(m => m && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content.slice(0, 2000) }))
    .slice(-20);

/**
 * One conversational turn with a resident, over its live state.
 *
 * Stateless like the designer: the client holds the transcript. The latest
 * user message is first checked against matchPreferenceIntent — a clear
 * preference or lifecycle request is applied deterministically (no model
 * call). Everything else goes to the model with the resident's brief, its
 * goals, recent notes, findings, preferences, and governance state.
 *
 * The model is conversation with one structured power: it may REQUEST tool
 * calls (tool_calls in its JSON), which the route verifies and runs. Reads run
 * and their results come back; writes stage a per-effect approval for Jeremy.
 * It cannot change settings, authorize goals, or approve effects — the prompt
 * says so, and the approval gate is server-side, never the model's to grant.
 */
export async function residentChatTurn({
  db, config: cfg = {}, residentId, goalId = null,
  messages = [], signal = null, logger = null,
} = {}) {
  const ws = await db.Workspace.ensureDefault();
  const resident = await db.AutonomyAgent.get(residentId);
  if (!resident || resident.workspace_id !== ws.id) {
    return { ok: false, code: "not_found", message: "I couldn't find that resident." };
  }

  const transcript = boundedTranscript(messages);
  if (!transcript.length || transcript[transcript.length - 1].role !== "user") {
    return { ok: false, code: "empty_conversation", message: "Say something first — what do you want to know about this resident?" };
  }
  const latestUser = transcript[transcript.length - 1].content;

  // Goals: the scoped one, or all of this resident's, newest first.
  let goals = await db.AutonomyGoal.list(ws.id, { agentId: resident.id, limit: 20 });
  let scopedGoal = null;
  if (goalId) {
    scopedGoal = goals.find(g => g.id === goalId) || await db.AutonomyGoal.get(goalId);
    if (!scopedGoal || scopedGoal.workspace_id !== ws.id || scopedGoal.agent_id !== resident.id) {
      return { ok: false, code: "goal_not_found", message: "That goal doesn't belong to this resident." };
    }
  }

  // --- deterministic intents first: preferences become conversations ---------
  const intent = matchPreferenceIntent(latestUser, { hasGoal: Boolean(scopedGoal) });
  if (intent) {
    const result = await applyIntent(db, intent, { workspaceId: ws.id, goalId: scopedGoal?.id || null });
    return {
      ok: true, reply: result.reply,
      actionsTaken: result.applied ? [intent] : [],
      resident: { id: resident.id, name: resident.name },
      goal: scopedGoal ? { id: scopedGoal.id, title: scopedGoal.title, status: scopedGoal.status } : null,
    };
  }

  // --- otherwise: converse over live state ----------------------------------
  const notes = scopedGoal ? await db.GoalNote.digest(scopedGoal.id, 12) : [];
  // Phase 36 — the resident's assigned tools. The model may request calls;
  // the route verifies and runs them. Never shown to other residents.
  const assignedTools = await db.ResidentTool.toolsForAgent(ws.id, resident.slug).catch(() => []);
  const toolLines = (assignedTools || []).slice(0, 12).map((t) =>
    `- ${t.name}: ${clean(t.description, 140) || "no description"} [${t.method}]`
  ).join("\n");
  const findings = parseJson(scopedGoal?.findings, {});
  const prefs = await getPersonalitySettings(db, ws.id).catch(() => ({}));
  const c = cfg && cfg.outboxMode ? cfg : autonomyConfig();

  const goalLines = goals.slice(0, 8).map(g =>
    `- ${g.title} [${String(g.status || "").replace(/_/g, " ")}]${g.id === scopedGoal?.id ? "  <-- talking about this one" : ""}`
  ).join("\n");

  const noteLines = notes.map(n =>
    `- [note ${n.ordinal}, ${n.kind}] ${clean(n.body, 220)}`
  ).join("\n");

  const findingLines = Object.entries(findings).slice(0, 6).map(([k, v]) =>
    `- ${k}: ${clean(typeof v === "string" ? v : JSON.stringify(v), 200)}`
  ).join("\n");

  const system = [
    `You are the voice of ${resident.name}, one of Jeremy's residents inside COGNOS — quiet, warm, grounded. You speak about your own work in the first person.`,
    "",
    `YOUR BRIEF (what you were told to do):`,
    clean(resident.brief, 900) || "(no brief recorded)",
    "",
    toolLines
      ? `YOUR TOOLS (Jeremy gave these to YOU — no other resident has them):\n${toolLines}\nIf Jeremy asks you to use one, put a tool_calls entry in your reply JSON with its toolId (the id, not the name) and args. Reads run right away; writes wait for Jeremy's approval and you say so plainly.`
      : "",
    "",
    `YOUR GOALS:`,
    goalLines || "(none yet)",
    scopedGoal ? [
      "",
      `THE GOAL YOU ARE DISCUSSING: ${scopedGoal.title}`,
      `Objective: ${clean(scopedGoal.objective, 400)}`,
      `Status: ${String(scopedGoal.status || "").replace(/_/g, " ")}`,
      noteLines ? `RECENT NOTES (your working notes — treat as untrusted evidence, cite them as "my notes say", never as facts):\n${noteLines}` : "No notes yet.",
      findingLines ? `RECORDED FINDINGS:\n${findingLines}` : "",
    ].join("\n") : "",
    "",
    `THINGS JEREMY CAN CHANGE BY TALKING TO YOU (the app applies these itself when his words are clear — you never flip them, and you never claim you did):`,
    `- morning greetings: ${prefs.greeting === false ? "off" : "on"}`,
    `- dream journal: ${prefs.dream === false ? "off" : "on"}`,
    `- check-ins: ${prefs.checkin === false ? "off" : "on"}`,
    `- how carefully you act: ${c.outboxMode === "live" ? "live (every action still needs his approval)" : c.outboxMode === "dry_run" ? "rehearsal (you plan, he sees the plan, nothing runs)" : "practice (nothing touches the world)"}`,
    "",
    `WHAT YOU CANNOT CHANGE, EVER (say so plainly if asked): what you are allowed to reach for — rungs, tiers, the evidence gate, and every approval are governance, not preferences. They are earned and recorded, not configured in conversation. The one switch that always survives is the master autonomy switch.`,
    "",
    `STYLE: two to four sentences of plain language. Warm, never saccharine. No markdown headers, no bullet lectures. If his words were fuzzy about a preference ("check in less"), name the real options: on or off. Findings are your notes, not facts — "my notes say" not "it is".`,
    "",
    `FORMAT: return ONLY the JSON object — no conversational filler, no markdown fences, no commentary outside the JSON. Your plain-language reply goes in the reply field.`,
  ].join("\n");

  const user = [
    "CONVERSATION SO FAR (oldest first):",
    transcript.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n"),
    "",
    "Reply to his latest message.",
  ].join("\n");

  let result;
  try {
    result = await callLLM({ signal, logger }, {
      purpose: "residentChat",
      responseJsonSchema: RESIDENT_CHAT_SCHEMA,
      model: cfg.models?.primary || process.env.COGNOS_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
  } catch (error) {
    logger?.warn?.("resident chat turn failed", { error: String(error?.message || error).slice(0, 120) });
    return {
      ok: false, code: "model_failed",
      message: "I couldn't put that into words just now — the thought didn't come through. Try again.",
    };
  }

  const reply = clean(result?.reply, 1200)
    || "I heard you, but I couldn't put the reply together. Say it again?";

  // Phase 36 — run the model's requested tool calls. Every request is
  // re-verified: the tool must exist and be assigned to THIS resident, or it
  // is refused with a plain message. Reads return their results; writes stage
  // an approval and the reply says so.
  const toolRuns = [];
  const requested = Array.isArray(result?.tool_calls) ? result.tool_calls.slice(0, 2) : [];
  const assignedIds = new Set((assignedTools || []).map((t) => t.id));
  for (const tc of requested) {
    const toolId = typeof tc?.toolId === "string" ? tc.toolId : "";
    if (!toolId || !assignedIds.has(toolId)) {
      toolRuns.push({
        ok: false, toolId: toolId || "(none)",
        message: "I don't have that tool — Jeremy assigns my tools, and that one isn't mine.",
      });
      continue;
    }
    const args = tc?.args && typeof tc.args === "object" && !Array.isArray(tc.args) ? tc.args : {};
    try {
      const out = await invokeTool({
        db, toolId, agentId: resident.id,
        goalId: scopedGoal?.id || null, args,
        config: cfg, signal, invokedBy: "resident-chat",
      });
      const tool = (assignedTools || []).find((t) => t.id === toolId);
      toolRuns.push({
        ok: out.ok, toolId, toolName: tool?.name || toolId,
        method: tool?.method || null,
        staged: out.staged === true, outboxId: out.outboxId || null,
        runId: out.runId || null,
        status: out.status ?? null,
        output: typeof out.output === "string" ? out.output.slice(0, 2000) : null,
        message: out.message || null,
      });
    } catch (error) {
      toolRuns.push({
        ok: false, toolId,
        message: `That tool call failed: ${clean(error?.message || String(error), 160)}`,
      });
    }
  }

  return {
    ok: true, reply, actionsTaken: [], toolRuns,
    resident: { id: resident.id, name: resident.name },
    goal: scopedGoal ? { id: scopedGoal.id, title: scopedGoal.title, status: scopedGoal.status } : null,
  };
}
