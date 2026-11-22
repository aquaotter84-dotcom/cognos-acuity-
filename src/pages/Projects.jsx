// Phase 18 — durable research projects.
// A project is a folder: it groups conversations and immutable evidence
// (documents, images, links) around one investigation. Deleting a project
// detaches its conversations and evidence; it never deletes evidence.

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Folder, FolderPlus, Menu, MessageSquare, Plus, ShieldAlert, Trash2, FileText, Image as ImageIcon, Link as LinkIcon, X } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import { Btn, Card, Disclosure, Field, Meta, EmptyState, TextInput, TextArea } from '@/components/ui/CognosUi';

const KIND_ICON = {
  document: <FileText className="w-3.5 h-3.5 text-primary" />,
  image: <ImageIcon className="w-3.5 h-3.5 text-primary" />,
  link: <LinkIcon className="w-3.5 h-3.5 text-primary" />,
};

function EvidenceRow({ source }) {
  const risks = Array.isArray(source.risk_flags) ? source.risk_flags : [];
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <span className="mt-1">{KIND_ICON[source.kind] || null}</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium break-words">{source.name}</p>
            <p className="text-sm text-muted-foreground capitalize">{source.kind}</p>
            {source.final_url && <p className="text-sm text-muted-foreground break-all mt-1">{source.final_url}</p>}
            {risks.length > 0 && (
              <p className="text-sm text-warn flex items-center gap-1.5 mt-1.5">
                <ShieldAlert className="w-4 h-4 shrink-0" /> Possible untrusted instructions found. Review before relying on this source.
              </p>
            )}
          </div>
        </div>
        {source.kind === 'image' && (
          <img src={api.imageUrl(source.id)} alt={`Preview of ${source.name}`} loading="lazy" className="w-12 h-12 rounded object-cover border border-border" />
        )}
      </div>
      <Disclosure summary="Source details" className="mt-2 border-0 bg-transparent px-0 py-0">
        <dl className="space-y-1 text-xs text-muted-foreground break-all">
          <div><dt className="inline font-medium">File type: </dt><dd className="inline">{source.media_type || 'Unknown'}</dd></div>
          <div><dt className="inline font-medium">Size: </dt><dd className="inline">{source.byte_size?.toLocaleString() || 0} bytes</dd></div>
          <div><dt className="inline font-medium">Snapshot fingerprint: </dt><dd className="inline font-mono">{source.content_sha256}</dd></div>
        </dl>
      </Disclosure>
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
        <button aria-label="Open navigation" onClick={openSidebar} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted"><Menu className="w-5 h-5" /></button>
        <Folder className="w-4 h-4 text-primary" />
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Projects</h2>
          <p className="hidden sm:block text-sm text-muted-foreground">Keep the chats and sources for a bigger question together.</p>
        </div>
        <Btn variant="primary" size="sm" onClick={() => setCreating(v => !v)} className="ml-auto">
          {creating ? <X className="w-3.5 h-3.5" /> : <FolderPlus className="w-3.5 h-3.5" />} {creating ? 'Cancel' : 'New project'}
        </Btn>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 min-h-0">
        <div className="max-w-3xl mx-auto space-y-3">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          {creating && (
            <form onSubmit={handleCreate}>
              <Card className="p-4 space-y-4">
                <div>
                  <h3 className="text-lg font-semibold">Start a project</h3>
                  <p className="text-sm text-muted-foreground mt-1">Give a lasting question its own space. Related chats, saved sources, and background work will stay together.</p>
                </div>
                <Field label="Project name">
                  <TextInput
                    autoFocus
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="For example, Buying a home"
                  />
                </Field>
                <Field label="What are you trying to work out? (optional)" hint="This gives COGNOS useful context for every chat in the project.">
                  <TextArea
                    value={objective}
                    onChange={e => setObjective(e.target.value)}
                    placeholder="Compare the costs, risks, and next steps."
                    rows={3}
                  />
                </Field>
                <div className="flex justify-end gap-2">
                  <Btn type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Btn>
                  <Btn type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</Btn>
                </div>
              </Card>
            </form>
          )}

          {sorted.length === 0 && !creating && (
            <EmptyState
              icon={Folder}
              title="Give a bigger question some room."
              body="Use a project for a home purchase, a trip, a business decision, or any question that needs more than one chat. Your conversations and sources stay together."
              action={<Btn variant="primary" onClick={() => setCreating(true)}><FolderPlus className="w-4 h-4" /> Start your first project</Btn>}
            />
          )}

          {sorted.map(project => (
            <div key={project.id} className="rounded-xl border border-border bg-card overflow-hidden">
              <button
                type="button"
                onClick={() => toggleExpanded(project)}
                className="w-full min-h-11 flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                aria-expanded={expandedId === project.id}
                aria-controls={`project-${project.id}`}
              >
                <Folder className="w-4 h-4 text-accent shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium truncate">{project.name}</p>
                  {project.objective && <p className="text-sm text-muted-foreground truncate">{project.objective}</p>}
                </div>
                <span className="hidden sm:inline text-sm text-muted-foreground shrink-0 tabular-nums">
                  {project.conversation_count} chat{project.conversation_count === 1 ? '' : 's'} · {project.source_count} source{project.source_count === 1 ? '' : 's'}
                </span>
                <span className="hidden sm:inline text-xs text-muted-foreground shrink-0">{new Date(project.updated_date).toLocaleDateString()}</span>
                <ChevronDown className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${expandedId === project.id ? 'rotate-180' : ''}`} />
              </button>

              {expandedId === project.id && detail && (
                <div id={`project-${project.id}`} className="border-t border-border px-4 py-4 space-y-5">
                  <div className="flex flex-wrap gap-2">
                    <Btn variant="primary" size="sm" onClick={() => startChat(project.id)}>
                      <Plus className="w-4 h-4" /> Start a chat
                    </Btn>
                    <Btn variant="secondary" size="sm" onClick={() => handleDelete(project)} disabled={busy}>
                      <Trash2 className="w-4 h-4" /> Delete project
                    </Btn>
                  </div>
                  <p className="text-sm text-muted-foreground -mt-2">Deleting a project removes the folder, not its chats or saved sources.</p>

                  <div>
                    <Meta className="mb-2">Conversations</Meta>
                    {detail.conversations.length === 0
                      ? <p className="text-sm text-muted-foreground">No chats yet. Start one above and it will appear here.</p>
                      : <div className="space-y-1">
                          {detail.conversations.map(c => (
                            <button key={c.id} type="button" onClick={() => openChat(c.id)} className="w-full min-h-11 flex items-center gap-2 text-left rounded-lg px-2.5 py-2 hover:bg-muted/60">
                              <MessageSquare className="w-4 h-4 text-muted-foreground shrink-0" />
                              <span className="text-sm truncate">{c.title}</span>
                              <span className="ml-auto text-xs text-muted-foreground shrink-0">{new Date(c.updated_date || c.created_date).toLocaleDateString()}</span>
                            </button>
                          ))}
                        </div>}
                  </div>

                  <div>
                    <Meta className="mb-1">Saved sources</Meta>
                    <p className="text-sm text-muted-foreground mb-2">Documents, images, and links added in project chats are kept here as unchangeable snapshots.</p>
                    {detail.sources.length === 0
                      ? <p className="text-sm text-muted-foreground">Nothing saved yet. Use the attachment button in a project chat to add a document, image, or link.</p>
                      : <div className="space-y-2">{detail.sources.map(s => <EvidenceRow key={s.id} source={s} />)}</div>}
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
