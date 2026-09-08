// Ported from the original src/pages/Settings.jsx.
// DIVERGENCE: no account section, no API-key field, no billing. Keys live in
// server env vars only and are never sent to the browser. What remains is the
// workspace instructions editor (which feeds buildContextSystemPrompt verbatim),
// local browser voice preferences, and runtime status from /api/health.
import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Menu, Check, Square, Volume2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import { useVoice } from '@/lib/voiceContext';

export default function Settings() {
  const { activeWorkspace, setActiveWorkspace, openSidebar } = useCognos();
  const voice = useVoice();
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
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Voice</h3>
            <div className="rounded-xl border border-border bg-card p-3 space-y-4 text-xs">
              {!voice.supported ? (
                <p className="text-muted-foreground leading-relaxed">
                  Speech output is not available in this browser. COGNOS will continue to work normally in text mode.
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium text-foreground/90">Voice mode</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">Speak governed answers automatically after the Governor approves them.</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label="Voice mode"
                      aria-checked={voice.settings.enabled}
                      onClick={voice.toggleEnabled}
                      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${voice.settings.enabled ? 'bg-accent' : 'bg-muted'}`}
                    >
                      <span className={`absolute left-1 top-1 w-4 h-4 rounded-full bg-white transition-transform ${voice.settings.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>

                  <label className="flex items-center gap-2 text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={voice.settings.autoSpeak}
                      onChange={event => voice.updateSettings({ autoSpeak: event.target.checked })}
                      className="accent-[hsl(var(--accent))]"
                    />
                    Automatically speak each new final response while voice mode is on
                  </label>

                  <label className="block text-[11px] text-muted-foreground">
                    Browser voice
                    <select
                      value={voice.settings.voiceURI}
                      onChange={event => voice.updateSettings({ voiceURI: event.target.value })}
                      className="mt-1 block w-full bg-muted/50 border border-border rounded-lg px-2.5 py-2 text-xs text-foreground outline-none focus:border-primary/50"
                    >
                      <option value="">System default</option>
                      {voice.voices.map((item, index) => (
                        <option key={`${item.voiceURI}-${index}`} value={item.voiceURI}>
                          {item.name} — {item.lang}{item.localService ? '' : ' · network'}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="grid sm:grid-cols-3 gap-4">
                    <label className="text-[11px] text-muted-foreground">
                      Speed <span className="float-right tabular-nums text-foreground/80">{voice.settings.rate.toFixed(2)}×</span>
                      <input
                        type="range" min="0.6" max="1.6" step="0.05"
                        value={voice.settings.rate}
                        onChange={event => voice.updateSettings({ rate: Number(event.target.value) })}
                        className="mt-2 w-full accent-[hsl(var(--accent))]"
                      />
                    </label>
                    <label className="text-[11px] text-muted-foreground">
                      Pitch <span className="float-right tabular-nums text-foreground/80">{voice.settings.pitch.toFixed(2)}</span>
                      <input
                        type="range" min="0.7" max="1.3" step="0.05"
                        value={voice.settings.pitch}
                        onChange={event => voice.updateSettings({ pitch: Number(event.target.value) })}
                        className="mt-2 w-full accent-[hsl(var(--accent))]"
                      />
                    </label>
                    <label className="text-[11px] text-muted-foreground">
                      Volume <span className="float-right tabular-nums text-foreground/80">{Math.round(voice.settings.volume * 100)}%</span>
                      <input
                        type="range" min="0" max="1" step="0.05"
                        value={voice.settings.volume}
                        onChange={event => voice.updateSettings({ volume: Number(event.target.value) })}
                        className="mt-2 w-full accent-[hsl(var(--accent))]"
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => voice.speakingId === 'voice-preview'
                        ? voice.stop()
                        : voice.speak("Hello. I'm COGNOS. Voice mode is ready, and I will only speak the council's governed final answer.", { id: 'voice-preview' })}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 transition-colors"
                    >
                      {voice.speakingId === 'voice-preview' ? <Square className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                      {voice.speakingId === 'voice-preview' ? 'Stop preview' : 'Test voice'}
                    </button>
                    <p className="text-[10px] text-muted-foreground/60 flex-1 min-w-[12rem]">
                      Browser-native playback: no audio is uploaded, stored, or sent to a separate speech provider.
                    </p>
                  </div>
                </>
              )}
            </div>
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
