// Phase 24 — the Workspace Manager (the brief's "WorkspaceAPI").
//
//   class WorkspaceAPI:
//       create_node(ws_id, node)             # adds to ws_id formatted key
//       read_node(ws_id, node_id)
//       add_edge(ws_id, src_id, dst_id, type, prov)
//       # ... similar for query, delete (soft flag), etc.
//
// It is a thin, strict layer OVER the Phase 23 atlas store. The atlas keeps
// every guarantee it already had (append-only rows, provenance seals, ledger
// events); this layer adds the multi-tenant parts:
//
//   * Namespace  — every node key is prefixed with the namespace token
//                  (`ws-<workspace_id>:…`, `group-public-<gid>:…`,
//                  `group-private-<gid>:…`). Group buckets use the bucket
//                  token as the atlas `workspace_id` itself.
//   * Isolation  — resolveAccess() is the single gate every read and write
//                  passes. A bearer's private namespace is bound INTO the JWT
//                  (`ws` claim); group namespaces resolve through membership
//                  and the role matrix. Anything else is a 403 and an audit
//                  incident. There is no code path that touches graph rows
//                  without passing resolveAccess() first.
//   * Append-only — "delete" is retire (a transition); "overwrite" does not
//                  exist. Creates append; dedupe returns the live head.
//   * Sealed provenance — every created node stores the spec seal
//                  (hash(content || timestamp || creator_id || workspace_id)),
//                  the run id, and any source atlas row (`source_graph_id`,
//                  e.g. "[graph_mu01yzi4hosh3erz]") in its provenance block.
//
// The manager never trusts the client's copy of any of this: timestamps,
// seals, and namespaces are computed server-side; a client-claimed seal that
// does not match is a 422 and an audit incident.

import { nowMs } from "../db/util.js";
import {
  parseNamespace, graphWorkspaceIdFor, nodeKeyPrefix,
  privateNamespace, groupNamespace, groupPermissions, bucketPermissions
} from "./namespaces.js";
import { computeWorkspaceSeal, verifyWorkspaceSeal, checkClientSeal } from "./provenance.js";

function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export function createWorkspaceManager({ db, logger = console }) {

  /**
   * THE isolation gate. Returns { ns, workspaceId, permissions } or throws
   * 403 (cross-workspace read guard) / 404 (unknown group).
   *
   * principal: { userId, workspaceId } — workspaceId comes from the JWT `ws`
   * claim (verified at the auth middleware), never from the request body.
   */
  async function resolveAccess(principal, namespaceToken, { write = false } = {}) {
    const ns = parseNamespace(namespaceToken); // 400 on unknown shape

    if (ns.kind === "private") {
      // The brief's cross-workspace read guard: key prefix must equal the
      // bearer's bound workspace, else 403. Incidents land on the CALLER's
      // own trail (principal.workspaceId), never on the target's, so audit
      // reads never leak another user's activity.
      if (ns.id !== principal.workspaceId) {
        await auditIncident(principal, principal.workspaceId, "isolation.denied", null,
          { reason: "namespace not bound to token ws claim", target_namespace: ns.token, write });
        throw httpError(403, "cross_workspace_denied",
          "This workspace namespace is not bound to your token");
      }
      return { ns, workspaceId: ns.id, permissions: { read: true, write: true }, group: null };
    }

    // Group buckets: membership + the role matrix decide.
    const group = await db.Groups.byId(ns.id);
    if (!group) throw httpError(404, "group_not_found", "No such group workspace");
    const perms = bucketPermissions(groupPermissions(db.Groups.membership(group, principal.userId)), ns.bucket);
    const needed = write ? "write" : "read";
    if (!perms[needed]) {
      await auditIncident(principal, principal.workspaceId, "isolation.denied", group.id,
        { reason: `role matrix refuses ${needed} on ${ns.bucket} bucket`, target_namespace: ns.token, write });
      throw httpError(403, "bucket_permission_denied",
        `Your role in this group does not allow ${needed} on the ${ns.bucket} bucket`);
    }
    return { ns, workspaceId: graphWorkspaceIdFor(ns), permissions: perms, group };
  }

  /** Audit helper. Incidents carry action suffixes; nothing here can be silent. */
  async function audit(principal, workspaceId, action, resourceId, detail = {}, tsMs = null) {
    try {
      return await db.WorkspaceAudit.append({
        userId: principal?.userId ?? null,
        workspaceId,
        action,
        resourceId,
        detail,
        tsMs: tsMs ?? nowMs()
      });
    } catch (err) {
      // The audit trail must never be the thing that breaks a mutation…
      logger?.warn?.("workspace audit write failed", { action, error: String(err) });
      return null;
    }
  }

  async function auditIncident(principal, workspaceId, action, resourceId, detail) {
    return audit(principal, workspaceId, action, resourceId, { incident: true, ...detail });
  }

  // --- nodes ---------------------------------------------------------------

  /**
   * create_node — append a node into a namespace.
   * body: { type, label, content?, trust?, source_graph_id?, run_id?, provenance? }
   * body.provenance.{timestamp,hash}: an OPTIONAL client-claimed seal; if the
   * hash does not match the facts the server will store, the mutation is a 422.
   */
  async function createNode(principal, namespaceToken, body = {}) {
    const access = await resolveAccess(principal, namespaceToken, { write: true });
    if (!access.permissions.write) {
      throw httpError(403, "bucket_permission_denied",
        `Your role in this group does not allow write on the ${access.ns.bucket} bucket`);
    }

    const label = String(body.label ?? "").trim();
    if (!label) throw httpError(400, "label_required", "A node needs a label");
    if (String(body.trust || "").toLowerCase() === "verified") {
      // Verified trust is minted only by an explicit user pin on the curation
      // routes (Phase 23 convention). The workspace API refuses it honestly
      // instead of silently downgrading.
      throw httpError(400, "verified_not_mintable",
        "verified trust is earned only by pinning (POST /api/graph/nodes/:id/pin on the atlas), not by workspace creates");
    }
    const content = body.content == null ? "" : String(body.content);
    const sourceGraphId = body.source_graph_id ? String(body.source_graph_id).slice(0, 80) : null;
    const runId = body.run_id ? String(body.run_id).slice(0, 120) : null;

    const tsMs = nowMs();
    const timestamp = new Date(tsMs).toISOString();
    const seal = computeWorkspaceSeal({
      content, timestamp, creatorId: principal.userId, workspaceId: access.workspaceId
    });

    // Provenance check (brief §3.2): a claimed seal that fails any segment is
    // a 422 plus a logged incident. The server's own seal is authoritative.
    const claimed = checkClientSeal({
      content,
      timestamp: body.provenance?.timestamp ?? timestamp,
      creatorId: principal.userId,
      workspaceId: access.workspaceId,
      claimedSeal: body.provenance?.hash
    });
    if (claimed.enforced && !claimed.ok) {
      await auditIncident(principal, access.workspaceId, "provenance.mismatch", null, {
        namespace: namespaceToken, label: label.slice(0, 120),
        claimed: claimed.claimed, expected: claimed.expected
      });
      throw httpError(422, "provenance_mismatch",
        "Supplied provenance seal does not match hash(content || timestamp || creator_id || workspace_id)");
    }

    const result = await db.Graph.createNamespacedNode({
      workspaceId: access.workspaceId,
      keyNamespace: nodeKeyPrefix(access.ns),
      type: body.type || "concept",
      label,
      content,
      trust: body.trust || "untrusted",      // 'verified' is refused upstream — pins only
      confidence: body.confidence ?? 0.5,
      actor: "user",
      note: sourceGraphId ? `derived from trusted atlas row ${sourceGraphId}` : "workspace api create",
      tsMs,
      sourceRunId: runId,
      provenanceExtras: {
        creator_id: principal.userId,
        workspace_id: access.workspaceId,
        namespace: access.ns.token,
        timestamp,
        ws_seal: seal,
        source_graph_id: sourceGraphId
      }
    });

    await audit(principal, access.workspaceId,
      result.existing ? "node.dedupe" : "node.created",
      result.node.id,
      { namespace: namespaceToken, node_key: result.node.node_key, source_graph_id: sourceGraphId }, tsMs);

    return hydrateNode(result);
  }

  /** read_node — with the cross-workspace guard in front of the atlas read. */
  async function readNode(principal, namespaceToken, nodeId) {
    const access = await resolveAccess(principal, namespaceToken);
    const node = await db.Graph.getNode(nodeId);
    if (!node) return null;
    if (node.workspace_id !== access.workspaceId) {
      // Even a valid id from ANOTHER namespace is invisible: 403, and logged
      // on the caller's own trail.
      await auditIncident(principal, principal.workspaceId, "isolation.denied", nodeId,
        { reason: "node belongs to a different namespace", target_namespace: namespaceToken });
      throw httpError(403, "cross_workspace_denied", "That node is not in your workspace");
    }
    return hydrateNode({ node, existing: true, events: [] });
  }

  async function listNodes(principal, namespaceToken, opts = {}) {
    const access = await resolveAccess(principal, namespaceToken);
    const rows = await db.Graph.listNodes(access.workspaceId, opts);
    return { access, rows };
  }

  /**
   * Soft delete: retire is a transition, never a delete. The row keeps its
   * lineage; a `reason` rides the provenance note.
   */
  async function retireNode(principal, namespaceToken, nodeId, reason = null) {
    const access = await resolveAccess(principal, namespaceToken, { write: true });
    if (!access.permissions.write) {
      throw httpError(403, "bucket_permission_denied",
        `Your role in this group does not allow write on the ${access.ns.bucket} bucket`);
    }
    const node = await db.Graph.getNode(nodeId);
    if (!node) return null;
    if (node.workspace_id !== access.workspaceId) {
      await auditIncident(principal, principal.workspaceId, "isolation.denied", nodeId,
        { reason: "retire attempted across namespaces", target_namespace: namespaceToken });
      throw httpError(403, "cross_workspace_denied", "That node is not in your workspace");
    }
    const result = await db.Graph.retireNode({
      nodeId, actor: "user", note: reason || "retired via workspace api"
    });
    await audit(principal, access.workspaceId, result.existing ? "node.retire.dedupe" : "node.retired",
      nodeId, { namespace: namespaceToken, reason: reason || null });
    return result;
  }

  // --- edges ---------------------------------------------------------------

  async function addEdge(principal, namespaceToken, { srcNodeId, dstNodeId, kind = "is-about", weight = 0.5, trust = "untrusted", source_graph_id = null, run_id = null }) {
    const access = await resolveAccess(principal, namespaceToken, { write: true });
    if (!access.permissions.write) {
      throw httpError(403, "bucket_permission_denied",
        `Your role in this group does not allow write on the ${access.ns.bucket} bucket`);
    }
    // Endpoints must already live in THIS namespace (createEdge re-checks the
    // workspace match, but the guard here produces the right error surface).
    for (const endpointId of [srcNodeId, dstNodeId]) {
      const endpoint = await db.Graph.getNode(endpointId);
      if (!endpoint) throw httpError(404, "endpoint_missing", `Edge endpoint ${endpointId} does not exist`);
      if (endpoint.workspace_id !== access.workspaceId) {
        await auditIncident(principal, principal.workspaceId, "isolation.denied", endpointId,
          { reason: "edge endpoint outside the namespace", target_namespace: namespaceToken });
        throw httpError(403, "cross_workspace_denied", "Edges cannot reach outside your workspace");
      }
    }
    const result = await db.Graph.createEdge({
      workspaceId: access.workspaceId,
      srcNodeId: String(srcNodeId), dstNodeId: String(dstNodeId),
      kind, trust, weight,
      sourceRunId: run_id || null,
      actor: "user",
      note: source_graph_id ? `derived from atlas row ${source_graph_id}` : "workspace api edge",
      provenanceExtras: {
        creator_id: principal.userId,
        workspace_id: access.workspaceId,
        namespace: access.ns.token,
        source_graph_id: source_graph_id ? String(source_graph_id).slice(0, 80) : null
      }
    });
    await audit(principal, access.workspaceId, result.existing ? "edge.dedupe" : "edge.created",
      result.edge.id, { namespace: namespaceToken, kind });
    return result;
  }

  async function listEdges(principal, namespaceToken, opts = {}) {
    const access = await resolveAccess(principal, namespaceToken);
    const rows = await db.Graph.listEdges(access.workspaceId, opts);
    return { access, rows };
  }

  /** Relevance query bounded to the namespace (the atlas query engine). */
  async function query(principal, namespaceToken, text, opts = {}) {
    const access = await resolveAccess(principal, namespaceToken);
    const rows = await db.Graph.queryRelevant(access.workspaceId, String(text || ""), opts);
    return { access, rows };
  }

  /**
   * Provenance verification over the namespace: every node is checked against
   * BOTH seals (atlas + spec). Mismatches are returned here AND already
   * logged as incidents by whichever write would have caused them.
   */
  async function verifyProvenance(principal, namespaceToken, { limit = 500 } = {}) {
    const access = await resolveAccess(principal, namespaceToken);
    const rows = await db.Graph.listNodes(access.workspaceId, { limit });
    const results = rows.map(node => {
      const atlas = db.Graph.verifyNodeSeal(node);
      const ws = verifyWorkspaceSeal(node);
      return {
        id: node.id,
        node_key: node.node_key,
        atlas_seal_ok: atlas.ok === true,
        ws_seal_ok: node.provenance?.ws_seal ? ws.ok : null,
        ok: atlas.ok === true && (node.provenance?.ws_seal ? ws.ok : true)
      };
    });
    const bad = results.filter(r => !r.ok);
    if (bad.length) {
      await auditIncident(principal, access.workspaceId, "provenance.audit_failures", null,
        { namespace: namespaceToken, count: bad.length, ids: bad.slice(0, 10).map(r => r.id) });
    }
    return {
      namespace: namespaceToken,
      workspaceId: access.workspaceId,
      checked: results.length,
      mismatches: bad.length,
      ok: bad.length === 0,
      rows: results
    };
  }

  // --- listing & groups ------------------------------------------------------

  /** Everything the bearer may see, with the role matrix applied. */
  async function listWorkspaces(principal) {
    const groups = await db.Groups.listForUser(principal.userId);
    const groupViews = [];
    for (const group of groups) {
      const membership = db.Groups.membership(group, principal.userId);
      const perms = groupPermissions(membership);
      const memberRows = await db.Groups.memberEmails([...new Set([...(Array.isArray(group.members) ? group.members : []), group.owner_id])]);
      const nameById = new Map(memberRows.map(r => [r.id, r]));
      groupViews.push({
        group_id: group.id,
        group_name: group.group_name,
        created_at: group.created_date,
        your_role: membership.isOwner ? "owner" : "member",
        buckets: {
          public: { namespace: groupNamespace(group.id, "public"), ...bucketPermissions(perms, "public") },
          private: { namespace: groupNamespace(group.id, "private"), ...bucketPermissions(perms, "private") }
        },
        owner: { id: group.owner_id, email: nameById.get(group.owner_id)?.email || null },
        members: (Array.isArray(group.members) ? group.members : []).map(id => ({
          id, email: nameById.get(id)?.email || null,
          can_write_private: (Array.isArray(group.private_writers) ? group.private_writers : []).includes(id)
        }))
      });
    }
    return {
      private: {
        workspace_id: principal.workspaceId,
        namespace: privateNamespace(principal.workspaceId),
        permissions: { read: true, write: true }
      },
      groups: groupViews
    };
  }

  async function createGroup(principal, { name }) {
    const clean = String(name ?? "").trim();
    if (!clean) throw httpError(400, "name_required", "A group needs a name");
    const group = await db.Groups.create({ name: clean, ownerId: principal.userId });
    await audit(principal, group.id, "group.created", group.id, { name: clean });
    await audit(principal, groupNamespace(group.id, "public"), "bucket.ready", group.id, { bucket: "public" });
    await audit(principal, groupNamespace(group.id, "private"), "bucket.ready", group.id, { bucket: "private" });
    return group;
  }

  async function getGroup(principal, groupId) {
    const group = await db.Groups.byId(groupId);
    if (!group) return null;
    const membership = db.Groups.membership(group, principal.userId);
    if (!membership.isMember) {
      await auditIncident(principal, principal.workspaceId, "isolation.denied", groupId, { reason: "non-member group read" });
      throw httpError(403, "not_a_member", "You are not a member of this group");
    }
    const perms = groupPermissions(membership);
    const memberRows = await db.Groups.memberEmails([...new Set([...(Array.isArray(group.members) ? group.members : []), group.owner_id])]);
    const nameById = new Map(memberRows.map(r => [r.id, r]));
    return {
      group_id: group.id,
      group_name: group.group_name,
      created_at: group.created_date,
      your_role: membership.isOwner ? "owner" : "member",
      buckets: {
        public: { namespace: groupNamespace(group.id, "public"), ...bucketPermissions(perms, "public") },
        private: { namespace: groupNamespace(group.id, "private"), ...bucketPermissions(perms, "private") }
      },
      owner: { id: group.owner_id, email: nameById.get(group.owner_id)?.email || null },
      members: (Array.isArray(group.members) ? group.members : []).map(id => ({
        id, email: nameById.get(id)?.email || null,
        can_write_private: (Array.isArray(group.private_writers) ? group.private_writers : []).includes(id)
      }))
    };
  }

  /** Owner-only member management; every change is audited. */
  async function assertGroupOwner(principal, groupId) {
    const group = await db.Groups.byId(groupId);
    if (!group) throw httpError(404, "group_not_found", "No such group");
    if (group.owner_id !== principal.userId) {
      await auditIncident(principal, principal.workspaceId, "isolation.denied", groupId, { reason: "non-owner group mutation" });
      throw httpError(403, "owner_only", "Only the group owner can do that");
    }
    return group;
  }

  async function addGroupMember(principal, groupId, { userId = null, email = null, canWritePrivate = false }) {
    const group = await assertGroupOwner(principal, groupId);
    let uid = userId ? String(userId) : null;
    if (!uid && email) {
      const account = await db.Accounts.byEmail(email);
      if (!account) throw httpError(404, "account_not_found", "No account with that email");
      uid = account.id;
    }
    if (!uid) throw httpError(400, "member_required", "Provide userId or email");
    if (uid === group.owner_id) throw httpError(409, "owner_is_member", "The owner is already a member of their own group");
    await db.Groups.addMember(groupId, uid);
    if (canWritePrivate) await db.Groups.setPrivateWriter(groupId, uid, true);
    await audit(principal, groupId, "group.member_added", uid,
      { email: email || null, can_write_private: Boolean(canWritePrivate) });
    return getGroup(principal, groupId);
  }

  async function removeGroupMember(principal, groupId, userId) {
    const group = await assertGroupOwner(principal, groupId);
    await db.Groups.removeMember(groupId, String(userId));
    await audit(principal, groupId, "group.member_removed", String(userId), {});
    return getGroup(principal, groupId);
  }

  async function flagGroupMember(principal, groupId, userId, canWritePrivate) {
    const group = await assertGroupOwner(principal, groupId);
    const members = Array.isArray(group.members) ? group.members : [];
    if (!members.includes(String(userId))) {
      throw httpError(404, "not_a_member", "Flag a member, not a stranger");
    }
    await db.Groups.setPrivateWriter(groupId, String(userId), Boolean(canWritePrivate));
    await audit(principal, groupId, "group.member_flagged", String(userId),
      { can_write_private: Boolean(canWritePrivate) });
    return getGroup(principal, groupId);
  }

  // --- audit read -------------------------------------------------------------

  /** Private namespace: the bearer reads their own trail. Groups: owner all, members own rows. */
  async function readAudit(principal, namespaceToken, opts = {}) {
    const access = await resolveAccess(principal, namespaceToken);
    let userIdFilter = principal.userId;
    if (access.group && access.permissions.write) userIdFilter = null; // owners see the whole trail
    const rows = await db.WorkspaceAudit.list({
      workspaceId: access.workspaceId,
      userId: userIdFilter,
      action: opts.action || null,
      sinceMs: opts.sinceMs ?? null,
      limit: opts.limit || 100
    });
    return { namespace: namespaceToken, count: rows.length, rows };
  }

  return {
    resolveAccess,
    audit,
    createNode, readNode, listNodes, retireNode,
    addEdge, listEdges,
    query,
    verifyProvenance,
    listWorkspaces,
    createGroup, getGroup, addGroupMember, removeGroupMember, flagGroupMember,
    readAudit
  };
}

/** Shape a Graph store result for the API: parse provenance, verify seals. */
function hydrateNode({ node, existing }) {
  let prov = node.provenance;
  try { prov = typeof prov === "string" ? JSON.parse(prov) : prov; } catch { /* keep raw */ }
  return {
    ...node,
    provenance: prov,
    created: !existing
  };
}
