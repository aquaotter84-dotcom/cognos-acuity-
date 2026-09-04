// Ported from the original src/pages/Settings.jsx.
// DIVERGENCE: no account section, no API-key field, no billing. Keys live in
// server env vars only and are never sent to the browser. What remains is the
// workspace instructions editor (which feeds buildContextSystemPrompt verbatim)
// and a read-only runtime status panel from /api/health.
import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Menu, Check } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';

export default function Settings() {
  const { activeWorkspace, setActiveWorkspace, openSidebar } = useCognos();
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [health, setHealth] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setName(activeWorkspace?.name || '');
    setInstructions(activeWorkspace?.instructions || '');
  }, [activeWorkspace]);

  useEffect(() => { api.health().then(setHealth).catch(() => {}); }, []);

  const save = async () => {
    try {
      const ws = await api.updateWorkspace({ name, instructions });
      setActiveWorkspace(ws);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { setError(e.message); }
  };

  const Row = ({ label, value }) => (
    <div className="flex justify-between gap-4 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground/80 text-right break-all">{String(value)}</span>
    </div>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-2 px-3 md:px-4 py-3 border-b border-border shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <button onClick={openSidebar} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted"><Menu className="w-5 h-5" /></button>
        <SettingsIcon className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Settings</h2>
      </header>
      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 min-h-0">
        <div className="max-w-2xl mx-auto space-y-6">
          {error && <p className="text-xs text-destructive">{error}</p>}

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Workspace</h3>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Workspace name"
              className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50" />
            <textarea value={instructions} onChange={e => setInstructions(e.target.value)} rows={6}
              placeholder="Workspace instructions — injected into every council system prompt."
              className="w-full bg-card border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-primary/50 resize-y" />
            <button onClick={save} className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground">
              {saved ? <><Check className="w-3.5 h-3.5" /> Saved</> : 'Save'}
            </button>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Runtime</h3>
            <div className="rounded-xl border border-border bg-card p-3 text-xs">
              {health ? (
                <>
                  <Row label="Model" value={health.model} />
                  <Row label="Fast model" value={health.fastModel} />
                  <Row label="Model key configured" value={health.modelKeyConfigured ? 'yes' : 'no'} />
                  <Row label="Database configured" value={health.databaseConfigured ? 'yes' : 'no'} />
                  <Row label="Web search" value={health.searchProvider} />
                  <Row label="Access gate" value={health.gate ? 'enabled' : 'disabled'} />
                </>
              ) : <p className="text-muted-foreground">Loading…</p>}
              <p className="text-muted-foreground/60 mt-3 leading-relaxed">
                Secrets are read from server environment variables and are never sent to the browser.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
