// Ported from the original src/components/chat/Sidebar.jsx.
// The conversation list, new-chat button and nav links are preserved. Phase 18
// adds durable research projects: chats and evidence can be grouped under a
// project, and every project can start its own conversations. Links to pages
// that only existed because of Base44-era features are removed (DIVERGENCES.md).

import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Plus, MessageSquare, Brain, Activity as ActivityIcon, Settings as SettingsIcon, Trash2, Search, Network, Cpu, Folder, FolderPlus, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';

function ConversationRow({ conversation, onNavigate }) {
  const { activeConversationId, refreshConversations } = useCognos();
  const navigate = useNavigate();
  const handleDelete = async (e, id) => {
    e.preventDefault();
    e.stopPropagation();
    await api.deleteConversation(id).catch(() => {});
    await refreshConversations();
    if (activeConversationId === id) navigate('/');
  };
  return (
    <Link
      to={`/?c=${conversation.id}`}
      onClick={onNavigate}
      className={`group flex items-start gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${activeConversationId === conversation.id ? 'bg-muted/70' : 'hover:bg-muted/40'}`}
    >
      <MessageSquare className="w-3.5 h-3.5 mt-0.5 text-muted-foreground shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{conversation.title}</p>
        {conversation.last_message_preview && (
          <p className="truncate text-[11px] text-muted-foreground/70">{conversation.last_message_preview}</p>
        )}
      </div>
      <button
        onClick={(e) => handleDelete(e, conversation.id)}
        className="md:opacity-0 md:group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
        title="Delete conversation"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </Link>
  );
}

export default function Sidebar({ onNavigate }) {
  const { conversations, refreshConversations, activeWorkspace, projects, refreshProjects } = useCognos();
  const [query, setQuery] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const matches = (conversation) =>
    !query || (conversation.title || '').toLowerCase().includes(query.toLowerCase()) ||
    (conversation.last_message_preview || '').toLowerCase().includes(query.toLowerCase());

  const byProject = new Map();
  const general = [];
  for (const conversation of conversations) {
    if (!matches(conversation)) continue;
    if (conversation.project_id) {
      if (!byProject.has(conversation.project_id)) byProject.set(conversation.project_id, []);
      byProject.get(conversation.project_id).push(conversation);
    } else {
      general.push(conversation);
    }
  }
  // Projects are ordered by recency; conversations within each by recency too.
  const orderedProjects = [...projects].sort((a, b) => (b.updated_date || '').localeCompare(a.updated_date || ''));

  const handleNew = () => {
    navigate('/');
    onNavigate?.();
  };

  const handleNewProjectChat = async (e, projectId) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const conversation = await api.createConversation('New conversation', projectId);
      await refreshConversations();
      navigate(`/?c=${conversation.id}`);
      onNavigate?.();
    } catch (err) {
      console.error('Could not start a chat in this project:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateProject = async (e) => {
    e.preventDefault();
    const name = projectName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await api.createProject(name);
      await refreshProjects();
      setProjectName('');
      setCreatingProject(false);
    } catch (err) {
      console.error('Could not create project:', err);
    } finally {
      setBusy(false);
    }
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
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" /> New chat
        </button>
        {creatingProject ? (
          <form onSubmit={handleCreateProject} className="flex items-center gap-1 mt-2">
            <input
              autoFocus
              value={projectName}
              onChange={e => setProjectName(e.target.value)}
              placeholder="Project name — e.g. Property purchase"
              className="flex-1 min-w-0 bg-muted/40 border border-border rounded-lg px-2 py-1.5 text-xs outline-none focus:border-primary/60"
            />
            <button type="submit" disabled={busy || !projectName.trim()} className="px-2 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs disabled:opacity-40" title="Create project">
              <Plus className="w-3.5 h-3.5" />
            </button>
            <button type="button" onClick={() => setCreatingProject(false)} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground" title="Cancel">
              <X className="w-3.5 h-3.5" />
            </button>
          </form>
        ) : (
          <button
            onClick={() => setCreatingProject(true)}
            className="w-full flex items-center justify-center gap-2 mt-2 px-3 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <FolderPlus className="w-3.5 h-3.5" /> New project
          </button>
        )}
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
        {orderedProjects.map(project => {
          const rows = byProject.get(project.id) || [];
          return (
            <div key={project.id} className="mb-1">
              <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
                <Folder className="w-3.5 h-3.5 text-accent shrink-0" />
                <span className="truncate font-medium text-foreground/80">{project.name}</span>
                <span className="shrink-0">· {project.conversation_count}</span>
                <button
                  onClick={(e) => handleNewProjectChat(e, project.id)}
                  disabled={busy}
                  className="ml-auto p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-40"
                  title={`Start a chat in ${project.name}`}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
              {rows.length === 0 && !query && (
                <p className="px-3 pb-1 text-[10px] text-muted-foreground/60">No chats yet — open this project's chat and upload evidence.</p>
              )}
              {rows.map(conversation => (
                <ConversationRow key={conversation.id} conversation={conversation} onNavigate={onNavigate} />
              ))}
            </div>
          );
        })}

        {general.length > 0 && (
          <div className="mb-1">
            <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
              <MessageSquare className="w-3 h-3" /> General
            </p>
            {general.map(conversation => (
              <ConversationRow key={conversation.id} conversation={conversation} onNavigate={onNavigate} />
            ))}
          </div>
        )}

        {!query && conversations.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">No conversations yet. Start a chat, or create a project to group research.</p>
        )}
      </div>

      <div className="p-2 border-t border-border space-y-0.5">
        {navLink('/projects', Folder, 'Projects', 'text-accent')}
        {navLink('/memory', Brain, 'Memory', 'text-accent')}
        {navLink('/activity', ActivityIcon, 'Activity')}
        {navLink('/system', Network, 'System')}
        {navLink('/about', Cpu, 'About COGNOS', 'text-primary')}
        {navLink('/settings', SettingsIcon, 'Settings', 'text-muted-foreground')}
      </div>
    </div>
  );
}
