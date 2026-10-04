// Phase 34 (Studio) — per-resident chat: "talk to your residents".
//
// A conversation over one resident's live state: its brief, its goals, recent
// notes and findings, its preferences, and what it is allowed to do. Stateless
// turns — the client holds the transcript; the server loads fresh state each
// turn, so what the resident says about itself is never stale.
//
// What this drawer is: a window into the loop. What it is not: a second loop.
// A clear preference or lifecycle request ("skip the mornings", "practice in
// the background", "go ahead") is applied by the server through the same
// engine functions the settings routes call, and reported in actionsTaken.
// The model itself can discuss, explain, and suggest — it cannot change
// settings, authorize goals, or approve effects, and the prompt says so.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Loader2, MessageCircle, Send, Wrench, X } from 'lucide-react';
import { api } from '@/lib/api';
import { ErrorNote } from '@/components/system/SystemUi';
import { ToolRunCard } from '@/components/autonomy/ResidentTools';

/** Suggested openers: the preferences that used to be switches, as sentences. */
const SUGGESTIONS = [
  'What are you working on?',
  'Skip the morning greetings',
  'Practice in the background — touch nothing',
  'What are you allowed to do yet?',
];

function greetingFor(resident, goal) {
  const name = resident?.name || 'this resident';
  return goal
    ? `Talking about ${name} — and specifically “${goal.title}”. Ask about its work, its notes, what it found — or tell it plainly what to change: “skip the mornings”, “practice in the background”, “go ahead”.`
    : `Talking with ${name}. Ask what it's working on, what it found, what it's allowed to do — or tell it plainly what to change: “skip the mornings”, “stop the dreams”, “practice in the background”.`;
}

export default function ResidentChatDrawer({ open, onClose, resident, goal = null, onChanged }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  // A fresh conversation every time the drawer opens.
  useEffect(() => {
    if (!open) return;
    setMessages([{ role: 'assistant', content: greetingFor(resident, goal) }]);
    setInput(''); setError('');
  }, [open, resident, goal]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const send = useCallback(async (text) => {
    const content = (text ?? input).trim();
    if (!content || busy || !resident?.id) return;
    setBusy(true); setError('');
    const transcript = [...messages.filter(m => m.content && m.role !== 'system'), { role: 'user', content }]
      .map(m => ({ role: m.role, content: m.content }));
    setMessages(prev => [...prev, { role: 'user', content }]);
    setInput('');
    try {
      const out = await api.chatWithResident(resident.id, {
        messages: transcript,
        ...(goal?.id ? { goalId: goal.id } : {}),
      });
      setMessages(prev => [...prev, { role: 'assistant', content: out.reply || '…' }]);
      // Phase 36 — tool calls the resident asked for, run and reported.
      // Each run also joins the transcript as plain context, so the next
      // turn can see what the tool answered.
      if (out.toolRuns?.length) {
        setMessages(prev => [...prev, ...out.toolRuns.map(tr => ({
          role: 'tool',
          toolRun: tr,
          content: `[tool “${tr.toolName || tr.toolId}” ${tr.staged ? 'staged for approval' : tr.ok ? `answered ${tr.status ?? ''}` : 'failed'}${tr.output ? `: ${String(tr.output).slice(0, 500)}` : ''}${tr.message ? ` — ${tr.message}` : ''}]`,
        }))]);
      }
      // A preference or lifecycle change may have landed — refresh the page
      // behind the drawer so cards, pills, and the inbox tell the truth.
      if (out.actionsTaken?.length) onChanged?.();
    } catch (e) {
      setError(e?.message || 'The resident could not answer.');
      setMessages(prev => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === 'user' && next[i].content === content && !next[i].failed) {
            next[i] = { ...next[i], failed: true };
            break;
          }
        }
        return next;
      });
    } finally {
      setBusy(false);
    }
  }, [input, busy, messages, resident, goal, onChanged]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label={`Talk with ${resident?.name || 'resident'}`}>
      <button
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="Close the conversation"
        tabIndex={-1}
      />
      <div className="relative flex flex-col w-full max-w-xl h-full bg-background border-l border-border shadow-2xl">
        <header className="flex items-start gap-2 px-4 py-3 border-b border-border shrink-0">
          <Bot className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <MessageCircle className="w-3.5 h-3.5 text-muted-foreground" />
              {resident?.name || 'Resident'}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
              {goal ? `About “${goal.title}”` : 'About its work, its notes, and what it may do'}
              {' '}— a conversation, not a control panel. Clear requests (“skip the mornings”) are applied; everything else is talk.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5 min-h-0">
          {messages.map((m, i) => (
            m.role === 'tool' && m.toolRun ? (
              <div key={i} className="flex justify-start">
                <div className="max-w-[85%] w-full">
                  <ToolRunCard run={m.toolRun} />
                </div>
              </div>
            ) : (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/60 border border-border/60'
              } ${m.failed ? 'opacity-60' : ''}`}>
                {m.content}
                {m.failed && <span className="block text-[10px] mt-1 opacity-70">didn't send</span>}
              </div>
            </div>
            )
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="rounded-xl px-3 py-2 bg-muted/60 border border-border/60">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
          <ErrorNote error={error} />
        </div>

        {messages.length <= 1 && !busy && (
          <div className="px-4 pb-2 flex flex-wrap gap-1.5 shrink-0">
            {SUGGESTIONS.map(s => (
              <button
                key={s}
                onClick={() => send(s)}
                className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <form
          className="flex items-center gap-2 px-4 py-3 border-t border-border shrink-0"
          onSubmit={e => { e.preventDefault(); send(); }}
        >
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={goal ? `Ask about “${goal.title}”…` : `Talk with ${resident?.name || 'this resident'}…`}
            className="flex-1 bg-muted/40 border border-border rounded-xl px-3 py-2 text-sm outline-none focus:border-primary/60"
            disabled={busy}
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="p-2 rounded-xl bg-primary text-primary-foreground disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
