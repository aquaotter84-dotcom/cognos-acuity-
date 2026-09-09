// Ported from the original src/components/chat/MobileNav.jsx.
// Tabs reduced to the surfaces that still exist (Docs/Spaces removed).
// Phase 14/15 adds one more tab, System: a read-only window onto the event
// ledger, telemetry and laws. Item padding drops to px-2 below sm so five tabs
// still fit a 360px screen — cosmetic only, nothing else here changed.

import { Link, useLocation } from 'react-router-dom';
import { MessageSquare, Brain, Activity as ActivityIcon, Settings as SettingsIcon, Network, Bot } from 'lucide-react';
import { useCognos } from '@/lib/cognosContext';

export default function MobileNav() {
  const location = useLocation();
  const { activeConversationId } = useCognos();
  // Chat tab preserves the active conversation so switching tabs never drops it.
  const chatTo = activeConversationId ? `/?c=${activeConversationId}` : '/';

  const navItems = [
    { to: chatTo, path: '/', label: 'Chat', icon: MessageSquare },
    { to: '/memory', path: '/memory', label: 'Memory', icon: Brain },
    { to: '/activity', path: '/activity', label: 'Activity', icon: ActivityIcon },
    { to: '/autonomy', path: '/autonomy', label: 'Autonomy', icon: Bot },
    { to: '/system', path: '/system', label: 'System', icon: Network },
    { to: '/settings', path: '/settings', label: 'Settings', icon: SettingsIcon },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 md:hidden border-t border-border bg-card/95 backdrop-blur select-none" style={{ paddingBottom: 'env(safe-area-inset-bottom, 12px)' }}>
      <div className="flex items-center justify-around py-2">
        {navItems.map(({ to, path, label, icon: Icon }) => {
          const isActive = location.pathname === path;
          return (
            <Link key={path} to={to} className={`flex flex-col items-center gap-1 px-1 sm:px-3 py-1.5 rounded-lg transition-colors ${isActive ? 'text-primary' : 'text-muted-foreground'}`}>
              <Icon className="w-5 h-5" />
              <span className="text-xs">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
