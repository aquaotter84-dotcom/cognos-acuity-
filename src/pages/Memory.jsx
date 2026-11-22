// Search, enable/disable, edit, delete, add, and protect memories.
// Technical classification stays available without leading the experience.

import { useState, useEffect } from 'react';
import { Brain, Search, Plus, Trash2, Edit2, Check, X, Menu, Star } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import {
  Btn, IconBtn, Card, Badge, TextInput, TextArea, Select, Disclosure, EmptyState, Field,
  LAYER_TONES, EVIDENCE_TONES, VOLATILITY_TONES,
} from '@/components/ui/CognosUi';

const LAYER_LABEL = {
  events: 'Moment',
  knowledge: 'Reference',
  entities: 'Person, place, or thing',
  goals: 'Goal',
  self: 'Assistant note',
};

const EVIDENCE_LABEL = {
  direct: 'Directly stated',
  repeated: 'Repeatedly confirmed',
  inferred: 'Inferred',
  assumed: 'Assumed',
};

const VOLATILITY_LABEL = {
  low: 'Lasting',
  medium: 'May change',
  high: 'Likely temporary',
};

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

  const resetAdd = () => {
    setIsAdding(false);
    setNewContent('');
    setNewKey('');
    setNewValue('');
    setNewLayer('events');
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
      resetAdd();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-2 px-3 md:px-4 py-3 border-b border-border shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <button aria-label="Open navigation" onClick={openSidebar} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted"><Menu className="w-5 h-5" /></button>
        <Brain className="w-4 h-4 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Memory</h2>
          <p className="hidden sm:block text-sm text-muted-foreground">Review what COGNOS carries into your conversations.</p>
        </div>
        <Btn variant={isAdding ? 'ghost' : 'secondary'} size="sm" onClick={() => isAdding ? resetAdd() : setIsAdding(true)}>
          {isAdding ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {isAdding ? 'Cancel' : 'Add memory'}
        </Btn>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 min-h-0">
        <div className="max-w-3xl mx-auto space-y-4">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          {memories.length > 0 && (
            <div className="flex items-center gap-2 min-h-11 px-3 rounded-lg bg-muted/40 border border-border">
              <Search className="w-4 h-4 text-muted-foreground shrink-0" />
              <input
                aria-label="Search memories"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search your memories"
                className="bg-transparent outline-none text-base flex-1 min-w-0 min-h-11 placeholder:text-muted-foreground"
              />
            </div>
          )}

          {isAdding && (
            <Card className="p-4">
              <form onSubmit={e => { e.preventDefault(); handleAdd(); }} className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold">Add a memory</h3>
                  <p className="text-sm text-muted-foreground mt-1">Save a preference, decision, or useful fact in your own words.</p>
                </div>
                <Field label="What should COGNOS remember?">
                  <TextArea
                    autoFocus
                    value={newContent}
                    onChange={e => setNewContent(e.target.value)}
                    rows={3}
                    placeholder="For example, I prefer concise answers with a clear next step."
                  />
                </Field>
                <Disclosure summary="Advanced options">
                  <div className="space-y-4 pt-1">
                    <Field label="Category" hint="This helps COGNOS organize the memory. The default works for most notes.">
                      <Select value={newLayer} onChange={e => setNewLayer(e.target.value)}>
                        <option value="events">Moment — something that happened</option>
                        <option value="knowledge">Reference — durable information</option>
                        <option value="entities">Person, place, or thing</option>
                        <option value="goals">Goal — something in progress</option>
                        <option value="self">Assistant note</option>
                      </Select>
                    </Field>
                    <Field label="Stable key (optional)" hint="A technical identifier used to find and update this exact memory.">
                      <TextInput value={newKey} onChange={e => setNewKey(e.target.value)} placeholder="For example, user.preference.style" className="font-mono text-sm" />
                    </Field>
                    <Field label="Structured value JSON (optional)" hint="A bounded, machine-readable value. It is treated as data, never as instructions.">
                      <TextArea
                        value={newValue}
                        onChange={e => setNewValue(e.target.value)}
                        rows={3}
                        placeholder='{"value":"concise"}'
                        className="font-mono text-sm"
                      />
                    </Field>
                  </div>
                </Disclosure>
                <div className="flex gap-2 justify-end">
                  <Btn type="button" variant="ghost" onClick={resetAdd}>Cancel</Btn>
                  <Btn type="submit" variant="primary" disabled={!newContent.trim()}>Save memory</Btn>
                </div>
              </form>
            </Card>
          )}

          {memories.length === 0 && !isAdding && (
            <EmptyState
              icon={Brain}
              title="Nothing saved yet."
              body="COGNOS saves useful details as you talk. You can also add a preference, decision, or fact yourself."
              action={<Btn variant="primary" onClick={() => setIsAdding(true)}><Plus className="w-4 h-4" /> Add your first memory</Btn>}
            />
          )}

          {memories.length > 0 && filtered.length === 0 && (
            <EmptyState
              icon={Search}
              title="No memories match that search."
              body="Try a different word, or clear the search to see everything."
              action={<Btn variant="secondary" onClick={() => setSearch('')}>Clear search</Btn>}
            />
          )}

          {filtered.map(mem => {
            const layer = mem.memory_layer || mem.memory_type || 'events';
            return (
              <Card key={mem.id} className={`p-4 ${mem.is_enabled ? '' : 'bg-muted/20'}`}>
                {editingId === mem.id ? (
                  <div className="space-y-3">
                    <Field label="Edit memory">
                      <TextArea autoFocus value={editContent} onChange={e => setEditContent(e.target.value)} rows={3} />
                    </Field>
                    <div className="flex gap-2 justify-end">
                      <Btn variant="ghost" onClick={() => setEditingId(null)}><X className="w-4 h-4" /> Cancel</Btn>
                      <Btn variant="primary" onClick={() => handleSaveEdit(mem.id)} disabled={!editContent.trim()}><Check className="w-4 h-4" /> Save changes</Btn>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-base leading-relaxed">{mem.content}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      <Badge tone="custom" className={LAYER_TONES[layer] || ''}>{LAYER_LABEL[layer] || layer}</Badge>
                      {!mem.is_enabled && <Badge>Not in use</Badge>}
                      {mem.is_favorite && <Badge tone="warn"><Star className="w-3.5 h-3.5 fill-warn" /> Protected</Badge>}
                    </div>

                    <Disclosure summary="Memory details" className="mt-3">
                      <div className="space-y-3 text-sm text-muted-foreground">
                        <div className="flex flex-wrap gap-1.5">
                          {mem.memory_type && <Badge tone="custom" className={LAYER_TONES[mem.memory_type] || ''}>Type: {mem.memory_type}</Badge>}
                          <Badge tone="custom" className={LAYER_TONES[layer] || ''}>Layer: {layer}</Badge>
                          {mem.evidence_level && <Badge tone="custom" className={EVIDENCE_TONES[mem.evidence_level] || ''}>Evidence: {EVIDENCE_LABEL[mem.evidence_level] || mem.evidence_level}</Badge>}
                          {mem.volatility && <Badge tone="custom" className={VOLATILITY_TONES[mem.volatility] || ''}>Change: {VOLATILITY_LABEL[mem.volatility] || mem.volatility}</Badge>}
                        </div>
                        {mem.memory_key && <p><span className="font-medium text-foreground">Stable key: </span><span className="font-mono break-all">{mem.memory_key}</span></p>}
                        <p><span className="font-medium text-foreground">Importance: </span>{mem.importance} out of 10</p>
                        {mem.memory_value && (
                          <div>
                            <p className="font-medium text-foreground mb-1">Structured value</p>
                            <pre className="text-xs font-mono whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-3">{typeof mem.memory_value === 'string' ? mem.memory_value : JSON.stringify(mem.memory_value, null, 2)}</pre>
                          </div>
                        )}
                      </div>
                    </Disclosure>

                    <div className="flex flex-wrap items-center justify-end gap-1 border-t border-border/60 mt-3 pt-2">
                      <IconBtn
                        onClick={() => handleFavorite(mem)}
                        title={mem.is_favorite ? 'Remove protection from pruning and fading' : 'Protect this memory from pruning and fading'}
                        aria-label={mem.is_favorite ? 'Remove memory protection' : 'Protect memory'}
                        className={mem.is_favorite ? 'text-warn' : ''}
                      >
                        <Star className={`w-4 h-4 ${mem.is_favorite ? 'fill-warn' : ''}`} />
                      </IconBtn>
                      <Btn variant="ghost" size="sm" onClick={() => handleToggle(mem)}>{mem.is_enabled ? 'Disable' : 'Enable'}</Btn>
                      <IconBtn onClick={() => { setEditingId(mem.id); setEditContent(mem.content); }} aria-label="Edit memory"><Edit2 className="w-4 h-4" /></IconBtn>
                      <IconBtn onClick={() => handleDelete(mem.id)} aria-label="Delete memory" className="hover:text-destructive"><Trash2 className="w-4 h-4" /></IconBtn>
                    </div>
                  </>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
