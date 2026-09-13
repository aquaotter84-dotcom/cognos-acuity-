// Phase 24 — "Sign in with Google".
//
// Two flows land here:
//   1. Classic OAuth 2.0 authorization-code flow (web sign-in button):
//        /api/accounts/auth/google/start    -> 302 to Google's consent screen
//        /api/accounts/auth/google/callback -> code exchanged for an id_token
//   2. Google Identity Services (One Tap / the GIS button), where the browser
//      already holds a credential (an id_token) and posts it straight to
//        /api/accounts/auth/google/verify
//
// The id_token is verified LOCALLY against Google's published JWKS:
//   * RS256 signature checked with node:crypto (JWK imported directly — the
//     same dependency-free posture as the rest of Phase 24)
//   * iss restricted to Google's two documented issuer values
//   * aud must equal GOOGLE_CLIENT_ID (azp checked when present)
//   * exp honoured with 60s clock leeway; future iat refused
//   * nonce (when the flow started one) must match — replay defence
//   * email_verified must be true BEFORE a Google identity may link to an
//     existing local account. Google documents this as the account-squatting
//     defence; skipping it is the classic OAuth account-takeover bug.
//
// Endpoint URLs are env-overridable (GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL /
// GOOGLE_JWKS_URL) so tests can point them at a local mock. The JWKS fetcher
// is also injectable (verifyIdToken({ fetchJwks })).

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

// Endpoint URLs resolve at CALL time (not module load) so tests and
// self-hosted deployments can point them at a local mock without restarting.
const ISSUERS = Object.freeze(["https://accounts.google.com", "accounts.google.com"]);
const CLOCK_LEEWAY_S = 60;
const JWKS_TTL_MS = 60 * 60 * 1000; // refresh Google's keys hourly at most

export function googleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    authUrl: process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
    jwksUrl: process.env.GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs"
  };
}

/** True when the deployment configured Google sign-in. Drives /health and 501s. */
export function googleConfigured() {
  const { clientId, clientSecret } = googleConfig();
  return Boolean(clientId && clientSecret);
}

function notConfigured() {
  const err = new Error("Google sign-in is not configured on this deployment (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).");
  err.status = 501;
  err.code = "google_not_configured";
  return err;
}

/**
 * The consent-screen URL. state + nonce are minted by the route and persisted
 * (google_auth_states) before this URL is handed out.
 */
export function buildAuthorizeUrl({ state, nonce, redirectUri, loginHint = null }) {
  const { clientId, authUrl } = googleConfig();
  if (!clientId) throw notConfigured();
  const url = new URL(authUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  if (loginHint) url.searchParams.set("login_hint", String(loginHint).slice(0, 200));
  return url.toString();
}

/** Exchange an authorization code for tokens at Google's token endpoint. */
export async function exchangeCodeForIdToken({ code, redirectUri, fetchImpl = fetch } = {}) {
  const { clientId, clientSecret, tokenUrl } = googleConfig();
  if (!clientId || !clientSecret) throw notConfigured();
  const body = new URLSearchParams({
    code: String(code || ""),
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.id_token) {
    const err = new Error(`Google token exchange failed (${res.status})`);
    err.status = 401;
    err.code = "google_exchange_failed";
    throw err;
  }
  return json;
}

// --- JWKS cache ---------------------------------------------------------------

let jwksCache = { keys: [], fetchedAtMs: 0, url: null };

async function defaultFetchJwks(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const err = new Error(`Could not fetch signing keys (${res.status})`);
    err.status = 401;
    err.code = "jwks_unavailable";
    throw err;
  }
  return res.json();
}

function selectKey(jwks, kid) {
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  return keys.find(k => k?.kid === kid && (k?.kty === "RSA" || k?.kty === "rsa")) || null;
}

/** RS256 signature check: import the JWK, verify over header.payload. */
function verifyRs256(jwk, signingInput, signatureB64url) {
  let key;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return false;
  }
  const data = Buffer.from(signingInput, "ascii");
  const sig = Buffer.from(signatureB64url, "base64url");
  return cryptoVerify("RSA-SHA256", data, key, sig);
}

function claimChecks(payload, { clientId, expectedNonce }) {
  const fail = (code, reason) => {
    const err = new Error(`Google id_token rejected: ${reason}`);
    err.status = 401;
    err.code = code;
    throw err;
  };
  if (!ISSUERS.includes(payload.iss)) fail("bad_issuer", `issuer ${payload.iss} is not Google`);
  if (payload.aud !== clientId) fail("bad_audience", "audience is not this deployment's client id");
  if (Array.isArray(payload.aud) ? true : false) fail("bad_audience", "multi-audience tokens are refused");
  if (payload.azp && payload.azp !== clientId) fail("bad_audience", "authorized party is not this deployment");
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || nowSec - CLOCK_LEEWAY_S >= payload.exp) fail("expired", "token expired");
  if (!Number.isFinite(payload.iat) || payload.iat > nowSec + CLOCK_LEEWAY_S) fail("future_issued", "issued in the future");
  if (expectedNonce !== undefined && expectedNonce !== null) {
    if (!payload.nonce || payload.nonce !== expectedNonce) fail("bad_nonce", "nonce does not match the started flow (possible replay)");
  }
  return payload;
}

/**
 * Verify a Google id_token end to end. Returns the claim set (sub, email,
 * email_verified, name, picture, nonce...) on success; throws { status: 401 }.
 */
export async function verifyIdToken({ idToken, expectedNonce = null, fetchJwks = null, fetchImpl = fetch, forceJwksRefresh = false } = {}) {
  const { clientId, jwksUrl } = googleConfig();
  if (!clientId) throw notConfigured();
  const fail = (code, reason) => {
    const err = new Error(`Google id_token rejected: ${reason}`);
    err.status = 401;
    err.code = code;
    throw err;
  };

  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return fail("malformed", "not a JWT");
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return fail("undecodable", "could not decode token");
  }
  // Algorithm confusion is the classic JWT pitfall: only RS256, always.
  if (header?.alg !== "RS256") return fail("bad_algorithm", `algorithm ${header?.alg} refused`);
  if (!header?.kid) return fail("bad_key", "missing kid");

  const fetcher = fetchJwks || ((url) => defaultFetchJwks(url, fetchImpl));
  const now = Date.now();
  const cacheIsFresh = jwksCache.url === jwksUrl && (now - jwksCache.fetchedAtMs) < JWKS_TTL_MS;
  let jwk = null;
  if (cacheIsFresh && !forceJwksRefresh) {
    jwk = selectKey(jwksCache, header.kid);
  }
  if (!jwk) {
    // Unknown kid or stale cache: force one refresh (Google rotates keys).
    const fresh = await fetcher(jwksUrl);
    if (!fresh || !Array.isArray(fresh.keys)) return fail("bad_keys", "signing keys unavailable");
    jwksCache = { keys: fresh.keys, fetchedAtMs: Date.now(), url: jwksUrl };
    jwk = selectKey(jwksCache, header.kid);
  }
  if (!jwk) return fail("unknown_key", "signed by a key Google does not publish");

  if (!verifyRs256(jwk, `${parts[0]}.${parts[1]}`, parts[2])) {
    return fail("bad_signature", "signature does not verify");
  }
  return claimChecks(payload, { clientId, expectedNonce });
}

/** Test hook: drop the JWKS cache so a test can serve fresh keys. */
export function resetJwksCache() {
  jwksCache = { keys: [], fetchedAtMs: 0, url: null };
}
