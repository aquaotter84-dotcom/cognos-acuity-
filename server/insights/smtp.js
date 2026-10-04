// Minimal dependency-free SMTP client (Phase 38 — Daily Insights email).
//
// Sends via Gmail's SMTP with implicit TLS (smtp.gmail.com:465) and an app
// password. No nodemailer: the whole conversation (EHLO → AUTH → MAIL → RCPT
// → DATA → QUIT) is ~150 lines over node:tls, in the same spirit as the
// dependency-free vault in server/autonomy/vault.js.
//
// The transport is injectable: pass { transport } to drive the SMTP
// conversation over a fake socket in tests. Production uses
// createTlsTransport(). A plaintext transport exists only for tests against
// a local mock server — it is never used for real sends.
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";

const CRLF = "\r\n";

function b64(s) {
  return Buffer.from(String(s), "utf8").toString("base64");
}

function smtpDate() {
  return new Date().toUTCString();
}

function buildMessage({ from, to, subject, text }) {
  const safeSubject = String(subject ?? "").replace(/[\r\n]+/g, " ");
  // Dot-stuffing: a line starting with "." ends DATA early.
  const body = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => (line.startsWith(".") ? "." + line : line))
    .join(CRLF);
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    `Date: ${smtpDate()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join(CRLF);
}

/** A line-oriented transport over a socket. { write(line), readReply(), close() }. */
export function wrapSocket(socket, { timeoutMs = 20000 } = {}) {
  let buffer = "";
  const waiters = [];
  const pendingLines = [];
  socket.setTimeout(timeoutMs);
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    pump();
  });
  socket.on("error", (err) => fail(err));
  socket.on("timeout", () => fail(new Error("SMTP socket timed out")));
  socket.on("close", () => fail(new Error("SMTP connection closed unexpectedly")));

  function pump() {
    // SMTP replies can span lines: "250-..." continues, "250 ..." ends.
    const m = buffer.match(/(^|\r\n)(\d{3})([ -])([^\r\n]*)\r\n/);
    if (!m) return;
    const end = m.index + m[0].length;
    const code = Number(m[2]);
    const last = m[3] === " ";
    buffer = buffer.slice(end);
    // Collect multiline: keep reading until the terminating line.
    if (!last) {
      pendingLines.push(m[4]);
      pump();
      return;
    }
    const lines = [...pendingLines, m[4]];
    pendingLines.length = 0;
    const w = waiters.shift();
    if (w) w.resolve({ code, lines });
  }
  function fail(err) {
    const w = waiters.shift();
    if (w) w.reject(err);
    else socket.destroy();
  }
  return {
    write(line) {
      socket.write(line + CRLF);
    },
    readReply() {
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        pump();
      });
    },
    close() {
      socket.removeAllListeners();
      socket.end();
    },
  };
}

export function createTlsTransport({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host, port, servername: host, timeout: timeoutMs }, () => {
      resolve(wrapSocket(socket, { timeoutMs }));
    });
    socket.once("error", reject);
  });
}

export function createPlainTransport({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port, timeout: timeoutMs }, () => {
      resolve(wrapSocket(socket, { timeoutMs }));
    });
    socket.once("error", reject);
  });
}

async function expectOk(transport, command, label) {
  if (command !== null) transport.write(command);
  const { code, lines } = await transport.readReply();
  if (code < 200 || code >= 400) {
    throw new Error(`${label} failed: ${code} ${lines.join(" ")}`.slice(0, 300));
  }
  return { code, lines };
}

/**
 * Send one plaintext email.
 *
 * { host, port, user, pass, from, to, subject, text, timeoutMs }
 * { transport?, useTls? } — pass a fake transport in tests; otherwise a TLS
 * transport is opened (useTls: false opens plaintext — tests only).
 */
export async function sendMail(
  { host, port = 465, user, pass, from, to, subject, text, timeoutMs = 20000 },
  { transport = null, useTls = true } = {}
) {
  if (!host || !user || !pass || !from || !to) {
    throw new Error("sendMail: host, user, pass, from and to are all required");
  }
  const t =
    transport ||
    (useTls
      ? await createTlsTransport({ host, port, timeoutMs })
      : await createPlainTransport({ host, port, timeoutMs }));
  try {
    await expectOk(t, null, "greeting"); // 220 banner
    await expectOk(t, "EHLO cognos", "EHLO");
    // AUTH PLAIN first, AUTH LOGIN as fallback (Gmail accepts both).
    t.write(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`);
    let auth = await t.readReply();
    if (auth.code !== 235) {
      t.write("AUTH LOGIN");
      auth = await t.readReply();
      if (auth.code !== 334) throw new Error(`AUTH LOGIN rejected: ${auth.code}`.slice(0, 200));
      await expectOk(t, b64(user), "auth username");
      await expectOk(t, b64(pass), "auth password");
    }
    await expectOk(t, `MAIL FROM:<${from}>`, "MAIL FROM");
    await expectOk(t, `RCPT TO:<${to}>`, "RCPT TO");
    await expectOk(t, "DATA", "DATA");
    t.write(buildMessage({ from, to, subject, text }) + `${CRLF}.`);
    await expectOk(t, null, "message body");
    try {
      t.write("QUIT");
      await t.readReply().catch(() => {});
    } catch {
      /* QUIT is best-effort */
    }
    return { ok: true };
  } finally {
    t.close();
  }
}
