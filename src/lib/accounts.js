// Phase 24 — minimal account client for the sign-in page.
//
// The legacy app stays single-tenant (no AuthProvider, no protected routes);
// this module serves /signin only. The JWT is kept in localStorage under a
// single key; the /api/accounts/* endpoints are same-origin, so no VITE_ vars.

const TOKEN_KEY = "cognos_access_token";

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode */ }
}

/** A Google callback may hand the token back in the URL fragment (#access_token=…). */
export function consumeHashToken() {
  try {
    if (!location.hash.includes("access_token=")) return null;
    const hash = new URLSearchParams(location.hash.slice(1));
    const token = hash.get("access_token");
    if (token) {
      setToken(token);
      // Scrub the fragment so the token doesn't linger in the address bar.
      history.replaceState(null, "", location.pathname + location.search);
    }
    return token;
  } catch { return null; }
}

async function call(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  const bearer = token || getToken();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = json?.code || null;
    throw err;
  }
  return json;
}

export const accountsApi = {
  register: ({ email, password, displayName }) =>
    call("/api/accounts/register", { method: "POST", body: { email, password, display_name: displayName || undefined } }),
  login: ({ email, password }) =>
    call("/api/accounts/login", { method: "POST", body: { email, password } }),
  me: (token) => call("/api/accounts/me", { token }),
  logout: () => call("/api/accounts/logout", { method: "POST" }),
  googleStatus: () => call("/api/accounts/auth/google/status"),
  /** Full-page redirect to Google's consent screen (state lives server-side). */
  async startGoogleSignIn() {
    const res = await fetch("/api/accounts/auth/google/start?format=json", { headers: { Accept: "application/json" } });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(json?.error || "Google sign-in is unavailable");
      err.code = json?.code || null;
      throw err;
    }
    location.href = json.authorize_url;
  }
};
