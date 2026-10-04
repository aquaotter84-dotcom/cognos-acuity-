// Ported from the original src/pages/Memory.jsx.
// Same view: search, enable/disable toggle, edit, delete, add, and the
// evidence/volatility/type badges. Sharing is removed (it required multi-user
// workspaces, which no longer exist).

import { useState, useEffect } from 'react';
import { Brain, Search, Plus, Trash2, Edit2, Check, X, Menu, Star } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import {
  Btn, IconBtn, Card, Badge, TextInput, TextArea, Select, Disclosure,
  LAYER_TONES, EVIDENCE_TONES, VOLATILITY_TONES,
} from '@/components/ui/CognosUi';

export default function Memory() {
  const { openSidebar } = useCognos();
  const [memories, setMemories] = useState([]);
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [newLayer, setNewLayer] = useState('events');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
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

  // Favorites are shielded: the nightly librarian never prunes/atomizes them,
  // and decay never touches them.
  const handleFavorite = async (mem) => {
    const next = !mem.is_favorite;
    setMemories(prev => prev.map(m => m.id === mem.id ? { ...m, is_favorite: next } : m));
    try {
      await api.updateMemory(mem.id, { is_favorite: next });
    } catch (e) {
      setMemories(prev => prev.map(m => m.id === mem.id ? { ...m, is_favorite: mem.is_favorite } : m));
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
    let value = undefined;
    if (newValue.trim()) {
      try { value = JSON.parse(newValue); }
      catch { setError('Structured value must be valid JSON.'); return; }
    }
    try {
      const created = await api.createMemory({
        content,
        memory_type: newLayer,
        memory_layer: newLayer,
        memory_key: newKey.trim() || undefined,
        memory_value: value,
        importance: 7
      });
      setMemories(prev => [created, ...prev]);
      setNewContent('');
      setNewKey('');
      setNewValue('');
      setNewLayer('events');
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
            <Card className="p-3 space-y-2">
              <TextArea value={newContent} onChange={e => setNewContent(e.target.value)} rows={3}
                placeholder="Something COGNOS should remember..." />
              <div className="grid sm:grid-cols-2 gap-2">
                <Select value={newLayer} onChange={e => setNewLayer(e.target.value)}>
                  <option value="events">events · things that happened (default)</option>
                  <option value="knowledge">knowledge · durable reference</option>
                  <option value="entities">entities · people, places, things</option>
                  <option value="goals">goals · goals and progress</option>
                  <option value="self">self · the assistant's own inner life</option>
                </Select>
                <TextInput value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="stable key (optional)" />
              </div>
              <TextArea value={newValue} onChange={e => setNewValue(e.target.value)} rows={2}
                placeholder='Structured value JSON (optional), e.g. {"value":"Python"}'
                className="font-mono text-xs" />
              <p className="text-[10px] text-muted-foreground">The readable note stays visible; the bounded structured value helps COGNOS retrieve durable facts without treating them as instructions.</p>
              <div className="flex gap-2 justify-end">
                <Btn variant="ghost" size="sm" onClick={() => { setIsAdding(false); setNewContent(''); setNewKey(''); setNewValue(''); }}>Cancel</Btn>
                <Btn variant="primary" size="sm" onClick={handleAdd}>Save</Btn>
              </div>
            </Card>
          )}

          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No memories yet. COGNOS extracts them automatically as you talk.
            </p>
          )}

          {filtered.map(mem => (
            <Card key={mem.id} className={`p-3 ${mem.is_enabled ? '' : 'opacity-50'}`}>
              {editingId === mem.id ? (
                <div className="space-y-2">
                  <TextArea value={editContent} onChange={e => setEditContent(e.target.value)} rows={3} />
                  <div className="flex gap-2 justify-end">
                    <IconBtn onClick={() => setEditingId(null)} aria-label="Cancel edit"><X className="w-3.5 h-3.5" /></IconBtn>
                    <Btn variant="primary" size="sm" onClick={() => handleSaveEdit(mem.id)} aria-label="Save edit"><Check className="w-3.5 h-3.5" /></Btn>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-sm leading-relaxed mb-2">{mem.content}</p>
                  {mem.memory_value && (
                    <Disclosure summary="Structured value" className="mb-2">
                      <p className="text-[10px] text-muted-foreground/70 font-mono break-all">
                        {typeof mem.memory_value === 'string' ? mem.memory_value : JSON.stringify(mem.memory_value)}
                      </p>
                    </Disclosure>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="custom" className={LAYER_TONES[mem.memory_type] || ''}>{mem.memory_type}</Badge>
                    <Badge tone="custom" className={LAYER_TONES[mem.memory_layer || mem.memory_type] || ''}>{mem.memory_layer || mem.memory_type || 'events'} layer</Badge>
                    {mem.memory_key && <span className="px-1.5 py-0.5 rounded text-[10px] font-mono text-muted-foreground bg-muted/60">{mem.memory_key}</span>}
                    {mem.evidence_level && <Badge tone="custom" className={EVIDENCE_TONES[mem.evidence_level] || ''}>{mem.evidence_level}</Badge>}
                    {mem.volatility && <Badge tone="custom" className={VOLATILITY_TONES[mem.volatility] || ''}>{mem.volatility}</Badge>}
                    <span className="text-[10px] text-muted-foreground">importance {mem.importance}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <IconBtn onClick={() => handleFavorite(mem)} title={mem.is_favorite ? "Unfavorite (removes its shield)" : "Favorite (shields it from pruning and fading)"} aria-label={mem.is_favorite ? 'Unfavorite' : 'Favorite'} className={mem.is_favorite ? "text-warn" : ""}>
                        <Star className={`w-3.5 h-3.5 ${mem.is_favorite ? "fill-warn" : ""}`} />
                      </IconBtn>
                      <button onClick={() => handleToggle(mem)} className="text-[10px] px-2 py-1 rounded-lg hover:bg-muted text-muted-foreground">
                        {mem.is_enabled ? 'Disable' : 'Enable'}
                      </button>
                      <IconBtn onClick={() => { setEditingId(mem.id); setEditContent(mem.content); }} aria-label="Edit memory"><Edit2 className="w-3.5 h-3.5" /></IconBtn>
                      <IconBtn onClick={() => handleDelete(mem.id)} aria-label="Delete memory" className="hover:text-destructive"><Trash2 className="w-3.5 h-3.5" /></IconBtn>
                    </div>
                  </div>
                </>
              )}
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
