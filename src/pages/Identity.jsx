// A read-only, human-readable rendering of the canonical server self-model.
// The page does not hard-code COGNOS architecture: it renders /api/identity so
// the prompt, API, and UI cannot silently describe three different systems.

import { useEffect, useMemo, useState } from 'react';
import {
  BookOpenCheck, Bot, Boxes, BrainCircuit, CheckCircle2, ChevronRight,
  CircleSlash2, Cpu, FileSearch, Gauge, GitBranch, Menu, Mic2,
  Network, RefreshCw, Scale, Search, ShieldCheck, Volume2
} from 'lucide-react';
import { api } from '@/lib/api';
import { useCognos } from '@/lib/cognosContext';
import { Card, ErrorNote, Pill } from '@/components/system/SystemUi';

const capabilityIcons = {
  conversation_reasoning: BrainCircuit,
  current_web_search: Search,
  document_analysis: FileSearch,
  link_analysis: Network,
  voice_output: Volume2,
  dictation: Mic2,
  memory: BookOpenCheck,
  bounded_agent: Bot,
  knowledge_observability: Gauge,
};

const subsystemIcons = {
  model_transport: Cpu,
  web_search: Search,
  source_engine: FileSearch,
  agent_runner: Bot,
  knowledge_layer: GitBranch,
  meta_cognition: Gauge,
  policy_engine: Scale,
  governed_stream: ShieldCheck,
  persistence: Boxes,
  voice_layer: Volume2,
};

function bytes(value) {
  if (value == null) return 'not reported';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} KB`;
  return `${value} B`;
}

function statusFor(capability, runtime) {
  switch (capability.id) {
    case 'current_web_search':
      return runtime?.webSearch?.enabled
        ? { label: `enabled · ${runtime.webSearch.provider}`, tone: 'ok' }
        : { label: 'disabled at runtime', tone: 'muted' };
    case 'document_analysis':
    case 'link_analysis':
      return runtime?.sources?.enabled
        ? { label: 'enabled', tone: 'ok' }
        : { label: 'disabled at runtime', tone: 'muted' };
    case 'voice_output':
    case 'dictation':
      return { label: 'browser-dependent', tone: 'info' };
    case 'memory':
      return runtime?.persistence?.databaseConfigured
        ? { label: 'database configured', tone: 'ok' }
        : { label: 'needs database', tone: 'warn' };
    case 'bounded_agent':
      return runtime?.agent?.enabled
        ? { label: 'read-only enabled', tone: 'ok' }
        : { label: 'disabled at runtime', tone: 'muted' };
    case 'knowledge_observability':
      return runtime?.knowledge?.ledgerEnabled || runtime?.knowledge?.telemetryEnabled
        ? { label: 'enabled', tone: 'ok' }
        : { label: 'observation disabled', tone: 'muted' };
    default:
      return { label: 'built in', tone: 'ok' };
  }
}

function OperatorCard({ operator, index }) {
  const sovereign = operator.id === 'governor';
  return (
    <article className={`rounded-lg border p-3 ${sovereign ? 'border-primary/40 bg-primary/5' : 'border-border/70 bg-muted/15'}`}>
      <div className="flex items-start gap-2">
        <span className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[10px] font-semibold ${sovereign ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
          {index + 1}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold">{operator.name}</h3>
            <span className="text-[10px] text-muted-foreground">{operator.role}</span>
            {sovereign && <Pill tone="info">final authority</Pill>}
          </div>
          <p className="text-[11px] text-foreground/80 leading-relaxed mt-1.5">{operator.operation}</p>
          <p className="text-[10px] text-muted-foreground leading-relaxed mt-2"><strong className="text-foreground/60">Authority:</strong> {operator.authority}</p>
        </div>
      </div>
    </article>
  );
}

export default function Identity() {
  const { openSidebar } = useCognos();
  const [identity, setIdentity] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true); setError(null);
    try { setIdentity(await api.identity()); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  useEffect(() => { load(); }, []);

  const runtimeFacts = useMemo(() => {
    if (!identity?.runtime) return [];
    const r = identity.runtime;
    return [
      ['Answer path', r.governance?.soleAnswerRoute],
      ['Final authority', `${r.governance?.finalAuthority}${r.governance?.governorEnabled ? '' : ' (disabled at runtime)'}`],
      ['Critic', r.governance?.criticEnabled ? 'enabled' : 'disabled at runtime'],
      ['Council seats', r.governance?.operators],
      ['Model deadline', r.modelTransport?.timeoutMs != null ? `${r.modelTransport.timeoutMs}ms total` : 'not reported'],
      ['Transient model retries', r.modelTransport?.maxRetries ?? 'not reported'],
      ['Sources per turn', r.sources?.maxPerTurn],
      ['Upload limit', bytes(r.sources?.maxUploadBytes)],
      ['Link limit', bytes(r.sources?.maxLinkBytes)],
      ['Agent modes', (r.agent?.modes || []).join(', ')],
      ['Agent tools', (r.agent?.tools || []).join(', ')],
      ['Agent writes', r.agent?.autonomousWrites ? 'enabled' : 'unavailable'],
      ['Background tasks', r.agent?.backgroundExecution ? 'enabled' : 'unavailable'],
      ['Adaptive behavior', r.knowledge?.adaptiveMode],
      ['Database', r.persistence?.databaseConfigured ? 'configured' : 'not configured'],
    ];
  }, [identity]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="flex items-center gap-2 px-3 md:px-4 py-3 border-b border-border shrink-0" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <button onClick={openSidebar} className="md:hidden p-2 -ml-2 rounded-lg hover:bg-muted"><Menu className="w-5 h-5" /></button>
        <Cpu className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-medium">About COGNOS</h2>
        {identity && <span className="text-[10px] text-muted-foreground/60">self-model v{identity.version}</span>}
        <button onClick={load} className="ml-auto p-1.5 rounded-lg hover:bg-muted" title="Reload identity"><RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} /></button>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 md:px-4 py-4 min-h-0">
        <div className="max-w-5xl mx-auto space-y-4">
          <ErrorNote error={error} />
          {!identity && !error && <p className="text-xs text-muted-foreground text-center py-12">Loading COGNOS self-model…</p>}

          {identity && (
            <>
              <section className="rounded-xl border border-primary/25 bg-gradient-to-br from-primary/10 via-card to-accent/5 p-4 md:p-5">
                <div className="flex flex-col md:flex-row md:items-start gap-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white text-xl font-bold shrink-0">C</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="text-xl font-bold tracking-tight">{identity.name}</h1>
                      <Pill tone="info">{identity.pronunciation}</Pill>
                      <Pill tone="ok">code-owned identity</Pill>
                    </div>
                    <p className="text-sm text-foreground/85 mt-1">{identity.kind}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed mt-2 max-w-3xl">{identity.purpose}</p>
                    <p className="text-[10px] text-muted-foreground/60 mt-3">
                      This page, the chat self-description, and the API derive from one immutable server manifest. Runtime switches are reported separately from built-in abilities.
                    </p>
                  </div>
                </div>
              </section>

              <div className="grid lg:grid-cols-2 gap-4">
                <Card title="Identity rules" subtitle="What COGNOS says about itself—and what it will not pretend to be.">
                  <div className="space-y-2">
                    {(identity.identityRules || []).map(rule => (
                      <div key={rule} className="flex items-start gap-2 text-[11px] leading-relaxed">
                        <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                        <span>{rule}</span>
                      </div>
                    ))}
                  </div>
                </Card>
                <Card title="Four governing principles" subtitle="Every generated or reviewed answer is measured against these charter commitments.">
                  <div className="grid sm:grid-cols-2 gap-2">
                    {(identity.principles || []).map(principle => (
                      <div key={principle.id} className="rounded border border-border/70 p-2.5 bg-muted/15">
                        <div className="text-xs font-semibold">{principle.name}</div>
                        <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{principle.meaning}</p>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>

              <Card title="The six-operator council" subtitle="Exactly six seats. Tools and supporting subsystems do not vote, answer independently, or become a seventh operator.">
                <div className="grid md:grid-cols-2 gap-2">
                  {(identity.operators || []).map((operator, index) => <OperatorCard key={operator.id} operator={operator} index={index} />)}
                </div>
              </Card>

              <Card title="How one turn works, top to bottom" subtitle="The complete lifecycle from the user's input to a governed answer, durable record, and optional speech.">
                <ol className="space-y-1">
                  {(identity.turnFlow || []).map(item => (
                    <li key={item.step} className="group flex gap-2.5 rounded-lg px-2 py-2 hover:bg-muted/20">
                      <span className="w-6 h-6 rounded-md bg-muted flex items-center justify-center tabular-nums text-[10px] text-muted-foreground shrink-0">{item.step}</span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1 text-xs font-medium"><ChevronRight className="w-3 h-3 text-primary" />{item.name}</div>
                        <p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">{item.operation}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>

              <Card title="What COGNOS can do" subtitle="A capability is labeled by actual runtime availability; disabled or browser-dependent features are not presented as active.">
                <div className="grid md:grid-cols-2 gap-2">
                  {(identity.capabilities || []).map(capability => {
                    const Icon = capabilityIcons[capability.id] || Boxes;
                    const status = statusFor(capability, identity.runtime);
                    return (
                      <article key={capability.id} className="rounded-lg border border-border/70 p-3 bg-muted/10">
                        <div className="flex items-center gap-2">
                          <Icon className="w-4 h-4 text-primary shrink-0" />
                          <h3 className="text-xs font-semibold flex-1">{capability.name}</h3>
                          <Pill tone={status.tone}>{status.label}</Pill>
                        </div>
                        <p className="text-[10px] text-muted-foreground leading-relaxed mt-2">{capability.operation}</p>
                      </article>
                    );
                  })}
                </div>
              </Card>

              <div className="grid lg:grid-cols-[1.35fr_0.65fr] gap-4">
                <Card title="Supporting subsystems" subtitle="These parts inform, protect, persist, or observe the council. None has final-answer authority.">
                  <div className="space-y-2">
                    {(identity.supportingSubsystems || []).map(subsystem => {
                      const Icon = subsystemIcons[subsystem.id] || Boxes;
                      return (
                        <div key={subsystem.id} className="flex items-start gap-2.5 rounded border border-border/60 p-2.5">
                          <Icon className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                          <div>
                            <p className="text-xs font-medium">{subsystem.name}</p>
                            <p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">{subsystem.operation}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>

                <Card title="Runtime facts" subtitle={`Generated ${new Date(identity.generatedAt).toLocaleString()}. No credential values are exposed.`}>
                  <dl className="space-y-0.5">
                    {runtimeFacts.map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-3 border-b border-border/50 py-1.5 last:border-0">
                        <dt className="text-[10px] text-muted-foreground">{label}</dt>
                        <dd className="text-[10px] text-right break-words">{String(value ?? '—')}</dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              </div>

              <Card title="Hard boundaries and honest limits" subtitle="Knowing itself includes knowing what it cannot do or must never bypass.">
                <div className="grid md:grid-cols-2 gap-x-4 gap-y-2">
                  {(identity.boundaries || []).map(boundary => (
                    <div key={boundary} className="flex items-start gap-2 text-[10px] text-muted-foreground leading-relaxed">
                      <CircleSlash2 className="w-3.5 h-3.5 text-yellow-500 shrink-0 mt-0.5" />
                      <span>{boundary}</span>
                    </div>
                  ))}
                </div>
              </Card>

              <Card title="Implementation map" subtitle="Where each major part lives in the repository and what it owns.">
                <div className="overflow-x-auto scrollbar-thin">
                  <table className="w-full text-left text-[10px] min-w-[620px]">
                    <thead className="text-muted-foreground uppercase tracking-wide">
                      <tr><th className="py-2 pr-3">Area</th><th className="py-2 pr-3">Location</th><th className="py-2">Responsibility</th></tr>
                    </thead>
                    <tbody>
                      {(identity.implementationMap || []).map(item => (
                        <tr key={item.area} className="border-t border-border/60 align-top">
                          <td className="py-2 pr-3 font-medium text-foreground/85">{item.area}</td>
                          <td className="py-2 pr-3 font-mono text-primary/80 whitespace-nowrap">{item.location}</td>
                          <td className="py-2 text-muted-foreground leading-relaxed">{item.responsibility}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
