// Phase 30 — semantic memory embeddings. Memories are found by MEANING, not
// keywords: each memory's content is embedded once via the already-configured
// AI provider's OpenAI-compatible /embeddings endpoint, and recall ranks by
// cosine similarity in JS (no pgvector, no new extensions — personal scale).
//
// The idea is borrowed from Sapphire (ddxfish/sapphire); the code is written
// from scratch. Sapphire is AGPL-3.0 — none of its code is copied here.
//
// Degradation contract: embeddings are best-effort. A missing key, a provider
// outage, or a memory with no embedding yet NEVER breaks chat — every
// consumer falls back to the pre-existing keyword/importance behavior.

import { providerApiConfig } from "../llm.js";

// Explicit override wins; then the provider default; then a generic fallback.
export function resolveEmbeddingModel(baseUrl) {
  const override = String(process.env.COGNOS_EMBEDDING_MODEL || "").trim();
  if (override) return override;
  if (/generativelanguage\.googleapis\.com/i.test(String(baseUrl || ""))) return "text-embedding-004";
  return "text-embedding-3-small";
}

// The text that represents a memory to the embedding model. The stable key
// carries signal for structured memories, so it rides along.
export function embeddingTextFor(memory) {
  const content = String(memory?.content || "").trim();
  const key = String(memory?.memory_key || "").trim();
  const text = key ? `${key}: ${content}` : content;
  return text.slice(0, 2000);
}

// Embed one batch of texts. Returns an array of vectors, or null when
// embeddings are unavailable for any reason (no key, network, provider
// error). Never throws — callers treat null as "fall back".
export async function embedTexts(texts, { logger = null, timeoutMs = 30000 } = {}) {
  const inputs = (Array.isArray(texts) ? texts : []).map(t => String(t || "").trim()).filter(Boolean);
  if (!inputs.length) return [];
  let apiKey, baseUrl;
  try {
    ({ apiKey, baseUrl } = providerApiConfig());
  } catch (e) {
    logger?.warn?.("embeddings unavailable: no provider key configured");
    return null;
  }
  const model = resolveEmbeddingModel(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: inputs, model }),
      signal: controller.signal
    });
    if (!res.ok) {
      logger?.warn?.("embeddings request failed", { status: res.status, model });
      return null;
    }
    const body = await res.json().catch(() => null);
    const data = body?.data;
    if (!Array.isArray(data) || data.length !== inputs.length) {
      logger?.warn?.("embeddings response malformed", { model });
      return null;
    }
    const vectors = data.map(d => (Array.isArray(d?.embedding) ? d.embedding : null));
    if (vectors.some(v => !v)) {
      logger?.warn?.("embeddings response missing vectors", { model });
      return null;
    }
    return vectors;
  } catch (e) {
    logger?.warn?.("embeddings request errored", { error: String(e?.message || e), model });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Cosine similarity in [-1, 1]. A zero vector has no direction — it scores 0,
// never NaN.
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]), y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Parse a stored embedding back into a vector. Anything unexpected → null.
export function parseEmbedding(value) {
  if (Array.isArray(value)) return value.every(n => Number.isFinite(Number(n))) ? value.map(Number) : null;
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const nums = parsed.map(Number);
    return nums.every(Number.isFinite) ? nums : null;
  } catch {
    return null;
  }
}

// Rank memories by similarity to the query vector. Memories without a usable
// embedding are skipped. Returns the top `limit` memories, most similar first.
export function rankMemoriesBySimilarity(queryEmbedding, memories, limit = 12) {
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) return [];
  const scored = [];
  for (const m of memories || []) {
    const vec = parseEmbedding(m?.embedding);
    if (!vec || vec.length !== queryEmbedding.length) continue;
    scored.push({ memory: m, score: cosineSimilarity(queryEmbedding, vec) });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, Math.max(1, limit)).map(s => s.memory);
}

const EMBED_BATCH = 25;

// Bring a set of memory rows up to date: embed any row whose embedding is
// missing or was produced by a different model, and UPDATE the rows.
// With `force: true`, every row is re-embedded (used when content changed).
// Best-effort and bounded — returns the number of rows updated, never throws.
export async function refreshMemoryEmbeddings(queryFn, memories, { logger = null, force = false } = {}) {
  const rows = (memories || []).filter(m => m && m.id && String(m.content || "").trim().length > 0);
  if (!rows.length || typeof queryFn !== "function") return 0;
  let baseUrl;
  try {
    ({ baseUrl } = providerApiConfig());
  } catch {
    return 0;
  }
  const model = resolveEmbeddingModel(baseUrl);
  const stale = force ? rows : rows.filter(m => {
    const vec = parseEmbedding(m.embedding);
    return !vec || m.embedding_model !== model;
  });
  if (!stale.length) return 0;
  let updated = 0;
  for (let i = 0; i < stale.length; i += EMBED_BATCH) {
    const batch = stale.slice(i, i + EMBED_BATCH);
    const vectors = await embedTexts(batch.map(embeddingTextFor), { logger });
    if (!vectors) return updated; // provider down — stop quietly, try again later
    for (let j = 0; j < batch.length; j++) {
      try {
        await queryFn(
          `UPDATE memories SET embedding = $1, embedding_model = $2 WHERE id = $3`,
          [JSON.stringify(vectors[j]), model, batch[j].id]
        );
        batch[j].embedding = JSON.stringify(vectors[j]);
        batch[j].embedding_model = model;
        updated++;
      } catch (e) {
        logger?.warn?.("embedding row update failed", { id: batch[j].id, error: String(e?.message || e) });
      }
    }
  }
  if (updated > 0) logger?.info?.("memory embeddings refreshed", { updated, model });
  return updated;
}

// Fire-and-forget wrapper for write paths and recall paths: schedules a
// refresh without ever blocking or failing the caller.
export function scheduleEmbeddingRefresh(queryFn, memories, opts = {}) {
  if (!memories?.length || typeof queryFn !== "function") return;
  refreshMemoryEmbeddings(queryFn, memories, opts).catch(() => {});
}
