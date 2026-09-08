import { AlertTriangle, Gauge, GitBranch, History, Link2, Scale } from 'lucide-react';

export const SYSTEM_TABS = [
  { id: 'ledger', label: 'Ledger', icon: History },
  { id: 'replay', label: 'Replay', icon: GitBranch },
  { id: 'coherence', label: 'Coherence', icon: Link2 },
  { id: 'telemetry', label: 'Telemetry', icon: Gauge },
  { id: 'laws', label: 'Laws', icon: Scale },
];

export const fmtTime = (v) => (v ? new Date(typeof v === 'number' ? v : v).toLocaleString() : '—');
export const fmtMs = (v) => (v == null ? '—' : `${Math.round(Number(v))}ms`);
export const fmtMoney = (v) => (v == null ? '—' : `$${Number(v).toFixed(5)}`);
export const fmtNum = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));

export function Card({ title, subtitle, children, action }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-semibold">{title}</h3>
          {subtitle && <p className="text-[10px] text-muted-foreground/70 leading-snug">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Pill({ tone = 'muted', children }) {
  const tones = {
    muted: 'bg-muted text-muted-foreground',
    ok: 'bg-green-500/15 text-green-400',
    warn: 'bg-yellow-500/15 text-yellow-400',
    bad: 'bg-destructive/15 text-destructive',
    info: 'bg-primary/15 text-primary',
  };
  return <span className={`px-1.5 py-0.5 rounded font-medium uppercase text-[10px] whitespace-nowrap ${tones[tone] || tones.muted}`}>{children}</span>;
}

export function Json({ value, className = '' }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground/50">null</span>;
  return (
    <pre className={`text-[10px] leading-relaxed whitespace-pre-wrap break-words font-mono text-foreground/80 bg-muted/40 rounded p-2 max-h-64 overflow-auto scrollbar-thin ${className}`}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Empty({ children }) {
  return <p className="text-xs text-muted-foreground py-6 text-center">{children}</p>;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return <p className="text-xs text-destructive flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}</p>;
}
