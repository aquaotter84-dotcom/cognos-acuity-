// Event bus — in-memory pub/sub for orchestration lifecycle events.
// One bus per orchestration run; subscribers are scoped to that run.

export function createEventBus(logger) {
  const subscribers = new Map();

  function subscribe(eventType, handler) {
    if (!subscribers.has(eventType)) subscribers.set(eventType, new Set());
    subscribers.get(eventType).add(handler);
    return () => subscribers.get(eventType)?.delete(handler);
  }

  async function publish(eventType, payload) {
    const handlers = subscribers.get(eventType);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        await h(payload);
      } catch (e) {
        logger?.warn?.("eventBus handler error", { eventType, error: String(e) });
      }
    }
  }

  return { subscribe, publish };
}