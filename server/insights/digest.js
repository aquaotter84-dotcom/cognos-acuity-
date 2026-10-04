// Daily Insights digest (Phase 38).
//
// The Insights resident's job: look across ALL of Jeremy's stored data once
// a day, find what's interesting, and email him a short morning digest.
//
// Pipeline: ensureInsightsResident → gatherFacts → composeDigest → send.
// The digest is Jeremy's own standing request, so no per-day approval is
// needed — but the autonomy kill switch halts it, a missing email config
// skips it (surfaced in Settings, never silent), and a failed send is
// recorded visibly in the run journal.
import { callLLM } from "../llm.js";
import { autonomyConfig } from "../autonomy/config.js";
import { sendMail } from "./smtp.js";
import {
  getConfig,
  getSendCredentials,
  startRun,
  finishRun,
} from "./emailStore.js";

export const INSIGHTS_RESIDENT_SLUG = "daily-insights";
const DAY_MS = 24 * 60 * 60 * 1000;

const INSIGHTS_BRIEF = `You are the Insights resident. Once a day you read across everything Jeremy keeps in COGNOS — memories, goals, ledger, conversations, ideas, outbox — and write him a short morning digest of what's actually interesting: patterns you notice, things left unfinished, items that need his attention, notable recent events. Plain, warm, no fluff. Never long.`;

/** The resident row this feature runs as — visible in Studio like any resident. */
export async function ensureInsightsResident(db, workspaceId) {
  const existing = await db.query(
    `SELECT * FROM autonomy_agents
     WHERE workspace_id = $1 AND slug = $2
       AND NOT EXISTS (SELECT 1 FROM autonomy_agents s WHERE s.supersedes_id = autonomy_agents.id)
     LIMIT 1`,
    [workspaceId, INSIGHTS_RESIDENT_SLUG]
  );
  if (existing[0]) return existing[0];
  const created = await db.AutonomyAgent.create({
    workspace_id: workspaceId,
    name: "Insights",
    slug: INSIGHTS_RESIDENT_SLUG,
    purpose: "Watches all of Jeremy's stored data and emails him a short daily digest of what's interesting.",
    brief: INSIGHTS_BRIEF,
    enabled: true,
  });
  return created;
}

// --- fact gathering -----------------------------------------------------------

async function safeQuery(db, sql, params) {
  try {
    return await db.query(sql, params);
  } catch {
    return [];
  }
}

/** One compact snapshot of everything, for the digest composer. */
export async function gatherFacts(db, workspaceId, { sinceMs = Date.now() - DAY_MS } = {}) {
  const sinceIso = new Date(sinceMs).toISOString();
  const facts = { window: "last 24 hours" };

  const mems = await safeQuery(
    db,
    `SELECT memory_type, content, importance, created_date FROM memories
     WHERE workspace_id = $1 AND is_enabled = TRUE AND created_date >= $2
     ORDER BY importance DESC, created_date DESC LIMIT 40`,
    [workspaceId, sinceIso]
  );
  facts.memories = {
    count: mems.length,
    by_layer: {},
    highlights: mems.slice(0, 12).map((m) => ({
      layer: m.memory_type,
      text: String(m.content || "").slice(0, 220),
    })),
  };
  for (const m of mems) {
    facts.memories.by_layer[m.memory_type || "unknown"] =
      (facts.memories.by_layer[m.memory_type || "unknown"] || 0) + 1;
  }

  const goals = await safeQuery(
    db,
    `SELECT id, title, status, updated_date FROM autonomy_goals
     WHERE workspace_id = $1 ORDER BY updated_date DESC LIMIT 30`,
    [workspaceId]
  );
  facts.goals = {
    total: goals.length,
    active: goals.filter((g) => !["closed", "done", "completed", "cancelled"].includes(String(g.status))).map((g) => ({
      title: g.title,
      status: g.status,
    })),
  };

  const ledger = await safeQuery(
    db,
    `SELECT action, target, decision, ts_ms FROM improvement_ledger
     ORDER BY seq DESC LIMIT 15`
  );
  facts.ledger = ledger.map((l) => ({
    action: l.action,
    target: l.target,
    decision: l.decision,
  }));

  const convos = await safeQuery(
    db,
    `SELECT id, title, created_date FROM conversations
     WHERE workspace_id = $1 AND created_date >= $2
     ORDER BY created_date DESC LIMIT 10`,
    [workspaceId, sinceIso]
  );
  facts.conversations = {
    count_24h: convos.length,
    titles: convos.map((c) => c.title).filter(Boolean).slice(0, 8),
  };

  const ideas = await safeQuery(
    db,
    `SELECT title, status FROM cognos_ideas
     WHERE workspace_id = $1 ORDER BY created_ms DESC LIMIT 15`,
    [workspaceId]
  );
  facts.ideas = {
    total: ideas.length,
    fresh: ideas.filter((i) => ["new", "proposed", "open"].includes(String(i.status))).map((i) => i.title),
  };

  const outbox = await safeQuery(
    db,
    `SELECT id, effect_type AS kind, status FROM autonomy_outbox
     WHERE workspace_id = $1 AND status IN ('staged','pending','awaiting_approval')
     ORDER BY created_date DESC LIMIT 15`,
    [workspaceId]
  );
  facts.outbox_awaiting = outbox.map((o) => ({ kind: o.kind, status: o.status }));

  const watches = await safeQuery(
    db,
    `SELECT name, status, consecutive_errors FROM resident_watches
     WHERE workspace_id = $1 AND status != 'stopped' LIMIT 15`,
    [workspaceId]
  );
  facts.watches = watches.map((w) => ({ name: w.name, status: w.status }));

  const notes = await safeQuery(
    db,
    `SELECT n.kind, n.body, n.created_date FROM goal_notes n
     JOIN autonomy_goals g ON g.id = n.goal_id
     WHERE g.workspace_id = $1 AND n.created_date >= $2
     ORDER BY n.created_date DESC LIMIT 10`,
    [workspaceId, sinceIso]
  );
  facts.goal_notes = notes.map((n) => ({
    kind: n.kind,
    text: String(n.body || "").slice(0, 200),
  }));

  return facts;
}

// --- composition ----------------------------------------------------------------

function fallbackDigest(facts, dateLabel) {
  const lines = [`COGNOS Daily Insights — ${dateLabel}`, ""];
  const attn = [];
  if (facts.outbox_awaiting?.length) attn.push(`${facts.outbox_awaiting.length} item(s) waiting for your approval in the Outbox.`);
  if (facts.ideas?.fresh?.length) attn.push(`${facts.ideas.fresh.length} fresh idea(s): ${facts.ideas.fresh.slice(0, 3).join("; ")}.`);
  if (facts.goals?.active?.length) attn.push(`${facts.goals.active.length} active goal(s).`);
  if (facts.watches?.some((w) => w.status === "error")) attn.push("One or more watches is in error — worth a look.");
  lines.push(attn.length ? "Needs your attention:" : "Nothing urgent on the board.");
  for (const a of attn) lines.push(`- ${a}`);
  lines.push("");
  lines.push(
    `In the last 24 hours: ${facts.memories?.count || 0} new memories, ` +
      `${facts.conversations?.count_24h || 0} conversations, ` +
      `${facts.ledger?.length || 0} ledger entries.`
  );
  if (facts.memories?.highlights?.length) {
    lines.push("", "Notable:");
    for (const h of facts.memories.highlights.slice(0, 5)) lines.push(`- [${h.layer}] ${h.text}`);
  }
  return lines.join("\n");
}

/**
 * Compose the digest email body. Uses the LLM; falls back to a deterministic
 * template if the model call fails so Jeremy still gets his morning read.
 */
export async function composeDigest(facts, { llmCall = null, dateLabel = null } = {}) {
  const label = dateLabel || new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });
  const call = llmCall || ((messages) => callLLM({}, { messages, purpose: "insights-digest" }));
  const factsJson = JSON.stringify(facts).slice(0, 12000);
  try {
    const out = await call([
      {
        role: "system",
        content:
          "You write Jeremy's morning digest for COGNOS. Plain, warm, no fluff. " +
          "Short: three sections max — \"Needs your attention\" (only real items, omit the section if none), " +
          "\"Worth knowing\" (2-4 genuine patterns or notable events), \"Loose ends\" (unfinished things). " +
          "Plain text, no markdown headers — use simple section titles on their own lines. " +
          "Under 250 words. Never invent facts not in the data; if the day was quiet, say so in one line.",
      },
      { role: "user", content: `Here is the last-24-hours snapshot of Jeremy's stored data:\n${factsJson}` },
    ]);
    const text = typeof out === "string" ? out : out?.content || out?.text || "";
    if (text && text.trim().length > 40) return text.trim();
  } catch {
    /* fall through to the template */
  }
  return fallbackDigest(facts, label);
}

export function digestSubject(date = new Date()) {
  const label = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" });
  return `COGNOS Daily Insights — ${label}`;
}

// --- the run ---------------------------------------------------------------------

/**
 * Run one digest: gather → compose → send. Returns a result object; the run
 * journal always records what happened.
 *
 * { mailer } defaults to real Gmail SMTP. Tests inject a fake.
 * { llmCall } defaults to the real model. Tests inject a stub.
 */
export async function runInsightsDigest({
  db,
  workspaceId,
  logger = null,
  mailer = null,
  llmCall = null,
  nowMs = Date.now(),
} = {}) {
  const log = (level, msg, extra) => logger?.[level]?.(msg, extra);
  const cfg = await getConfig(db, workspaceId);

  // Not configured or paused: never fire, and say so honestly.
  if (!cfg.configured) {
    const runId = await startRun(db, workspaceId, nowMs);
    await finishRun(db, runId, { status: "skipped", error: "email not configured", nowMs });
    return { ok: false, runId, skipped: "not_configured", message: "Email isn't configured yet — add the Gmail address and app password in Settings." };
  }
  if (!cfg.enabled) {
    const runId = await startRun(db, workspaceId, nowMs);
    await finishRun(db, runId, { status: "skipped", error: "digest paused", nowMs });
    return { ok: false, runId, skipped: "paused", message: "The daily digest is paused." };
  }

  // The kill switch halts the digest like everything else autonomous.
  if (autonomyConfig().enabled !== true) {
    const runId = await startRun(db, workspaceId, nowMs);
    await finishRun(db, runId, { status: "skipped", error: "autonomy kill switch", nowMs });
    return { ok: false, runId, skipped: "killed", message: "Autonomy is frozen — the digest is halted with it." };
  }

  const runId = await startRun(db, workspaceId, nowMs);
  try {
    await ensureInsightsResident(db, workspaceId);
    const facts = await gatherFacts(db, workspaceId, { sinceMs: nowMs - DAY_MS });
    const body = await composeDigest(facts, { llmCall });
    const subject = digestSubject(new Date(nowMs));

    const creds = await getSendCredentials(db, workspaceId);
    if (!creds?.password) {
      throw new Error(
        creds?.decryptError
          ? "The stored app password couldn't be decrypted — re-enter it in Settings."
          : "The app password is missing — re-enter it in Settings."
      );
    }
    // The recipient is ALWAYS the configured address itself. No free-form
    // recipient exists anywhere in this feature.
    const send = mailer || ((opts) => sendMail(opts));
    await send({
      host: "smtp.gmail.com",
      port: 465,
      user: creds.address,
      pass: creds.password,
      from: creds.address,
      to: creds.address,
      subject,
      text: body,
    });
    await finishRun(db, runId, { status: "sent", subject, preview: body, nowMs });
    log("info", "insights digest sent", { to: creds.address });
    return { ok: true, runId, subject };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    await finishRun(db, runId, { status: "failed", error: message, nowMs });
    log("warn", "insights digest failed", { error: message });
    return { ok: false, runId, error: message };
  }
}
