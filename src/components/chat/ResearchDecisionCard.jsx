// Phase 18 — the Governor of research is the user.
// A research plan never opens links by itself. This card is the recorded
// approval barrier: approving consents (per-step, by scope hash) to the exact
// public URLs the plan proposes; declining executes nothing. After either
// decision the run is finished — the next message continues from its evidence.

import { useState } from 'react';
import { AlertTriangle, Check, ClipboardCheck, ExternalLink, ShieldCheck, ThumbsDown, ThumbsUp } from 'lucide-react';

export default function ResearchDecisionCard({ runId, steps, busy, error, onApprove, onDecline }) {
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(false);

  const pending = (steps || []).filter(s => s.status === 'awaiting_approval' || s.status === 'approved');
  const urls = pending.map(s => (s.input || {}).url).filter(Boolean);
  const approvedCount = (steps || []).filter(s => s.requires_approval && s.status !== 'declined').length;

  return (
    <div className="max-w-3xl mx-auto rounded-2xl border border-accent/40 bg-card shadow-lg overflow-hidden">
      <div className="flex items-start gap-2 px-4 py-3 bg-accent/10 border-b border-accent/20">
        <ClipboardCheck className="w-4 h-4 text-accent mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            Research plan — awaiting your approval
            {error && <span className="text-[10px] text-destructive font-normal">{error}</span>}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            The researcher proposes {steps?.length || 0} read-only step{steps?.length === 1 ? '' : 's'}. Nothing runs until you approve, and it can never release an answer by itself.
          </p>
        </div>
      </div>

      <div className="px-4 py-2 space-y-1.5 max-h-56 overflow-y-auto">
        {(steps || []).map(step => {
          const input = step.input || {};
          const url = input.url || '';
          return (
            <div key={step.id || step.ordinal} className="flex items-start gap-2 rounded-lg border border-border px-2.5 py-2">
              <span className="text-[10px] font-bold text-muted-foreground mt-0.5 tabular-nums">{step.ordinal ?? '?'}</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-primary break-all flex items-center gap-1">
                  <ExternalLink className="w-3 h-3 shrink-0" /> {url || step.tool_name}
                </p>
                {input.reason && <p className="text-[11px] text-muted-foreground mt-0.5">{input.reason}</p>}
              </div>
              <span className="text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded px-1.5 py-0.5 shrink-0">
                {step.requires_approval ? 'Approval' : 'Read'}
              </span>
            </div>
          );
        })}
        {!steps?.length && <p className="text-xs text-muted-foreground py-2">No steps were proposed.</p>}
      </div>

      <div className="px-4 py-3 border-t border-border bg-muted/20">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-2.5">
          <ShieldCheck className="w-3.5 h-3.5 text-green-500 shrink-0" />
          <span className="leading-tight">
            Approving opens only the exact URLs listed above via the protected fetcher (SSRF checks, size and time limits, injection screening).
            {urls.length > 0 && ` You consent to ${approvedCount} recorded step${approvedCount === 1 ? '' : 's'}.`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            {declining ? (
              <input
                autoFocus
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Reason for declining (recorded, optional)"
                className="w-full bg-background border border-border rounded-lg px-2.5 py-1.5 text-xs outline-none focus:border-primary/60"
              />
            ) : <span />}
          </div>
          <button
            onClick={() => { if (declining) { onDecline(reason.trim() || 'No reason given'); return; } setDeclining(true); }}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 disabled:opacity-40"
          >
            {declining ? <Check className="w-3.5 h-3.5" /> : <ThumbsDown className="w-3.5 h-3.5" />}
            {declining ? 'Confirm decline' : 'Decline'}
          </button>
          <button
            onClick={() => { setDeclining(false); setReason(''); onApprove(); }}
            disabled={busy || !steps?.length}
            className="flex items-center gap-1.5 rounded-lg bg-accent text-accent-foreground px-3 py-1.5 text-xs font-medium disabled:opacity-40"
            title={busy ? 'Working…' : 'Approve the plan and run the listed steps'}
          >
            {busy ? (
              <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
            ) : <ThumbsUp className="w-3.5 h-3.5" />}
            Approve &amp; run
          </button>
        </div>
        {urls.length === 0 && !busy && (
          <p className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 mt-2">
            <AlertTriangle className="w-3 h-3" /> No public URLs in this plan — approving records consent and finishes the run without fetching.
          </p>
        )}
      </div>
    </div>
  );
}
