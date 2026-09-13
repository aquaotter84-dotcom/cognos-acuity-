// Phase 24 — the account store.
//
// Same factory shape as createKnowledgeStore/createMetaStore/createAutonomyStore:
// a function of one `run` query runner, spread into the composition root in
// server/db.js, so every method works identically against the pool and inside
// withTransaction().
//
// Append-only discipline, honoured table by table:
//   * accounts            — rows are created and linked, never deleted. A
//                           disabled account is status='disabled', not an
//                           absent row (history keeps its subject).
//   * account_groups      — membership changes are edits to group CONFIG (the
//                           spec models members as a JSON array), not rewrites
//                           of history; the audit trail records every change.
//   * jwt_blocklist       — append-only revocation list. The only deletes are
//                           of rows already past their expiry (Redis-TTL
//                           semantics in Postgres; see docs divergence).
//   * workspace_audit     — append-only. The app exposes INSERT and SELECT
//                           only. Rotation (scripts/audit-rotate.mjs) is the
//                           single sanctioned mover of old rows.
//   * google_auth_states  — short-lived CSRF state rows; consumption is a
//                           single-use flag flip, expiry is enforced on read.

import { randomUUID } from "node:crypto";
import { nowMs } from "../db/util.js";

const EMAIL_RE = /^[^\s@]{1,200}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(e)) {
    const err = new Error("A valid email address is required");
    err.status = 400;
    err.code = "invalid_email";
    throw err;
  }
  return e;
}

function cleanText(value, limit = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function createAccountsStore(run) {
  return {

    // --- accounts ------------------------------------------------------------

    Accounts: {
      normalizeEmail,

      async create({ email, displayName, passwordHash = null, provider = "email", googleSub = null, googleEmail = null, avatarUrl = null, workspaceId }) {
        const id = randomUUID();
        const rows = await run(
          `INSERT INTO accounts (id, email, display_name, password_hash, auth_provider, google_sub, google_email, avatar_url, workspace_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active') RETURNING *`,
          [id, normalizeEmail(email), cleanText(displayName, 80) || null,
           passwordHash || null, ["email", "google", "email+google"].includes(provider) ? provider : provider ? "email+google" : "email",
           googleSub || null, googleEmail ? normalizeEmail(googleEmail) : null, avatarUrl || null, workspaceId]
        );
        return rows[0];
      },

      async byEmail(email) {
        const rows = await run(`SELECT * FROM accounts WHERE email = $1 LIMIT 1`, [normalizeEmail(email)]);
        return rows[0] || null;
      },

      async byId(id) {
        const rows = await run(`SELECT * FROM accounts WHERE id = $1 LIMIT 1`, [String(id || "")]);
        return rows[0] || null;
      },

      async byGoogleSub(googleSub) {
        const rows = await run(`SELECT * FROM accounts WHERE google_sub = $1 LIMIT 1`, [String(googleSub || "")]);
        return rows[0] || null;
      },

      /** Link a verified Google identity onto an existing email account. */
      async linkGoogle(id, { googleSub, googleEmail, avatarUrl = null }) {
        const rows = await run(
          `UPDATE accounts SET google_sub = $2, google_email = $3,
             auth_provider = CASE WHEN password_hash IS NOT NULL THEN 'email+google' ELSE 'google' END,
             avatar_url = COALESCE($4, avatar_url), updated_date = now()
           WHERE id = $1 RETURNING *`,
          [String(id), String(googleSub), normalizeEmail(googleEmail), avatarUrl]
        );
        return rows[0] || null;
      },

      async touchLogin(id) {
        await run(`UPDATE accounts SET last_login_at = now() WHERE id = $1`, [String(id)]);
      },

      async count() {
        const rows = await run(`SELECT COUNT(*)::int AS n FROM accounts`);
        return rows[0]?.n ?? 0;
      }
    },

    // --- groups --------------------------------------------------------------
    // Spec shape: group_id, group_name, owner_id, members (JSON array of UUIDs).
    // `private_writers` carries the flag behind the role matrix's "member can
    // read/write the private bucket only if flagged".

    Groups: {
      async create({ name, ownerId }) {
        const id = randomUUID();
        const rows = await run(
          `INSERT INTO account_groups (id, group_name, owner_id, members, private_writers)
           VALUES ($1,$2,$3,'[]'::jsonb,'[]'::jsonb) RETURNING *`,
          [id, cleanText(name, 120), String(ownerId)]
        );
        return rows[0];
      },

      async byId(id) {
        const rows = await run(`SELECT * FROM account_groups WHERE id = $1 LIMIT 1`, [String(id || "")]);
        return rows[0] || null;
      },

      async listForUser(userId) {
        const uid = String(userId || "");
        return run(
          `SELECT * FROM account_groups WHERE owner_id = $1 OR members @> $2::jsonb ORDER BY created_date ASC`,
          [uid, JSON.stringify([uid])]
        );
      },

      async listByOwner(ownerId) {
        return run(`SELECT * FROM account_groups WHERE owner_id = $1 ORDER BY created_date ASC`, [String(ownerId)]);
      },

      async addMember(id, userId) {
        const uid = String(userId);
        const rows = await run(
          `UPDATE account_groups
             SET members = CASE WHEN members @> $2::jsonb THEN members ELSE members || $2::jsonb END,
                 updated_date = now()
           WHERE id = $1 RETURNING *`,
          [String(id), JSON.stringify([uid])]
        );
        return rows[0] || null;
      },

      async removeMember(id, userId) {
        const uid = String(userId);
        const rows = await run(
          `UPDATE account_groups
             SET members = members - $2,
                 private_writers = private_writers - $2,
                 updated_date = now()
           WHERE id = $1 RETURNING *`,
          [String(id), uid]
        );
        return rows[0] || null;
      },

      /** Flip the "can read/write the group's private bucket" flag for one member. */
      async setPrivateWriter(id, userId, allowed) {
        const uid = String(userId);
        // $2 is the jsonb membership probe; $4 is the TEXT the `-` operator
        // needs (same param cannot serve both — PG would pin it to jsonb).
        const rows = await run(
          `UPDATE account_groups
             SET private_writers = CASE WHEN $3::boolean THEN
                   CASE WHEN private_writers @> $2::jsonb THEN private_writers ELSE private_writers || $2::jsonb END
                 ELSE private_writers - $4 END,
                 updated_date = now()
           WHERE id = $1 RETURNING *`,
          [String(id), JSON.stringify([uid]), Boolean(allowed), uid]
        );
        return rows[0] || null;
      },

      /**
       * Membership view used by the role matrix. Pure input for
       * groupPermissions() in server/workspaces/namespaces.js.
       */
      membership(group, userId) {
        const uid = String(userId || "");
        const members = Array.isArray(group?.members) ? group.members : (typeof group?.members === "string" ? JSON.parse(group.members) : []);
        const writers = Array.isArray(group?.private_writers) ? group.private_writers : (typeof group?.private_writers === "string" ? JSON.parse(group.private_writers) : []);
        const isOwner = group?.owner_id === uid;
        const isMember = isOwner || members.includes(uid);
        return { isOwner, isMember, canWritePrivate: writers.includes(uid) };
      },

      async memberEmails(userIds) {
        const ids = (Array.isArray(userIds) ? userIds : []).map(String).filter(Boolean);
        if (!ids.length) return [];
        return run(`SELECT id, email, display_name FROM accounts WHERE id = ANY($1)`, [ids]);
      }
    },

    // --- JWT revocation (the logout blocklist) -------------------------------

    AuthBlocklist: {
      /**
       * Revoke a jti until its token's natural expiry. The purge of
       * already-expired rows replicates Redis key TTL without a second system.
       */
      async add(jti, userId, expiresAt, now = new Date()) {
        await run(
          `INSERT INTO jwt_blocklist (jti, user_id, expires_at) VALUES ($1,$2,$3)
           ON CONFLICT (jti) DO NOTHING`,
          [String(jti), String(userId || null), expiresAt instanceof Date ? expiresAt : new Date(expiresAt)]
        );
        await run(`DELETE FROM jwt_blocklist WHERE expires_at < $1`, [now]);
      },

      async has(jti) {
        const rows = await run(`SELECT 1 FROM jwt_blocklist WHERE jti = $1 LIMIT 1`, [String(jti || "")]);
        return rows.length > 0;
      }
    },

    // --- Google OAuth CSRF state (single-use, short TTL) ---------------------

    AuthState: {
      async put(state, nonce, { ttlMs = 10 * 60 * 1000 } = {}) {
        await run(
          `INSERT INTO google_auth_states (state, nonce, expires_at) VALUES ($1,$2,$3)
           ON CONFLICT (state) DO UPDATE SET nonce = EXCLUDED.nonce, consumed = FALSE, expires_at = EXCLUDED.expires_at, created_date = now()`,
          [String(state), String(nonce), new Date(Date.now() + ttlMs)]
        );
        return state;
      },

      /** Fetch only if live; the caller consumes via consume(). */
      async getLive(state) {
        const rows = await run(
          `SELECT * FROM google_auth_states WHERE state = $1 AND consumed = FALSE AND expires_at > now() LIMIT 1`,
          [String(state || "")]
        );
        return rows[0] || null;
      },

      async consume(state) {
        const rows = await run(
          `UPDATE google_auth_states SET consumed = TRUE WHERE state = $1 AND consumed = FALSE RETURNING *`,
          [String(state || "")]
        );
        return rows[0] || null;
      }
    },

    // --- workspace audit (append-only) ----------------------------------------

    WorkspaceAudit: {
      /**
       * One immutable row per mutation or notable denial. ts_ms is taken from
       * the caller so the row lines up with provenance timestamps.
       */
      async append({ userId = null, workspaceId = null, action, resourceId = null, detail = null, tsMs = null }) {
        const id = randomUUID();
        const rows = await run(
          `INSERT INTO workspace_audit (id, ts_ms, user_id, workspace_id, action, resource_id, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [id, tsMs ?? nowMs(), userId, workspaceId, String(action).slice(0, 120),
           resourceId ? String(resourceId).slice(0, 200) : null,
           detail ? JSON.stringify(detail) : null]
        );
        return rows[0];
      },

      /** The read function: filtered, bounded, newest first. */
      async list({ workspaceId = null, userId = null, action = null, sinceMs = null, limit = 100 } = {}) {
        const clauses = [];
        const params = [];
        if (workspaceId) { params.push(String(workspaceId)); clauses.push(`workspace_id = $${params.length}`); }
        if (userId) { params.push(String(userId)); clauses.push(`user_id = $${params.length}`); }
        if (action) { params.push(String(action)); clauses.push(`action = $${params.length}`); }
        if (sinceMs !== null && Number.isFinite(Number(sinceMs))) { params.push(Number(sinceMs)); clauses.push(`ts_ms >= $${params.length}`); }
        params.push(Math.max(1, Math.min(Number(limit) || 100, 500)));
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        return run(
          `SELECT * FROM workspace_audit ${where} ORDER BY ts_ms DESC, created_date DESC LIMIT $${params.length}`,
          params
        );
      }
    }
  };
}
