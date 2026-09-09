// Ported from the original src/components/chat/ChatInput.jsx.
//
// DIVERGENCE: the attach / screen-share / camera controls are gone. They existed
// only because Base44 provided a hosted file store (integrations.Core.UploadFile)
// that returned public URLs. There is no honest equivalent here without adding a
// blob store, so rather than fake a broken paperclip the control was removed.
// Voice dictation (Web Speech API) is browser-native and is kept.

import { useState, useRef, useEffect } from 'react';
import { Send, Square, Mic, MicOff, FileText, Link as LinkIcon, X } from 'lucide-react';
import SourceComposer from '@/components/chat/SourceComposer';

function useSpeechRecognition(onFinal) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const ref = useRef(null);
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

  const start = () => {
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
      if (final) { onFinal(final.trim()); setInterim(''); }
    };
    rec.onend = () => { setListening(false); setInterim(''); };
    rec.start();
    ref.current = rec;
    setListening(true);
  };
  const stop = () => { ref.current?.stop(); setListening(false); };

  return { supported: Boolean(SR), listening, interim, start, stop };
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
              onClick={() => (listening ? stop() : start())}
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
