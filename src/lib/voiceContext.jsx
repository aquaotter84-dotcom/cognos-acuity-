import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { chunkSpeechText, markdownToSpeechText } from './speechText.js';

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

export function VoiceProvider({ children }) {
  const supported = typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance !== 'undefined';
  const [settings, setSettingsState] = useState(initialSettings);
  const [voices, setVoices] = useState([]);
  const [speakingId, setSpeakingId] = useState(null);
  const playbackRef = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const refreshVoices = useCallback(() => {
    if (!supported) return;
    const list = window.speechSynthesis.getVoices();
    setVoices([...list].sort((a, b) => {
      if (a.default !== b.default) return a.default ? -1 : 1;
      if (a.lang !== b.lang) return a.lang.localeCompare(b.lang);
      return a.name.localeCompare(b.name);
    }));
  }, [supported]);

  useEffect(() => {
    if (!supported) return undefined;
    refreshVoices();
    window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices);
    // Safari may populate the list shortly after mount without firing the event.
    const retry = window.setTimeout(refreshVoices, 250);
    return () => {
      window.clearTimeout(retry);
      window.speechSynthesis.removeEventListener?.('voiceschanged', refreshVoices);
      playbackRef.current += 1;
      window.speechSynthesis.cancel();
    };
  }, [refreshVoices, supported]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch { /* private browsing/storage denial must not break voice playback */ }
  }, [settings]);

  const stop = useCallback(() => {
    playbackRef.current += 1;
    if (supported) window.speechSynthesis.cancel();
    setSpeakingId(null);
  }, [supported]);

  const updateSettings = useCallback((patch) => {
    setSettingsState(previous => {
      const next = normalizeSettings({
        ...previous,
        ...(typeof patch === 'function' ? patch(previous) : patch),
      });
      // Keep async SSE callbacks aligned even before React's next render.
      settingsRef.current = next;
      return next;
    });
  }, []);

  const speak = useCallback((markdown, { id = 'voice-preview' } = {}) => {
    if (!supported) return false;
    const text = markdownToSpeechText(markdown);
    const chunks = chunkSpeechText(text);
    if (!chunks.length) return false;

    playbackRef.current += 1;
    const playback = playbackRef.current;
    const playbackSettings = { ...settingsRef.current };
    window.speechSynthesis.cancel();
    setSpeakingId(id);

    const selectedVoice = playbackSettings.voiceURI
      ? voices.find(voice => voice.voiceURI === playbackSettings.voiceURI)
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
      // Cancellation from a newer playback has a different playback token, so
      // finish() cannot clear the newer indicator. Other engine errors do clear it.
      utterance.onerror = finish;
      try { window.speechSynthesis.speak(utterance); }
      catch { finish(); }
    };
    playNext();
    return true;
  }, [supported, voices]);

  const speakAutomatically = useCallback((markdown, options = {}) => {
    const current = settingsRef.current;
    if (!current.enabled || !current.autoSpeak) return false;
    return speak(markdown, options);
  }, [speak]);

  const toggleEnabled = useCallback(() => {
    updateSettings(previous => ({ enabled: !previous.enabled }));
  }, [updateSettings]);

  useEffect(() => {
    if (!settings.enabled) stop();
  }, [settings.enabled, stop]);

  const value = useMemo(() => ({
    engine: 'browser',
    supported,
    settings,
    voices,
    speakingId,
    isSpeaking: speakingId !== null,
    speak,
    speakAutomatically,
    stop,
    updateSettings,
    toggleEnabled,
  }), [settings, speak, speakAutomatically, speakingId, stop, supported, toggleEnabled, updateSettings, voices]);

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice() {
  const value = useContext(VoiceContext);
  if (!value) throw new Error('useVoice must be used inside VoiceProvider');
  return value;
}
