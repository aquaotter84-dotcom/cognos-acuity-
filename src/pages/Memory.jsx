// Ported from the original src/pages/Memory.jsx.
// Same view: search, enable/disable toggle, edit, delete, add, and the
// evidence/volatility/type badges. Sharing is removed (it required multi-user
// workspaces, which no longer exist).

import { useState, useEffect } from 'react';
import { Brain, Search, Plus, Trash2, Edit2, Check, X, Menu } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';

const typeColors = {
  episodic: 'bg-accent/15 text-accent',
  semantic: 'bg-primary/15 text-primary',
  working: 'bg-amber-500/15 text-amber-400',
};

const evidenceColors = {
  direct: 'bg-green-500/15 text-green-400',
  repeated: 'bg-primary/15 text-primary',
  inferred: 'bg-amber-500/15 text-amber-400',
  assumed: 'bg-red-500/15 text-red-400',
};

const volatilityColors = {
  low: 'bg-green-500/15 text-green-400',
  medium: 'bg-amber-500/15 text-amber-400',
  high: 'bg-red-500/15 text-red-400',
};

export default function Memory() {
  const { openSidebar } = useCognos();
  const [memories, setMemories] = useState([]);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [error, setError] = useState(null);

  const load = () => api.listMemories().then(setMemories).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  const filtered = memories.filter(m => m.content?.toLowerCase().includes(search.toLowerCase()));

  const handleToggle = async (mem) => {
    const next = !mem.is_enabled;
    setMemories(prev => prev.map(m => m.id === mem.id ? { ...m, is_enabled: next } : m));
    try {
      await api.updateMemory(mem.id, { is_enabled: next });
    } catch (e) {
      setMemories(prev => prev.map(m => m.id === mem.id ? { ...m, is_enabled: mem.is_enabled } : m));
      setError(e.message);
    }
  };

  const handleDelete = async (id) => {
    const snapshot = memories;
    setMemories(prev => prev.filter(m => m.id !== id));
    try { await api.deleteMemory(id); } catch (e) { setMemories(snapshot); setError(e.message); }
  };

  const handleSaveEdit = async (id) => {
    try {
      const updated = await api.updateMemory(id, { content: editContent });
      setMemories(prev => prev.map(m => m.id === id ? updated : m));
      setEditingId(null);
    } catch (e) { setError(e.message); }
  };

  const handleAdd = async () => {
    const content = newContent.trim();
    if (!content) return;
    try {
      const created = await api.createMemory({ content, memory_type: 'semantic', importance: 7 });
      setMemories(prev => [created, ...prev]);
      setNewContent('');
      setIsAdding(false);
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-2 px-3 md:px-4 py-3 border-b border-border shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <button onClick={openSidebar} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted"><Menu className="w-5 h-5" /></button>
        <Brain className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-medium flex-1">Memory</h2>
        <button onClick={() => setIsAdding(v => !v)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground">
          <Plus className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 min-h-0">
        <div className="max-w-3xl mx-auto space-y-3">
          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/40 border border-border">
            <Search className="w-4 h-4 text-muted-foreground shrink-0" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search memories"
              className="bg-transparent outline-none text-sm flex-1 min-w-0 placeholder:text-muted-foreground/60" />
          </div>

          {isAdding && (
            <div className="rounded-xl border border-border bg-card p-3 space-y-2">
              <textarea value={newContent} onChange={e => setNewContent(e.target.value)} rows={3}
                placeholder="Something COGNOS should remember..."
                className="w-full bg-transparent outline-none text-sm resize-none" />
              <div className="flex gap-2 justify-end">
                <button onClick={() => { setIsAdding(false); setNewContent(''); }} className="text-xs px-3 py-1.5 rounded-lg hover:bg-muted">Cancel</button>
                <button onClick={handleAdd} className="text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground">Save</button>
              </div>
            </div>
          )}

          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No memories yet. COGNOS extracts them automatically as you talk.
            </p>
          )}

          {filtered.map(mem => (
            <div key={mem.id} className={`rounded-xl border border-border bg-card p-3 ${mem.is_enabled ? '' : 'opacity-50'}`}>
              {editingId === mem.id ? (
                <div className="space-y-2">
                  <textarea value={editContent} onChange={e => setEditContent(e.target.value)} rows={3}
                    className="w-full bg-muted/40 rounded-lg p-2 outline-none text-sm resize-none" />
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setEditingId(null)} className="p-1.5 rounded-lg hover:bg-muted"><X className="w-3.5 h-3.5" /></button>
                    <button onClick={() => handleSaveEdit(mem.id)} className="p-1.5 rounded-lg bg-primary text-primary-foreground"><Check className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm leading-relaxed mb-2">{mem.content}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${typeColors[mem.memory_type] || 'bg-muted'}`}>{mem.memory_type}</span>
                    {mem.evidence_level && <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${evidenceColors[mem.evidence_level] || 'bg-muted'}`}>{mem.evidence_level}</span>}
                    {mem.volatility && <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${volatilityColors[mem.volatility] || 'bg-muted'}`}>{mem.volatility}</span>}
                    <span className="text-[10px] text-muted-foreground">importance {mem.importance}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <button onClick={() => handleToggle(mem)} className="text-[10px] px-2 py-1 rounded-lg hover:bg-muted text-muted-foreground">
                        {mem.is_enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => { setEditingId(mem.id); setEditContent(mem.content); }} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground"><Edit2 className="w-3.5 h-3.5" /></button>
                      <button onClick={() => handleDelete(mem.id)} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
