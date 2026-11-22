import { useState } from 'react';
import { FlaskConical, Brain, Network, MessagesSquare, Settings, RefreshCw } from 'lucide-react';

const suggestions = [
  {
    icon: MessagesSquare,
    title: 'Think through a decision',
    description: 'Slow down and weigh the trade-offs.',
    text: 'Help me think through a big decision, step by step',
  },
  {
    icon: FlaskConical,
    title: 'Research a question',
    description: 'Review the plan before any page is opened.',
    text: 'Research the best way to winterize a house — propose your plan before you open a single page',
  },
  {
    icon: Brain,
    title: 'Save what matters',
    description: 'Ask COGNOS to remember a preference.',
    text: 'Remember that I like short, plain answers — what should you learn about me next?',
  },
  {
    icon: Network,
    title: 'See what it remembers',
    description: 'Review what COGNOS has learned so far.',
    text: 'Summarize what you have learned about me from our conversations so far',
  },
];

function Mark() {
  return (
    <svg viewBox="0 0 200 200" className="w-16 h-16 md:w-20 md:h-20 mb-4" role="img" aria-label="COGNOS">
      <defs>
        <radialGradient id="cg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="hsl(110 32% 42%)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="hsl(84 72% 55%)" stopOpacity="0.15" />
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="72" fill="url(#cg)" />
      <circle cx="100" cy="100" r="72" fill="none" stroke="hsl(110 32% 42%)" strokeOpacity="0.5" strokeWidth="1" />
      <circle cx="100" cy="100" r="46" fill="none" stroke="hsl(84 72% 55%)" strokeOpacity="0.6" strokeWidth="1" />
      <circle cx="100" cy="100" r="20" fill="none" stroke="hsl(110 32% 42%)" strokeOpacity="0.8" strokeWidth="1.5" />
      {[0, 60, 120, 180, 240, 300].map(a => {
        const r = (a * Math.PI) / 180;
        return <circle key={a} cx={100 + 46 * Math.cos(r)} cy={100 + 46 * Math.sin(r)} r="3.5" fill="hsl(84 72% 65%)" />;
      })}
    </svg>
  );
}

function AiSetup({ onOpenSettings, onRetryConnection }) {
  const [checking, setChecking] = useState(false);
  const checkAgain = async () => {
    setChecking(true);
    try { await onRetryConnection?.(); }
    finally { setChecking(false); }
  };

  return (
    <div className="m-auto flex w-full max-w-lg flex-col items-center text-center">
      <Mark />
      <p className="orbit-eyebrow mb-2">One quick setup</p>
      <h1 className="orbit-page-title text-2xl md:text-3xl mb-3">Connect COGNOS to an AI model</h1>
      <p className="orbit-page-sub text-sm md:text-base max-w-md">
        Your workspace is ready. Add your AI provider credentials in the server environment, restart COGNOS, and run the connection test in Settings.
      </p>
      <div className="mt-6 flex w-full flex-col sm:w-auto sm:flex-row gap-2.5">
        <button type="button" onClick={onOpenSettings} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
          <Settings className="w-4 h-4" aria-hidden />
          Open AI settings
        </button>
        <button type="button" onClick={checkAgain} disabled={checking} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50">
          <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} aria-hidden />
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <p className="mt-5 text-xs text-muted-foreground leading-relaxed max-w-sm">
        Credentials stay on your server. They are never sent to this browser.
      </p>
    </div>
  );
}

export default function WelcomeScreen({ onSuggestion, modelConfigured = null, onOpenSettings, onRetryConnection }) {
  return (
    <div className="flex min-h-full px-4 py-5 md:py-8 animate-fade-in">
      {modelConfigured === false ? (
        <AiSetup onOpenSettings={onOpenSettings} onRetryConnection={onRetryConnection} />
      ) : (
        <div className="m-auto flex w-full max-w-2xl flex-col items-center">
          <Mark />
          <p className="orbit-eyebrow mb-2">Your space to think</p>
          <h1 className="orbit-page-title text-2xl md:text-4xl mb-2 text-center">What are you working through?</h1>
          <p className="orbit-page-sub text-sm md:text-base mb-5 md:mb-6 text-center max-w-lg">
            Ask a question, weigh a decision, or start a research project. COGNOS shows its work and asks before researching beyond your conversation.
          </p>
          <div className="grid grid-cols-2 gap-2.5 md:gap-3 w-full max-w-2xl">
            {suggestions.map(({ icon: Icon, title, description, text }) => (
              <button
                type="button"
                key={title}
                onClick={() => onSuggestion(text)}
                className="orbit-agent-card flex min-h-28 flex-col gap-1 p-3.5 md:p-4 text-left"
              >
                <Icon className="w-4 h-4 text-primary mb-1" aria-hidden />
                <span className="text-sm font-semibold leading-snug">{title}</span>
                <span className="text-xs text-muted-foreground leading-relaxed">{description}</span>
              </button>
            ))}
          </div>
          <p className="mt-4 md:mt-5 text-xs text-muted-foreground text-center max-w-sm leading-relaxed">
            Use the choices above to adjust tone, answer style, web lookup, and research help anytime.
          </p>
        </div>
      )}
    </div>
  );
}
