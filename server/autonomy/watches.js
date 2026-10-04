// Resident watches (Phase 37) — "every morning, check X and tell me."
//
// OpenMuse's Monitor spec, reimplemented in COGNOS idioms: a resident watches
// a URL for a condition (change | contains | price_below) on an interval.
// Hash-deduped (no alert twice for the same bytes), failure backoff,
// pause/resume/stop. Each check runs as a durable task (lease runner), so a
// crashed check is a non-event.
//
// A watch firing creates a notice + activity feed entry — the resident "tells"
// Jeremy through the surfaces he already reads.

import { createHash } from "node:crypto";
import { newId } from "../db/util.js";
import { query } from "../db.js";
import { createDurableTask } from "./leaseRunner.js";

const sha256 = (s) => createHash("sha256").update(String(s), "utf8").digest("hex");

/** Fetch a URL's text. Public HTTPS only — same boundary as resident tools. */
async function fetchText(url, { timeoutMs = 20000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("watches only fetch public https URLs");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "COGNOS-watch/1.0" },
      redirect: "follow"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text.slice(0, 200000); // bounded
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a price-ish number from text. Best effort. */
function extractPrice(text) {
  const m = String(text).replace(/,/g, "").match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

export function createWatchRunner({ db, store, taskRunner, logger = null }) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };

  async function createWatch({ workspaceId, residentId, name, url, condition, conditionValue = null, intervalMinutes = 1440 }) {
    if (!["change", "contains", "price_below"].includes(condition)) {
      throw new Error(`unknown watch condition: ${condition}`);
    }
    const t = Date.now();
    const id = newId("watch");
    await query(
      `INSERT INTO resident_watches
        (id, workspace_id, resident_id, name, url, condition, condition_value,
         interval_minutes, status, created_ms, updated_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$9)`,
      [id, workspaceId, residentId, String(name).slice(0, 200), url, condition,
       conditionValue ? String(conditionValue).slice(0, 500) : null,
       Math.max(5, Math.min(10080, intervalMinutes || 1440)), t]
    );
    return getWatch(id);
  }

  async function getWatch(id) {
    const rows = await query(`SELECT * FROM resident_watches WHERE id=$1`, [id]);
    return rows[0] || null;
  }

  async function listWatches(workspaceId, { residentId = null, status = null } = {}) {
    const where = ["workspace_id=$1"];
    const params = [workspaceId];
    if (residentId) { params.push(residentId); where.push(`resident_id=$${params.length}`); }
    if (status) { params.push(status); where.push(`status=$${params.length}`); }
    return query(
      `SELECT * FROM resident_watches WHERE ${where.join(" AND ")} ORDER BY updated_ms DESC LIMIT 100`,
      params
    );
  }

  async function setStatus(id, status) {
    if (!["active", "paused", "stopped"].includes(status)) throw new Error(`bad status: ${status}`);
    await query(`UPDATE resident_watches SET status=$2, updated_ms=$3 WHERE id=$1`, [id, status, Date.now()]);
    return getWatch(id);
  }

  async function deleteWatch(id) {
    const rows = await query(`DELETE FROM resident_watches WHERE id=$1 RETURNING id`, [id]);
    return (rows || []).length > 0;
  }

  /** Run one check. Called by the durable task runner; idempotent by watch id. */
  async function checkWatch(owner, task) {
    const watchId = task.input?.watchId;
    const watch = await getWatch(watchId);
    if (!watch || watch.status !== "active") return { status: "succeeded", skipped: "watch gone or paused" };

    const t = Date.now();
    try {
      const text = await fetchText(watch.url);
      const hash = sha256(text);
      const checks = (watch.checks || 0) + 1;
      let changed = false;
      let detail = null;

      if (watch.condition === "change") {
        changed = !!watch.last_hash && watch.last_hash !== hash;
        detail = changed ? "the page changed" : "no change";
      } else if (watch.condition === "contains") {
        const nowContains = text.toLowerCase().includes(String(watch.condition_value || "").toLowerCase());
        const beforeContains = watch.last_hash === "contains:true";
        changed = nowContains !== beforeContains;
        detail = nowContains ? `now contains "${watch.condition_value}"` : `no longer contains "${watch.condition_value}"`;
        // For contains, the "hash" is the boolean state.
        await query(
          `UPDATE resident_watches SET last_hash=$2, last_check_ms=$3, checks=$4,
                  consecutive_errors=0, updated_ms=$3,
                  last_change_ms=CASE WHEN $5 THEN $3 ELSE last_change_ms END
           WHERE id=$1`,
          [watch.id, `contains:${nowContains}`, t, checks, changed]
        );
      } else if (watch.condition === "price_below") {
        const price = extractPrice(text);
        const threshold = parseFloat(watch.condition_value);
        changed = price != null && !Number.isNaN(threshold) && price < threshold;
        detail = price != null ? `price $${price}` : "no price found";
        await query(
          `UPDATE resident_watches SET last_hash=$2, last_check_ms=$3, checks=$4,
                  consecutive_errors=0, updated_ms=$3,
                  last_change_ms=CASE WHEN $5 THEN $3 ELSE last_change_ms END
           WHERE id=$1`,
          [watch.id, hash, t, checks, changed]
        );
      }

      if (watch.condition !== "contains") {
        await query(
          `UPDATE resident_watches SET last_hash=$2, last_check_ms=$3, checks=$4,
                  consecutive_errors=0, updated_ms=$3,
                  last_change_ms=CASE WHEN $5 THEN $3 ELSE last_change_ms END
           WHERE id=$1`,
          [watch.id, hash, t, checks, changed]
        );
      }

      if (changed) {
        // Tell Jeremy through the surfaces he reads.
        await db.AutonomyNotice.create({
          workspace_id: watch.workspace_id,
          agent_id: watch.resident_id,
          template_id: "watch_fired",
          fields: { watchName: watch.name, detail: detail || "changed" },
          severity: "info"
        });
      }
      return { status: "succeeded", changed, detail };
    } catch (error) {
      // Failure backoff: consecutive errors stretch the interval.
      const errors = (watch.consecutive_errors || 0) + 1;
      await query(
        `UPDATE resident_watches SET consecutive_errors=$2, last_check_ms=$3, updated_ms=$3,
                status=CASE WHEN $2 >= 10 THEN 'error' ELSE status END
         WHERE id=$1`,
        [watch.id, errors, t]
      );
      throw error; // durable task marks failed; the watch survives for next interval
    }
  }

  /** Schedule due watches as durable tasks. Called by the maintenance loop. */
  async function scheduleDue() {
    const t = Date.now();
    const due = await query(
      `SELECT * FROM resident_watches
       WHERE status='active'
         AND (last_check_ms IS NULL
              OR last_check_ms + (interval_minutes * 60000 * POWER(2, LEAST(consecutive_errors, 4))) <= $1)
       LIMIT 20`,
      [t]
    );
    for (const watch of due || []) {
      const owner = watch.workspace_id;
      await createDurableTask(store, owner, {
        id: `watch-check:${watch.id}:${Math.floor(t / 60000)}`,
        kind: "watch_check",
        title: `Check "${watch.name}"`,
        input: { watchId: watch.id }
      });
    }
    return (due || []).length;
  }

  return { createWatch, getWatch, listWatches, setStatus, deleteWatch, checkWatch, scheduleDue };
}
