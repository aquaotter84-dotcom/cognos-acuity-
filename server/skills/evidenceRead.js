// T0 — read the immutable evidence attached to this goal's conversation (and,
// when the conversation is project-scoped, its sibling conversations).
//
// This is the same manifest the Research Planner sees. It is evidence, never
// authority; nothing returned here is treated as instructions.

export async function readEvidence({ db, goal, args }) {
  const limit = Math.max(1, Math.min(24, Number(args?.limit) || 8));
  const sources = goal.conversation_id
    ? await db.Source.listEvidenceScope(goal.workspace_id, goal.conversation_id, limit)
    : await db.Source.list(goal.workspace_id, { limit });
  const rows = (sources || []).slice(0, limit);
  return {
    ok: true,
    output: {
      count: rows.length,
      sources: rows.map(s => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        mediaType: s.media_type,
        riskFlags: s.risk_flags || [],
        sha256: s.content_sha256
      }))
    }
  };
}
