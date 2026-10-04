// Phase 19 — the Autonomy page: an operator surface, not a chat surface.
//
// Everything here is either a query over stored rows or one of exactly three
// decisions: authorizing a goal, approving/refusing/reverting a staged
// effect, and approving/refusing a promotion (Phase 20: the only route from a
// working note to durable knowledge). Nothing on this page composes an answer. A goal's findings are shown
// as UNTRUSTED EVIDENCE with a citation-like treatment, never as COGNOS
// speaking, and the only way to turn them into an answer is the explicit
// "Ask COGNOS about this" turn, which goes through the council and the
// Governor like any other question.
//
// When autonomy is off, the page says so first and disables creation. That is
// not a warning banner bolted on — the resting state of this system is frozen,
// and the UI should look like it.
//
// Phase 25 adds three things and changes no decision above:
//   * the switch itself, when an operator has delegated it (settings.js);
//   * "Needs your attention" — one glance at everything waiting on a human,
//     each row jumping to the tab that resolves it;
//   * plain-language labels, with the machine vocabulary demoted into a
//     "Technical details" disclosure rather than deleted (see lib/autonomyLabels.js).
// The designer drawer is the one place here that talks to a model, and it
// creates nothing: it drafts rows and hands you an explicit Create button.

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity, AlertTriangle, Bell, Bot, Check, ChevronDown, ChevronRight, ClipboardCheck,
  Clock, Copy, Gauge, Heart, HelpCircle, Inbox, Lock, Menu, Pause, Pencil, Play, Plus, RefreshCw, ScrollText,
  Send, ShieldAlert, ShieldCheck, Snowflake, Sparkles, Sprout, MessageCircle, Trash2, ThumbsDown, ThumbsUp, Undo2, X, Zap, Wrench
} from 'lucide-react';
import { api } from '@/lib/api';
import { noteLocator } from '@/components/chat/GoalCard';
import { useCognos } from '@/lib/cognosContext';
import { Pill, Empty, ErrorNote } from '@/components/system/SystemUi';
import DesignerDrawer from '@/components/autonomy/DesignerDrawer';
import ResidentChatDrawer from '@/components/autonomy/ResidentChatDrawer';
import AuthorizeConsent from '@/components/autonomy/AuthorizeConsent';
import ToolsTab, { ResidentToolPicker, ToolRunHistory } from '@/components/autonomy/ResidentTools';
import { ARCHIVIST } from '@/lib/archivist';
import {
  GLOSSARY, TIER_LABEL, effectStatusLabel, goalStatusLabel,
  humanInterval, outboxModeLabel, parkReasonLabel, tierLabel,
} from '@/lib/autonomyLabels';

const TABS = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'residents', label: 'Residents', icon: Bot },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'goals', label: 'Goals', icon: ScrollText },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'notices', label: 'Notices', icon: Inbox },
  { id: 'outbox', label: 'Outbox', icon: ShieldCheck },
  { id: 'promotions', label: 'Promotions', icon: Sprout },
  { id: 'cleanup', label: 'Cleanup', icon: Sparkles },
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

/** The setup steps shown when nobody has handed the switch to this page. */
const SETUP_STEPS = [
  {
    env: 'COGNOS_AUTONOMY_UI_CONTROL=true',
    what: 'Hands the on/off switch to this page. Recommended: you can then turn autonomy on and off from here, and every flip is recorded.',
  },
  {
    env: 'COGNOS_AUTONOMY_ENABLED=true',
    what: 'Pins autonomy on in the environment instead. This outranks the UI — once pinned, the toggle cannot turn it off.',
  },
  {
    env: 'restart the server process',
    what: 'Environment variables are read at boot. After a flip from this page no restart is needed; after editing them, one is.',
  },
  {
    env: 'COGNOS_AUTONOMY_NOTICE_MODE=internal',
    what: 'Optional. When autonomy is on and this is unset, notices already go to the in-app channel. Set none to stay silent, or webhook plus COGNOS_AUTONOMY_NOTICE_WEBHOOK to post them out.',
  },
];

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50"
      title="Copy to clipboard"
    >
      {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

/** The env-var setup steps, for server deploys where the switches are managed
    by the environment and this page cannot hand them over itself. */
function SetupStepsPanel() {
  return (
    <div className="mt-2.5 rounded-lg border border-border bg-background/60 p-3">
      <p className="text-[11px] font-semibold flex items-center gap-1.5">
        <ClipboardCheck className="w-3.5 h-3.5 text-muted-foreground" />
        How to turn it on
      </p>
      <ol className="mt-2 space-y-2">
        {SETUP_STEPS.map((step, i) => (
          <li key={step.env} className="flex items-start gap-2">
            <span className="text-[10px] text-muted-foreground/70 tabular-nums mt-0.5">{i + 1}.</span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 flex-wrap">
                <code className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded">{step.env}</code>
                {step.env.startsWith('COGNOS_') && <CopyButton text={step.env} />}
              </p>
              <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">{step.what}</p>
            </div>
          </li>
        ))}
      </ol>
      <CopyButton
        label="Copy all the steps"
        text={SETUP_STEPS.map((s, i) => `${i + 1}. ${s.env} — ${s.what}`).join('\n')}
      />
    </div>
  );
}

/**
 * The switch handover: the honest answer to "why are the toggles dead?"
 *
 * The Autonomy page's switches are held back until an operator hands them over
 * (server/autonomy/settings.js). On a server deploy that means environment
 * variables, so the page keeps the copyable setup steps. On this phone there is
 * no operator shell — Jeremy is the operator — so the page hands the switches
 * to itself through the delegation files (server/delegation-files.mjs, read at
 * boot by mobile/entry.mjs). A handover takes effect when the app is closed and
 * reopened, and the panel says so instead of pretending a toggle is live.
 * Nothing here touches the governance logic: it only writes the files the boot
 * reads, and an operator pin still outranks everything.
 */
function SwitchHandover({ canToggle, pinned }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setState(await api.autonomyDelegation()); }
    catch { setState({ managed: 'environment', switches: [] }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const handOver = async (name) => {
    if (busy) return;
    setBusy(name); setError('');
    try { setState(await api.handOverAutonomySwitch(name)); }
    catch (e) { setError(e?.message || 'Could not hand the switch over.'); }
    finally { setBusy(null); }
  };

  const takeBack = async (name) => {
    if (busy) return;
    setBusy(name); setError('');
    try { setState(await api.takeBackAutonomySwitch(name)); }
    catch (e) { setError(e?.message || 'Could not take the switch back.'); }
    finally { setBusy(null); }
  };

  if (!state) return null;

  // A server deploy: no delegation files, so the env-var setup steps stand.
  if (state.managed !== 'device') {
    return (!canToggle && !pinned) ? <SetupStepsPanel /> : null;
  }

  const switches = state.switches || [];
  // Shown while any switch is not live — including "handed over, restart
  // pending", which is exactly when the user needs the restart instruction.
  if (!switches.some((sw) => !sw.delegated)) return null;

  return (
    <div className="mt-2.5 rounded-lg border border-border bg-background/60 p-3">
      <p className="text-[11px] font-semibold flex items-center gap-1.5">
        <ClipboardCheck className="w-3.5 h-3.5 text-muted-foreground" />
        The switches are held back
      </p>
      <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
        These switches are held back until the operator hands them over. On this phone,
        you&rsquo;re the operator — tap to hand a switch to this page. It takes effect
        when you close and reopen the app. An operator pin (a real environment variable,
        if one is ever set) still outranks everything.
      </p>
      {error && <p className="text-[10px] text-destructive mt-1.5">{error}</p>}
      <div className="mt-2 space-y-2">
        {switches.map((sw) => (
          <div key={sw.name} className="rounded-lg border border-border/70 px-2.5 py-2">
            <p className="text-[11px] font-medium">{sw.label}</p>
            <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">{sw.blurb}</p>
            <div className="mt-1.5">
              {!sw.delegated && !sw.fileDelegated && (
                <button
                  onClick={() => handOver(sw.name)}
                  disabled={busy === sw.name}
                  className="rounded-lg bg-primary text-primary-foreground px-2.5 py-1.5 text-[11px] disabled:opacity-40"
                >
                  {busy === sw.name ? 'Handing over…' : sw.cta}
                </button>
              )}
              {sw.fileDelegated && !sw.delegated && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Pill tone="info">handed over — restart pending</Pill>
                  <span className="text-[10px] text-muted-foreground">Close and reopen the app to use it.</span>
                  <button
                    onClick={() => takeBack(sw.name)}
                    disabled={busy === sw.name}
                    className="text-[10px] text-muted-foreground underline hover:text-foreground disabled:opacity-40"
                  >
                    Take it back
                  </button>
                </div>
              )}
              {sw.delegated && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Pill tone="ok">handed over</Pill>
                  {sw.fileDelegated ? (
                    <button
                      onClick={() => takeBack(sw.name)}
                      disabled={busy === sw.name}
                      className="text-[10px] text-muted-foreground underline hover:text-foreground disabled:opacity-40"
                    >
                      Take it back
                    </button>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">
                      Handed over by the environment — this page can&rsquo;t take it back.
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The switch itself — present only when an operator delegated it. */
function EnableToggle({ status, busy, onToggle }) {
  const on = status?.enabled === true;
  return (
    <div className="flex items-center gap-2.5 shrink-0">
      <span className="text-[11px] text-muted-foreground hidden sm:inline">{on ? 'On' : 'Off'}</span>
      <button
        role="switch"
        aria-checked={on}
        aria-label={on ? 'Turn autonomy off' : 'Turn autonomy on'}
        onClick={() => onToggle(!on)}
        disabled={busy}
        className={`relative w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-primary' : 'bg-muted-foreground/30'}`}
        title={on ? 'Turn autonomy off' : 'Turn autonomy on'}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-background shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

/**
 * The banner: the first thing on the page, and the answer to "is it on, and can
 * I do anything about that?"
 *
 * Three cases, because they are three genuinely different situations. A frozen
 * page that only names an environment variable is a dead end; a toggle that
 * silently fails against an operator pin is a lie. So: a working switch when the
 * switch was delegated, an honest "an operator pinned this" when it was not, and
 * copyable setup steps when neither.
 */
function StatusBanner({ status, busy, onToggle, onError }) {
  const on = status?.enabled === true;
  const canToggle = status?.canToggleFromUi === true;
  const pinned = status?.pinned === true;

  return (
    <div className={`rounded-xl border p-4 ${on ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/30'}`}>
      <div className="flex items-start gap-3">
        {on
          ? <Zap className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          : <Snowflake className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold flex items-center gap-2 flex-wrap">
            {on ? 'Autonomy is on' : 'Autonomy is off'}
            <Pill tone={on ? 'ok' : 'muted'}>{on ? 'running' : 'frozen'}</Pill>
            {pinned && <Pill tone="info">pinned by an operator</Pill>}
            {!pinned && canToggle && <Pill tone="info">you control this</Pill>}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            {on
              ? 'Residents may wake on the heartbeat and advance authorized goals. Every effect they produce is still staged and judged before anything happens, and a goal still does no work until you authorize it.'
              : 'Nothing wakes, no goal runs, no notice is written, no tick is recorded. This is the resting state — and you can change it from here if an operator handed you the switch.'}
          </p>

          {pinned && (
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
              An operator pinned this on with{' '}
              <span className="font-mono text-foreground/80">COGNOS_AUTONOMY_ENABLED{status?.requestedEnabled ? `=${String(status.requestedEnabled).split(' ')[0]}` : '=true'}</span>.
              The UI will not pretend it can override that — remove the variable and restart to hand the switch back.
            </p>
          )}

          <SwitchHandover canToggle={canToggle} pinned={pinned} />

          {canToggle && (
            <p className="text-[10px] text-muted-foreground/70 mt-1.5">
              Flipping this takes effect on the next heartbeat — no restart — and every flip is written to the audit trail.
              {status?.settings?.stored?.updatedAtMs ? ` Last changed ${fmtTime(new Date(Number(status.settings.stored.updatedAtMs)))}${status.settings.stored.updatedBy ? ` by ${status.settings.stored.updatedBy}` : ''}.` : ''}
            </p>
          )}
        </div>

        <div className="flex flex-col items-end gap-2 shrink-0">
          {canToggle && <EnableToggle status={status} busy={busy} onToggle={onToggle} />}
          {!canToggle && (
            <div className="flex flex-col items-end gap-1">
              <Pill tone="muted">outbox: {outboxModeLabel(status?.outboxMode || 'shadow')}</Pill>
              <Pill tone="muted">{(status?.builtTiers || []).length} tiers built</Pill>
            </div>
          )}
        </div>
      </div>
      {onError}
    </div>
  );
}

/**
 * "What does autonomy want from me?" — one panel, one glance.
 *
 * Everything in here is a thing that is waiting on a human, grouped by the kind
 * of decision, and each group names the tab that resolves it. The panel adds no
 * new decision: every row is a link to a barrier that already existed. An empty
 * panel is the good state, and it says so in words rather than disappearing.
 */
function AttentionPanel({ data, onJump, loading }) {
  if (loading) {
    return (
      <Section title="Needs your attention" icon={Bell}>
        <p className="text-xs text-muted-foreground">Checking…</p>
      </Section>
    );
  }
  const groups = (data?.groups || []).filter(g => g.count > 0);

  return (
    <Section
      title="Needs your attention"
      subtitle="Everything waiting on you, in one place. Nothing here happens until you decide."
      icon={Bell}
      action={<Pill tone={groups.length ? 'warn' : 'ok'}>{data?.total ?? 0} waiting</Pill>}
    >
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground py-1">
          Nothing is waiting on you. {data?.enabled ? 'The loop is running and has no questions.' : 'Autonomy is off, so there is nothing to ask.'}
        </p>
      ) : (
        <div className="space-y-2">
          {groups.map(group => (
            <div key={group.kind} className="rounded-lg border border-border">
              <button
                onClick={() => onJump(group.tab)}
                className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
                title={`Open the ${group.tab} tab`}
              >
                <span className="mt-0.5 shrink-0 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-semibold px-1.5 py-0.5 tabular-nums">
                  {group.count}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-xs font-medium block">{group.label}</span>
                  <span className="text-[10px] text-muted-foreground block leading-snug">{group.hint}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {group.rows.slice(0, 3).map(row => (
                      <span key={row.id} className="px-1.5 py-0.5 rounded bg-muted text-[10px] truncate max-w-[16rem]">
                        {row.title || row.id}
                        {row.detail ? <span className="text-muted-foreground"> · {row.detail}</span> : null}
                      </span>
                    ))}
                    {group.count > 3 && <span className="text-[10px] text-muted-foreground px-1">+{group.count - 3} more</span>}
                  </span>
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground mt-1 shrink-0" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** The glossary behind the "?" button. Teaches the jargon instead of hiding it. */
function HelpDrawer({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label="What these words mean">
      <button className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close" tabIndex={-1} />
      <div className="relative flex flex-col w-full max-w-md h-full bg-background border-l border-border shadow-2xl">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <HelpCircle className="w-4 h-4 text-primary" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold">What these words mean</h2>
            <p className="text-[10px] text-muted-foreground">Plain language first, the machine name under it.</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted" title="Close">
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-3">
          {GLOSSARY.map(entry => (
            <div key={entry.term}>
              <p className="text-xs font-semibold">{entry.term}</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">{entry.body}</p>
              <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">{entry.technical}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- residents
function Residents({ status, frozen, onError, onDesign, onChanged }) {
  const [rows, setRows] = useState([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', slug: '', purpose: '', brief: '', skill_allowlist: [] });
  const [editing, setEditing] = useState(null);   // { id, brief }
  const [expandedPurpose, setExpandedPurpose] = useState(null); // resident id with full purpose shown
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [chatResident, setChatResident] = useState(null); // Phase 34: per-resident chat

  const refresh = useCallback(async () => {
    try { setRows(await api.listResidents()); }
    catch (e) { setError(e.message || 'Could not load residents'); }
    onChanged?.();
  }, [onChanged]);

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

  const handleDelete = async (resident) => {
    if (busy || !window.confirm(`Delete ${resident.name}? Its version history will be removed. Existing conversation and goal records are kept where possible.`)) return;
    setBusy(true); setError('');
    try { await api.deleteResident(resident.id); setEditing(null); await refresh(); }
    catch (err) { setError(err.message || 'Could not delete the resident'); }
    finally { setBusy(false); }
  };

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

      <div className="px-1 pt-1">
        <p className="orbit-eyebrow">Your team</p>
        <h2 className="orbit-page-title text-xl mt-1">Meet your residents.</h2>
        <p className="orbit-page-sub text-sm mt-1">Made by you, for the things you want to get done.</p>
      </div>

      <Section
        title="Residents"
        subtitle="Named agents with an objective, a versioned brief, and their own skill allowlist"
        icon={Bot}
        action={
          <div className="flex items-center gap-1.5">
            {/* Designing is never disabled by the frozen state: describing a
                resident is how you find out what you want to turn on. */}
            <button
              onClick={onDesign}
              title="Describe a resident in plain words and COGNOS drafts it"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-primary/40 bg-primary/5 text-primary text-xs font-medium hover:bg-primary/10"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Design with COGNOS</span>
            </button>
            <button
              onClick={() => setCreating(v => !v)}
              disabled={frozen}
              title={frozen ? 'Autonomy is off — turn it on, or design a resident first' : 'Fill in the form yourself'}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40"
            >
              {creating ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
              {creating ? 'Cancel' : 'New resident'}
            </button>
          </div>
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
                      } ${skill.enabled ? '' : 'opacity-50'}`}
                      title={`${skill.summary} — ${tierLabel(skill.tier)}${skill.enabled ? '' : ' (not available in this deployment yet)'}`}
                    >
                      {skill.id} <span className="opacity-60">{skill.tier}</span>
                      {!skill.enabled && <span className="opacity-70"> · off here</span>}
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
          <Empty>
            No residents yet. Describe one to COGNOS with “Design with COGNOS”, or fill in the form yourself —
            then give it a goal to work on.
          </Empty>
        )}

        <div className="space-y-2">
          {rows.map(resident => (
            <div key={resident.id} className="orbit-agent-card rounded-lg border border-border">
              <div className="flex items-start gap-3 px-3 py-2.5">
                <Bot className="w-4 h-4 text-accent mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="orbit-agent-name min-w-0 flex-1 truncate">{resident.name}</span>
                    <Pill tone={resident.enabled ? 'ok' : 'muted'}>{resident.enabled ? 'enabled' : 'disabled'}</Pill>
                    <Pill tone="muted">brief v{resident.brief_version}</Pill>
                  </div>
                  {resident.purpose && (
                    <button
                      onClick={() => setExpandedPurpose(expandedPurpose === resident.id ? null : resident.id)}
                      className="block w-full text-left mt-0.5 cursor-pointer"
                      title={expandedPurpose === resident.id ? 'Tap to collapse' : 'Tap to read the full description'}
                    >
                      <span className={`text-sm text-muted-foreground ${expandedPurpose === resident.id ? '' : 'truncate'} block`}>
                        {resident.purpose}
                      </span>
                    </button>
                  )}
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {(resident.skill_allowlist || []).map(id => {
                      const skill = skills.find(s => s.id === id);
                      return (
                        <span
                          key={id}
                          className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground"
                          title={skill ? `${skill.summary} — ${tierLabel(skill.tier)}` : id}
                        >
                          {id}
                        </span>
                      );
                    })}
                    {(resident.skill_allowlist || []).length === 0 && (
                      <span className="text-[10px] text-muted-foreground/70">no skills allowed yet</span>
                    )}
                  </div>
                  {/* Phase 36 — per-resident tool assignment, by tap. */}
                  <ResidentToolPicker resident={resident} onChanged={refresh} />
                  <ToolRunHistory residentId={resident.id} limit={3} />
                  {resident.brief && (
                    <p className="text-[10px] text-muted-foreground/70 mt-1.5 line-clamp-2 whitespace-pre-wrap">
                      {resident.brief}
                    </p>
                  )}
                </div>
                {resident.conversation_id && <button
                  onClick={() => { window.location.href = `/?c=${resident.conversation_id}`; }}
                  className="shrink-0 p-1.5 rounded-lg text-muted-foreground hover:text-primary hover:bg-muted"
                  title="Converse with this resident"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                </button>}
                {/* Phase 34 — Talk: per-resident chat over the resident's state.
                    Preferences become conversations here. */}
                <button
                  onClick={() => setChatResident(resident)}
                  className="shrink-0 px-2 py-1.5 rounded-lg text-xs font-medium text-primary hover:bg-muted"
                  title={`Talk with ${resident.name}`}
                >
                  Talk
                </button>
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
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleBrief(resident)} disabled={busy}
                      className="rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs disabled:opacity-40">
                      Save as version {resident.brief_version + 1}
                    </button>
                    <button onClick={() => handleDelete(resident)} disabled={busy}
                      className="rounded-lg border border-destructive/40 text-destructive px-3 py-1.5 text-xs disabled:opacity-40 hover:bg-destructive/10">
                      <Trash2 className="w-3 h-3 inline mr-1" />Delete resident
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>
      {/* Phase 34 — per-resident chat drawer. */}
      {chatResident && (
        <ResidentChatDrawer
          open={!!chatResident}
          resident={chatResident}
          onClose={() => setChatResident(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------- goals
/** The webhook destinations a scope grants, in plain words for the barrier. */
function destinationsInScope(scope) {
  const out = [];
  for (const entry of Array.isArray(scope?.effectsAllowed) ? scope.effectsAllowed : []) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && Array.isArray(entry.destinations)) {
      out.push(...entry.destinations.filter(d => typeof d === 'string' && d.trim()));
    }
  }
  return out;
}

/** Small multi-value editor for destinations a grant will carry. */
function DestinationEditor({ destinations, input, onInput, onAdd, onRemove, hint }) {
  const add = () => {
    const url = input.trim().replace(/[),.;]+$/g, '');
    if (!url || destinations.includes(url)) { onInput(''); return; }
    onAdd(url); onInput('');
  };
  return (
    <div className="rounded-lg border border-border/70 px-2.5 py-2 space-y-1.5">
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        <strong className="text-foreground">Webhook destinations (optional).</strong>{' '}
        https endpoints this first goal may POST a webhook to — part of the scope you authorize, locked in by its hash.
        Granting looks like nothing until the goal uses it: a write aimed anywhere else is refused, and only attempts
        aimed at a granted destination fill the evidence corpus. {hint}
      </p>
      {destinations.map(url => (
        <div key={url} className="flex items-center gap-2 text-[11px]">
          <Send className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="font-mono break-all flex-1">{url}</span>
          <button type="button" onClick={() => onRemove(url)} className="p-0.5 rounded text-muted-foreground hover:text-destructive" title="Remove">
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <input
          value={input}
          onChange={e => onInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="https://hooks.example.com/cognos"
          className="flex-1 bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs font-mono outline-none focus:border-primary/60"
        />
        <button type="button" onClick={add} disabled={!input.trim()}
          className="shrink-0 rounded-lg border border-border px-2 py-1.5 text-[11px] hover:bg-muted/50 disabled:opacity-40">
          Add
        </button>
      </div>
    </div>
  );
}

function Goals({ status, frozen, residents, onError, onChanged }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', objective: '', agent_id: '' });
  const [destinations, setDestinations] = useState([]);
  const [destInput, setDestInput] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [detail, setDetail] = useState({});
  const [editingGoal, setEditingGoal] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editObjective, setEditObjective] = useState('');
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try { setRows(await api.listGoals(filter ? { status: filter } : {})); }
    catch (e) { setError(e.message || 'Could not load goals'); }
    // Every decision re-reads the list, so this is also the moment the
    // "needs your attention" panel is out of date. Tell the page.
    onChanged?.();
  }, [filter, onChanged]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!expanded) return;
    setEditingGoal(false);
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

  const decidePromotion = async (promotionId, decision) => {
    setBusy(true); setError('');
    try {
      await api.decidePromotion(promotionId, { decision });
      if (expanded) {
        const d = await api.getGoal(expanded);
        setDetail(prev => ({ ...prev, [expanded]: d }));
      }
    } catch (err) {
      setError(err.message || 'The promotion decision failed');
    } finally { setBusy(false); }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (busy || !form.title.trim() || !form.objective.trim()) return;
    setBusy(true); setError('');
    try {
      // The destination grant is the key the goal's webhook scope is built
      // with: { effect: "webhook.post", destinations: [...] } in the scope the
      // operator authorizes. With no destinations named, send no scope at all
      // and the route's notify-only default stands, exactly as before.
      const body = {
        title: form.title.trim(),
        objective: form.objective.trim(),
        agent_id: form.agent_id || undefined,
      };
      if (destinations.length) {
        body.scope = { effectsAllowed: ['notify', { effect: 'webhook.post', destinations: [...destinations] }] };
      }
      await api.createGoal(body);
      setForm({ title: '', objective: '', agent_id: '' });
      setDestinations([]); setDestInput('');
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

      <div className="px-1 pt-1">
        <p className="orbit-eyebrow">Goals</p>
        <h2 className="orbit-page-title text-xl mt-1">What they're working toward.</h2>
        <p className="orbit-page-sub text-sm mt-1">Nothing runs until you say so.</p>
      </div>

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
              <option value="">Any state</option>
              {['awaiting_authorization', 'active', 'parked', 'completed', 'cancelled'].map(s => (
                <option key={s} value={s}>{goalStatusLabel(s)}</option>
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
            <DestinationEditor
              destinations={destinations}
              input={destInput}
              onInput={setDestInput}
              onAdd={url => setDestinations(prev => [...prev, url])}
              onRemove={url => setDestinations(prev => prev.filter(u => u !== url))}
              hint={status?.liveDestination?.configured
                ? `This deployment's approved live destination is ${status.liveDestination.hostname} — a live delivery can only ever go there.`
                : 'No approved live destination is set here, so a live flip is not available.'}
            />
            <p className="text-[10px] text-muted-foreground">
              The goal is created <strong>waiting for you</strong> (<span className="font-mono">awaiting_authorization</span>).
              Nothing runs until you authorize it.
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
                      <Pill tone={GOAL_TONE[goal.status] || 'muted'}>{goalStatusLabel(goal.status)}</Pill>
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {GOAL_STATUS_HELP[goal.status] || ''}
                      {goal.park_reason ? ` ${parkReasonLabel(goal.park_reason)}.` : ''}
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
                        <p className="text-sm text-muted-foreground whitespace-pre-wrap">{d.goal.objective}</p>

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
                                {destinationsInScope(d.goal.scope).length > 0 && (
                                  <p className="mb-1 text-foreground/80 leading-relaxed">
                                    May POST a webhook to:{' '}
                                    <span className="font-mono break-all">{destinationsInScope(d.goal.scope).join('; ')}</span>
                                    {' '}— granted here, never widen-able afterwards.
                                  </p>
                                )}
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

                        {/* ---- edit: rename or re-aim. Title + objective only — the
                             scope and budget are the deal you authorized and are
                             never rewritten here. ---- */}
                        <div className="flex items-center gap-2">
                          {editingGoal ? (
                            <div className="flex-1 space-y-2 rounded-lg border border-border bg-background/60 p-2.5">
                              <input
                                autoFocus
                                value={editTitle}
                                onChange={e => setEditTitle(e.target.value)}
                                placeholder="Goal title"
                                className="w-full bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-primary/60"
                              />
                              <textarea
                                value={editObjective}
                                onChange={e => setEditObjective(e.target.value)}
                                placeholder="Objective — what would count as done?"
                                rows={3}
                                className="w-full bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-primary/60 resize-none"
                              />
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={async () => {
                                    if (busy || !editTitle.trim() || !editObjective.trim()) return;
                                    setBusy(true); setError('');
                                    try {
                                      const r = await api.updateGoal(goal.id, {
                                        title: editTitle.trim(),
                                        objective: editObjective.trim(),
                                      });
                                      setDetail(prev => ({ ...prev, [goal.id]: { ...prev[goal.id], goal: r.goal } }));
                                      setEditingGoal(false);
                                      await refresh();
                                    } catch (e) {
                                      setError(e?.message || 'Could not save the changes.');
                                    } finally {
                                      setBusy(false);
                                    }
                                  }}
                                  disabled={busy || !editTitle.trim() || !editObjective.trim()}
                                  className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-2.5 py-1.5 text-xs disabled:opacity-40"
                                >
                                  <Check className="w-3.5 h-3.5" /> Save
                                </button>
                                <button
                                  onClick={() => setEditingGoal(false)}
                                  disabled={busy}
                                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                                >
                                  <X className="w-3.5 h-3.5" /> Cancel
                                </button>
                              </div>
                              <p className="text-[10px] text-muted-foreground leading-relaxed">
                                Renaming never changes what the goal may do or spend — that was
                                settled when you authorized it.
                              </p>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                setEditTitle(goal.title || '');
                                setEditObjective(d?.goal?.objective || '');
                                setEditingGoal(true);
                              }}
                              disabled={busy}
                              className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
                            >
                              <Pencil className="w-3.5 h-3.5" /> Edit goal
                            </button>
                          )}
                        </div>

                        {/* ---- delete: any status. Notes orphan to the cleanup review queue. ---- */}
                        <div className="flex items-center gap-2">
                          <button
                            onClick={async () => {
                              if (busy) return;
                              const ok = window.confirm(
                                `Delete “${goal.title}”? Its notes will wait for your call in the cleanup review — everything else about it stays in the record.`
                              );
                              if (!ok) return;
                              setBusy(true); setError('');
                              try {
                                await api.deleteGoal(goal.id);
                                setExpanded(null);
                                await refresh();
                              } catch (e) {
                                setError(e?.message || 'Could not delete the goal.');
                              } finally {
                                setBusy(false);
                              }
                            }}
                            disabled={busy}
                            className="flex items-center gap-1.5 rounded-lg border border-destructive/40 px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-40">
                            <Trash2 className="w-3.5 h-3.5" /> Delete goal
                          </button>
                        </div>

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
                            onClick={() => d.goal.conversation_id && navigate(`/?c=${d.goal.conversation_id}&goal=${d.goal.id}`)}
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

                        {/* ---- workers and promotions (Phase 20) ---- */}
                        {(d.subagents?.length > 0 || d.promotions?.length > 0) && (
                          <div className="grid md:grid-cols-2 gap-3">
                            <div>
                              <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">
                                Workers — narrow subsets, carved budgets
                              </p>
                              {d.subagents?.length ? (
                                <ul className="space-y-1">
                                  {d.subagents.map(w => (
                                    <li key={w.id} className="rounded border border-border px-2 py-1.5 text-[10px]">
                                      <p className="text-foreground/90">{w.objective}</p>
                                      <p className="text-muted-foreground mt-0.5 font-mono">
                                        {(w.skills || []).join(', ') || '—'} · {Number(w.spent?.steps || 0)} steps · {fmtMoney(w.spent?.costUsd || 0)}
                                      </p>
                                      <Pill tone={w.status === 'completed' ? 'ok' : w.status === 'refused' || w.status === 'failed' ? 'bad' : 'muted'}>
                                        {w.status}
                                      </Pill>
                                    </li>
                                  ))}
                                </ul>
                              ) : <p className="text-[10px] text-muted-foreground">No workers spawned.</p>}
                            </div>
                            <div>
                              <p className="text-[10px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide">
                                Promotions — human confirm required
                              </p>
                              {d.promotions?.length ? (
                                <div className="space-y-1.5">
                                  {d.promotions.map(p => {
                                    const note = (d.notes || []).find(n => n.id === p.note_id);
                                    return (
                                      <PromotionRow
                                        key={p.id}
                                        promotion={{ ...p, goal_title: null, note_ordinal: note?.ordinal ?? null, note_body: note?.body || null }}
                                        busy={busy}
                                        onDecide={decidePromotion}
                                      />
                                    );
                                  })}
                                </div>
                              ) : <p className="text-[10px] text-muted-foreground">No promotion requests.</p>}
                            </div>
                          </div>
                        )}

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

// --------------------------------------------------------------- promotions
// Phase 20 — the human-confirm half of the promotion path. Approving applies
// the write the moment it lands (as inferred, with origin tags); refusing
// records the decision. Answer-carried applications appear here too, with
// decision_source answer_carried:<message>.
function PromotionRow({ promotion: p, busy, onDecide }) {
  const decided = p.status !== 'requested' && p.status !== 'approved';
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <p className="text-xs">
        {p.goal_title && <span className="font-medium">{p.goal_title} · </span>}
        <span className="font-mono text-[10px] text-primary">{p.note_ordinal != null ? `n${p.note_ordinal}` : shortId(p.note_id)}</span>
        {' '}→ {p.target}{' '}
        <Pill tone={p.status === 'applied' ? 'ok' : p.status === 'refused' ? 'bad' : 'muted'}>{p.status}</Pill>
      </p>
      {p.redacted ? (
        <p className="text-[11px] text-muted-foreground italic mt-1">Body withheld — refused as secret-bearing.</p>
      ) : p.note_body ? (
        <p className="text-[11px] text-foreground/80 mt-1">{p.note_body}</p>
      ) : null}
      <p className="text-[10px] text-muted-foreground mt-1 font-mono">
        {p.decision_source || 'awaiting decision'}{p.reason ? ` — ${p.reason}` : ''} · {fmtTime(p.created_date)}
      </p>
      {!decided && (
        <div className="flex items-center gap-2 mt-2">
          <button onClick={() => onDecide(p.id, 'approve')} disabled={busy}
            className="flex items-center gap-1 rounded-lg bg-accent text-accent-foreground px-2 py-1 text-[10px] font-medium disabled:opacity-40">
            <Check className="w-3 h-3" /> Approve &amp; apply
          </button>
          <button onClick={() => onDecide(p.id, 'refuse')} disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40">
            <X className="w-3 h-3" /> Refuse
          </button>
        </div>
      )}
      {p.status === 'applied' && (p.applied_memory_id || p.applied_belief_id) && (
        <p className="text-[10px] text-green-600 dark:text-green-400 mt-1 font-mono">
          landed as inferred → {p.applied_memory_id || p.applied_belief_id}
        </p>
      )}
    </div>
  );
}

function Promotions({ frozen, onChanged }) {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try { setRows(await api.listPromotions(filter ? { status: filter } : {})); }
    catch (e) { setError(e.message || 'Could not load promotions'); }
    onChanged?.();
  }, [filter, onChanged]);

  useEffect(() => { refresh(); }, [refresh]);

  const decide = async (id, decision) => {
    setBusy(true); setError('');
    try { await api.decidePromotion(id, { decision }); await refresh(); }
    catch (e) { setError(e.message || 'The decision failed'); }
    finally { setBusy(false); }
  };

  return (
    <Section
      title="Promotions"
      subtitle="The only route from a working note to memory — every application lands inferred with origin tags"
      icon={Sprout}
      action={
        <select
          value={filter} onChange={e => setFilter(e.target.value)}
          className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs outline-none"
        >
          <option value="">Any state</option>
          {['requested', 'approved', 'applied', 'refused'].map(s => (
            <option key={s} value={s}>
              {s === 'requested' ? 'Waiting for you' : s === 'applied' ? 'Added to knowledge' : s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      }
    >
      <ErrorNote error={error} />
      {frozen && <p className="text-[11px] text-muted-foreground mb-2">Autonomy is off — the queue is still visible, but deciding one needs it on.</p>}
      {rows.length === 0
        ? <Empty>No promotion requests. A worker asks with note.promote.request; you confirm here, or a Governor-approved answer carries a cited finding.</Empty>
        : (
          <div className="space-y-2">
            {rows.map(p => (
              <PromotionRow key={p.id} promotion={p} busy={busy || frozen} onDecide={decide} />
            ))}
          </div>
        )}
    </Section>
  );
}

// ------------------------------------------------------------------ cleanup
// Phase 33 — the cleanup agent's review queue. Exact duplicates tidy
// themselves (logged); everything here is a merge or a retirement that only
// Jeremy's approval can apply. Approving applies synchronously; refusing
// records the decision and stands.
const CLEANUP_KIND_LABEL = {
  near_duplicate: "Near-duplicates",
  redundant_key: "Same key, different content",
  subsumed: "Absorbed by a longer memory",
  fragment_merge: "Fragments to merge",
  stale_volatile: "Gone quiet",
  orphan_node: "Unconnected graph node",
  dead_end: "Dead-end graph corner",
  contradiction: "Graph contradiction",
  orphan_note: "Orphaned goal note"
};

function CleanupRow({ proposal: p, busy, onDecide }) {
  const decided = p.status !== 'requested';
  const detail = p.detail || {};
  const previewEntries = Object.entries(detail.previews || {});
  const labelEntries = Object.entries(detail.labels || {});
  return (
    <div className="rounded-lg border border-border px-3 py-2.5">
      <p className="text-xs">
        <span className="font-medium">{CLEANUP_KIND_LABEL[p.kind] || p.kind}</span>
        {' '}· <span className="text-muted-foreground">{p.title}</span>{' '}
        <Pill tone={p.status === 'applied' ? 'ok' : p.status === 'refused' ? 'bad' : 'muted'}>{p.status}</Pill>
      </p>
      {detail.similarity != null && (
        <p className="text-[10px] text-muted-foreground mt-1">Similarity {Math.round(detail.similarity * 100)}% — same thing said two ways.</p>
      )}
      {previewEntries.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {previewEntries.map(([id, text]) => (
            <p key={id} className="text-[11px] text-foreground/80 border-l-2 border-border pl-2">
              {id === detail.canonicalId ? <span className="font-medium">Keep: </span> : null}{text}
            </p>
          ))}
        </div>
      )}
      {labelEntries.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {labelEntries.map(([id, text]) => (
            <p key={id} className="text-[11px] text-foreground/80 border-l-2 border-border pl-2">{text}</p>
          ))}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground mt-1 font-mono">
        {p.store}{p.reason ? ` — ${p.reason}` : ''} · {fmtTime(p.created_date)}
      </p>
      {!decided && (
        <div className="flex items-center gap-2 mt-2">
          <button onClick={() => onDecide(p.id, 'approve')} disabled={busy}
            className="flex items-center gap-1 rounded-lg bg-accent text-accent-foreground px-2 py-1 text-[10px] font-medium disabled:opacity-40">
            <Check className="w-3 h-3" /> Approve &amp; tidy up
          </button>
          <button onClick={() => onDecide(p.id, 'refuse')} disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40">
            <X className="w-3 h-3" /> Leave it alone
          </button>
        </div>
      )}
    </div>
  );
}

function Cleanup({ frozen, onChanged }) {
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('requested');
  const [lastRun, setLastRun] = useState(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [proposals, summary] = await Promise.all([
        api.listCleanupProposals(filter ? { status: filter } : {}),
        api.getLastCleanupRun()
      ]);
      setRows(proposals || []);
      setLastRun(summary || null);
    }
    catch (e) { setError(e.message || 'Could not load the cleanup queue'); }
    onChanged?.();
  }, [filter, onChanged]);

  useEffect(() => { refresh(); }, [refresh]);

  const decide = async (id, decision) => {
    setBusy(true); setError('');
    try { await api.decideCleanupProposal(id, { decision }); await refresh(); }
    catch (e) { setError(e.message || 'The decision failed'); }
    finally { setBusy(false); }
  };

  const runNow = async () => {
    setRunning(true); setError('');
    try { await api.runCleanupAudit(); await refresh(); }
    catch (e) { setError(e.message || 'The housekeeping pass failed'); }
    finally { setRunning(false); }
  };

  const tidied = lastRun?.run?.tidied || {};
  const tidiedCount = Object.values(tidied).reduce((n, v) => n + (Number(v) || 0), 0);

  return (
    <Section
      title="Cleanup"
      subtitle="Housekeeping for everything I remember — duplicates and clutter get tidied automatically; anything real needs your call"
      icon={Sparkles}
      action={
        <div className="flex items-center gap-2">
          <select
            value={filter} onChange={e => setFilter(e.target.value)}
            className="bg-background border border-border rounded-lg px-2 py-1.5 text-xs outline-none"
          >
            {['requested', 'applied', 'refused', ''].map(s => (
              <option key={s} value={s}>
                {s === 'requested' ? 'Waiting for you' : s === '' ? 'Any state' : s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
          <button onClick={runNow} disabled={running || frozen}
            className="rounded-lg border border-border px-2 py-1.5 text-xs hover:bg-muted/50 disabled:opacity-40">
            {running ? 'Tidying…' : 'Run a pass now'}
          </button>
        </div>
      }
    >
      <ErrorNote error={error} />
      {frozen && <p className="text-[11px] text-muted-foreground mb-2">Autonomy is off — the queue is still visible, but running a pass or deciding one needs it on.</p>}
      {lastRun?.run ? (
        <p className="text-[11px] text-muted-foreground mb-3">
          Last pass {fmtTime(lastRun.run.finishedMs)} — tidied up {tidiedCount} {tidiedCount === 1 ? 'thing' : 'things'}
          {lastRun.openProposals ? `, ${lastRun.openProposals} waiting for your call` : ', everything else looks tidy'}.
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground mb-3">No housekeeping pass has run yet. The first one happens on its own within a day of autonomy being on.</p>
      )}
      {rows.length === 0
        ? <Empty>Nothing waiting for your call. Exact duplicates tidy themselves; merges and anything destructive show up here.</Empty>
        : (
          <div className="space-y-2">
            {rows.map(p => (
              <CleanupRow key={p.id} proposal={p} busy={busy || frozen} onDecide={decide} />
            ))}
          </div>
        )}
    </Section>
  );
}

// ------------------------------------------------------------------ notices
function ActivityTab() {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError('');
      const feed = await api.autonomyFeed({ limit: 50 });
      setItems(Array.isArray(feed) ? feed : feed.items || []);
    } catch (e) {
      setError(e?.message || 'Could not load the activity feed.');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="space-y-3">
      <div className="px-1 pt-1">
        <p className="orbit-eyebrow">Activity</p>
        <h2 className="orbit-page-title text-xl mt-1">A running story.</h2>
        <p className="orbit-page-sub text-sm mt-1">Every run, and how it got there.</p>
      </div>
    <Section title="Activity" subtitle="One running story — goals, actions, notices" icon={Activity}>
      {error && <p className="text-xs text-destructive mb-2">{error}</p>}
      {items.length === 0 && !error ? (
        <p className="text-xs text-muted-foreground py-6 text-center">
          Nothing yet. When goals run, actions stage, or notices arrive, they'll appear here as one story.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="rounded-lg border border-border/70 px-3 py-2.5">
              <p className="text-sm leading-relaxed">{item.text}</p>
              <p className="text-[10px] text-muted-foreground mt-1">
                {item.atMs ? new Date(item.atMs).toLocaleString() : ''}
                {item.severity === 'warning' ? ' · needs attention' : ''}
              </p>
            </div>
          ))}
        </div>
      )}
    </Section>
    </div>
  );
}

function Notices({ onChanged }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try { setRows(await api.listNotices()); }
    catch (e) { setError(e.message || 'Could not load notices'); }
    onChanged?.();
  }, [onChanged]);

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
                  <p className="text-sm">{notice.text || '—'}</p>
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

/**
 * A receipt is metadata: ids, statuses, counts, digests, header NAMES. There is
 * no response body in it to render, and that is the point — an endpoint that
 * echoes a credential back cannot write it into this row.
 */
function ReceiptLine({ receipt }) {
  const r = typeof receipt === 'string' ? (() => { try { return JSON.parse(receipt); } catch { return null; } })() : receipt;
  if (!r || typeof r !== 'object') return null;

  if (r.dryRun) {
    return (
      <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">
        dry run {r.built === false ? '· could not be built' : '· request built, nothing sent'}
        {r.request?.bodyBytes != null ? ` · ${r.request.bodyBytes} B` : ''}
        {r.signed ? ' · signed' : ''}
      </p>
    );
  }
  if (typeof r.status !== 'number' && !r.reversal) return null;

  const parts = [];
  if (typeof r.status === 'number') parts.push(`${r.status} ${r.statusText || ''}`.trim());
  if (r.accepted === false) parts.push('released, not accepted');
  if (typeof r.attempts === 'number' && r.attempts > 1) parts.push(`${r.attempts} attempts`);
  if (r.redirects) parts.push(`${r.redirects} redirect(s)`);
  if (typeof r.latencyMs === 'number') parts.push(`${r.latencyMs}ms`);
  if (typeof r.responseBytes === 'number') parts.push(`response ${r.responseBytes} B, digest only`);
  if (r.signed) parts.push('signed');
  if (r.reversal) parts.push(r.reversal.unsendable ? 'reversed · cannot be un-sent' : 'reversed');

  return (
    <p className={`text-[10px] mt-0.5 font-mono ${r.accepted === false || r.reversal?.unsendable ? 'text-yellow-500' : 'text-muted-foreground'}`}>
      {parts.join(' · ')}
    </p>
  );
}

// ------------------------------------------------------------------- outbox
/** The rungs, in plain words: what each one lets the loop reach for. Copy lives
 *  here so every surface that lists them cannot drift. Read-only — rungs are
 *  presented, never switched, from this UI. */
const RUNG_ROWS = [
  { key: 'residents', label: 'Residents (T2)',
    hint: 'Let goals live here as durable residents and report through notices.' },
  { key: 'search', label: 'Web search (T3)',
    hint: 'Let a query leave for a third-party search provider. Fetching stays governed by each goal\u2019s own URL allowlist.' },
  { key: 'inbound', label: 'Inbound',
    hint: 'Let the deployment receive work from outside rather than only reach for it.' },
];
// Phase 34: externalWrites and irreversible are gone — T4/T5 are allowed when
// built, no rung to climb. The trust is in the asking (Governor + approval).

function Outbox({ status, onChanged }) {
  const [data, setData] = useState(null);
  const [rungs, setRungs] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [flipping, setFlipping] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [outbox, rungList] = await Promise.all([
        api.listOutbox(),
        api.listRungs().catch(() => null),
      ]);
      setData(outbox); setRungs(rungList);
    } catch (e) { setError(e.message || 'Could not load the outbox'); }
    onChanged?.();
  }, [onChanged]);

  useEffect(() => { refresh(); }, [refresh]);

  const decide = async (id, decision) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api.decideEffect(id, { decision });
      await refresh();
    } catch (e) {
      // A refusal is an answer, not a broken button: the Governor says why.
      setError(e.message || `Could not ${decision} this effect`);
      await refresh();
    } finally { setBusy(false); }
  };

  /**
   * Widen or narrow the outbox mode. A widening to live is refused unless every
   * readiness condition holds — the conditions list below already renders them,
   * so the error only has to say that the flip did not happen and how many
   * things are outstanding. Narrowing is refused by nothing, so the way back to
   * shadow is always one click.
   */
  const flipMode = async (mode) => {
    setFlipping(true); setError(''); setNotice('');
    try {
      const out = await api.setOutboxMode(mode);
      setNotice(out?.note || `The outbox is now in ${out?.mode || mode} mode.`);
      await refresh();
    } catch (e) {
      const unmet = e?.body?.unmet || [];
      setError(unmet.length
        ? `Not live yet — ${unmet.length} thing(s) still unmet, each named below. Nothing was written.`
        : (e?.message || 'Could not change the outbox mode'));
      await refresh();
    } finally { setFlipping(false); }
  };

  const effects = data?.effects || [];
  const corpus = data?.corpus;
  const writes = status?.externalWrites || {};
  // Phase 22 (autonomy row): the readiness report. Eight named conditions, each
  // with a sentence to read when it is unmet, so the answer to "what would going
  // live take?" is on the page before the click rather than in a 409 after it.
  const live = rungs?.live || null;
  const mode = status?.outboxMode || 'shadow';
  const destination = live?.destination || status?.liveDestination || {};

  return (
    <div className="space-y-3">
      <ErrorNote error={error} />
      {notice && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] leading-relaxed">
          {notice}
        </div>
      )}

      <Section
        title="External writes"
        subtitle="What the outbox may send, and where it stands"
        icon={Send}
      >
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          <Pill tone={writes.built ? 'info' : 'muted'}>{writes.built ? 'T4 built' : 'T4 not built'}</Pill>
          <Pill tone={writes.deliversNow ? 'bad' : 'info'}>outbox {outboxModeLabel(status?.outboxMode || 'shadow')}</Pill>
          {/* Two facts, because they are two facts. `deliversNow` answers "does
              the LOOP perform a release verdict?" — and an operator's Approve on
              a staged row is a live decision whatever the loop's mode is, so a
              shadow deployment that said only "delivers nothing" was describing
              a system that could still send. */}
          <Pill tone={writes.deliversNow ? 'bad' : (writes.deliversOnApproval ? 'warn' : 'ok')}>
            {writes.deliversNow
              ? 'the loop can deliver'
              : (writes.deliversOnApproval ? 'an approval can deliver' : 'delivers nothing')}
          </Pill>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[
            ['staged', corpus?.byTier?.T4 ?? 0, 'waiting for judgment'],
            ['would release', corpus?.wouldRelease ?? 0, 'judged, not sent'],
            ['refused', corpus?.refused ?? 0, 'rules named below'],
          ].map(([label, value, hint]) => (
            <div key={label} className="rounded-lg border border-border px-3 py-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
              <p className="text-lg font-semibold tabular-nums">
                {value}
              </p>
              <p className="text-[9px] text-muted-foreground/70">{hint}</p>
            </div>
          ))}
        </div>

        {(corpus?.byDestination && Object.keys(corpus.byDestination).length > 0) && (
          <div className="mt-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Where effects were aimed</p>
            <div className="space-y-1">
              {Object.entries(corpus.byDestination).slice(0, 8).map(([destination, n]) => (
                <p key={destination} className="text-[10px] font-mono truncate">
                  {destination} <span className="text-muted-foreground">×{n}</span>
                </p>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------------------------------------ going live
            Going live is a choice now, not an achievement: the readiness report
            below says what it takes, and the flip is one click when every
            condition holds. */}
        <div className="mt-3 rounded-lg border border-border/70 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Going live</p>
          <p className="text-[11px] mt-1 leading-relaxed">
            {live?.alreadyLive ? (
              <>The outbox is <span className="font-mono">live</span>: a release verdict is
                performed rather than only recorded — to one destination, and only for effects
                the Governor judges one at a time.</>
            ) : (
              <>The outbox is <span className="font-mono">{mode}</span>: verdicts are recorded
                and nothing is performed. Going live is your decision — every send is
                still judged, and still needs your approval.</>
            )}
          </p>

          <p className="text-[10px] mt-1.5 text-muted-foreground">
            Approved destination:{' '}
            {destination.configured ? (
              <span className="font-mono text-foreground/80">{destination.hostname}</span>
            ) : destination.misconfigured ? (
              <span className="text-yellow-500">set, but the adapter would refuse it — {destination.reason}</span>
            ) : (
              <span className="text-yellow-500">none, so no live delivery has anywhere it is allowed to go</span>
            )}
            <span className="text-muted-foreground/70">
              {' '}— a live write needs this AND the destination granted in the goal's own scope.
            </span>
          </p>

          {(live?.conditions || []).length > 0 && (
            <p className="text-[10px] mt-2 text-muted-foreground">
              {/* The server reports both counts, so this is a summary of what the
                  list below already says one line at a time — not a second
                  opinion computed here. */}
              {live.met} of {live.total} conditions met
              {live.ready ? ' — the flip will be accepted.' : ` — ${live.unmet.length} still unmet, each named below.`}
            </p>
          )}
          {(live?.conditions || []).length > 0 && (
            <ul className="mt-1 space-y-1">
              {live.conditions.map(c => (
                <li key={c.id} className="text-[10px] flex items-start gap-1.5">
                  {c.met
                    ? <Check className="w-3 h-3 mt-0.5 shrink-0 text-green-500" />
                    : <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-yellow-500" />}
                  <span className={c.met ? 'text-muted-foreground' : 'text-foreground/80'}>
                    {c.label}
                    {!c.met && c.sentence && (
                      <span className="text-muted-foreground"> — {c.sentence}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            {live?.alreadyLive ? (
              <button onClick={() => flipMode('shadow')} disabled={flipping || !status?.canSetOutboxMode}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] hover:bg-muted/50 disabled:opacity-40"
                title="Narrowing needs no evidence. The brake is always one click.">
                <Undo2 className={`w-3.5 h-3.5 ${flipping ? 'animate-pulse' : ''}`} /> Back to shadow
              </button>
            ) : (
              <button onClick={() => flipMode('live')}
                disabled={flipping || live?.ready !== true || status?.canSetOutboxMode === false}
                className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-2.5 py-1.5 text-[11px] disabled:opacity-40"
                title={live?.ready
                  ? 'Every condition is met. A release verdict will now be performed.'
                  : 'Not yet — every unmet condition is named above'}>
                <Zap className={`w-3.5 h-3.5 ${flipping ? 'animate-pulse' : ''}`} /> Go live
              </button>
            )}
            <p className="text-[10px] text-muted-foreground max-w-md leading-relaxed">
              {status?.canSetOutboxMode === false
                ? `This deployment has not handed the mode switch to this page (${status?.outboxRefusal?.message || 'set COGNOS_AUTONOMY_OUTBOX_UI_CONTROL=true'}).`
                : 'Going live waits until every condition below is met. Going back to shadow never waits.'}
            </p>
          </div>
        </div>
      </Section>

      <Section
        title="Actions waiting on you"
        subtitle="Staging is not acting. Each one is judged before anything happens, and nothing runs until you approve it."
        icon={ShieldCheck}
      >
        {effects.length === 0
          ? <Empty>Nothing is waiting. Actions appear here the moment a goal stages one — a notice to send, a page to read, or (with outside writes enabled) a webhook to call.</Empty>
          : (
            <div className="space-y-2">
              {effects.map(effect => {
                const verdict = effect.verdict || {};
                return (
                  <div key={effect.id} className="rounded-lg border border-border px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium flex items-center gap-2 flex-wrap">
                          <span>{effectStatusLabel(effect.status)}</span>
                          <Pill tone={EFFECT_TONE[effect.status] || 'muted'}>{effect.tier}</Pill>
                          <Pill tone={effect.mode === 'live' ? 'warn' : 'info'}>
                            {effect.mode === 'live' ? 'would really run' : 'shadow — delivers nothing'}
                          </Pill>
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-0.5 truncate" title={tierLabel(effect.tier)}>
                          {tierLabel(effect.tier)}
                        </p>
                        {/* The machine names stay one disclosure deep: whoever reads the logs needs them. */}
                        <details className="text-[10px] text-muted-foreground/70 mt-0.5">
                          <summary className="cursor-pointer select-none">Technical details</summary>
                          <p className="font-mono truncate mt-0.5">
                            {effect.effect_type} · {effect.status} · mode {effect.mode} · skill {effect.skill_id} ·
                            goal {shortId(effect.goal_id)} · key {shortId(effect.idempotency_key)}
                          </p>
                        </details>
                        {effect.destination && (
                          <p className="text-[10px] mt-0.5 font-mono truncate flex items-center gap-1">
                            <Send className="w-3 h-3 shrink-0 text-muted-foreground" />
                            <span className="text-foreground/80">{effect.destination}</span>
                          </p>
                        )}
                        <ReceiptLine receipt={effect.receipt} />
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5">{fmtTime(effect.created_date)}</p>
                      </div>
                      {effect.status === 'staged' && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button onClick={() => decide(effect.id, 'approve')} disabled={busy}
                            title={
                              effect.tier === 'T5'
                                ? 'Approve this exact irreversible effect. It releases one at a time, never by class, and only after the Action Governor also rules it safe.'
                                : 'Ask the Action Governor to release this effect'
                            }
                            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] disabled:opacity-40 bg-primary text-primary-foreground">
                            <ThumbsUp className="w-3 h-3" /> Approve
                          </button>
                          <button onClick={() => decide(effect.id, 'refuse')} disabled={busy}
                            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] hover:bg-muted/50 disabled:opacity-40">
                            <ThumbsDown className="w-3 h-3" /> Refuse
                          </button>
                        </div>
                      )}
                      {['released', 'refused', 'would_release', 'failed'].includes(effect.status) && (
                        <button onClick={() => decide(effect.id, 'revert')} disabled={busy}
                          title={effect.status === 'released' && effect.effect_type === 'external_write'
                            ? 'Record the reversal. A delivered webhook cannot be un-sent — the row will say so.'
                            : 'Record the reversal as a new transition; the original row stays'}
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
/**
 * Phase 31 — heartbeat personality switches. Three independent toggles, each
 * plainly described. Everything here is skippable: turning one off silences
 * that behavior entirely, and the loop itself never depends on any of them.
 */

function Overview({ status, residents, goals, onTick, ticking, onToggle, toggling, bannerError,
  attention, attentionLoading, onJump, onDesign, onSeedArchivist, seedingArchivist,
  onAutoAuthorize, autoAuthBusy }) {
  const ceilings = status?.ceilings || {};
  const counts = status?.counts || {};
  const skills = status?.skills || [];
  const tick = status?.tick || {};
  const frozen = status?.enabled !== true;

  return (
    <div className="space-y-3">
      <div className="px-1 pt-1">
        <p className="orbit-eyebrow">Overview</p>
        <h2 className="orbit-page-title text-xl mt-1">Everything your residents are up to.</h2>
        <p className="orbit-page-sub text-sm mt-1">One greeting, the whole story.</p>
      </div>
      <StatusBanner
        status={status}
        busy={toggling}
        onToggle={onToggle}
        onError={bannerError ? (
          <p className="mt-2.5 text-[11px] text-destructive flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span>{bannerError}</span>
          </p>
        ) : null}
      />

      {/* Phase 34 — preferences become conversations. Greeting, dream journal,
          and check-ins are configured by talking to a resident, not by
          switches. The chat understands "stop saying good morning" and
          friends. */}
      <Section title="Daily rhythms" subtitle="Morning greetings, dreams, check-ins — just ask" icon={MessageCircle}>
        <p className="text-sm text-muted-foreground leading-relaxed">
          These aren't switches anymore. Open any resident's chat and say what you
          want — <span className="text-foreground">"stop saying good morning"</span>,{" "}
          <span className="text-foreground">"start the dreams again"</span>,{" "}
          <span className="text-foreground">"turn check-ins off"</span> — and it's done.
        </p>
      </Section>

      {/* Phase 26 — forgo goal authorization. A delegated switch, reported as its
          own three facts (on / pinned / may-I-change-it), so the toggle can
          explain itself instead of lying. */}
      <Section title="Goal authorization" subtitle="Whether a new goal waits for you before it runs" icon={ShieldCheck}>
        <div className="rounded-lg border border-border/70 px-3 py-2.5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium flex items-center gap-2 flex-wrap">
                Auto-authorize new goals
                {status?.settings?.autoAuthorize
                  ? <Pill tone="warn">forgoing the consent click</Pill>
                  : <Pill tone="ok">you authorize each goal</Pill>}
                {status?.settings?.autoAuthorizePinned && <Pill tone="info">pinned by an operator</Pill>}
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                {status?.settings?.autoAuthorize
                  ? 'New goals start active when created — their scope and budget hashes are still recorded, the allowlist and ceilings still bind, and every staged effect still waits for its own approval.'
                  : 'A new goal is created waiting for you. It does no work until you authorize its scope and budget.'}
              </p>
            </div>
            <button
              role="switch"
              aria-checked={status?.settings?.autoAuthorize === true}
              aria-label="Auto-authorize new goals"
              disabled={!status?.settings?.canSetAutoAuthorize || autoAuthBusy}
              onClick={() => onAutoAuthorize(!status?.settings?.autoAuthorize)}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${status?.settings?.autoAuthorize ? 'bg-primary' : 'bg-muted-foreground/30'}`}
              title={status?.settings?.canSetAutoAuthorize
                ? (status?.settings?.autoAuthorize ? 'Turn auto-authorize off' : 'Turn auto-authorize on')
                : (status?.settings?.autoAuthorizeRefusal?.message || 'Auto-authorize is not delegated to this page')}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-background shadow transition-transform ${status?.settings?.autoAuthorize ? 'translate-x-5' : ''}`} />
            </button>
          </div>
          {!status?.settings?.canSetAutoAuthorize && (
            <p className="text-[10px] text-muted-foreground mt-1.5 leading-relaxed">
              {status?.settings?.autoAuthorizeRefusal?.message || 'This deployment has not handed the auto-authorize switch to this page.'}
            </p>
          )}
        </div>
      </Section>

      {/* Rungs are governance, presented — not switches to flip. What this
          deployment may reach for, in plain words. The sign-off lives with the
          operator; every effect still asks Jeremy. */}
      <Section title="Rungs" subtitle="What this deployment may reach for" icon={Lock}>
        <div className="space-y-2">
          {RUNG_ROWS.map(({ key, label, hint }) => {
            const on = status?.settings?.rungs?.[key] === true;
            const pinned = status?.settings?.rungPinned?.[key] === true;
            return (
              <div key={key} className="rounded-lg border border-border/70 px-3 py-2.5">
                <p className="text-xs font-medium flex items-center gap-2 flex-wrap">
                  {label}
                  {on ? <Pill tone="ok">available</Pill> : <Pill tone="muted">not available here</Pill>}
                  {pinned && <Pill tone="info">pinned by an operator</Pill>}
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{hint}</p>
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed max-w-2xl">
          A rung says a tier exists here. It never releases anything by itself —
          every effect is still judged, and irreversible ones still need your approval.
        </p>
      </Section>

      {/* What is waiting on you, above the numbers. The numbers are context; this is the question. */}
      <AttentionPanel data={attention} onJump={onJump} loading={attentionLoading} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          ['Residents', counts.residents ?? residents.length, Bot, 'text-accent'],
          ['Running goals', counts.activeGoals ?? 0, Activity, 'text-green-500'],
          ['Paused goals', counts.parkedGoals ?? 0, Pause, 'text-yellow-500'],
          ['Actions waiting', counts.stagedEffects ?? 0, ShieldCheck, 'text-primary'],
        ].map(([label, value, Icon, tone]) => (
          <div key={label} className="rounded-xl border border-border bg-card px-3 py-3">
            <Icon className={`w-3.5 h-3.5 ${tone} mb-1.5`} />
            <p className="text-xl font-semibold tabular-nums">{value}</p>
            <p className="text-[10px] text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      <Section title="Start here" subtitle="The two things worth doing first on this page" icon={Sparkles}>
        <div className="grid sm:grid-cols-2 gap-2">
          <button
            onClick={onDesign}
            className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5 text-left hover:bg-primary/10 transition-colors"
          >
            <p className="text-xs font-semibold flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-primary" /> Design a resident by describing it
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
              Say what you want watched and how often. COGNOS drafts the name, brief, skills, budget and a first
              goal — you review all of it, and nothing is created until you click.
            </p>
          </button>
          <button
            onClick={onSeedArchivist}
            disabled={frozen || seedingArchivist}
            title={frozen ? 'Autonomy is off — turn it on first' : 'Create the Archivist. Its first goal waits for you.'}
            className="rounded-lg border border-border px-3 py-2.5 text-left hover:bg-muted/50 transition-colors disabled:opacity-40"
          >
            <p className="text-xs font-semibold flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5 text-accent" /> {seedingArchivist ? 'Creating the Archivist…' : 'Try the Archivist'}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
              A monitor that records how beliefs change. It is created, not authorized — nothing runs until you
              say so on the Goals tab.
            </p>
          </button>
        </div>
      </Section>

      <div className="grid md:grid-cols-2 gap-3">
        <Section title="Spending limits" subtitle="Hitting one pauses the goal and tells you why — it is never silently queued" icon={Gauge}>
          <div className="space-y-3">
            <Meter label="Workspace spend today" used={0} limit={ceilings.maxCostPerDayUsd ?? 0} suffix="" />
            <div className="grid grid-cols-2 gap-3 text-[10px]">
              <div><p className="text-muted-foreground">Per day</p><p className="font-medium tabular-nums">{fmtMoney(ceilings.maxCostPerDayUsd)}</p></div>
              <div><p className="text-muted-foreground">Per month</p><p className="font-medium tabular-nums">{fmtMoney(ceilings.maxCostPerMonthUsd)}</p></div>
              <div><p className="text-muted-foreground">Goals at once</p><p className="font-medium tabular-nums">{ceilings.maxActiveGoals}</p></div>
              <div><p className="text-muted-foreground">Notices per day</p><p className="font-medium tabular-nums">{ceilings.maxNoticesPerDay}</p></div>
            </div>
          </div>
        </Section>

        <Section title="How often it wakes" subtitle="One bounded slice per wake-up; a lease makes two workers impossible" icon={RefreshCw}>
          <div className="grid grid-cols-2 gap-3 text-[10px]">
            <div><p className="text-muted-foreground">Wakes every</p><p className="font-medium">{humanInterval(tick.intervalMs)}</p></div>
            <div><p className="text-muted-foreground">Work per wake-up</p><p className="font-medium tabular-nums">up to {tick.maxStepsPerTick} steps</p></div>
            <div><p className="text-muted-foreground">Longest slice</p><p className="font-medium tabular-nums">{fmtMs(tick.sliceMs)}</p></div>
            <div><p className="text-muted-foreground">Pauses after</p><p className="font-medium tabular-nums">{tick.maxConsecutiveFailures} failures</p></div>
            <div className="col-span-2">
              <p className="text-muted-foreground">Reports to you</p>
              <p className="font-medium">
                {status?.notices?.mode === 'none'
                  ? (status?.enabled
                    ? 'nowhere — the notice channel is set to none'
                    : 'nowhere yet — turn autonomy on and notices go to the in-app channel unless you set none')
                  : `through the ${status?.notices?.mode || '—'} channel`}
              </p>
            </div>
          </div>
          <button onClick={onTick} disabled={ticking || frozen}
            className="mt-3 flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs disabled:opacity-40"
            title={frozen ? 'Autonomy is off' : 'Run one bounded slice now'}>
            <RefreshCw className={`w-3.5 h-3.5 ${ticking ? 'animate-spin' : ''}`} /> Run a slice now
          </button>
          <details className="mt-2.5 text-[10px] text-muted-foreground">
            <summary className="cursor-pointer select-none">Technical details</summary>
            <div className="grid grid-cols-2 gap-x-2 gap-y-1 mt-1.5 font-mono">
              <span>intervalMs: {fmtMs(tick.intervalMs)}</span>
              <span>sliceMs: {fmtMs(tick.sliceMs)}</span>
              <span>leaseMs: {fmtMs(tick.leaseMs)}</span>
              <span>jitterMs: {fmtMs(tick.jitterMs)}</span>
              <span>outboxMode: {status?.outboxMode || 'shadow'}</span>
              <span>backoffMs: {fmtMs(tick.stepBackoffMs)}</span>
            </div>
          </details>
        </Section>
      </div>

      <Section
        title="What residents can do"
        subtitle="Skills live in code, not in a table. No brief, no draft and no database row can add one."
        icon={Zap}
      >
        <div className="space-y-1.5">
          {skills.map(skill => (
            <div key={skill.id} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{skill.summary}</p>
                <p className="text-[10px] text-muted-foreground/80 mt-0.5">{tierLabel(skill.tier)}</p>
              </div>
              <Pill tone={skill.enabled ? 'ok' : 'muted'}>{skill.enabled ? 'available' : 'not available here'}</Pill>
            </div>
          ))}
        </div>
        {/* The machine vocabulary is demoted, not deleted: whoever reads the logs
            needs the same tokens the code and the audit trail use. */}
        <details className="mt-2.5 rounded-lg border border-border/60 px-3 py-2">
          <summary className="text-[11px] text-muted-foreground cursor-pointer select-none">
            Technical details — skill ids, tiers and kill switches
          </summary>
          <div className="mt-2 space-y-1">
            {skills.map(skill => (
              <p key={skill.id} className="text-[10px] font-mono text-muted-foreground/80 flex flex-wrap gap-x-2">
                <span className="text-foreground/80">{skill.id}</span>
                <span>{skill.tier}</span>
                <span>kill switch: {skill.killSwitch}</span>
                {skill.requiresRung ? <span>needs rung: {skill.requiresRung}</span> : null}
                <span>{skill.enabled ? 'enabled' : 'off'}</span>
              </p>
            ))}
            {status?.noticeTemplates?.length > 0 && (
              <p className="text-[10px] text-muted-foreground pt-1">
                Notice templates: <span className="font-mono">{status.noticeTemplates.join(', ')}</span> —
                a model cannot write free text into a notice.
              </p>
            )}
            <p className="text-[10px] text-muted-foreground pt-1">
              Built tiers: <span className="font-mono">{(status?.builtTiers || []).join(', ') || '—'}</span>.
              Tiers in words: {Object.entries(TIER_LABEL).map(([t, l]) => `${t} ${l}`).join(' · ')}.
              T5 is built and default-off: it releases only by your approval of that exact action, one at a time, never by class.
            </p>
          </div>
        </details>
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
  const [attention, setAttention] = useState(null);
  const [attentionLoading, setAttentionLoading] = useState(true);
  const [ticking, setTicking] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [autoAuthBusy, setAutoAuthBusy] = useState(false);
  const [error, setError] = useState('');
  const [bannerError, setBannerError] = useState('');
  const [designerOpen, setDesignerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [seedingArchivist, setSeedingArchivist] = useState(false);
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

  const refreshAttention = useCallback(async () => {
    setAttentionLoading(true);
    try { setAttention(await api.autonomyAttention()); }
    catch { setAttention(null); }
    finally { setAttentionLoading(false); }
  }, []);

  useEffect(() => { refreshAll(); refreshAttention(); }, [refreshAll, refreshAttention]);

  const frozen = status?.enabled !== true;

  const runTick = async () => {
    setTicking(true); setError('');
    try {
      const result = await api.runTick();
      if (result?.frozen) setError('Autonomy is off — nothing ran.');
      await refreshAll();
      forceRefresh(n => n + 1);
    } catch (e) {
      setError(e.message || 'The tick failed');
    } finally { setTicking(false); }
  };

  /**
   * THE SWITCH. Only rendered when an operator delegated it, and the server is
   * the thing that decides — a pin answers 409 with the reason, which is shown
   * here rather than swallowed. The toggle flips back to the truth on refusal
   * instead of staying where the click put it.
   */
  const handleToggle = async (next) => {
    if (toggling) return;
    setToggling(true); setBannerError('');
    try {
      const out = await api.setAutonomyEnabled(next);
      await Promise.all([refreshAll(), refreshAttention()]);
      setBannerError(out.changed === false
        ? `Autonomy was already ${out.enabled ? 'on' : 'off'}.`
        : '');
    } catch (e) {
      // Refusal or failure: re-read the truth so the switch cannot sit in a
      // position the server did not accept.
      setBannerError(e?.message || 'Could not change the switch.');
      await refreshAll();
    } finally { setToggling(false); }
  };

  /**
   * Phase 26 — forgo goal authorization. The server decides (a pin or no
   * delegation answers 409), and the toggle flips back to the truth on refusal
   * instead of staying where the click put it.
   */
  const handleAutoAuthorize = async (next) => {
    if (autoAuthBusy) return;
    setAutoAuthBusy(true); setBannerError('');
    try {
      const out = await api.setAutoAuthorize(next);
      await refreshAll();
      if (out.changed === false) {
        setBannerError(`Auto-authorize was already ${out.autoAuthorize ? 'on' : 'off'}.`);
      }
    } catch (e) {
      setBannerError(e?.message || 'Could not change auto-authorize.');
      await refreshAll();
    } finally { setAutoAuthBusy(false); }
  };

  /**
   * One click to a first resident. It CREATES; it does not authorize. The goal
   * lands awaiting_authorization and stays there until a decision on the Goals
   * tab records consent in goal_authorizations — which is why this ends by
   * taking you there rather than by reporting success.
   *
   * Idempotent at this layer: a second click finds the Archivist already there
   * instead of writing a duplicate resident or goal. The brief comes from the
   * same module the seed script uses, so the two cannot drift.
   */
  const seedArchivist = async () => {
    if (seedingArchivist || frozen) return;
    setSeedingArchivist(true); setError('');
    try {
      let resident = residents.find(r => r.slug === ARCHIVIST.slug);
      if (!resident) {
        resident = await api.createResident({
          name: ARCHIVIST.name,
          slug: ARCHIVIST.slug,
          purpose: ARCHIVIST.purpose,
          brief: ARCHIVIST.brief,
          skill_allowlist: ARCHIVIST.skill_allowlist,
          heartbeat_interval_ms: ARCHIVIST.heartbeat_interval_ms,
          enabled: ARCHIVIST.enabled,
        });
      }

      const existing = await api.listGoals().catch(() => []);
      const already = existing.find(
        g => g.title === ARCHIVIST.goalTitle && g.agent_id === resident?.id
      );
      if (!already) {
        await api.createGoal({
          title: ARCHIVIST.goalTitle,
          objective: ARCHIVIST.goalObjective,
          agent_id: resident?.id,
        });
      }

      await Promise.all([refreshAll(), refreshAttention()]);
      // The thing worth looking at is the goal waiting on you, not this page.
      setTab('goals');
    } catch (e) {
      // A refusal here is usually "autonomy is off" or a brief that exceeded a
      // ceiling; both arrive with their own words, so pass them through.
      setError(e?.message || 'Could not create the Archivist');
      await refreshAll().catch(() => {});
    } finally { setSeedingArchivist(false); }
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
        <h2 className="orbit-page-title text-base">Studio</h2>
        <span className="text-[10px] text-muted-foreground hidden sm:inline">
          your team, their work, and everything waiting on you
        </span>
        <button
          onClick={() => setHelpOpen(true)}
          className="ml-auto p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
          title="What do these words mean?"
          aria-label="Open the glossary"
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setDesignerOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium"
          title="Describe a resident in plain words and COGNOS drafts it"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Design with COGNOS</span>
        </button>
        <button
          onClick={() => { refreshAll(); refreshAttention(); }}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted"
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
            <Overview
              status={status} residents={residents} goals={goals}
              onTick={runTick} ticking={ticking}
              onToggle={handleToggle} toggling={toggling}
              bannerError={bannerError}
              attention={attention} attentionLoading={attentionLoading}
              onJump={setTab} onDesign={() => setDesignerOpen(true)}
              onSeedArchivist={seedArchivist} seedingArchivist={seedingArchivist}
              onAutoAuthorize={handleAutoAuthorize} autoAuthBusy={autoAuthBusy}
            />
          ) : tab === 'residents' ? (
            <Residents status={status} frozen={frozen} onDesign={() => setDesignerOpen(true)} onChanged={refreshAll} />
          ) : tab === 'tools' ? (
            <ToolsTab residents={residents} onChanged={refreshAll} />
          ) : tab === 'goals' ? (
            <Goals status={status} frozen={frozen} residents={residents} onChanged={refreshAttention} />
          ) : tab === 'activity' ? (
            <ActivityTab />
          ) : tab === 'notices' ? (
            <Notices onChanged={refreshAttention} />
          ) : tab === 'promotions' ? (
            <Promotions frozen={frozen} onChanged={refreshAttention} />
          ) : tab === 'cleanup' ? (
            <Cleanup frozen={frozen} onChanged={refreshAttention} />
          ) : (
            <Outbox status={status} onChanged={refreshAttention} />
          )}
        </div>
      </div>

      <DesignerDrawer
        open={designerOpen}
        onClose={() => setDesignerOpen(false)}
        status={status}
        onCreated={() => { refreshAll(); refreshAttention(); }}
        onEnabledChange={() => { refreshAll(); refreshAttention(); }}
      />
      <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
