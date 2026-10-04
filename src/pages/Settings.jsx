// Ported from the original src/pages/Settings.jsx.
// DIVERGENCE: no account section, no API-key field, no billing. Keys live in
// server env vars only and are never sent to the browser. What remains is the
// workspace instructions editor (which feeds buildContextSystemPrompt verbatim),
// local browser voice preferences, and runtime status from /api/health.
import { useState, useEffect, useCallback } from 'react';
import { Settings as SettingsIcon, Menu, Check, X, Square, Volume2, ShieldAlert, Scale, Trash2, Sun, Moon, Database, Pencil, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { Pill } from '@/components/system/SystemUi';
import { useCognos } from '@/lib/cognosContext';
import { useVoice } from '@/lib/voiceContext';
import { diagnoseTtsNative } from '@/lib/ttsNative';
import { getTheme, applyTheme } from '@/lib/theme';
import AppUpdatesSection from '@/components/settings/AppUpdatesSection';

/** One governance switch row: label, hint, a toggle, and the honest reason it
 *  is disabled (a pin, or no delegation) rather than a switch that lies. */
function GovernanceToggle({ label, hint, on, canToggle, refusal, busy, onFlip }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="font-medium text-foreground/90 flex items-center gap-1.5">
          {label}
          {on ? <span className="text-[10px] text-green-500">on</span> : <span className="text-[10px] text-destructive">off</span>}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{hint}</p>
        {!canToggle && refusal && (
          <p className="text-[10px] text-muted-foreground mt-0.5">{refusal.message}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${label} ${on ? 'on' : 'off'}`}
        disabled={!canToggle || busy}
        onClick={() => onFlip(!on)}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${on ? 'bg-primary' : 'bg-muted-foreground/30'}`}
        title={canToggle ? `${on ? 'Turn ' + label + ' off' : 'Turn ' + label + ' on'}` : (refusal?.message || `${label} is not delegated to this page`)}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-background shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

/**
 * The council switch handover: the honest answer to "why are the Critic and
 * Governor toggles dead?" — the same pattern as the Autonomy page's
 * SwitchHandover. The toggles are held back until the operator hands them over
 * (server/council/settings.js: COGNOS_COUNCIL_UI_CONTROL). On this phone there
 * is no operator shell — the operator is the person holding it — so the section
 * hands the switches to itself through the delegation file
 * (server/delegation-files.mjs, read at boot by mobile/entry.mjs). A handover
 * takes effect when the app is closed and reopened, and the panel says so
 * instead of pretending a toggle is live. The handover hands over the toggles
 * ONLY: both seats still rest ON (fail-closed), and an operator pin still
 * outranks everything. Nothing here weakens governance.
 */
function CouncilHandover() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setState(await api.autonomyDelegation()); }
    catch { setState({ managed: 'environment', switches: [] }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const handOver = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { setState(await api.handOverAutonomySwitch('council')); }
    catch (e) { setError(e?.message || 'Could not hand the switches over.'); }
    finally { setBusy(false); }
  };

  const takeBack = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { setState(await api.takeBackAutonomySwitch('council')); }
    catch (e) { setError(e?.message || 'Could not take the switches back.'); }
    finally { setBusy(false); }
  };

  if (!state) return null;

  // A server deploy: no delegation files — the env var is the only route, and
  // the page keeps the honest setup line instead of a dead end.
  if (state.managed !== 'device') {
    return (
      <p className="text-muted-foreground leading-relaxed">
        These switches are not delegated to this page. Set{' '}
        <span className="font-mono text-foreground/80">COGNOS_COUNCIL_UI_CONTROL=true</span>{' '}
        and restart to turn them on and off from here.
      </p>
    );
  }

  const sw = (state.switches || []).find((s) => s.name === 'council');
  if (!sw) return null;

  // Already live (or handed over and pending the restart): show the state and
  // the take-back, never a bare button that pretends.
  if (sw.delegated || sw.fileDelegated) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {sw.delegated
          ? <Pill tone="ok">handed over</Pill>
          : <Pill tone="info">handed over — restart pending</Pill>}
        {!sw.delegated && (
          <span className="text-[10px] text-muted-foreground">Close and reopen the app to use the switches.</span>
        )}
        {sw.fileDelegated ? (
          <button
            onClick={takeBack}
            disabled={busy}
            className="text-[10px] text-muted-foreground underline hover:text-foreground disabled:opacity-40"
          >
            {busy ? 'Taking back…' : 'Take them back'}
          </button>
        ) : (
          <span className="text-[10px] text-muted-foreground">
            Handed over by the environment — this page can&rsquo;t take them back.
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3">
      <p className="text-[11px] font-semibold flex items-center gap-1.5">
        <Scale className="w-3.5 h-3.5 text-muted-foreground" />
        The switches are held back
      </p>
      <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
        The Critic and Governor switches are held back until the operator hands them over.
        On this phone, you&rsquo;re the operator — tap to hand the switches to this page.
        It takes effect when you close and reopen the app. The handover only hands over
        the switches: both seats rest <strong>on</strong>, and an operator pin (a real
        environment variable, if one is ever set) still outranks everything.
      </p>
      {error && <p className="text-[10px] text-destructive mt-1.5">{error}</p>}
      <div className="mt-2">
        <button
          onClick={handOver}
          disabled={busy}
          className="rounded-lg bg-primary text-primary-foreground px-2.5 py-1.5 text-[11px] disabled:opacity-40"
        >
          {busy ? 'Handing over…' : (sw.cta || 'Hand me the council switches')}
        </button>
      </div>
    </div>
  );
}

/** The brains of the operation — which AI model answers, which handles the
 *  quick background jobs, and which reads attached images. All three are tap
 *  options backed by the provider's live model catalog (fetched from
 *  /v1/models, cached an hour, refreshable) — no more typing model ids, and
 *  new models show up without another release. Keys and endpoint URLs stay
 *  keyed in: they are never shown, edited, or offered here. */
function ModelSection({ onChanged }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">AI models</h3>
      <div className="rounded-xl border border-border bg-card p-3 space-y-5 text-xs">
        <ModelPicker
          title="Answering model"
          blurb="The main brain — the one that talks to you."
          statusFn={api.modelIdStatus}
          setFn={api.setModelId}
          clearFn={api.clearModelId}
          onChanged={onChanged}
        />
        <ModelPicker
          title="Quick-tasks model"
          blurb="The smaller brain behind background jobs — ranking memories, the council's quick passes."
          statusFn={api.fastModelStatus}
          setFn={api.setFastModel}
          clearFn={api.clearFastModel}
          onChanged={onChanged}
        />
        <ModelPicker
          title="Image-reading model"
          blurb="Reads the images you attach."
          statusFn={api.imageModelStatus}
          setFn={api.setImageModel}
          clearFn={api.clearImageModel}
          onChanged={onChanged}
        />
        <ConnectionTest />
      </div>
    </section>
  );
}

/** One model slot: current choice, a live catalog to tap from, a refresh,
 *  and a manual-entry fallback for when the catalog can't load. */
function ModelPicker({ title, blurb, statusFn, setFn, clearFn, onChanged }) {
  const [status, setStatus] = useState(null);
  const [catalog, setCatalog] = useState(null); // { models: [], cached, fetchedAt } | { error }
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const refreshStatus = useCallback(() => {
    statusFn().then(setStatus).catch(() => setStatus(null));
  }, [statusFn]);
  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const loadCatalog = useCallback(async (forceRefresh = false) => {
    setCatalog((c) => c || { loading: true });
    try {
      const r = await api.modelsList(forceRefresh);
      if (r.ok) setCatalog({ models: r.models || [], cached: r.cached, fetchedAt: r.fetchedAt });
      else setCatalog({ error: r.error || 'The model list could not be loaded.' });
    } catch (e) {
      setCatalog({ error: e.message || 'The model list could not be loaded.' });
    }
  }, []);

  useEffect(() => { if (open && !catalog) loadCatalog(false); }, [open, catalog, loadCatalog]);

  const choose = async (id) => {
    setBusy(true); setMessage(null);
    try {
      await setFn(id);
      await refreshStatus();
      onChanged?.();
      setOpen(false);
      setMessage({ ok: true, text: `Switched — "${id}" takes effect right away.` });
    } catch (e) {
      setMessage({ ok: false, text: e.message || 'Could not switch models.' });
    } finally { setBusy(false); }
  };

  const saveManual = async () => {
    const id = manualInput.trim();
    if (!id) return;
    setBusy(true); setMessage(null);
    try {
      await setFn(id);
      setManualInput('');
      setManual(false);
      await refreshStatus();
      onChanged?.();
      setMessage({ ok: true, text: `Switched — "${id}" takes effect right away.` });
    } catch (e) {
      setMessage({ ok: false, text: e.message || 'Could not switch models.' });
    } finally { setBusy(false); }
  };

  const reset = async () => {
    if (!window.confirm(`Reset the ${title.toLowerCase()} to the default?`)) return;
    setBusy(true); setMessage(null);
    try {
      await clearFn();
      await refreshStatus();
      onChanged?.();
      setMessage({ ok: true, text: 'Reset to the default.' });
    } catch (e) {
      setMessage({ ok: false, text: e.message || 'Could not reset.' });
    } finally { setBusy(false); }
  };

  if (status === null) return <p className="text-muted-foreground">Loading…</p>;
  if (status.managed === 'environment') {
    return (
      <div>
        <p className="font-medium text-foreground/90">{title}</p>
        <p className="text-muted-foreground leading-relaxed mt-1">
          Managed by the server environment on this install — it can't be changed here.
          Current: <span className="break-all">{status.value}</span>.
        </p>
      </div>
    );
  }

  const current = status.value;
  const models = catalog?.models || [];

  return (
    <div className="space-y-2">
      <p className="font-medium text-foreground/90">{title}</p>
      <p className="text-muted-foreground/70 leading-relaxed">{blurb}</p>
      <p className="text-muted-foreground">
        Current: <span className="break-all text-foreground/80">{current}{status.isDefault ? ' (default)' : ''}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setOpen(v => !v)}
          disabled={busy}
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
        >
          {open ? 'Close list' : 'Choose a model'}
        </button>
        {!status.isDefault && (
          <button
            onClick={reset}
            disabled={busy}
            className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Reset to default
          </button>
        )}
        <button
          onClick={() => setManual(v => !v)}
          disabled={busy}
          className="text-xs px-3 py-2 rounded-lg text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {manual ? 'Hide manual entry' : 'Type one in'}
        </button>
      </div>

      {open && (
        <div className="rounded-lg border border-border bg-background/60 p-2 space-y-1 max-h-64 overflow-y-auto">
          <div className="flex items-center justify-between px-1 py-1">
            <p className="text-[10px] text-muted-foreground">
              {catalog?.loading ? 'Loading the catalog…'
                : catalog?.error ? 'The live catalog is unavailable'
                : `${models.length} models${catalog?.cached ? ' · cached' : ''}`}
            </p>
            {!catalog?.loading && (
              <button
                onClick={() => loadCatalog(true)}
                className="text-[10px] text-primary hover:underline"
              >
                Refresh
              </button>
            )}
          </div>
          {catalog?.loading && <p className="text-[11px] text-muted-foreground px-1 py-2">Fetching the latest from your provider…</p>}
          {catalog?.error && (
            <p className="text-[11px] text-muted-foreground px-1 py-2 leading-relaxed">
              {catalog.error} You can still type a model id below.
            </p>
          )}
          {models.map(id => (
            <button
              key={id}
              onClick={() => choose(id)}
              disabled={busy}
              className={`w-full text-left px-2.5 py-2 rounded-lg text-[11px] font-mono break-all transition-colors disabled:opacity-50 ${
                id === current ? 'bg-primary/15 text-primary' : 'hover:bg-muted/60 text-foreground/80'
              }`}
            >
              {id}{id === current ? ' · current' : ''}
            </button>
          ))}
        </div>
      )}

      {manual && (
        <div className="flex gap-2">
          <input
            value={manualInput}
            onChange={e => setManualInput(e.target.value)}
            placeholder="e.g. openai/gpt-oss-20b"
            autoComplete="off" autoCapitalize="off" spellCheck="false"
            className="flex-1 bg-muted/50 border border-border rounded-lg px-3 py-2 text-xs font-mono outline-none focus:border-primary/50"
          />
          <button
            onClick={saveManual}
            disabled={busy || !manualInput.trim()}
            className="text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Use it'}
          </button>
        </div>
      )}

      {message && (
        <p className={message.ok ? 'text-green-500' : 'text-destructive'}>{message.text}</p>
      )}
    </div>
  );
}

/** Staged AI-connection self-test. Reports stage results only — the key and
 *  the endpoint URL are scrubbed before they reach the app. */
function ConnectionTest() {
  const [diag, setDiag] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true); setDiag(null);
    try {
      setDiag(await api.diagnoseAi());
    } catch (e) {
      setDiag({ ok: false, summary: e.message || 'The diagnostic could not run.', stages: [] });
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2 pt-1 border-t border-border/60">
      <div className="flex items-center justify-between pt-2">
        <p className="font-medium text-foreground/90">Connection test</p>
        <button
          onClick={run}
          disabled={busy}
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
          title="Run a staged connection test against your AI provider: key sanity, DNS, TCP, TLS, HTTPS."
        >
          {busy ? 'Testing…' : 'Test AI connection'}
        </button>
      </div>
      {diag && (
        <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-1.5">
          <p className={diag.ok ? 'text-green-500' : 'text-destructive'}>{diag.summary}</p>
          {(diag.stages || []).map(s => (
            <div key={s.name} className="flex items-start gap-2">
              {s.ok
                ? <Check className="w-3.5 h-3.5 text-green-500 mt-0.5 shrink-0" />
                : <X className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />}
              <div className="min-w-0">
                <p className="font-medium capitalize">
                  {s.name}{s.skipped ? ' (skipped)' : ''}
                  <span className="text-muted-foreground font-normal"> · {s.ms}ms</span>
                </p>
                <p className="text-muted-foreground leading-snug">{s.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Point COGNOS at an external Postgres (e.g. Supabase) instead of the
 *  on-device database — or switch back. Takes effect immediately; the
 *  connection pool is reset and the schema migrates itself. */
function DatabaseSection({ onChanged }) {
  const [status, setStatus] = useState(null);
  const [urlInput, setUrlInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { ok, text }

  const refresh = () => api.databaseUrlStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { refresh(); }, []);

  const save = async () => {
    setBusy(true); setMessage(null);
    try {
      await api.setDatabaseUrl(urlInput);
      setUrlInput('');
      await refresh();
      onChanged?.();
      setMessage({ ok: true, text: 'Database switched — COGNOS now uses your cloud database.' });
    } catch (e) { setMessage({ ok: false, text: e.message || 'Could not save the database URL.' }); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm('Switch back to the on-device database? Your cloud data stays where it is — COGNOS will just stop using it.')) return;
    setBusy(true); setMessage(null);
    try {
      await api.clearDatabaseUrl();
      await refresh();
      onChanged?.();
      setMessage({ ok: true, text: 'Switched back to the on-device database.' });
    } catch (e) { setMessage({ ok: false, text: e.message || 'Could not remove the database URL.' }); }
    finally { setBusy(false); }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Database</h3>
      <div className="rounded-xl border border-border bg-card p-3 space-y-3 text-xs">
        {status === null ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : status.managed === 'environment' ? (
          <p className="text-muted-foreground leading-relaxed">
            The database for this install is managed by the server environment, so it can't be
            changed here.
          </p>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <Database className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-muted-foreground leading-relaxed">
                {status.external
                  ? 'COGNOS is using your cloud database. Paste a new connection string below to switch, or remove it to go back to the on-device database.'
                  : 'COGNOS is using the on-device database. Paste a Postgres connection string below (e.g. from Supabase) to move your data to the cloud instead.'}
              </p>
            </div>
            <input
              type="password"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              placeholder="postgresql://…"
              autoComplete="off" autoCapitalize="off" spellCheck="false"
              className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50"
            />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={save}
                disabled={busy || !urlInput.trim()}
                className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save database URL'}
              </button>
              {status.external && (
                <button
                  onClick={remove}
                  disabled={busy}
                  className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Use on-device database
                </button>
              )}
            </div>
            {message && (
              <p className={message.ok ? 'text-green-500' : 'text-destructive'}>{message.text}</p>
            )}
            <p className="text-muted-foreground/60 leading-relaxed">
              The URL is stored privately inside the app — no other app can read it. Supabase:
              Project Settings → Database → Connection string (Session pooler mode).
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** Phase 32 — personas: named voice/style bundles. A persona changes how
 *  COGNOS talks, never what it may do — governance stays persona-free.
 *  Built-ins can be edited but not deleted; custom ones get full CRUD. */
function PersonasSection() {
  const [personas, setPersonas] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // persona being edited, or 'new'
  // Phase 33 — label each persona's preferred TTS voice, when one is set.
  const { voices: deviceVoices } = useVoice();
  const voiceLabel = (voiceURI) => {
    const v = (deviceVoices || []).find(item => item.voiceURI === voiceURI);
    return v ? `${v.name} — ${v.lang}` : voiceURI;
  };

  const load = async () => {
    try {
      const r = await api.listPersonas();
      setPersonas(r.personas || []);
      setActiveId(r.activeId || null);
      setError('');
    } catch (e) {
      // Never leave the section stuck on "Loading…": an empty list renders
      // the error with a retry instead of a spinner that never resolves.
      setPersonas([]);
      setError(e.message || 'Could not load personas');
    }
  };
  useEffect(() => { load(); }, []);

  const activate = async (id) => {
    setBusy(true);
    try {
      const r = await api.activatePersona(id);
      setActiveId(r.activeId);
      setPersonas(prev => (prev || []).map(p => ({ ...p, is_active: p.id === r.activeId })));
    } catch (e) { setError(e.message || 'Could not switch persona'); }
    finally { setBusy(false); }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this persona? The active voice falls back to COGNOS.')) return;
    setBusy(true);
    try { await api.deletePersona(id); await load(); }
    catch (e) { setError(e.message || 'Could not delete persona'); }
    finally { setBusy(false); }
  };

  const saveEdit = async (data) => {
    setBusy(true);
    try {
      if (editing === 'new') await api.createPersona(data);
      else await api.updatePersona(editing.id, data);
      setEditing(null);
      await load();
    } catch (e) { setError(e.message || 'Could not save persona'); }
    finally { setBusy(false); }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Personas</h3>
      <div className="rounded-xl border border-border bg-card p-3 space-y-3 text-xs">
        <p className="text-muted-foreground leading-relaxed">
          A persona is the voice COGNOS talks in — prompt, tone, spoken voice, and optional model or
          temperature. It changes how it speaks, never what it may do: identity, the
          council, and governance stay the same under every persona.
        </p>
        {error && (
          <div className="flex items-center gap-2">
            <p className="text-destructive flex-1">{error}</p>
            <button
              type="button"
              onClick={load}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground shrink-0"
            >
              Retry
            </button>
          </div>
        )}
        {personas === null ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-0.5">
            {personas.map(p => (
              <div key={p.id} className={`rounded-lg border p-2.5 ${p.id === activeId ? 'border-primary/50 bg-primary/5' : 'border-border'}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground/90 flex items-center gap-2">
                      {p.name}
                      {p.builtin && <span className="text-[10px] text-muted-foreground font-normal">built-in</span>}
                      {p.id === activeId && <span className="text-[10px] text-green-500">active</span>}
                    </p>
                    {p.description && <p className="text-muted-foreground mt-0.5 leading-snug">{p.description}</p>}
                    {p.voice && p.voice.voiceURI && (
                      <p className="text-muted-foreground/70 mt-0.5 leading-snug">
                        Spoken voice: {voiceLabel(p.voice.voiceURI)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {p.id !== activeId && (
                      <button onClick={() => activate(p.id)} disabled={busy}
                        className="text-xs px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-50">
                        Use
                      </button>
                    )}
                    <button onClick={() => setEditing(p)} title="Edit persona"
                      className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    {!p.builtin && (
                      <button onClick={() => remove(p.id)} disabled={busy} title="Delete persona"
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-muted disabled:opacity-50">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <button onClick={() => setEditing('new')}
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground">
          <Plus className="w-3.5 h-3.5" /> New persona
        </button>
        {editing && (
          <PersonaEditor
            initial={editing === 'new' ? null : editing}
            busy={busy}
            onCancel={() => setEditing(null)}
            onSave={saveEdit}
          />
        )}
      </div>
    </section>
  );
}

function PersonaEditor({ initial, busy, onCancel, onSave }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [promptText, setPromptText] = useState(initial?.prompt_text || '');
  const [modelOverride, setModelOverride] = useState(initial?.model_override || '');
  const [temperature, setTemperature] = useState(initial?.temperature ?? '');
  // Phase 33 — preferred TTS voice for this persona. Stored in persona.voice;
  // switching personas switches the spoken voice. Blank = the Voice settings.
  const [ttsVoiceURI, setTtsVoiceURI] = useState(initial?.voice?.voiceURI || '');
  const [formError, setFormError] = useState('');
  const deviceVoices = useVoice().voices;

  const submit = () => {
    if (!name.trim()) { setFormError('Give the persona a name.'); return; }
    const t = String(temperature).trim();
    if (t !== '' && (Number.isNaN(Number(t)) || Number(t) < 0 || Number(t) > 2)) {
      setFormError('Temperature must be a number between 0 and 2, or left blank.');
      return;
    }
    setFormError('');
    const voice = { ...(initial?.voice && typeof initial.voice === 'object' ? initial.voice : {}) };
    if (ttsVoiceURI) voice.voiceURI = ttsVoiceURI;
    else delete voice.voiceURI;
    onSave({
      name: name.trim(),
      description: description.trim(),
      prompt_text: promptText,
      model_override: modelOverride.trim(),
      temperature: t === '' ? null : Number(t),
      voice,
    });
  };

  const inputCls = "w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50";
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2.5">
      <p className="font-medium text-foreground/90">{initial ? `Edit “${initial.name}”` : 'New persona'}</p>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name — e.g. Night Owl"
        maxLength={60} className={inputCls} />
      <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Short description"
        maxLength={300} className={inputCls} />
      <textarea value={promptText} onChange={e => setPromptText(e.target.value)} rows={5}
        placeholder="How this persona talks — tone, register, habits. This is a voice/style layer only: it can never change COGNOS's identity, capabilities, or governance."
        maxLength={4000} className={`${inputCls} resize-y`} />
      <div className="grid grid-cols-2 gap-2">
        <input value={modelOverride} onChange={e => setModelOverride(e.target.value)}
          placeholder="Model override (optional)" maxLength={120}
          className={inputCls} title="Optional: a different model id for this persona's answer drafts. Blank keeps the configured model." />
        <input value={temperature} onChange={e => setTemperature(e.target.value)}
          placeholder="Temperature 0–2 (optional)" inputMode="decimal"
          className={inputCls} title="Optional: sampling temperature for this persona's answer drafts. Blank keeps the provider default." />
      </div>
      <label className="block text-[11px] text-muted-foreground">
        Spoken voice
        <select
          value={ttsVoiceURI}
          onChange={e => setTtsVoiceURI(e.target.value)}
          className="mt-1 block w-full bg-muted/50 border border-border rounded-lg px-2.5 py-2 text-xs text-foreground outline-none focus:border-primary/50"
          title="The voice this persona speaks in. Blank uses the Voice settings above."
        >
          <option value="">Default — from Voice settings</option>
          {deviceVoices.map((item, index) => (
            <option key={`${item.voiceURI}-${index}`} value={item.voiceURI}>
              {item.name} — {item.lang}
            </option>
          ))}
        </select>
      </label>
      {initial?.builtin && (
        <p className="text-muted-foreground/70 leading-relaxed">Built-in personas can be tuned but not deleted.</p>
      )}
      {formError && <p className="text-destructive">{formError}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy || !name.trim()}
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-50">
          {busy ? 'Saving…' : 'Save persona'}
        </button>
        <button onClick={onCancel}
          className="text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function Settings() {
  const { activeWorkspace, setActiveWorkspace, openSidebar } = useCognos();
  const voice = useVoice();
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [health, setHealth] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [council, setCouncil] = useState(null);
  const [councilBusy, setCouncilBusy] = useState(null);
  const [councilError, setCouncilError] = useState('');
  const [theme, setTheme] = useState(() => getTheme());
  const [voiceInstallHint, setVoiceInstallHint] = useState(false);
  const [ttsDiag, setTtsDiag] = useState(null);
  const [ttsDiagBusy, setTtsDiagBusy] = useState(false);

  const setAppearance = (t) => { setTheme(applyTheme(t)); };

  // The system voice-data installer sometimes can't open (no handler for the
  // intent). openInstallVoiceData() resolves false then, and we fall back to
  // the manual path instead of leaving a dead button.
  const handleInstallVoiceData = async () => {
    const opened = await voice.openInstallVoiceData();
    if (!opened) setVoiceInstallHint(true);
  };

  // Raw native TTS diagnostic: asks the phone directly what its
  // text-to-speech engine sees, bypassing the voice plugin entirely. The
  // result is rendered verbatim below so the phone tells us what's failing.
  const handleTtsDiagnostic = async () => {
    if (ttsDiagBusy) return;
    setTtsDiagBusy(true);
    setTtsDiag(null);
    try {
      setTtsDiag(await diagnoseTtsNative());
    } finally {
      setTtsDiagBusy(false);
    }
  };

  useEffect(() => {
    setName(activeWorkspace?.name || '');
    setInstructions(activeWorkspace?.instructions || '');
  }, [activeWorkspace]);

  useEffect(() => { api.health().then(setHealth).catch(() => {}); }, []);
  useEffect(() => {
    api.councilSettings().then(setCouncil).catch(() => setCouncil(null));
  }, []);

  const flipCouncil = async (which, enabled) => {
    if (councilBusy) return;
    setCouncilBusy(which); setCouncilError('');
    try {
      const out = await api.setCouncilSwitch(which, enabled);
      setCouncil(out.settings);
      if (out.changed === false) {
        setCouncilError(`${which === 'governor' ? 'The Governor' : 'The Critic'} was already ${enabled ? 'on' : 'off'}.`);
      }
    } catch (e) {
      // A refusal is an answer: re-read the truth so the switch cannot sit in a
      // position the server did not accept.
      setCouncilError(e?.message || `Could not change ${which}`);
      api.councilSettings().then(setCouncil).catch(() => {});
    } finally { setCouncilBusy(null); }
  };

  const save = async () => {
    try {
      const ws = await api.updateWorkspace({ name, instructions });
      setActiveWorkspace(ws);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError(e.message); }
  };

  const Row = ({ label, value }) => (
    <div className="flex justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground/80 text-right break-all">{String(value)}</span>
    </div>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-2 px-3 md:px-4 py-3 border-b border-border shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <button onClick={openSidebar} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted"><Menu className="w-5 h-5" /></button>
        <SettingsIcon className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Settings</h2>
      </header>
      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 min-h-0">
        <div className="max-w-2xl mx-auto space-y-6">
          {error && <p className="text-xs text-destructive">{error}</p>}

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workspace</h3>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Workspace name"
              className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50" />
            <textarea value={instructions} onChange={e => setInstructions(e.target.value)} rows={6}
              placeholder="Workspace instructions — injected into every council system prompt."
              className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50 resize-y" />
            <button onClick={save} className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground">
              {saved ? <><Check className="w-3.5 h-3.5" /> Saved</> : 'Save'}
            </button>
          </section>

          <ModelSection onChanged={() => api.health().then(setHealth).catch(() => {})} />

          <AppUpdatesSection />

          <DatabaseSection onChanged={() => api.health().then(setHealth).catch(() => {})} />

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Appearance</h3>
            <div className="rounded-xl border border-border bg-card p-3 text-xs">
              <div className="grid grid-cols-2 gap-2">
                {[
                  { id: 'dark', label: 'Dark', icon: Moon },
                  { id: 'light', label: 'Light', icon: Sun },
                ].map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setAppearance(id)}
                    aria-pressed={theme === id}
                    className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 transition-colors ${theme === id ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Voice</h3>            <div className="rounded-xl border border-border bg-card p-3 space-y-4 text-xs">
              {!voice.supported ? (
                <>
                  <p className="text-muted-foreground leading-relaxed">
                    Speech output is not available on this device.
                    COGNOS will continue to work normally in text mode.
                  </p>
                  <p className="text-[11px] text-muted-foreground/60 font-mono leading-relaxed">
                    probe: native {(voice.probe?.isNative) ? 'yes' : 'no'}
                    {' · '}plugin {(voice.probe?.plugin) ? 'yes' : 'no'}
                    {' · '}voices {voice.probe?.voices ?? 0}
                    {' · '}browser {(voice.probe?.browser) ? 'yes' : 'no'}
                    {voice.probe?.error ? ` · ${voice.probe.error}` : ''}
                  </p>
                </>
              ) : (
                <>
                  {voice.engine === 'native' && voice.voices.length === 0 && (
                    <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2.5">
                      <p className="font-medium text-foreground/90">No voice data on this device yet</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                        The speech engine is ready, but this phone has no voices installed.
                        Install the system voice data, then pick a voice below.
                      </p>
                      <button
                        type="button"
                        onClick={handleInstallVoiceData}
                        className="mt-2 text-xs px-3 py-2 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                      >
                        Install voice data
                      </button>
                      {voiceInstallHint && (
                        <div className="mt-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 flex items-start gap-2">
                          <p className="text-[11px] text-muted-foreground leading-relaxed flex-1">
                            The installer didn't open, so here's the manual path: open your phone's{' '}
                            <span className="text-foreground/80">Settings</span>, search{' '}
                            <span className="text-foreground/80">Text-to-speech</span>, tap{' '}
                            <span className="text-foreground/80">Text-to-speech output</span>, tap the gear by your
                            preferred engine, then <span className="text-foreground/80">Install voice data</span> and
                            download English (US). Reopen COGNOS and pick a voice.
                          </p>
                          <button
                            type="button"
                            aria-label="Dismiss"
                            onClick={() => setVoiceInstallHint(false)}
                            className="text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium text-foreground/90">Voice mode</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">Speak governed answers automatically after the Governor approves them.</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label="Voice mode"
                      aria-checked={voice.settings.enabled}
                      onClick={voice.toggleEnabled}
                      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${voice.settings.enabled ? 'bg-accent' : 'bg-muted'}`}
                    >
                      <span className={`absolute left-1 top-1 w-4 h-4 rounded-full bg-white transition-transform ${voice.settings.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>

                  <label className="flex items-center gap-2 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={voice.settings.autoSpeak}
                      onChange={event => voice.updateSettings({ autoSpeak: event.target.checked })}
                      className="accent-[hsl(var(--accent))]"
                    />
                    Automatically speak each new final response while voice mode is on
                  </label>

                  <label className="block text-[11px] text-muted-foreground">
                    {voice.engine === 'native' ? 'Device voice' : 'Browser voice'}
                    <select
                      value={voice.settings.voiceURI}
                      onChange={event => voice.updateSettings({ voiceURI: event.target.value })}
                      className="mt-1 block w-full bg-muted/50 border border-border rounded-lg px-2.5 py-2 text-xs text-foreground outline-none focus:border-primary/50"
                    >
                      <option value="">System default</option>
                      {voice.voices.map((item, index) => (
                        <option key={`${item.voiceURI}-${index}`} value={item.voiceURI}>
                          {item.name} — {item.lang}{item.localService ? '' : ' · network'}
                        </option>
                      ))}
                    </select>
                  </label>
                  {voice.engine === 'native' && (
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={handleInstallVoiceData}
                        className="text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Install voice data
                      </button>
                      <p className="text-[10px] text-muted-foreground/60 flex-1 min-w-[12rem]">
                        Opens the system installer if this device is missing voice data for its on-device voices.
                      </p>
                    </div>
                  )}

                  <div className="grid sm:grid-cols-3 gap-4">
                    <label className="text-[11px] text-muted-foreground">
                      Speed <span className="float-right tabular-nums text-foreground/80">{voice.settings.rate.toFixed(2)}×</span>
                      <input
                        type="range" min="0.6" max="1.6" step="0.05"
                        value={voice.settings.rate}
                        onChange={event => voice.updateSettings({ rate: Number(event.target.value) })}
                        className="mt-2 w-full accent-[hsl(var(--accent))]"
                      />
                    </label>
                    <label className="text-[11px] text-muted-foreground">
                      Pitch <span className="float-right tabular-nums text-foreground/80">{voice.settings.pitch.toFixed(2)}</span>
                      <input
                        type="range" min="0.7" max="1.3" step="0.05"
                        value={voice.settings.pitch}
                        onChange={event => voice.updateSettings({ pitch: Number(event.target.value) })}
                        className="mt-2 w-full accent-[hsl(var(--accent))]"
                      />
                    </label>
                    <label className="text-[11px] text-muted-foreground">
                      Volume <span className="float-right tabular-nums text-foreground/80">{Math.round(voice.settings.volume * 100)}%</span>
                      <input
                        type="range" min="0" max="1" step="0.05"
                        value={voice.settings.volume}
                        onChange={event => voice.updateSettings({ volume: Number(event.target.value) })}
                        className="mt-2 w-full accent-[hsl(var(--accent))]"
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => voice.speakingId === 'voice-preview'
                        ? voice.stop()
                        : voice.speak("Hello. I'm COGNOS. Voice mode is ready, and I will only speak the council's governed final answer.", { id: 'voice-preview' })}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                    >
                      {voice.speakingId === 'voice-preview' ? <Square className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                      {voice.speakingId === 'voice-preview' ? 'Stop preview' : 'Test voice'}
                    </button>
                    <p className="text-[10px] text-muted-foreground/60 flex-1 min-w-[12rem]">
                      {voice.engine === 'native'
                        ? 'On-device playback: no audio is uploaded, stored, or sent to a separate speech provider.'
                        : 'Browser-native playback: no audio is uploaded, stored, or sent to a separate speech provider.'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={handleTtsDiagnostic}
                      disabled={ttsDiagBusy}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      {ttsDiagBusy ? 'Running diagnostic…' : 'Run TTS diagnostic'}
                    </button>
                    <p className="text-[10px] text-muted-foreground/60 flex-1 min-w-[12rem]">
                      Asks the phone directly what its text-to-speech engine sees, bypassing the voice plugin.
                    </p>
                  </div>
                  {ttsDiag && (
                    <pre className="text-[10px] font-mono text-muted-foreground bg-muted/40 rounded-lg px-3 py-2.5 overflow-x-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(ttsDiag, null, 2)}
                    </pre>
                  )}
                </>
              )}
            </div>
          </section>

          <PersonasSection />

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Governance</h3>
            <div className="rounded-xl border border-border bg-card p-3 space-y-4 text-xs">
              <div className="flex items-start gap-2">
                <Scale className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-muted-foreground leading-relaxed">
                  The Critic and the Governor are the two safety seats. Both rest <strong>on</strong>.
                  An operator can pin either in the environment, which outranks this page; with{' '}
                  <span className="font-mono text-foreground/80">COGNOS_COUNCIL_UI_CONTROL=true</span> they are handed to this page, and every flip is recorded.
                </p>
              </div>

              {councilError && <p className="text-destructive">{councilError}</p>}

              <GovernanceToggle
                label="Critic"
                hint="Scores drafts for accuracy, adequacy and unsupported certainty, and requests one bounded revision."
                on={council?.criticEnabled === true}
                canToggle={council?.canToggleCritic === true}
                refusal={council?.criticRefusal}
                busy={councilBusy === 'critic'}
                onFlip={(next) => flipCouncil('critic', next)}
              />

              <GovernanceToggle
                label="Governor"
                hint="The deterministic final veto: empty responses, secret leakage, minimum-cause floors and citation audits."
                on={council?.governorEnabled === true}
                canToggle={council?.canToggleGovernor === true}
                refusal={council?.governorRefusal}
                busy={councilBusy === 'governor'}
                onFlip={(next) => flipCouncil('governor', next)}
              />

              {council?.governorEnabled === false && (
                <p className="flex items-start gap-2 text-[11px] leading-relaxed text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 rounded-lg px-3 py-2">
                  <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    The Governor is off. Nothing deterministic is vetoing answers anymore — empty responses,
                    leaked credentials and unverifiable citations can reach the user. This is the safety net,
                    and it is off until you turn it back on.
                  </span>
                </p>
              )}

              {(council?.governorPinned || council?.criticPinned) && (
                <p className="text-muted-foreground leading-relaxed">
                  An operator pinned {[
                    council.governorPinned ? 'the Governor' : null,
                    council.criticPinned ? 'the Critic' : null,
                  ].filter(Boolean).join(' and ')} in the environment, so this page cannot change it. Remove the
                  pin and restart to hand it back.
                </p>
              )}

              {!(council?.uiControl) && <CouncilHandover />}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Runtime</h3>
            <div className="rounded-xl border border-border bg-card p-3 text-xs">
              {health ? (
                <>
                  <Row label="COGNOS self-model" value={`v${health.identityVersion || 'unknown'}`} />
                  <Row label="Model" value={health.model} />
                  <Row label="Fast model" value={health.fastModel} />
                  <Row label="Model deadline" value={health.modelRequestPolicy?.timeoutMs != null ? `${health.modelRequestPolicy.timeoutMs}ms total` : 'unknown'} />
                  <Row label="Transient model retries" value={health.modelRequestPolicy?.maxRetries ?? 'unknown'} />
                  <Row label="Model key configured" value={health.modelKeyConfigured ? 'yes' : 'no'} />
                  <Row label="LLM service tier" value={health.llmServiceTier || 'provider-default'} />
                  <Row label="Prompt-cache routing" value={health.promptCacheKeyConfigured ? 'configured' : 'automatic/provider-default'} />
                  <Row label="Database configured" value={health.databaseConfigured ? 'yes' : 'no'} />
                  <Row label="Web search" value={health.searchProvider} />
                  <Row label="Document/link sources" value={health.sources ? 'enabled' : 'disabled'} />
                  <Row label="Agent mode" value={health.agent?.enabled ? `${(health.agent.modes || []).join(', ')} · writes ${health.agent.autonomousWrites ? 'enabled' : 'disabled'}` : 'disabled'} />
                  <Row label="Access gate" value={health.gate ? 'enabled' : 'disabled'} />
                </>
              ) : <p className="text-muted-foreground">Loading…</p>}
              <p className="text-muted-foreground/60 mt-3 leading-relaxed">
                Secrets are read from server environment variables and are never sent to the browser.
              </p>
            </div>
          </section>

          <p className="text-center text-[11px] text-muted-foreground/50 pb-2">
            COGNOS · build autonomy-switches · 2026-09-30
          </p>
        </div>
      </div>
    </div>
  );
}
