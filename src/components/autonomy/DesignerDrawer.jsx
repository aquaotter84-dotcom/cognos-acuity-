// The conversational resident designer — Phase 25.
//
// Shared by the Autonomy page ("Design with COGNOS") and the chat header (the
// Bot button), so the way you describe a resident is the same wherever you start.
//
// What this drawer is: a conversation that ends in a DRAFT, and one explicit
// button that turns the draft into rows. What it is not: a second answer path.
// The text COGNOS writes here is a short design note about the draft in front of
// you — it never carries a goal's findings and never composes an answer to a
// question. That is still POST /api/chat, through the council and the Governor.
//
// Three things the UI is honest about, because the server enforces all three:
//   * a turn creates NOTHING — the draft is inert until you click Create;
//   * every skill that fell out of the allowlist is NAMED with its reason, so
//     what you authorize is what you read;
//   * a budget can only ever clamp down, and each reduction is reported.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, Bot, Check, ChevronDown, Loader2, Plus, Send, Snowflake,
  Sparkles, X, Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import { humanInterval, budgetLabel } from '@/lib/autonomyLabels';
import { ErrorNote, Pill } from '@/components/system/SystemUi';

const EMPTY_DRAFT = {
  name: '', slug: '', purpose: '', brief: '', skills: [],
  heartbeatMs: 900000, budget: null, firstGoal: null, proposedUrls: [], complete: false,
};

/** The opening line, so the drawer is never an empty box with a cursor in it. */
const GREETING = {
  role: 'assistant',
  content: 'Tell me what you want watched and how often, in plain words — "check the county agenda page each morning and tell me when a hearing is added" is exactly the right shape. I will draft the whole resident: its name, purpose, operating brief, the skills it may use, how often it wakes, its budget, and a first goal if you want one. Nothing is created until you click Create.',
};

function DraftField({ label, value, mono = false }) {
  if (!value) return null;
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`text-xs whitespace-pre-wrap ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

export default function DesignerDrawer({ open, onClose, onCreated, onEnabledChange, status: statusProp = null }) {
  const [messages, setMessages] = useState([GREETING]);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [adjustments, setAdjustments] = useState([]);
  const [dropped, setDropped] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState(statusProp);
  const [withGoal, setWithGoal] = useState(true);
  const [grantUrls, setGrantUrls] = useState([]);
  const [showDraft, setShowDraft] = useState(true);
  const [created, setCreated] = useState(null);
  const scrollRef = useRef(null);

  // The status tells the drawer whether Create can work yet. Take the caller's
  // copy when it has one (the Autonomy page always does) so the drawer never
  // disagrees with the banner behind it.
  useEffect(() => {
    if (statusProp) { setStatus(statusProp); return; }
    if (!open) return;
    let cancelled = false;
    api.autonomyStatus()
      .then(s => { if (!cancelled) setStatus(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, statusProp]);

  // A fresh conversation every time the drawer opens: a draft left over from
  // last Tuesday is a draft nobody remembers agreeing to.
  useEffect(() => {
    if (!open) return;
    setMessages([GREETING]);
    setDraft(EMPTY_DRAFT);
    setAdjustments([]); setDropped([]);
    setInput(''); setError(''); setNotice(''); setCreated(null);
    setWithGoal(true);
    setGrantUrls([]);
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true); setError(''); setNotice('');
    // The transcript the server sees: what the operator said, and what COGNOS
    // said about the draft. Bounded server-side, so a long refinement session
    // cannot grow the prompt without limit.
    const transcript = [...messages.filter(m => m.content && m.role !== 'system'), { role: 'user', content: text }]
      .map(m => ({ role: m.role, content: m.content }));
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    try {
      const out = await api.designResident({
        messages: transcript,
        draft: draft.complete || draft.name ? draft : null,
      });
      const nextDraft = out.draft || EMPTY_DRAFT;
      setDraft(nextDraft);
      setGrantUrls(prev => {
        const proposed = Array.isArray(nextDraft.proposedUrls) ? nextDraft.proposedUrls : [];
        const previouslyProposed = Array.isArray(draft.proposedUrls) ? draft.proposedUrls : [];
        const kept = prev.filter(url => proposed.includes(url));
        const newlyProposed = proposed.filter(url => !previouslyProposed.includes(url));
        return [...new Set([...kept, ...newlyProposed])];
      });
      setAdjustments(out.adjustments || []);
      setDropped(out.droppedSkills || []);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: out.reply || 'Draft updated.',
        questions: out.questions || [],
      }]);
      if (out.frozen) setNotice(out.note || '');
    } catch (e) {
      // The server answers a designer failure with a sentence, not a stack
      // trace, and the draft it echoes back is the one we already had — so a
      // failed turn costs nothing but the message. The user bubble is already
      // on screen; mark it failed rather than appending a second copy.
      setError(e?.message || 'The designer could not produce a draft.');
      setMessages(prev => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === 'user' && next[i].content === text && !next[i].failed) {
            next[i] = { ...next[i], failed: true };
            break;
          }
        }
        return next;
      });
      if (e?.body?.draft) setDraft(e.body.draft);
    } finally {
      setBusy(false);
    }
  }, [input, busy, messages, draft]);

  const create = useCallback(async () => {
    if (creating || !draft.complete) return;
    setCreating(true); setError(''); setNotice('');
    try {
      const out = await api.createDesignedResident({
        draft,
        create_first_goal: withGoal && Boolean(draft.firstGoal),
        grant_urls: grantUrls,
      });
      setCreated(out);
      setDropped(out.droppedSkills || []);
      setAdjustments(out.adjustments || []);
      onCreated?.(out);
    } catch (e) {
      setError(e?.message || 'Could not create the resident.');
      if (e?.body?.draft) setDraft(e.body.draft);
    } finally {
      setCreating(false);
    }
  }, [creating, draft, withGoal, grantUrls, onCreated]);

  /** Turn autonomy on from inside the drawer, when this deployment allows it. */
  const enableFromDrawer = useCallback(async () => {
    setCreating(true); setError('');
    try {
      const out = await api.setAutonomyEnabled(true);
      setStatus(prev => ({ ...(prev || {}), enabled: out.enabled, settings: out.settings, canToggleFromUi: out.settings?.canToggle }));
      setNotice('Autonomy is on. Your draft is unchanged — create it when you are ready.');
      // The Autonomy page is behind this drawer with its own copy of the status.
      // Tell it, or its banner keeps saying "off" while the switch says on.
      onEnabledChange?.();
    } catch (e) {
      setError(e?.message || 'Could not turn autonomy on.');
    } finally {
      setCreating(false);
    }
  }, []);

  if (!open) return null;

  const frozen = status ? status.enabled !== true : false;
  const canToggle = status?.canToggleFromUi === true;
  const budget = draft.budget || {};

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label="Design a resident">
      <button
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="Close the designer"
        tabIndex={-1}
      />
      <div className="relative flex flex-col w-full max-w-xl h-full bg-background border-l border-border shadow-2xl">
        {/* header */}
        <header className="flex items-start gap-2 px-4 py-3 border-b border-border shrink-0">
          <Sparkles className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold">Design a resident</h2>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Describe it in plain words. COGNOS drafts the whole thing; nothing is created until you say so.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted shrink-0" title="Close">
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* conversation */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-3 min-h-0">
          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                m.role === 'user'
                  ? 'bg-primary/10 text-foreground'
                  : 'bg-muted/50 text-foreground/90 border border-border/60'
              }`}>
                {m.role === 'assistant' && (
                  <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                    <Bot className="w-3 h-3" /> COGNOS · design note
                  </p>
                )}
                <p className="whitespace-pre-wrap">{m.content}</p>
                {m.failed && <p className="text-[10px] text-destructive mt-1">That turn failed — nothing changed.</p>}
                {m.questions?.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {m.questions.map((q, j) => (
                      <li key={j} className="text-[11px] text-muted-foreground flex gap-1.5">
                        <span className="text-primary">?</span><span>{q}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}

          {busy && (
            <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Drafting…
            </p>
          )}

          {/* the draft, so "what would I be creating" is always on screen */}
          {(draft.name || draft.brief || draft.skills.length > 0) && (
            <div className="rounded-xl border border-primary/30 bg-card overflow-hidden">
              <button
                onClick={() => setShowDraft(v => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40"
              >
                <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="text-xs font-semibold flex-1 min-w-0 truncate">
                  The draft {draft.name ? `— ${draft.name}` : ''}
                </span>
                <Pill tone={draft.complete ? 'ok' : 'warn'}>{draft.complete ? 'ready to create' : 'incomplete'}</Pill>
                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${showDraft ? 'rotate-180' : ''}`} />
              </button>

              {showDraft && (
                <div className="px-3 pb-3 space-y-2.5 border-t border-border/60 pt-2.5">
                  <DraftField label="Purpose" value={draft.purpose} />
                  <DraftField label="Brief — its operating instructions" value={draft.brief} />
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Wakes</p>
                      <p>{humanInterval(draft.heartbeatMs)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Slug</p>
                      <p className="font-mono text-[11px]">{draft.slug || '—'}</p>
                    </div>
                  </div>

                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Skills it may use</p>
                    <div className="flex flex-wrap gap-1">
                      {draft.skills.length === 0 && <span className="text-[11px] text-muted-foreground">none yet</span>}
                      {draft.skills.map(id => (
                        <span key={id} className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono">{id}</span>
                      ))}
                    </div>
                  </div>

                  {budget && Object.keys(budget).length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Budget ceilings</p>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                        {Object.entries(budget).slice(0, 8).map(([k, v]) => (
                          <span key={k} className="text-muted-foreground">
                            {budgetLabel(k)}: <span className="text-foreground tabular-nums">{k === 'maxCostUsd' ? `$${Number(v).toFixed(2)}` : Number(v).toLocaleString()}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {draft.firstGoal && (
                    <div className="rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">First goal — will wait for your authorization</p>
                      <p className="text-xs font-medium mt-0.5">{draft.firstGoal.title}</p>
                      <p className="text-[11px] text-muted-foreground line-clamp-3">{draft.firstGoal.objective}</p>
                    </div>
                  )}

                  {(draft.proposedUrls || []).length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                        Pages it may read — tick to grant at create
                      </p>
                      <p className="text-[10px] text-muted-foreground mb-1.5 leading-snug">
                        These are proposals. Nothing is allowlisted until you tick it and create, then authorize the goal.
                      </p>
                      <div className="space-y-1">
                        {draft.proposedUrls.map(url => {
                          const on = grantUrls.includes(url);
                          return (
                            <label key={url} className="flex items-start gap-2 text-[11px] cursor-pointer">
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => setGrantUrls(prev => (
                                  on ? prev.filter(u => u !== url) : [...prev, url]
                                ))}
                                className="accent-primary mt-0.5"
                              />
                              <span className="font-mono break-all">{url}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Everything that was corrected, out loud. */}
                  {dropped.length > 0 && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 space-y-1">
                      <p className="text-[10px] font-semibold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                        <AlertTriangle className="w-3 h-3" />
                        {dropped.length} skill{dropped.length === 1 ? '' : 's'} left out of the allowlist
                      </p>
                      {dropped.map((d, i) => (
                        <p key={i} className="text-[11px] text-muted-foreground leading-snug">
                          <span className="font-mono text-foreground/80">{d.id}</span> — {d.note}
                        </p>
                      ))}
                    </div>
                  )}
                  {adjustments.length > 0 && (
                    <details className="rounded-lg border border-border/60 px-2.5 py-1.5">
                      <summary className="text-[10px] text-muted-foreground cursor-pointer">
                        {adjustments.length} adjustment{adjustments.length === 1 ? '' : 's'} COGNOS made to the model's proposal
                      </summary>
                      <ul className="mt-1.5 space-y-1">
                        {adjustments.map((a, i) => (
                          <li key={i} className="text-[11px] text-muted-foreground leading-snug">
                            <span className="font-mono text-foreground/70">{a.field}</span> — {a.note}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          {created && (
            <div className="rounded-xl border border-green-500/40 bg-green-500/5 px-3 py-2.5">
              <p className="text-xs font-semibold text-green-600 dark:text-green-400 flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5" /> {created.note || 'Created.'}
              </p>
              {created.goal && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  “{created.goal.title}” is waiting for your authorization on the Goals tab. It does no work until you give it.
                </p>
              )}
            </div>
          )}

          {notice && !created && (
            <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground flex items-start gap-1.5">
              <Snowflake className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{notice}</span>
            </p>
          )}

          <ErrorNote error={error} />
        </div>

        {/* composer + the one button that writes */}
        <footer className="shrink-0 border-t border-border px-4 py-3 space-y-2 bg-background">
          {frozen && !created && (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
              <p className="text-[11px] text-muted-foreground leading-snug">
                <strong className="text-foreground">Autonomy is off.</strong> You can keep designing — creating is what waits.
                {canToggle
                  ? ' Turn it on below and the draft becomes a resident.'
                  : ' An operator has to enable it before a resident can be created.'}
              </p>
              {canToggle && (
                <button
                  onClick={enableFromDrawer}
                  disabled={creating}
                  className="mt-1.5 flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-2.5 py-1.5 text-xs font-medium disabled:opacity-40"
                >
                  <Zap className="w-3.5 h-3.5" /> Turn autonomy on
                </button>
              )}
            </div>
          )}

          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              rows={2}
              placeholder={draft.name ? 'Refine it — “make it hourly”, “drop the notice skill”, “call it Ledger”…' : 'What should this resident watch, and how often?'}
              className="flex-1 bg-muted/30 border border-border rounded-xl px-3 py-2 text-xs outline-none focus:border-primary/60 resize-none"
            />
            <button
              onClick={send}
              disabled={busy || !input.trim()}
              className="p-2.5 rounded-xl bg-primary text-primary-foreground disabled:opacity-40 shrink-0"
              title="Send to the designer"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>

          {!created && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={create}
                disabled={creating || busy || !draft.complete || frozen}
                className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-2 text-xs font-medium disabled:opacity-40"
                title={!draft.complete ? 'The draft needs a name first' : frozen ? 'Autonomy is off' : 'Create the resident'}
              >
                <Plus className="w-3.5 h-3.5" />
                {creating ? 'Creating…' : 'Create resident'}
              </button>
              {draft.firstGoal && (
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={withGoal}
                    onChange={e => setWithGoal(e.target.checked)}
                    className="accent-primary"
                  />
                  and its first goal <span className="opacity-70">(waits for authorization)</span>
                </label>
              )}
            </div>
          )}
          {created && (
            <button
              onClick={onClose}
              className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted"
            >
              Done
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
