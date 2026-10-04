import { useState, useEffect, useCallback } from 'react';
import { Trash2, AlertTriangle, Database, CheckCircle2, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Btn, SectionCard, TextInput, Badge } from '@/components/ui/CognosUi';

const CLEAR_ALL_PHRASE = 'CLEAR EVERYTHING';

function CategoryRow({ cat, onCleared, disabled }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const doClear = async () => {
    setBusy(true); setError(null);
    try {
      const result = await api.clearDataCategory(cat.key);
      setConfirming(false);
      onCleared?.(result);
    } catch (e) {
      setError(e.message || 'Could not clear.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/50 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{cat.title}</span>
          <Badge tone={cat.count > 0 ? 'info' : 'muted'}>{cat.count} {cat.count === 1 ? 'item' : 'items'}</Badge>
        </div>
        <p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">{cat.description}</p>
        {cat.warning && (
          <p className="text-warn text-xs mt-1 flex items-start gap-1">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {cat.warning}
          </p>
        )}
        {error && <p className="text-destructive text-xs mt-1">{error}</p>}
      </div>
      <div className="shrink-0">
        {confirming ? (
          <div className="flex items-center gap-1.5">
            <Btn variant="danger" size="sm" onClick={doClear} disabled={busy || disabled}>
              {busy ? 'Clearing…' : `Clear ${cat.count}`}
            </Btn>
            <Btn variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy} aria-label="Cancel">
              <X className="w-3.5 h-3.5" />
            </Btn>
          </div>
        ) : (
          <Btn variant="secondary" size="sm" onClick={() => setConfirming(true)} disabled={disabled || cat.count === 0}>
            <Trash2 className="w-3.5 h-3.5" /> Clear
          </Btn>
        )}
      </div>
    </div>
  );
}

export default function DataCleanupSection() {
  const [cats, setCats] = useState(null);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState(null); // { ok, text }
  const [phrase, setPhrase] = useState('');
  const [clearingAll, setClearingAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api.dataCleanupCounts();
      setCats(data.categories);
      setTotal(data.total);
    } catch (e) {
      setMessage({ ok: false, text: e.message || 'Could not load stored-data counts.' });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCleared = (result) => {
    const n = Object.values(result.clearedTables || {}).reduce((a, b) => a + b, 0);
    let text = `${result.title} cleared — ${n} ${n === 1 ? 'item' : 'items'} removed.`;
    if (result.backupPath) text += ` Backed up first to ${result.backupPath}.`;
    setMessage({ ok: true, text });
    refresh();
  };

  const clearAll = async () => {
    setClearingAll(true); setMessage(null);
    try {
      const result = await api.clearAllData(phrase);
      const n = Object.values(result.categories || {}).reduce(
        (a, tables) => a + Object.values(tables).reduce((x, y) => x + y, 0), 0);
      let text = `Everything cleared — ${n} ${n === 1 ? 'item' : 'items'} removed across all categories.`;
      if (result.backupPath) text += ` Memories backed up first to ${result.backupPath}.`;
      setMessage({ ok: true, text });
      setPhrase('');
      refresh();
    } catch (e) {
      setMessage({ ok: false, text: e.message || 'Could not clear everything.' });
    } finally {
      setClearingAll(false);
    }
  };

  return (
    <SectionCard title="Stored data" bodyClassName="space-y-3 text-sm">
      <div className="flex items-start gap-2">
        <Database className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
        <p className="text-muted-foreground leading-relaxed">
          Every category of data COGNOS keeps, with live counts. Clearing is permanent —
          each category asks you to confirm first. Accounts, settings, keys, and
          endpoints are never touched here.
        </p>
      </div>

      {message && (
        <p className={message.ok ? 'text-ok flex items-start gap-1.5' : 'text-destructive'}>
          {message.ok && <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
          <span>{message.text}</span>
        </p>
      )}

      {cats === null ? (
        <p className="text-muted-foreground">{refreshing ? 'Loading…' : 'Could not load.'}</p>
      ) : (
        <div>
          {cats.map((cat) => (
            <CategoryRow key={cat.key} cat={cat} onCleared={handleCleared} disabled={clearingAll} />
          ))}
        </div>
      )}

      <div className="pt-3 mt-1 border-t border-destructive/30">
        <p className="font-medium text-destructive flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> Clear everything
        </p>
        <p className="text-muted-foreground text-xs mt-1 leading-relaxed">
          Removes all {total} stored {total === 1 ? 'item' : 'items'} across every category above.
          Memories are backed up to a file first; the ledger gets a tombstone entry.
          Type <span className="font-mono font-bold">{CLEAR_ALL_PHRASE}</span> to enable.
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <TextInput
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder={CLEAR_ALL_PHRASE}
            autoComplete="off" autoCapitalize="characters" spellCheck="false"
            className="max-w-[220px]"
          />
          <Btn
            variant="danger"
            size="sm"
            onClick={clearAll}
            disabled={clearingAll || phrase !== CLEAR_ALL_PHRASE}
          >
            {clearingAll ? 'Clearing…' : 'Clear everything'}
          </Btn>
        </div>
      </div>
    </SectionCard>
  );
}
