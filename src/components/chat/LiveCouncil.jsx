// SANCTIONED UPGRADE — live council thinking.
//
// The original could only show a council trace AFTER the whole turn returned
// (CouncilTrace, rendered from the JSON response). This renders the same stages
// as they happen, driven by the SSE events from /api/chat. Once the turn is done
// this component is replaced by the original CouncilTrace, unchanged.

import { Brain, Check, Loader2, Search, ShieldCheck, AlertTriangle } from 'lucide-react';

const STAGE_LABELS = {
  agentPrepare: 'Agent — preparing bounded reads',
  contextAssembly: 'Assembling context',
  observer: 'Observer — perceiving',
  webSearch: 'Web search — pulling facts',
  strategist: 'Strategist — planning',
  specialist: 'Specialist — working',
  synthesizer: 'Synthesizer — integrating',
  critic: 'Critic — evaluating',
  governor: 'Governor — governing',
  memoryExtraction: 'Memory — extracting',
  auditLog: 'Audit — recording'
};

export default function LiveCouncil({ live }) {
  if (!live) return null;
  const { stages = [], classification, agent, webSearch, plan, critic, governor } = live;
  if (!stages.length) return null;

  return (
    <div className="mt-2 border border-border rounded-lg bg-muted/30 text-xs">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        <Brain className="w-3.5 h-3.5 text-accent" />
        <span className="font-medium text-muted-foreground">Council thinking</span>
      </div>
      <div className="px-3 py-2 space-y-1.5">
        {stages.map((s) => (
          <div key={s.stage} className="flex items-center gap-2">
            {s.status === 'running'
              ? <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0" />
              : s.status === 'error'
                ? <AlertTriangle className="w-3 h-3 text-destructive shrink-0" />
                : <Check className="w-3 h-3 text-green-400 shrink-0" />}
            <span className={s.status === 'running' ? 'text-foreground' : 'text-muted-foreground'}>
              {STAGE_LABELS[s.stage] || s.stage}
            </span>
            {s.ms != null && <span className="ml-auto tabular-nums text-muted-foreground/60">{(s.ms / 1000).toFixed(1)}s</span>}
          </div>
        ))}

        {agent && agent.mode !== 'off' && (
          <p className="text-muted-foreground/70 pt-1">
            agent: {agent.mode.replace('_', ' ')} · {agent.status} · {(agent.steps || []).filter(step => step.status === 'completed').length}/{(agent.steps || []).length} reads
          </p>
        )}
        {classification && (
          <p className="text-muted-foreground/70 pt-1">
            {classification.task_type} · {classification.complexity}
            {classification.intent ? ` · ${classification.intent}` : ''}
          </p>
        )}
        {webSearch?.query && (
          <p className="flex items-start gap-1.5 text-muted-foreground/70">
            <Search className="w-3 h-3 mt-0.5 shrink-0" /> {webSearch.query}
          </p>
        )}
        {plan && <p className="text-muted-foreground/70">plan: {plan}</p>}
        {critic && !critic.skipped && critic.score != null && (
          <p className="text-muted-foreground/70">critic: {critic.score}/10</p>
        )}
        {governor && (
          <p className="flex items-center gap-1.5 text-muted-foreground/70">
            <ShieldCheck className="w-3 h-3" /> {governor.approved ? 'approved' : `flagged: ${(governor.flags || []).join(', ')}`}
          </p>
        )}
      </div>
    </div>
  );
}
