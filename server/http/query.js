// Small HTTP query helpers shared by route modules.

/** Accept either epoch milliseconds or an ISO instant. */
export function parseInstant(value) {
  if (value === undefined || value === null || value === "") return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 1e11) return Math.trunc(asNumber);
  const asDate = Date.parse(String(value));
  return Number.isFinite(asDate) ? asDate : null;
}
