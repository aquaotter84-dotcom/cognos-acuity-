// Phase 24 — sealed provenance for workspace rows.
//
// The brief, section 3.2, gives the exact invariant:
//
//     hash(content || timestamp || creator_id || workspace_id) == stored_hash
//
// …and requires the API to reject any mutation where a segment fails with a
// 422 and a logged incident. The hash is canonical (sorted-key JSON over the
// four segments, same canonicalJson discipline as the atlas seals in
// server/knowledge/graph.js) so it is byte-stable across runs and drivers.
//
// Two seals live on every workspace-API row, deliberately:
//   * provenance.ws_seal  — this module's spec seal (content/timestamp/
//                           creator_id/workspace_id). Answers "who created
//                           this, when, and has the content moved?"
//   * content_sha256      — the atlas seal (recomputed from stored columns by
//                           verifyNodeSeal). Answers "has THIS row been
//                           tampered with since it was written?"
// They are independent witnesses; the verify route reports both.

import { createHash } from "node:crypto";
import { canonicalJson } from "../knowledge/graph.js";

export function sha256Hex(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/**
 * The spec seal. timestamp is the ISO instant stored in the provenance block;
 * canonicalJson makes the concatenation unambiguous.
 */
export function computeWorkspaceSeal({ content, timestamp, creatorId, workspaceId }) {
  return `sha256:${sha256Hex(canonicalJson([
    "cognos.ws_node_v1",
    String(content ?? ""),
    String(timestamp ?? ""),
    String(creatorId ?? ""),
    String(workspaceId ?? "")
  ]))}`;
}

/** Verify a row's stored seal against its own provenance block. */
export function verifyWorkspaceSeal(node) {
  if (!node?.provenance) return { ok: false, reason: "missing_provenance" };
  let prov;
  try {
    prov = typeof node.provenance === "string" ? JSON.parse(node.provenance) : node.provenance;
  } catch {
    return { ok: false, reason: "unparseable_provenance" };
  }
  if (!prov?.ws_seal || !prov?.timestamp || !prov?.creator_id) {
    return { ok: false, reason: "incomplete_provenance" };
  }
  const recomputed = computeWorkspaceSeal({
    content: node.content,
    timestamp: prov.timestamp,
    creatorId: prov.creator_id,
    workspaceId: prov.workspace_id || node.workspace_id
  });
  return {
    ok: recomputed === prov.ws_seal,
    stored: prov.ws_seal,
    recomputed,
    reason: recomputed === prov.ws_seal ? null : "ws_seal_mismatch"
  };
}

/**
 * Middleware check for client-supplied provenance: if a write claims a seal,
 * the claim must match the facts the server will actually store. Any mismatch
 * is a 422 plus an audit incident (logged by the manager's createNode path).
 */
export function checkClientSeal({ content, timestamp, creatorId, workspaceId, claimedSeal }) {
  if (!claimedSeal) return { enforced: false };
  const expected = computeWorkspaceSeal({ content, timestamp, creatorId, workspaceId });
  return {
    enforced: true,
    ok: expected === claimedSeal,
    expected,
    claimed: String(claimedSeal),
    reason: expected === claimedSeal ? null : "ws_seal_mismatch"
  };
}
