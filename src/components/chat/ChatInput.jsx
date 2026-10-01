// Ported from the original src/components/chat/ChatInput.jsx.
//
// DIVERGENCE: the attach / screen-share / camera controls are gone. They existed
// only because Base44 provided a hosted file store (integrations.Core.UploadFile)
// that returned public URLs. There is no honest equivalent here without adding a
// blob store, so rather than fake a broken paperclip the control was removed.
// Voice dictation prefers the native speech-recognition plugin on Android
// (Web Speech API is not exposed to Android WebViews) and falls back to the
// browser's Web Speech API everywhere else.

import { useState, useRef, useEffect, useMemo } from 'react';
import { Send, Square, Mic, MicOff, FileText, Link as LinkIcon, X } from 'lucide-react';
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

export default function ChatInput({
  onSend,
  disabled,
  isProcessing,
  onStop,
  conversationId,
  sources = [],
  onSourcesChange = () => {},
  agentMode = 'off',
  onAgentModeChange = () => {}
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
            agentMode={agentMode}
            onAgentModeChange={onAgentModeChange}
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
