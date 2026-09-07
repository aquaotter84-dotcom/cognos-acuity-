// Small helpers shared by server/db.js and the Phase 14/15 stores.
//
// They live in a leaf module on purpose: the knowledge and meta stores import
// them, and server/db.js imports those stores, so putting the helpers in db.js
// would create an import cycle. db.js re-exports newId() so every existing
// `import { newId } from "./db.js"` keeps working unchanged.

/** The app's id generator — unchanged from server/db.js. */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Postgres NUMERIC and BIGINT arrive as strings through node-pg. */
export function num(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function int(value, fallback = 0) {
  const n = num(value, fallback);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function clamp01(n) {
  const v = num(n, 0);
  return Math.min(1, Math.max(0, v));
}

/** Milliseconds — the ledger's time unit. */
export function nowMs() {
  return Date.now();
}
