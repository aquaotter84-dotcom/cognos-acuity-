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
