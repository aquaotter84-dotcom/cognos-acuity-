// Phase 20 — the Goal Card: a goal's working state, inside chat.
//
// A goal never speaks for itself. This card shows what the loop has recorded —
// status, findings with their locators, narrow workers, open promotions — and
// hosts the two human barriers: authorize/decline (birth) and approve/refuse
// (promotion). Findings cite by locator ([goal_<tail>:nN]); the ONLY display
// grammar, matching server/autonomy/goalEvidence.js, which owns the parse.

import { useState } from 'react';
import { Bot, Check, ChevronDown, ChevronRight, ClipboardCheck, Sprout, ThumbsDown, ThumbsUp, X } from 'lucide-react';

/** The locator tail: the goal id minus its constant `goal_` prefix. */
export function goalTail(goalId) {
  return String(goalId || '').replace(/^goal_/, '');
}

/** Display-only locator for one note. Never parsed client-side. */
export function noteLocator(goalId, ordinal) {
  return `[goal_${goalTail(goalId)}:n${ordinal}]`;
}

const STATUS_TONE = {
  awaiting_authorization: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  active: 'bg-green-500/10 text-green-600 dark:text-green-400',
  parked: 'bg-muted text-muted-foreground',
  completed: 'bg-primary/10 text-primary',
  cancelled: 'bg-muted text-muted-foreground',
};

function Pill({ tone, children }) {
  return (
    <span className={`text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5 ${tone || 'bg-muted text-muted-foreground'}`}>
      {children}
    </span>
  );
}

export default function GoalCard({ detail, busy, error, carried, onDecision, onPromotion, onClear }) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(true);

  const goal = detail?.goal;
  if (!goal) return null;

  const findings = (detail.notes || []).filter(n => n.kind === 'finding');
  const openPromotions = (detail.promotions || []).filter(p => p.status === 'requested' || p.status === 'approved');
  const workers = detail.subagents || [];
  const scope = goal.scope || {};
  const budget = goal.budget || {};
  const spent = goal.spent || {};

  const promotionNote = (p) => (detail.notes || []).find(n => n.id === p.note_id) || null;

  return (
    <div className="max-w-3xl mx-auto rounded-2xl border border-primary/30 bg-card shadow-lg overflow-hidden">
      <div className="flex items-start gap-2 px-4 py-3 bg-primary/5 border-b border-border">
        <button onClick={() => setOpen(v => !v)} className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground" title={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold flex items-center gap-2 flex-wrap">
            <span className="truncate">{goal.title}</span>
            <Pill tone={STATUS_TONE[goal.status]}>{String(goal.status || '').replace(/_/g, ' ')}</Pill>
            {error && <span className="text-[10px] text-destructive font-normal">{error}</span>}
          </h3>
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {findings.length} finding{findings.length === 1 ? '' : 's'} · {workers.length} worker{workers.length === 1 ? '' : 's'} · {openPromotions.length} open promotion{openPromotions.length === 1 ? '' : 's'} ·{' '}
            {Number(spent.steps || 0)} steps{budget.maxSteps ? ` / ${budget.maxSteps}` : ''}
          </p>
        </div>
        {onClear && (
          <button onClick={onClear} className="shrink-0 p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted" title="Detach this goal from the chat">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {open && (
        <div className="px-4 py-3 space-y-3 max-h-96 overflow-y-auto">
          {carried?.applied?.length > 0 && (
            <p className="flex items-start gap-1.5 text-[11px] text-green-600 dark:text-green-400 bg-green-500/10 rounded-lg px-2.5 py-2">
              <Sprout className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                The last answer carried {carried.applied.length} finding{carried.applied.length === 1 ? '' : 's'} into memory
                ({carried.applied.map(a => `n${a.ordinal} → ${a.target}`).join(', ')}). They landed as <em>inferred</em>, never direct.
              </span>
            </p>
          )}

          {/* ---- THE BIRTH BARRIER ---- */}
          {goal.status === 'awaiting_authorization' && (
            <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
              <p className="text-xs font-semibold flex items-center gap-1.5">
                <ClipboardCheck className="w-3.5 h-3.5 text-accent" /> This goal is waiting for you
              </p>
              <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                Nothing runs until you authorize it. Authorizing records the hash of this scope and
                budget — the goal can never widen either without a new decision from you.
              </p>
              <div className="grid sm:grid-cols-2 gap-2 mt-2 text-[10px]">
                <div className="rounded bg-background/60 border border-border p-2">
                  <p className="text-muted-foreground mb-1">Scope</p>
                  <pre className="font-mono whitespace-pre-wrap break-all">{JSON.stringify(scope, null, 1)}</pre>
                </div>
                <div className="rounded bg-background/60 border border-border p-2">
                  <p className="text-muted-foreground mb-1">Budget</p>
                  <pre className="font-mono whitespace-pre-wrap break-all">{JSON.stringify(budget, null, 1)}</pre>
                </div>
              </div>
              {declining ? (
                <div className="flex items-center gap-2 mt-2.5">
                  <input
                    autoFocus value={reason} onChange={e => setReason(e.target.value)}
                    placeholder="Why not? (optional, recorded)"
                    className="flex-1 bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-primary/60"
                  />
                  <button onClick={() => { onDecision(goal.id, 'decline', { reason: reason.trim() || undefined }); setDeclining(false); setReason(''); }} disabled={busy}
                    className="rounded-lg bg-destructive text-destructive-foreground px-3 py-1.5 text-xs disabled:opacity-40">
                    Decline
                  </button>
                  <button onClick={() => { setDeclining(false); setReason(''); }}
                    className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2 mt-2.5">
                  <button onClick={() => onDecision(goal.id, 'authorize')} disabled={busy}
                    className="flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs disabled:opacity-40">
                    <ThumbsUp className="w-3.5 h-3.5" /> Authorize
                  </button>
                  <button onClick={() => setDeclining(true)} disabled={busy}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted/50 disabled:opacity-40">
                    <ThumbsDown className="w-3.5 h-3.5" /> Decline
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ---- findings, with locators ---- */}
          {findings.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
                Findings — cite by locator, never by paraphrase
              </p>
              <ul className="space-y-1">
                {findings.slice(0, 5).map(note => (
                  <li key={note.id} className="flex items-start gap-2 text-[11px] rounded-lg border border-border px-2.5 py-2">
                    <span className="font-mono text-[9px] text-primary mt-0.5 shrink-0">{noteLocator(goal.id, note.ordinal)}</span>
                    <span className="text-foreground/80 min-w-0">{note.body}</span>
                  </li>
                ))}
              </ul>
              {findings.length > 5 && (
                <p className="text-[10px] text-muted-foreground mt-1">+ {findings.length - 5} more on the Autonomy page.</p>
              )}
            </div>
          )}

          {/* ---- narrow workers ---- */}
          {workers.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
                Workers — narrow subsets, carved budgets
              </p>
              <ul className="space-y-1">
                {workers.map(w => (
                  <li key={w.id} className="flex items-center gap-2 text-[11px] rounded-lg border border-border px-2.5 py-1.5">
                    <Bot className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="truncate flex-1">{w.objective}</span>
                    <Pill tone={w.status === 'completed' ? STATUS_TONE.active : w.status === 'refused' ? STATUS_TONE.awaiting_authorization : undefined}>
                      {w.status}
                    </Pill>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ---- the promotion barrier ---- */}
          {openPromotions.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
                Open promotions — nothing applies without you or a citing answer
              </p>
              <ul className="space-y-1.5">
                {openPromotions.map(p => {
                  const note = promotionNote(p);
                  return (
                    <li key={p.id} className="rounded-lg border border-accent/30 px-2.5 py-2">
                      <p className="text-[11px]">
                        <span className="font-mono text-[9px] text-primary">{note ? noteLocator(goal.id, note.ordinal) : p.note_id}</span>
                        {' '}→ {p.target}
                        {note && <span className="text-muted-foreground"> · {note.body}</span>}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <button onClick={() => onPromotion(p.id, 'approve')} disabled={busy}
                          className="flex items-center gap-1 rounded-lg bg-accent text-accent-foreground px-2 py-1 text-[10px] font-medium disabled:opacity-40">
                          <Check className="w-3 h-3" /> Approve &amp; apply
                        </button>
                        <button onClick={() => onPromotion(p.id, 'refuse')} disabled={busy}
                          className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40">
                          <X className="w-3 h-3" /> Refuse
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
            Promoted findings land as <em>inferred</em> with origin tags — never as direct memories.
            Ask about this goal and the council answers through the Governor, citing locators.
          </p>
        </div>
      )}
    </div>
  );
}
