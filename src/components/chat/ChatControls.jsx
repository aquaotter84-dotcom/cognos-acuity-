// v51 — Chat as the front door: the four less-frequent choices (persona,
// answer style, web lookup, research help) consolidated into ONE tidy,
// discoverable control set.
//
// - ActiveChoiceChips: a slim strip under the chat header showing what is
//   active right now — a chip for the current research mode (always, it is
//   Jeremy's standing choice), plus chips for a non-default persona, a
//   non-default answer style, and web lookup when it is on. Tapping any chip
//   opens the sheet.
// - ChatControlSheet: the single "How COGNOS answers" sheet with warm,
//   plain-language labels — no jargon. Choices apply to the next message;
//   device-local choices persist on this device, the persona persists
//   server-side via the existing activatePersona path.

import { useEffect } from 'react';
import { Check, Globe, SlidersHorizontal, X } from 'lucide-react';

export const STYLE_OPTIONS = [
  { value: 'balanced', label: 'Balanced', hint: 'The usual mix — clear and to the point.' },
  { value: 'casual', label: 'Easygoing', hint: 'Relaxed and conversational, like talking it over.' },
  { value: 'technical', label: 'Technical', hint: 'Literal and precise, step by step.' },
  { value: 'strategic', label: 'Big picture', hint: 'Plans, trade-offs, and where things lead.' },
];

export const AGENT_MODE_OPTIONS = [
  { value: 'off', label: 'Off', hint: 'Just answers from what it knows. Nothing looked up.' },
  { value: 'observe', label: 'Watch', hint: 'Notices what it could check, but opens nothing on its own.' },
  { value: 'read_only', label: 'Open my links', hint: 'Opens links you paste into the message. Nothing else changes.' },
  { value: 'research', label: 'Research for me', hint: 'Proposes a plan first — nothing opens until you approve it.' },
];

export const styleLabel = (value) =>
  STYLE_OPTIONS.find((o) => o.value === value)?.label || 'Balanced';

export const agentModeLabel = (value) =>
  AGENT_MODE_OPTIONS.find((o) => o.value === value)?.label || 'Research for me';

function OptionRow({ selected, onSelect, label, hint }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`w-full flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
        selected ? 'border-primary/60 bg-primary/5' : 'border-border hover:bg-muted/40 active:bg-muted/60'
      }`}
    >
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-[11px] text-muted-foreground leading-snug mt-0.5">{hint}</span>}
      </span>
      {selected && <Check className="w-4 h-4 text-primary shrink-0 mt-0.5" aria-hidden />}
    </button>
  );
}

function Section({ title, note, children }) {
  return (
    <section className="px-4 py-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">{title}</h3>
      {note && <p className="text-[11px] text-muted-foreground mb-2 leading-snug">{note}</p>}
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

export function ChatControlSheet({
  open,
  onClose,
  style,
  onStyleChange,
  webSearch,
  onWebSearchChange,
  personas,
  activePersonaId,
  onPersonaChange,
  agentMode,
  onAgentModeChange,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="How COGNOS answers">
      <button className="absolute inset-0 bg-black/50 cursor-default" onClick={onClose} aria-label="Close" tabIndex={-1} />
      <div className="absolute bottom-0 left-0 right-0 md:inset-0 md:m-auto md:max-w-lg md:h-fit bg-card border-t md:border border-border rounded-t-2xl md:rounded-2xl shadow-2xl max-h-[85vh] overflow-y-auto animate-fade-in">
        <div className="sticky top-0 bg-card/95 backdrop-blur px-4 pt-2.5 pb-2.5 border-b border-border/60 z-10">
          <div className="w-10 h-1 rounded-full bg-muted mx-auto mb-2 md:hidden" aria-hidden />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">How COGNOS answers</h2>
              <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                Tune the reply — choices apply to your next message and are remembered.
              </p>
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 -mr-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <Section
          title="How it talks"
          note="Changes how COGNOS sounds — never what it's allowed to do."
        >
          {(personas || []).map((p) => (
            <OptionRow
              key={p.id}
              selected={p.id === activePersonaId}
              onSelect={() => onPersonaChange(p.id)}
              label={p.name}
              hint={p.description}
            />
          ))}
          {(!personas || personas.length === 0) && (
            <p className="text-xs text-muted-foreground py-1">Voices are still loading…</p>
          )}
        </Section>

        <div className="border-t border-border/60" />

        <Section title="Answer style">
          {STYLE_OPTIONS.map((o) => (
            <OptionRow
              key={o.value}
              selected={o.value === style}
              onSelect={() => onStyleChange(o.value)}
              label={o.label}
              hint={o.hint}
            />
          ))}
        </Section>

        <div className="border-t border-border/60" />

        <Section title="Looking things up">
          <button
            type="button"
            onClick={() => onWebSearchChange(!webSearch)}
            aria-pressed={webSearch}
            className="w-full flex items-center gap-3 rounded-xl border border-border px-3 py-2.5 text-left hover:bg-muted/40 active:bg-muted/60 transition-colors"
          >
            <Globe className="w-4 h-4 text-primary shrink-0" aria-hidden />
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium">Search the web</span>
              <span className="block text-[11px] text-muted-foreground leading-snug mt-0.5">
                Lets COGNOS check current facts online when an answer needs them.
              </span>
            </span>
            <span
              aria-hidden
              className={`w-9 h-5 rounded-full p-0.5 shrink-0 transition-colors ${webSearch ? 'bg-primary' : 'bg-muted'}`}
            >
              <span className={`block w-4 h-4 rounded-full bg-white shadow transition-transform ${webSearch ? 'translate-x-4' : 'translate-x-0'}`} />
            </span>
          </button>
        </Section>

        <div className="border-t border-border/60" />

        <Section
          title="Research help"
          note="How far COGNOS may go looking things up on its own."
        >
          {AGENT_MODE_OPTIONS.map((o) => (
            <OptionRow
              key={o.value}
              selected={o.value === agentMode}
              onSelect={() => onAgentModeChange(o.value)}
              label={o.label}
              hint={o.hint}
            />
          ))}
        </Section>

        <div className="h-4" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} />
      </div>
    </div>
  );
}

export function ActiveChoiceChips({
  style,
  webSearch,
  personas,
  activePersonaId,
  agentMode,
  onOpen,
}) {
  const persona = (personas || []).find((p) => p.id === activePersonaId);
  const chips = [];
  if (persona && persona.id !== 'default') {
    chips.push({ key: 'persona', label: persona.name, title: 'How COGNOS talks — tap to change' });
  }
  if (style && style !== 'balanced') {
    chips.push({ key: 'style', label: styleLabel(style), title: 'Answer style — tap to change' });
  }
  if (webSearch) {
    chips.push({ key: 'web', label: 'Searching the web', title: 'Web lookup is on — tap to change', icon: true });
  }
  // The research mode is always a live choice (Jeremy's standing default is
  // "Research for me"), so it always shows — the indicator is the point.
  chips.push({ key: 'mode', label: agentModeLabel(agentMode), title: 'Research help — tap to change' });

  return (
    <div className="shrink-0 border-b border-border/60">
      <div className="max-w-3xl mx-auto px-3 md:px-4 py-1.5 flex items-center gap-1.5 overflow-x-auto scrollbar-thin">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={onOpen}
            title={c.title}
            className="shrink-0 inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-foreground/80 hover:bg-muted/70 active:bg-muted transition-colors"
          >
            {c.icon && <Globe className="w-3 h-3 text-primary" aria-hidden />}
            {c.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onOpen}
          aria-label="Adjust how COGNOS answers"
          title="Adjust how COGNOS answers"
          className="shrink-0 p-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/60 active:bg-muted transition-colors"
        >
          <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
