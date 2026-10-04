// Durable workflow store (Phase 37) — OpenMuse's engineering discipline,
// reimplemented in COGNOS idioms.
//
// One kind-keyed table for ALL workflow state (durable tasks, watches,
// ideas-in-flight). Transitions are atomic via compare-and-swap; leases, not
// locks. Memory keeps its own tables — this is for *work*, not memories.
//
// CAS shapes ported from OpenMuse's Store (MIT): compareAndSwap,
// insertIfAbsent. The lease protocol (claim → heartbeat → LostLease→requeue)
// is reimplemented for COGNOS's CommonJS + db layer.

/** The three CAS shapes. `run` is the query runner (db.run or equivalent). */
export function createWorkflowStore(run) {
  const json = (v) => JSON.stringify(v ?? null);

  return {
    async get(owner, kind, id) {
      const rows = await run(
        `SELECT data FROM workflow_records WHERE owner=$1 AND kind=$2 AND id=$3`,
        [owner, kind, id]
      );
      const raw = rows[0]?.data;
      return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    },

    async list(owner, kind, { limit = 100 } = {}) {
      const rows = await run(
        `SELECT data FROM workflow_records WHERE owner=$1 AND kind=$2
         ORDER BY updated_at DESC LIMIT $3`,
        [owner, kind, Math.max(1, Math.min(1000, limit))]
      );
      return (rows || []).map(r => typeof r.data === "string" ? JSON.parse(r.data) : r.data);
    },

    async put(owner, kind, value) {
      if (!value?.id) throw new Error("workflow record needs an id");
      await run(
        `INSERT INTO workflow_records(owner,kind,id,data)
         VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT(owner,kind,id)
         DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
        [owner, kind, value.id, json(value)]
      );
      return value;
    },

    /**
     * Atomic compare-and-swap: applies `patch` only if current data contains
     * every key in `expected`. Returns the new record, or null if the CAS lost.
     */
    async compareAndSwap(owner, kind, id, expected, patch) {
      const rows = await run(
        `UPDATE workflow_records
            SET data = data || $5::jsonb, updated_at = now()
          WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb
          RETURNING data`,
        [owner, kind, id, json(expected), json(patch)]
      );
      const raw = rows[0]?.data;
      return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    },

    /**
     * Insert only if absent. Returns the record on insert, null if it already
     * existed. Content-hash IDs + this = no duplicates, ever.
     */
    async insertIfAbsent(owner, kind, value) {
      if (!value?.id) throw new Error("workflow record needs an id");
      const rows = await run(
        `INSERT INTO workflow_records(owner,kind,id,data)
         VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT(owner,kind,id) DO NOTHING
         RETURNING data`,
        [owner, kind, value.id, json(value)]
      );
      const raw = rows[0]?.data;
      return raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    },

    async remove(owner, kind, id) {
      const rows = await run(
        `DELETE FROM workflow_records WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING id`,
        [owner, kind, id]
      );
      return (rows || []).length > 0;
    },

    /** All records of a kind across owners (for maintenance loops). */
    async scan(kind, { limit = 500 } = {}) {
      const rows = await run(
        `SELECT owner, data FROM workflow_records WHERE kind=$1
         ORDER BY updated_at ASC LIMIT $2`,
        [kind, Math.max(1, Math.min(5000, limit))]
      );
      return (rows || []).map(r => ({
        owner: r.owner,
        value: typeof r.data === "string" ? JSON.parse(r.data) : r.data
      }));
    }
  };
}
