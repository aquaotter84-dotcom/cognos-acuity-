// PHASE 23 ADDITION — the Atlas tab. A window onto the trust-annotated
// knowledge graph: overview counts, query, node/edge instruments, conflicts,
// snapshots with Merkle diffs, provenance verification, coverage, and the
// user-controlled curation acts (pin / fork / revise / retire / trust).
//
// Curation mints new rows and ledger events; nothing is overwritten and
// nothing is deleted. The graph never answers — citations in an answer are
// audited by the Governor against the nodes the turn actually loaded.

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, Empty, ErrorNote, Json, Pill, fmtMs, fmtTime } from './SystemUi';

const NODE_TYPES = ['', 'concept', 'person', 'source', 'event', 'intent'];
const TRUSTS = ['', 'verified', 'trusted', 'untrusted', 'flagged'];
const STATUSES = ['', 'active', 'pinned', 'retired'];
const EDGE_KINDS = ['is-about', 'in-source', 'refines', 'contradicts', 'supports', 'revision', 'fork'];

const trustTone = (t) => (t === 'verified' ? 'ok' : t === 'trusted' ? 'info' : t === 'flagged' ? 'bad' : 'warn');
const statusTone = (s) => (s === 'retired' ? 'muted' : s === 'pinned' ? 'info' : 'ok');

export default function GraphTab() {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [overview, setOverview] = useState(null);
  const [verify, setVerify] = useState(null);
  const [coverage, setCoverage] = useState(null);

  const [filter, setFilter] = useState({ type: '', trust: '', status: '', q: '', truthOnly: false, limit: 60 });
  const [nodes, setNodes] = useState([]);
  const [selected, setSelected] = useState(null);

  const [qbox, setQbox] = useState({ q: '', truthOnly: false });
  const [qres, setQres] = useState(null);

  const [conflicts, setConflicts] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [diff, setDiff] = useState(null);
  const [diffSel, setDiffSel] = useState({ a: '', b: '' });

  const [create, setCreate] = useState({ type: 'concept', label: '', content: '', trust: 'untrusted' });
  const [edge, setEdge] = useState({ srcNodeId: '', dstNodeId: '', kind: 'is-about', note: '' });

  const loadAll = useCallback(async (nodeFilter = filter) => {
    setBusy(true); setError(null);
    try {
      const [ov, list, conf, snaps, ver, cov] = await Promise.all([
        api.graphOverview(),
        api.graphNodes({ ...nodeFilter, truthOnly: nodeFilter.truthOnly ? '1' : '' }),
        api.graphConflicts({ limit: 30 }),
        api.graphSnapshots(),
        api.graphVerify().catch(() => null),
        api.graphCoverage().catch(() => null),
      ]);
      setOverview(ov);
      setNodes(list.nodes || []);
      setConflicts(conf.conflicts || []);
      setSnapshots(snaps.snapshots || []);
      setVerify(ver);
      setCoverage(cov);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [filter]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const openNode = useCallback(async (id) => {
    setBusy(true); setError(null);
    try {
      setSelected(await api.graphNode(id));
    } catch (e) {
      setError(e.message || String(e)); setSelected(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const act = useCallback(async (fn, reload = true) => {
    setBusy(true); setError(null);
    try {
      await fn();
      if (selected) setSelected(await api.graphNode(selected.node.id));
      if (reload) await loadAll();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [loadAll, selected]);

  const runQuery = async () => {
    if (!qbox.q.trim()) { setQres(null); return; }
    setBusy(true); setError(null);
    try {
      setQres(await api.graphQuery({ q: qbox.q, truthOnly: qbox.truthOnly ? '1' : '', limit: 12 }));
    } catch (e) {
      setError(e.message || String(e)); setQres(null);
    } finally {
      setBusy(false);
    }
  };

  const runDiff = async () => {
    if (!diffSel.a || !diffSel.b) { setDiff(null); return; }
    setBusy(true); setError(null);
    try {
      setDiff(await api.graphDiffSnapshots(diffSel.a, diffSel.b));
    } catch (e) {
      setError(e.message || String(e)); setDiff(null);
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'bg-muted/50 border border-border rounded px-2 py-1 text-xs';

  return (
    <div className="space-y-3">
      <ErrorNote error={error} />

      {overview && (
        <Card title="Atlas overview" subtitle="What the user-controlled, append-only graph holds. Sessions, sources, and intents stitch here — the Governor consults it before drafting and cites only what the turn loaded.">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <div className="rounded border border-border/60 p-2"><div className="text-[10px] text-muted-foreground/60 uppercase">nodes</div><div className="text-lg tabular-nums">{overview.nodes?.total ?? 0}</div><div className="text-[10px] text-muted-foreground/70">{overview.nodes?.active ?? 0} active · {overview.nodes?.pinned ?? 0} pinned · {overview.nodes?.retired ?? 0} retired</div></div>
            <div className="rounded border border-border/60 p-2"><div className="text-[10px] text-muted-foreground/60 uppercase">edges</div><div className="text-lg tabular-nums">{overview.edges?.total ?? 0}</div><div className="text-[10px] text-muted-foreground/70">{overview.edges?.active ?? 0} active · {overview.edges?.retired ?? 0} retired</div></div>
            <div className="rounded border border-border/60 p-2"><div className="text-[10px] text-muted-foreground/60 uppercase">open conflicts</div><div className="text-lg tabular-nums">{overview.openConflicts ?? 0}</div><div className="text-[10px] text-muted-foreground/70">contradicts, live ends</div></div>
            <div className="rounded border border-border/60 p-2"><div className="text-[10px] text-muted-foreground/60 uppercase">snapshots</div><div className="text-lg tabular-nums">{overview.snapshots ?? 0}</div><div className="text-[10px] text-muted-foreground/70">immutable · Merkle</div></div>
            <div className="rounded border border-border/60 p-2">
              <div className="text-[10px] text-muted-foreground/60 uppercase">seals</div>
              <div className="text-lg tabular-nums flex items-center gap-1.5">
                {verify ? (verify.ok ? <ShieldCheck className="w-5 h-5 text-green-400" /> : <Pill tone="bad">{verify.mismatches ?? '?'} mismatches</Pill>) : '—'}
              </div>
              <div className="text-[10px] text-muted-foreground/70">{verify ? `${verify.nodesChecked ?? 0} nodes · ${verify.edgesChecked ?? 0} edges recomputed` : 'not checked'}</div>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(overview.nodes?.byType || []).map(t => <Pill key={t.type} tone="muted">{t.type} ×{t.count}</Pill>)}
            {(overview.nodes?.byTrust || []).map(t => <Pill key={t.trust} tone={trustTone(t.trust)}>{t.trust} ×{t.count}</Pill>)}
          </div>
          {coverage && (
            <div className="mt-2 text-[11px] text-muted-foreground">
              coverage: <span className="text-foreground/85 tabular-nums">{coverage.coveragePct ?? '—'}%</span> of session content reachable from the graph · {coverage.events ?? 0} projected events, {coverage.intents ?? 0} intents, {coverage.concepts ?? 0} concepts
              {coverage.conversations != null && <span> · {coverage.conversations} conversations</span>}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <button onClick={() => loadAll()} disabled={busy} className="px-3 py-1.5 rounded-lg bg-primary/15 text-primary text-xs hover:bg-primary/25 disabled:opacity-50">Refresh</button>
          </div>
        </Card>
      )}

      <Card title="Query" subtitle="The same bounded relevance query the turn uses — indexed overlap, under the 150ms target. truthOnly admits only nodes standing under the truth floor.">
        <div className="flex flex-wrap gap-2 items-end">
          <input className={`${inputCls} flex-1 min-w-[14rem]`} placeholder="what does the graph know about…" value={qbox.q} onChange={(e) => setQbox(s => ({ ...s, q: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') runQuery(); }} />
          <label className="text-[11px] text-muted-foreground flex items-center gap-1.5"><input type="checkbox" checked={qbox.truthOnly} onChange={(e) => setQbox(s => ({ ...s, truthOnly: e.target.checked }))} /> truthOnly</label>
          <button onClick={runQuery} disabled={busy} className="px-3 py-1.5 rounded-lg bg-primary/15 text-primary text-xs hover:bg-primary/25 disabled:opacity-50">Ask the atlas</button>
        </div>
        {qres && (
          <div className="mt-2 space-y-1">
            <div className="text-[10px] text-muted-foreground/70">{qres.count} node(s) · {fmtMs(qres.latencyMs)} (target ≤ {qres.latencyTargetMs}ms)</div>
            {qres.nodes.map(n => (
              <button key={n.id} onClick={() => openNode(n.id)} className="w-full text-left rounded border border-border/60 hover:border-primary/40 px-2 py-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="muted">{n.type}</Pill>
                  <Pill tone={trustTone(n.trust)}>{n.trust}</Pill>
                  <Pill tone={statusTone(n.status)}>{n.status}</Pill>
                  <span className="text-foreground/85 truncate flex-1">{n.label}</span>
                  <span className="tabular-nums text-muted-foreground/60">{n.id}</span>
                </div>
              </button>
            ))}
            {qres.nodes.length === 0 && <Empty>Nothing relevant — the atlas answers only what it holds.</Empty>}
          </div>
        )}
      </Card>

      <Card title="Nodes" subtitle="Click a row to inspect its edges, lineage, and provenance seal — and to curate it.">
        <div className="flex flex-wrap gap-2 mb-2">
          <select className={inputCls} value={filter.type} onChange={(e) => setFilter(f => ({ ...f, type: e.target.value }))}>
            {NODE_TYPES.map(t => <option key={t} value={t}>{t || 'all types'}</option>)}
          </select>
          <select className={inputCls} value={filter.trust} onChange={(e) => setFilter(f => ({ ...f, trust: e.target.value }))}>
            {TRUSTS.map(t => <option key={t} value={t}>{t || 'any trust'}</option>)}
          </select>
          <select className={inputCls} value={filter.status} onChange={(e) => setFilter(f => ({ ...f, status: e.target.value }))}>
            {STATUSES.map(t => <option key={t} value={t}>{t || 'any status'}</option>)}
          </select>
          <input className={`${inputCls} flex-1 min-w-[10rem]`} placeholder="search label / content / id…" value={filter.q} onChange={(e) => setFilter(f => ({ ...f, q: e.target.value }))} />
          <label className="text-[11px] text-muted-foreground flex items-center gap-1.5"><input type="checkbox" checked={filter.truthOnly} onChange={(e) => setFilter(f => ({ ...f, truthOnly: e.target.checked }))} /> truthOnly</label>
        </div>
        {nodes.length === 0 ? <Empty>No nodes match. Approved turns project their exchange here.</Empty> : (
          <div className="space-y-1 max-h-72 overflow-auto scrollbar-thin">
            {nodes.map(n => (
              <button key={n.id} onClick={() => openNode(n.id)} className={`w-full text-left rounded border px-2 py-1.5 text-xs ${selected?.node?.id === n.id ? 'border-primary/50 bg-primary/5' : 'border-border/60 hover:border-primary/40'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="muted">{n.type}</Pill>
                  <Pill tone={trustTone(n.trust)}>{n.trust}</Pill>
                  <Pill tone={statusTone(n.status)}>{n.status}</Pill>
                  <span className="text-foreground/85 truncate flex-1">{n.label}</span>
                  <span className="tabular-nums text-muted-foreground/50 text-[10px]">{n.id}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {selected && (
        <Card
          title={`${selected.node.type}:${selected.node.id}`}
          subtitle={`v${selected.node.version} · ${fmtTime(selected.node.created_at)} · seal ${selected.seal?.sealOk ? 'holds' : 'BROKEN'} · hash ${String(selected.node.provenance_hash || '').slice(0, 12)}…`}
          action={<button onClick={() => setSelected(null)} className="text-[10px] text-muted-foreground hover:text-foreground">close</button>}
        >
          <div className="flex flex-wrap gap-2 mb-2">
            <Pill tone={trustTone(selected.node.trust)}>{selected.node.trust}</Pill>
            <Pill tone={statusTone(selected.node.status)}>{selected.node.status}</Pill>
            <Pill>confidence {Number(selected.node.confidence ?? 0).toFixed(2)}</Pill>
            {selected.node.pinned && <Pill tone="info">pinned</Pill>}
          </div>
          <p className="text-xs text-foreground/90 mb-1 font-medium">{selected.node.label}</p>
          <Json value={selected.node.content} />
          <div className="mt-2 flex flex-wrap gap-2">
            <button disabled={busy || selected.node.status === 'retired'} onClick={() => act(() => api.graphPinNode(selected.node.id))} className="px-2.5 py-1 rounded-lg bg-primary/15 text-primary text-[11px] hover:bg-primary/25 disabled:opacity-40">Pin</button>
            <button disabled={busy || selected.node.status === 'retired'} onClick={() => { const note = window.prompt('Fork note (optional)', ''); if (note !== null) act(() => api.graphForkNode(selected.node.id, { note })); }} className="px-2.5 py-1 rounded-lg bg-primary/15 text-primary text-[11px] hover:bg-primary/25 disabled:opacity-40">Fork</button>
            <button disabled={busy || selected.node.status === 'retired'} onClick={() => { const content = window.prompt('Revised content (empty keeps current)', selected.node.content || ''); if (content !== null) { const note = window.prompt('Revision note (optional)', '') || ''; act(() => api.graphReviseNode(selected.node.id, { content: content || undefined, note })); } }} className="px-2.5 py-1 rounded-lg bg-primary/15 text-primary text-[11px] hover:bg-primary/25 disabled:opacity-40">Revise</button>
            <button disabled={busy || selected.node.status === 'retired'} onClick={() => { const note = window.prompt('Retire reason (recorded on the ledger)', ''); if (note !== null) act(() => api.graphRetireNode(selected.node.id, { note })); }} className="px-2.5 py-1 rounded-lg bg-destructive/15 text-destructive text-[11px] hover:bg-destructive/25 disabled:opacity-40">Retire</button>
            {['verified', 'trusted', 'untrusted', 'flagged'].filter(t => t !== selected.node.trust).map(t => (
              <button key={t} disabled={busy} onClick={() => act(() => api.graphTrustNode(selected.node.id, { trust: t }))} className="px-2.5 py-1 rounded-lg bg-muted text-muted-foreground text-[11px] hover:bg-muted/70 disabled:opacity-40">→ {t}</button>
            ))}
          </div>
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1">edges — {selected.edges?.length ?? 0}</div>
            {(selected.edges || []).length === 0 ? <Empty>Isolated — no edges touch this node.</Empty> : (
              <div className="space-y-1">
                {selected.edges.map(e => (
                  <div key={e.id} className="flex flex-wrap gap-2 items-center rounded border border-border/50 px-2 py-1 text-[11px]">
                    <Pill tone={e.kind === 'contradicts' ? 'warn' : 'info'}>{e.kind}</Pill>
                    <button className="text-foreground/80 hover:text-primary underline decoration-dotted" onClick={() => openNode(e.src_node_id === selected.node.id ? e.dst_node_id : e.src_node_id)}>{e.src_node_id === selected.node.id ? `→ ${String(e.dst_node_id).slice(0, 18)}` : `${String(e.src_node_id).slice(0, 18)} →`}</button>
                    <Pill tone={trustTone(e.trust)}>{e.trust}</Pill>
                    <Pill tone={statusTone(e.status)}>{e.status}</Pill>
                    {e.status !== 'retired' && (
                      <button className="ml-auto text-[10px] text-destructive/80 hover:text-destructive" disabled={busy} onClick={() => { if (window.confirm(`Retire edge ${e.id}? The row and its history stay.`)) act(() => api.graphRetireEdge(e.id)); }}>retire</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1">lineage — {selected.lineage?.count ?? 0} event(s)</div>
            {(selected.lineage?.events || []).length === 0 ? <Empty>No ledger events.</Empty> : (
              <div className="space-y-1">
                {selected.lineage.events.map(h => (
                  <div key={h.id || h.seq} className="flex flex-wrap gap-2 items-center text-[11px]">
                    <span className="tabular-nums text-muted-foreground/50">#{h.seq}</span>
                    <Pill tone="info">{h.transition}</Pill>
                    <span className="text-muted-foreground/70">{fmtTime(h.at || h.ts_ms)}</span>
                    {h.delta && <span className="text-foreground/70">Δ {JSON.stringify(h.delta).slice(0, 160)}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      )}

      <Card title="Curate" subtitle="Create nodes and edges directly. Both calls are idempotent — re-sending the same content returns the existing row.">
        <div className="grid sm:grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1">new node</div>
            <div className="space-y-1.5">
              <div className="flex gap-1.5">
                <select className={inputCls} value={create.type} onChange={(e) => setCreate(c => ({ ...c, type: e.target.value }))}>
                  {['concept', 'person', 'source', 'event', 'intent'].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <select className={inputCls} value={create.trust} onChange={(e) => setCreate(c => ({ ...c, trust: e.target.value }))}>
                  {['verified', 'trusted', 'untrusted', 'flagged'].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <input className={`${inputCls} w-full`} placeholder="label" value={create.label} onChange={(e) => setCreate(c => ({ ...c, label: e.target.value }))} />
              <input className={`${inputCls} w-full`} placeholder="content (defaults to label)" value={create.content} onChange={(e) => setCreate(c => ({ ...c, content: e.target.value }))} />
              <button disabled={busy || !create.label.trim()} onClick={() => act(async () => { const out = await api.graphCreateNode({ type: create.type, label: create.label, content: create.content || create.label, trust: create.trust }); setCreate({ type: 'concept', label: '', content: '', trust: 'untrusted' }); if (out.node) setSelected(await api.graphNode(out.node.id)); }, true)} className="px-3 py-1.5 rounded-lg bg-primary/15 text-primary text-xs hover:bg-primary/25 disabled:opacity-40">Create node</button>
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-1">new edge</div>
            <div className="space-y-1.5">
              <input className={`${inputCls} w-full`} placeholder="source node id (graph_…)" value={edge.srcNodeId} onChange={(e) => setEdge(c => ({ ...c, srcNodeId: e.target.value }))} />
              <input className={`${inputCls} w-full`} placeholder="target node id (graph_…)" value={edge.dstNodeId} onChange={(e) => setEdge(c => ({ ...c, dstNodeId: e.target.value }))} />
              <div className="flex gap-1.5">
                <select className={inputCls} value={edge.kind} onChange={(e) => setEdge(c => ({ ...c, kind: e.target.value }))}>
                  {EDGE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
                <input className={`${inputCls} flex-1`} placeholder="note (optional)" value={edge.note} onChange={(e) => setEdge(c => ({ ...c, note: e.target.value }))} />
              </div>
              <button disabled={busy || !edge.srcNodeId.trim() || !edge.dstNodeId.trim()} onClick={() => act(async () => { await api.graphCreateEdge({ srcNodeId: edge.srcNodeId, dstNodeId: edge.dstNodeId, kind: edge.kind, note: edge.note }); setEdge({ srcNodeId: '', dstNodeId: '', kind: 'is-about', note: '' }); })} className="px-3 py-1.5 rounded-lg bg-primary/15 text-primary text-xs hover:bg-primary/25 disabled:opacity-40">Create edge</button>
            </div>
          </div>
        </div>
      </Card>

      <Card title="Conflicts" subtitle="contradicts edges between live nodes — the Critic reads these before judging, and they are resolved by retiring or revising, never by deleting.">
        {conflicts.length === 0 ? <Empty>No open contradictions. The atlas agrees with itself.</Empty> : (
          <div className="space-y-1.5">
            {conflicts.map(({ edge: e, src, dst }) => (
              <div key={e.id} className="rounded border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="warn">contradicts</Pill>
                  <button className="text-foreground/85 hover:text-primary underline decoration-dotted" onClick={() => openNode(e.src_node_id)}>“{String(src?.label || e.src_node_id).slice(0, 80)}”</button>
                  <span className="text-muted-foreground/60">vs</span>
                  <button className="text-foreground/85 hover:text-primary underline decoration-dotted" onClick={() => openNode(e.dst_node_id)}>“{String(dst?.label || e.dst_node_id).slice(0, 80)}”</button>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground/60">edge {e.id} · {fmtTime(e.created_at)} · weight {Number(e.weight ?? 0).toFixed(2)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Snapshots" subtitle="Immutable, Merkle-rooted captures of the live graph. The diff names exactly which nodes and edges were added or retired between two captures.">
        <div className="flex flex-wrap gap-2 mb-2">
          <button disabled={busy} onClick={() => act(async () => { const note = window.prompt('Snapshot note (optional)', '') || ''; await api.graphCreateSnapshot({ note }); })} className="px-3 py-1.5 rounded-lg bg-primary/15 text-primary text-xs hover:bg-primary/25 disabled:opacity-40">Take snapshot</button>
          <select className={inputCls} value={diffSel.a} onChange={(e) => setDiffSel(s => ({ ...s, a: e.target.value }))}>
            <option value="">from…</option>
            {snapshots.map(s => <option key={s.id} value={s.id}>{s.id} · {fmtTime(s.created_at)}</option>)}
          </select>
          <select className={inputCls} value={diffSel.b} onChange={(e) => setDiffSel(s => ({ ...s, b: e.target.value }))}>
            <option value="">to…</option>
            {snapshots.map(s => <option key={s.id} value={s.id}>{s.id} · {fmtTime(s.created_at)}</option>)}
          </select>
          <button disabled={busy || !diffSel.a || !diffSel.b} onClick={runDiff} className="px-3 py-1.5 rounded-lg bg-primary/15 text-primary text-xs hover:bg-primary/25 disabled:opacity-40">Diff</button>
        </div>
        {snapshots.length === 0 ? <Empty>No snapshots yet.</Empty> : (
          <div className="space-y-1">
            {snapshots.map(s => (
              <div key={s.id} className="flex flex-wrap gap-2 items-center rounded border border-border/50 px-2 py-1 text-[11px]">
                <span className="text-foreground/85 tabular-nums">{s.id}</span>
                <span className="text-muted-foreground/70">{s.node_count} nodes · {s.edge_count} edges</span>
                <span className="text-muted-foreground/50 font-mono">root {String(s.merkle_root || '').slice(0, 16)}…</span>
                {s.note && <span className="text-muted-foreground/70 truncate">“{s.note}”</span>}
                <span className="ml-auto text-muted-foreground/50">{fmtTime(s.created_at)}</span>
              </div>
            ))}
          </div>
        )}
        {diff && (
          <div className="mt-2 rounded border border-border/60 p-2 text-[11px]">
            <div className="flex flex-wrap gap-2 mb-1">
              <Pill tone={diff.identical ? 'ok' : 'warn'}>{diff.identical ? 'identical' : 'changed'}</Pill>
              <span className="text-muted-foreground/70 font-mono">{String(diff.a?.root || '').slice(0, 12)}… → {String(diff.b?.root || '').slice(0, 12)}…</span>
            </div>
            <Json value={diff} />
          </div>
        )}
      </Card>
    </div>
  );
}
