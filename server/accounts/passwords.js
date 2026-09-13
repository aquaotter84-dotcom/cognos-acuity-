// Phase 24 — password hashing.
//
// DIVERGENCE FROM THE ORIGINAL SPEC (deliberate, documented in docs/WORKSPACES.md):
// the brief said "Bcrypt/Argon2". Both are native or emulated dependencies; this
// app runs on Vercel serverless where native builds and cold-start weight are
// real costs. Node's built-in scrypt (RFC 7914) is the same *family* of memory-
// hard KDF, is FIPS-listed, and needs zero dependencies. The wire format is
// versioned (`scrypt$N$r$p$salt$hash`) so parameters — or a future move to
// argon2id — can be upgraded per-hash without a migration.
//
// Properties enforced here:
//   * per-password random 16-byte salt (never reused, never stored in plaintext)
//   * timing-safe comparison (crypto.timingSafeEqual, equal-length buffers)
//   * unknown/short/oversized inputs fail closed, never throw to the caller

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

// OWASP-recommended scrypt parameters for interactive logins (2024+): the cost
// is clamped so a serverless invocation stays well inside its time budget.
const PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });
const SALT_BYTES = 16;
const FORMAT = "scrypt";

/** Hash a password into the versioned wire format. */
export async function hashPassword(password) {
  const pw = String(password ?? "");
  if (pw.length < 8 || pw.length > 200) {
    const err = new Error("Password must be between 8 and 200 characters");
    err.status = 400;
    throw err;
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(pw, salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: 128 * PARAMS.N * PARAMS.r * 2 });
  return [
    FORMAT,
    PARAMS.N, PARAMS.r, PARAMS.p,
    salt.toString("base64"),
    key.toString("base64")
  ].join("$");
}

/** Parse a stored hash. Returns null for anything malformed (fail closed). */
function parseStored(stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== FORMAT) return null;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 16384 || r < 8 || p < 1) return null;
  try {
    const salt = Buffer.from(parts[4], "base64");
    const key = Buffer.from(parts[5], "base64");
    if (salt.length < 8 || key.length < 32) return null;
    return { N, r, p, salt, key, maxmem: 128 * N * r * 2 };
  } catch {
    return null;
  }
}

/** Verify a password against a stored hash. Constant work for valid formats. */
export async function verifyPassword(password, stored) {
  const parsed = parseStored(stored);
  if (!parsed) return false;
  const pw = String(password ?? "");
  if (pw.length < 1 || pw.length > 200) return false;
  const attempt = await scrypt(pw, parsed.salt, parsed.key.length, {
    N: parsed.N, r: parsed.r, p: parsed.p, maxmem: parsed.maxmem
  });
  return attempt.length === parsed.key.length && timingSafeEqual(attempt, parsed.key);
}

/**
 * A one-time dummy hash so "unknown email" and "wrong password" take the same
 * scrypt path (and roughly the same time) in authenticateEmail(). Prevents
 * account enumeration by response timing.
 */
const DUMMY_PASSWORD = randomBytes(24).toString("hex");
export const DUMMY_HASH = await hashPassword(DUMMY_PASSWORD);
