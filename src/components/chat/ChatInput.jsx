// Ported from the original src/components/chat/ChatInput.jsx.
//
// DIVERGENCE: the attach / screen-share / camera controls are gone. They existed
// only because Base44 provided a hosted file store (integrations.Core.UploadFile)
// that returned public URLs. There is no honest equivalent here without adding a
// blob store, so rather than fake a broken paperclip the control was removed.
// Voice dictation prefers the native speech-recognition plugin on Android
// (Web Speech API is not exposed to Android WebViews) and falls back to the
// browser's Web Speech API everywhere else.

import { useState, useRef, useEffect, useMemo, useSyncExternalStore } from 'react';
import { Send, Square, Mic, MicOff, FileText, Link as LinkIcon, X, Layers, Play } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { useVoice } from '@/lib/voiceContext';
import SourceComposer from '@/components/chat/SourceComposer';

function useSpeechRecognition(onFinal) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const webRef = useRef(null);
  const nativeListeners = useRef([]);
  const nativeTranscript = useRef('');
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const nativeAvailable = useMemo(() => {
    try { return Capacitor.isNativePlatform() && !!SpeechRecognition; }
    catch { return false; }
  }, []);

  const stopNative = async () => {
    try { await SpeechRecognition.stop(); } catch { /* already stopped */ }
    (nativeListeners.current || []).forEach((l) => { try { l.remove(); } catch { /* noop */ } });
    nativeListeners.current = [];
    const said = nativeTranscript.current.trim();
    nativeTranscript.current = '';
    setListening(false);
    setInterim('');
    if (said) onFinalRef.current(said);
  };

  const startNative = async () => {
    const avail = await SpeechRecognition.available().catch(() => ({ available: false }));
    if (!avail || avail.available === false) throw new Error('speech recognition unavailable');
    const perm = await SpeechRecognition.requestPermissions().catch(() => null);
    if (perm && perm.speechRecognition && perm.speechRecognition !== 'granted') {
      throw new Error('microphone permission denied');
    }
    nativeTranscript.current = '';
    nativeListeners.current = [
      await SpeechRecognition.addListener('partialResults', (d) => {
        const m = (d && d.matches) || [];
        if (m.length) { nativeTranscript.current = m[0]; setInterim(m[0]); }
      }),
      await SpeechRecognition.addListener('listeningState', (s) => {
        if (s && s.status === 'stopped') stopNative();
      }),
    ];
    await SpeechRecognition.start({ language: 'en-US', maxResults: 1, partialResults: true, popup: false });
    setListening(true);
  };

  const startWeb = () => {
    if (!SR) return;
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let final = '';
      let inter = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else inter += t;
      }
      setInterim(inter);
      if (final) { onFinalRef.current(final.trim()); setInterim(''); }
    };
    rec.onend = () => { setListening(false); setInterim(''); };
    rec.onerror = () => { setListening(false); setInterim(''); };
    rec.start();
    webRef.current = rec;
    setListening(true);
  };

  const start = async () => {
    if (nativeAvailable) {
      try { await startNative(); return; }
      catch { /* fall through to the web API */ }
    }
    startWeb();
  };

  const stop = () => {
    if (nativeAvailable && nativeListeners.current.length) { stopNative(); return; }
    try { webRef.current?.stop(); } catch { /* noop */ }
    setListening(false);
  };

  useEffect(() => () => {
    try { webRef.current?.stop(); } catch { /* noop */ }
    (nativeListeners.current || []).forEach((l) => { try { l.remove(); } catch { /* noop */ } });
  }, []);

  return { supported: nativeAvailable || Boolean(SR), listening, interim, start, stop };
}

// Phase 37c — the follow-up queue strip. Sits right above the composer and
// shows every message waiting its turn: tap a row's X to drop it, or hit
// "Send queued" to resume a paused queue and drain it in order. Warm,
// rounded, mobile-first: previews truncate, the whole strip collapses to
// nothing when the queue is empty.
function QueueStrip({ queue, onResume }) {
  const snap = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const pending = snap.pending;
  if (pending.length === 0) return null;
  const preview = (t) => (t.length > 56 ? t.slice(0, 56) + '…' : t);
  return (
    <div className="max-w-3xl mx-auto mb-2 rounded-2xl border border-border bg-card/90 backdrop-blur px-3 py-2 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/80 min-w-0">
          <Layers className="w-3.5 h-3.5 text-primary shrink-0" aria-hidden />
          <span className="truncate">
            {pending.length === 1 ? '1 queued' : `${pending.length} queued`}
            {snap.paused ? ' — paused' : snap.running ? ' — sending…' : ''}
          </span>
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onResume}
          className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary hover:bg-primary/20 active:bg-primary/25 text-xs font-medium px-2.5 py-1 transition-colors shrink-0"
        >
          <Play className="w-3 h-3" aria-hidden />
          Send queued
        </button>
      </div>
      <ul className="mt-1.5 space-y-1">
        {pending.map((m) => (
          <li key={m.id} className="flex items-center gap-2 rounded-xl bg-muted/50 px-2.5 py-1.5">
            <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate">{preview(m.text)}</span>
            <button
              type="button"
              onClick={() => queue.remove(m.id)}
              aria-label="Remove queued message"
              className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 active:bg-destructive/20 transition-colors shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ChatInput({
  onSend,
  disabled,
  isProcessing,
  onStop,
  conversationId,
  sources = [],
  onSourcesChange = () => {},
  agentMode = 'research',
  // Phase 37c — the follow-up queue (ConversationQueue instance) and the
  // resume-and-drain callback. `disabled` now means "no workspace"; the
  // composer itself stays live and editable while a reply streams.
  // v51 — agentMode still rides along with every send, but the selector UI
  // moved to the consolidated "How COGNOS answers" sheet; the composer row
  // keeps only the message itself, attachments, dictation, and send.
  queue = null,
  onQueueResume = () => {},
}) {
  const [text, setText] = useState('');
  const textareaRef = useRef(null);
  const { supported: micSupported, listening, interim, start, stop } = useSpeechRecognition(
    (t) => setText(prev => (prev ? prev.trim() + ' ' : '') + t)
  );
  // Audio focus: never let the mic hear COGNOS talking to itself. Starting
  // dictation silences any in-flight speech first.
  const { stop: stopSpeaking } = useVoice();
  const startDictation = async () => {
    try { stopSpeaking(); } catch { /* voice provider not mounted */ }
    await start();
  };
  const displayText = listening && interim ? (text ? text + ' ' : '') + interim : text;

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, { sources, agentMode });
    setText('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }
  }, [text]);

  return (
    <div
      className="border-t border-border bg-background/95 backdrop-blur p-3 md:p-4"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
    >
      {queue && <QueueStrip queue={queue} onResume={onQueueResume} />}
      <div className="relative max-w-3xl mx-auto bg-card border border-border rounded-2xl p-2 focus-within:border-primary/50 transition-colors">
        {sources.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pb-2">
            {sources.map(source => (
              <span key={source.id} className="inline-flex items-center gap-1 max-w-[220px] rounded-md bg-primary/10 text-primary px-2 py-1 text-[10px]">
                {source.kind === 'link' ? <LinkIcon className="w-3 h-3 shrink-0" /> : <FileText className="w-3 h-3 shrink-0" />}
                <span className="truncate">{source.name}</span>
                <button
                  type="button"
                  onClick={() => onSourcesChange(sources.filter(item => item.id !== source.id))}
                  className="hover:text-destructive"
                  aria-label={`Remove ${source.name}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <SourceComposer
            conversationId={conversationId}
            disabled={disabled}
            sources={sources}
            onSourcesChange={onSourcesChange}
          />
          {micSupported && (
            <button
              onClick={() => (listening ? stop() : startDictation())}
              className={`p-2 rounded-xl transition-colors ${listening ? 'bg-destructive text-destructive-foreground animate-pulse' : 'text-muted-foreground hover:text-foreground'}`}
              title={listening ? 'Stop listening' : 'Speak'}
            >
              {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          )}
          <textarea
            ref={textareaRef}
            value={displayText}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message COGNOS..."
            rows={1}
            className="flex-1 bg-transparent resize-none outline-none text-base md:text-sm py-2 placeholder:text-muted-foreground/60 scrollbar-thin"
          />
          {isProcessing ? (
            <button onClick={onStop} className="p-2 rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors" title="Stop">
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={handleSend} disabled={disabled || !text.trim()} className="p-2 rounded-xl bg-primary text-primary-foreground disabled:opacity-30 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors">
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
