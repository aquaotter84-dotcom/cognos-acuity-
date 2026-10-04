// Ported from the original src/components/chat/ChatMessage.jsx.
// Changes: the Base44 <Image> wrapper became a plain <img>; the live council
// panel renders while streaming; completed answers expose local speech controls.

import { useState, Fragment } from 'react';
import ReactMarkdown from 'react-markdown';
import { AlertCircle, BookOpen, Copy, Check, Square, Volume2, RotateCcw } from 'lucide-react';
import CouncilTrace from '@/components/chat/CouncilTrace';
import LiveCouncil from '@/components/chat/LiveCouncil';
import { useVoice } from '@/lib/voiceContext';
// v51 — inline citation locators ([src_x], [graph_x], [goal_x:n1]) render as
// calm chips instead of raw bracket text.
import { splitCitationTokens } from '@/lib/citations';

function CitationChip({ citation }) {
  return (
    <span
      title={citation.locator}
      className="inline-flex items-center gap-1 align-baseline rounded-md border border-border bg-muted/60 px-1.5 py-px text-[10px] font-medium text-muted-foreground mx-0.5 whitespace-nowrap"
    >
      <BookOpen className="w-2.5 h-2.5" aria-hidden />
      {citation.label}
    </span>
  );
}

// Tokenize only plain-text leaves of a paragraph: citations inside links or
// code spans stay exactly as the author wrote them.
function withCitations(children) {
  const out = [];
  let k = 0;
  const visit = (node) => {
    if (typeof node === 'string') {
      for (const tok of splitCitationTokens(node)) {
        if (tok.type === 'cite' && tok.citation) {
          out.push(<CitationChip key={`cite-${k++}`} citation={tok.citation} />);
        } else {
          out.push(tok.text);
        }
      }
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node != null) {
      out.push(<Fragment key={`el-${k++}`}>{node}</Fragment>);
    }
  };
  visit(children);
  return out;
}

// v51 — a failed turn becomes a calm card with the plain detail and a retry,
// instead of a raw markdown bubble. Rows persisted before v51 carry the old
// "⚠️ **The council could not answer.**" boilerplate; it is stripped so the
// card reads clean either way.
const LEGACY_ERROR_PREFIX = '⚠️ **The council could not answer.**';

function ChatErrorCard({ message, onRetry }) {
  let detail = typeof message.content === 'string' ? message.content.trim() : '';
  if (detail.startsWith(LEGACY_ERROR_PREFIX)) detail = detail.slice(LEGACY_ERROR_PREFIX.length).trim();
  const canRetry = typeof onRetry === 'function' && typeof message.retryText === 'string' && message.retryText.trim();
  return (
    <div className="flex gap-3 animate-message-in">
      <div className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center flex-shrink-0" aria-hidden>
        <AlertCircle className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0 rounded-2xl rounded-tl-md border border-border bg-card px-4 py-3">
        <p className="text-sm font-medium">That didn't go through.</p>
        {detail && <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">{detail}</p>}
        {canRetry && (
          <button
            type="button"
            onClick={() => onRetry(message.retryText)}
            className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-primary/10 text-primary px-3 py-1.5 text-xs font-medium hover:bg-primary/20 active:bg-primary/25 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden />
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

export default function ChatMessage({ message, council, live, isStreaming, onRetry }) {
  const [copied, setCopied] = useState(false);
  const { supported: voiceSupported, speakingId, speak, stop } = useVoice();
  const isUser = message.role === 'user';
  const isThisSpeaking = speakingId === message.id;

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  if (isUser) {
    return (
      <div className="flex justify-end animate-message-in">
        <div className="max-w-[85%] md:max-w-[80%] bg-primary text-primary-foreground rounded-2xl rounded-br-md px-4 py-2.5">
          <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {attachments.map((a, i) => (a.file_type || '').startsWith('image/') ? (
                <img key={i} src={a.file_url} className="w-20 h-20 rounded-lg object-cover" alt={a.name} />
              ) : (
                <span key={i} className="text-[10px] bg-primary-foreground/15 px-1.5 py-1 rounded">{a.name}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // v51 — failed assistant turns render as the calm error card, with retry
  // when the original text is available.
  if (!isStreaming && message.processing_status === 'error') {
    return <ChatErrorCard message={message} onRetry={onRetry} />;
  }

  return (
    <div className="flex gap-3 animate-message-in">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center flex-shrink-0">
        <span className="text-xs font-bold text-white">C</span>
      </div>
      <div className="flex-1 group min-w-0">
        {(message.content || isStreaming) && (
          <div className="bg-card border border-border rounded-2xl rounded-tl-md px-4 py-3 overflow-x-auto">
            <ReactMarkdown
              components={{
                p: ({ children }) => <p className="mb-3 last:mb-0 text-sm leading-relaxed">{withCitations(children)}</p>,
                code: ({ children }) => <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{children}</code>,
                pre: ({ children }) => <pre className="bg-muted p-3 rounded-lg overflow-x-auto mb-3 text-xs">{children}</pre>,
                ul: ({ children }) => <ul className="list-disc pl-5 mb-3 space-y-1 text-sm">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 space-y-1 text-sm">{children}</ol>,
                li: ({ children }) => <li>{withCitations(children)}</li>,
                h1: ({ children }) => <h1 className="text-base font-semibold mb-2">{children}</h1>,
                h2: ({ children }) => <h2 className="text-sm font-semibold mb-2">{children}</h2>,
                a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline break-all">{children}</a>,
              }}
            >
              {message.content}
            </ReactMarkdown>
            {isStreaming && <span className="inline-block w-1.5 h-4 bg-primary/70 align-middle ml-0.5 animate-pulse rounded-sm" />}
          </div>
        )}
        {isStreaming ? <LiveCouncil live={live} /> : (council && <CouncilTrace council={council} />)}
        {!isStreaming && message.content && (
          <div className="mt-1 flex items-center gap-3 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
            {voiceSupported && (
              <button
                onClick={() => (isThisSpeaking ? stop() : speak(message.content, { id: message.id }))}
                className={`flex items-center gap-1 text-xs transition-colors ${isThisSpeaking ? 'text-accent' : 'text-muted-foreground hover:text-foreground'}`}
                title={isThisSpeaking ? 'Stop speaking' : 'Read this response aloud'}
              >
                {isThisSpeaking ? <Square className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                {isThisSpeaking ? 'Stop' : 'Listen'}
              </button>
            )}
            <button onClick={handleCopy} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
