// Shared birth-barrier copy: sentences first, hashes in Technical details.
// Used by the Autonomy page and the chat Goal Card so the same scope cannot
// read as JSON in one place and as English in the other.

import { describeBudget, describeScope } from '@/lib/autonomyLabels';

export default function AuthorizeConsent({ scope, budget, hashes = null }) {
  const scopeLines = describeScope(scope);
  const budgetLines = describeBudget(budget);
  return (
    <>
      <div className="grid sm:grid-cols-2 gap-2 mt-2 text-[10px]">
        <div className="rounded bg-background/60 border border-border p-2">
          <p className="text-muted-foreground mb-1">What it may do</p>
          <ul className="space-y-0.5 text-[11px] text-foreground/80 leading-snug">
            {scopeLines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
        <div className="rounded bg-background/60 border border-border p-2">
          <p className="text-muted-foreground mb-1">How far it may go</p>
          <ul className="space-y-0.5 text-[11px] text-foreground/80 leading-snug">
            {budgetLines.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      </div>
      <details className="mt-2 rounded border border-border/60 px-2 py-1.5">
        <summary className="text-[10px] text-muted-foreground cursor-pointer select-none">
          Technical details — scope, budget, hashes
        </summary>
        <div className="mt-1.5 grid sm:grid-cols-2 gap-2 text-[10px]">
          <pre className="font-mono whitespace-pre-wrap break-all text-muted-foreground">{JSON.stringify(scope || {}, null, 1)}</pre>
          <pre className="font-mono whitespace-pre-wrap break-all text-muted-foreground">{JSON.stringify(budget || {}, null, 1)}</pre>
        </div>
        {hashes?.scopeSha256 && (
          <p className="mt-1 font-mono text-[10px] text-muted-foreground/80 break-all">
            scope {hashes.scopeSha256} · budget {hashes.budgetSha256}
          </p>
        )}
      </details>
    </>
  );
}
