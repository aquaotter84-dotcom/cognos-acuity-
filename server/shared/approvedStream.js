// The only release point for answer text.
//
// Model output is deliberately buffered inside the council until the Governor
// has ruled on the complete final draft. Only the approved draft (or a fixed,
// deterministic refusal selected after a veto) may cross the SSE boundary.
// Chunks are yielded without an artificial typing delay; yielding merely gives
// a disconnect a chance to propagate between writes.

import { throwIfAborted } from "./cancellation.js";

export async function releaseApprovedText(text, { onToken = null, signal = null, chunkSize = 96 } = {}) {
  if (typeof onToken !== "function" || !text) return 0;
  const value = String(text);
  const codePoints = Array.from(value); // never split an emoji/surrogate pair
  let chunks = 0;
  for (let offset = 0; offset < codePoints.length; offset += chunkSize) {
    throwIfAborted(signal);
    onToken(codePoints.slice(offset, offset + chunkSize).join(""));
    chunks++;
    // No fake typewriter delay. This yield allows socket closure/cancellation and
    // backpressure-related events to be observed before the next frame.
    await new Promise(resolve => setImmediate(resolve));
  }
  return chunks;
}
