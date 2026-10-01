import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { chunkSpeechText, markdownToSpeechText } from './speechText.js';
import { loadNativePlugin, probeNativeTts } from './ttsNative.js';
import { mapNativeVoices, resolveTtsVoice } from './ttsVoice.js';

export { chunkSpeechText, markdownToSpeechText } from './speechText.js';

const VoiceContext = createContext(null);
const STORAGE_KEY = 'cognos.voice.v1';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  autoSpeak: true,
  voiceURI: '',
  rate: 1,
  pitch: 1,
  volume: 1,
});

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

function normalizeSettings(value = {}) {
  return {
    enabled: value.enabled === true,
    autoSpeak: value.autoSpeak !== false,
    voiceURI: typeof value.voiceURI === 'string' ? value.voiceURI : '',
    rate: clamp(value.rate, 0.6, 1.6, DEFAULT_SETTINGS.rate),
    pitch: clamp(value.pitch, 0.7, 1.3, DEFAULT_SETTINGS.pitch),
    volume: clamp(value.volume, 0, 1, DEFAULT_SETTINGS.volume),
  };
}

function initialSettings() {
  if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function browserSupported() {
  return typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance !== 'undefined';
}

export function VoiceProvider({ children }) {
  // Engine priority: on-device native TTS (works in Android WebViews, where
  // speechSynthesis does not exist) first, browser speechSynthesis as fallback.
  const [engine, setEngine] = useState(() => (browserSupported() ? 'browser' : null));
  const [nativeTts, setNativeTts] = useState(null);
  // One-line probe diagnostics, surfaced in Settings → Voice when speech is
  // unavailable so a device-specific failure can be reported remotely.
  const [probe, setProbe] = useState({ isNative: false, plugin: false, voices: 0, browser: false, error: '' });
  const [settings, setSettingsState] = useState(initialSettings);
  const [voices, setVoices] = useState([]);
  const [speakingId, setSpeakingId] = useState(null);
  const [activePersona, setActivePersonaState] = useState(null);
  const playbackRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const voicesRef = useRef(voices);
  voicesRef.current = voices;
  const personaRef = useRef(activePersona);
  personaRef.current = activePersona;
  const nativeTtsRef = useRef(nativeTts);
  nativeTtsRef.current = nativeTts;

  // --- Native engine detection ------------------------------------------------
  // Runs on mount. getVoices() doubles as the availability probe: if the
  // plugin is missing or the engine isn't ready, we fall back to the browser.
  // The probe retries a few times because the Capacitor native bridge may not
  // be injected yet when the app first mounts (the boot page redirects to the
  // loopback server); a slow bridge must not permanently hide a working engine.
  useEffect(() => {
    let cancelled = false;
    const recordProbe = (patch) => {
      if (!cancelled) setProbe((prev) => ({ ...prev, ...patch }));
    };
    const PROBE_ATTEMPTS = 4;
    (async () => {
      for (let attempt = 0; attempt < PROBE_ATTEMPTS && !cancelled; attempt += 1) {
        const result = await probeNativeTts({
          isNativePlatform: () => Capacitor.isNativePlatform(),
          loadPlugin: loadNativePlugin,
        });
        recordProbe({
          isNative: result.detail.isNative,
          plugin: result.detail.pluginLoaded,
          voices: result.detail.voices,
          error: result.detail.error,
        });
        if (!cancelled && result.ok) {
          // Zero voices is still a working engine — the phone just has no
          // voice data installed. The UI offers the installer prominently.
          setNativeTts(result.tts);
          setVoices(mapNativeVoices(result.rawVoices));
          setEngine('native');
          return;
        }
        if (!cancelled && browserSupported()) {
          recordProbe({ browser: true });
          setEngine('browser');
          return;
        }
        if (attempt < PROBE_ATTEMPTS - 1) {
          await new Promise((r) => { setTimeout(r, 750 * (attempt + 1)); });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // --- Browser voices ----------------------------------------------------------
  const refreshVoices = useCallback(() => {
    if (engine !== 'browser' || !browserSupported()) return;
    const list = window.speechSynthesis.getVoices();
    setVoices([...list].sort((a, b) => {
      if (a.default !== b.default) return a.default ? -1 : 1;
      if (a.lang !== b.lang) return a.lang.localeCompare(b.lang);
      return a.name.localeCompare(b.name);
    }));
  }, [engine]);

  useEffect(() => {
    if (engine !== 'browser' || !browserSupported()) return undefined;
    refreshVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
    const retry = window.setTimeout(refreshVoices, 250);
    return () => {
      window.clearTimeout(retry);
      window.speechSynthesis.removeEventListener?.('voiceschanged', refreshVoices);
    };
  }, [refreshVoices, engine]);

  // --- Settings persistence -----------------------------------------------------
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch { /* private browsing/storage denial must not break voice playback */ }
  }, [settings]);

  // --- Stop ----------------------------------------------------------------------
  const stop = useCallback(() => {
    playbackRef.current += 1;
    if (browserSupported()) {
      try { window.speechSynthesis.cancel(); } catch { /* noop */ }
    }
    // Never awaited: an interrupted native speak() promise may never settle
    // (the plugin clears its callbacks on stop), so awaiting here could hang.
    nativeTtsRef.current?.stop();
    setSpeakingId(null);
  }, []);

  // Unmount: silence both engines.
  useEffect(() => () => { stop(); }, [stop]);

  const updateSettings = useCallback((patch) => {
    setSettingsState(previous => {
      const next = normalizeSettings({
        ...previous,
        ...(typeof patch === 'function' ? patch(previous) : patch),
      });
      settingsRef.current = next;
      return next;
    });
  }, []);

  // --- Browser playback (unchanged behavior) --------------------------------------
  const speakBrowser = useCallback((chunks, id, playback, playbackSettings) => {
    window.speechSynthesis.cancel();
    setSpeakingId(id);
    const selectedVoice = playbackSettings.voiceURI
      ? voicesRef.current.find(voice => voice.voiceURI === playbackSettings.voiceURI)
      : null;
    let index = 0;
    const finish = () => {
      if (playbackRef.current === playback) setSpeakingId(null);
    };
    const playNext = () => {
      if (playbackRef.current !== playback) return;
      if (index >= chunks.length) return finish();
      const utterance = new window.SpeechSynthesisUtterance(chunks[index++]);
      if (selectedVoice) utterance.voice = selectedVoice;
      utterance.rate = playbackSettings.rate;
      utterance.pitch = playbackSettings.pitch;
      utterance.volume = playbackSettings.volume;
      utterance.onend = playNext;
      utterance.onerror = finish;
      try { window.speechSynthesis.speak(utterance); }
      catch { finish(); }
    };
    playNext();
  }, []);

  // --- Native playback --------------------------------------------------------------
  const speakNative = useCallback((chunks, id, playback) => {
    const tts = nativeTtsRef.current;
    if (!tts) return false;
    setSpeakingId(id);
    const shouldContinue = () => playbackRef.current === playback;
    (async () => {
      try {
        const resolved = resolveTtsVoice({
          personaVoice: personaRef.current?.voice,
          settings: settingsRef.current,
          voices: voicesRef.current,
        });
        await tts.speakChunks(chunks, { ...resolved, shouldContinue });
      } catch {
        /* engine errors end the turn quietly; chat is never broken by speech */
      } finally {
        if (playbackRef.current === playback) setSpeakingId(null);
      }
    })();
    return true;
  }, []);

  const speak = useCallback((markdown, { id = 'voice-preview' } = {}) => {
    const text = markdownToSpeechText(markdown);
    const chunks = chunkSpeechText(text);
    if (!chunks.length) return false;

    playbackRef.current += 1;
    const playback = playbackRef.current;
    if (engine === 'native' && nativeTtsRef.current) return speakNative(chunks, id, playback);
    if (engine === 'browser' && browserSupported()) {
      speakBrowser(chunks, id, playback, { ...settingsRef.current });
      return true;
    }
    return false;
  }, [engine, speakBrowser, speakNative]);

  const speakAutomatically = useCallback((markdown, options = {}) => {
    const current = settingsRef.current;
    if (!current.enabled || !current.autoSpeak) return false;
    return speak(markdown, options);
  }, [speak]);

  const toggleEnabled = useCallback(() => {
    updateSettings(previous => ({ enabled: !previous.enabled }));
  }, [updateSettings]);

  // The active persona carries the preferred TTS voice. Switching personas
  // stops in-flight speech so the old voice doesn't finish a long read.
  const setActivePersona = useCallback((persona) => {
    stop();
    setActivePersonaState(persona || null);
  }, [stop]);

  const openInstallVoiceData = useCallback(async () => {
    const tts = nativeTtsRef.current;
    if (engine !== 'native' || !tts) return false;
    try {
      if (Capacitor.getPlatform() !== 'android') return false;
      return await tts.openInstall();
    } catch {
      return false;
    }
  }, [engine]);

  useEffect(() => {
    if (!settings.enabled) stop();
  }, [settings.enabled, stop]);

  const supported = engine === 'native' || engine === 'browser';

  const value = useMemo(() => ({
    engine, // 'native' | 'browser' | null
    supported,
    probe, // { isNative, plugin, voices, browser, error } — diagnostics for Settings
    settings,
    voices,
    speakingId,
    isSpeaking: speakingId !== null,
    activePersona,
    setActivePersona,
    speak,
    speakAutomatically,
    stop,
    updateSettings,
    toggleEnabled,
    openInstallVoiceData,
  }), [engine, supported, probe, settings, voices, speakingId, activePersona, setActivePersona,
    speak, speakAutomatically, stop, updateSettings, toggleEnabled, openInstallVoiceData]);

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice() {
  const value = useContext(VoiceContext);
  if (!value) throw new Error('useVoice must be used inside VoiceProvider');
  return value;
}
