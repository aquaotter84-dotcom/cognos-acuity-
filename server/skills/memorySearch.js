// T0 — search enabled workspace memories. Semantic-first: when the pool
// carries embeddings, the query is embedded once and ranked by cosine
// similarity (meaning, not wording). Falls back to substring matching when
// embeddings are unavailable. Read-only; returns previews, never full rows.

import { cleanText } from "../sources/extract.js";
import { embedTexts, parseEmbedding, rankMemoriesBySimilarity } from "../memory/embeddings.js";
import { recordRecall } from "../memory/recall.js";

export async function searchMemory({ db, goal, args }) {
  const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5));
  const query = cleanText(String(args?.query || "")).slice(0, 200);
  const needle = query.toLowerCase();
  const pool = await db.Memory.filter({ workspace_id: goal.workspace_id, is_enabled: true }, 200);

  const toPreview = (m) => ({
    id: m.id,
    preview: String(m.content || "").slice(0, 200),
    evidence_level: m.evidence_level || null,
    volatility: m.volatility || null
  });

  // Instrumentation only: record that these rows were recalled. Never used
  // for ranking (Sapphire's restraint). Best-effort — never fails the search.
  const note = (rows) => {
    const qf = typeof db?.query === "function" ? db.query : null;
    if (qf && rows?.length) recordRecall(qf, rows.map(m => m.id)).catch(() => {});
  };

  // Semantic ranking when the pool has real embedding coverage.
  if (query) {
    try {
      const embedded = (pool || []).filter(m => parseEmbedding(m?.embedding));
      if (embedded.length >= 3) {
        const vecs = await embedTexts([query]);
        if (vecs && vecs[0] && vecs[0].length > 0) {
          const ranked = rankMemoriesBySimilarity(vecs[0], embedded, limit);
          if (ranked.length > 0) {
            note(ranked);
            return { ok: true, output: { count: ranked.length, memories: ranked.map(toPreview), ranked_by: "semantic" } };
          }
        }
      }
    } catch { /* fall through to substring */ }
  }

  // Substring fallback — the original behavior, unchanged.
  const hits = (pool || [])
    .filter(m => !needle || String(m.content || "").toLowerCase().includes(needle))
    .slice(0, limit)
    .map(toPreview);
  note(hits);
  return { ok: true, output: { count: hits.length, memories: hits, ranked_by: "substring" } };
}
