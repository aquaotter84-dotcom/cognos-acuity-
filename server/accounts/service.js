// Phase 24 — the account service (business rules behind the routes).
//
// Everything that must be *carefully* coded lives here rather than in the
// route module, so it is testable without HTTP:
//   * registerAccount — one transaction creates the account AND its default
//     private workspace (a workspace with no owner row can never exist).
//   * authenticateEmail — scrypt verification, dummy-hash timing equalization
//     for unknown emails, and a bounded failure throttle.
//   * upsertGoogleAccount — find by google_sub; link by verified email only;
//     never overwrite an existing google_sub; audit every path taken.
//   * issueToken — JWT bound to sub + ws exactly as the brief requires.

import { randomBytes, randomUUID } from "node:crypto";
import { createWorkspaceManager } from "../workspaces/manager.js";
import { hashPassword, verifyPassword, DUMMY_HASH } from "./passwords.js";
import { signJwt } from "./jwt.js";
import { DEFAULT_DISPLAY_NAME } from "./facts.js";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX = 30;

// In-memory throttle. Deliberately per-instance: on serverless each warm
// instance counts separately (documented in docs/WORKSPACES.md). It stops the
// single-instance brute force; a shared limiter is a Redis-shaped upgrade path.
const loginFailures = new Map();   // key -> { count, resetAtMs }
const registerCounts = new Map();  // key -> { count, resetAtMs }

function sweep(map, now) {
  for (const [k, v] of map) if (v.resetAtMs <= now) map.delete(k);
}

function throttleFailure(map, key, max, windowMs) {
  const now = Date.now();
  sweep(map, now);
  const entry = map.get(key) || { count: 0, resetAtMs: now + windowMs };
  entry.count += 1;
  map.set(key, entry);
  if (entry.count > max) {
    const err = new Error("Too many attempts. Try again later.");
    err.status = 429;
    err.code = "rate_limited";
    err.retryAfterSec = Math.max(1, Math.ceil((entry.resetAtMs - now) / 1000));
    throw err;
  }
}

function throttleOk(map, key) {
  map.delete(String(key || ""));
}

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export function createAccountService({ db, logger }) {

  // A private workspace is a real row in the existing `workspaces` table —
  // that is what makes the whole single-tenant stack (conversations, memories,
  // the Phase 23 atlas) work per-user with zero schema surgery.
  const manager = createWorkspaceManager({ db, logger });

  /**
   * Register an account. Creates the default private workspace in the SAME
   * transaction, so an account always points at an existing workspace.
   */
  async function registerAccount({ email, password, displayName = null, actor = "api", ip = null }) {
    const regKey = ip || "local";
    throttleFailure(registerCounts, `register:${regKey}`, REGISTER_MAX, REGISTER_WINDOW_MS);

    const normEmail = db.Accounts.normalizeEmail(email);
    if (typeof password !== "string" || password.length < 8) {
      throw httpError(400, "weak_password", "Password must be at least 8 characters");
    }
    const passwordHash = await hashPassword(password);

    const existing = await db.Accounts.byEmail(normEmail);
    if (existing) {
      throw httpError(409, "email_taken", "An account with this email already exists");
    }

    const result = await db.withTransaction(async (store) => {
      // Preferred name comes from trusted graph row [graph_mu02br2ofvew5mqm]
      // ("Patches"). A registration may pass an explicit display_name; the
      // deployment may override the default with COGNOS_DEFAULT_DISPLAY_NAME.
      const resolvedName = (displayName && String(displayName).trim())
        || process.env.COGNOS_DEFAULT_DISPLAY_NAME
        || DEFAULT_DISPLAY_NAME;

      const ws = await store.Workspace.create({
        id: randomUUID(), // the brief's workspace-<uuid> shape for private workspaces
        name: `Workspace ${resolvedName}`.slice(0, 80),
        description: `Private workspace (ws-<workspace_id> namespace) created at registration.`
      });
      const account = await store.Accounts.create({
        email: normEmail,
        displayName: resolvedName,
        passwordHash,
        provider: "email",
        workspaceId: ws.id
      });
      await store.WorkspaceAudit.append({
        userId: account.id, workspaceId: ws.id,
        action: "account.register", resourceId: account.id,
        detail: { email: normEmail, provider: "email", workspace_namespace: `ws-${ws.id}` },
        tsMs: Date.now()
      });
      await store.WorkspaceAudit.append({
        userId: account.id, workspaceId: ws.id,
        action: "workspace.created", resourceId: ws.id,
        detail: { namespace: `ws-${ws.id}`, kind: "private" },
        tsMs: Date.now()
      });
      return { account, workspace: ws };
    });

    throttleOk(registerCounts, `register:${regKey}`);
    return result;
  }

  /** Email + password sign-in. */
  async function authenticateEmail({ email, password, ip = null }) {
    const normEmail = db.Accounts.normalizeEmail(email);
    const key = `login:${normEmail}:${ip || "local"}`;
    throttleFailure(loginFailures, key, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS);

    const account = await db.Accounts.byEmail(normEmail);
    const ok = await verifyPassword(password ?? "", account?.password_hash || DUMMY_HASH);
    if (!account || !ok) {
      // Same scrypt work happened either way (DUMMY_HASH); now fail uniformly.
      throw httpError(401, "invalid_credentials", "Invalid email or password");
    }
    if (account.status !== "active") {
      throw httpError(403, "account_disabled", "This account is disabled");
    }
    throttleOk(loginFailures, key);
    await db.Accounts.touchLogin(account.id);
    await db.WorkspaceAudit.append({
      userId: account.id, workspaceId: account.workspace_id,
      action: "account.login", resourceId: account.id,
      detail: { method: "email" }, tsMs: Date.now()
    });
    return account;
  }

  /**
   * Find-or-create the account for a VERIFIED Google id_token payload.
   * Resolution order:
   *   1. google_sub match  — returning Google user.
   *   2. email match AND email_verified — link the Google identity onto the
   *      existing account. (An unverified email may never claim an account.)
   *   3. otherwise create a new account with its own private workspace.
   */
  async function upsertGoogleAccount({ payload, ip = null }) {
    if (!payload?.sub) throw httpError(401, "google_invalid", "Google token carried no subject");
    if (!payload?.email) throw httpError(401, "google_invalid", "Google token carried no email (email scope required)");
    if (payload.email_verified !== true) {
      throw httpError(401, "google_email_unverified",
        "Google account email is not verified; refusing to link or create an account");
    }

    const existing = await db.Accounts.byGoogleSub(payload.sub);
    if (existing) {
      if (existing.status !== "active") throw httpError(403, "account_disabled", "This account is disabled");
      await db.Accounts.touchLogin(existing.id);
      await db.WorkspaceAudit.append({
        userId: existing.id, workspaceId: existing.workspace_id,
        action: "account.login", resourceId: existing.id,
        detail: { method: "google" }, tsMs: Date.now()
      });
      return { account: existing, created: false, linked: false };
    }

    const byEmail = await db.Accounts.byEmail(payload.email);
    if (byEmail) {
      if (byEmail.status !== "active") throw httpError(403, "account_disabled", "This account is disabled");
      if (byEmail.google_sub && byEmail.google_sub !== payload.sub) {
        throw httpError(409, "google_identity_conflict", "This account is already linked to a different Google identity");
      }
      const linked = await db.Accounts.linkGoogle(byEmail.id, {
        googleSub: payload.sub, googleEmail: payload.email, avatarUrl: payload.picture || null
      });
      await db.Accounts.touchLogin(linked.id);
      await db.WorkspaceAudit.append({
        userId: linked.id, workspaceId: linked.workspace_id,
        action: "account.google_linked", resourceId: linked.id,
        detail: { method: "google", email_verified: true }, tsMs: Date.now()
      });
      await db.WorkspaceAudit.append({
        userId: linked.id, workspaceId: linked.workspace_id,
        action: "account.login", resourceId: linked.id,
        detail: { method: "google", linked_existing: true }, tsMs: Date.now()
      });
      return { account: linked, created: false, linked: true };
    }

    const displayName = (payload.name && String(payload.name).trim().slice(0, 80))
      || process.env.COGNOS_DEFAULT_DISPLAY_NAME
      || DEFAULT_DISPLAY_NAME;

    const created = await db.withTransaction(async (store) => {
      const ws = await store.Workspace.create({
        id: randomUUID(), // the brief's workspace-<uuid> shape for private workspaces
        name: `Workspace ${displayName}`.slice(0, 80),
        description: "Private workspace created on first Google sign-in."
      });
      const account = await store.Accounts.create({
        email: payload.email,
        displayName,
        provider: "google",
        googleSub: payload.sub,
        googleEmail: payload.email,
        avatarUrl: payload.picture || null,
        workspaceId: ws.id
      });
      await store.WorkspaceAudit.append({
        userId: account.id, workspaceId: ws.id,
        action: "account.register", resourceId: account.id,
        detail: { email: payload.email, provider: "google", workspace_namespace: `ws-${ws.id}` },
        tsMs: Date.now()
      });
      await store.WorkspaceAudit.append({
        userId: account.id, workspaceId: ws.id,
        action: "workspace.created", resourceId: ws.id,
        detail: { namespace: `ws-${ws.id}`, kind: "private" },
        tsMs: Date.now()
      });
      return { account, workspace: ws };
    });
    return { account: created.account, created: true, linked: false };
  }

  /**
   * Mint the access token: sub = user_id, ws = workspace_id (the brief's two
   * required claims), plus a unique jti for logout revocation.
   */
  function issueToken(account) {
    const { token, payload } = signJwt({
      sub: account.id,
      ws: account.workspace_id,
      email: account.email
    });
    return { token, claims: payload };
  }

  /**
   * GET /api/accounts/me body. The profile cites the trusted rows by their
   * exact graph ids — provenance travels with the assertion.
   */
  function buildProfile(account, workspace = null) {
    return {
      account: {
        user_id: account.id,
        email: account.email,
        display_name: account.display_name,
        auth_provider: account.auth_provider,
        avatar_url: account.avatar_url || null,
        workspace_id: account.workspace_id,
        workspace_namespace: `ws-${account.workspace_id}`,
        created_at: account.created_date,
        last_login_at: account.last_login_at || null
      },
      workspace: workspace ? { id: workspace.id, name: workspace.name, namespace: `ws-${workspace.id}` } : null,
      authoritative_facts: [
        {
          graph_id: "[graph_mu02br2ofvew5mqm]",
          subject: "user.preferred.name",
          value: account.display_name,
          trust: "trusted",
          applied: true,
          note: "display_name policy — default comes from trusted graph row [graph_mu02br2ofvew5mqm]"
        }
      ]
    };
  }

  return {
    manager,
    registerAccount,
    authenticateEmail,
    upsertGoogleAccount,
    issueToken,
    buildProfile,
    audit: manager.audit
  };
}

/** Test hook: clear the in-process throttle tables. */
export function resetThrottles() {
  loginFailures.clear();
  registerCounts.clear();
}
