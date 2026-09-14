// Ported from the original src/pages/Settings.jsx.
// DIVERGENCE: no account section, no API-key field, no billing. Keys live in
// server env vars only and are never sent to the browser. What remains is the
// workspace instructions editor (which feeds buildContextSystemPrompt verbatim),
// local browser voice preferences, and runtime status from /api/health.
import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Menu, Check, Square, Volume2, ShieldAlert, Scale } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import { useVoice } from '@/lib/voiceContext';

/** One governance switch row: label, hint, a toggle, and the honest reason it
 *  is disabled (a pin, or no delegation) rather than a switch that lies. */
function GovernanceToggle({ label, hint, on, canToggle, refusal, busy, onFlip }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="font-medium text-foreground/90 flex items-center gap-1.5">
          {label}
          {on ? <span className="text-[10px] text-green-500">on</span> : <span className="text-[10px] text-destructive">off</span>}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{hint}</p>
        {!canToggle && refusal && (
          <p className="text-[10px] text-muted-foreground mt-0.5">{refusal.message}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${label} ${on ? 'on' : 'off'}`}
        disabled={!canToggle || busy}
        onClick={() => onFlip(!on)}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${on ? 'bg-primary' : 'bg-muted-foreground/30'}`}
        title={canToggle ? `${on ? 'Turn ' + label + ' off' : 'Turn ' + label + ' on'}` : (refusal?.message || `${label} is not delegated to this page`)}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-background shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

export default function Settings() {
  const { activeWorkspace, setActiveWorkspace, openSidebar } = useCognos();
  const voice = useVoice();
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [health, setHealth] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [council, setCouncil] = useState(null);
  const [councilBusy, setCouncilBusy] = useState(null);
  const [councilError, setCouncilError] = useState('');

  useEffect(() => {
    setName(activeWorkspace?.name || '');
    setInstructions(activeWorkspace?.instructions || '');
  }, [activeWorkspace]);

  useEffect(() => { api.health().then(setHealth).catch(() => {}); }, []);
  useEffect(() => {
    api.councilSettings().then(setCouncil).catch(() => setCouncil(null));
  }, []);

  const flipCouncil = async (which, enabled) => {
    if (councilBusy) return;
    setCouncilBusy(which); setCouncilError('');
    try {
      const out = await api.setCouncilSwitch(which, enabled);
      setCouncil(out.settings);
      if (out.changed === false) {
        setCouncilError(`${which === 'governor' ? 'The Governor' : 'The Critic'} was already ${enabled ? 'on' : 'off'}.`);
      }
    } catch (e) {
      // A refusal is an answer: re-read the truth so the switch cannot sit in a
      // position the server did not accept.
      setCouncilError(e?.message || `Could not change ${which}`);
      api.councilSettings().then(setCouncil).catch(() => {});
    } finally { setCouncilBusy(null); }
  };

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
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Governance</h3>
            <div className="rounded-xl border border-border bg-card p-3 space-y-4 text-xs">
              <div className="flex items-start gap-2">
                <Scale className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-muted-foreground leading-relaxed">
                  The Critic and the Governor are the two safety seats. Both rest <strong>on</strong>.
                  An operator can pin either in the environment, which outranks this page; with{' '}
                  <span className="font-mono text-foreground/80">COGNOS_COUNCIL_UI_CONTROL=true</span> they are handed to this page, and every flip is recorded.
                </p>
              </div>

              {councilError && <p className="text-destructive">{councilError}</p>}

              <GovernanceToggle
                label="Critic"
                hint="Scores drafts for accuracy, adequacy and unsupported certainty, and requests one bounded revision."
                on={council?.criticEnabled === true}
                canToggle={council?.canToggleCritic === true}
                refusal={council?.criticRefusal}
                busy={councilBusy === 'critic'}
                onFlip={(next) => flipCouncil('critic', next)}
              />

              <GovernanceToggle
                label="Governor"
                hint="The deterministic final veto: empty responses, secret leakage, minimum-cause floors and citation audits."
                on={council?.governorEnabled === true}
                canToggle={council?.canToggleGovernor === true}
                refusal={council?.governorRefusal}
                busy={councilBusy === 'governor'}
                onFlip={(next) => flipCouncil('governor', next)}
              />

              {council?.governorEnabled === false && (
                <p className="flex items-start gap-2 text-[11px] leading-relaxed text-yellow-600 dark:text-yellow-400 bg-yellow-500/10 rounded-lg px-3 py-2">
                  <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    The Governor is off. Nothing deterministic is vetoing answers anymore — empty responses,
                    leaked credentials and unverifiable citations can reach the user. This is the safety net,
                    and it is off until you turn it back on.
                  </span>
                </p>
              )}

              {(council?.governorPinned || council?.criticPinned) && (
                <p className="text-muted-foreground leading-relaxed">
                  An operator pinned {[
                    council.governorPinned ? 'the Governor' : null,
                    council.criticPinned ? 'the Critic' : null,
                  ].filter(Boolean).join(' and ')} in the environment, so this page cannot change it. Remove the
                  pin and restart to hand it back.
                </p>
              )}

              {!(council?.uiControl) && (
                <p className="text-muted-foreground leading-relaxed">
                  These switches are not delegated to this page. Set{' '}
                  <span className="font-mono text-foreground/80">COGNOS_COUNCIL_UI_CONTROL=true</span> and restart
                  to turn them on and off from here.
                </p>
              )}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Runtime</h3>
            <div className="rounded-xl border border-border bg-card p-3 text-xs">
              {health ? (
                <>
                  <Row label="COGNOS self-model" value={`v${health.identityVersion || 'unknown'}`} />
                  <Row label="Model" value={health.model} />
                  <Row label="Fast model" value={health.fastModel} />
                  <Row label="Model deadline" value={health.modelRequestPolicy?.timeoutMs != null ? `${health.modelRequestPolicy.timeoutMs}ms total` : 'unknown'} />
                  <Row label="Transient model retries" value={health.modelRequestPolicy?.maxRetries ?? 'unknown'} />
                  <Row label="Model key configured" value={health.modelKeyConfigured ? 'yes' : 'no'} />
                  <Row label="LLM service tier" value={health.llmServiceTier || 'provider-default'} />
                  <Row label="Prompt-cache routing" value={health.promptCacheKeyConfigured ? 'configured' : 'automatic/provider-default'} />
                  <Row label="Database configured" value={health.databaseConfigured ? 'yes' : 'no'} />
                  <Row label="Web search" value={health.searchProvider} />
                  <Row label="Document/link sources" value={health.sources ? 'enabled' : 'disabled'} />
                  <Row label="Agent mode" value={health.agent?.enabled ? `${(health.agent.modes || []).join(', ')} · writes ${health.agent.autonomousWrites ? 'enabled' : 'disabled'}` : 'disabled'} />
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
