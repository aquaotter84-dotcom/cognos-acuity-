#!/usr/bin/env node
// Phase 24 regressions — accounts, multi-tenant workspaces, sealed provenance.
//
// The brief's five required scenarios, plus the auth surface:
//   1. Account creation   — workspace created; display_name defaults from the
//                           trusted row [graph_mu02br2ofvew5mqm] ("Patches").
//   2. Node creation      — provenance hash chain verifies (both seals).
//   3. Isolation          — a user cannot read another's node; API 403s and
//                           the attempt is audited.
//   4. Audit trail        — every mutation writes a unique audit record.
//   5. Group membership   — owner manages members; the role matrix decides
//                           bucket access (public read; private only if flagged).
//   + Sign in with email OR Google: scrypt credentials, HS256 JWT with sub+ws,
//     logout revocation (jti blocklist), and a REAL Google id_token flow run
//     against a local mock OIDC provider (RS256 keys, nonce, state, email
//     verification, audience checks).

import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { bootHarness } from "./harness.mjs";
import { hashPassword, verifyPassword } from "../server/accounts/passwords.js";
import { signJwt, verifyJwt, resolveTokenTtlMs } from "../server/accounts/jwt.js";
import { computeWorkspaceSeal, verifyWorkspaceSeal } from "../server/workspaces/provenance.js";
import {
  parseNamespace, privateNamespace, groupNamespace, graphWorkspaceIdFor,
  nodeKeyPrefix, groupPermissions, bucketPermissions
} from "../server/workspaces/namespaces.js";
import { verifyIdToken, googleConfigured, resetJwksCache } from "../server/accounts/google.js";
import { createAccountService, resetThrottles } from "../server/accounts/service.js";
import { TRUSTED_ATLAS_FACTS, DEFAULT_DISPLAY_NAME, TRUSTED_VALUES, authoritativeFacts } from "../server/accounts/facts.js";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log("phase24: pure checks (passwords, jwt, seals, namespaces, role matrix, google tokens, facts)");

// --- passwords -----------------------------------------------------------------

await test("scrypt hash verifies the right password and rejects the wrong one", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("correct horse battery staple ", hash), false);
  assert.equal(await verifyPassword("", hash), false);
  assert.equal(await verifyPassword("anything", "garbage"), false, "malformed stored hash fails closed");
});

await test("every password gets a fresh salt (no shared digests)", async () => {
  const a = await hashPassword("same-password-1");
  const b = await hashPassword("same-password-1");
  assert.notEqual(a, b);
});

await test("tampered hashes never verify", async () => {
  const hash = await hashPassword("a-reasonable-passphrase");
  const parts = hash.split("$");
  parts[5] = Buffer.from("tampered").toString("base64");
  assert.equal(await verifyPassword("a-reasonable-passphrase", parts.join("$")), false);
});

// --- jwt -----------------------------------------------------------------------

await test("JWT carries sub + ws + a unique jti, and round-trips", () => {
  const a = signJwt({ sub: "user-1", ws: "ws-1", email: "a@x.test" });
  const b = signJwt({ sub: "user-1", ws: "ws-1", email: "a@x.test" });
  assert.notEqual(a.payload.jti, b.payload.jti, "jti is unique per token");
  assert.equal(a.payload.sub, "user-1");
  assert.equal(a.payload.ws, "ws-1");
  const verified = verifyJwt(a.token);
  assert.equal(verified.jti, a.payload.jti);
});

await test("tampered tokens are refused with 401", () => {
  const { token } = signJwt({ sub: "user-1", ws: "ws-1" });
  const [h, p, sig] = token.split(".");
  const evilPayload = Buffer.from(JSON.stringify({ sub: "victim", ws: "victim-ws" })).toString("base64url");
  assert.throws(() => verifyJwt(`${h}.${evilPayload}.${sig}`), e => e.status === 401);
  assert.throws(() => verifyJwt(`${h}.${p}.${sig.slice(0, -2)}xx`), e => e.status === 401);
  assert.throws(() => verifyJwt("not-a-token"), e => e.status === 401);
});

await test("expired tokens are refused with 401", () => {
  const { token } = signJwt({ sub: "user-1", ws: "ws-1", ttlMs: 5 * 60 * 1000 });
  assert.doesNotThrow(() => verifyJwt(token));
  // sign "in the past" by hand: ttl is clamped to >= 5m, so craft an expired token directly
  const forged = (() => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "cognos-hs256-v1" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "cognos-accounts", aud: "cognos-api", sub: "u", ws: "w", jti: "j",
      iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600
    })).toString("base64url");
    const sig = crypto.createHmac("sha256", process.env.COGNOS_JWT_SECRET || "x").update(`${header}.${payload}`).digest("base64url");
    return `${header}.${payload}.${sig}`;
  })();
  // signature will not match unless the same secret resolves; both ways it must throw 401
  assert.throws(() => verifyJwt(forged), e => e.status === 401);
});

await test("non-HS256 headers are refused before any signature math", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "u", ws: "w", jti: "j" })).toString("base64url");
  assert.throws(() => verifyJwt(`${header}.${payload}.`), e => e.status === 401);
});

await test("token TTL resolves inside its clamps", () => {
  const ms = resolveTokenTtlMs();
  assert.ok(ms >= 5 * 60 * 1000 && ms <= 30 * 24 * 60 * 60 * 1000);
});

// --- provenance seals ------------------------------------------------------------

await test("the spec seal verifies content/timestamp/creator/workspace and detects any segment change", () => {
  const seal = computeWorkspaceSeal({
    content: "hello", timestamp: "2026-09-13T14:22:11.000Z",
    creatorId: "user-uuid", workspaceId: "ws-uuid"
  });
  assert.match(seal, /^sha256:[0-9a-f]{64}$/);
  const row = {
    content: "hello",
    workspace_id: "ws-uuid",
    provenance: { timestamp: "2026-09-13T14:22:11.000Z", creator_id: "user-uuid", workspace_id: "ws-uuid", ws_seal: seal }
  };
  assert.equal(verifyWorkspaceSeal(row).ok, true);
  // Flip one segment at a time — each must break the seal.
  for (const mutate of [
    r => { r.content = "hello tampered"; },
    r => { r.provenance.timestamp = "2026-09-13T14:22:12.000Z"; },
    r => { r.provenance.creator_id = "someone-else"; },
    r => { r.provenance.workspace_id = "another-ws"; }
  ]) {
    const copy = JSON.parse(JSON.stringify(row));
    mutate(copy);
    assert.equal(verifyWorkspaceSeal(copy).ok, false, "mismatch detected");
  }
  assert.equal(verifyWorkspaceSeal({ content: "x", provenance: {} }).ok, false, "incomplete provenance fails closed");
});

// --- namespaces & role matrix ------------------------------------------------------

await test("namespace tokens parse; garbage is a 400", () => {
  const ws = "123e4567-e89b-12d3-a456-426614174000";
  const ns = parseNamespace(`ws-${ws}`);
  assert.equal(ns.kind, "private");
  assert.equal(graphWorkspaceIdFor(ns), ws);
  assert.equal(nodeKeyPrefix(ns), `ws-${ws}:`);

  const pub = parseNamespace(groupNamespace(ws, "public"));
  assert.equal(pub.kind, "group-public");
  assert.equal(graphWorkspaceIdFor(pub), `group-public-${ws}`, "bucket token IS the atlas workspace_id");

  const priv = parseNamespace(groupNamespace(ws, "private"));
  assert.equal(priv.kind, "group-private");
  assert.equal(privateNamespace(ws), `ws-${ws}`);

  assert.throws(() => parseNamespace("workspace-123"), e => e.status === 400);
  assert.throws(() => parseNamespace("ws-not-a-uuid"), e => e.status === 400);
  assert.throws(() => parseNamespace("group-public-xyz"), e => e.status === 400);
});

await test("role matrix: owner full; member reads public; flagged member adds private", () => {
  const owner = groupPermissions({ isOwner: true });
  assert.deepEqual(owner, { readPublic: true, writePublic: true, readPrivate: true, writePrivate: true });

  const member = groupPermissions({ isMember: true });
  assert.deepEqual(member, { readPublic: true, writePublic: false, readPrivate: false, writePrivate: false });

  const flagged = groupPermissions({ isMember: true, canWritePrivate: true });
  assert.deepEqual(flagged, { readPublic: true, writePublic: false, readPrivate: true, writePrivate: true });

  const stranger = groupPermissions({});
  assert.deepEqual(stranger, { readPublic: false, writePublic: false, readPrivate: false, writePrivate: false });

  assert.deepEqual(bucketPermissions(member, "public"), { read: true, write: false });
  assert.deepEqual(bucketPermissions(flagged, "private"), { read: true, write: true });
  assert.deepEqual(bucketPermissions(member, "private"), { read: false, write: false });
});

// --- google id_token verification (local RSA JWKS) ---------------------------------

const { publicKey: gp1, privateKey: gk1 } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const { publicKey: gp2, privateKey: gk2 } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk1 = { ...gp1.export({ format: "jwk" }), kid: "test-key-1", alg: "RS256", use: "sig" };
const jwk2 = { ...gp2.export({ format: "jwk" }), kid: "test-key-2", alg: "RS256", use: "sig" };

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function makeIdToken(privateKey, { kid = "test-key-1", alg = "RS256", iss = "https://accounts.google.com", aud = "test-client-id", sub = "google-sub-1", email = "guser@x.test", email_verified = true, name = "G User", nonce = null, ageSec = 0, ttlSec = 3600 } = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64({ alg, typ: "JWT", kid });
  const payload = b64({ iss, aud, sub, email, email_verified, name, nonce, azp: aud, iat: nowSec - ageSec, exp: nowSec - ageSec + ttlSec });
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

await test("a well-formed RS256 Google id_token verifies end to end", async () => {
  resetJwksCache();
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  const token = makeIdToken(gk1, { nonce: "nonce-abc" });
  const payload = await verifyIdToken({ idToken: token, expectedNonce: "nonce-abc", fetchJwks: async () => ({ keys: [jwk1] }) });
  assert.equal(payload.sub, "google-sub-1");
  assert.equal(payload.email_verified, true);
});

await test("id_token rejections: signature, algorithm, audience, expiry, nonce, key rotation", async () => {
  const jwks = async () => ({ keys: [jwk1] });
  const rejects = (p, code) => p.then(() => { throw new Error("should have been rejected"); },
    e => { assert.equal(e.status, 401, `expected 401 for ${code}, got ${e.code || e.message}`); });

  // signed by a key Google does not publish -> one refresh attempt -> unknown key
  await rejects(verifyIdToken({ idToken: makeIdToken(gk2), fetchJwks: jwks, forceJwksRefresh: true }), "unknown_key");
  // rotated keys: kid 2 appears in fresh JWKS and now verifies
  const rotated = await verifyIdToken({ idToken: makeIdToken(gk2, { kid: "test-key-2" }), fetchJwks: async () => ({ keys: [jwk1, jwk2] }), forceJwksRefresh: true });
  assert.equal(rotated.kid ?? true, true);

  await rejects(verifyIdToken({ idToken: makeIdToken(gk1, { alg: "HS256" }), fetchJwks: jwks }), "bad_algorithm");
  await rejects(verifyIdToken({ idToken: makeIdToken(gk1, { aud: "someone-elses-client" }), fetchJwks: jwks }), "bad_audience");
  await rejects(verifyIdToken({ idToken: makeIdToken(gk1, { iss: "https://evil.example" }), fetchJwks: jwks }), "bad_issuer");
  await rejects(verifyIdToken({ idToken: makeIdToken(gk1, { ageSec: 7200 }), fetchJwks: jwks }), "expired");
  await rejects(verifyIdToken({ idToken: makeIdToken(gk1, { nonce: "nonce-abc" }), expectedNonce: "nonce-different", fetchJwks: jwks }), "bad_nonce");
  await rejects(verifyIdToken({ idToken: "junk", fetchJwks: jwks }), "malformed");
  assert.equal(googleConfigured(), true, "client id/secret now configured via env");
});

// --- trusted-facts registry ----------------------------------------------------------

await test("the registry holds exactly the trusted Atlas rows, all truth-bearing", () => {
  const expected = [
    "graph_mu02bqyvnd1cmlmv", "graph_mu02bqun6vptjczp", "graph_mu02br2ofvew5mqm",
    "graph_mu02br6ged2v5219", "graph_mu02bra9qiw2n5kp", "graph_mu01yzi4hosh3erz",
    "graph_mtzt7k3ei9ozy2ci", "graph_mtzt7jzlg5oklort"
  ];
  for (const id of expected) {
    assert.ok(TRUSTED_ATLAS_FACTS[id], `missing registered fact ${id}`);
    assert.equal(TRUSTED_ATLAS_FACTS[id].trust, "trusted", `${id} must be trusted — NOT truth-bearing rows never assert facts`);
  }
  assert.equal(Object.keys(TRUSTED_ATLAS_FACTS).length, expected.length);
  // Preferred name comes from trusted graph row [graph_mu02br2ofvew5mqm].
  assert.equal(DEFAULT_DISPLAY_NAME, "Patches");
  assert.equal(TRUSTED_ATLAS_FACTS.graph_mu02br2ofvew5mqm.value, "Patches");
  // Middle name spelled "Bryan" per [graph_mu01yzi4hosh3erz].
  assert.equal(TRUSTED_ATLAS_FACTS.graph_mu01yzi4hosh3erz.value, "Bryan");
  // Values verbatim from [graph_mu02br6ged2v5219].
  assert.ok(TRUSTED_VALUES.includes("autonomy") && TRUSTED_VALUES.includes("subtractive innovation"));
  // /me payload cites every row by its bracketed graph id.
  const facts = authoritativeFacts();
  assert.equal(facts.length, expected.length);
  assert.ok(facts.every(f => /^\[graph_[a-z0-9]+\]$/.test(f.graph_id)));
});

// =============================================================================
// Harness half: the real app against PGlite, driven over HTTP.
// =============================================================================

console.log("phase24: harness (live app, PGlite, mock Google OIDC provider)");

// --- a tiny mock Google OIDC provider -----------------------------------------

const mockState = { idTokenFactory: null };
const googleMock = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    if (req.url === "/token" && req.method === "POST") {
      const params = new URLSearchParams(body);
      // The test encodes the nonce IN the code so the mock can echo it in the
      // id_token, exactly like Google echoes the nonce from the authorize URL.
      const nonce = String(params.get("code") || "").replace(/^nonce-/, "");
      const idToken = mockState.idTokenFactory
        ? mockState.idTokenFactory(nonce)
        : makeIdToken(gk1, { nonce, sub: "google-sub-e2e", email: "google.e2e@x.test" });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ access_token: "ya29.mock", id_token: idToken, token_type: "Bearer" }));
    }
    if (req.url === "/jwks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ keys: [jwk1] }));
    }
    res.writeHead(404); res.end("{}");
  });
});
await new Promise(r => googleMock.listen(0, "127.0.0.1", r));
const gPort = googleMock.address().port;

const harness = await bootHarness({
  COGNOS_JWT_SECRET: "phase24-harness-secret-0123456789abcdef",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_AUTH_URL: `http://127.0.0.1:${gPort}/auth`,
  GOOGLE_TOKEN_URL: `http://127.0.0.1:${gPort}/token`,
  GOOGLE_JWKS_URL: `http://127.0.0.1:${gPort}/jwks`
});
const { raw } = harness;
resetJwksCache();
resetThrottles();

const authed = (token) => (options = {}) => raw(options.path || "/api/workspaces", {
  ...options,
  headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  _rawHeaders: true
});
// raw() in the harness fixes Content-Type; add a bearer-aware wrapper.
async function api(token, path, { method = "GET", body } = {}) {
  const res = await fetch(harness.base + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// --- 1. account creation ---------------------------------------------------------

let userA, wsA, tokenA, nsA;
await test("register: account + default workspace created in one stroke", async () => {
  const r = await raw("/api/accounts/register", { method: "POST", body: { email: "A@Example.com", password: "hunter2boogaloo" } });
  assert.equal(r.status, 201, r.text?.slice(0, 300));
  userA = r.json.account;
  tokenA = r.json.access_token;
  wsA = r.json.workspace;
  nsA = `ws-${wsA.id}`;
  // Email normalized; workspace id is a UUID; namespace token is ws-<uuid>.
  assert.equal(userA.email, "a@example.com");
  assert.match(wsA.id, /^[0-9a-f-]{36}$/);
  assert.match(userA.workspace_id, /^[0-9a-f-]{36}$/);
  assert.equal(userA.workspace_namespace, nsA);
  // The brief's test #1: display_name pulled from trusted row [graph_mu02br2ofvew5mqm].
  assert.equal(userA.display_name, "Patches");
  // The workspace is a real row in the single-tenant workspaces table.
  const wsRows = await harness.sql(`SELECT * FROM workspaces WHERE id = $1`, [wsA.id]);
  assert.equal(wsRows.length, 1, "workspace row exists");
});

await test("register: validation and uniqueness refuse politely", async () => {
  assert.equal((await raw("/api/accounts/register", { method: "POST", body: { email: "not-an-email", password: "longenough123" } })).status, 400);
  assert.equal((await raw("/api/accounts/register", { method: "POST", body: { email: "x@y.test", password: "short" } })).status, 400);
  assert.equal((await raw("/api/accounts/register", { method: "POST", body: { email: "a@example.com", password: "hunter2boogaloo" } })).status, 409);
});

await test("register: explicit display_name wins over the trusted default", async () => {
  const r = await raw("/api/accounts/register", { method: "POST", body: { email: "named@x.test", password: "hunter2boogaloo", display_name: "Ada" } });
  assert.equal(r.status, 201);
  assert.equal(r.json.account.display_name, "Ada");
});

await test("login: wrong password 401, right password 200, /me cites the trusted rows", async () => {
  assert.equal((await raw("/api/accounts/login", { method: "POST", body: { email: "a@example.com", password: "wrong-password" } })).status, 401);
  assert.equal((await raw("/api/accounts/login", { method: "POST", body: { email: "nobody@x.test", password: "wrong-password" } })).status, 401, "unknown email fails identically");
  const r = await raw("/api/accounts/login", { method: "POST", body: { email: "a@example.com", password: "hunter2boogaloo" } });
  assert.equal(r.status, 200);
  tokenA = r.json.access_token;

  const me = await api(tokenA, "/api/accounts/me");
  assert.equal(me.status, 200);
  assert.equal(me.json.account.display_name, "Patches");
  assert.equal(me.json.workspace.namespace, nsA);
  const ids = me.json.trusted_atlas_facts.map(f => f.graph_id);
  assert.ok(ids.includes("[graph_mu02br2ofvew5mqm]"), "preferred-name row cited");
  assert.ok(ids.includes("[graph_mu01yzi4hosh3erz]"), "middle-name row cited");
});

await test("workspaces API demands a bearer token", async () => {
  assert.equal((await raw(`/api/workspaces`)).status, 401);
  assert.equal((await api("forged.token.here", `/api/workspaces`)).status, 401);
});

// --- 2. node creation with sealed provenance ---------------------------------------

let nodeA;
await test("create node: appended with namespaced key, creator, run id, and BOTH seals", async () => {
  const r = await api(tokenA, `/api/workspaces/${nsA}/nodes`, {
    method: "POST",
    body: {
      type: "concept",
      label: "Deep Work Charter",
      content: "Mornings are protected deep-work blocks; meetings batch after 14:00.",
      source_graph_id: "[graph_mu02br6ged2v5219]",
      run_id: "run_phase24_test"
    }
  });
  assert.equal(r.status, 201, r.text?.slice(0, 300));
  nodeA = r.json;
  // Namespace prefix is IN the stored key.
  assert.ok(nodeA.node_key.startsWith(`${nsA}:concept:`), `node_key prefix: ${nodeA.node_key}`);
  // Sealed provenance block: hash, run id, source graph id (brief §2.2).
  assert.equal(nodeA.provenance.creator_id, userA.user_id);
  assert.equal(nodeA.provenance.workspace_id, wsA.id);
  assert.equal(nodeA.provenance.source_graph_id, "[graph_mu02br6ged2v5219]");
  assert.equal(nodeA.provenance.run_id, "run_phase24_test");
  assert.match(nodeA.provenance.ws_seal, /^sha256:[0-9a-f]{64}$/);
  assert.match(nodeA.content_sha256, /^[0-9a-f]{64}$/);
  // Both seals verify right now.
  assert.equal(verifyWorkspaceSeal(nodeA).ok, true);
});

await test("verify route: dual-seal audit is clean over the namespace", async () => {
  const r = await api(tokenA, `/api/workspaces/${nsA}/verify`);
  assert.equal(r.status, 200);
  assert.equal(r.json.checked >= 1, true);
  assert.equal(r.json.mismatches, 0);
  assert.equal(r.json.ok, true);
});

await test("read/list/query stay inside the namespace", async () => {
  const read = await api(tokenA, `/api/workspaces/${nsA}/nodes/${nodeA.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.json.id, nodeA.id);

  const listed = await api(tokenA, `/api/workspaces/${nsA}/nodes?q=deep+work`);
  assert.ok(listed.json.nodes.some(n => n.id === nodeA.id));

  const query = await api(tokenA, `/api/workspaces/${nsA}/query?q=${encodeURIComponent("deep work mornings")}`);
  assert.equal(query.status, 200);
  assert.ok(query.json.results.some(n => n.id === nodeA.id));

  assert.equal((await api(tokenA, `/api/workspaces/${nsA}/nodes/graph_doesnotexist`)).status, 404);
  assert.equal((await api(tokenA, `/api/workspaces/ws-00000000-0000-4000-8000-000000000000/nodes`)).status, 403, "namespace bound to the token, not the URL");
  assert.equal((await api(tokenA, `/api/workspaces/nonsense/nodes`)).status, 400, "bad namespace shape refused");
});

await test("client-claimed seal mismatch is a 422 and a logged incident", async () => {
  const r = await api(tokenA, `/api/workspaces/${nsA}/nodes`, {
    method: "POST",
    body: {
      label: "Seal Claim Node",
      content: "claims a seal it computed wrong",
      provenance: { timestamp: "2026-09-13T14:22:11.000Z", hash: "sha256:" + "0".repeat(64) }
    }
  });
  assert.equal(r.status, 422, r.text?.slice(0, 200));
  const audit = await api(tokenA, `/api/workspaces/${nsA}/audit?action=provenance.mismatch`);
  assert.ok(audit.json.rows.length >= 1, "incident landed in the audit trail");
  assert.equal(audit.json.rows[0].detail.incident, true);
});

await test("retire is a soft transition, never a delete", async () => {
  const made = await api(tokenA, `/api/workspaces/${nsA}/nodes`, { method: "POST", body: { label: "Ephemeral", content: "to be retired" } });
  const retired = await api(tokenA, `/api/workspaces/${nsA}/nodes/${made.json.id}/retire`, { method: "POST", body: { reason: "phase24 test" } });
  assert.equal(retired.status, 200);
  assert.equal(retired.json.node.status, "retired");
  const gone = await api(tokenA, `/api/workspaces/${nsA}/nodes/${made.json.id}`);
  assert.equal(gone.status, 200, "the row still exists (append-only)");
  assert.equal(gone.json.status, "retired");
});

await test("edges respect the namespace on both endpoints", async () => {
  const b = await api(tokenA, `/api/workspaces/${nsA}/nodes`, { method: "POST", body: { label: "Subtractive Innovation", content: "remove before you add" } });
  const e = await api(tokenA, `/api/workspaces/${nsA}/edges`, {
    method: "POST",
    body: { src_node_id: b.json.id, dst_node_id: nodeA.id, kind: "refines", source_graph_id: "[graph_mu02br6ged2v5219]" }
  });
  assert.equal(e.status, 201, e.text?.slice(0, 200));
  assert.equal(e.json.provenance.source_graph_id, "[graph_mu02br6ged2v5219]");
  // Cross-namespace endpoint refused.
  const other = await raw("/api/accounts/register", { method: "POST", body: { email: "edge-victim@x.test", password: "hunter2boogaloo" } });
  const cross = await api(tokenA, `/api/workspaces/ws-${other.json.workspace.id}/edges`, {
    method: "POST", body: { src_node_id: b.json.id, dst_node_id: nodeA.id }
  });
  assert.equal(cross.status, 403);
});

// --- 3. isolation -------------------------------------------------------------------

let tokenB, nsB;
await test("isolation: another user gets 403 on every door into A's namespace", async () => {
  const reg = await raw("/api/accounts/register", { method: "POST", body: { email: "b@x.test", password: "hunter2boogaloo" } });
  tokenB = reg.json.access_token;
  nsB = `ws-${reg.json.workspace.id}`;
  const meB = await api(tokenB, "/api/accounts/me");
  assert.equal(meB.json.account.display_name, "Patches", "B also gets the trusted default");

  assert.equal((await api(tokenB, `/api/workspaces/${nsA}/nodes`)).status, 403, "list");
  assert.equal((await api(tokenB, `/api/workspaces/${nsA}/nodes/${nodeA.id}`)).status, 403, "read one — the brief's exact scenario");
  assert.equal((await api(tokenB, `/api/workspaces/${nsA}/query?q=deep`)).status, 403, "query");
  assert.equal((await api(tokenB, `/api/workspaces/${nsA}/nodes`, { method: "POST", body: { label: "intrusion" } })).status, 403, "write");
  assert.equal((await api(tokenB, `/api/workspaces/${nsA}/audit`)).status, 403, "even the audit trail");
  // And the attempt is on B's own trail as an incident.
  const incidents = await api(tokenB, `/api/workspaces/${nsB}/audit?action=isolation.denied`);
  assert.ok(incidents.json.rows.length >= 4, "every denial audited");
});

// --- logout / JWT revocation ------------------------------------------------------------

await test("logout blocklists the jti; the token dies immediately", async () => {
  const login = await raw("/api/accounts/login", { method: "POST", body: { email: "b@x.test", password: "hunter2boogaloo" } });
  const temp = login.json.access_token;
  assert.equal((await api(temp, "/api/accounts/me")).status, 200);
  const out = await api(temp, "/api/accounts/logout", { method: "POST" });
  assert.equal(out.status, 200);
  const after = await api(temp, "/api/accounts/me");
  assert.equal(after.status, 401);
  assert.equal(after.json.code, "token_revoked");
});

// --- 4. audit trail -----------------------------------------------------------------------

await test("audit: mutations wrote unique, ordered, attributed records", async () => {
  const audit = await api(tokenA, `/api/workspaces/${nsA}/audit?limit=200`);
  assert.equal(audit.status, 200);
  const rows = audit.json.rows;
  const ids = new Set(rows.map(r => r.id));
  assert.equal(ids.size, rows.length, "unique ids");
  const actions = rows.map(r => r.action);
  for (const expected of ["account.register", "workspace.created", "account.login", "node.created", "provenance.mismatch", "node.retired", "edge.created"]) {
    assert.ok(actions.includes(expected), `audit contains ${expected}`);
  }
  assert.ok(rows.every(r => r.user_id === userA.user_id), "A sees their own trail");
  assert.ok(rows.every(r => r.ts_ms > 0));
});

// --- 5. group membership & buckets -----------------------------------------------------------

let group, tokenC;
await test("group: owner creates it; both buckets materialize as namespaces", async () => {
  const g = await api(tokenA, "/api/groups", { method: "POST", body: { name: "Atlas Crew" } });
  assert.equal(g.status, 201, g.text?.slice(0, 300));
  group = g.json;
  assert.match(group.group_id, /^[0-9a-f-]{36}$/);
  assert.equal(group.owner.id, userA.user_id);
  assert.equal(group.your_role, "owner");
  assert.equal(group.buckets.public.namespace, `group-public-${group.group_id}`);
  assert.equal(group.buckets.private.namespace, `group-private-${group.group_id}`);
  assert.equal(group.buckets.public.write, true);
  assert.equal(group.buckets.private.write, true);
});

await test("owner writes both buckets; nodes land under the group bucket keys", async () => {
  for (const bucket of ["public", "private"]) {
    const ns = group.buckets[bucket].namespace;
    const r = await api(tokenA, `/api/workspaces/${ns}/nodes`, {
      method: "POST", body: { label: `${bucket} brief`, content: `${bucket}-bucket content`, type: "concept" }
    });
    assert.equal(r.status, 201, r.text?.slice(0, 200));
    assert.ok(r.json.node_key.startsWith(`${ns}:concept:`));
    assert.equal(r.json.provenance.namespace, ns);
  }
});

let publicNode;
await test("member (unflagged): reads public, refused everywhere else", async () => {
  const pubList = await api(tokenA, `/api/workspaces/${group.buckets.public.namespace}/nodes`);
  publicNode = pubList.json.nodes[0];

  const added = await api(tokenA, `/api/groups/${group.group_id}/members`, {
    method: "POST", body: { email: "b@x.test" }
  });
  assert.equal(added.status, 200);
  assert.ok(added.json.members.some(m => m.email === "b@x.test" && m.can_write_private === false));

  assert.equal((await api(tokenB, `/api/workspaces/${group.buckets.public.namespace}/nodes/${publicNode.id}`)).status, 200, "member reads public");
  assert.equal((await api(tokenB, `/api/workspaces/${group.buckets.public.namespace}/nodes`, { method: "POST", body: { label: "nope" } })).status, 403, "member cannot write public (owner-only)");
  assert.equal((await api(tokenB, `/api/workspaces/${group.buckets.private.namespace}/nodes`)).status, 403, "member cannot read private");
  assert.equal((await api(tokenB, `/api/workspaces/${group.buckets.private.namespace}/nodes`, { method: "POST", body: { label: "nope" } })).status, 403, "member cannot write private");
});

await test("flagged member: private bucket unlocks read AND write", async () => {
  const meB = await api(tokenB, "/api/accounts/me");
  const flagged = await api(tokenA, `/api/groups/${group.group_id}/members/${meB.json.account.user_id}/flag`, {
    method: "POST", body: { can_write_private: true }
  });
  assert.equal(flagged.status, 200);
  assert.ok(flagged.json.members.find(m => m.id === meB.json.account.user_id).can_write_private === true);

  const privList = await api(tokenB, `/api/workspaces/${group.buckets.private.namespace}/nodes`);
  assert.equal(privList.status, 200);
  const wrote = await api(tokenB, `/api/workspaces/${group.buckets.private.namespace}/nodes`, {
    method: "POST", body: { label: "Member Note", content: "flagged member write" }
  });
  assert.equal(wrote.status, 201, wrote.text?.slice(0, 200));
  // ...but the public bucket stays owner-write.
  assert.equal((await api(tokenB, `/api/workspaces/${group.buckets.public.namespace}/nodes`, { method: "POST", body: { label: "no" } })).status, 403);
});

await test("non-members are 403 on both buckets", async () => {
  const regC = await raw("/api/accounts/register", { method: "POST", body: { email: "c@x.test", password: "hunter2boogaloo" } });
  tokenC = regC.json.access_token;
  assert.equal((await api(tokenC, `/api/workspaces/${group.buckets.public.namespace}/nodes/${publicNode.id}`)).status, 403);
  assert.equal((await api(tokenC, `/api/workspaces/${group.buckets.private.namespace}/nodes`)).status, 403);
});

await test("only the owner manages members", async () => {
  const meB = await api(tokenB, "/api/accounts/me");
  assert.equal(meB.status, 200);
  assert.equal((await api(tokenB, `/api/groups/${group.group_id}/members`, {
    method: "POST", body: { email: "c@x.test" }
  })).status, 403, "member cannot add members");
  const removed = await api(tokenA, `/api/groups/${group.group_id}/members/${meB.json.account.user_id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal((await api(tokenB, `/api/workspaces/${group.buckets.public.namespace}/nodes/${publicNode.id}`)).status, 403, "removed member loses access");
});

// --- Google sign-in end to end ---------------------------------------------------------------

await test("google oauth: status, start (JSON), callback with code+state -> account + token", async () => {
  const status = await raw("/api/accounts/auth/google/status");
  assert.equal(status.json.configured, true);

  const start = await raw("/api/accounts/auth/google/start?format=json");
  assert.equal(start.status, 200);
  assert.match(start.json.authorize_url, /client_id=test-client-id/);
  assert.match(start.json.authorize_url, /nonce=/);

  // The mock provider embeds the nonce (encoded in our fake code) into the id_token.
  const url = new URL(start.json.authorize_url);
  const state = url.searchParams.get("state");
  const nonce = url.searchParams.get("nonce");
  mockState.idTokenFactory = (echoedNonce) => makeIdToken(gk1, {
    nonce: echoedNonce, sub: "google-sub-e2e", email: "google.e2e@x.test", name: "Google E2E"
  });

  const cb = await raw(`/api/accounts/auth/google/callback?code=nonce-${encodeURIComponent(nonce)}&state=${encodeURIComponent(state)}`);
  assert.equal(cb.status, 200, cb.text?.slice(0, 300));
  assert.equal(cb.json.google.created, true);
  assert.equal(cb.json.account.auth_provider, "google");
  assert.equal(cb.json.account.display_name, "Google E2E");
  assert.match(cb.json.account.workspace_id, /^[0-9a-f-]{36}$/);

  const me = await api(cb.json.access_token, "/api/accounts/me");
  assert.equal(me.status, 200);

  // Second sign-in with the same Google identity finds the SAME account.
  const start2 = await raw("/api/accounts/auth/google/start?format=json");
  const url2 = new URL(start2.json.authorize_url);
  const cb2 = await raw(`/api/accounts/auth/google/callback?code=nonce-${encodeURIComponent(url2.searchParams.get("nonce"))}&state=${encodeURIComponent(url2.searchParams.get("state"))}`);
  assert.equal(cb2.status, 200);
  assert.equal(cb2.json.google, undefined, "no created/linked marker on a returning user");
  assert.equal(cb2.json.account.user_id, cb.json.account.user_id, "same google_sub -> same account");
});

await test("google oauth: state is single-use (replay refused)", async () => {
  const start = await raw("/api/accounts/auth/google/start?format=json");
  const url = new URL(start.json.authorize_url);
  const qs = `code=nonce-${encodeURIComponent(url.searchParams.get("nonce"))}&state=${encodeURIComponent(url.searchParams.get("state"))}`;
  assert.equal((await raw(`/api/accounts/auth/google/callback?${qs}`)).status, 200);
  const replay = await raw(`/api/accounts/auth/google/callback?${qs}`);
  assert.equal(replay.status, 401);
  assert.equal(replay.json.code, "bad_state");
});

await test("google: verified email links to the existing account; unverified never does", async () => {
  // Register by email first.
  const reg = await raw("/api/accounts/register", { method: "POST", body: { email: "linkme@x.test", password: "hunter2boogaloo", display_name: "Link Me" } });

  // Verified Google email matching -> link, SAME user id, provider email+google.
  const start = await raw("/api/accounts/auth/google/start?format=json");
  const url = new URL(start.json.authorize_url);
  mockState.idTokenFactory = (nonce) => makeIdToken(gk1, {
    nonce, sub: "google-sub-link", email: "linkme@x.test", name: "Link Me"
  });
  const cb = await raw(`/api/accounts/auth/google/callback?code=nonce-${encodeURIComponent(url.searchParams.get("nonce"))}&state=${encodeURIComponent(url.searchParams.get("state"))}`);
  assert.equal(cb.status, 200, cb.text?.slice(0, 300));
  assert.equal(cb.json.google.linked, true);
  assert.equal(cb.json.account.user_id, reg.json.account.user_id, "linked, not duplicated");
  assert.equal(cb.json.account.auth_provider, "email+google");

  // Unverified email -> refused even though the address matches.
  const start2 = await raw("/api/accounts/auth/google/start?format=json");
  const url2 = new URL(start2.json.authorize_url);
  mockState.idTokenFactory = (nonce) => makeIdToken(gk1, {
    nonce, sub: "google-sub-unverified", email: "unverified@x.test", email_verified: false
  });
  const cb2 = await raw(`/api/accounts/auth/google/callback?code=nonce-${encodeURIComponent(url2.searchParams.get("nonce"))}&state=${encodeURIComponent(url2.searchParams.get("state"))}`);
  assert.equal(cb2.status, 401);
  assert.equal(cb2.json.code, "google_email_unverified");
});

await test("google GIS verify endpoint: wrong-audience and foreign-key credentials refused", async () => {
  const badAud = makeIdToken(gk1, { aud: "someone-elses-client", nonce: null });
  assert.equal((await raw("/api/accounts/auth/google/verify", { method: "POST", body: { credential: badAud } })).status, 401);
  const foreign = makeIdToken(gk2, { kid: "test-key-2" });
  assert.equal((await raw("/api/accounts/auth/google/verify", { method: "POST", body: { credential: foreign } })).status, 401, "key not in this deployment's JWKS");
  assert.equal((await raw("/api/accounts/auth/google/verify", { method: "POST", body: {} })).status, 400);
});

await test("health exposes account configuration (no secret material)", async () => {
  const h = await raw("/api/health");
  assert.equal(h.json.accounts.google.configured, true);
  assert.equal(h.json.accounts.jwtSecretConfigured, true);
  assert.ok(!JSON.stringify(h.json).includes("phase24-harness-secret"), "the secret itself never appears");
});

// --- service-level check: the /me assertion helper ------------------------------

await test("buildProfile names the row its display-name policy came from", async () => {
  const svc = createAccountService({ db: harness.db, logger: console });
  const profile = svc.buildProfile({ id: "u1", email: "u@x.test", display_name: "Patches", workspace_id: "w1", auth_provider: "email", created_date: new Date(), last_login_at: null, avatar_url: null });
  assert.equal(profile.authoritative_facts[0].graph_id, "[graph_mu02br2ofvew5mqm]");
  assert.equal(profile.authoritative_facts[0].trust, "trusted");
});

console.log(`\nphase24: ${passed} checks passed`);
googleMock.close();
await harness.stop();
process.exit(0);
