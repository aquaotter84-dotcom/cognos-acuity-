// Authorizations — Phase 19.
//
// A goal's scope and budget are fixed at authorization, and widening either is
// a NEW row, never an edit (pin.goal_scope_immutable). The hashes here are what
// make that enforceable: a goal cannot claim a scope it was not granted,
// because the hash of the scope it tries to act under has to match the hash it
// was authorized under.

import { createHash } from "node:crypto";
import { canonicalize } from "./outbox.js";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function scopeHashes({ goalId = null, scope = {}, budget = {} } = {}) {
  return {
    scopeSha256: sha256(JSON.stringify([goalId, canonicalize(scope)])),
    budgetSha256: sha256(JSON.stringify([goalId, canonicalize(budget)]))
  };
}

/** Does a live authorization still cover the goal's current scope and budget? */
export function authorizationCovers(authorization, { goalId, scope, budget, nowMs = Date.now() }) {
  if (!authorization) return false;
  if (authorization.decision !== "authorize") return false;   // a declined row covers nothing
  if (authorization.expires_at_ms && Number(authorization.expires_at_ms) <= nowMs) return false;
  const current = scopeHashes({ goalId, scope, budget });
  return current.scopeSha256 === authorization.scope_sha256
    && current.budgetSha256 === authorization.budget_sha256;
}

/** A budget may only be tightened, never raised, without a new authorization. */
export function isTightening(current = {}, proposed = {}) {
  for (const [key, value] of Object.entries(proposed)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const existing = current[key];
    if (existing !== undefined && Number.isFinite(Number(existing)) && value > Number(existing)) {
      return false;
    }
  }
  return true;
}
