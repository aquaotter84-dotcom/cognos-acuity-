// v52 — the COGNOS design system kit.
//
// One Btn, one Card, one Badge, one set of form controls, one metadata scale,
// one disclosure. The covered screens (Projects, Memory, Studio, Settings)
// build from these so the app stops drifting into one-off classes.
//
// Rules the kit enforces:
//   * Colors come from the shared tokens (primary, accent, destructive, ok,
//     warn, muted, ...) — never a bare palette class or hex, in either theme.
//   * Focus is always visible: the global `:focus-visible` rule in index.css
//     draws the ring for keyboard users. Buttons never set `outline-none`;
//     inputs pair it with a border highlight (the global rule still outranks
//     it on keyboard focus).
//   * Type scale: `text-sm` is the reading size on a phone; `text-xs` is for
//     supporting lines; `text-[10px]` (via <Meta/>) is metadata only.
//   * Technical detail stays available but disclosed: <Disclosure/>.

/** Button variants. `warm` is the one deliberate accent (the Ideas cards);
 *  it lives here — not inline — so the exception stays singular. */
const BTN_VARIANTS = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'border border-border text-muted-foreground hover:text-foreground hover:bg-muted/60',
  ghost: 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
  danger: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
  accentSoft: 'bg-accent/15 text-accent hover:bg-accent/25',
  warm: 'bg-amber-500 text-white hover:bg-amber-600',
};

const BTN_SIZES = {
  sm: 'text-xs px-2.5 py-1.5',
  md: 'text-sm px-3 py-2',
};

export function Btn({ variant = 'primary', size = 'md', className = '', ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 select-none ${BTN_VARIANTS[variant] || BTN_VARIANTS.primary} ${BTN_SIZES[size] || BTN_SIZES.md} ${className}`}
      {...props}
    />
  );
}

/** Icon-only button. Give it an aria-label or title — it has no text. */
export function IconBtn({ className = '', children, ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 select-none ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

/** The one card. */
export function Card({ className = '', ...props }) {
  return <div className={`rounded-xl border border-border bg-card ${className}`} {...props} />;
}

/** Card with the standard section header (title, optional subtitle + action).
 *  This is the Autonomy `Section` pattern, promoted to the kit. */
export function SectionCard({ icon: Icon, title, subtitle, action, bodyClassName = '', className = '', children }) {
  return (
    <section className={`rounded-xl border border-border bg-card overflow-hidden ${className}`}>
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60">
        {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />}
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-semibold">{title}</h3>
          {subtitle && <p className="text-[10px] text-muted-foreground/70 leading-snug">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className={`p-4 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

const BADGE_TONES = {
  muted: 'bg-muted text-muted-foreground',
  ok: 'bg-ok/15 text-ok',
  warn: 'bg-warn/15 text-warn',
  bad: 'bg-destructive/15 text-destructive',
  info: 'bg-primary/15 text-primary',
};

/** The one badge. Tones are semantic and token-based, so they read correctly
 *  in both themes. (SystemUi's `Pill` is an alias of this.)
 *  `tone="custom"` skips the built-in tone classes so a full palette pair
 *  (e.g. LAYER_TONES) can be passed via className without conflicts. */
export function Badge({ tone = 'muted', className = '', children }) {
  const toneCls = tone === 'custom' ? '' : (BADGE_TONES[tone] || BADGE_TONES.muted);
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 rounded font-medium uppercase text-[10px] whitespace-nowrap ${toneCls} ${className}`}>
      {children}
    </span>
  );
}

/** The memory category palette — the one place layer/type/evidence/volatility
 *  colors are defined. Each entry carries its light and dark treatment, so a
 *  badge never goes washed-out on the light face. */
export const LAYER_TONES = {
  self: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  events: 'bg-warn/15 text-warn',
  entities: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  knowledge: 'bg-primary/15 text-primary',
  goals: 'bg-ok/15 text-ok',
};

export const EVIDENCE_TONES = {
  direct: 'bg-ok/15 text-ok',
  repeated: 'bg-primary/15 text-primary',
  inferred: 'bg-warn/15 text-warn',
  assumed: 'bg-destructive/15 text-destructive',
};

export const VOLATILITY_TONES = {
  low: 'bg-ok/15 text-ok',
  medium: 'bg-warn/15 text-warn',
  high: 'bg-destructive/15 text-destructive',
};

const INPUT_CLS =
  'w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/60 placeholder:text-muted-foreground/60 transition-colors';

/** Labeled form field: label, control, optional hint. */
export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-muted-foreground mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[10px] text-muted-foreground/70 mt-1 leading-snug">{hint}</span>}
    </label>
  );
}

export function TextInput({ className = '', ...props }) {
  return <input className={`${INPUT_CLS} ${className}`} {...props} />;
}

export function TextArea({ className = '', ...props }) {
  return <textarea className={`${INPUT_CLS} resize-y ${className}`} {...props} />;
}

export function Select({ className = '', children, ...props }) {
  return (
    <select className={`${INPUT_CLS.replace('text-sm', 'text-xs')} text-foreground ${className}`} {...props}>
      {children}
    </select>
  );
}

/** Metadata scale: 10px, uppercase, tracked — for metadata only, never body. */
export function Meta({ className = '', ...props }) {
  return (
    <p className={`text-[10px] uppercase tracking-wide text-muted-foreground ${className}`} {...props} />
  );
}

/** The standard empty state: dashed card, icon, title, one supporting line. */
export function EmptyState({ icon: Icon, title, body, action }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
      {Icon && <Icon className="w-5 h-5 text-muted-foreground/50 mx-auto" aria-hidden />}
      <p className="text-sm font-medium mt-2">{title}</p>
      {body && <p className="text-[11px] text-muted-foreground mt-1 max-w-sm mx-auto leading-relaxed">{body}</p>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

/** Progressive disclosure: summary first, the technical detail one tap deep. */
export function Disclosure({ summary, children, className = '' }) {
  return (
    <details className={`rounded-lg border border-border/60 bg-muted/20 px-3 py-2 ${className}`}>
      <summary className="text-[11px] text-muted-foreground cursor-pointer select-none hover:text-foreground">
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
