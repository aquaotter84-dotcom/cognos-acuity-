// The Ideas tab (Phase 37) — rule-based, evidence-linked suggestions, in the
// Studio's Orbit-face visual language: warm cards, friendly headings.
// An idea is a suggestion, never a nag: title, plain-language reason,
// evidence chips, and one-tap Accept (creates a durable task) or Dismiss.

import { useCallback, useEffect, useState } from 'react';
import {
  Lightbulb, Check, X, RefreshCw, Flag, Bot,
  FileText, Sparkles, CircleCheck
} from 'lucide-react';
import { api } from '@/lib/api';

/** Evidence kind -> small icon. */
const EVIDENCE_ICON = {
  goal: Flag,
  resident: Bot,
};

function evidenceLabel(ev) {
  if (ev.kind === 'goal') return ev.title || 'a goal';
  if (ev.kind === 'resident') return ev.name || 'a resident';
  return ev.title || ev.id || ev.kind;
}

function IdeaCard({ idea, busy, onAccept, onDismiss }) {
  const evidence = Array.isArray(idea.evidence) ? idea.evidence : [];
  return (
    <div className="rounded-xl border border-amber-200/70 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/20 overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-start gap-2.5">
          <Lightbulb className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold leading-snug">{idea.title}</h4>
            {idea.reason && (
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{idea.reason}</p>
            )}
            {evidence.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {evidence.map((ev, i) => {
                  const Icon = EVIDENCE_ICON[ev.kind] || FileText;
                  return (
                    <span
                      key={i}
                      className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground"
                      title={ev.id || ev.kind}
                    >
                      <Icon className="w-3 h-3" />
                      {evidenceLabel(ev)}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-amber-200/60 dark:border-amber-900/40 bg-card/60">
        <button
          onClick={() => onAccept(idea.id)}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50 transition-colors"
          title="Turn this idea into a real task"
        >
          <Check className="w-3.5 h-3.5" /> Accept
        </button>
        <button
          onClick={() => onDismiss(idea.id)}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50"
          title="No thanks — put this one away"
        >
          <X className="w-3.5 h-3.5" /> Dismiss
        </button>
        {idea.prompt && (
          <details className="ml-auto text-[10px] text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground">See the plan</summary>
            <p className="mt-1 whitespace-pre-wrap leading-relaxed">{idea.prompt}</p>
          </details>
        )}
      </div>
    </div>
  );
}

export default function IdeasTab() {
  const [ideas, setIdeas] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [lastNote, setLastNote] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const data = await api.listIdeas({ status: 'new' });
      setIdeas(data.ideas || []);
    } catch (e) {
      setError(e.message || 'Could not load ideas');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const data = await api.refreshIdeas();
      const n = data.created?.length ?? 0;
      setLastNote(
        n === 0
          ? 'Looked everything over — nothing new to suggest right now.'
          : n === 1
            ? 'Found one new idea for you.'
            : `Found ${n} new ideas for you.`
      );
      await load();
    } catch (e) {
      setError(e.message || 'Could not refresh ideas');
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const accept = useCallback(async (id) => {
    setBusyId(id);
    try {
      await api.acceptIdea(id);
      setLastNote('Done — that idea is now a task in the queue.');
      await load();
    } catch (e) {
      setError(e.message || 'Could not accept the idea');
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const dismiss = useCallback(async (id) => {
    setBusyId(id);
    try {
      await api.dismissIdea(id);
      await load();
    } catch (e) {
      setError(e.message || 'Could not dismiss the idea');
    } finally {
      setBusyId(null);
    }
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60">
          <Lightbulb className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <div className="flex-1 min-w-0">
            <h3 className="text-xs font-semibold">Ideas</h3>
            <p className="text-[10px] text-muted-foreground/70 leading-snug">
              Gentle suggestions from the loop — goals without a plan, residents without a job. Take one or leave it.
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 disabled:opacity-50"
            title="Look for new ideas"
          >
            <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Looking…' : 'Check for ideas'}
          </button>
        </header>
      </div>

      {error && (
        <p className="text-[11px] text-destructive px-1">{error}</p>
      )}
      {lastNote && !error && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground px-1">
          <CircleCheck className="w-3.5 h-3.5 text-green-500" /> {lastNote}
        </p>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground py-6 text-center">Gathering ideas…</p>
      ) : ideas.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <Sparkles className="w-5 h-5 text-amber-400 mx-auto" />
          <p className="text-sm font-medium mt-2">All caught up</p>
          <p className="text-[11px] text-muted-foreground mt-1 max-w-sm mx-auto">
            Every goal has a plan and every resident has something to do. When that changes, an idea will show up here.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {ideas.map(idea => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              busy={busyId === idea.id}
              onAccept={accept}
              onDismiss={dismiss}
            />
          ))}
        </div>
      )}
    </div>
  );
}
