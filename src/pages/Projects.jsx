// Phase 18 — durable research projects.
// A project is a folder: it groups conversations and immutable evidence
// (documents, images, links) around one investigation. Deleting a project
// detaches its conversations and evidence; it never deletes evidence.

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Folder, FolderPlus, Menu, MessageSquare, Plus, ShieldAlert, Trash2, FileText, Image as ImageIcon, Link as LinkIcon, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import { Btn, Card, Meta, EmptyState, TextInput, TextArea } from '@/components/ui/CognosUi';

const KIND_ICON = {
  document: <FileText className="w-3.5 h-3.5 text-primary" />,
  image: <ImageIcon className="w-3.5 h-3.5 text-primary" />,
  link: <LinkIcon className="w-3.5 h-3.5 text-primary" />,
};

function EvidenceRow({ source }) {
  const risks = Array.isArray(source.risk_flags) ? source.risk_flags : [];
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex items-start gap-2 min-w-0 flex-1">
        <span className="mt-0.5">{KIND_ICON[source.kind] || null}</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium truncate">{source.name}</p>
          <p className="text-[10px] text-muted-foreground truncate">
            {source.kind} · {source.media_type} · {source.byte_size?.toLocaleString()} bytes · {source.content_sha256?.slice(0, 16)}…
          </p>
          {source.final_url && <p className="text-[10px] text-muted-foreground/70 truncate">{source.final_url}</p>}
          {risks.length > 0 && (
            <p className="text-[10px] text-warn flex items-center gap-1 mt-0.5">
              <ShieldAlert className="w-3 h-3" /> Untrusted instructions detected
            </p>
          )}
        </div>
      </div>
      {source.kind === 'image' && (
        <img src={api.imageUrl(source.id)} alt="" loading="lazy" className="w-12 h-12 rounded object-cover border border-border" />
      )}
    </div>
  );
}

export default function Projects() {
  const navigate = useNavigate();
  const { openSidebar, projects, refreshProjects } = useCognos();
  const [projectsDetail, setProjectsDetail] = useState({}); // id -> detail
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [objective, setObjective] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const refreshOne = useCallback(async (project) => {
    if (!project) return;
    try {
      const detail = await api.getProject(project.id);
      setProjectsDetail(prev => ({ ...prev, [project.id]: detail }));
    } catch (e) {
      console.error('Could not load project detail:', e);
    }
  }, []);

  // Load detail for the expanded project.
  useEffect(() => {
    if (!expandedId) return;
    let cancelled = false;
    const project = projects.find(p => p.id === expandedId);
    if (project) {
      api.getProject(expandedId)
        .then(detail => { if (!cancelled) setProjectsDetail(prev => ({ ...prev, [expandedId]: detail })); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [expandedId, projects]);

  const toggleExpanded = (project) => {
    if (expandedId === project.id) setExpandedId(null);
    else { setExpandedId(project.id); refreshOne(project); }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const project = await api.createProject(name.trim(), objective.trim() || undefined);
      await refreshProjects();
      setName(''); setObjective(''); setCreating(false);
      setExpandedId(project.id);
    } catch (err) {
      setError(err.message || 'Could not create project');
    } finally { setBusy(false); }
  };

  const handleDelete = async (project) => {
    if (busy || !window.confirm(`Delete project “${project.name}”? Its conversations and evidence are detached, not deleted.`)) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteProject(project.id);
      setProjectsDetail(prev => {
        const next = { ...prev };
        delete next[project.id];
        return next;
      });
      if (expandedId === project.id) setExpandedId(null);
      await refreshProjects();
    } catch (err) {
      setError(err.message || 'Could not delete project');
    } finally { setBusy(false); }
  };

  const startChat = (projectId) => {
    api.createConversation('New conversation', projectId)
      .then(conversation => {
        navigate(`/?c=${conversation.id}`);
      })
      .catch(err => setError(err.message || 'Could not start a chat in this project'));
  };

  const openChat = (conversationId) => navigate(`/?c=${conversationId}`);

  const sorted = [...projects].sort((a, b) => (b.updated_date || '').localeCompare(a.updated_date || ''));
  const detail = projectsDetail[expandedId];

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-2 px-3 md:px-4 py-3 border-b border-border shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <button onClick={openSidebar} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted"><Menu className="w-5 h-5" /></button>
        <Folder className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-medium">Projects</h2>
        <span className="text-[10px] text-muted-foreground">research folders — conversations, evidence, runs</span>
        <Btn variant="primary" size="sm" onClick={() => setCreating(v => !v)} className="ml-auto">
          {creating ? <X className="w-3.5 h-3.5" /> : <FolderPlus className="w-3.5 h-3.5" />} {creating ? 'Cancel' : 'New project'}
        </Btn>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 min-h-0">
        <div className="max-w-3xl mx-auto space-y-3">
          {error && <p className="text-xs text-destructive">{error}</p>}

          {creating && (
            <form onSubmit={handleCreate}>
              <Card className="p-3 space-y-2">
                <p className="text-xs text-muted-foreground">Projects survive across sessions: conversations, immutable evidence, agent runs, decisions and approvals stay grouped until you remove them.</p>
                <TextInput
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Project name — e.g. Property purchase"
                />
                <TextArea
                  value={objective}
                  onChange={e => setObjective(e.target.value)}
                  placeholder="What are you investigating? (optional — shared with the council)"
                  rows={2}
                />
                <Btn type="submit" size="sm" disabled={busy || !name.trim()}>Create project</Btn>
              </Card>
            </form>
          )}

          {sorted.length === 0 && !creating && (
            <EmptyState
              icon={Folder}
              title="No research projects yet."
              body="Group a property purchase, a vendor comparison, or any investigation with its own chats and evidence."
            />
          )}

          {sorted.map(project => (
            <div key={project.id} className="rounded-xl border border-border bg-card overflow-hidden">
              <button type="button" onClick={() => toggleExpanded(project)} className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors">
                <Folder className="w-4 h-4 text-accent shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{project.name}</p>
                  {project.objective && <p className="text-xs text-muted-foreground truncate">{project.objective}</p>}
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                  {project.conversation_count} chat{project.conversation_count === 1 ? '' : 's'} · {project.source_count} source{project.source_count === 1 ? '' : 's'}
                </span>
                <span className="text-[10px] text-muted-foreground/60 shrink-0">{new Date(project.updated_date).toLocaleDateString()}</span>
              </button>

              {expandedId === project.id && detail && (
                <div className="border-t border-border px-4 py-3 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Btn variant="primary" size="sm" onClick={() => startChat(project.id)}>
                      <Plus className="w-3.5 h-3.5" /> New chat
                    </Btn>
                    <Btn variant="secondary" size="sm" onClick={() => handleDelete(project)} disabled={busy}>
                      <Trash2 className="w-3.5 h-3.5" /> Detach project
                    </Btn>
                  </div>

                  <div>
                    <Meta className="mb-1.5">Conversations</Meta>
                    {detail.conversations.length === 0
                      ? <p className="text-xs text-muted-foreground/70">None yet.</p>
                      : <div className="space-y-1">
                          {detail.conversations.map(c => (
                            <button key={c.id} type="button" onClick={() => openChat(c.id)} className="w-full flex items-center gap-2 text-left rounded-lg px-2.5 py-1.5 hover:bg-muted/60">
                              <MessageSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="text-xs truncate">{c.title}</span>
                              <span className="ml-auto text-[10px] text-muted-foreground/60 shrink-0">{new Date(c.updated_date || c.created_date).toLocaleDateString()}</span>
                            </button>
                          ))}
                        </div>}
                  </div>

                  <div>
                    <Meta className="mb-1.5">Immutable evidence</Meta>
                    {detail.sources.length === 0
                      ? <p className="text-xs text-muted-foreground/70">Upload documents, images, or open links inside a project chat — they land here as hashed snapshots.</p>
                      : <div className="space-y-1">{detail.sources.map(s => <EvidenceRow key={s.id} source={s} />)}</div>}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
