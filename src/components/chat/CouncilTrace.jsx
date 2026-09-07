// Council trace — a collapsible panel rendered under assistant messages that have
// council metadata from chatOrchestrate. Lets the user watch the pipeline reason:
// Observer classification -> Strategist plan -> Specialist sub-tasks -> Critic ->
// revisions -> Governor. Session-only (not persisted on the message).
//
// PHASE 14/15 ADDITION: one extra collapsible section, "Knowledge & telemetry",
// showing what the run did to the store and what it cost. It renders only when
// those fields are present, so an older persisted message draws exactly what it
// drew before. Nothing here is a second channel to the user: it is the same
// council object the message already carries.

import { useState } from 'react';
import { ChevronRight, Brain, ShieldCheck, AlertTriangle, RefreshCw } from 'lucide-react';

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60 mb-1.5">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Field({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex gap-1.5">
      <span className="text-muted-foreground/60">{label}:</span>
      <span className="text-foreground/80">{String(value)}</span>
    </div>
  );
}

export default function CouncilTrace({ council }) {
  const [open, setOpen] = useState(false);
  if (!council) return null;
  const {
    classification, plan, subTasks, critic, revisions, governor, modelUsed, latencyMs,
    memoriesUsed, webSearch, stageTimings,
    // Phase 14 — the knowledge layer; Phase 15 — the run's telemetry record.
    coherence, knowledge, telemetry, strategy, runId
  } = council || {};
  if (!classification && !plan && !critic && !webSearch && !stageTimings) return null;
  const hasKnowledgeSection = Boolean(coherence || knowledge || telemetry || strategy || runId);

  const score = critic?.score;
  const summary = [
    classification?.task_type,
    classification?.complexity,
    plan === 'decomposed' ? 'decomposed' : 'direct',
    webSearch ? 'web search' : null
  ].filter(Boolean).join(' • ');

  return (
    <div className="mt-2 border border-border rounded-lg bg-muted/30 text-xs">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Brain className="w-3.5 h-3.5 text-accent" />
        <span className="font-medium text-muted-foreground">Council</span>
        <span className="text-muted-foreground/70 truncate flex-1 text-left">{summary}</span>
        {score != null && !critic?.skipped && (
          <span className={`px-1.5 py-0.5 rounded font-medium ${score >= 7 ? 'text-green-400' : score >= 5 ? 'text-yellow-400' : 'text-red-400'}`}>
            {score}/10
          </span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-border/60 pt-3">
          {critic?.charter && (
            <Section title="Charter">
              <div className="flex flex-wrap gap-1.5">
                {['truth', 'evidence', 'agency', 'dignity'].map(p => {
                  const ok = critic.charter[p];
                  return (
                    <span key={p} className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${ok ? 'text-green-400 bg-green-400/10' : 'text-red-400 bg-red-400/10'}`}>
                      {p}
                    </span>
                  );
                })}
              </div>
              {critic.charter.note && <p className="text-muted-foreground">{critic.charter.note}</p>}
            </Section>
          )}
          {Array.isArray(memoriesUsed) && memoriesUsed.length > 0 && (
            <Section title={`Memory (${memoriesUsed.length})`}>
              {memoriesUsed.map(m => {
                const ev = m.evidence;
                const evColor = ev === 'direct' ? 'text-green-400 bg-green-400/10'
                  : ev === 'repeated' ? 'text-primary bg-primary/10'
                  : ev === 'inferred' ? 'text-amber-400 bg-amber-400/10'
                  : ev === 'assumed' ? 'text-red-400 bg-red-400/10' : '';
                return (
                  <div key={m.id} className="flex items-start gap-1.5">
                    {ev && <span className={`mt-0.5 px-1 py-0.5 rounded text-[9px] font-medium uppercase shrink-0 ${evColor}`}>{ev}</span>}
                    <p className="text-muted-foreground/80 leading-relaxed flex-1">{m.preview}</p>
                  </div>
                );
              })}
            </Section>
          )}
          {classification && (
            <Section title="Observer">
              <Field label="Task" value={classification.task_type} />
              <Field label="Complexity" value={classification.complexity} />
              <Field label="Intent" value={classification.intent} />
              {classification.needs_decomposition && (
                <span className="inline-block px-1.5 py-0.5 rounded bg-accent/15 text-accent">needs decomposition</span>
              )}
            </Section>
          )}

          {webSearch && (
            <Section title="Web Search">
              <Field label="Query" value={webSearch.query} />
              <p className="text-foreground/70 whitespace-pre-wrap line-clamp-8 leading-relaxed">{webSearch.results}</p>
              {webSearch.model && <span className="text-muted-foreground/60 text-[10px]">via {webSearch.model}</span>}
            </Section>
          )}

          {plan && (
            <Section title="Strategist">
              <Field label="Plan" value={plan} />
            </Section>
          )}

          {Array.isArray(subTasks) && subTasks.length > 0 && (
            <Section title={`Specialist (${subTasks.length})`}>
              {subTasks.map((st, i) => (
                <div key={st.id || i} className="rounded-md border border-border/60 p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent font-medium uppercase text-[10px]">{st.agent}</span>
                    <span className={`text-[10px] ${st.status === 'complete' ? 'text-green-400' : st.status === 'error' ? 'text-red-400' : 'text-muted-foreground'}`}>
                      {st.status}
                    </span>
                  </div>
                  <p className="text-muted-foreground mb-1">{st.description}</p>
                  {st.output && <p className="text-foreground/70 line-clamp-4 whitespace-pre-wrap">{st.output}</p>}
                </div>
              ))}
            </Section>
          )}

          {critic && (
            <Section title="Critic">
              {critic.skipped ? (
                <span className="text-muted-foreground">skipped ({critic.reason})</span>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    {score != null && <span className="px-1.5 py-0.5 rounded font-medium bg-muted text-foreground">Score {score}/10</span>}
                    {critic.needs_revision && (
                      <span className="flex items-center gap-1 text-red-400"><AlertTriangle className="w-3 h-3" />needs revision</span>
                    )}
                  </div>
                  {critic.reasoning && <p className="text-muted-foreground">{critic.reasoning}</p>}
                </>
              )}
            </Section>
          )}

          {revisions && revisions.triggered && (
            <Section title="Revisions">
              <span className="flex items-center gap-1 text-muted-foreground">
                <RefreshCw className="w-3 h-3" /> {revisions.count} of {revisions.maxRevisions} revision{revisions.count !== 1 ? 's' : ''} applied
              </span>
            </Section>
          )}

          {governor && (
            <Section title="Governor">
              {governor.approved ? (
                <span className="flex items-center gap-1 text-green-400"><ShieldCheck className="w-3 h-3" /> approved</span>
              ) : (
                <span className="flex items-center gap-1 text-yellow-400"><ShieldCheck className="w-3 h-3" /> flagged</span>
              )}
              {Array.isArray(governor.flags) && governor.flags.length > 0 && (
                <p className="text-muted-foreground">{governor.flags.join(', ')}</p>
              )}
            </Section>
          )}

          {stageTimings && typeof stageTimings === 'object' && Object.keys(stageTimings).length > 0 && (
            <Section title="Timing">
              {(() => {
                const order = ['contextAssembly', 'observer', 'webSearch', 'strategist', 'specialist', 'synthesizer', 'critic', 'governor', 'memoryExtraction', 'auditLog'];
                const entries = Object.entries(stageTimings).sort((a, b) => {
                  const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0]);
                  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
                });
                const max = Math.max(...entries.map(([, v]) => v.totalMs), 1);
                return entries.map(([stage, t]) => (
                  <div key={stage}>
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground/80 flex-1 truncate">{stage}</span>
                      {t.runs > 1 && <span className="text-muted-foreground/50">×{t.runs}</span>}
                      <span className="text-foreground/80 tabular-nums">{(t.totalMs / 1000).toFixed(1)}s</span>
                    </div>
                    <div className="h-1 rounded-full bg-muted mt-0.5 overflow-hidden">
                      <div className={`h-full rounded-full ${t.lastStatus === 'error' ? 'bg-destructive' : 'bg-primary/60'}`} style={{ width: `${Math.max(2, (t.totalMs / max) * 100)}%` }} />
                    </div>
                  </div>
                ));
              })()}
              {latencyMs != null && (
                <div className="flex justify-between pt-1 text-muted-foreground/60 border-t border-border/40">
                  <span>wall total</span>
                  <span className="tabular-nums">{(latencyMs / 1000).toFixed(1)}s</span>
                </div>
              )}
            </Section>
          )}

          {hasKnowledgeSection && (
            <Section title="Knowledge & telemetry">
              {coherence && coherence.checked && (
                <Field label="coherence" value={`${coherence.verdict}${coherence.beliefsConsidered ? ` (of ${coherence.beliefsConsidered} belief${coherence.beliefsConsidered === 1 ? '' : 's'})` : ''}`} />
              )}
              {coherence && !coherence.checked && <Field label="coherence" value={`not checked — ${coherence.reason || 'monitor off'}`} />}
              {coherence?.contradictions?.length > 0 && (
                <div className="space-y-1 rounded border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-yellow-500/80">contradiction — logged as a transition, not an error</div>
                  {coherence.contradictions.map((c, i) => (
                    <div key={i} className="text-muted-foreground/90">
                      “{String(c.claim || '').slice(0, 140)}”
                      {c.confidence != null && <span className="text-muted-foreground/60"> · confidence {Number(c.confidence).toFixed(2)}</span>}
                      {c.beliefId && <span className="text-muted-foreground/50"> · belief {c.beliefId}</span>}
                    </div>
                  ))}
                </div>
              )}
              {coherence?.confirmations?.length > 0 && (
                <Field label="confirmations" value={coherence.confirmations.map(c => String(c.claim || '').slice(0, 60)).join(' | ')} />
              )}
              {coherence?.hypotheses?.length > 0 && (
                <Field label="new hypotheses" value={coherence.hypotheses.map(h => `${String(h.claim || '').slice(0, 60)} @${Number(h.confidence ?? 0).toFixed(2)}`).join(' | ')} />
              )}
              {knowledge && (
                <Field label="ledger" value={`${knowledge.ledgerEvents ?? 0} event(s) written this run${knowledge.enabled === false ? ` — ${knowledge.reason || 'disabled'}` : ''}`} />
              )}
              {knowledge?.relationship && (
                <Field label="relationship" value={`${knowledge.relationship.direction}${knowledge.relationship.strength != null ? ` → strength ${Number(knowledge.relationship.strength).toFixed(3)}` : ''}`} />
              )}
              {knowledge?.decay && (
                <Field label="decay sweep" value={`${knowledge.decay.events ?? 0} weakened link(s) of ${knowledge.decay.considered ?? 0} considered`} />
              )}
              {telemetry && (
                <Field
                  label="telemetry"
                  value={`${telemetry.status} · ${telemetry.modelCalls ?? 0} model call(s) · ${telemetry.tokens?.total ?? 0} tokens${telemetry.tokens?.measured ? '' : ' (estimated)'} · $${Number(telemetry.costUsd ?? 0).toFixed(5)}`}
                />
              )}
              {telemetry?.confidence != null && (
                <Field label="confidence" value={`${Number(telemetry.confidence).toFixed(2)} from ${telemetry.confidenceSource || 'n/a'}`} />
              )}
              {telemetry?.failures?.length > 0 && (
                <div className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-destructive/90">
                  {telemetry.failures.map((f, i) => (
                    <div key={i}>{f.kind || f.type || 'failure'}{f.stage ? ` at ${f.stage}` : ''}{f.model ? ` (${f.model})` : ''}{f.message || f.error_message ? ` — ${String(f.message || f.error_message).slice(0, 120)}` : ''}</div>
                  ))}
                </div>
              )}
              {telemetry?.vetoed && (
                <Field label="veto recorded" value={`${telemetry.vetoDraftOrigin || 'draft'} refused: ${telemetry.vetoReason || 'governor flag'} — nothing written to memory`} />
              )}
              {strategy && <Field label="strategy" value={`${strategy.id} · ${strategy.mode} mode · switched: ${strategy.switched ? 'yes' : 'no'}`} />}
              {runId && <Field label="run" value={runId} />}
            </Section>
          )}

          <div className="flex items-center gap-3 text-muted-foreground/70 pt-1 border-t border-border/60">
            {modelUsed && <span>model: {modelUsed}</span>}
            {latencyMs != null && <span>{(latencyMs / 1000).toFixed(1)}s</span>}
          </div>
        </div>
      )}
    </div>
  );
}