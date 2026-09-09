// Process/request timing that does not participate in any reasoning decision.
// A first request is a cold-instance candidate (the platform may still have done
// work before this module loaded); later requests are unambiguously warm.

import { performance } from "node:perf_hooks";

const instanceBootedAtMs = Math.floor(performance.timeOrigin);
const moduleLoadedAtMs = Date.now();
let requestOrdinal = 0;

export function beginRequestTiming() {
  requestOrdinal += 1;
  const receivedAtMs = Date.now();
  const processAgeMs = Math.max(0, receivedAtMs - instanceBootedAtMs);
  const moduleAgeMs = Math.max(0, receivedAtMs - moduleLoadedAtMs);
  return {
    instanceBootedAtMs,
    moduleLoadedAtMs,
    receivedAtMs,
    processAgeMs,
    moduleAgeMs,
    requestOrdinal,
    // A first chat on an old process is not called cold. This deliberately
    // favors false negatives over blaming a warm request on cold-start cost.
    coldInstanceCandidate: requestOrdinal === 1 && moduleAgeMs < 30_000
  };
}

export async function timed(operation) {
  const started = performance.now();
  const value = await operation();
  return { value, ms: Math.max(0, Math.round(performance.now() - started)) };
}

export function elapsedMs(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

export function monotonicNow() {
  return performance.now();
}
