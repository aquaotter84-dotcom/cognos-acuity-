// Phase 36 — resident tools UI: Jeremy's hand-typed HTTPS tools, assigned per
// resident by tap. Secrets are write-only: the form accepts them once and the
// UI never shows them again — only their names.

import { useState, useEffect, useCallback } from 'react';
import {
  Wrench, Plus, X, Trash2, Play, Check, Clock, AlertTriangle,
  KeyRound, Pencil, ChevronDown,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Pill, Empty, ErrorNote } from '@/components/system/SystemUi';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const RUN_TONE = {
  succeeded: 'ok',
  failed: 'bad',
  awaiting_approval: 'warn',
  refused: 'muted',
  staged: 'info',
};

const RUN_LABEL = {
  succeeded: 'ran',
  failed: 'failed',
  awaiting_approval: 'waiting for your approval',
  refused: 'refused',
  staged: 'staged',
};

/** "Name: value" lines → object. */
function parseHeaders(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i < 1) throw new Error(`header line needs "Name: value" — got “${t.slice(0, 40)}”`);
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

/** "NAME=value" lines → object. */
function parseSecrets(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i < 1) throw new Error(`secret line needs "NAME=value" — got “${t.slice(0, 40)}”`);
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function headersToText(headers) {
  return Object.entries(headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ToolRunCard({ run }) {
  if (!run) return null;
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2">
      <div className="flex items-center gap-2 text-xs">
        <Wrench className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="font-medium truncate flex-1">{run.tool_name || run.toolName || 'Tool'}</span>
        {run.method && (
          <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground">
            {run.method}
          </span>
        )}
        <Pill tone={RUN_TONE[run.status] || 'muted'}>
          {RUN_LABEL[run.status] || run.status}
        </Pill>
      </div>
      {run.message && <p className="text-[11px] text-muted-foreground mt-1">{run.message}</p>}
      {run.error && <p className="text-[11px] text-destructive/80 mt-1">{run.error}</p>}
      {run.output && (
        <pre className="text-[10px] font-mono text-muted-foreground mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-words bg-background/60 rounded p-1.5">
          {run.output}
        </pre>
      )}
      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground/70">
        {run.created_date && <span>{timeAgo(run.created_date)}</span>}
        {run.latency_ms != null && <span>{run.latency_ms}ms</span>}
        {run.status_code != null && <span>→ {run.status_code}</span>}
      </div>
    </div>
  );
}

function ToolForm({ initial, onSave, onCancel, busy }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [method, setMethod] = useState(initial?.method || 'GET');
  const [url, setUrl] = useState(initial?.url || '');
  const [headersText, setHeadersText] = useState(headersToText(initial?.headers));
  const [bodyTemplate, setBodyTemplate] = useState(initial?.body_template || '');
  const [secretsText, setSecretsText] = useState('');
  const [localError, setLocalError] = useState('');

  const save = async () => {
    setLocalError('');
    let headers = {};
    let secrets = {};
    try {
      headers = parseHeaders(headersText);
      secrets = parseSecrets(secretsText);
    } catch (e) {
      setLocalError(e.message);
      return;
    }
    await onSave({
      name: name.trim(),
      description: description.trim(),
      method,
      url: url.trim(),
      headers,
      body_template: bodyTemplate,
      ...(Object.keys(secrets).length ? { secrets } : {}),
    });
  };

  return (
    <div className="rounded-lg border border-border bg-background p-3 space-y-2.5">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <input
          value={name} onChange={e => setName(e.target.value)}
          placeholder="Tool name — e.g. “Evening check-in ping”"
          className="bg-muted/40 border border-border rounded-lg px-2.5 py-2 text-xs outline-none focus:border-primary/60"
        />
        <select
          value={method} onChange={e => setMethod(e.target.value)}
          className="bg-muted/40 border border-border rounded-lg px-2 py-2 text-xs outline-none"
          title="GET reads run right away; anything else waits for your approval"
        >
          {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <input
        value={description} onChange={e => setDescription(e.target.value)}
        placeholder="What it's for — one line, shown on the resident's card"
        className="w-full bg-muted/40 border border-border rounded-lg px-2.5 py-2 text-xs outline-none focus:border-primary/60"
      />
      <input
        value={url} onChange={e => setUrl(e.target.value)}
        placeholder="https://… — {{name}} placeholders allowed in the path and query, never the host"
        className="w-full bg-muted/40 border border-border rounded-lg px-2.5 py-2 text-xs font-mono outline-none focus:border-primary/60"
      />
      <div>
        <p className="text-[10px] text-muted-foreground mb-1">
          Headers, one per line — <span className="font-mono">Name: value</span>.
          content-type, x-cognos-*, or x-api-key only.
        </p>
        <textarea
          value={headersText} onChange={e => setHeadersText(e.target.value)}
          rows={2} placeholder={"x-cognos-source: my-desk\nx-api-key: {{secret:MY_KEY}}"}
          className="w-full bg-muted/40 border border-border rounded-lg px-2.5 py-2 text-xs font-mono outline-none focus:border-primary/60 resize-none"
        />
      </div>
      {method !== 'GET' && (
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">
            Body template — <span className="font-mono">{'{{name}}'}</span> fills in when it runs,
            <span className="font-mono">{' {{secret:NAME}} '}</span> pulls from Secrets below.
          </p>
          <textarea
            value={bodyTemplate} onChange={e => setBodyTemplate(e.target.value)}
            rows={3} placeholder={'{"message": "{{text}}"}'}
            className="w-full bg-muted/40 border border-border rounded-lg px-2.5 py-2 text-xs font-mono outline-none focus:border-primary/60 resize-none"
          />
        </div>
      )}
      <div className="rounded-lg border border-warn/30 bg-warn/5 p-2.5">
        <p className="text-[11px] font-medium flex items-center gap-1.5">
          <KeyRound className="w-3.5 h-3.5 text-warn" />
          Secrets — write-only
        </p>
        <p className="text-[10px] text-muted-foreground mt-0.5 mb-1.5">
          Typed once, never shown again — not here, not in run history, not in logs.
          Reference one as <span className="font-mono">{'{{secret:NAME}}'}</span> above.
        </p>
        <textarea
          value={secretsText} onChange={e => setSecretsText(e.target.value)}
          rows={2} placeholder={"MY_KEY=paste-it-here\nOTHER_TOKEN=…"}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className="w-full bg-background border border-border rounded-lg px-2.5 py-2 text-xs font-mono outline-none focus:border-primary/60 resize-none"
        />
        {(initial?.secret_names?.length > 0) && (
          <p className="text-[10px] text-muted-foreground mt-1.5">
            Already stored: {initial.secret_names.map(n => (
              <span key={n} className="font-mono px-1 py-0.5 rounded bg-muted text-[10px] mr-1">{n}</span>
            ))}
            — add a line above to replace one, or leave blank to keep them.
          </p>
        )}
      </div>
      <ErrorNote error={localError} />
      <div className="flex items-center gap-2">
        <button
          onClick={save} disabled={busy || !name.trim() || !url.trim()}
          className="rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs disabled:opacity-40"
        >
          {initial ? 'Save changes' : 'Create tool'}
        </button>
        <button
          onClick={onCancel} disabled={busy}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Tap-to-toggle assignment of one tool across residents. */
function ToolAssignments({ tool, residents, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const assigned = new Set(tool.assigned_slugs || []);

  const toggle = async (resident) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (assigned.has(resident.slug)) {
        await api.unassignTool(resident.id, tool.id);
      } else {
        await api.assignTool(resident.id, tool.id);
      }
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Could not change the assignment');
    } finally {
      setBusy(false);
    }
  };

  if (!residents?.length) return <p className="text-[10px] text-muted-foreground">No residents yet.</p>;
  return (
    <div>
      <ErrorNote error={error} />
      <div className="flex flex-wrap gap-1.5">
      {residents.map(r => {
        const on = assigned.has(r.slug);
        return (
          <button
            key={r.id} onClick={() => toggle(r)} disabled={busy}
            title={on ? `Take “${tool.name}” away from ${r.name}` : `Give “${tool.name}” to ${r.name}`}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
              on
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            {on && <Check className="w-3 h-3 text-primary" />}
            {r.name}
          </button>
        );
      })}
      </div>
    </div>
  );
}

/** Per-resident picker: which tools this resident may use. Compact, for cards. */
export function ResidentToolPicker({ resident, onChanged }) {
  const [tools, setTools] = useState([]);
  const [assigned, setAssigned] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!resident?.id) return;
    try {
      const [all, mine] = await Promise.all([api.listTools(), api.residentTools(resident.id)]);
      setTools(all.tools || []);
      setAssigned(mine.tools || []);
    } catch (e) {
      setError(e.message || 'Could not load tools');
    }
  }, [resident?.id]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (tool) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const has = assigned.some(t => t.id === tool.id);
      if (has) await api.unassignTool(resident.id, tool.id);
      else await api.assignTool(resident.id, tool.id);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Could not change the assignment');
    } finally {
      setBusy(false);
    }
  };

  const assignedIds = new Set(assigned.map(t => t.id));

  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <Wrench className="w-3 h-3" />
        Tools ({assigned.length})
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-1.5 space-y-1 rounded-lg border border-border/60 bg-muted/20 p-2">
          <ErrorNote error={error} />
          {tools.length === 0 && (
            <p className="text-[10px] text-muted-foreground">
              No tools yet — make one on the Tools tab, then hand it to this resident here.
            </p>
          )}
          {tools.map(t => {
            const on = assignedIds.has(t.id);
            return (
              <button
                key={t.id} onClick={() => toggle(t)} disabled={busy}
                className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted/40 disabled:opacity-40"
              >
                <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                  on ? 'border-primary bg-primary/20' : 'border-border'
                }`}>
                  {on && <Check className="w-3 h-3 text-primary" />}
                </span>
                <span className="text-[11px] font-medium flex-1 truncate">{t.name}</span>
                <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground">
                  {t.method}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Recent runs for one resident. */
export function ToolRunHistory({ residentId, limit = 10 }) {
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!residentId) return;
    api.toolRuns(residentId, { limit })
      .then(r => setRuns(r.runs || []))
      .catch(e => setError(e.message || 'Could not load run history'));
  }, [residentId, limit]);

  if (error) return <ErrorNote error={error} />;
  if (!runs.length) return null;
  return (
    <div className="mt-1.5 space-y-1.5">
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
        Recent tool runs
      </p>
      {runs.map(r => <ToolRunCard key={r.id} run={r} />)}
    </div>
  );
}

export default function ToolsTab({ residents, onChanged }) {
  const [tools, setTools] = useState([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const out = await api.listTools();
      setTools(out.tools || []);
    } catch (e) {
      setError(e.message || 'Could not load tools');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveNew = async (data) => {
    setBusy(true); setError('');
    try {
      await api.createTool(data);
      setCreating(false);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Could not create the tool');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (data) => {
    setBusy(true); setError('');
    try {
      await api.updateTool(editing.id, data);
      setEditing(null);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Could not save the tool');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tool) => {
    if (!window.confirm(`Delete “${tool.name}”? Its secrets go with it. Run history keeps its rows.`)) return;
    setBusy(true); setError('');
    try {
      await api.deleteTool(tool.id);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message || 'Could not delete the tool');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h2 className="orbit-page-title text-xl mt-1">Tools your residents can use.</h2>
        <p className="text-xs text-muted-foreground mt-1 max-w-xl leading-relaxed">
          Define an HTTPS endpoint once, then hand it to whichever residents should have it —
          a resident only ever sees its own tools. Reads run right away; writes wait for
          your approval in the Outbox, one at a time. Keys live in Secrets: typed once,
          never shown again.
        </p>
      </div>

      <ErrorNote error={error} />

      {!creating ? (
        <button
          onClick={() => { setCreating(true); setEditing(null); }}
          className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-2 text-xs font-medium"
        >
          <Plus className="w-3.5 h-3.5" /> New tool
        </button>
      ) : (
        <ToolForm busy={busy} onSave={saveNew} onCancel={() => setCreating(false)} />
      )}

      {tools.length === 0 && !creating ? (
        <Empty
          title="No tools yet"
          body="A tool is an HTTPS endpoint a resident may call — a ping, a lookup, a trigger. Make one above, then tap a resident's name on it to hand it over."
        />
      ) : (
        <div className="space-y-2.5">
          {tools.map(tool => (
            <div key={tool.id} className="orbit-agent-card rounded-lg border border-border">
              <div className="flex items-start gap-3 px-3 py-2.5">
                <Wrench className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate flex-1">{tool.name}</span>
                    <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground">
                      {tool.method}
                    </span>
                    {(tool.secret_names?.length > 0) && (
                      <span className="flex items-center gap-1 text-[10px] text-muted-foreground" title={`Secrets: ${tool.secret_names.join(', ')}`}>
                        <KeyRound className="w-3 h-3" />{tool.secret_names.length}
                      </span>
                    )}
                  </div>
                  {tool.description && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">{tool.description}</p>
                  )}
                  <p className="text-[10px] font-mono text-muted-foreground/70 mt-1 truncate" title={tool.url}>
                    {tool.url}
                  </p>
                  <div className="mt-2">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                      Residents with this tool — tap to hand it over or take it back
                    </p>
                    <ToolAssignments tool={tool} residents={residents} onChanged={async () => { await load(); onChanged?.(); }} />
                  </div>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    onClick={() => { setEditing(editing?.id === tool.id ? null : tool); setCreating(false); }}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
                    title="Edit the tool"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => remove(tool)} disabled={busy}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40"
                    title="Delete the tool"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {editing?.id === tool.id && (
                <div className="border-t border-border px-3 py-2.5">
                  <ToolForm initial={tool} busy={busy} onSave={saveEdit} onCancel={() => setEditing(null)} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
        <p className="text-[11px] font-medium flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-warn" />
          How tools stay safe
        </p>
        <ul className="text-[11px] text-muted-foreground mt-1.5 space-y-1 list-disc list-inside">
          <li>A resident only sees the tools you hand it — never another resident's.</li>
          <li>Reads run right away. Writes wait for your approval in the Outbox, one at a time.</li>
          <li>The master autonomy switch halts tools too.</li>
          <li>Secrets are write-only: typed once, resolved at send time, never stored or shown.</li>
        </ul>
      </div>
    </div>
  );
}
