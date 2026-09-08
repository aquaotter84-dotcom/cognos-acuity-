// Ported from the original src/components/chat/ChatMessage.jsx.
// Changes: the Base44 <Image> wrapper became a plain <img>; the live council
// panel renders while streaming; completed answers expose local speech controls.

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Copy, Check, Square, Volume2 } from 'lucide-react';
import CouncilTrace from '@/components/chat/CouncilTrace';
import LiveCouncil from '@/components/chat/LiveCouncil';
import { useVoice } from '@/lib/voiceContext';

export default function ChatMessage({ message, council, live, isStreaming }) {
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
                p: ({ children }) => <p className="mb-3 last:mb-0 text-sm leading-relaxed">{children}</p>,
                code: ({ children }) => <code className="bg-muted px-1.5 py-0.5 rounded text-xs">{children}</code>,
                pre: ({ children }) => <pre className="bg-muted p-3 rounded-lg overflow-x-auto mb-3 text-xs">{children}</pre>,
                ul: ({ children }) => <ul className="list-disc pl-5 mb-3 space-y-1 text-sm">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 space-y-1 text-sm">{children}</ol>,
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
