// Daily Insights scheduling (Phase 38).
//
// The digest rides the heartbeat like the cleanup audit and the librarian:
// day-guarded, behind the autonomy kill switch, and a failure never kills
// the beat. The send time is Jeremy's morning in America/New_York.
import { getConfig } from "./emailStore.js";

function nyParts(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function sendTimeMinutes(t) {
  const [h, m] = String(t || "07:00").split(":").map(Number);
  return h * 60 + m;
}

/**
 * True when a digest should fire now: configured, enabled, past today's
 * send time (New York), and no successful send yet today (New York day).
 * Pure logic except for the config/last-run reads — nowMs is injectable
 * for tests.
 */
export async function insightsDue(db, workspaceId, nowMs = Date.now()) {
  const cfg = await getConfig(db, workspaceId);
  if (!cfg.configured || !cfg.enabled) return false;
  const now = nyParts(nowMs);
  if (now.minutes < sendTimeMinutes(cfg.send_time)) return false;
  // Any successful send on this New York day blocks a second one — a later
  // failed retry must not re-arm the day.
  const sent = await db.query(
    `SELECT started_ms FROM insights_digest_runs
     WHERE workspace_id = $1 AND status = 'sent'
     ORDER BY started_ms DESC LIMIT 5`,
    [workspaceId]
  );
  for (const row of sent) {
    if (row.started_ms && nyParts(Number(row.started_ms)).day === now.day) return false;
  }
  // A failed attempt backs off: retry at most every 30 minutes, so a bad
  // password doesn't hammer Gmail on every heartbeat beat.
  const recent = await db.query(
    `SELECT started_ms, status FROM insights_digest_runs
     WHERE workspace_id = $1 AND status IN ('failed', 'running')
     ORDER BY started_ms DESC LIMIT 1`,
    [workspaceId]
  );
  if (recent[0]?.started_ms && nowMs - Number(recent[0].started_ms) < 30 * 60 * 1000) return false;
  return true;
}
