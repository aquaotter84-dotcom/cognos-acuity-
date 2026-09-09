// T0 — search active beliefs. Read-only. Confidence is returned so a resident
// can see how well-supported a claim is before it leans on it.

export async function searchBeliefs({ db, goal, args }) {
  const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5));
  const needle = String(args?.query || "").toLowerCase().slice(0, 200);
  // The drift-relevant columns come back too: support/contradict counts and the
  // confirmation timestamps. Without them a resident can see what COGNOS
  // believes right now but not whether anything moved since it last looked,
  // which is the entire job of a monitor.
  const rows = await db.query(
    `SELECT id, statement, status, confidence, evidence_level, hypothesis,
            support_count, contradict_count, first_seen_ms, last_confirmed_ms
       FROM beliefs
      WHERE workspace_id = $1 AND status = 'active'
      ORDER BY confidence DESC LIMIT $2`,
    [goal.workspace_id, Math.max(limit * 4, 20)]
  );
  const hits = (rows || [])
    .filter(b => !needle || String(b.statement || "").toLowerCase().includes(needle))
    .slice(0, limit)
    .map(b => ({
      id: b.id,
      statement: String(b.statement || "").slice(0, 200),
      status: b.status,
      confidence: Number(b.confidence),
      evidence_level: b.evidence_level || null,
      hypothesis: b.hypothesis === true,
      supportCount: Number(b.support_count || 0),
      contradictCount: Number(b.contradict_count || 0),
      firstSeenMs: b.first_seen_ms === null || b.first_seen_ms === undefined ? null : Number(b.first_seen_ms),
      lastConfirmedMs: b.last_confirmed_ms === null || b.last_confirmed_ms === undefined ? null : Number(b.last_confirmed_ms)
    }));
  return { ok: true, output: { count: hits.length, beliefs: hits } };
}
