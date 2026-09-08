// Cooperative cancellation for a council turn.
//
// The browser owns an AbortController for the one chat request. The HTTP layer
// turns a disconnected SSE response into an AbortSignal, the orchestrator checks
// it between every stage, and callLLM links it to each upstream model request.
// A cancellation is not a model failure and must not create a fabricated error
// answer; it is recorded as a cancelled run and then allowed to stop quietly.

import { CognosError } from "./errors.js";

export class ClientAbortError extends CognosError {
  constructor(message = "Council turn cancelled by the client", { cause } = {}) {
    super(message, { code: "CLIENT_ABORT", category: "cancellation", status: 499, cause });
    this.name = "ClientAbortError";
  }
}

export function clientAbortError(reason = null) {
  if (reason instanceof ClientAbortError) return reason;
  return new ClientAbortError(undefined, { cause: reason instanceof Error ? reason : undefined });
}

export function isClientAbort(error, signal = null) {
  return error instanceof ClientAbortError ||
    error?.code === "CLIENT_ABORT" ||
    error?.name === "ClientAbortError" ||
    Boolean(signal?.aborted);
}

export function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw clientAbortError(signal.reason);
}
