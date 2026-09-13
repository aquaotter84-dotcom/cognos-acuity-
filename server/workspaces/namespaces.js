// Phase 24 — workspace namespaces and the group role matrix.
//
// Every workspace-graph key lives in exactly one namespace. The namespace is
// the isolation boundary: a JWT bearer may only touch namespaces this module
// says their claims cover.
//
//   private workspace   ws-<workspace_id>
//   group public bucket group-public-<group_id>
//   group private bucket group-private-<group_id>
//
// The buckets are the brief's literal `group-public-<group_id>/nodes/…` and
// `group-private-<group_id>/nodes/…`: each maps 1:1 onto the Phase 23 atlas's
// existing `workspace_id` scoping column, so the graph store needs no new
// isolation logic — a bucket IS a workspace_id value. Node keys additionally
// carry the namespace as an explicit prefix (`ws-<id>:concept:label`), which is
// the brief's "every node/edge key is prefixed" requirement enforced in data.

export const NAMESPACE_KINDS = Object.freeze(["private", "group-public", "group-private"]);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function badNamespace(token) {
  const err = new Error(`Unknown workspace namespace: ${String(token).slice(0, 80)}`);
  err.status = 400;
  err.code = "bad_namespace";
  return err;
}

/** Parse a namespace token: "ws-<uuid>" | "group-public-<uuid>" | "group-private-<uuid>". */
export function parseNamespace(token) {
  const t = String(token || "").trim();
  if (t.startsWith("ws-")) {
    const id = t.slice(3);
    if (!UUID_RE.test(id)) throw badNamespace(t);
    return { token: t, kind: "private", id, bucket: "private" };
  }
  if (t.startsWith("group-public-")) {
    const id = t.slice("group-public-".length);
    if (!UUID_RE.test(id)) throw badNamespace(t);
    return { token: t, kind: "group-public", id, bucket: "public" };
  }
  if (t.startsWith("group-private-")) {
    const id = t.slice("group-private-".length);
    if (!UUID_RE.test(id)) throw badNamespace(t);
    return { token: t, kind: "group-private", id, bucket: "private" };
  }
  throw badNamespace(t);
}

/** A user's default private-workspace namespace token. */
export function privateNamespace(workspaceId) {
  return `ws-${workspaceId}`;
}

/** Group bucket namespace token for a group id. */
export function groupNamespace(groupId, bucket /* "public" | "private" */) {
  return `group-${bucket}-${groupId}`;
}

/**
 * The value stored in the atlas's workspace_id column for a namespace.
 * Private namespaces use the real workspace row id (so the single-tenant
 * stack keeps working against the same rows); group buckets use the bucket
 * token itself — the directory metaphor from the brief, one column.
 */
export function graphWorkspaceIdFor(ns) {
  return ns.kind === "private" ? ns.id : ns.token;
}

/** The key prefix every node created in this namespace must carry. */
export function nodeKeyPrefix(ns) {
  return `${ns.token}:`;
}

// --- the group role matrix (pure, exhaustively testable) ----------------------
//
// Brief, section 2.3: "owner can write to both buckets; member can read
// public, read/write private only if flagged."

export function groupPermissions({ isOwner = false, isMember = false, canWritePrivate = false } = {}) {
  if (isOwner) return Object.freeze({ readPublic: true, writePublic: true, readPrivate: true, writePrivate: true });
  if (isMember && canWritePrivate) return Object.freeze({ readPublic: true, writePublic: false, readPrivate: true, writePrivate: true });
  if (isMember) return Object.freeze({ readPublic: true, writePublic: false, readPrivate: false, writePrivate: false });
  return Object.freeze({ readPublic: false, writePublic: false, readPrivate: false, writePrivate: false });
}

/** Turn a matrix cell into the read/write pair a namespace bucket needs. */
export function bucketPermissions(perms, bucket) {
  return Object.freeze({
    read: bucket === "public" ? perms.readPublic : perms.readPrivate,
    write: bucket === "public" ? perms.writePublic : perms.writePrivate
  });
}
