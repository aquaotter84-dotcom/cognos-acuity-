// Ported from the original src/pages/Settings.jsx.
// DIVERGENCE: no account section, no API-key field, no billing. Keys live in
// server env vars only and are never sent to the browser. What remains is the
// workspace instructions editor (which feeds buildContextSystemPrompt verbatim),
// local browser voice preferences, and runtime status from /api/health.
import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Menu, Check, X, Square, Volume2, ShieldAlert, Scale, KeyRound, Trash2, Sun, Moon, Database, Pencil, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import { useVoice } from '@/lib/voiceContext';
import { getTheme, applyTheme } from '@/lib/theme';

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

/** Change or remove the on-device model API key — no reinstall needed. */
function ModelKeySection({ onChanged }) {
  const [status, setStatus] = useState(null);
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { ok, text }
  const [diag, setDiag] = useState(null); // staged AI-connection diagnostic result
  const [diagBusy, setDiagBusy] = useState(false);

  const refresh = () => api.modelKeyStatus().then(setStatus).catch(() => setStatus(null));
  useEffect(() => { refresh(); }, []);

  const save = async () => {
    setBusy(true); setMessage(null);
    try {
      await api.setModelKey(keyInput);
      setKeyInput('');
      await refresh();
      onChanged?.();
      setMessage({ ok: true, text: 'Key saved — it takes effect immediately, no restart needed.' });
    } catch (e) { setMessage({ ok: false, text: e.message || 'Could not save the key.' }); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!window.confirm('Remove the saved API key? COGNOS won\u2019t be able to answer until you add a new one.')) return;
    setBusy(true); setMessage(null);
    try {
      await api.clearModelKey();
      await refresh();
      onChanged?.();
      setMessage({ ok: true, text: 'Key removed.' });
    } catch (e) { setMessage({ ok: false, text: e.message || 'Could not remove the key.' }); }
    finally { setBusy(false); }
  };

  const runDiagnostic = async () => {
    setDiagBusy(true); setDiag(null);
    try {
      setDiag(await api.diagnoseAi());
    } catch (e) {
      setDiag({ ok: false, summary: e.message || 'The diagnostic could not run.', stages: [] });
    } finally { setDiagBusy(false); }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">AI model key</h3>
      <div className="rounded-xl border border-border bg-card p-3 space-y-3 text-xs">
        {status === null ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : status.managed === 'environment' ? (
          <p className="text-muted-foreground leading-relaxed">
            The model key for this install is managed by the server environment, so it can't be
            changed here. {status.configured ? 'A key is configured.' : 'No key is configured yet.'}
          </p>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <KeyRound className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
              <p className="text-muted-foreground leading-relaxed">
                {status.configured
                  ? 'A key is saved on this device. Paste a new one below to replace it — or remove it entirely.'
                  : 'No key is saved yet, so COGNOS can\u2019t answer. Paste your BluesMinds (or OpenAI-compatible) API key below.'}
              </p>
            </div>
            <input
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              placeholder="Paste new API key"
              autoComplete="off" autoCapitalize="off" spellCheck="false"
              className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50"
            />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={save}
                disabled={busy || !keyInput.trim()}
                className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save new key'}
              </button>
              {status.configured && (
                <button
                  onClick={remove}
                  disabled={busy}
                  className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40 disabled:opacity-50"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove key
                </button>
              )}
              <button
                onClick={runDiagnostic}
                disabled={diagBusy}
                className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
                title="Run a staged connection test against your AI provider: key sanity, DNS, TCP, TLS, HTTPS."
              >
                {diagBusy ? 'Testing…' : 'Test AI connection'}
              </button>
            </div>
            {message && (
              <p className={message.ok ? 'text-green-500' : 'text-destructive'}>{message.text}</p>
            )}
            {diag && (
              <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-1.5">
                <p className={diag.ok ? 'text-green-500' : 'text-destructive'}>{diag.summary}</p>
                {diag.stages.map(s => (
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
            <p className="text-muted-foreground/60 leading-relaxed">
              The key is stored privately inside the app — no other app can read it — and is only
              ever sent to your model provider when answering.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** Point COGNOS at a different AI provider and/or model — e.g. Gemini's
 *  OpenAI-compatible endpoint. Takes effect immediately, no restart. Neither
 *  value is secret, so the current values are shown. */
function AiProviderSection({ onChanged }) {
  const [base, setBase] = useState(null);
  const [baseInput, setBaseInput] = useState('');
  const [model, setModel] = useState(null);
  const [modelInput, setModelInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { ok, text }

  const refresh = () => Promise.all([
    api.baseUrlStatus().then(setBase).catch(() => setBase(null)),
    api.modelIdStatus().then(setModel).catch(() => setModel(null)),
  ]);
  useEffect(() => { refresh(); }, []);

  const run = async (fn, doneText) => {
    setBusy(true); setMessage(null);
    try {
      await fn();
      await refresh();
      onChanged?.();
      setMessage({ ok: true, text: doneText });
    } catch (e) { setMessage({ ok: false, text: e.message || 'Could not save.' }); }
    finally { setBusy(false); }
  };

  const saveBase = () => run(
    () => api.setBaseUrl(baseInput).then(() => setBaseInput('')),
    'Provider switched — it takes effect immediately.'
  );
  const resetBase = () => {
    if (!window.confirm('Reset the provider to the default?')) return;
    run(() => api.clearBaseUrl(), 'Provider reset to the default.');
  };
  const saveModel = () => run(
    () => api.setModelId(modelInput).then(() => setModelInput('')),
    'Model switched — it takes effect immediately.'
  );
  const resetModel = () => {
    if (!window.confirm('Reset the model to the default?')) return;
    run(() => api.clearModelId(), 'Model reset to the default.');
  };

  const envManaged = base?.managed === 'environment' || model?.managed === 'environment';

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">AI provider</h3>
      <div className="rounded-xl border border-border bg-card p-3 space-y-4 text-xs">
        {(base === null || model === null) ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : envManaged ? (
          <p className="text-muted-foreground leading-relaxed">
            The provider for this install is managed by the server environment, so it can't be
            changed here. Endpoint: <span className="break-all">{base.value}</span>.
            Model: <span className="break-all">{model.value}</span>.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <p className="font-medium text-foreground/90">
                Endpoint <span className="text-muted-foreground font-normal">· current: </span>
                <span className="text-muted-foreground font-normal break-all">{base.value}{base.isDefault ? ' (default)' : ''}</span>
              </p>
              <input
                value={baseInput}
                onChange={e => setBaseInput(e.target.value)}
                placeholder="https://…"
                autoComplete="off" autoCapitalize="off" spellCheck="false"
                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={saveBase}
                  disabled={busy || !baseInput.trim()}
                  className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save endpoint'}
                </button>
                {!base.isDefault && (
                  <button
                    onClick={resetBase}
                    disabled={busy}
                    className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    Reset to default
                  </button>
                )}
              </div>
              <p className="text-muted-foreground/60 leading-relaxed">
                Any OpenAI-compatible endpoint. For Gemini:
                https://generativelanguage.googleapis.com/v1beta/openai
              </p>
            </div>
            <div className="space-y-2">
              <p className="font-medium text-foreground/90">
                Model <span className="text-muted-foreground font-normal">· current: </span>
                <span className="text-muted-foreground font-normal break-all">{model.value}{model.isDefault ? ' (default)' : ''}</span>
              </p>
              <input
                value={modelInput}
                onChange={e => setModelInput(e.target.value)}
                placeholder="e.g. gemini-2.0-flash"
                autoComplete="off" autoCapitalize="off" spellCheck="false"
                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={saveModel}
                  disabled={busy || !modelInput.trim()}
                  className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save model'}
                </button>
                {!model.isDefault && (
                  <button
                    onClick={resetModel}
                    disabled={busy}
                    className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    Reset to default
                  </button>
                )}
              </div>
              <p className="text-muted-foreground/60 leading-relaxed">
                Switching providers usually means switching the model too — use the model id
                your provider expects.
              </p>
            </div>
            {message && (
              <p className={message.ok ? 'text-green-500' : 'text-destructive'}>{message.text}</p>
            )}
          </>
        )}
      </div>
    </section>
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

  const load = async () => {
    try {
      const r = await api.listPersonas();
      setPersonas(r.personas || []);
      setActiveId(r.activeId || null);
      setError('');
    } catch (e) {
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
          A persona is the voice COGNOS talks in — prompt, tone, and optional model or
          temperature. It changes how it speaks, never what it may do: identity, the
          council, and governance stay the same under every persona.
        </p>
        {error && <p className="text-destructive">{error}</p>}
        {personas === null ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-2">
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
  const [formError, setFormError] = useState('');

  const submit = () => {
    if (!name.trim()) { setFormError('Give the persona a name.'); return; }
    const t = String(temperature).trim();
    if (t !== '' && (Number.isNaN(Number(t)) || Number(t) < 0 || Number(t) > 2)) {
      setFormError('Temperature must be a number between 0 and 2, or left blank.');
      return;
    }
    setFormError('');
    onSave({
      name: name.trim(),
      description: description.trim(),
      prompt_text: promptText,
      model_override: modelOverride.trim(),
      temperature: t === '' ? null : Number(t)
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

  const setAppearance = (t) => { setTheme(applyTheme(t)); };

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

          <ModelKeySection onChanged={() => api.health().then(setHealth).catch(() => {})} />

          <AiProviderSection onChanged={() => api.health().then(setHealth).catch(() => {})} />

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
                <p className="text-muted-foreground leading-relaxed">
                  Speech output is not available in this browser. COGNOS will continue to work normally in text mode.
                </p>
              ) : (
                <>
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
                    Browser voice
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
                      Browser-native playback: no audio is uploaded, stored, or sent to a separate speech provider.
                    </p>
                  </div>
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

              {!(council?.uiControl) && (
                <p className="text-muted-foreground leading-relaxed">
                  These switches are not delegated to this page. Set{' '}
                  <span className="font-mono text-foreground/80">COGNOS_COUNCIL_UI_CONTROL=true</span> and restart
                  to turn them on and off from here.
                </p>
              )}
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
