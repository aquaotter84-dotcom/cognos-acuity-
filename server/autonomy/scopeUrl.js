// URL-allowlist matching for T3 evidence fetch — Phase 20.
//
// A goal's scope.urlAllowlist names where its web.fetch skill may read. Two
// entry forms, deliberately explicit:
//
//   * exact URL — "https://example.com/docs/page" (contains "://"):
//     matches that URL exactly, fragment ignored. Query included: an exact
//     entry is exact.
//   * host or host + path prefix — "example.com", "example.com/docs":
//     matches the host EXACTLY (no subdomain widening: "example.com" does not
//     cover "evil-example.com" or "sub.example.com") with any path, or only
//     paths under the prefix on a segment boundary ("/docs" covers "/docs"
//     and "/docs/x", never "/docs2").
//
// Matching is case-insensitive on hosts. Anything that is not a string in the
// list is ignored. An empty or missing allowlist matches nothing — fetching
// is closed by default and opened entry by entry at authorization time.
//
// This answers ONLY "is this destination granted?". Whether the URL is shaped
// safely (scheme, credentials, ports, literal-IP privateness) is the UNSAFE_URL
// rule's job, and whether a hostname RESOLVES privately is safeFetch's job at
// perform time. Three gates, three places, each doing one thing.
//
// Imports sit below the header note so the file still opens with the contract:
// node:net and webhookPost give the GRANT-side validation (bottom of file) the
// adapter's own boundaries, so a grant can never be looser than a delivery.

import net from "node:net";
import { checkWebhookUrl, isLocalOrReservedHost } from "./webhookPost.js";

function splitEntry(entry) {
  const text = String(entry || "").trim();
  if (!text) return null;
  if (text.includes("://")) return { kind: "url", text };
  const withoutScheme = text.replace(/^[a-z]+:/i, "");
  const slash = withoutScheme.indexOf("/");
  const host = (slash === -1 ? withoutScheme : withoutScheme.slice(0, slash))
    .toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  let prefix = slash === -1 ? "" : withoutScheme.slice(slash);
  if (prefix && !prefix.startsWith("/")) prefix = `/${prefix}`;
  return { kind: "host", host, prefix: prefix || "" };
}

function normalizeCandidate(candidate) {
  let url;
  try {
    url = new URL(String(candidate || "").trim());
  } catch {
    return null;
  }
  url.hash = "";
  return url;
}

function pathUnder(pathname, prefix) {
  if (!prefix || prefix === "/") return true;
  const clean = prefix.endsWith("/") && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
  return pathname === clean || pathname.startsWith(`${clean}/`);
}

/**
 * @returns {{allowed: boolean, entry: string|null, reason: string}}
 */
export function urlAllowedByScope(candidate, allowlist) {
  const list = Array.isArray(allowlist) ? allowlist : [];
  const url = normalizeCandidate(candidate);
  if (!url) return { allowed: false, entry: null, reason: "not a parseable absolute URL" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");

  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const entry = splitEntry(raw);
    if (!entry) continue;
    if (entry.kind === "url") {
      const expected = normalizeCandidate(entry.text);
      if (!expected) continue;
      if (expected.href === url.href) {
        return { allowed: true, entry: raw, reason: "exact URL entry" };
      }
      continue;
    }
    if (entry.host === host && pathUnder(url.pathname || "/", entry.prefix)) {
      return { allowed: true, entry: raw, reason: "host entry" };
    }
  }
  return { allowed: false, entry: null, reason: "no allowlist entry covers this URL" };
}

// ---------------------------------------------------------------------------
// Phase 21 — destinations for an external WRITE.
//
// A read allowlist (scope.urlAllowlist) answers "where may this goal look?".
// A write destination answers a sharper question: "where may this goal ACT?".
// So a write destination is never inferred from the read allowlist, never
// free-form, and never a bare effect-type string: it is an explicit entry
// naming the skill and the destinations granted to it at authorization time.
//
//   scope.effectsAllowed: [
//     "external_read",                                        // a class grant
//     { effect: "webhook.post", destinations: ["https://hooks.example.com/cognos"] }
//   ]
//
// Both spellings of `effect` are accepted — the effect TYPE ("external_write")
// and the SKILL id ("webhook.post") — because AUTONOMY.md §4.7.1 writes the
// gate in terms of the skill and the existing Governor check reads the type.
// A class grant with no destinations grants nothing to write to: closed by
// default, opened destination by destination.
// ---------------------------------------------------------------------------

/** The scope entry granting a skill/effect, or null. */
export function scopeEntryFor(scope, { effectType = null, skillId = null } = {}) {
  const list = Array.isArray(scope?.effectsAllowed) ? scope.effectsAllowed : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const names = [entry.effect, entry.skill, entry.effectType, entry.skillId]
      .filter(v => typeof v === "string");
    if ((effectType && names.includes(effectType)) || (skillId && names.includes(skillId))) return entry;
  }
  return null;
}

/** Destinations granted to a write skill. Never falls back to the read allowlist. */
export function destinationsForScope(scope, { effectType = null, skillId = null } = {}) {
  const entry = scopeEntryFor(scope, { effectType, skillId });
  const list = Array.isArray(entry?.destinations) ? entry.destinations : [];
  return list.filter(d => typeof d === "string" && d.trim().length > 0);
}

/**
 * Is a write destination granted? Same matcher as reads — exact URL, or host
 * plus path prefix on a segment boundary — because widening rules for writes
 * would be exactly backwards. An empty grant list matches nothing.
 */
export function destinationAllowed(candidate, destinations) {
  return urlAllowedByScope(candidate, destinations);
}

// ---------------------------------------------------------------------------
// Phase 27 — validating a destination GRANT, before it is written into scope.
//
// The sections above judge attempts; this one judges grants. A destination the
// adapter would refuse is a key cut for a lock that does not exist: it can
// never be attempted, so it can never fill the shadow corpus, and the goal
// that carries it looks keyed while it is not. Because scope is immutable
// after creation (pin.goal_scope_immutable), the only moment a malformed grant
// can still be corrected is before the goal row exists — which is where the
// goal and designer create routes run this check, refusing with every bad
// entry named.
//
// Both entry shapes from scopeUrl's own contract are accepted: an exact https
// URL (validated by the adapter's own checkWebhookUrl, so a grant can never be
// looser than the delivery) and a host or host+path-prefix entry (a wider
// grant the operator makes deliberately — refused only when it names a literal
// IP or a local/reserved host, which the adapter would never deliver to).
// ---------------------------------------------------------------------------

/** A grant list longer than this is a wish list, not an authorization. */
export const MAX_DESTINATION_GRANTS = 8;

const HOST_SHAPE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** Refusal reasons for ONE entry, or null when the entry is grantable. */
function destinationEntryProblem(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return "a destination must be a non-empty string";
  if (text.length > 2000) return "a destination exceeds 2000 characters";
  if (/[\u0000-\u001F\u007F\s]/.test(text)) return "a destination cannot contain whitespace or control characters";
  if (text.includes("://")) {
    // The adapter's own gate: https, port 443, no credentials, no literal IP,
    // no local host. A grant that fails here would refuse at attempt time.
    const checked = checkWebhookUrl(text);
    if (!checked.ok) return checked.reason;
    return null;
  }
  // Host or host + path prefix. The grant-side mirror of splitEntry above:
  // what passes splitEntry's parsing is then held to the adapter's boundaries.
  const withoutScheme = text.replace(/^[a-z]+:/i, "");
  const slash = withoutScheme.indexOf("/");
  const host = (slash === -1 ? withoutScheme : withoutScheme.slice(0, slash))
    .toLowerCase().replace(/\.$/, "");
  if (!host) return "a destination has no host";
  if (host.includes("..") || !HOST_SHAPE.test(host) || host.includes(":")) {
    return `the destination host '${host.slice(0, 80)}' is not a host name`;
  }
  if (net.isIP(host)) return `the destination '${host}' names a literal IP address`;
  if (isLocalOrReservedHost(host)) return `the destination names a local or reserved host (${host})`;
  return null;
}

/**
 * Validate a destination grant list as an operator is about to authorize it.
 *
 * @returns {{ok: boolean, destinations: string[], errors: string[]}}
 *   `destinations` is the normalized grant (exact URLs in href form, fragment
 *   dropped — the shape the matcher will compare attempts against); `errors`
 *   names every entry that failed, bounded, so the refusal is a sentence the
 *   operator can act on rather than the first failure found.
 */
export function validateDestinationGrant(rawList, { limit = MAX_DESTINATION_GRANTS } = {}) {
  const list = Array.isArray(rawList) ? rawList : [];
  const errors = [];
  const destinations = [];
  const seen = new Set();
  for (const raw of list) {
    const problem = destinationEntryProblem(raw);
    if (problem) {
      if (errors.length < 6) {
        const shown = String(raw ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").slice(0, 120) || "(empty)";
        errors.push(`destination '${shown}': ${problem}`);
      }
      continue;
    }
    const text = String(raw).trim();
    const normalized = text.includes("://") ? (() => {
      // checkWebhookUrl already proved this entry parses; drop the fragment,
      // which the matcher ignores, so the stored grant is what it matches.
      const url = new URL(text);
      url.hash = "";
      return url.href;
    })() : text;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    destinations.push(normalized);
  }
  if (destinations.length > limit) {
    errors.push(`the grant names ${destinations.length} destinations; a goal may be granted at most ${limit}`);
  }
  return { ok: errors.length === 0, destinations, errors };
}
