// Core runtime — defines the agent/handler contract and a runner that executes a
// handler against a protocol message. Phase 1: a plain function-based contract.

import { validateMessage } from "./protocol.js";

export function defineAgent({ name, type = "handler", handle }) {
  if (!name || typeof name !== "string") throw new Error("Agent requires a name");
  if (typeof handle !== "function") throw new Error(`Agent "${name}" requires a handle() function`);
  return { name, type, handle };
}

export async function runAgent(agent, message, ctx) {
  const err = validateMessage(message);
  if (err) throw new Error(`Invalid message for ${agent.name}: ${err}`);
  return agent.handle(message, ctx);
}