// Phase 37c — follow-up queue for chat.
//
// Ported from OpenMuse's conversation-queue.ts (MIT), rebuilt in COGNOS's
// idioms: plain ESM, no types, and queued entries carry the turn `options`
// (sources, agentMode) they were composed with.
//
// The idea: the composer stays live while a reply streams. Messages sent
// mid-stream wait their turn instead of racing the current reply — one send
// at a time, in the order they were typed.
//
// Semantics carried over from the original, verbatim:
//   * flush() sends pending messages one at a time, in order, and picks up
//     messages enqueued mid-flush.
//   * A failed send pauses the queue. The failed message was already shifted
//     out of `pending` before send() ran — and the failed turn already wrote
//     itself into the transcript — so it is NEVER resent implicitly.
//   * pause()/resume() are manual: the UI's stop button pauses, the
//     "Send queued" strip resumes and drains.
//
// subscribe/notify is exposed so React can read the queue with
// useSyncExternalStore (getSnapshot is a stable instance field, and the
// snapshot object is replaced — never mutated — on every update).

export class ConversationQueue {
  constructor() {
    this.state = { pending: [], running: false, paused: false };
    this.listeners = new Set();
  }

  getSnapshot = () => this.state;

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  _update(patch) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Add a message to the tail of the queue. entry = { id, text, options }. */
  enqueue(entry) {
    this._update({ pending: [...this.state.pending, entry] });
  }

  /** Drop a queued message by id. A no-op when the id isn't queued. */
  remove(id) {
    this._update({ pending: this.state.pending.filter((m) => m.id !== id) });
  }

  pause() {
    this._update({ paused: true });
  }

  resume() {
    this._update({ paused: false });
  }

  /** Empty the queue without sending anything. */
  clear() {
    this._update({ pending: [] });
  }

  /**
   * Send queued messages one at a time, in order, while the queue is neither
   * paused nor already flushing. On error the queue pauses itself (the failed
   * message is already in the transcript, so it is never resent) and the
   * error is rethrown for the caller to surface.
   */
  async flush(send) {
    if (this.state.running || this.state.paused) return;
    this._update({ running: true });
    try {
      while (this.state.pending.length && !this.state.paused) {
        const [message, ...pending] = this.state.pending;
        this._update({ pending });
        await send(message);
      }
    } catch (error) {
      // The failed message is already in the transcript. Never resend it implicitly.
      this._update({ paused: true });
      throw error;
    } finally {
      this._update({ running: false });
    }
  }
}
