// Ported from the original src/components/chat/Sidebar.jsx.
// The conversation list, new-chat button and nav links are preserved. Links to
// pages that only existed because of Base44-era features (Beliefs, Dynamics,
// Insights, Documents, Agent, Workspaces) are removed — see DIVERGENCES.md.

import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Plus, MessageSquare, Brain, Activity as ActivityIcon, Settings as SettingsIcon, Trash2, Search, Network } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';

export default function Sidebar({ onNavigate }) {
  const { conversations, refreshConversations, activeConversationId, activeWorkspace } = useCognos();
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const location = useLocation();

  const filtered = conversations.filter(c =>
    !query || (c.title || '').toLowerCase().includes(query.toLowerCase()) ||
    (c.last_message_preview || '').toLowerCase().includes(query.toLowerCase())
  );

  const handleNew = () => {
    navigate('/');
    onNavigate?.();
  };

  const handleDelete = async (e, id) => {
    e.preventDefault();
    e.stopPropagation();
    await api.deleteConversation(id).catch(() => {});
    await refreshConversations();
    if (activeConversationId === id) navigate('/');
  };

  const navLink = (to, Icon, label, accent) => (
    <Link
      to={to}
      onClick={onNavigate}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted/50 text-sm transition-colors ${location.pathname === to ? 'bg-muted/60' : ''}`}
    >
      <Icon className={`w-4 h-4 ${accent || 'text-primary'}`} /> {label}
    </Link>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-3 border-b border-border">
        <div className="flex items-center gap-2 mb-3 px-1">
          <div className="w-6 h-6 rounded-md bg-gradient-to-br from-primary to-accent flex items-center justify-center">
            <span className="text-[10px] font-bold text-white">C</span>
          </div>
          <span className="text-sm font-semibold tracking-tight">COGNOS</span>
          <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[100px]">{activeWorkspace?.name}</span>
        </div>
        <button
          onClick={handleNew}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" /> New chat
        </button>
      </div>

      <div className="px-3 py-2">
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-muted/40 border border-border">
          <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="bg-transparent outline-none text-xs flex-1 min-w-0 placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 min-h-0">
        {filtered.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">No conversations yet.</p>
        )}
        {filtered.map(c => (
          <Link
            key={c.id}
            to={`/?c=${c.id}`}
            onClick={onNavigate}
            className={`group flex items-start gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${activeConversationId === c.id ? 'bg-muted/70' : 'hover:bg-muted/40'}`}
          >
            <MessageSquare className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{c.title}</p>
              {c.last_message_preview && (
                <p className="truncate text-[11px] text-muted-foreground/70">{c.last_message_preview}</p>
              )}
            </div>
            <button
              onClick={(e) => handleDelete(e, c.id)}
              className="md:opacity-0 md:group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
              title="Delete conversation"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </Link>
        ))}
      </div>

      <div className="p-2 border-t border-border space-y-0.5">
        {navLink('/memory', Brain, 'Memory', 'text-accent')}
        {navLink('/activity', ActivityIcon, 'Activity')}
        {navLink('/system', Network, 'System')}
        {navLink('/settings', SettingsIcon, 'Settings', 'text-muted-foreground')}
      </div>
    </div>
  );
}
