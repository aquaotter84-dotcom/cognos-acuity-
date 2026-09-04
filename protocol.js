// Message protocol — the standard envelope agents and stages use to communicate.
// Phase 1: a minimal, validated message shape. Later phases extend it with richer routing.

let counter = 0;

export function createMessage({ type, from, to = "*", content = null, metadata = {} }) {
  return {
    id: `msg_${Date.now()}_${counter++}`,
    type,
    from,
    to,
    content,
    metadata,
    timestamp: new Date().toISOString()
  };
}

export function validateMessage(msg) {
  if (!msg || typeof msg !== "object") return "Message must be an object";
  if (!msg.type || typeof msg.type !== "string") return "Missing or invalid 'type'";
  if (!msg.from || typeof msg.from !== "string") return "Missing or invalid 'from'";
  if (!msg.id || typeof msg.id !== "string") return "Missing or invalid 'id'";
  return null; // null = valid
}