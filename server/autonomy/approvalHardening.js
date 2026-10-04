// Approval hardening (Phase 37) — stolen from OpenMuse's ActionProposal discipline,
// reimplemented in COGNOS idioms.
//
// Two guarantees:
//   1. Approvals ROT. An approval is good for APPROVAL_TTL_MS (default 24h).
//      A Tuesday approval never executes Friday.
//   2. Approvals BIND. Each approval row carries a hash of the exact payload it
//      approved (destination + method + canonical body). If the effect's bytes
//      drift after approval, the Governor refuses — "approved one thing,
//      executed a slightly different thing" is closed.
//
// The Governor checks both on every readback. The outbox decision route stamps
// both at approval time.
import { createHash } from "node:crypto";
import { canonicalize } from "./authorize.js";

const sha256hex = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");

/** How long a human approval stays valid. A Tuesday approval never runs Friday. */
export const APPROVAL_TTL_MS = Number(process.env.COGNOS_APPROVAL_TTL_MS || 24 * 60 * 60 * 1000);

/**
 * The canonical bytes an approval binds to: effect type, destination, method,
 * and the body that will actually be sent. Stable across re-reads; sensitive
 * values never included (digests only).
 */
export function canonicalPayloadHash(effect) {
  const p = effect?.payload || {};
  // Prefer digests the staging path already computed; fall back to canonical
  // JSON of the stable fields. Never hash raw secret values.
  const bodyPart = p.body_digest
    || p.request_digest
    || canonicalize(stripVolatile(p));
  const parts = {
    effect_type: effect?.effect_type || null,
    destination: effect?.destination || p.url_origin || p.url || null,
    method: p.method || null,
    body: bodyPart,
  };
  return sha256hex(canonicalize(parts));
}

// Fields that change between staging and execution but don't change what the
// approval meant (timestamps, run ids, preview redactions). Note: secret_refs
// are NOT volatile — changing which secret an effect uses is material and
// must invalidate the approval.
const VOLATILE_KEYS = new Set([
  "preview", "built_at", "staged_at", "run_id", "tick_id", "step_id",
]);
function stripVolatile(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (VOLATILE_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Validate an approval row against the effect it names. Returns
 * { ok: true } or { ok: false, rule, detail }.
 *
 * `missingRule` keeps the caller's historical rule name for the no-approval
 * case (TOOL_WRITE_NEEDS_APPROVAL / T5_NEEDS_HUMAN) so existing verdict
 * consumers don't see a new rule where an old one was asserted.
 */
export function validateApproval(approval, effect, nowMs = Date.now(), missingRule = "NO_APPROVAL") {
  if (!approval) return { ok: false, rule: missingRule, detail: "no human approval row names this exact effect id" };
  const now = Number(nowMs) || Date.now();
  if (approval.expires_ms != null && Number(approval.expires_ms) <= now) {
    return {
      ok: false,
      rule: "APPROVAL_EXPIRED",
      detail: `approved ${new Date(Number(approval.decided_ms)).toISOString()}, expired ${new Date(Number(approval.expires_ms)).toISOString()} — approvals rot after ${Math.round(APPROVAL_TTL_MS / 3600000)}h`
    };
  }
  if (approval.payload_sha256) {
    const current = canonicalPayloadHash(effect);
    if (current !== approval.payload_sha256) {
      return {
        ok: false,
        rule: "APPROVAL_PAYLOAD_MISMATCH",
        detail: "the effect's bytes changed since approval — re-approve the new payload"
      };
    }
  }
  return { ok: true };
}

/** The stamp the decision route writes when a human approves. */
export function approvalStamp(effect, decidedMs = Date.now()) {
  const at = Number(decidedMs) || Date.now();
  return {
    expires_ms: at + APPROVAL_TTL_MS,
    payload_sha256: canonicalPayloadHash(effect),
  };
}
