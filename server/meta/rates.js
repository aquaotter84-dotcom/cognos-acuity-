// Phase 15.1 — the cost rate table. EDITABLE CONSTANTS, deliberately not a
// database table and not an environment variable: pricing is a property of the
// deployment, it changes rarely, and when it changes a reviewer should see the
// diff. Every number here is an estimate in USD per 1M tokens.
//
// If your provider's price is not listed, estimateCost() falls back to
// FALLBACK_RATE and marks the result rateKnown:false — telemetry says it does
// not know rather than inventing a precise-looking number.
//
// Verify against your provider's current pricing before trusting the totals.

export const RATE_TABLE = Object.freeze({
  // OpenAI list prices (per 1M tokens).
  "gpt-4o-mini": Object.freeze({ prompt: 0.15, completion: 0.60 }),
  "gpt-4o": Object.freeze({ prompt: 2.5, completion: 10.0 }),
  "gpt-4o-2024-08-06": Object.freeze({ prompt: 0.15, completion: 0.60 }),
  "gpt-4.1-mini": Object.freeze({ prompt: 0.4, completion: 1.6 }),
  "gpt-4.1": Object.freeze({ prompt: 2.0, completion: 8.0 }),
  "o1-mini": Object.freeze({ prompt: 3.0, completion: 12.0 }),

  // BluesMinds / gateway-routed open weights. The working model today is
  // COGNOS_MODEL=openai/gpt-oss-20b, so both spellings are listed.
  "gpt-oss-20b": Object.freeze({ prompt: 0.05, completion: 0.2 }),
  "openai/gpt-oss-20b": Object.freeze({ prompt: 0.05, completion: 0.2 }),
  "gpt-oss-120b": Object.freeze({ prompt: 0.15, completion: 0.6 }),
  "openai/gpt-oss-120b": Object.freeze({ prompt: 0.15, completion: 0.6 }),

  // Anthropic, in case the gateway is pointed there.
  "claude-3-5-haiku-latest": Object.freeze({ prompt: 0.8, completion: 4.0 }),
  "claude-sonnet-4": Object.freeze({ prompt: 3.0, completion: 15.0 })
});

export const FALLBACK_RATE = Object.freeze({ prompt: 1.0, completion: 3.0 });

/** Characters-per-token used when a provider does not report usage. This is an
 *  approximation and every number it produces is flagged tokensMeasured:false. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokensFromChars(chars) {
  return Math.max(0, Math.ceil(Number(chars || 0) / CHARS_PER_TOKEN));
}

export function rateFor(model) {
  if (!model) return { rate: FALLBACK_RATE, known: false, model: null };
  const exact = RATE_TABLE[model];
  if (exact) return { rate: exact, known: true, model };
  // Gateway-prefixed ids ("openai/gpt-oss-20b") and dated suffixes
  // ("gpt-4o-2024-08-06") are matched by stripping the prefix / suffix.
  const stripped = String(model).replace(/^[^/]+\//, "");
  if (RATE_TABLE[stripped]) return { rate: RATE_TABLE[stripped], known: true, model: stripped };
  const base = stripped.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (RATE_TABLE[base]) return { rate: RATE_TABLE[base], known: true, model: base };
  const family = Object.keys(RATE_TABLE).find(k => stripped.startsWith(k));
  if (family) return { rate: RATE_TABLE[family], known: true, model: family };
  return { rate: FALLBACK_RATE, known: false, model: null };
}

/** USD, from token counts. Returns the rate it used so the record can say
 *  whether the number is grounded or a fallback. */
export function estimateCost({ model = null, promptTokens = 0, completionTokens = 0 } = {}) {
  const { rate, known } = rateFor(model);
  const usd = (Number(promptTokens || 0) / 1_000_000) * rate.prompt
    + (Number(completionTokens || 0) / 1_000_000) * rate.completion;
  return { usd: Number(usd.toFixed(6)), rateKnown: known, rate: { ...rate }, matchedModel: rateFor(model).model };
}

export function describeRateTable() {
  return {
    currency: "USD",
    unit: "per 1M tokens",
    fallback: { ...FALLBACK_RATE },
    charsPerToken: CHARS_PER_TOKEN,
    models: Object.entries(RATE_TABLE).map(([model, r]) => ({ model, ...r }))
  };
}
