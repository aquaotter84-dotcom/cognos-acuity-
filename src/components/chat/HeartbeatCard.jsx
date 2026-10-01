// Phase 31 — the morning greeting card.
//
// Rendered once per device-local day at the top of Chat, above the messages.
// It is not a chat message: it carries no council trace, is never persisted,
// and a dismiss (the X) clears it for the session. The server already dedupes
// per day, so a re-open tomorrow simply fetches the next one.

import { X, Sparkles, Bell } from 'lucide-react';

export default function HeartbeatCard({ text, checkin, onDismiss }) {
  if (!text && !checkin) return null;
  return (
    <div className="rounded-xl border border-border bg-muted/40 px-3.5 py-3 relative">
      <button
        onClick={onDismiss}
        aria-label="Dismiss greeting"
        className="absolute top-2 right-2 text-muted-foreground hover:text-foreground p-1"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      {text && (
        <p className="text-[13px] leading-relaxed flex items-start gap-2 pr-6">
          <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
          <span>{text}</span>
        </p>
      )}
      {checkin && (
        <p className="text-[12px] text-muted-foreground leading-relaxed flex items-start gap-2 mt-1.5 pr-6">
          <Bell className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{checkin}</span>
        </p>
      )}
    </div>
  );
}
