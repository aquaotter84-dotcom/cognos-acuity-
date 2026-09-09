// Phase 19 — the Autonomy page: an operator surface, not a chat surface.
//
// Everything here is either a query over stored rows or one of exactly two
// decisions: authorizing a goal, and approving/refusing/reverting a staged
// effect. Nothing on this page composes an answer. A goal's findings are shown
// as UNTRUSTED EVIDENCE with a citation-like treatment, never as COGNOS
// speaking, and the only way to turn them into an answer is the explicit
// "Ask COGNOS about this" turn, which goes through the council and the
// Governor like any other question.
//
// When autonomy is off, the page says so first and disables creation. That is
// not a warning banner bolted on — the resting state of this system is frozen,
// and the UI should look like it.

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, Bot, Check, ChevronDown, ChevronRight, ClipboardCheck,
  Clock, Gauge, Inbox, Menu, Pause, Play, Plus, RefreshCw, ScrollText,
  ShieldAlert, ShieldCheck, Snowflake, ThumbsDown, ThumbsUp, Undo2, X, Zap
} from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import { Pill, Empty, ErrorNote } from '@/components/system/SystemUi';

const TABS = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'residents', label: 'Residents', icon: Bot },
  { id: 'goals', label: 'Goals', icon: ScrollText },
  { id: 'notices', label: 'Notices', icon: Inbox },
  { id: 'outbox', label: 'Outbox', icon: ShieldCheck },
];

/** Status -> pill tone. Parked and refused are the interesting ones. */
const GOAL_TONE = {
  active: 'ok',
  awaiting_authorization: 'warn',
  parked: 'warn',
  completed: 'info',
  cancelled: 'muted',
  proposed: 'muted',
};

const GOAL_STATUS_HELP = {
  awaiting_authorization: 'Waiting for you. It will do no work until you authorize it.',
  active: 'Running. Each wake-up is a bounded slice.',
  parked: 'Stopped with a recorded reason. Resuming needs its authorization to still hold.',
  completed: 'Finished. Its findings are still evidence you can ask about.',
  cancelled: 'Ended. It will not wake again.',
};

const EFFECT_TONE = {
  staged: 'info',
  would_release: 'info',
  released: 'ok',
  refused: 'bad',
  reverted: 'muted',
  failed: 'bad',
};

const fmtTime = (v) => (v ? new Date(v).toLocaleString() : '—');
const fmtMoney = (v) => (v == null ? '—' : `$${Number(v).toFixed(4)}`);
const fmtMs = (v) => {
  if (v == null) return '—';
  const n = Number(v);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 90_000) return `${(n / 1000).toFixed(1)}s`;
  if (n < 5_400_000) return `${Math.round(n / 60_000)}m`;
  return `${(n / 3_600_000).toFixed(1)}h`;
};
const shortId = (v) => (v ? String(v).slice(0, 12) : '—');

/** A spend line against its ceiling, so "is it nearly out?" is a glance. */
function Meter({ label, used, limit, suffix = '' }) {
  const pct = limit > 0 ? Math.min(100, (Number(used) / Number(limit)) * 100) : 0;
  const tone = pct >= 100 ? 'bg-destructive' : pct >= 75 ? 'bg-yellow-500' : 'bg-primary';
  return (
    <div>
      <div className="flex items-baseline justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {Number(used).toLocaleString()}{suffix} / {Number(limit).toLocaleString()}{suffix}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Section({ title, subtitle, icon: Icon, children, action }) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60">
        {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-semibold">{title}</h3>
          {subtitle && <p className="text-[10px] text-muted-foreground/70 leading-snug">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** The frozen/enabled banner. Deliberately the first thing you see. */
function StatusBanner({ status }) {
  const on = status?.enabled === true;
  return (
    <div className={`rounded-xl border p-4 ${on ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/30'}`}>
      <div className="flex items-start gap-3">
        {on
          ? <Zap className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          : <Snowflake className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold flex items-center gap-2">
            {on ? 'Autonomy is enabled' : 'Autonomy is frozen'}
            <Pill tone={on ? 'ok' : 'muted'}>{on ? 'running' : 'default off'}</Pill>
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            {on
              ? 'Residents may wake on the heartbeat and advance authorized goals. Every effect they produce is still staged and judged before anything happens.'
              : 'Nothing wakes, no goal runs, no notice is written, no tick is recorded. This is the resting state (phase19.autonomy_default_off) — enabling a rung is an operator decision.'}
          </p>
          {!on && (
            <p className="text-[10px] text-muted-foreground/70 mt-1.5 font-mono">
              COGNOS_AUTONOMY_ENABLED{status?.requestedEnabled ? ` = ${status.requestedEnabled}` : ''}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Pill tone="info">outbox: {status?.outboxMode || 'shadow'}</Pill>
          <Pill tone="muted">tiers: {(status?.builtTiers || []).join(', ') || '—'}</Pill>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- residents
function Residents({ status, frozen, onError }) {
  const [rows, setRows] = useState([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', purpose: '', brief: '', skill_allowlist: [] });
  const [editing, setEditing] = useState(null);   // { id, brief }
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try { setRows(await api.listResidents()); }
    catch (e) { setError(e.message || 'Could not load residents'); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const skills = status?.skills || [];

  const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (busy || !form.name.trim()) return;
    setBusy(true); setError('');
    try {
      await api.createResident({
        name: form.name.trim(),
        slug: (form.slug || slugify(form.name)).trim(),
        purpose: form.purpose.trim() || undefined,
        brief: form.brief.trim(),
        skill_allowlist: form.skill_allowlist,
        enabled: true,
      });
      setForm({ name: '', slug: '', purpose: '', brief: '', skill_allowlist: [] });
      setCreating(false);
      await refresh();
    } catch (err) {
      setError(err.message || 'Could not create resident');
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!editing?.id) { setHistory([]); return; }
    let cancelled = false;
    api.getResident(editing.id)
      .then(d => { if (!cancelled) setHistory(d?.history || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [editing?.id]);

  const handleBrief = async (resident) => {
    if (busy || !editing?.brief?.trim()) return;
    setBusy(true); setError('');
    try {
      await api.updateResident(resident.id, { brief: editing.brief });
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err.message || 'Could not update the brief');
    } finally { setBusy(false); }
  };

  const toggleSkill = (id) => setForm(f => ({
    ...f,
    skill_allowlist: f.skill_allowlist.includes(id)
      ? f.skill_allowlist.filter(s => s !== id)
      : [...f.skill_allowlist, id]
  }));

  return (
    <div className="space-y-3">
      <ErrorNote error={error} />

      <Section
        title="Residents"
        subtitle="Named agents with an objective, a versioned brief, and their own skill allowlist"
        icon={Bot}
        action={
          <button
            onClick={() => setCreating(v => !v)}
            disabled={frozen}
            title={frozen ? 'Autonomy is frozen' : undefined}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40"
          >
            {creating ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {creating ? 'Cancel' : 'New resident'}
          </button>
        }
      >
        {creating && (
          <form onSubmit={handleCreate} className="mb-4 rounded-lg border border-border bg-background p-3 space-y-2">
            <div className="grid sm:grid-cols-2 gap-2">
              <input
                autoFocus value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value, slug: f.slug || slugify(e.target.value) }))}
                placeholder="Name — e.g. Recorder"
                className="bg-background border border-border rounded-lg px-2.5 py-2 text-xs outline-none focus:border-primary/60"
              />
              <input
                value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                placeholder="slug"
                className="bg-background border border-border rounded-lg px-2.5 py-2 text-xs font-mono outline-none focus:border-primary/60"
              />
            </div>
            <input
              value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))}
              placeholder="Purpose — one line, shown wherever the resident appears"
              className="w-full bg-background border border-border rounded-lg px-2.5 py-2 text-xs outline-none focus:border-primary/60"
            />
            <textarea
              value={form.brief} onChange={e => setForm(f => ({ ...f, brief: e.target.value }))}
              placeholder="Brief — operating instructions. A brief never grants a skill; only the allowlist below does."
              rows={3}
              className="w-full bg-background border border-border rounded-lg px-2.5 py-2 text-xs outline-none focus:border-primary/60 resize-none"
            />
            <div>
              <p className="text-[10px] text-muted-foreground mb-1.5">
                Skills this resident may use. The registry is code — a brief cannot add to it.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {skills.map(skill => {
                  const on = form.skill_allowlist.includes(skill.id);
                  return (
                    <button
                      key={skill.id} type="button" onClick={() => toggleSkill(skill.id)}
                      className={`px-2 py-1 rounded-md border text-[10px] transition-colors ${
                        on ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/50'
                      }`}
                      title={skill.summary}
                    >
                      {skill.id} <span className="opacity-60">{skill.tier}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <button type="submit" disabled={busy || !form.name.trim()}
              className="rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs disabled:opacity-40">
              Create resident
            </button>
          </form>
        )}

        {rows.length === 0 && !creating && (
          <Empty>No residents yet. Create one, then give it a goal to work on.</Empty>
        )}

        <div className="space-y-2">
          {rows.map(resident => (
            <div key={resident.id} className="rounded-lg border border-border">
              <div className="flex items-start gap-3 px-3 py-2.5">
                <Bot className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate flex items-center gap-2">
                    {resident.name}
                    <Pill tone={resident.enabled ? 'ok' : 'muted'}>{resident.enabled ? 'enabled' : 'disabled'}</Pill>
                    <Pill tone="muted">brief v{resident.brief_version}</Pill>
                  </p>
                  {resident.purpose && <p className="text-xs text-muted-foreground truncate">{resident.purpose}</p>}
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(resident.skill_allowlist || []).map(id => (
                      <span key={id} className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground">{id}</span>
                    ))}
                    {(resident.skill_allowlist || []).length === 0 && (
                      <span className="text-[10px] text-muted-foreground/70">no skills allowed yet</span>
                    )}
                  </div>
                  {resident.brief && (
                    <p className="text-[10px] text-muted-foreground/70 mt-1.5 line-clamp-2 whitespace-pre-wrap">
                      {resident.brief}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => setEditing(editing?.id === resident.id ? null : { id: resident.id, brief: resident.brief })}
                  className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
                  title="Change the brief (creates a new version)"
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${editing?.id === resident.id ? 'rotate-180' : ''}`} />
                </button>
              </div>

              {editing?.id === resident.id && (
                <div className="border-t border-border px-3 py-2.5 space-y-2 bg-muted/20">
                  {history?.length > 1 && (
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                        Previous versions — kept, never overwritten
                      </p>
                      {history.slice(0, -1).reverse().map(v => (
                        <div key={v.id} className="rounded border border-border/60 bg-background/60 px-2 py-1.5">
                          <p className="text-[10px] text-muted-foreground">v{v.brief_version} · {fmtTime(v.created_date)}</p>
                          <p className="text-[10px] text-foreground/70 line-clamp-2 whitespace-pre-wrap mt-0.5">{v.brief || '—'}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground flex items-start gap-1.5">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-500" />
                    <span>
                      Saving creates <strong>version {resident.brief_version + 1}</strong>. The previous brief is
                      kept, so you can always see what this resident was told when it did the thing you are
                      looking at (pin.resident_brief_subordinate).
                    </span>
                  </p>
                  <textarea
                    autoFocus value={editing.brief}
                    onChange={e => setEditing({ ...editing, brief: e.target.value })}
                    rows={4}
                    className="w-full bg-background border border-border rounded-lg px-2.5 py-2 text-xs outline-none focus:border-primary/60 resize-none font-mono"
                  />
                  <button onClick={() => handleBrief(resident)} disabled={busy}
                    className="rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs disabled:opacity-40">
                    Save as version {resident.brief_version + 1}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// -------------------------------------------------------------------- goals
function Goals({ status, frozen, residents, onError }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', objective: '', agent_id: '' });
  const [expanded, setExpanded] = useState(null);
  const [detail, setDetail] = useState({});
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try { setRows(await api.listGoals(filter ? { status: filter } : {})); }
    catch (e) { setError(e.message || 'Could not load goals'); }
  }, [filter]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    api.getGoal(expanded)
      .then(d => { if (!cancelled) setDetail(prev => ({ ...prev, [expanded]: d })); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [expanded, rows]);

  const decide = async (goalId, decision, extra = {}) => {
    setBusy(true); setError('');
    try {
      await api.decideGoal(goalId, { decision, ...extra });
      setDeclining(null); setReason('');
      await refresh();
      if (expanded) {
        const d = await api.getGoal(expanded);
        setDetail(prev => ({ ...prev, [expanded]: d }));
      }
    } catch (err) {
      setError(err.message || `Could not ${decision} this goal`);
    } finally { setBusy(false); }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (busy || !form.title.trim() || !form.objective.trim()) return;
    setBusy(true); setError('');
    try {
      await api.createGoal({
        title: form.title.trim(),
        objective: form.objective.trim(),
        agent_id: form.agent_id || undefined,
      });
      setForm({ title: '', objective: '', agent_id: '' });
      setCreating(false);
      await refresh();
    } catch (err) {
      setError(err.message || 'Could not create goal');
    } finally { setBusy(false); }
  };

  const d = expanded ? detail[expanded] : null;
  const findings = (d?.notes || []).filter(n => n.kind === 'finding');

  return (
    <div className="space-y-3">
      <ErrorNote error={error} />

      <Section
        title="Goals"
        subtitle="A goal does no work until you authorize it — authorization records the hash of the exact scope and budget you agreed to"
        icon={ScrollText}
        action={
          <div className="flex items-center gap-2">
            <select
              value={filter} onChange={e => setFilter(e.target.value)}
              className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs outline-none"
            >
              <option value="">All statuses</option>
              {['awaiting_authorization', 'active', 'parked', 'completed', 'cancelled'].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button
              onClick={() => setCreating(v => !v)}
              disabled={frozen || residents.length === 0}
              title={frozen ? 'Autonomy is frozen' : residents.length === 0 ? 'Create a resident first' : undefined}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40"
            >
              {creating ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
              {creating ? 'Cancel' : 'New goal'}
            </button>
          </div>
        }
      >
        {creating && (
          <form onSubmit={handleCreate} className="mb-4 rounded-lg border border-border bg-background p-3 space-y-2">
            <input
              autoFocus value={form.title}
              onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder="Title — e.g. Watch the county record"
              className="w-full bg-background border border-border rounded-lg px-2.5 py-2 text-xs outline-none focus:border-primary/60"
            />
            <textarea
              value={form.objective} onChange={e => setForm(f => ({ ...f, objective: e.target.value }))}
              placeholder="Objective — what would count as done?"
              rows={3}
              className="w-full bg-background border border-border rounded-lg px-2.5 py-2 text-xs outline-none focus:border-primary/60 resize-none"
            />
            <select
              value={form.agent_id} onChange={e => setForm(f => ({ ...f, agent_id: e.target.value }))}
              className="w-full bg-background border border-border rounded-lg px-2.5 py-2 text-xs outline-none"
            >
              <option value="">No resident (unowned)</option>
              {residents.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <p className="text-[10px] text-muted-foreground">
              The goal is created <strong>awaiting authorization</strong>. Nothing runs until you authorize it.
            </p>
            <button type="submit" disabled={busy || !form.title.trim() || !form.objective.trim()}
              className="rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs disabled:opacity-40">
              Create goal
            </button>
          </form>
        )}

        {rows.length === 0 && !creating && <Empty>No goals yet.</Empty>}

        <div className="space-y-2">
          {rows.map(goal => {
            const open = expanded === goal.id;
            const spent = goal.spent || {};
            const budget = goal.budget || {};
            return (
              <div key={goal.id} className="rounded-lg border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : goal.id)}
                  className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
                >
                  {open ? <ChevronDown className="w-3.5 h-3.5 mt-1 text-muted-foreground shrink-0" />
                        : <ChevronRight className="w-3.5 h-3.5 mt-1 text-muted-foreground shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate flex items-center gap-2">
                      {goal.title}
                      <Pill tone={GOAL_TONE[goal.status] || 'muted'}>{goal.status}</Pill>
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {GOAL_STATUS_HELP[goal.status] || ''}
                      {goal.park_reason ? ` Reason: ${goal.park_reason}.` : ''}
                    </p>
                    <div className="flex flex-wrap items-center gap-3 mt-1.5 text-[10px] text-muted-foreground tabular-nums">
                      <span>{Number(spent.steps || 0)} / {budget.maxSteps ?? '—'} steps</span>
                      <span>{fmtMoney(spent.costUsd || 0)} / {budget.maxCostUsd ?? '—'}</span>
                      {goal.next_run_at_ms && <span>next {fmtTime(Number(goal.next_run_at_ms))}</span>}
                    </div>
                  </div>
                </button>

                {open && (
                  <div className="border-t border-border px-3 py-3 space-y-3 bg-muted/10">
                    {!d ? (
                      <p className="text-xs text-muted-foreground">Loading…</p>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground whitespace-pre-wrap">{d.goal.objective}</p>

                        {/* ---- THE BARRIER ---- */}
                        {d.goal.status === 'awaiting_authorization' && (
                          <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
                            <p className="text-xs font-semibold flex items-center gap-1.5">
                              <ClipboardCheck className="w-3.5 h-3.5 text-accent" />
                              This goal is waiting for you
                            </p>
                            <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                              Authorizing records the hash of the scope and budget below. The goal can never
                              widen either without a new decision from you (pin.goal_scope_immutable).
                            </p>
                            <div className="grid sm:grid-cols-2 gap-2 mt-2 text-[10px]">
                              <div className="rounded bg-background/60 border border-border p-2">
                                <p className="text-muted-foreground mb-1">Scope</p>
                                <pre className="font-mono whitespace-pre-wrap break-all">{JSON.stringify(d.goal.scope, null, 1)}</pre>
                              </div>
                              <div className="rounded bg-background/60 border border-border p-2">
                                <p className="text-muted-foreground mb-1">Budget</p>
                                <pre className="font-mono whitespace-pre-wrap break-all">{JSON.stringify(d.goal.budget, null, 1)}</pre>
                              </div>
                            </div>
                            {declining === goal.id ? (
                              <div className="flex items-center gap-2 mt-2.5">
                                <input
                                  autoFocus value={reason}
                                  onChange={e => setReason(e.target.value)}
                                  placeholder="Why not? (optional, recorded)"
                                  className="flex-1 bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-primary/60"
                                />
                                <button onClick={() => decide(goal.id, 'decline', { reason: reason || undefined })} disabled={busy}
                                  className="rounded-lg bg-destructive text-destructive-foreground px-3 py-1.5 text-xs disabled:opacity-40">
                                  Decline
                                </button>
                                <button onClick={() => { setDeclining(null); setReason(''); }}
                                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-2 mt-2.5">
                                <button onClick={() => decide(goal.id, 'authorize')} disabled={busy}
                                  className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs disabled:opacity-40">
                                  <ThumbsUp className="w-3.5 h-3.5" /> Authorize
                                </button>
                                <button onClick={() => setDeclining(goal.id)} disabled={busy}
                                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted/50 disabled:opacity-40">
                                  <ThumbsDown className="w-3.5 h-3.5" /> Decline
                                </button>
                              </div>
                            )}
                          </div>
                        )}

                        {/* ---- lifecycle controls ---- */}
                        {(d.goal.status === 'active' || d.goal.status === 'parked') && (
                          <div className="flex flex-wrap items-center gap-2">
                            {d.goal.status === 'active'
                              ? <button onClick={() => decide(goal.id, 'pause')} disabled={busy}
                                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted/50 disabled:opacity-40">
                                  <Pause className="w-3.5 h-3.5" /> Pause
                                </button>
                              : <button onClick={() => decide(goal.id, 'resume')} disabled={busy}
                                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted/50 disabled:opacity-40">
                                  <Play className="w-3.5 h-3.5" /> Resume
                                </button>}
                            <button
                              onClick={() => { if (window.confirm(`Cancel “${goal.title}”? This ends it; it cannot be resumed.`)) decide(goal.id, 'cancel'); }}
                              disabled={busy}
                              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-destructive disabled:opacity-40">
                              <X className="w-3.5 h-3.5" /> Cancel
                            </button>
                          </div>
                        )}

                        {/* ---- findings: evidence, never an answer ---- */}
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                          <p className="text-xs font-semibold flex items-center gap-1.5">
                            <ShieldAlert className="w-3.5 h-3.5 text-amber-500" />
                            Untrusted findings — {findings.length}
                          </p>
                          <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                            These are the resident's own typed notes: what it <em>said</em>, not what is true.
                            They are never presented as COGNOS speaking. To turn them into an answer, ask.
                          </p>
                          {findings.length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {findings.slice(0, 5).map(note => (
                                <li key={note.id} className="flex items-start gap-2 text-[11px]">
                                  <span className="font-mono text-[9px] text-muted-foreground mt-0.5 shrink-0">[{note.ordinal}]</span>
                                  <span className="text-foreground/80">{note.body}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          <button
                            onClick={() => d.goal.conversation_id && navigate(`/?c=${d.goal.conversation_id}`)}
                            disabled={!d.goal.conversation_id}
                            className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs disabled:opacity-40"
                          >
                            Ask COGNOS about this <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                          <p className="text-[10px] text-muted-foreground/70 mt-1">
                            Opens this resident's conversation. You ask; the council answers through the
                            Governor. A goal can never propose a draft answer.
                          </p>
                        </div>

                        {/* ---- audit trail ---- */}
                        <div className="grid md:grid-cols-2 gap-3">
                          <div>
                            <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Steps</p>
                            {d.steps?.length ? (
                              <ul className="space-y-1">
                                {d.steps.map(step => (
                                  <li key={step.id} className="flex items-center gap-2 text-[10px] font-mono">
                                    <span className="text-muted-foreground w-5 text-right">{step.ordinal}</span>
                                    <span className="flex-1 truncate">{step.skill_id}</span>
                                    <Pill tone={step.status === 'completed' ? 'ok' : step.status === 'refused' ? 'bad' : 'muted'}>
                                      {step.status}
                                    </Pill>
                                    {step.error_message && (
                                      <span className="text-destructive truncate max-w-[140px]" title={step.error_message}>
                                        {step.error_message}
                                      </span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            ) : <p className="text-[10px] text-muted-foreground">No steps yet.</p>}
                          </div>
                          <div>
                            <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Event log</p>
                            {d.events?.length ? (
                              <ul className="space-y-1 max-h-48 overflow-y-auto scrollbar-thin">
                                {d.events.slice().reverse().map(event => (
                                  <li key={event.id} className="flex items-start gap-2 text-[10px]">
                                    <Clock className="w-3 h-3 mt-0.5 text-muted-foreground/60 shrink-0" />
                                    <span className="font-mono text-foreground/80">{event.event_type}</span>
                                    <span className="text-muted-foreground ml-auto shrink-0">{fmtTime(event.created_date)}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : <p className="text-[10px] text-muted-foreground">No events yet.</p>}
                          </div>
                        </div>

                        {/* ---- authorizations ---- */}
                        {d.approvals?.length > 0 && (
                          <div>
                            <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">Authorizations</p>
                            <ul className="space-y-1">
                              {d.approvals.map(a => (
                                <li key={a.id} className="flex items-center gap-2 text-[10px] font-mono">
                                  <Pill tone={a.decision === 'authorize' ? 'ok' : 'bad'}>{a.decision}</Pill>
                                  <span className="text-muted-foreground truncate">scope {shortId(a.scope_sha256)}</span>
                                  <span className="text-muted-foreground truncate">budget {shortId(a.budget_sha256)}</span>
                                  {a.reason && <span className="text-muted-foreground/70 truncate">“{a.reason}”</span>}
                                  <span className="ml-auto text-muted-foreground/70 shrink-0">{fmtTime(a.created_date)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ notices
function Notices() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try { setRows(await api.listNotices()); }
    catch (e) { setError(e.message || 'Could not load notices'); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const ack = async (id) => {
    try { await api.ackNotice(id); await refresh(); }
    catch (e) { setError(e.message || 'Could not acknowledge'); }
  };

  return (
    <Section
      title="Notices"
      subtitle="Templated messages from the loop — deterministic text, never model prose"
      icon={Inbox}
    >
      <ErrorNote error={error} />
      {rows.length === 0
        ? <Empty>No unread notices. A goal that parks, finishes or runs low on budget leaves one here.</Empty>
        : (
          <div className="space-y-2">
            {rows.map(notice => (
              <div key={notice.id} className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
                <Inbox className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs">{notice.text || '—'}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {notice.templateId} · {notice.severity} · {fmtTime(notice.createdMs)}
                    {notice.goalId ? ` · goal ${shortId(notice.goalId)}` : ''}
                  </p>
                </div>
                <button onClick={() => ack(notice.id)}
                  className="shrink-0 flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] hover:bg-muted/50">
                  <Check className="w-3 h-3" /> Acknowledge
                </button>
              </div>
            ))}
          </div>
        )}
    </Section>
  );
}

// ------------------------------------------------------------------- outbox
function Outbox({ status }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setData(await api.listOutbox()); }
    catch (e) { setError(e.message || 'Could not load the outbox'); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const decide = async (id, decision) => {
    setBusy(true); setError('');
    try { await api.decideEffect(id, { decision }); await refresh(); }
    catch (e) { setError(e.message || `Could not ${decision} this effect`); }
    finally { setBusy(false); }
  };

  const effects = data?.effects || [];
  const corpus = data?.corpus;

  return (
    <div className="space-y-3">
      <ErrorNote error={error} />

      {corpus && (
        <Section
          title="Shadow corpus"
          subtitle="Every judgement recorded while nothing was delivered — the evidence that earns the next rung"
          icon={Gauge}
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              ['samples', corpus.samples],
              ['would release', corpus.wouldRelease],
              ['refused', corpus.refused],
              ['released', corpus.released],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border px-3 py-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
                <p className="text-lg font-semibold tabular-nums">{value ?? 0}</p>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            Rung 4 (external writes) opens only when this corpus justifies it. A count alone can be
            rationalised; a single false release cannot.
          </p>
        </Section>
      )}

      <Section
        title="Staged effects"
        subtitle="Staging is not acting. Each effect is judged by the Action Governor before anything happens."
        icon={ShieldCheck}
      >
        {effects.length === 0
          ? <Empty>Nothing staged. Phase 19 builds T0–T2 only, so the only effect a goal can produce is a notice.</Empty>
          : (
            <div className="space-y-2">
              {effects.map(effect => {
                const verdict = effect.verdict || {};
                return (
                  <div key={effect.id} className="rounded-lg border border-border px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium flex items-center gap-2 flex-wrap">
                          <span className="font-mono">{effect.effect_type}</span>
                          <Pill tone="muted">{effect.tier}</Pill>
                          <Pill tone={EFFECT_TONE[effect.status] || 'muted'}>{effect.status}</Pill>
                          <Pill tone={effect.mode === 'live' ? 'warn' : 'info'}>{effect.mode}</Pill>
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5 font-mono truncate">
                          skill {effect.skill_id} · goal {shortId(effect.goal_id)} · key {shortId(effect.idempotency_key)}
                        </p>
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5">{fmtTime(effect.created_date)}</p>
                      </div>
                      {effect.status === 'staged' && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button onClick={() => decide(effect.id, 'approve')} disabled={busy}
                            className="flex items-center gap-1 rounded-lg bg-primary text-primary-foreground px-2 py-1 text-[10px] disabled:opacity-40">
                            <ThumbsUp className="w-3 h-3" /> Approve
                          </button>
                          <button onClick={() => decide(effect.id, 'refuse')} disabled={busy}
                            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] hover:bg-muted/50 disabled:opacity-40">
                            <ThumbsDown className="w-3 h-3" /> Refuse
                          </button>
                        </div>
                      )}
                      {['released', 'refused'].includes(effect.status) && (
                        <button onClick={() => decide(effect.id, 'revert')} disabled={busy}
                          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] hover:bg-muted/50 shrink-0 disabled:opacity-40">
                          <Undo2 className="w-3 h-3" /> Revert
                        </button>
                      )}
                    </div>

                    {verdict.failed?.length > 0 && (
                      <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5">
                        <p className="text-[10px] font-semibold text-destructive flex items-center gap-1">
                          <ShieldAlert className="w-3 h-3" /> Refused — {verdict.failed.length} rule(s) fired
                        </p>
                        <ul className="mt-1 space-y-0.5">
                          {verdict.failed.map((f, i) => (
                            <li key={i} className="text-[10px]">
                              <span className="font-mono text-destructive">{f.rule}</span>
                              <span className="text-muted-foreground"> — {f.reason}</span>
                              {f.law && <span className="text-muted-foreground/70 font-mono"> ({f.law})</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {verdict.passed?.length > 0 && (
                      <details className="mt-1.5">
                        <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                          {verdict.passed.length} check(s) passed
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {verdict.passed.map((p, i) => (
                            <li key={i} className="text-[10px] text-muted-foreground flex items-start gap-1">
                              <Check className="w-3 h-3 mt-0.5 text-green-500 shrink-0" /> {p}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </Section>
    </div>
  );
}

// ----------------------------------------------------------------- overview
function Overview({ status, residents, goals, onTick, ticking }) {
  const ceilings = status?.ceilings || {};
  const counts = status?.counts || {};
  const skills = status?.skills || [];
  const tick = status?.tick || {};

  return (
    <div className="space-y-3">
      <StatusBanner status={status} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ['Residents', counts.residents ?? residents.length, Bot, 'text-accent'],
          ['Active goals', counts.activeGoals ?? 0, Activity, 'text-green-500'],
          ['Parked goals', counts.parkedGoals ?? 0, Pause, 'text-yellow-500'],
          ['Staged effects', counts.stagedEffects ?? 0, ShieldCheck, 'text-primary'],
        ].map(([label, value, Icon, tone]) => (
          <div key={label} className="rounded-xl border border-border bg-card px-3 py-3">
            <Icon className={`w-3.5 h-3.5 ${tone} mb-1.5`} />
            <p className="text-xl font-semibold tabular-nums">{value}</p>
            <p className="text-[10px] text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <Section title="Ceilings" subtitle="Hitting one parks a goal and writes a notice — it is never silently queued" icon={Gauge}>
          <div className="space-y-3">
            <Meter label="Workspace spend today" used={0} limit={ceilings.maxCostPerDayUsd ?? 0} suffix="" />
            <div className="grid grid-cols-2 gap-3 text-[10px]">
              <div><p className="text-muted-foreground">Daily ceiling</p><p className="font-medium tabular-nums">{fmtMoney(ceilings.maxCostPerDayUsd)}</p></div>
              <div><p className="text-muted-foreground">Monthly ceiling</p><p className="font-medium tabular-nums">{fmtMoney(ceilings.maxCostPerMonthUsd)}</p></div>
              <div><p className="text-muted-foreground">Active goals</p><p className="font-medium tabular-nums">{ceilings.maxActiveGoals}</p></div>
              <div><p className="text-muted-foreground">Notices / day</p><p className="font-medium tabular-nums">{ceilings.maxNoticesPerDay}</p></div>
            </div>
          </div>
        </Section>

        <Section title="The loop" subtitle="One bounded slice per wake-up; a lease makes two workers impossible" icon={RefreshCw}>
          <div className="grid grid-cols-2 gap-3 text-[10px]">
            <div><p className="text-muted-foreground">Heartbeat</p><p className="font-medium tabular-nums">{fmtMs(tick.intervalMs)}</p></div>
            <div><p className="text-muted-foreground">Slice cap</p><p className="font-medium tabular-nums">{fmtMs(tick.sliceMs)}</p></div>
            <div><p className="text-muted-foreground">Steps / slice</p><p className="font-medium tabular-nums">{tick.maxStepsPerTick}</p></div>
            <div><p className="text-muted-foreground">Lease</p><p className="font-medium tabular-nums">{fmtMs(tick.leaseMs)}</p></div>
            <div><p className="text-muted-foreground">Park after</p><p className="font-medium tabular-nums">{tick.maxConsecutiveFailures} failures</p></div>
            <div><p className="text-muted-foreground">Notices</p><p className="font-medium">{status?.notices?.mode || '—'}</p></div>
          </div>
          <button onClick={onTick} disabled={ticking || status?.enabled !== true}
            className="mt-3 flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs disabled:opacity-40"
            title={status?.enabled !== true ? 'Autonomy is frozen' : 'Run one bounded slice now'}>
            <RefreshCw className={`w-3.5 h-3.5 ${ticking ? 'animate-spin' : ''}`} /> Run a slice now
          </button>
        </Section>
      </div>

      <Section
        title="Skills"
        subtitle="Code-owned, not data. A row in any table cannot add to this list — only a reviewed code change can."
        icon={Zap}
      >
        <div className="space-y-1.5">
          {skills.map(skill => (
            <div key={skill.id} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
              <Pill tone={skill.tier === 'T0' ? 'muted' : skill.tier === 'T1' ? 'info' : 'warn'}>{skill.tier}</Pill>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium font-mono">{skill.id}</p>
                <p className="text-[10px] text-muted-foreground">{skill.summary}</p>
                <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5">kill switch: {skill.killSwitch}</p>
              </div>
              <Pill tone={skill.enabled ? 'ok' : 'muted'}>{skill.enabled ? 'enabled' : 'off'}</Pill>
            </div>
          ))}
          {status?.noticeTemplates?.length > 0 && (
            <p className="text-[10px] text-muted-foreground pt-1">
              Notice templates: <span className="font-mono">{status.noticeTemplates.join(', ')}</span> —
              a model cannot write free text into a notice.
            </p>
          )}
        </div>
      </Section>
    </div>
  );
}

// --------------------------------------------------------------------- page
export default function Autonomy() {
  const { openSidebar } = useCognos() || {};
  const [tab, setTab] = useState('overview');
  const [status, setStatus] = useState(null);
  const [residents, setResidents] = useState([]);
  const [goals, setGoals] = useState([]);
  const [ticking, setTicking] = useState(false);
  const [error, setError] = useState('');
  const [, forceRefresh] = useState(0);

  const refreshAll = useCallback(async () => {
    try {
      const [s, r, g] = await Promise.all([
        api.autonomyStatus(),
        api.listResidents().catch(() => []),
        api.listGoals().catch(() => []),
      ]);
      setStatus(s); setResidents(r); setGoals(g);
    } catch (e) {
      setError(e.message || 'Could not load the autonomy status');
    }
  }, []);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  const frozen = status?.enabled !== true;

  const runTick = async () => {
    setTicking(true); setError('');
    try {
      const result = await api.runTick();
      if (result?.frozen) setError('Autonomy is frozen — nothing ran.');
      await refreshAll();
      forceRefresh(n => n + 1);
    } catch (e) {
      setError(e.message || 'The tick failed');
    } finally { setTicking(false); }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <header
        className="flex items-center gap-2 px-3 md:px-4 py-3 border-b border-border shrink-0"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
      >
        <button onClick={() => openSidebar?.()} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted">
          <Menu className="w-5 h-5" />
        </button>
        <Bot className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-medium">Autonomy</h2>
        <span className="text-[10px] text-muted-foreground hidden sm:inline">
          residents, goals, and the outbox — every effect judged before it happens
        </span>
        <button
          onClick={refreshAll}
          className="ml-auto p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
          title="Refresh"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex items-center gap-1 px-3 md:px-4 py-2 border-b border-border overflow-x-auto shrink-0">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors ${
              tab === id ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
            }`}
          >
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 min-h-0">
        <div className="max-w-4xl mx-auto space-y-3">
          <ErrorNote error={error} />

          {!status ? (
            <p className="text-xs text-muted-foreground py-6 text-center">Loading autonomy status…</p>
          ) : tab === 'overview' ? (
            <Overview status={status} residents={residents} goals={goals} onTick={runTick} ticking={ticking} />
          ) : tab === 'residents' ? (
            <Residents status={status} frozen={frozen} />
          ) : tab === 'goals' ? (
            <Goals status={status} frozen={frozen} residents={residents} />
          ) : tab === 'notices' ? (
            <Notices />
          ) : (
            <Outbox status={status} />
          )}
        </div>
      </div>
    </div>
  );
}
