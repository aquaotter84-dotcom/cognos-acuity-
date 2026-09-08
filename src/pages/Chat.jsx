// Ported from the original src/pages/Chat.jsx.
//
// The send path is now ONE function, handleSend, front to back:
//   handleSend -> sendMessage() (SSE) -> /api/chat -> runCouncilTurn -> events
// There is no second path, no fake typewriter, no orphaned tail. The original
// simulated streaming locally by revealing an already-complete string; that
// simulation is deleted. Council progress streams live, while answer chunks are
// released only after the Governor has approved the complete final text.
//
// DIVERGENCES: no base44 client, no auth, no attachments/vision (no blob store),
// and no LiveKit dependency. Browser-native speech output can auto-speak only
// the governed final answer. Style selector and the web-search toggle remain.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Menu, Globe, Volume2, VolumeX } from 'lucide-react';
import { api, sendMessage } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import { useVoice } from '@/lib/voiceContext';
import ChatMessage from '@/components/chat/ChatMessage';
import ChatInput from '@/components/chat/ChatInput';
import WelcomeScreen from '@/components/chat/WelcomeScreen';

const STYLES = ['balanced', 'casual', 'technical', 'strategic'];

export default function Chat() {
  const { activeWorkspace, setActiveConversationId, refreshConversations, openSidebar } = useCognos();
  const {
    supported: voiceSupported,
    settings: voiceSettings,
    isSpeaking,
    speakAutomatically,
    stop: stopSpeaking,
    toggleEnabled: toggleVoiceMode,
  } = useVoice();
  const [searchParams, setSearchParams] = useSearchParams();
  const conversationId = searchParams.get('c');

  const [messages, setMessages] = useState([]);
  const [councilTraces, setCouncilTraces] = useState({});
  const [conversationSummary, setConversationSummary] = useState(null);
  const [style, setStyle] = useState('balanced');
  const [webSearch, setWebSearch] = useState(false);
  const [selectedSources, setSelectedSources] = useState([]);
  const [agentMode, setAgentMode] = useState('off');
  const [isProcessing, setIsProcessing] = useState(false);
  const [draft, setDraft] = useState(null);   // { text, live } — the in-flight assistant turn
  const abortRef = useRef(null);
  const messagesEndRef = useRef(null);

  useEffect(() => {
    setActiveConversationId(conversationId);
    setSelectedSources([]);
    stopSpeaking();
    return stopSpeaking;
  }, [conversationId, setActiveConversationId, stopSpeaking]);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setCouncilTraces({});
      setConversationSummary(null);
      return;
    }
    let cancelled = false;
    api.getConversation(conversationId)
      .then(({ conversation, messages }) => {
        if (cancelled) return;
        setMessages(messages);
        setConversationSummary(conversation?.summary || null);
        // Council traces are persisted on the message row, so reopening a thread
        // restores the trace instead of losing it (the original kept them in
        // session state only).
        const traces = {};
        for (const m of messages) if (m.council) traces[m.id] = m.council;
        setCouncilTraces(traces);
      })
      .catch(() => { if (!cancelled) setMessages([]); });
    return () => { cancelled = true; };
  }, [conversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, draft]);

  // --- THE SEND PATH -------------------------------------------------------
  const handleSend = useCallback(async (text, options = {}) => {
    if (!activeWorkspace || isProcessing) return;
    const turnSources = Array.isArray(options.sources) ? options.sources : [];
    const turnAgentMode = options.agentMode || 'off';

    stopSpeaking();
    setIsProcessing(true);
    setDraft({ text: '', live: { stages: [] } });

    const controller = new AbortController();
    abortRef.current = controller;

    // Optimistic user bubble; replaced by the persisted row on the `start` event.
    const tempId = `temp_${Date.now()}`;
    setMessages(prev => [...prev, {
      id: tempId,
      role: 'user',
      content: text,
      created_date: new Date().toISOString(),
      attachments: turnSources.map(source => ({
        source_id: source.id,
        name: source.name,
        source_type: source.kind,
        file_type: source.media_type
      }))
    }]);

    const markStage = (stage, status, ms) => setDraft(d => {
      if (!d) return d;
      const stages = [...d.live.stages];
      const i = stages.findIndex(s => s.stage === stage);
      if (i >= 0) stages[i] = { ...stages[i], status, ms };
      else stages.push({ stage, status, ms });
      return { ...d, live: { ...d.live, stages } };
    });
    const mergeLive = (patch) => setDraft(d => (d ? { ...d, live: { ...d.live, ...patch } } : d));

    try {
      await sendMessage(
        {
          conversationId,
          userMessage: text,
          style,
          webSearch,
          agentMode: turnAgentMode,
          attachments: turnSources.map(source => ({ source_id: source.id }))
        },
        {
          start: (data) => {
            setMessages(prev => prev.map(m => (m.id === tempId ? data.userMessage : m)));
            setSelectedSources([]);
            if (!conversationId && data.conversationId) {
              setActiveConversationId(data.conversationId);
              setSearchParams({ c: data.conversationId });
              refreshConversations();
            }
          },
          'stage.start': (e) => markStage(e.stage, 'running'),
          'stage.complete': (e) => markStage(e.stage, e.status === 'error' ? 'error' : 'done', e.ms),
          memories: (d) => mergeLive(d),
          observer: (d) => mergeLive(d),
          agent: (d) => mergeLive({ agent: d }),
          webSearch: (d) => mergeLive({ webSearch: d }),
          strategist: (d) => mergeLive({ plan: d.plan }),
          critic: (d) => mergeLive(d),
          governor: (d) => mergeLive({ governor: d }),
          token: (d) => setDraft(prev => (prev ? { ...prev, text: prev.text + d.delta } : prev)),
          done: (data) => {
            setMessages(prev => [...prev, data.message]);
            if (data.council) setCouncilTraces(prev => ({ ...prev, [data.message.id]: data.council }));
            if (data.summary) setConversationSummary(data.summary);
            if (data.response) {
              // `done.response` is the exact post-Governor text. The provider
              // checks the current mode at callback time, so disabling voice
              // during a turn also prevents playback of its eventual answer.
              speakAutomatically(data.response, { id: data.message.id });
            }
            refreshConversations();
          },
          error: (data) => {
            if (data.message) setMessages(prev => [...prev, data.message]);
            else setMessages(prev => [...prev, {
              id: `err_${Date.now()}`, role: 'assistant',
              content: `⚠️ **The council could not answer.**\n\n${data.error}`,
              processing_status: 'error'
            }]);
          }
        },
        controller.signal
      );
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, {
          id: `err_${Date.now()}`, role: 'assistant',
          content: `⚠️ **The council could not answer.**\n\n${err.message}`,
          processing_status: 'error'
        }]);
      }
    } finally {
      setDraft(null);
      setIsProcessing(false);
      abortRef.current = null;
    }
  }, [activeWorkspace, isProcessing, conversationId, style, webSearch, setSearchParams, setActiveConversationId, refreshConversations, speakAutomatically, stopSpeaking]);

  const handleStop = () => abortRef.current?.abort();

  return (
    <div className="flex flex-col h-full min-h-0">
      <header
        className="flex items-center gap-2 px-3 md:px-4 py-3 border-b border-border shrink-0"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
      >
        <button onClick={openSidebar} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted transition-colors">
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-medium truncate">{activeWorkspace?.name || 'COGNOS'}</h2>
          {conversationSummary && <p className="text-xs text-muted-foreground truncate">{conversationSummary}</p>}
        </div>
        <button
          onClick={toggleVoiceMode}
          disabled={!voiceSupported}
          aria-pressed={voiceSettings.enabled}
          aria-label={voiceSettings.enabled ? 'Turn voice mode off' : 'Turn voice mode on'}
          className={`p-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${voiceSettings.enabled ? 'text-accent bg-accent/10' : 'text-muted-foreground hover:text-foreground'} ${isSpeaking ? 'animate-pulse' : ''}`}
          title={!voiceSupported ? 'Speech output is not supported in this browser' : voiceSettings.enabled ? 'Voice mode on — click to turn off' : 'Turn voice mode on'}
        >
          {voiceSettings.enabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
        </button>
        <button
          onClick={() => setWebSearch(v => !v)}
          className={`p-1.5 rounded-lg transition-colors ${webSearch ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}
          title={webSearch ? 'Web search on' : 'Web search off'}
        >
          <Globe className="w-4 h-4" />
        </button>
        <select
          value={style}
          onChange={e => setStyle(e.target.value)}
          className="bg-muted/50 border border-border rounded-lg text-xs px-2 py-1.5 outline-none"
        >
          {STYLES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin min-h-0">
        {messages.length === 0 && !draft ? (
          <WelcomeScreen onSuggestion={handleSend} />
        ) : (
          <div className="max-w-3xl mx-auto px-3 md:px-4 py-4 space-y-4">
            {messages.map(m => (
              <ChatMessage key={m.id} message={m} council={councilTraces[m.id]} />
            ))}
            {draft && (
              <ChatMessage
                message={{ id: 'draft', role: 'assistant', content: draft.text }}
                live={draft.live}
                isStreaming
              />
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <ChatInput
        onSend={handleSend}
        disabled={isProcessing}
        isProcessing={isProcessing}
        onStop={handleStop}
        conversationId={conversationId}
        sources={selectedSources}
        onSourcesChange={setSelectedSources}
        agentMode={agentMode}
        onAgentModeChange={setAgentMode}
      />
    </div>
  );
}
