// T0 — search active beliefs. Read-only. Confidence is returned so a resident
// can see how well-supported a claim is before it leans on it.

export async function searchBeliefs({ db, goal, args }) {
  const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5));
  const needle = String(args?.query || "").toLowerCase().slice(0, 200);
  const rows = await db.query(
    `SELECT id, statement, status, confidence, evidence_level, hypothesis
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
      hypothesis: b.hypothesis === true
    }));
  return { ok: true, output: { count: hits.length, beliefs: hits } };
}
