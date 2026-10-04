#!/usr/bin/env node
// Daily Insights email (Phase 38): the Insights resident emails Jeremy a
// short digest every morning from his COGNOS Gmail account.
//
// What this file proves:
//   * The SMTP client speaks the protocol (EHLO → AUTH → MAIL → RCPT → DATA
//     → QUIT), falls back from AUTH PLAIN to AUTH LOGIN, and throws on
//     rejected credentials or recipients — all against a fake transport.
//   * Email credentials are validated, the app password is stored encrypted
//     (vault envelope, never plaintext), and no accessor ever returns it.
//   * insightsDue() fires once a day past the send time (America/New_York),
//     and stays quiet when unconfigured, paused, early, or already sent.
//   * runInsightsDigest() skips honestly when unconfigured/paused/killed,
//     sends to the configured address only (the recipient IS the address —
//     no free-form recipient exists), and records failed sends visibly.
//   * The routes expose status/config/schedule, never leak the password,
//     and reject bad input.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootHarness } from "./harness.mjs";
import { sendMail } from "../server/insights/smtp.js";
import {
  getConfig,
  setCredentials,
  clearPassword,
  setSchedule,
  getSendCredentials,
  startRun,
  finishRun,
  lastRun,
} from "../server/insights/emailStore.js";
import { insightsDue } from "../server/insights/schedule.js";
import {
  ensureInsightsResident,
  gatherFacts,
  composeDigest,
  runInsightsDigest,
  INSIGHTS_RESIDENT_SLUG,
} from "../server/insights/digest.js";
import { _resetVaultKeyCache } from "../server/autonomy/vault.js";
import { newId } from "../server/db/util.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// --- fake SMTP transport ------------------------------------------------------
// Queue of replies; records every written line. Replies are matched in order.

function fakeTransport(replies) {
  const written = [];
  let i = 0;
  return {
    written,
    write(line) {
      written.push(line);
    },
    async readReply() {
      const step = replies[i++];
      assert.ok(step, `unexpected SMTP read #${i} (writes so far: ${JSON.stringify(written)})`);
      return { code: step[0], lines: step[1] || [] };
    },
    close() {},
  };
}

const GREETING = [220, ["mock ESMTP ready"]];
const EHLO_OK = [250, ["mock", "AUTH PLAIN LOGIN"]];
const AUTH_PLAIN_OK = [235, ["authenticated"]];
const AUTH_PLAIN_BAD = [535, ["bad credentials"]];
const AUTH_LOGIN_CHALLENGE = [334, ["VXNlcm5hbWU6"]];
const AUTH_LOGIN_USER_OK = [334, ["UGFzc3dvcmQ6"]];
const AUTH_LOGIN_OK = [235, ["authenticated"]];
const MAIL_OK = [250, ["OK"]];
const RCPT_OK = [250, ["OK"]];
const RCPT_BAD = [550, ["no such mailbox"]];
const DATA_GO = [354, ["end with ."]];
const BODY_OK = [250, ["queued"]];

await test("smtp: full happy-path conversation", async () => {
  const t = fakeTransport([GREETING, EHLO_OK, AUTH_PLAIN_OK, MAIL_OK, RCPT_OK, DATA_GO, BODY_OK, [221, ["bye"]]]);
  await sendMail(
    { host: "smtp.gmail.com", port: 465, user: "cognos@gmail.com", pass: "abcd efgh", from: "cognos@gmail.com", to: "cognos@gmail.com", subject: "Hi", text: "hello" },
    { transport: t }
  );
  const w = t.written;
  assert.ok(w[0].startsWith("EHLO"), `first command is EHLO, got ${w[0]}`);
  assert.ok(w[1].startsWith("AUTH PLAIN "), "AUTH PLAIN attempted");
  assert.ok(w.includes("MAIL FROM:<cognos@gmail.com>"), "MAIL FROM sent");
  assert.ok(w.includes("RCPT TO:<cognos@gmail.com>"), "RCPT TO sent");
  const dataIdx = w.indexOf("DATA");
  assert.ok(dataIdx >= 0, "DATA sent");
  const body = w[dataIdx + 1];
  assert.ok(body.includes("Subject: Hi"), "subject header present");
  assert.ok(body.includes("hello"), "body present");
  assert.ok(body.endsWith("\r\n."), "message terminated with dot");
  assert.equal(w[w.length - 1], "QUIT", "QUIT sent last");
});

await test("smtp: falls back to AUTH LOGIN when PLAIN is rejected", async () => {
  const t = fakeTransport([GREETING, EHLO_OK, AUTH_PLAIN_BAD, AUTH_LOGIN_CHALLENGE, AUTH_LOGIN_USER_OK, AUTH_LOGIN_OK, MAIL_OK, RCPT_OK, DATA_GO, BODY_OK, [221, ["bye"]]]);
  await sendMail(
    { host: "h", user: "u", pass: "p", from: "a@b.c", to: "a@b.c", subject: "s", text: "t" },
    { transport: t }
  );
  assert.ok(t.written.includes("AUTH LOGIN"), "fell back to AUTH LOGIN");
});

await test("smtp: bad credentials throw", async () => {
  const t = fakeTransport([GREETING, EHLO_OK, AUTH_PLAIN_BAD, AUTH_LOGIN_CHALLENGE, [535, ["bad"]]]);
  await assert.rejects(
    () => sendMail({ host: "h", user: "u", pass: "wrong", from: "a@b.c", to: "a@b.c", subject: "s", text: "t" }, { transport: t }),
    /AUTH/i
  );
});

await test("smtp: rejected recipient throws", async () => {
  const t = fakeTransport([GREETING, EHLO_OK, AUTH_PLAIN_OK, MAIL_OK, RCPT_BAD]);
  await assert.rejects(
    () => sendMail({ host: "h", user: "u", pass: "p", from: "a@b.c", to: "nope@b.c", subject: "s", text: "t" }, { transport: t }),
    /RCPT TO failed/
  );
});

await test("smtp: missing fields throw before connecting", async () => {
  await assert.rejects(() => sendMail({ host: "h", user: "u" }, { transport: fakeTransport([]) }), /required/);
});

// --- harness ------------------------------------------------------------------

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cognos-insights-test-"));
_resetVaultKeyCache();
const h = await bootHarness({ COGNOS_DATA_DIR: dataDir });
const query = (text, params = []) => h.sql(text, params);
const dbf = { query };

try {
  const ws = (await h.sql(`SELECT id FROM workspaces LIMIT 1`))[0];
  assert.ok(ws, "a workspace exists after warm-up");
  const wsId = ws.id;

  // --- email store ------------------------------------------------------------

  await test("store: rejects a bad email address", async () => {
    await assert.rejects(() => setCredentials(dbf, wsId, { email_address: "not-an-email", app_password: "abcdefghijklmnop" }), /email address/);
  });

  await test("store: requires an app password", async () => {
    await assert.rejects(() => setCredentials(dbf, wsId, { email_address: "cognos@gmail.com", app_password: "" }), /app password is required/);
  });

  await test("store: saves credentials encrypted and never returns the secret", async () => {
    const cfg = await setCredentials(dbf, wsId, { email_address: "Cognos@Gmail.com", app_password: "abcd efgh ijkl mnop" });
    assert.equal(cfg.configured, true);
    assert.equal(cfg.email_address, "cognos@gmail.com", "address normalized");
    assert.equal(cfg.has_password, true);
    assert.ok(!("app_password" in cfg) && !("app_password_enc" in cfg), "no secret in the public view");
    const rows = await h.sql(`SELECT app_password_enc FROM insights_email_config WHERE workspace_id = $1`, [wsId]);
    assert.ok(rows[0].app_password_enc.startsWith("v1."), "stored as a vault envelope");
    assert.ok(!rows[0].app_password_enc.includes("abcdefgh"), "no plaintext in the row");
    const creds = await getSendCredentials(dbf, wsId);
    assert.equal(creds.address, "cognos@gmail.com");
    assert.equal(creds.password, "abcdefghijklmnop", "decrypts back (spaces stripped)");
  });

  await test("store: getConfig never leaks the password", async () => {
    const cfg = await getConfig(dbf, wsId);
    assert.equal(JSON.stringify(cfg).includes("abcdefgh"), false, "serialized config has no secret");
  });

  await test("store: updating the address keeps the existing password", async () => {
    const cfg = await setCredentials(dbf, wsId, { email_address: "cognos2@gmail.com", app_password: "" });
    assert.equal(cfg.email_address, "cognos2@gmail.com");
    assert.equal(cfg.has_password, true, "password kept");
    const creds = await getSendCredentials(dbf, wsId);
    assert.equal(creds.password, "abcdefghijklmnop");
    // restore
    await setCredentials(dbf, wsId, { email_address: "cognos@gmail.com", app_password: "" });
  });

  await test("store: schedule validates the send time", async () => {
    await assert.rejects(() => setSchedule(dbf, wsId, { enabled: true, send_time: "25:99" }), /HH:MM/);
    await assert.rejects(() => setSchedule(dbf, wsId, { enabled: true, send_time: "7am" }), /HH:MM/);
    const cfg = await setSchedule(dbf, wsId, { enabled: true, send_time: "06:30" });
    assert.equal(cfg.send_time, "06:30");
    assert.equal(cfg.enabled, true);
  });

  await test("store: clearing the password unconfigures the digest", async () => {
    const cfg = await clearPassword(dbf, wsId);
    assert.equal(cfg.has_password, false);
    assert.equal(cfg.configured, false);
    const creds = await getSendCredentials(dbf, wsId);
    assert.equal(creds, null);
    // restore for later tests
    await setCredentials(dbf, wsId, { email_address: "cognos@gmail.com", app_password: "abcdefghijklmnop" });
  });

  await test("store: run journal records the lifecycle", async () => {
    const id = await startRun(dbf, wsId);
    await finishRun(dbf, id, { status: "sent", subject: "s", preview: "p" });
    const last = await lastRun(dbf, wsId);
    assert.equal(last.id, id);
    assert.equal(last.status, "sent");
    assert.equal(last.subject, "s");
  });

  // --- schedule ---------------------------------------------------------------

  // 2026-10-05 is a Monday. Times below are UTC; EDT = UTC-4 in October.
  const monday0700edt = Date.UTC(2026, 9, 5, 11, 0, 0); // 07:00 EDT
  const monday0630edt = Date.UTC(2026, 9, 5, 10, 30, 0); // 06:30 EDT
  const monday0800edt = Date.UTC(2026, 9, 5, 12, 0, 0); // 08:00 EDT

  await setSchedule(dbf, wsId, { enabled: true, send_time: "07:00" });
  // (re)configure so the schedule tests have credentials
  await setCredentials(dbf, wsId, { email_address: "cognos@gmail.com", app_password: "abcdefghijklmnop" });

  await test("schedule: due past the send time when nothing sent today", async () => {
    assert.equal(await insightsDue(dbf, wsId, monday0800edt), true);
  });

  await test("schedule: not due before the send time", async () => {
    assert.equal(await insightsDue(dbf, wsId, monday0630edt), false);
  });

  await test("schedule: not due twice on the same New York day", async () => {
    const id = await startRun(dbf, wsId, monday0700edt);
    await finishRun(dbf, id, { status: "sent", nowMs: monday0700edt + 1000 });
    assert.equal(await insightsDue(dbf, wsId, monday0800edt), false, "already sent today");
    // but a failed run does not block the retry
    const id2 = await startRun(dbf, wsId, monday0700edt + 2000);
    await finishRun(dbf, id2, { status: "failed", error: "boom", nowMs: monday0700edt + 3000 });
    assert.equal(await insightsDue(dbf, wsId, monday0800edt), false, "a sent run earlier today still blocks");
  });

  // Tuesday timestamps: a fresh New York day with no sent run on it.
  const tuesday0800edt = Date.UTC(2026, 9, 6, 12, 0, 0); // 08:00 EDT
  await test("schedule: a failed attempt backs off instead of hammering", async () => {
    const id = await startRun(dbf, wsId, tuesday0800edt - 10 * 60 * 1000);
    await finishRun(dbf, id, { status: "failed", error: "x", nowMs: tuesday0800edt - 10 * 60 * 1000 });
    assert.equal(await insightsDue(dbf, wsId, tuesday0800edt), false, "10 minutes after a failure: quiet");
    assert.equal(await insightsDue(dbf, wsId, tuesday0800edt + 31 * 60 * 1000), true, "31 minutes after: retries");
  });

  await test("schedule: quiet when paused or unconfigured", async () => {
    await setSchedule(dbf, wsId, { enabled: false, send_time: "07:00" });
    assert.equal(await insightsDue(dbf, wsId, monday0800edt), false, "paused");
    await setSchedule(dbf, wsId, { enabled: true, send_time: "07:00" });
    await clearPassword(dbf, wsId);
    assert.equal(await insightsDue(dbf, wsId, monday0800edt), false, "no password");
    await setCredentials(dbf, wsId, { email_address: "cognos@gmail.com", app_password: "abcdefghijklmnop" });
  });

  // --- digest run ---------------------------------------------------------------

  const fullDb = {
    query,
    AutonomyAgent: {
      create: async (data) => {
        const id = data.id || newId("agt");
        const rows = await query(
          `INSERT INTO autonomy_agents
             (id, workspace_id, name, slug, purpose, brief, brief_version, skill_allowlist, default_scope, default_budgets, heartbeat_interval_ms, enabled)
           VALUES ($1,$2,$3,$4,$5,$6,1,'[]','{}','{}',900000,TRUE) RETURNING *`,
          [id, data.workspace_id, data.name, data.slug, data.purpose || null, String(data.brief || "")]
        );
        return rows[0];
      },
    },
  };

  await test("digest: ensures the Insights resident (visible in Studio)", async () => {
    const r = await ensureInsightsResident(fullDb, wsId);
    assert.equal(r.slug, INSIGHTS_RESIDENT_SLUG);
    assert.equal(r.enabled, true);
    const again = await ensureInsightsResident(fullDb, wsId);
    assert.equal(again.id, r.id, "idempotent — no duplicate resident");
  });

  await test("digest: gathers facts across the stores", async () => {
    await h.sql(
      `INSERT INTO memories (id, workspace_id, content, memory_type, importance, is_enabled) VALUES ($1, $2, 'Jeremy fixed the fence', 'events', 8, TRUE)`,
      [newId("mem"), wsId]
    );
    await h.sql(
      `INSERT INTO autonomy_goals (id, workspace_id, title, objective, status) VALUES ($1, $2, 'Finish the shed', 'obj', 'active')`,
      [newId("goal"), wsId]
    );
    const facts = await gatherFacts(fullDb, wsId, { sinceMs: Date.now() - 3600_000 });
    assert.ok(facts.memories.count >= 1, "memories counted");
    assert.ok(facts.goals.active.some((g) => g.title === "Finish the shed"), "active goal listed");
    assert.ok(Array.isArray(facts.ledger), "ledger present");
  });

  await test("digest: skipped honestly when email is not configured", async () => {
    await clearPassword(dbf, wsId);
    let mailed = false;
    const result = await runInsightsDigest({
      db: fullDb, workspaceId: wsId, mailer: async () => { mailed = true; },
      llmCall: async () => "digest",
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, "not_configured");
    assert.equal(mailed, false, "no email attempted");
    const skipped = await h.sql(`SELECT status FROM insights_digest_runs WHERE id = $1`, [result.runId]);
    assert.equal(skipped[0].status, "skipped");
    await setCredentials(dbf, wsId, { email_address: "cognos@gmail.com", app_password: "abcdefghijklmnop" });
  });

  await test("digest: halted by the kill switch", async () => {
    delete process.env.COGNOS_AUTONOMY_ENABLED;
    await setSchedule(dbf, wsId, { enabled: true, send_time: "07:00" });
    let mailed = false;
    const result = await runInsightsDigest({
      db: fullDb, workspaceId: wsId, mailer: async () => { mailed = true; },
      llmCall: async () => "digest",
    });
    assert.equal(result.skipped, "killed");
    assert.equal(mailed, false);
    process.env.COGNOS_AUTONOMY_ENABLED = "true";
  });

  await test("digest: sends to the configured address only", async () => {
    await setSchedule(dbf, wsId, { enabled: true, send_time: "07:00" });
    const sent = [];
    const result = await runInsightsDigest({
      db: fullDb, workspaceId: wsId,
      mailer: async (opts) => { sent.push(opts); return { ok: true }; },
      llmCall: async () => "Good morning — quiet day. Nothing needs you.",
    });
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "cognos@gmail.com", "recipient is the configured address");
    assert.equal(sent[0].from, "cognos@gmail.com");
    assert.ok(!("recipient" in sent[0]) || sent[0].to === "cognos@gmail.com", "no free-form recipient");
    assert.ok(sent[0].subject.includes("Daily Insights"), "subject labeled");
    assert.ok(sent[0].text.length > 10, "body composed");
    const sentRow = await h.sql(`SELECT status FROM insights_digest_runs WHERE id = $1`, [result.runId]);
    assert.equal(sentRow[0].status, "sent");
  });

  await test("digest: a failed send is recorded visibly, not silent", async () => {
    const result = await runInsightsDigest({
      db: fullDb, workspaceId: wsId,
      mailer: async () => { throw new Error("535 bad credentials"); },
      llmCall: async () => "digest",
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /535/);
    const failedRow = await h.sql(`SELECT status, error FROM insights_digest_runs WHERE id = $1`, [result.runId]);
    assert.equal(failedRow[0].status, "failed");
    assert.match(failedRow[0].error, /535/);
  });

  await test("digest: falls back to a template when the model fails", async () => {
    const facts = { memories: { count: 2, highlights: [{ layer: "events", text: "fence fixed" }] }, goals: { active: [] }, ledger: [], conversations: { count_24h: 1 }, ideas: { fresh: [] }, outbox_awaiting: [], watches: [] };
    const text = await composeDigest(facts, { llmCall: async () => { throw new Error("model down"); }, dateLabel: "Monday" });
    assert.ok(text.includes("fence fixed"), "template carries the facts");
  });

  // --- routes ---------------------------------------------------------------------

  await test("routes: status never leaks the password", async () => {
    const r = await h.raw("/api/insights/email");
    assert.equal(r.status, 200);
    assert.equal(r.json.has_password, true);
    assert.equal(r.json.configured, true);
    assert.ok(!JSON.stringify(r.json).includes("abcdefgh"), "no secret in the response");
  });

  await test("routes: bad credentials are rejected with plain errors", async () => {
    const r = await h.raw("/api/insights/email", { method: "POST", body: { email_address: "bad", app_password: "x" } });
    assert.equal(r.status, 400);
    assert.ok(r.json.error, "plain error message");
  });

  await test("routes: saving credentials works and stays write-only", async () => {
    const r = await h.raw("/api/insights/email", { method: "POST", body: { email_address: "cognos@gmail.com", app_password: "abcdefghijklmnop" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.has_password, true);
    assert.ok(!JSON.stringify(r.json).includes("abcdefgh"));
  });

  await test("routes: bad send time is rejected", async () => {
    const r = await h.raw("/api/insights/email/schedule", { method: "POST", body: { enabled: true, send_time: "nope" } });
    assert.equal(r.status, 400);
  });

  await test("routes: manual run is refused honestly when unconfigured", async () => {
    await clearPassword(dbf, wsId);
    const r = await h.raw("/api/insights/email/run", { method: "POST" });
    assert.equal(r.status, 409);
    assert.equal(r.json.skipped, "not_configured");
    await setCredentials(dbf, wsId, { email_address: "cognos@gmail.com", app_password: "abcdefghijklmnop" });
  });

  console.log(`\ninsights-email: ${passed} passed`);
} finally {
  delete process.env.COGNOS_AUTONOMY_ENABLED;
  await h.stop();
}
