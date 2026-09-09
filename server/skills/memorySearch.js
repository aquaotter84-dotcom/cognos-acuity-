// T0 — search enabled workspace memories. Substring match; no embeddings, no
// new infrastructure. Read-only and returns previews, never full rows.

import { cleanText } from "../sources/extract.js";

export async function searchMemory({ db, goal, args }) {
  const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5));
  const needle = cleanText(String(args?.query || "")).toLowerCase().slice(0, 200);
  const pool = await db.Memory.filter({ workspace_id: goal.workspace_id, is_enabled: true }, 200);
  const hits = (pool || [])
    .filter(m => !needle || String(m.content || "").toLowerCase().includes(needle))
    .slice(0, limit)
    .map(m => ({
      id: m.id,
      preview: String(m.content || "").slice(0, 200),
      evidence_level: m.evidence_level || null,
      volatility: m.volatility || null
    }));
  return { ok: true, output: { count: hits.length, memories: hits } };
}
