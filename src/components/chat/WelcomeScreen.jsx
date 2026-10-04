// Plain-language welcome: say what COGNOS does for the user, and let the
// suggestion cards demo what makes it different — deep research with a plan
// you approve, memory that sticks, and reasoning you can watch.

import { FlaskConical, Brain, Network, MessagesSquare } from 'lucide-react';

const suggestions = [
  {
    icon: FlaskConical,
    title: 'Research something deeply',
    text: 'Research the best way to winterize a house — propose your plan before you open a single page',
  },
  {
    icon: Brain,
    title: 'Remember this about me',
    text: 'Remember that I like short, plain answers — what should you learn about me next?',
  },
  {
    icon: Network,
    title: 'What have you learned?',
    text: 'Summarize what you have learned about me from our conversations so far',
  },
  {
    icon: MessagesSquare,
    title: 'Think it through with me',
    text: 'Help me think through a big decision, step by step',
  },
];

function Mark() {
  return (
    <svg viewBox="0 0 200 200" className="w-40 h-40 md:w-56 md:h-56 mb-6" aria-label="COGNOS">
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

export default function WelcomeScreen({ onSuggestion }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-4 py-8 animate-fade-in overflow-y-auto">
      <Mark />
      <p className="orbit-eyebrow mb-2">Your AI, on your phone</p>
      <h1 className="orbit-page-title text-3xl mb-2">Welcome to COGNOS</h1>
      <p className="orbit-page-sub text-sm mb-8 text-center max-w-md">
        An AI that thinks out loud, remembers what matters, and keeps everything on this phone.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-2xl">
        {suggestions.map(({ icon: Icon, title, text }) => (
          <button
            key={title}
            onClick={() => onSuggestion(text)}
            className="orbit-agent-card flex flex-col gap-1 p-4 text-left"
          >
            <Icon className="w-5 h-5 text-primary mb-1" />
            <span className="text-sm font-medium">{title}</span>
            <span className="text-xs text-muted-foreground line-clamp-1">{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
