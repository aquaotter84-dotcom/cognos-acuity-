// Phase 24 route module — /api/accounts/*, the multi-tenant front door.
//
//   POST /api/accounts/register                 email + password sign-up
//   POST /api/accounts/login                    email + password sign-in
//   POST /api/accounts/logout                   revokes the bearer token (jti -> blocklist)
//   GET  /api/accounts/me                       profile + authoritative facts
//   GET  /api/accounts/auth/google/start        "Sign in with Google" — consent redirect (or JSON url)
//   GET  /api/accounts/auth/google/callback     OAuth code -> account -> token
//   POST /api/accounts/auth/google/verify       GIS/One Tap credential (id_token) -> account -> token
//
// Everything under /api/accounts is exempt from the deployment's cookie gate
// (see server/index.js): these routes ARE the authentication layer and carry
// their own protections — scrypt password hashing, a bounded login throttle,
// single-use CSRF state for the Google redirect flow, and JWT verification.
//
// Trusted-fact rule (see server/accounts/facts.js): the ONLY user facts this
// module asserts come from trusted Atlas rows, cited by graph id in every
// response that carries them.

import { randomBytes } from "node:crypto";
import { createAccountService } from "../accounts/service.js";
import { signJwt, verifyJwt } from "../accounts/jwt.js";
import {
  googleConfigured, buildAuthorizeUrl, exchangeCodeForIdToken, verifyIdToken
} from "../accounts/google.js";
import { authoritativeFacts } from "../accounts/facts.js";

/** The request's origin, proxy-aware, for OAuth redirect defaults. */
function requestOrigin(req) {
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000").split(",")[0].trim();
  return `${proto}://${host}`;
}

export function createAuthMiddleware({ db }) {
  /**
   * Bearer-token authentication. On success req.auth = { userId, workspaceId,
   * jti, email, claims, account } — the `ws` claim is the ONLY workspace the
   * request may touch, and it is re-checked against the account's current
   * binding so a workspace reassignment invalidates outstanding tokens.
   */
  return async function requireAuth(req, res, next) {
    try {
      const header = String(req.headers.authorization || "");
      const bearer = header.match(/^Bearer\s+(.+)$/i);
      const token = bearer ? bearer[1].trim() : null;
      if (!token) {
        return res.status(401).json({ error: "Missing bearer token", code: "no_token" });
      }
      const claims = verifyJwt(token); // throws 401 on signature/expiry/shape
      const revoked = await db.AuthBlocklist.has(claims.jti);
      if (revoked) {
        return res.status(401).json({ error: "Token has been revoked (logged out)", code: "token_revoked" });
      }
      const account = await db.Accounts.byId(claims.sub);
      if (!account || account.status !== "active") {
        return res.status(401).json({ error: "Account not found or disabled", code: "account_unavailable" });
      }
      if (account.workspace_id !== claims.ws) {
        // The token binds a workspace; if the account moved, force a fresh
        // sign-in so no stale binding survives a workspace revocation.
        return res.status(401).json({
          error: "Token workspace binding is stale; sign in again",
          code: "stale_workspace_binding"
        });
      }
      req.auth = {
        userId: account.id,
        workspaceId: claims.ws,
        jti: claims.jti,
        email: account.email,
        claims,
        account
      };
      return next();
    } catch (err) {
      if (err?.status === 401) {
        return res.status(401).json({ error: err.message, code: err.code || "invalid_token" });
      }
      return next(err);
    }
  };
}

export function registerAccountRoutes(app, { wrap, db, logger }) {
  const service = createAccountService({ db, logger });
  const requireAuth = createAuthMiddleware({ db });

  const tokenResponse = (account, { created = false, linked = false } = {}) => ({
    access_token: service.issueToken(account).token,
    token_type: "Bearer",
    account: {
      user_id: account.id,
      email: account.email,
      display_name: account.display_name,
      auth_provider: account.auth_provider,
      workspace_id: account.workspace_id,
      workspace_namespace: `ws-${account.workspace_id}`
    },
    ...(created || linked ? { google: { created, linked } } : {})
  });

  // --- register ---------------------------------------------------------------
  app.post("/api/accounts/register", wrap(async (req, res) => {
    const { email, password, display_name: displayName = null } = req.body || {};
    const { account, workspace } = await service.registerAccount({
      email, password, displayName, ip: req.ip
    });
    res.status(201).json({
      ...tokenResponse(account),
      workspace: { id: workspace.id, name: workspace.name, namespace: `ws-${workspace.id}` }
    });
  }));

  // --- login (email) ------------------------------------------------------------
  app.post("/api/accounts/login", wrap(async (req, res) => {
    const { email, password } = req.body || {};
    const account = await service.authenticateEmail({ email, password, ip: req.ip });
    res.json(tokenResponse(account));
  }));

  // --- logout (JWT revocation) ---------------------------------------------------
  app.post("/api/accounts/logout", requireAuth, wrap(async (req, res) => {
    const expMs = Number(req.auth.claims.exp) * 1000;
    await db.AuthBlocklist.add(req.auth.jti, req.auth.userId, new Date(expMs));
    await service.audit(req.auth, req.auth.workspaceId, "account.logout", req.auth.userId, { jti: req.auth.jti });
    res.json({ ok: true, revoked: req.auth.jti, revoked_until: new Date(expMs).toISOString() });
  }));

  // --- me --------------------------------------------------------------------
  app.get("/api/accounts/me", requireAuth, wrap(async (req, res) => {
    const workspace = await db.Workspace.get(req.auth.workspaceId);
    const profile = service.buildProfile(req.auth.account, workspace);
    res.json({
      ...profile,
      // The full annotated registry of trusted facts this deployment asserts
      // (each entry cites its Atlas graph id; see server/accounts/facts.js).
      trusted_atlas_facts: authoritativeFacts()
    });
  }));

  // --- Google: status ------------------------------------------------------------
  app.get("/api/accounts/auth/google/status", wrap(async (req, res) => {
    res.json({
      configured: googleConfigured(),
      client_id: process.env.GOOGLE_CLIENT_ID || null, // public value; safe to expose
      verify_mode: googleConfigured() ? "jwks_rs256" : null
    });
  }));

  // --- Google: start the authorization-code flow ---------------------------------
  app.get("/api/accounts/auth/google/start", wrap(async (req, res) => {
    if (!googleConfigured()) {
      return res.status(501).json({
        error: "Google sign-in is not configured on this deployment (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).",
        code: "google_not_configured"
      });
    }
    const state = randomBytes(24).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    await db.AuthState.put(state, nonce);
    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || `${requestOrigin(req)}/api/accounts/auth/google/callback`;
    const authorizeUrl = buildAuthorizeUrl({ state, nonce, redirectUri, loginHint: req.query.login_hint || null });

    // Browsers get the redirect; API clients (and the SPA) can ask for JSON.
    const wantsJson = req.query.format === "json" || String(req.headers.accept || "").includes("application/json") && !req.query.redirect;
    if (wantsJson) {
      return res.json({ authorize_url: authorizeUrl, state, expires_in: 600 });
    }
    return res.redirect(authorizeUrl);
  }));

  // --- Google: OAuth callback -----------------------------------------------------
  app.get("/api/accounts/auth/google/callback", wrap(async (req, res) => {
    if (!googleConfigured()) {
      return res.status(501).json({ error: "Google sign-in is not configured.", code: "google_not_configured" });
    }
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      return res.status(401).json({ error: `Google refused the flow: ${String(oauthError).slice(0, 120)}`, code: "google_denied" });
    }
    if (!code || !state) {
      return res.status(400).json({ error: "callback needs code and state", code: "callback_incomplete" });
    }
    // Single-use CSRF state: read live, then consume atomically.
    const live = await db.AuthState.getLive(String(state));
    if (!live) {
      return res.status(401).json({ error: "Unknown, expired, or already-used state", code: "bad_state" });
    }
    const consumed = await db.AuthState.consume(String(state));
    if (!consumed) {
      return res.status(401).json({ error: "State already used", code: "bad_state" });
    }

    const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || `${requestOrigin(req)}/api/accounts/auth/google/callback`;
    const tokens = await exchangeCodeForIdToken({ code: String(code), redirectUri });
    const payload = await verifyIdToken({ idToken: tokens.id_token, expectedNonce: live.nonce });
    const { account, created, linked } = await service.upsertGoogleAccount({ payload });

    // Frontend handoff: an explicit COGNOS_OAUTH_REDIRECT_TO bounces the token
    // in the URL FRAGMENT (fragments never reach a server, logs, or proxies).
    // Default is a plain JSON response for API clients and tests.
    const frontend = process.env.COGNOS_OAUTH_REDIRECT_TO;
    if (frontend) {
      const target = new URL(frontend, requestOrigin(req));
      target.hash = `access_token=${encodeURIComponent(service.issueToken(account).token)}`;
      return res.redirect(target.toString());
    }
    res.json({ ...tokenResponse(account, { created, linked }) });
  }));

  // --- Google: GIS / One Tap credential --------------------------------------------
  app.post("/api/accounts/auth/google/verify", wrap(async (req, res) => {
    if (!googleConfigured()) {
      return res.status(501).json({ error: "Google sign-in is not configured.", code: "google_not_configured" });
    }
    const credential = req.body?.credential;
    const nonce = req.body?.nonce || null;
    if (!credential) {
      return res.status(400).json({ error: "body needs a Google credential (id_token)", code: "credential_required" });
    }
    const payload = await verifyIdToken({ idToken: String(credential), expectedNonce: nonce });
    const { account, created, linked } = await service.upsertGoogleAccount({ payload });
    res.json(tokenResponse(account, { created, linked }));
  }));

  // --- the rest of the Phase 24 surface lives in routes/workspaces.js --------------
  return { service, requireAuth };
}
