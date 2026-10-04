// Stored-data cleanup — Jeremy's direction: cleanup controls that cover ALL
// stored data. One place (Settings → Stored data) lists every category of data
// COGNOS keeps, with live counts, and clears each one behind an explicit
// confirmation. "Everything, the ledger, everything."
//
// Safety rules:
//   * Nothing here touches accounts, settings, API keys, endpoints, auth
//     state, the workspace row, or the system audit tables. Data only.
//   * Every clear runs inside a transaction: a category goes all at once or
//     not at all.
//   * Memories are backed up to a file and verified before the wipe, the
//     same safe path as the v47 Sapphire transplant.
//   * The ledger is append-only by charter, but Jeremy explicitly ordered it
//     clearable: clearing it writes a tombstone entry so the wipe itself is
//     on the record.
//   * Goal clearing reuses the v54 fix path: children (steps, subagents,
//     notes, events, authorizations) are deleted before the goal row, in one
//     transaction.

import fs from "node:fs";
import path from "node:path";
import { newId } from "../db/util.js";
import { resolveBackupDir } from "../memory/transplant.js";

// Tables are listed children-first (RESTRICT foreign keys).
const CATEGORIES = {
  memories: {
    title: "Memories",
    description: "Everything COGNOS remembers — the five memory layers, links between memories, beliefs, and learning history.",
    tables: ["memory_edges", "beliefs", "knowledge_events", "memory_tending_state", "librarian_runs", "coherence_reports", "confidence_history", "memories"],
    backup: "memories",
  },
  graph: {
    title: "Knowledge graph",
    description: "The entity/relationship graph — nodes, edges, and snapshots.",
    tables: ["graph_edges", "graph_nodes", "graph_snapshots", "relationships"],
  },
  ledger: {
    title: "Ledger",
    description: "The improvement ledger. Append-only by design — clearing it writes a tombstone entry so the wipe stays on the record.",
    tables: ["improvement_ledger"],
    tombstone: true,
    warning: "The ledger is append-only by design. You ordered it clearable anyway — a tombstone will mark the wipe.",
  },
  goals: {
    title: "Goals",
    description: "Goals and everything attached to them — steps, subagents, notes, events, authorizations.",
    tables: ["goal_subagents", "goal_steps", "goal_notes", "goal_events", "goal_authorizations", "autonomy_goals"],
  },
  conversations: {
    title: "Conversations",
    description: "Chats, messages, and agent run records.",
    tables: ["agent_steps", "agent_runs", "agent_events", "image_analyses", "task_contexts", "messages", "conversations"],
  },
  projects: {
    title: "Projects",
    description: "Projects.",
    tables: ["projects"],
  },
  ideas: {
    title: "Ideas",
    description: "The Ideas surface — captured ideas and their states.",
    tables: ["cognos_ideas"],
  },
  outbox: {
    title: "Outbox & approvals",
    description: "Staged effects, approval decisions, and outbox history.",
    tables: ["outbox_events", "effect_approvals", "agent_approvals", "autonomy_outbox"],
  },
  watches: {
    title: "Watches",
    description: "Resident watches — URL changes, price thresholds, text availability.",
    tables: ["resident_watches"],
  },
  tools: {
    title: "Resident tools",
    description: "Tool definitions, resident assignments, run history, and stored tool secrets.",
    tables: ["resident_tool_secrets", "resident_tool_runs", "resident_tool_assignments", "resident_tools"],
    warning: "This also removes stored tool secrets.",
  },
  sources: {
    title: "Sources",
    description: "Sources and their indexed chunks and images.",
    tables: ["source_images", "source_chunks", "sources"],
  },
  residents: {
    title: "Residents",
    description: "The resident agents themselves (their definitions, not just their activity).",
    tables: ["autonomy_agents"],
    warning: "This removes the residents themselves. Their tools, watches, and assignments reference them — clear those first or they go with everything.",
  },
  autonomy: {
    title: "Autonomy runtime",
    description: "Ticks, notices, strategies, workflow records, heartbeat state, and cleanup history.",
    tables: ["autonomy_notices", "autonomy_ticks", "autonomy_rung_evidence", "strategies", "strategy_evaluations", "adaptive_decisions", "workflow_records", "heartbeat_state", "cleanup_proposals", "cleanup_runs"],
  },
  telemetry: {
    title: "Telemetry",
    description: "Model-call and run telemetry.",
    tables: ["telemetry_model_calls", "telemetry_runs"],
  },
};

// "Clear everything" runs categories in this order (children before parents
// across categories where it matters).
const CLEAR_ALL_ORDER = [
  "telemetry", "autonomy", "sources", "tools", "watches", "outbox", "ideas",
  "projects", "conversations", "goals", "ledger", "graph", "residents", "memories",
];

const CLEAR_ALL_PHRASE = "CLEAR EVERYTHING";

/** Only "table does not exist" is swallowed — a lazy-migrated database may not
 *  have every table yet. Any other error aborts the transaction. */
function isMissingTable(err) {
  return err?.code === "42P01" || /does not exist/i.test(String(err?.message || ""));
}

async function tableCount(run, table) {
  try {
    const rows = await run(`SELECT COUNT(*)::int AS n FROM ${table}`);
    return rows[0]?.n ?? 0;
  } catch (e) {
    if (isMissingTable(e)) return 0;
    throw e;
  }
}

async function clearTables(run, tables) {
  const cleared = {};
  for (const table of tables) {
    try {
      const n = await tableCount(run, table);
      await run(`DELETE FROM ${table}`);
      cleared[table] = n;
    } catch (e) {
      if (isMissingTable(e)) {
        cleared[table] = 0;
        continue;
      }
      throw e;
    }
  }
  return cleared;
}

/** v47 transplant safe path: backup memories to a verified file before wiping. */
function backupMemories(run) {
  const dir = resolveBackupDir();
  if (!dir) throw new Error("no_backup_directory");
  return run(`SELECT * FROM memories ORDER BY created_date ASC`).then((rows) => {
    const nowMs = Date.now();
    const file = path.join(dir, `memories-backup-${new Date(nowMs).toISOString().slice(0, 10)}.json`);
    const payload = {
      marker: "cleanup_backup_memories",
      exported_at: new Date(nowMs).toISOString(),
      row_count: rows.length,
      note: "User-initiated backup before clearing memories via Stored data cleanup.",
      rows,
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload));
    const back = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!back || back.marker !== "cleanup_backup_memories" || !Array.isArray(back.rows) || back.rows.length !== rows.length) {
      throw new Error("backup_verify_failed");
    }
    return file;
  });
}

async function writeLedgerTombstone(run) {
  const nowMs = Date.now();
  await run(
    `INSERT INTO improvement_ledger (id, ts_ms, action, proposal, decision, justification, proposed_by)
     VALUES ($1, $2, 'ledger_cleared', '{}'::jsonb, 'cleared', $3, 'user')`,
    [newId("led"), nowMs, `Ledger cleared by the user via Stored data cleanup at ${new Date(nowMs).toISOString()}. This tombstone is the first entry of the new ledger.`]
  );
}

async function clearCategory(store, key) {
  const cat = CATEGORIES[key];
  if (!cat) throw Object.assign(new Error(`unknown category: ${key}`), { status: 404 });
  return store.withTransaction(async (tx) => {
    let backupPath = null;
    if (cat.backup === "memories") {
      backupPath = await backupMemories(tx.query);
    }
    const cleared = await clearTables(tx.query, cat.tables);
    if (cat.tombstone) {
      await writeLedgerTombstone(tx.query);
    }
    return { cleared, backupPath };
  });
}

export function registerDataCleanupRoutes(app, { wrap, db, logger }) {
  app.get("/api/data/cleanup/counts", wrap(async (req, res) => {
    const categories = [];
    for (const [key, cat] of Object.entries(CATEGORIES)) {
      let count = 0;
      for (const table of cat.tables) {
        count += await tableCount(db.query, table);
      }
      categories.push({ key, title: cat.title, description: cat.description, warning: cat.warning || null, count });
    }
    const total = categories.reduce((n, c) => n + c.count, 0);
    res.json({ categories, total });
  }));

  app.post("/api/data/cleanup/all", wrap(async (req, res) => {
    if (req.body?.confirm !== CLEAR_ALL_PHRASE) {
      return res.status(400).json({ error: `Clearing everything requires confirming with "${CLEAR_ALL_PHRASE}".` });
    }
    try {
      const result = {};
      let backupPath = null;
      await db.withTransaction(async (tx) => {
        for (const key of CLEAR_ALL_ORDER) {
          const cat = CATEGORIES[key];
          if (cat.backup === "memories") {
            backupPath = await backupMemories(tx.query);
          }
          result[key] = await clearTables(tx.query, cat.tables);
          if (cat.tombstone) {
            await writeLedgerTombstone(tx.query);
          }
        }
      });
      logger?.info?.("data cleanup: everything cleared");
      res.json({ cleared: true, categories: result, backupPath });
    } catch (e) {
      logger?.warn?.("data cleanup: clear-all failed", { error: String(e?.message || e) });
      res.status(500).json({ error: `Could not clear everything: ${e?.message || "unknown error"}` });
    }
  }));

  app.post("/api/data/cleanup/:category", wrap(async (req, res) => {
    const key = req.params.category;
    if (req.body?.confirm !== true) {
      return res.status(400).json({ error: "Clearing a data category requires an explicit confirmation." });
    }
    const cat = CATEGORIES[key];
    if (!cat) return res.status(404).json({ error: `Unknown data category: ${key}` });
    try {
      const { cleared, backupPath } = await clearCategory(db, key);
      logger?.info?.("data cleanup: category cleared", { category: key });
      res.json({ cleared: true, category: key, title: cat.title, clearedTables: cleared, backupPath });
    } catch (e) {
      logger?.warn?.("data cleanup: category clear failed", { category: key, error: String(e?.message || e) });
      res.status(500).json({ error: `Could not clear ${cat.title}: ${e?.message || "unknown error"}` });
    }
  }));
}

export { CATEGORIES, CLEAR_ALL_PHRASE };
