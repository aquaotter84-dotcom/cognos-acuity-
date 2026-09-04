// Agent registry — registers named agents/handlers for the orchestrator to dispatch to.
// Phase 1 holds stage handlers; later phases register cognitive agents here.

export function createRegistry() {
  const agents = new Map();

  function register(name, agent) {
    if (agents.has(name)) throw new Error(`Agent already registered: ${name}`);
    agents.set(name, agent);
    return agent;
  }

  function get(name) {
    if (!agents.has(name)) throw new Error(`Agent not found: ${name}`);
    return agents.get(name);
  }

  function has(name) {
    return agents.has(name);
  }

  function list() {
    return Array.from(agents.keys());
  }

  return { register, get, has, list };
}