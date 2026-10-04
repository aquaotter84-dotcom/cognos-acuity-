// Daily Insights email configuration (Phase 38).
//
// One row per workspace in insights_email_config. The app password is
// write-only: it is encrypted with the vault envelope
// (server/autonomy/vault.js) before it touches the row, and NO accessor in
// this module ever returns it. Callers get { has_password: true/false }.
// The one exception is getSendCredentials(), used only by the digest sender
// at send time — never by a route that returns data to the UI.
//
// The digest is only ever sent to the configured address itself (Jeremy's
// COGNOS Gmail account). There is no recipient field anywhere in this
// feature; the address IS the recipient.
import { encryptSecret, decryptSecret, getVaultKey } from "../autonomy/vault.js";
import { newId } from "../db/util.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_RE = /^[0-2][0-9]:[0-5][0-9]$/;

export function validEmail(address) {
  return EMAIL_RE.test(String(address || "").trim());
}

export function validSendTime(t) {
  if (!TIME_RE.test(String(t || ""))) return false;
  const [h, m] = String(t).split(":").map(Number);
  return h <= 23 && m <= 59;
}

function row(db, workspaceId) {
  return db
    .query(
      `SELECT workspace_id, email_address, app_password_enc, enabled, send_time, updated_date
       FROM insights_email_config WHERE workspace_id = $1`,
      [workspaceId]
    )
    .then((rows) => rows[0] || null);
}

/** Public view for the UI. The password is never included — only whether one is set. */
export async function getConfig(db, workspaceId) {
  const r = await row(db, workspaceId);
  return {
    configured: Boolean(r?.email_address && r?.app_password_enc),
    email_address: r?.email_address || "",
    has_password: Boolean(r?.app_password_enc),
    enabled: r?.enabled === true,
    send_time: r?.send_time || "07:00",
  };
}

/**
 * Save the Gmail address + app password. The password is encrypted with the
 * vault key before storage. Passing an empty password keeps the existing one
 * (lets the UI update the address or schedule without retyping the secret).
 */
export async function setCredentials(db, workspaceId, { email_address, app_password }) {
  const address = String(email_address || "").trim().toLowerCase();
  if (!validEmail(address)) throw new Error("That doesn't look like an email address.");
  const existing = await row(db, workspaceId);
  let enc = existing?.app_password_enc || "";
  if (app_password !== undefined && app_password !== null && String(app_password) !== "") {
    const secret = String(app_password).trim().replace(/\s+/g, "");
    if (secret.length < 8) throw new Error("That app password looks too short — paste the full 16-character code.");
    enc = encryptSecret(secret, getVaultKey());
  }
  if (!enc) throw new Error("An app password is required — paste the 16-character code from your Google account.");
  await db.query(
    `INSERT INTO insights_email_config (workspace_id, email_address, app_password_enc, enabled, send_time)
     VALUES ($1, $2, $3, COALESCE((SELECT enabled FROM insights_email_config WHERE workspace_id = $1), FALSE),
             COALESCE((SELECT send_time FROM insights_email_config WHERE workspace_id = $1), '07:00'))
     ON CONFLICT (workspace_id) DO UPDATE
       SET email_address = EXCLUDED.email_address,
           app_password_enc = EXCLUDED.app_password_enc,
           updated_date = now()`,
    [workspaceId, address, enc]
  );
  return getConfig(db, workspaceId);
}

/** Remove the stored app password (address and schedule stay). */
export async function clearPassword(db, workspaceId) {
  await db.query(
    `UPDATE insights_email_config SET app_password_enc = '', updated_date = now() WHERE workspace_id = $1`,
    [workspaceId]
  );
  return getConfig(db, workspaceId);
}

export async function setSchedule(db, workspaceId, { enabled, send_time }) {
  if (send_time !== undefined && !validSendTime(send_time)) {
    throw new Error("Send time must be HH:MM (24-hour).");
  }
  await db.query(
    `INSERT INTO insights_email_config (workspace_id, enabled, send_time)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           send_time = EXCLUDED.send_time,
           updated_date = now()`,
    [workspaceId, enabled === true, send_time || "07:00"]
  );
  return getConfig(db, workspaceId);
}

/**
 * INTERNAL — send time only. Decrypts the app password. Never called from a
 * route that returns data to the UI.
 */
export async function getSendCredentials(db, workspaceId) {
  const r = await row(db, workspaceId);
  if (!r?.email_address || !r?.app_password_enc) return null;
  let password;
  try {
    password = decryptSecret(r.app_password_enc, getVaultKey());
  } catch {
    return { address: r.email_address, password: null, decryptError: true };
  }
  return { address: r.email_address, password };
}

// --- digest run journal -------------------------------------------------------

export async function startRun(db, workspaceId, nowMs = Date.now()) {
  const id = newId("idg");
  await db.query(
    `INSERT INTO insights_digest_runs (id, workspace_id, started_ms, status)
     VALUES ($1, $2, $3, 'running')`,
    [id, workspaceId, nowMs]
  );
  return id;
}

export async function finishRun(db, runId, { status, error = null, subject = null, preview = null, nowMs = Date.now() }) {
  await db.query(
    `UPDATE insights_digest_runs
     SET finished_ms = $2, status = $3, error = $4, subject = $5, preview = $6
     WHERE id = $1`,
    [runId, nowMs, status, error, subject, preview ? String(preview).slice(0, 500) : null]
  );
}

export async function lastRun(db, workspaceId) {
  const rows = await db.query(
    `SELECT id, started_ms, finished_ms, status, error, subject, preview, created_date
     FROM insights_digest_runs WHERE workspace_id = $1
     ORDER BY started_ms DESC LIMIT 1`,
    [workspaceId]
  );
  return rows[0] || null;
}
