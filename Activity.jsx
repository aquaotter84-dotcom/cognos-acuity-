// Ported from the original src/pages/Activity.jsx — the audit log view.
import { useState, useEffect } from 'react';
import { Activity as ActivityIcon, Menu } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';

export default function Activity() {
  const { openSidebar } = useCognos();
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => { api.listActivity().then(setEvents).catch(e => setError(e.message)); }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-2 px-3 md:px-4 py-3 border-b border-border shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <button onClick={openSidebar} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted"><Menu className="w-5 h-5" /></button>
        <ActivityIcon className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-medium">Activity</h2>
      </header>
      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 min-h-0">
        <div className="max-w-3xl mx-auto space-y-2">
          {error && <p className="text-xs text-destructive">{error}</p>}
          {events.length === 0 && <p className="text-sm text-muted-foreground py-8 text-center">No activity recorded yet.</p>}
          {events.map(e => (
            <div key={e.id} className="rounded-lg border border-border bg-card px-3 py-2 text-xs flex flex-wrap items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded font-medium uppercase text-[10px] ${e.status === 'error' ? 'bg-destructive/15 text-destructive' : 'bg-green-500/15 text-green-400'}`}>{e.status}</span>
              <span className="text-muted-foreground">{e.event_type}</span>
              {e.task_type && <span className="text-foreground/80">{e.task_type}</span>}
              {e.model_used && <span className="text-muted-foreground/70">{e.model_used}</span>}
              <span className="ml-auto tabular-nums text-muted-foreground/70">{(e.latency_ms / 1000).toFixed(1)}s</span>
              <span className="w-full text-muted-foreground/50 text-[10px]">{new Date(e.created_date).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
