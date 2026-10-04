// Lease-based durable task runner (Phase 37) — OpenMuse's lease protocol,
// reimplemented in COGNOS idioms.
//
// Leases, not locks. A worker claims a task by CAS-ing queued→running with a
// fresh leaseId + leaseUntil. A heartbeat renews the lease. If the heartbeat
// CAS fails (someone else took it) or the guard fails, the run aborts with
// LostLeaseError → the task goes back to `queued`, never `failed`.
// Interrupted work is resumable by design.
//
// Task statuses: queued, running, waiting_approval, scheduled, paused,
//                succeeded, failed, cancelled
// A task record: { id, kind, title, status, leaseId, leaseUntil, attempts,
//                  input, result, error, createdMs, updatedMs }

import { randomUUID } from "node:crypto";

export class LostLeaseError extends Error {
  constructor(reason = "Task was paused, cancelled or taken over by another worker") {
    super(reason);
    this.name = "LostLeaseError";
  }
}

const nowIso = (ms) => new Date(ms).toISOString();

export function createTaskRunner(store, execute, { now = () => Date.now(), leaseMs = 60000, onSettled = null } = {}) {
  const active = new Map(); // taskId -> { abort, leaseId }

  async function claim(owner, taskId) {
    const task = await store.get(owner, "durable_tasks", taskId);
    if (!task) return null;
    const t = now();
    // Claim queued tasks, or running tasks whose lease expired (dead worker).
    const claimable =
      task.status === "queued" ||
      (task.status === "running" && task.leaseUntil && Date.parse(task.leaseUntil) <= t);
    if (!claimable) return null;
    const leaseId = randomUUID();
    const expected = { status: task.status, leaseId: task.leaseId ?? null };
    if (task.status === "running") expected.leaseUntil = task.leaseUntil;
    return store.compareAndSwap(owner, "durable_tasks", taskId, expected, {
      status: "running",
      leaseId,
      leaseUntil: nowIso(t + leaseMs),
      attempts: (task.attempts || 0) + 1,
      updatedMs: t
    });
  }

  async function run(owner, taskId) {
    const claimed = await claim(owner, taskId);
    if (!claimed) return null; // someone else got it
    const task = claimed;
    const leaseId = task.leaseId;
    const controller = new AbortController();
    active.set(task.id, { abort: () => controller.abort(), leaseId });

    const guard = async () => {
      const latest = await store.get(owner, "durable_tasks", task.id);
      if (controller.signal.aborted || latest?.leaseId !== leaseId || latest?.status !== "running") {
        throw new LostLeaseError();
      }
    };

    const checkpoint = async (patch) => {
      if (controller.signal.aborted) throw new LostLeaseError();
      const next = await store.compareAndSwap(
        owner, "durable_tasks", task.id,
        { leaseId, status: "running" },
        { ...patch, updatedMs: now() }
      );
      if (!next) throw new LostLeaseError();
      return next;
    };

    const heartbeat = setInterval(() => {
      store.compareAndSwap(
        owner, "durable_tasks", task.id,
        { leaseId, status: "running" },
        { leaseUntil: nowIso(now() + leaseMs) }
      ).then((v) => { if (!v) controller.abort(); })
       .catch(() => controller.abort());
    }, Math.max(1000, Math.floor(leaseMs / 3)));

    try {
      const result = await execute(owner, task, { signal: controller.signal, guard, checkpoint });
      // Success: release the lease, record the result.
      await store.compareAndSwap(
        owner, "durable_tasks", task.id,
        { leaseId, status: "running" },
        { status: result?.status || "succeeded", result: result || null, leaseId: null, leaseUntil: null, updatedMs: now() }
      );
      const settled = await store.get(owner, "durable_tasks", task.id);
      if (onSettled && settled) await onSettled(owner, settled);
      return settled;
    } catch (error) {
      if (error instanceof LostLeaseError || controller.signal.aborted) {
        // Lost the lease → back to queued, NEVER failed. Someone else (or a
        // later tick) will pick it up. Interrupted work is resumable.
        await store.compareAndSwap(
          owner, "durable_tasks", task.id,
          { leaseId, status: "running" },
          { status: "queued", leaseId: null, leaseUntil: null, updatedMs: now() }
        );
      } else {
        const detail = error instanceof Error ? error.message : "Task execution failed";
        await store.compareAndSwap(
          owner, "durable_tasks", task.id,
          { leaseId, status: "running" },
          { status: "failed", error: String(detail).slice(0, 500), leaseId: null, leaseUntil: null, updatedMs: now() }
        );
      }
      const settled = await store.get(owner, "durable_tasks", task.id);
      if (onSettled && settled) await onSettled(owner, settled).catch(() => {});
      return settled;
    } finally {
      clearInterval(heartbeat);
      active.delete(task.id);
    }
  }

  /**
   * The 60s maintenance loop: requeue expired leases (dead workers),
   * surface tasks waiting on approval past their window. Never throws.
   */
  async function maintain() {
    try {
      const t = now();
      const records = await store.scan("durable_tasks", { limit: 1000 });
      for (const { owner, value: task } of records) {
        if (task.status === "running" && task.leaseUntil && Date.parse(task.leaseUntil) <= t) {
          // Dead worker: CAS back to queued. If another worker already
          // claimed it (leaseId changed), the CAS loses harmlessly.
          await store.compareAndSwap(
            owner, "durable_tasks", task.id,
            { status: "running", leaseId: task.leaseId ?? null, leaseUntil: task.leaseUntil },
            { status: "queued", leaseId: null, leaseUntil: null, updatedMs: t }
          );
        }
      }
    } catch {
      // Maintenance never breaks the loop.
    }
  }

  return {
    run,
    claim,
    maintain,
    abort(taskId) { active.get(taskId)?.abort(); },
    get activeCount() { return active.size; }
  };
}

/** Create a new durable task record (queued). Idempotent by id. */
export async function createDurableTask(store, owner, { id, kind = "generic", title, input = {}, runAfterMs = null }) {
  const t = Date.now();
  const task = {
    id: id || randomUUID(),
    kind,
    title: String(title || "task").slice(0, 200),
    status: runAfterMs && runAfterMs > t ? "scheduled" : "queued",
    nextRunMs: runAfterMs || null,
    leaseId: null,
    leaseUntil: null,
    attempts: 0,
    input,
    result: null,
    error: null,
    createdMs: t,
    updatedMs: t
  };
  // insertIfAbsent: same id never creates a duplicate.
  const inserted = await store.insertIfAbsent(owner, "durable_tasks", task);
  return inserted || task;
}
