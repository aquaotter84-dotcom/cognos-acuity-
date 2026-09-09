// Local / self-hosted entrypoint. Vercel does NOT use this file — it imports
// server/index.js through api/index.js as a serverless handler instead.
//
// This is also the only place the autonomy heartbeat starts, and the only place
// graceful shutdown is installed. Both matter on a container host (Railway):
// a redeploy sends SIGTERM, and without a handler every deploy is a crash —
// an in-flight tick would be killed holding a lease, and the pool would be
// abandoned instead of closed.
//
// Shutdown order is deliberate:
//   1. stop the heartbeat (no new ticks start)
//   2. let the in-flight tick finish or park, and release its lease
//   3. close the HTTP server (no new requests)
//   4. close the database pool
// A second SIGTERM after the grace window force-exits.

import app from "./index.js";
import db, { isConfigured, closeDatabase } from "./db.js";
import { getSystemConfig } from "./config.js";
import { autonomyConfig } from "./autonomy/config.js";
import { startHeartbeat } from "./autonomy/heartbeat.js";
import { createLogger } from "./shared/logging.js";

const logger = createLogger("server");
const port = Number(process.env.PORT || 3000);

const server = app.listen(port, "0.0.0.0", () => {
  const config = getSystemConfig();
  logger.info("cognos listening", {
    port,
    model: config.models.primary,
    databaseConfigured: isConfigured(),
    gate: Boolean(process.env.COGNOS_RUNTIME_SECRET)
  });
});

// --- The heartbeat ----------------------------------------------------------
// Only started when autonomy is enabled. The tick is resumable, so a host that
// never runs this still works through POST /api/autonomy/tick — more slowly,
// but identically.
let heartbeat = null;
const autonomy = autonomyConfig();
if (autonomy.enabled === true) {
  heartbeat = startHeartbeat({ db, logger: logger.child("heartbeat") });
  logger.info("autonomy heartbeat started", {
    intervalMs: heartbeat.intervalMs,
    outboxMode: autonomy.outboxMode,
    builtTiers: autonomy.builtTiers
  });
} else {
  logger.info("autonomy disabled", {
    requested: autonomy.requestedEnabled,
    note: "phase19.autonomy_default_off — set COGNOS_AUTONOMY_ENABLED=true to enable a rung"
  });
}

// --- Graceful shutdown ------------------------------------------------------
const GRACE_MS = Math.max(1_000, Math.min(60_000,
  Number(process.env.COGNOS_SHUTDOWN_GRACE_MS || 25_000)));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    logger.warn("second termination signal — forcing exit", { signal });
    process.exit(1);
  }
  shuttingDown = true;
  logger.info("shutdown started", { signal, graceMs: GRACE_MS });

  const forced = setTimeout(() => {
    logger.warn("grace window exceeded — forcing exit");
    process.exit(1);
  }, GRACE_MS);
  if (typeof forced.unref === "function") forced.unref();

  try {
    if (heartbeat) {
      const stopped = await heartbeat.stop();
      logger.info("heartbeat stopped", { ...stopped, ticksRun: heartbeat.ticksRun });
    }
  } catch (error) {
    logger.warn("heartbeat stop failed", { error: String(error?.message || error) });
  }

  await new Promise(resolve => server.close(resolve));

  try {
    await closeDatabase();
  } catch (error) {
    logger.warn("database close failed", { error: String(error?.message || error) });
  }

  clearTimeout(forced);
  logger.info("shutdown complete", { signal });
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { shutdown(signal).catch(() => process.exit(1)); });
}
