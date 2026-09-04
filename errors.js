// Error handling — structured error type plus a handler wrapper that converts errors to proper responses.

export class CognosError extends Error {
  constructor(message, { code = "COGNOS_ERROR", category = "system", status = 500, cause } = {}) {
    super(message);
    this.name = "CognosError";
    this.code = code;
    this.category = category;
    this.status = status;
    if (cause) this.cause = cause;
  }
  toJSON() {
    return { error: this.message, code: this.code, category: this.category, status: this.status };
  }
}

export function wrapHandler(handler, logger) {
  return async function (req) {
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof CognosError) {
        logger?.error?.(e.message, { code: e.code, category: e.category, status: e.status });
        return Response.json(e.toJSON(), { status: e.status });
      }
      logger?.error?.("Unhandled error", { error: String(e) });
      return Response.json({ error: e?.message || "Internal error" }, { status: 500 });
    }
  };
}