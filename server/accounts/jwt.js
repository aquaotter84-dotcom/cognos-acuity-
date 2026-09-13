// Phase 24 — JSON Web Tokens, with zero dependencies.
//
// The brief asked for JWT auth carrying `sub` (user id) and `ws` (workspace
// id) claims. This module signs and verifies HS256 tokens using node:crypto
// only — no jsonwebtoken dependency, no algorithm-confusion surface: the
// verifier accepts exactly one algorithm (HS256) and compares signatures in
// constant time.
//
// Secret resolution order (fail-soft for dev, explicit for production):
//   1. COGNOS_JWT_SECRET   — the dedicated signing secret (recommended)
//   2. COGNOS_RUNTIME_SECRET — the existing deployment gate secret
//   3. an ephemeral per-process secret — fine for tests and previews; a loud
//      warning is logged once because tokens will not survive a restart and
//      multi-instance deployments would not accept each other's tokens.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ISSUER = "cognos-accounts";
const AUDIENCE = "cognos-api";
const ALGORITHM = "HS256";
const CLOCK_LEEWAY_S = 30;

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const MIN_TTL_MS = 5 * 60 * 1000;           // 5m
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;// 30d

let ephemeralSecret = null;
let warnedEphemeral = false;

export function resolveJwtSecret() {
  const configured = process.env.COGNOS_JWT_SECRET || process.env.COGNOS_RUNTIME_SECRET || "";
  if (configured && configured.length >= 16) return configured;
  if (configured) {
    // Present but too short to be honest security. Fail closed for signing.
    const err = new Error("COGNOS_JWT_SECRET must be at least 16 characters");
    err.status = 500;
    throw err;
  }
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(48).toString("base64url");
    if (!warnedEphemeral) {
      warnedEphemeral = true;
      console.warn(JSON.stringify({
        level: "warn", component: "accounts.jwt",
        message: "No COGNOS_JWT_SECRET configured — using an EPHEMERAL per-process secret. Tokens are invalidated by every restart; set COGNOS_JWT_SECRET for anything real."
      }));
    }
  }
  return ephemeralSecret;
}

export function resolveTokenTtlMs() {
  const raw = Number(process.env.COGNOS_JWT_TTL_MS || DEFAULT_TTL_MS);
  if (!Number.isFinite(raw)) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.trunc(raw)));
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function hmac(data, secret) {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Mint an access token.
 * claims.sub — the account id (user_id, UUID)
 * claims.ws  — the bound workspace id; the ONLY workspace the bearer may touch
 * Every token carries a unique jti so logout can revoke it individually.
 */
export function signJwt({ sub, ws, email = null, ttlMs = null, extra = {} } = {}) {
  if (!sub || !ws) throw new Error("signJwt requires sub (user_id) and ws (workspace_id)");
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(ttlMs || resolveTokenTtlMs()) || DEFAULT_TTL_MS));
  const header = { alg: ALGORITHM, typ: "JWT", kid: "cognos-hs256-v1" };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: String(sub),
    ws: String(ws),
    email: email || null,
    jti: randomBytes(16).toString("hex"),
    iat: nowSec,
    exp: nowSec + Math.floor(ttl / 1000),
    ...extra
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = hmac(signingInput, resolveJwtSecret());
  return { token: `${signingInput}.${signature}`, payload };
}

/**
 * Verify a token's structure, signature, and time window. Returns the payload
 * or throws { status: 401 }. Only HS256 is ever accepted.
 */
export function verifyJwt(token) {
  const fail = (reason) => {
    const err = new Error(`Invalid token: ${reason}`);
    err.status = 401;
    err.code = "invalid_token";
    throw err;
  };
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return fail("malformed");
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return fail("undecodable");
  }
  if (header?.alg !== ALGORITHM) return fail(`algorithm ${header?.alg} refused`);
  if (header?.typ !== "JWT") return fail("wrong typ");
  const expected = hmac(`${parts[0]}.${parts[1]}`, resolveJwtSecret());
  const given = Buffer.from(parts[2], "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return fail("bad signature");
  if (payload.iss !== ISSUER) return fail("wrong issuer");
  if (payload.aud !== AUDIENCE) return fail("wrong audience");
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || nowSec - CLOCK_LEEWAY_S >= payload.exp) return fail("expired");
  if (!Number.isFinite(payload.iat) || payload.iat > nowSec + CLOCK_LEEWAY_S) return fail("issued in the future");
  if (!payload.sub || !payload.ws || !payload.jti) return fail("missing sub/ws/jti");
  return payload;
}
