// Council operator — Governor (sovereignty). A rule-based policy gate that inspects
// the final response for safety issues (e.g. leaked secrets, empty output). Best-effort
// and synchronous (no model call). Flags issues without blocking in Phase 2.

import { defineAgent } from "../shared/runtime.js";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9]{20,}/i
];

export const governorAgent = defineAgent({
  name: "governor",
  type: "post",
  async handle(message, ctx) {
    if (!ctx.config.council.governorEnabled) {
      return { approved: true, flags: [] };
    }
    const { responseText } = message.content;
    const flags = [];
    const text = responseText || "";
    if (!text.trim()) flags.push("empty_response");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        flags.push("potential_secret_leak");
        break;
      }
    }
    return { approved: flags.length === 0, flags };
  }
});