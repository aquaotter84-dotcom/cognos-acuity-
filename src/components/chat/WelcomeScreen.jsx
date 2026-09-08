// Ported from the original src/components/chat/WelcomeScreen.jsx.
// DIVERGENCE: the original logo was hosted on media.base44.com. That URL is a
// Base44 asset, so it is replaced with an inline SVG mark — no platform domain.
// Copy and suggestion cards are unchanged.

import { Sparkles, BookOpen, Cpu, Code } from 'lucide-react';

const suggestions = [
  { icon: Cpu, title: 'Meet COGNOS', text: 'Explain what COGNOS is, how every part works, what you can do, and your limits' },
  { icon: Sparkles, title: 'Brainstorm ideas', text: 'Help me brainstorm ideas for a new project' },
  { icon: BookOpen, title: 'Explain a concept', text: 'Explain how neural networks work in simple terms' },
  { icon: Code, title: 'Write code', text: 'Write a Python function to sort a list of dictionaries' },
];

function Mark() {
  return (
    <svg viewBox="0 0 200 200" className="w-40 h-40 md:w-56 md:h-56 mb-6" aria-label="COGNOS">
      <defs>
        <radialGradient id="cg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="hsl(217 91% 60%)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="hsl(258 83% 58%)" stopOpacity="0.15" />
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="72" fill="url(#cg)" />
      <circle cx="100" cy="100" r="72" fill="none" stroke="hsl(217 91% 60%)" strokeOpacity="0.5" strokeWidth="1" />
      <circle cx="100" cy="100" r="46" fill="none" stroke="hsl(258 83% 58%)" strokeOpacity="0.6" strokeWidth="1" />
      <circle cx="100" cy="100" r="20" fill="none" stroke="hsl(217 91% 60%)" strokeOpacity="0.8" strokeWidth="1.5" />
      {[0, 60, 120, 180, 240, 300].map(a => {
        const r = (a * Math.PI) / 180;
        return <circle key={a} cx={100 + 46 * Math.cos(r)} cy={100 + 46 * Math.sin(r)} r="3.5" fill="hsl(217 91% 70%)" />;
      })}
    </svg>
  );
}

export default function WelcomeScreen({ onSuggestion }) {
  return (
    <div className="flex flex-col items-center justify-center h-full px-4 py-8 animate-fade-in overflow-y-auto">
      <Mark />
      <h1 className="text-2xl font-bold tracking-tight mb-2">Welcome to COGNOS</h1>
      <p className="text-sm text-muted-foreground mb-8 text-center max-w-md">
        A governed AI reasoning council with one identity, visible evidence, bounded tools, and a sovereign final-answer gate.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-2xl">
        {suggestions.map(({ icon: Icon, title, text }) => (
          <button
            key={title}
            onClick={() => onSuggestion(text)}
            className="flex flex-col gap-1 p-4 rounded-xl border border-border bg-card/50 hover:bg-card hover:border-primary/30 transition-all text-left"
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
