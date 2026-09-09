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
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Folder, Menu, Globe, Volume2, VolumeX } from 'lucide-react';
import { api, sendMessage } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import { useVoice } from '@/lib/voiceContext';
import ChatMessage from '@/components/chat/ChatMessage';
import ChatInput from '@/components/chat/ChatInput';
import WelcomeScreen from '@/components/chat/WelcomeScreen';
import ResearchDecisionCard from '@/components/chat/ResearchDecisionCard';

const STYLES = ['balanced', 'casual', 'technical', 'strategic'];

export default function Chat() {
  const { activeWorkspace, setActiveConversationId, refreshConversations, openSidebar, projectById } = useCognos();
  const navigate = useNavigate();
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
  const [conversationProject, setConversationProject] = useState(null); // project id when this chat lives inside a project
  // Phase 18 — an awaiting_approval research run in this conversation. The run
  // executes only when the user approves it here; the next message after the
  // decision continues with the executed run's evidence attached.
  const [researchRun, setResearchRun] = useState(null);
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
        setConversationProject(conversation?.project_id || null);
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

  // Phase 18 — research plans stop for the user: whenever an awaiting_approval
  // research run exists for this conversation, surface it for decision. The
  // run executes only after that decision; it never answers on its own.
  useEffect(() => {
    if (!conversationId) { setResearchRun(null); return; }
    let cancelled = false;
    api.agentRuns({ limit: 50 })
      .then(async (runs) => {
        if (cancelled) return;
        const pending = (runs || []).find(r =>
          r.mode === 'research' && r.conversation_id === conversationId && r.status === 'awaiting_approval');
        if (!pending) { if (!cancelled) setResearchRun(null); return; }
        const detail = await api.agentRun(pending.id);
        if (!cancelled) setResearchRun(detail);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [conversationId, messages]);

  const handleResearchDecided = useCallback(async (decision, reason) => {
    if (!researchRun?.run || researchRun.busy) return;
    setResearchRun(prev => prev ? { ...prev, busy: true } : prev);
    try {
      const outcome = await api.decideAgentRun(researchRun.run.id, { decision, reason: reason || undefined });
      const { run, steps } = outcome;
      setResearchRun({
        run,
        steps,
        decided: { decision, at: Date.now(), sourceCount: (outcome.createdSources || []).length }
      });
    } catch (err) {
      setResearchRun(prev => prev ? { ...prev, error: err.message || 'The decision could not be recorded' } : prev);
    }
  }, [researchRun]);

  // A research conversation's next message continues with the decided run, so
  // the executed steps' fetched pages attach to the answer as ordinary evidence.
  const decidedResearchRunId = researchRun?.run && !researchRun.busy
    && researchRun.decided && researchRun.run.status !== 'awaiting_approval'
    ? researchRun.run.id : null;

  // --- THE SEND PATH -------------------------------------------------------
  const handleSend = useCallback(async (text, options = {}) => {
    if (!activeWorkspace || isProcessing) return;
    const turnSources = Array.isArray(options.sources) ? options.sources : [];
    const turnAgentMode = options.agentMode || 'off';
    // Phase 18 — after the user decides a research plan, the next message in the
    // conversation continues that executed run: approved pages were attached as
    // evidence server-side, and the council answers from them like any source.
    // A research-mode message starts a NEW proposal; the continuation of a
    // decided run is a plain (or read-only) question, not another plan.
    const turnResearchRunId = turnAgentMode !== 'research' ? decidedResearchRunId : null;

    stopSpeaking();
    setIsProcessing(true);
    setDraft({ text: '', live: { stages: [] } });
    if (turnResearchRunId) setResearchRun(null);

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
          researchRunId: turnResearchRunId,
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
  }, [activeWorkspace, isProcessing, conversationId, style, webSearch, setSearchParams, setActiveConversationId, refreshConversations, speakAutomatically, stopSpeaking, decidedResearchRunId]);

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
          {conversationProject && (
            <button
              onClick={() => navigate('/projects')}
              className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-accent hover:underline"
              title="Open Projects"
            >
              <Folder className="w-3 h-3" />
              {projectById(conversationProject)?.name || 'Research project'} — view
            </button>
          )}
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

      {researchRun && researchRun.run && researchRun.run.status === 'awaiting_approval' && !researchRun.decided && (
        <div className="shrink-0 px-3 md:px-4 pb-1">
          <ResearchDecisionCard
            runId={researchRun.run.id}
            steps={researchRun.steps || []}
            busy={Boolean(researchRun.busy)}
            error={researchRun.error || null}
            onApprove={() => handleResearchDecided('approve')}
            onDecline={(reason) => handleResearchDecided('decline', reason)}
          />
        </div>
      )}

      {researchRun && researchRun.decided && researchRun.run && (
        <div className="shrink-0 px-3 md:px-4 pb-1">
          <div className="max-w-3xl mx-auto rounded-xl border border-border bg-card px-3 py-2.5 text-xs">
            <p className="text-muted-foreground">
              {researchRun.decided.decision === 'approve'
                ? `Plan approved — ${(researchRun.steps || []).length} step${(researchRun.steps || []).length === 1 ? '' : 's'} executed with consent recorded per step.`
                : 'Plan declined — nothing was opened or executed.'}
            </p>
            {(researchRun.steps || []).filter(s => s.status === 'completed').length > 0 && (
              <p className="text-muted-foreground mt-1">
                Fetched pages are attached as immutable evidence for your next question — ask me to continue and I will answer from them.
              </p>
            )}
            {researchRun.error && <p className="text-destructive mt-1">{researchRun.error}</p>}
          </div>
        </div>
      )}

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
