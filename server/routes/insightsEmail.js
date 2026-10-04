// Daily Insights email routes (Phase 38).
//
// Settings → Daily Insights: the Gmail address + app password for the
// COGNOS account, the send schedule, a test-email button, and the digest
// status. The app password is write-only — no endpoint here ever returns it.
//
// The digest is only ever sent to the configured address itself. There is
// no recipient parameter on any endpoint.
import { sendMail } from "../insights/smtp.js";
import {
  getConfig,
  setCredentials,
  clearPassword,
  setSchedule,
  getSendCredentials,
  lastRun,
} from "../insights/emailStore.js";
import { runInsightsDigest, digestSubject } from "../insights/digest.js";

async function workspaceId(db) {
  const ws = await db.Workspace.ensureDefault();
  return ws.id;
}

function publicStatus(cfg, last) {
  return {
    configured: cfg.configured,
    email_address: cfg.email_address,
    has_password: cfg.has_password,
    enabled: cfg.enabled,
    send_time: cfg.send_time,
    last_run: last
      ? {
          started_ms: Number(last.started_ms),
          finished_ms: last.finished_ms ? Number(last.finished_ms) : null,
          status: last.status,
          error: last.error,
          subject: last.subject,
          preview: last.preview,
        }
      : null,
  };
}

export function registerInsightsEmailRoutes(app, { wrap, db, logger, mailer = null, llmCall = null }) {
  const send = mailer || ((opts) => sendMail(opts));

  app.get("/api/insights/email", wrap(async (req, res) => {
    const wsId = await workspaceId(db);
    const [cfg, last] = await Promise.all([getConfig(db, wsId), lastRun(db, wsId)]);
    res.json(publicStatus(cfg, last));
  }));

  app.post("/api/insights/email", wrap(async (req, res) => {
    const wsId = await workspaceId(db);
    try {
      const cfg = await setCredentials(db, wsId, {
        email_address: req.body?.email_address,
        app_password: req.body?.app_password,
      });
      const last = await lastRun(db, wsId);
      logger?.info?.("insights email: credentials saved");
      res.json(publicStatus(cfg, last));
    } catch (e) {
      res.status(400).json({ error: e.message || "Could not save." });
    }
  }));

  app.delete("/api/insights/email/password", wrap(async (req, res) => {
    const wsId = await workspaceId(db);
    const cfg = await clearPassword(db, wsId);
    const last = await lastRun(db, wsId);
    res.json(publicStatus(cfg, last));
  }));

  app.post("/api/insights/email/schedule", wrap(async (req, res) => {
    const wsId = await workspaceId(db);
    try {
      const cfg = await setSchedule(db, wsId, {
        enabled: req.body?.enabled,
        send_time: req.body?.send_time,
      });
      const last = await lastRun(db, wsId);
      res.json(publicStatus(cfg, last));
    } catch (e) {
      res.status(400).json({ error: e.message || "Could not save the schedule." });
    }
  }));

  // Send a test email to the configured address. Proves the app password
  // works before the first real digest.
  app.post("/api/insights/email/test", wrap(async (req, res) => {
    const wsId = await workspaceId(db);
    const creds = await getSendCredentials(db, wsId);
    if (!creds?.password) {
      return res.status(400).json({
        ok: false,
        error: creds?.decryptError
          ? "The stored app password couldn't be decrypted — re-enter it and try again."
          : "Add the Gmail address and app password first.",
      });
    }
    try {
      await send({
        host: "smtp.gmail.com",
        port: 465,
        user: creds.address,
        pass: creds.password,
        from: creds.address,
        to: creds.address,
        subject: "COGNOS test email",
        text: "This is a test from COGNOS Daily Insights. If you're reading this, the email setup works — your morning digest will arrive here.",
      });
      logger?.info?.("insights email: test sent");
      res.json({ ok: true, to: creds.address });
    } catch (e) {
      const message = String(e?.message || e).slice(0, 300);
      logger?.warn?.("insights email: test failed", { error: message });
      res.status(502).json({ ok: false, error: `Couldn't send: ${message}` });
    }
  }));

  // Run the digest right now (manual trigger from Settings).
  app.post("/api/insights/email/run", wrap(async (req, res) => {
    const wsId = await workspaceId(db);
    const result = await runInsightsDigest({ db, workspaceId: wsId, logger, mailer: send, llmCall });
    if (result.ok) return res.json({ ok: true, runId: result.runId, subject: result.subject });
    res.status(result.skipped ? 409 : 502).json({ ok: false, skipped: result.skipped || null, error: result.error || result.message });
  }));
}
