// Ported from the original src/components/chat/MobileNav.jsx.
// Tabs reduced to the surfaces that still exist (Docs/Spaces removed).
// Phase 14/15 adds one more tab, System: a read-only window onto the event
// ledger, telemetry and laws.
//
// v50 — navigation restructure. The bottom bar carries the four everyday
// destinations (Chat, Projects, Memory, Studio). Everything else — Activity,
// System (framed as diagnostics), About COGNOS, Settings — lives behind a
// single "More" overflow sheet, one tap away, instead of crowding the bar.
// Every route still exists; nothing was removed.

import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MessageSquare, Brain, Folder, Bot, MoreHorizontal, Activity as ActivityIcon, Settings as SettingsIcon, Network, Cpu, X } from 'lucide-react';
import { useCognos } from '@/lib/cognosContext';

// The everyday destinations. These are the whole bottom bar.
const PRIMARY_ITEMS = [
  { key: 'chat', label: 'Chat', icon: MessageSquare },
  { key: 'projects', to: '/projects', path: '/projects', label: 'Projects', icon: Folder },
  { key: 'memory', to: '/memory', path: '/memory', label: 'Memory', icon: Brain },
  { key: 'studio', to: '/autonomy', path: '/autonomy', label: 'Studio', icon: Bot },
];

// Advanced / infrequent destinations. Reachable from "More", never deleted.
const MORE_ITEMS = [
  { to: '/activity', path: '/activity', label: 'Activity', icon: ActivityIcon, hint: 'What has happened lately' },
  { to: '/system', path: '/system', label: 'System', icon: Network, hint: 'Diagnostics — ledger, telemetry, and laws' },
  { to: '/about', path: '/about', label: 'About COGNOS', icon: Cpu, hint: 'What this app is' },
  { to: '/settings', path: '/settings', label: 'Settings', icon: SettingsIcon, hint: 'Models, keys, and behavior' },
];

const MORE_PATHS = new Set(MORE_ITEMS.map(i => i.path));

export default function MobileNav() {
  const location = useLocation();
  const { activeConversationId } = useCognos();
  const [moreOpen, setMoreOpen] = useState(false);
  // Chat tab preserves the active conversation so switching tabs never drops it.
  const chatTo = activeConversationId ? `/?c=${activeConversationId}` : '/';

  const primary = PRIMARY_ITEMS.map(item =>
    item.key === 'chat' ? { ...item, to: chatTo, path: '/' } : item
  );
  const moreActive = MORE_PATHS.has(location.pathname);

  const itemClass = (isActive) =>
    `flex flex-col items-center gap-1 px-1 sm:px-3 py-1.5 rounded-lg transition-colors ${isActive ? 'text-primary' : 'text-muted-foreground'}`;

  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 z-40 md:hidden border-t border-border bg-card/95 backdrop-blur select-none" style={{ paddingBottom: 'env(safe-area-inset-bottom, 12px)' }}>
        <div className="flex items-center justify-around py-2">
          {primary.map(({ to, path, label, icon: Icon }) => {
            const isActive = location.pathname === path;
            return (
              <Link key={path} to={to} className={itemClass(isActive)}>
                <Icon className="w-5 h-5" />
                <span className="text-xs">{label}</span>
              </Link>
            );
          })}
          <button
            onClick={() => setMoreOpen(true)}
            className={itemClass(moreActive)}
            aria-label="More destinations"
            aria-expanded={moreOpen}
          >
            <MoreHorizontal className="w-5 h-5" />
            <span className="text-xs">More</span>
          </button>
        </div>
      </nav>

      {moreOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-label="More destinations">
          <button className="absolute inset-0 bg-black/50" onClick={() => setMoreOpen(false)} aria-label="Close" tabIndex={-1} />
          <div className="absolute bottom-0 left-0 right-0 bg-card border-t border-border rounded-t-2xl p-4 pb-8 shadow-2xl">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold">More</p>
              <button onClick={() => setMoreOpen(false)} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground" aria-label="Close more menu">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-1">
              {MORE_ITEMS.map(({ to, path, label, icon: Icon, hint }) => (
                <Link
                  key={path}
                  to={to}
                  onClick={() => setMoreOpen(false)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${location.pathname === path ? 'bg-muted/60' : 'hover:bg-muted/40'}`}
                >
                  <Icon className="w-5 h-5 text-muted-foreground shrink-0" />
                  <span className="min-w-0">
                    <span className="text-sm font-medium block">{label}</span>
                    <span className="text-[11px] text-muted-foreground block leading-snug">{hint}</span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
