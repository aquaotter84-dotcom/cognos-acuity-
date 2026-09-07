// PHASE 14/15 ADDITION — the System page. A read-only window onto what the
// system knows about itself: the append-only event ledger, state replay,
// coherence reports, beliefs, per-run reasoning telemetry, the law layer and the
// Improvement Ledger.
//
// It adds no write path to chat and no second channel to the user. The only
// mutation available here is proposing an adaptation to the Policy Engine, which
// is judged against immutable laws and appended to the Improvement Ledger —
// refusals included. In v1 an approved proposal authorizes and records; it does
// not change a model, a schema or the send path at runtime.

import { useCallback, useEffect, useState } from 'react';
import { Menu, Network, History, Scale, Gauge, Link2, GitBranch, RefreshCw, AlertTriangle, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';

const TABS = [
  { id: 'ledger', label: 'Ledger', icon: History },
  { id: 'replay', label: 'Replay', icon: GitBranch },
  { id: 'coherence', label: 'Coherence', icon: Link2 },
  { id: 'telemetry', label: 'Telemetry', icon: Gauge },
  { id: 'laws', label: 'Laws', icon: Scale },
];

const fmtTime = (v) => (v ? new Date(typeof v === 'number' ? v : v).toLocaleString() : '—');
const fmtMs = (v) => (v == null ? '—' : `${Math.round(Number(v))}ms`);
const fmtMoney = (v) => (v == null ? '—' : `$${Number(v).toFixed(5)}`);
const fmtNum = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));

function Card({ title, subtitle, children, action }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-semibold">{title}</h3>
          {subtitle && <p className="text-[10px] text-muted-foreground/70 leading-snug">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Pill({ tone = 'muted', children }) {
  const tones = {
    muted: 'bg-muted text-muted-foreground',
    ok: 'bg-green-500/15 text-green-400',
    warn: 'bg-yellow-500/15 text-yellow-400',
    bad: 'bg-destructive/15 text-destructive',
    info: 'bg-primary/15 text-primary',
  };
  return <span className={`px-1.5 py-0.5 rounded font-medium uppercase text-[10px] whitespace-nowrap ${tones[tone] || tones.muted}`}>{children}</span>;
}

function Json({ value, className = '' }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground/50">null</span>;
  return (
    <pre className={`text-[10px] leading-relaxed whitespace-pre-wrap break-words font-mono text-foreground/80 bg-muted/40 rounded p-2 max-h-64 overflow-auto scrollbar-thin ${className}`}>
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Empty({ children }) {
  return <p className="text-xs text-muted-foreground py-6 text-center">{children}</p>;
}

function ErrorNote({ error }) {
  if (!error) return null;
  return <p className="text-xs text-destructive flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}</p>;
}

export default function System() {
  const { openSidebar } = useCognos();
  const [tab, setTab] = useState('ledger');
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // ledger
  const [events, setEvents] = useState([]);
  const [transitions, setTransitions] = useState([]);
  const [filter, setFilter] = useState({ transition: '', entityType: '', runId: '', limit: 50 });

  // replay
  const [replay, setReplay] = useState(null);
  const [replayForm, setReplayForm] = useState({ entityType: 'belief', entityId: '', at: '' });

  // coherence + beliefs
  const [reports, setReports] = useState([]);
  const [beliefs, setBeliefs] = useState([]);
  const [analytics, setAnalytics] = useState(null);

  // telemetry
  const [runs, setRuns] = useState([]);
  const [runDetail, setRunDetail] = useState(null);
  const [summary, setSummary] = useState(null);

  // laws
  const [laws, setLaws] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [improvements, setImprovements] = useState([]);
  const [proposal, setProposal] = useState({
    action: 'change_model',
    target: 'gpt_5_4',
    justification: 'cheaper than the current model, so cost goes down',
    law_refs: 'charter.evidence',
    evidence: ''
  });
  const [proposalResult, setProposalResult] = useState(null);

  useEffect(() => { api.health().then(setHealth).catch(() => {}); }, []);

  const load = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      if (tab === 'ledger') {
        const data = await api.knowledgeEvents(filter);
        setEvents(data.events || []); setTransitions(data.transitions || []);
      } else if (tab === 'coherence') {
        const [c, b, a] = await Promise.all([
          api.knowledgeCoherence({ limit: 30 }),
          api.knowledgeBeliefs({ limit: 60 }),
          api.knowledgeAnalytics({ windowDays: 30, limit: 20 }),
        ]);
        setReports(c.reports || []); setBeliefs(b.beliefs || []); setAnalytics(a);
      } else if (tab === 'telemetry') {
        const [r, s] = await Promise.all([api.telemetryRuns({ limit: 40 }), api.telemetrySummary().catch(() => null)]);
        setRuns(r.runs || []); setSummary(s);
      } else if (tab === 'laws') {
        const [l, p, i] = await Promise.all([api.laws(), api.policy(), api.improvements({ limit: 50 })]);
        setLaws(l); setPolicy(p); setImprovements(i.improvements || []);
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [tab, filter]);

  useEffect(() => { load(); }, [load]);

  const doReplay = async (override = {}) => {
    const form = { ...replayForm, ...override };
    setReplayForm(form);
    if (!form.entityId) { setReplay(null); return; }
    setBusy(true); setError(null);
    try {
      const params = form.at ? { at: /^\d+$/.test(form.at) ? Number(form.at) : form.at } : {};
      setReplay(await api.knowledgeState(form.entityType, form.entityId, params));
    } catch (e) { setError(e.message || String(e)); setReplay(null); }
    finally { setBusy(false); }
  };

  const openRun = async (runId) => {
    setBusy(true); setError(null);
    try { setRunDetail(await api.telemetryRun(runId)); }
    catch (e) { setError(e.message || String(e)); setRunDetail(null); }
    finally { setBusy(false); }
  };

  const submitProposal = async () => {
    setBusy(true); setError(null); setProposalResult(null);
    try {
      const lawRefs = String(proposal.law_refs || '').split(',').map(x => x.trim()).filter(Boolean);
      const evidence = String(proposal.evidence || '').trim() ? { note: String(proposal.evidence).trim() } : null;
      setProposalResult(await api.proposeAdaptation({
        action: proposal.action,
        target: proposal.target || null,
        justification: proposal.justification || '',
        law_refs: lawRefs,
        evidence,
        proposed_by: 'operator:system-page'
      }));
    } catch (e) {
      // A refusal answers 409 with the decision body — that IS the result.
      setProposalResult({ decision: 'refused', error: e.message || String(e) });
    } finally { setBusy(false); load(); }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-2 px-3 md:px-4 py-3 border-b border-border shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <button onClick={openSidebar} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted"><Menu className="w-5 h-5" /></button>
        <Network className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-medium">System</h2>
        <span className="text-[10px] text-muted-foreground/70 hidden sm:inline">Phase 14 event ledger · Phase 15 meta-cognition</span>
        <div className="ml-auto flex items-center gap-2">
          {health && (
            <span className="hidden md:flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
              <Pill tone={health.ledger ? 'ok' : 'muted'}>ledger {health.ledger ? 'on' : 'off'}</Pill>
              <Pill tone={health.coherence ? 'ok' : 'muted'}>coherence {health.coherence ? 'on' : 'off'}</Pill>
              <Pill tone={health.telemetry ? 'ok' : 'muted'}>telemetry {health.telemetry ? 'on' : 'off'}</Pill>
              <Pill tone="info">adaptive {health.adaptiveMode}</Pill>
            </span>
          )}
          <button onClick={load} className="p-1.5 rounded-lg hover:bg-muted" title="Reload"><RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /></button>
        </div>
      </header>

      <div className="flex gap-1 px-3 md:px-4 py-2 border-b border-border/60 overflow-x-auto scrollbar-thin shrink-0">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors ${tab === id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted'}`}
          >
            <Icon className="w-3.5 h-3.5" />{label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 min-h-0">
        <div className="max-w-4xl mx-auto space-y-3">
          <ErrorNote error={error} />

          {tab === 'ledger' && (
            <>
              <Card
                title="Event ledger"
                subtitle="Append-only. Nothing is deleted: retiring is a transition. Every row here was written in the same transaction as the knowledge it describes."
              >
                <div className="flex flex-wrap gap-2 mb-3">
                  <select
                    className="bg-muted/50 border border-border rounded px-2 py-1 text-xs"
                    value={filter.transition}
                    onChange={(e) => setFilter(f => ({ ...f, transition: e.target.value }))}
                  >
                    <option value="">all transitions</option>
                    {transitions.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <input
                    className="bg-muted/50 border border-border rounded px-2 py-1 text-xs w-32"
                    placeholder="entity type"
                    value={filter.entityType}
                    onChange={(e) => setFilter(f => ({ ...f, entityType: e.target.value }))}
                  />
                  <input
                    className="bg-muted/50 border border-border rounded px-2 py-1 text-xs flex-1 min-w-[10rem]"
                    placeholder="run id"
                    value={filter.runId}
                    onChange={(e) => setFilter(f => ({ ...f, runId: e.target.value }))}
                  />
                </div>
                {events.length === 0 ? <Empty>No ledger events yet. Send a message and they appear here.</Empty> : (
                  <div className="space-y-1.5">
                    {events.map(e => (
                      <div key={e.id} className="rounded border border-border/70 bg-muted/20 px-2.5 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="tabular-nums text-muted-foreground/50">#{e.seq}</span>
                          <Pill tone={e.reversible ? 'info' : 'warn'}>{e.transition}</Pill>
                          <button
                            className="text-foreground/80 hover:text-primary underline decoration-dotted"
                            onClick={() => { setTab('replay'); doReplay({ entityType: e.entity_type, entityId: e.entity_id, at: String(e.ts_ms) }); }}
                            title="Replay this entity at this instant"
                          >
                            {e.entity_type}:{String(e.entity_id).slice(0, 18)}
                          </button>
                          <span className="ml-auto tabular-nums text-muted-foreground/60">{fmtTime(e.at)}</span>
                        </div>
                        {(e.from_state || e.to_state || e.delta) && (
                          <div className="mt-1.5 grid sm:grid-cols-3 gap-1.5 text-[10px]">
                            <div><span className="text-muted-foreground/60">from </span><Json value={e.from_state} /></div>
                            <div><span className="text-muted-foreground/60">to </span><Json value={e.to_state} /></div>
                            <div><span className="text-muted-foreground/60">delta </span><Json value={e.delta} /></div>
                          </div>
                        )}
                        <div className="mt-1 text-[10px] text-muted-foreground/50 flex flex-wrap gap-2">
                          {e.source_run_id && <span>run {e.source_run_id}</span>}
                          {e.source_message_id && <span>message {e.source_message_id}</span>}
                          <span>source {e.source_kind || '—'}</span>
                          <span>reversible: {e.reversible ? 'yes' : 'no'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}

          {tab === 'replay' && (
            <>
              <Card title="State reconstruction" subtitle="Fold the ledger up to an instant and you have the entity's state at that instant. Current-state tables are maintained transactionally for fast reads; replay is the proof they are right.">
                <div className="flex flex-wrap gap-2 items-end">
                  <label className="text-[10px] text-muted-foreground/70">
                    entity type
                    <input className="mt-0.5 block bg-muted/50 border border-border rounded px-2 py-1 text-xs w-32" value={replayForm.entityType} onChange={(e) => setReplayForm(f => ({ ...f, entityType: e.target.value }))} />
                  </label>
                  <label className="text-[10px] text-muted-foreground/70 flex-1 min-w-[12rem]">
                    entity id
                    <input className="mt-0.5 block bg-muted/50 border border-border rounded px-2 py-1 text-xs w-full" placeholder="belief_…" value={replayForm.entityId} onChange={(e) => setReplayForm(f => ({ ...f, entityId: e.target.value }))} />
                  </label>
                  <label className="text-[10px] text-muted-foreground/70">
                    at (epoch ms or ISO; empty = now)
                    <input className="mt-0.5 block bg-muted/50 border border-border rounded px-2 py-1 text-xs w-44" placeholder="1757200000000" value={replayForm.at} onChange={(e) => setReplayForm(f => ({ ...f, at: e.target.value }))} />
                  </label>
                  <button onClick={() => doReplay()} className="px-3 py-1.5 rounded-lg bg-primary/15 text-primary text-xs hover:bg-primary/25">Replay</button>
                </div>
              </Card>

              {replay && (
                <>
                  <Card title={`${replay.entityType}:${replay.entityId}`} subtitle={replay.replayed ? `state as of ${fmtTime(replay.asOf)}` : 'current state (no cut-off given)'}>
                    <div className="flex flex-wrap gap-2 mb-2 text-[10px]">
                      <Pill tone={replay.exists ? 'ok' : 'muted'}>{replay.exists ? 'exists' : 'no state at that instant'}</Pill>
                      <Pill>{replay.eventCount} event(s)</Pill>
                      {replay.firstEventAt && <Pill>first {fmtTime(replay.firstEventAt)}</Pill>}
                      {replay.lastTransition && <Pill tone="info">{replay.lastTransition}</Pill>}
                    </div>
                    <Json value={replay.state} />
                    {replay.foldMatchesCurrentState && (
                      <div className="mt-2 flex items-start gap-2 text-[11px]">
                        {replay.foldMatchesCurrentState.consistent
                          ? <><ShieldCheck className="w-4 h-4 text-green-400 shrink-0 mt-0.5" /><span className="text-muted-foreground">Folding the whole ledger reproduces the materialized row — no drift on {Object.keys(replay.foldMatchesCurrentState.current || {}).length} tracked field(s).</span></>
                          : <><AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" /><span className="text-muted-foreground">Drift detected: {JSON.stringify(replay.foldMatchesCurrentState.drift)}</span></>}
                      </div>
                    )}
                  </Card>
                  <Card title="History" subtitle="Every transition behind that state, oldest first.">
                    {replay.history?.length ? (
                      <div className="space-y-1 text-[11px]">
                        {replay.history.map(h => (
                          <div key={h.id || h.seq} className="flex flex-wrap gap-2 items-center rounded border border-border/50 px-2 py-1">
                            <span className="tabular-nums text-muted-foreground/50">#{h.seq}</span>
                            <Pill tone="info">{h.transition}</Pill>
                            <span className="text-muted-foreground/70">{fmtTime(h.at || h.ts_ms)}</span>
                            {h.delta && <span className="text-foreground/70">Δ {JSON.stringify(h.delta)}</span>}
                          </div>
                        ))}
                      </div>
                    ) : <Empty>No history.</Empty>}
                  </Card>
                </>
              )}
            </>
          )}

          {tab === 'coherence' && (
            <>
              {analytics && (
                <Card title="Change analytics" subtitle={`Read-only measurements over the last ${analytics.windowDays} day(s), generated ${fmtTime(analytics.generatedAt)}.`}>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <div className="rounded border border-border/60 p-2"><div className="text-[10px] text-muted-foreground/60 uppercase">ledger events</div><div className="text-lg tabular-nums">{analytics.summary?.ledger?.events ?? '—'}</div></div>
                    <div className="rounded border border-border/60 p-2"><div className="text-[10px] text-muted-foreground/60 uppercase">events / day</div><div className="text-lg tabular-nums">{fmtNum(analytics.churn?.events_per_day, 2)}</div></div>
                    <div className="rounded border border-border/60 p-2"><div className="text-[10px] text-muted-foreground/60 uppercase">entities changed</div><div className="text-lg tabular-nums">{analytics.change_rate?.count ?? '—'}</div></div>
                    <div className="rounded border border-border/60 p-2"><div className="text-[10px] text-muted-foreground/60 uppercase">contradictions</div><div className="text-lg tabular-nums">{(analytics.summary?.coherence || []).find(c => c.verdict === 'contradiction')?.count ?? 0}</div></div>
                  </div>

                  {analytics.summary?.ledger?.by_transition?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {analytics.summary.ledger.by_transition.map(t => <Pill key={t.transition} tone="muted">{t.transition} ×{t.count}</Pill>)}
                    </div>
                  )}

                  {analytics.stability && (
                    <div className="mt-3 rounded border border-border/60 px-2.5 py-2 text-[11px]">
                      <span className="text-muted-foreground/70">stability index (beliefs): </span>
                      <span className="text-foreground/85 tabular-nums">{fmtNum(analytics.stability.average_stability_index, 3)}</span>
                      <span className="text-muted-foreground/70"> — {analytics.stability.reading}</span>
                      {analytics.relationship_stability?.average_stability_index != null && (
                        <span className="text-muted-foreground/60"> · relationships {fmtNum(analytics.relationship_stability.average_stability_index, 3)}</span>
                      )}
                    </div>
                  )}

                  {analytics.churn?.buckets?.length > 0 && (() => {
                    const max = Math.max(...analytics.churn.buckets.map(b => b.total), 1);
                    return (
                      <div className="mt-3 space-y-1">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">churn over time{analytics.churn.peak ? ` · peak ${fmtTime(analytics.churn.peak.bucket)}` : ''}</div>
                        {analytics.churn.buckets.map(b => (
                          <div key={b.bucket_ms} className="flex items-center gap-2 text-[11px]">
                            <span className="text-muted-foreground/70 w-28 truncate tabular-nums">{new Date(b.bucket_ms).toLocaleDateString()}</span>
                            <div className="h-1.5 rounded-full bg-muted flex-1 overflow-hidden"><div className="h-full rounded-full bg-primary/60" style={{ width: `${Math.max(2, (b.total / max) * 100)}%` }} /></div>
                            <span className="tabular-nums w-8 text-right">{b.total}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {analytics.change_rate?.entities?.length > 0 && (
                    <div className="mt-3 space-y-1">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60">most-changed entities</div>
                      {analytics.change_rate.entities.slice(0, 12).map(m => (
                        <div key={`${m.entity_type}:${m.entity_id}`} className="flex items-center gap-2 text-[11px]">
                          <span className="text-foreground/80 w-20 shrink-0">{m.entity_type}</span>
                          <button className="text-muted-foreground/80 hover:text-primary underline decoration-dotted truncate" onClick={() => { setTab('replay'); doReplay({ entityType: m.entity_type, entityId: m.entity_id, at: '' }); }}>{String(m.entity_id).slice(0, 22)}</button>
                          <span className="ml-auto tabular-nums text-muted-foreground/70 shrink-0">{m.events} change(s) · {fmtNum(m.change_rate_per_day, 2)}/day · last {fmtTime(m.last_change)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              )}

              <Card title="Coherence reports" subtitle="After each council cycle the monitor compares the draft against stored beliefs. A contradiction is not an error — it is a measured transition, with both claims, their lineage and the confidence deltas.">
                {reports.length === 0 ? <Empty>No coherence reports yet.</Empty> : (
                  <div className="space-y-1.5">
                    {reports.map(r => (
                      <div key={r.id} className="rounded border border-border/70 bg-muted/20 px-2.5 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <Pill tone={r.verdict === 'contradiction' ? 'warn' : r.verdict === 'coherent' || r.verdict === 'confirmation' ? 'ok' : r.verdict === 'error' ? 'bad' : 'muted'}>{r.verdict}</Pill>
                          <span className="text-muted-foreground/70">{fmtTime(r.created_date || r.ts_ms)}</span>
                          {r.run_id && <button className="text-muted-foreground/80 hover:text-primary underline decoration-dotted" onClick={() => { setTab('telemetry'); openRun(r.run_id); }}>run {String(r.run_id).slice(0, 16)}</button>}
                          <span className="ml-auto tabular-nums text-muted-foreground/60">Δ confidence {fmtNum(r.confidence_delta)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground/60">
                          {r.checked ? <span>checked</span> : <span>not checked{r.skip_reason ? ` — ${r.skip_reason}` : ''}</span>}
                          {r.draft_shipped != null && <span>draft shipped: {String(r.draft_shipped)}</span>}
                          {(r.belief_ids || []).length > 0 && <span>{r.belief_ids.length} belief(s) considered</span>}
                          {r.model_used && <span>monitor model {r.model_used}</span>}
                          {r.latency_ms != null && <span>{fmtMs(r.latency_ms)}</span>}
                        </div>
                        {r.note && <p className="mt-1 text-[11px] text-muted-foreground/80">{r.note}</p>}
                        {(r.contradictions || []).length > 0 && (
                          <div className="mt-1.5 rounded border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5 text-[11px]">
                            <div className="text-[10px] uppercase tracking-wide text-yellow-500/80 mb-1">both claims, with lineage — a transition, not an error</div>
                            {r.contradictions.map((c, i) => (
                              <div key={i} className="text-muted-foreground/90">
                                “{String(c.claim || '').slice(0, 160)}”
                                {c.confidence != null && <span className="text-muted-foreground/60"> · confidence now {fmtNum(c.confidence)}</span>}
                                {c.prev_confidence != null && <span className="text-muted-foreground/60"> (was {fmtNum(c.prev_confidence)})</span>}
                                {c.belief_id && <button className="ml-1 text-muted-foreground/60 hover:text-primary underline decoration-dotted" onClick={() => { setTab('replay'); doReplay({ entityType: 'belief', entityId: c.belief_id, at: '' }); }}>{String(c.belief_id).slice(0, 14)}</button>}
                              </div>
                            ))}
                          </div>
                        )}
                        {(r.confirmations || []).length > 0 && (
                          <div className="mt-1.5 text-[11px] text-muted-foreground/80">
                            confirmed: {r.confirmations.map(c => `“${String(c.claim || '').slice(0, 60)}”`).join(' · ')}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Beliefs" subtitle="Current state, maintained transactionally. Retired beliefs keep their rows and their history.">
                {beliefs.length === 0 ? <Empty>No beliefs yet — they are extracted from exchanges that ship.</Empty> : (
                  <div className="space-y-1">
                    {beliefs.map(b => (
                      <div key={b.id} className="flex items-start gap-2 text-xs rounded border border-border/50 px-2 py-1.5">
                        <button className="text-muted-foreground/70 hover:text-primary underline decoration-dotted shrink-0" onClick={() => { setTab('replay'); doReplay({ entityType: 'belief', entityId: b.id, at: '' }); }}>{String(b.id).slice(0, 14)}</button>
                        <span className="text-foreground/85 flex-1">{String(b.statement || b.content || '').slice(0, 160)}</span>
                        <span className="tabular-nums text-muted-foreground/70 shrink-0">{fmtNum(b.confidence)} · {b.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}

          {tab === 'telemetry' && (
            <>
              {summary?.summary && (
                <Card title="What the system has measured about itself" subtitle="Aggregated across recorded runs. Nothing invisible: timeouts, aborts, upstream 5xx, vetoes and contradictions are all here.">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    {summary.summary.map(s => (
                      <div key={s.strategy_id || 'all'} className="rounded border border-border/60 p-2">
                        <div className="text-[10px] text-muted-foreground/60 uppercase truncate">{s.strategy_id || 'strategy'}</div>
                        <div className="text-lg tabular-nums">{s.runs}</div>
                        <div className="text-[10px] text-muted-foreground/70">runs · {fmtMs(s.avg_latency_ms)} avg · {fmtMoney(s.avg_cost_usd)} avg</div>
                        <div className="text-[10px] text-muted-foreground/70">veto rate {fmtNum(s.veto_rate)} · errors {fmtNum(s.error_rate)} · contradictions {s.contradictions ?? 0}</div>
                      </div>
                    ))}
                  </div>
                  {summary.switchAnalysis && (
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      switch analysis: <span className="text-foreground/80">{summary.switchAnalysis.switch ? 'would switch' : 'no switch'}</span> — {summary.switchAnalysis.reason || 'observe mode'}
                    </div>
                  )}
                </Card>
              )}

              <Card title="Reasoning telemetry" subtitle="One record per orchestration run: per-stage latency, model, tokens where the model exposed them (estimated otherwise), cost from the rate table, confidence where the council expressed it, the coherence verdict, failures, and any veto with the operator that produced the rejected draft.">
                {runs.length === 0 ? <Empty>No runs recorded yet.</Empty> : (
                  <div className="space-y-1">
                    {runs.map(r => (
                      <button key={r.id} onClick={() => openRun(r.id)} className="w-full text-left rounded border border-border/60 hover:border-primary/40 px-2.5 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <Pill tone={r.status === 'success' ? 'ok' : r.status === 'vetoed' ? 'warn' : 'bad'}>{r.status}</Pill>
                          <span className="text-muted-foreground/80 truncate">{String(r.id).slice(0, 20)}</span>
                          {r.vetoed && <Pill tone="warn">vetoed</Pill>}
                          {r.coherence_verdict === 'contradiction' && <Pill tone="warn">contradiction</Pill>}
                          {(r.failure_count || 0) > 0 && <Pill tone="bad">{r.failure_count} failure(s)</Pill>}
                          <span className="ml-auto tabular-nums text-muted-foreground/70">{fmtMs(r.latency_ms)} · {fmtMoney(r.cost_usd)} · {r.ledger_events ?? 0} events</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted-foreground/60">
                          <span>{fmtTime(r.started_ms)}</span>
                          {r.models?.length > 0 && <span>models: {r.models.join(', ')}</span>}
                          <span>tokens {r.tokens_total ?? 0}{r.tokens_measured ? '' : ' (estimated)'}</span>
                          {r.confidence != null && <span>confidence {fmtNum(r.confidence)} ({r.confidence_source || 'n/a'})</span>}
                          {r.strategy_id && <span>{r.strategy_id}</span>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </Card>

              {runDetail && (
                <Card title={`Run ${String(runDetail.id).slice(0, 24)}`} subtitle="Stages, model calls, ledger events and the adaptive observation for one run." action={<button onClick={() => setRunDetail(null)} className="text-[10px] text-muted-foreground hover:text-foreground">close</button>}>
                  <div className="space-y-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1">stages</div>
                      {(runDetail.stage_order || []).map(st => (
                        <div key={st.stage} className="flex items-center gap-2 text-[11px] py-0.5">
                          <span className="text-muted-foreground/80 w-36 truncate">{st.stage}{st.runs > 1 ? ` ×${st.runs}` : ''}</span>
                          <div className="h-1.5 rounded-full bg-muted flex-1 overflow-hidden"><div className={`h-full rounded-full ${st.lastStatus === 'error' ? 'bg-destructive' : 'bg-primary/60'}`} style={{ width: `${Math.max(2, (Number(st.totalMs || 0) / Math.max(1, runDetail.latency_ms || 1)) * 100)}%` }} /></div>
                          <span className="tabular-nums w-16 text-right">{fmtMs(st.totalMs)}</span>
                          <span className="text-[10px] text-muted-foreground/50 w-28 text-right truncate">{st.model || ''} · {st.tokens ?? 0} tok</span>
                        </div>
                      ))}
                      {(runDetail.stage_order || []).length === 0 && <Empty>No stages recorded.</Empty>}
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1">model calls</div>
                      {(runDetail.calls || []).map(c => (
                        <div key={c.id} className="flex flex-wrap gap-2 text-[11px] rounded border border-border/50 px-2 py-1">
                          <Pill tone={c.status === 'success' ? 'ok' : 'bad'}>{c.purpose || c.stage || 'call'}</Pill>
                          <span className="text-muted-foreground/80">{c.model}</span>
                          <span className="tabular-nums text-muted-foreground/70">{fmtMs(c.latency_ms)} · {c.tokens_total ?? 0} tok{c.tokens_measured ? '' : ' est'} · {fmtMoney(c.cost_usd)}</span>
                          {c.error_class && <Pill tone="bad">{c.error_class}</Pill>}
                          {c.http_status && <span className="text-muted-foreground/60">HTTP {c.http_status}</span>}
                          {c.attempt > 1 && <span className="text-muted-foreground/60">attempt {c.attempt}</span>}
                        </div>
                      ))}
                      {(runDetail.calls || []).length === 0 && <Empty>No model calls recorded.</Empty>}
                    </div>
                    {runDetail.failures?.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-destructive/70 mb-1">documented failures — {runDetail.failures.length}</div>
                        {runDetail.failures.map((f, i) => (
                          <div key={i} className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] mb-1">
                            <Pill tone="bad">{f.kind || f.type || 'failure'}</Pill>
                            <span className="text-muted-foreground/85 ml-2">{f.stage ? `${f.stage} · ` : ''}{f.model ? `${f.model} · ` : ''}{f.message || f.error_message || 'no message'}</span>
                            <span className="text-muted-foreground/50 ml-2">{f.http_status ? `HTTP ${f.http_status} · ` : ''}{fmtTime(f.at)}{f.recovered ? ' · recovered' : ''}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {runDetail.vetoed && (
                      <div className="rounded border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5 text-[11px]">
                        <span className="text-yellow-500/90">veto raised</span> — draft from <span className="text-foreground/80">{runDetail.veto_draft_origin || 'unknown'}</span>, refused by the Governor: {runDetail.veto_reason || 'flag'}. The draft itself is not stored; only its length and digest. Nothing was written to memory or the conversation summary.
                      </div>
                    )}
                    {runDetail.adaptive_decision && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1">adaptive observation (observe mode)</div>
                        <Json value={runDetail.adaptive_decision} />
                      </div>
                    )}
                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1">ledger events for this run — {runDetail.ledger_events?.length ?? 0}</div>
                      {(runDetail.ledger_events || []).map(e => (
                        <div key={e.id} className="flex flex-wrap gap-2 items-center text-[11px] py-0.5">
                          <span className="tabular-nums text-muted-foreground/50">#{e.seq}</span>
                          <Pill tone="info">{e.transition}</Pill>
                          <span className="text-muted-foreground/70">{e.entity_type}:{String(e.entity_id).slice(0, 16)}</span>
                          <span className="ml-auto text-muted-foreground/50">{fmtTime(e.ts_ms)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>
              )}
            </>
          )}

          {tab === 'laws' && (
            <>
              <Card
                title={`Law layer v${laws?.version || '?'} — ${laws?.count ?? 0} laws`}
                subtitle="The single source of truth for what cannot change. Deep-frozen at module load and not runtime-writable; every adaptation is judged against it."
                action={<Pill tone={laws?.runtimeModifiable ? 'bad' : 'ok'}>{laws?.runtimeModifiable ? 'mutable' : 'immutable'}</Pill>}
              >
                {laws?.laws?.map(l => (
                  <div key={l.id} className="rounded border border-border/60 px-2.5 py-2 mb-1.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={l.layer === 'charter' ? 'info' : 'muted'}>{l.layer}</Pill>
                      <span className="font-medium text-foreground/90">{l.name}</span>
                      <span className="text-muted-foreground/60">{l.id}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground/50">{l.source}</span>
                    </div>
                    <p className="mt-1 text-muted-foreground/85 leading-snug">{l.statement}</p>
                    {l.forbids?.length > 0 && <p className="mt-1 text-[10px] text-muted-foreground/60">forbids: {l.forbids.join(' · ')}</p>}
                  </div>
                ))}
              </Card>

              <Card title="Policy Engine" subtitle="Propose an architectural adaptation. The gate judges it, records the judgment in the Improvement Ledger — refusals included — and in v1 applies nothing at runtime except strategy-registry rows.">
                <div className="grid sm:grid-cols-2 gap-2 text-xs">
                  <label className="text-[10px] text-muted-foreground/70">
                    action
                    <select className="mt-0.5 block w-full bg-muted/50 border border-border rounded px-2 py-1 text-xs" value={proposal.action} onChange={(e) => setProposal(p => ({ ...p, action: e.target.value }))}>
                      {(policy?.gatedActions || []).map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </label>
                  <label className="text-[10px] text-muted-foreground/70">
                    target (model id, strategy id, table, law id…)
                    <input className="mt-0.5 block w-full bg-muted/50 border border-border rounded px-2 py-1 text-xs" value={proposal.target} onChange={(e) => setProposal(p => ({ ...p, target: e.target.value }))} placeholder="gpt-5-mini" />
                  </label>
                  <label className="text-[10px] text-muted-foreground/70 sm:col-span-2">
                    cited law ids (comma separated — at least one real law must be cited)
                    <input className="mt-0.5 block w-full bg-muted/50 border border-border rounded px-2 py-1 text-xs" value={proposal.law_refs} onChange={(e) => setProposal(p => ({ ...p, law_refs: e.target.value }))} placeholder="charter.evidence, pin.model_ban" />
                  </label>
                  <label className="text-[10px] text-muted-foreground/70 sm:col-span-2">
                    justification (at least 20 characters — this is what gets recorded in the Improvement Ledger)
                    <input className="mt-0.5 block w-full bg-muted/50 border border-border rounded px-2 py-1 text-xs" value={proposal.justification} onChange={(e) => setProposal(p => ({ ...p, justification: e.target.value }))} placeholder="charter.evidence: the council must only assert what it can verify" />
                  </label>
                  <label className="text-[10px] text-muted-foreground/70 sm:col-span-2">
                    evidence (optional; without it the gate reports evidenceSufficient: false)
                    <input className="mt-0.5 block w-full bg-muted/50 border border-border rounded px-2 py-1 text-xs" value={proposal.evidence} onChange={(e) => setProposal(p => ({ ...p, evidence: e.target.value }))} placeholder="telemetry run run_abc123: p50 latency 4100ms vs 6900ms" />
                  </label>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button onClick={submitProposal} className="px-3 py-1.5 rounded-lg bg-primary/15 text-primary text-xs hover:bg-primary/25">Submit to the gate</button>
                  <span className="text-[10px] text-muted-foreground/60">The default proposal is already a refusal: <code className="bg-muted px-1 rounded">change_model → gpt_5_4</code> is on the banned list. Try <code className="bg-muted px-1 rounded">add_auth</code>, <code className="bg-muted px-1 rounded">weaken_veto</code>, <code className="bg-muted px-1 rounded">register_operator</code> or <code className="bg-muted px-1 rounded">modify_law</code> — all refused and logged.</span>
                </div>
                {proposalResult && (
                  <div className={`mt-3 rounded border px-2.5 py-2 text-xs ${proposalResult.decision === 'approved' ? 'border-green-500/30 bg-green-500/5' : 'border-destructive/30 bg-destructive/5'}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={proposalResult.decision === 'approved' ? 'ok' : 'bad'}>{proposalResult.decision || 'refused'}</Pill>
                      <span className="text-muted-foreground/80">{proposalResult.action || proposal.action}</span>
                      {proposalResult.applied != null && <span className="text-muted-foreground/60">applied: {String(proposalResult.applied)}</span>}
                    </div>
                    {(proposalResult.violations || proposalResult.reasons || []).map((v, i) => (
                      <p key={i} className="mt-1 text-destructive/90">· {typeof v === 'string' ? v : `${v.law}${v.law_name ? ` (${v.law_name})` : ''}: ${v.reason}`}</p>
                    ))}
                    {proposalResult.lawRefs?.length > 0 && <p className="mt-1 text-muted-foreground/80">cited laws: {proposalResult.lawRefs.join(', ')}</p>}
                    {proposalResult.law && <p className="mt-1 text-muted-foreground/80">law: {proposalResult.law}</p>}
                    {proposalResult.requiredJustification && <p className="mt-1 text-muted-foreground/70">requires: {proposalResult.requiredJustification}</p>}
                    {proposalResult.evidenceSufficient != null && <p className="mt-1 text-[10px] text-muted-foreground/60">evidence sufficient: {String(proposalResult.evidenceSufficient)}</p>}
                    {proposalResult.justification && <p className="mt-1 text-[10px] text-muted-foreground/60">justification recorded: “{proposalResult.justification}”</p>}
                    {proposalResult.lawRefs?.length > 0 && <p className="mt-1 text-[10px] text-muted-foreground/60">laws cited: {proposalResult.lawRefs.join(', ')}</p>}
                    {proposalResult.unknownLawRefs?.length > 0 && <p className="mt-1 text-[10px] text-destructive/80">unknown law refs: {proposalResult.unknownLawRefs.join(', ')}</p>}
                    {proposalResult.ledger?.id && <p className="mt-1 text-[10px] text-muted-foreground/60">Improvement Ledger row {proposalResult.ledger.id} — decision “{proposalResult.ledger.decision}”, applied {String(proposalResult.ledger.applied)}</p>}
                    {proposalResult.error && <p className="mt-1 text-destructive/90">{proposalResult.error}</p>}
                  </div>
                )}
              </Card>

              <Card title="Improvement Ledger" subtitle="Append-only record of architectural change: when, what, why (evidence), which law constrains it, and whether it was reverted. A revert appends a new row; nothing is edited.">
                {improvements.length === 0 ? <Empty>No proposals judged yet.</Empty> : (
                  <div className="space-y-1.5">
                    {improvements.map(im => (
                      <div key={im.id} className="rounded border border-border/60 px-2.5 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <Pill tone={im.decision === 'approved' ? 'ok' : 'bad'}>{im.decision}</Pill>
                          <span className="text-foreground/85">{im.action}</span>
                          {im.target && <span className="text-muted-foreground/70">{im.target}</span>}
                          {im.reverted && <Pill tone="warn">reverted</Pill>}
                          {im.applied && <Pill tone="info">applied</Pill>}
                          <span className="ml-auto text-[10px] text-muted-foreground/60">{fmtTime(im.ts_ms || im.created_date)}</span>
                        </div>
                        {im.justification && <p className="mt-1 text-muted-foreground/80">“{im.justification}”</p>}
                        {(im.law_refs?.length || im.reasons?.length || im.evidence) && (
                          <p className="mt-1 text-[10px] text-muted-foreground/60">
                            {im.law_refs?.length ? `laws: ${im.law_refs.join(', ')}` : ''}
                            {im.reasons?.length ? `${im.law_refs?.length ? ' · ' : ''}reasons: ${im.reasons.join(' · ')}` : ''}
                            {im.evidence ? ` · evidence: ${JSON.stringify(im.evidence).slice(0, 200)}` : ''}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
