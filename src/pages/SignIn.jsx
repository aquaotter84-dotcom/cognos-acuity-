// Phase 24 — the sign-in page.
//
// Two ways in, exactly as the brief requires: email + password, or Google.
// Sits OUTSIDE CognosLayout (the legacy app remains single-tenant and
// ungated); this page is the front door for the /api/accounts and
// /api/workspaces surface.
//
// Provenance note: when a profile is loaded, the default display name comes
// from trusted Atlas row [graph_mu02br2ofvew5mqm] ("Patches") — the page shows
// the registry it cites rather than asserting facts of its own.

import { useEffect, useState } from 'react';
import { Brain, Mail, Lock, User as UserIcon, LogOut, ShieldCheck, Loader2 } from 'lucide-react';
import { accountsApi, getToken, setToken, consumeHashToken } from '@/lib/accounts';

const card = "rounded-xl border border-border bg-card p-4 text-sm";
const input = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/40";
const btn = "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-50";
const errBox = "rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive";

export default function SignIn() {
  const [mode, setMode] = useState('signin'); // signin | register
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [session, setSession] = useState(null); // { account, workspace, trusted_atlas_facts }
  const [googleReady, setGoogleReady] = useState(null); // null = unknown

  const loadMe = async (token) => {
    const me = await accountsApi.me(token);
    setSession(me);
  };

  useEffect(() => {
    const fromHash = consumeHashToken();
    const token = getToken();
    if ((fromHash || token) && !session) {
      loadMe(fromHash || token).catch(() => setToken(null));
    }
    accountsApi.googleStatus()
      .then(s => setGoogleReady(Boolean(s.configured)))
      .catch(() => setGoogleReady(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = mode === 'register'
        ? await accountsApi.register({ email, password, displayName })
        : await accountsApi.login({ email, password });
      setToken(res.access_token);
      await loadMe(res.access_token);
      if (mode === 'register') setNotice('Account created — your private workspace is ready.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setError(null); setNotice(null); setBusy(true);
    try {
      await accountsApi.startGoogleSignIn(); // full-page navigation
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const logout = async () => {
    try { await accountsApi.logout(); } catch { /* token already dead is fine */ }
    setToken(null);
    setSession(null);
    setPassword('');
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Brain className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">COGNOS accounts</h1>
            <p className="text-xs text-muted-foreground">
              Private workspaces over the trust-annotated atlas — sign in by email or with Google.
            </p>
          </div>
        </div>

        {session ? (
          <div className="space-y-3">
            <div className={card}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <UserIcon className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <div className="font-medium">{session.account.display_name}</div>
                    <div className="text-xs text-muted-foreground">{session.account.email}</div>
                  </div>
                </div>
                <button className={`${btn} border border-border hover:bg-accent`} onClick={logout}>
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
              </div>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <dt>Workspace</dt><dd className="font-mono break-all text-foreground">{session.account.workspace_namespace}</dd>
                <dt>Provider</dt><dd className="text-foreground">{session.account.auth_provider}</dd>
              </dl>
            </div>

            <div className={card}>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <ShieldCheck className="h-4 w-4" /> Authoritative facts cited by this profile
              </div>
              <ul className="space-y-1 text-xs">
                {(session.trusted_atlas_facts || []).slice(0, 4).map(f => (
                  <li key={f.graph_id} className="flex flex-wrap items-baseline gap-x-2">
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{f.graph_id}</code>
                    <span className="text-muted-foreground">{f.subject}</span>
                    <span className="text-foreground">{Array.isArray(f.value) ? f.value.join(', ') : f.value}</span>
                    <span className="ml-auto rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">{f.trust}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Every fact the API asserts comes from a trusted Atlas row, cited by graph id. NOT truth-bearing rows never generate assertions.
              </p>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-xs font-medium">
              <button type="button" onClick={() => { setMode('signin'); setError(null); }}
                className={`rounded-md px-3 py-1.5 ${mode === 'signin' ? 'bg-background shadow' : 'text-muted-foreground'}`}>
                Sign in
              </button>
              <button type="button" onClick={() => { setMode('register'); setError(null); }}
                className={`rounded-md px-3 py-1.5 ${mode === 'register' ? 'bg-background shadow' : 'text-muted-foreground'}`}>
                Create account
              </button>
            </div>

            {mode === 'register' && (
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">Display name (optional — defaults to the trusted preferred-name fact)</span>
                <input className={input} value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Patches" maxLength={80} />
              </label>
            )}
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Email</span>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input className={`${input} pl-9`} type="email" required value={email}
                  onChange={e => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
              </div>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Password {mode === 'register' && <span className="text-[10px]">(min 8 chars)</span>}</span>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input className={`${input} pl-9`} type="password" required minLength={8} value={password}
                  onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
              </div>
            </label>

            {error && <div className={errBox} role="alert">{error}</div>}
            {notice && <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">{notice}</div>}

            <button type="submit" className={`${btn} w-full bg-primary text-primary-foreground hover:bg-primary/90`} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === 'register' ? 'Create account' : 'Sign in'}
            </button>

            <div className="flex items-center gap-3 py-1">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <button type="button" onClick={google} className={`${btn} w-full border border-border hover:bg-accent`}
              disabled={busy || googleReady === false} title={googleReady === false ? 'Google sign-in is not configured on this deployment' : undefined}>
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.51 6.16-4.51z" />
              </svg>
              {googleReady === false ? 'Google sign-in not configured' : 'Continue with Google'}
            </button>
          </form>
        )}

        <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
          Passwords are hashed with scrypt (per-user salt, timing-safe compare).
          Tokens carry your workspace binding and are revoked on sign-out.
          See <code className="font-mono">docs/WORKSPACES.md</code> for the full trust model.
        </p>
      </div>
    </div>
  );
}
