// The in-process heartbeat — Phase 19.
//
// Started by server/serve.js ONLY. server/index.js must never start it:
// Vercel imports index.js as a serverless handler, and a timer there would do
// nothing except leak.
//
// The heartbeat is not required for correctness. The tick is resumable and
// lease-guarded, so a deployment that only ever receives an HTTP cron tick
// works identically — more slowly, but identically. The heartbeat's job is to
// make the loop wake up on its own on a host that has a process.
//
// Safety properties:
//   * one tick at a time — a tick that overruns its interval never overlaps;
//   * unref'd, so it can never hold the process open on its own;
//   * stop() is idempotent and awaited by graceful shutdown.

import { runTick } from "./tick.js";
import { autonomyConfig } from "./config.js";
import { createLogger } from "../shared/logging.js";

export function startHeartbeat({ db, logger = createLogger("autonomy.heartbeat"), intervalMs = null } = {}) {
  let timer = null;
  let running = false;
  let stopping = false;
  let ticks = 0;
  let lastResult = null;

  const cfg = autonomyConfig();
  const every = Math.max(5_000, Number(intervalMs || cfg.tick.intervalMs) || 60_000);

  async function beat() {
    if (running || stopping) return;      // never overlap; one slice at a time
    running = true;
    try {
      const config = autonomyConfig();    // re-read, so the kill switch takes effect without a restart
      if (config.enabled !== true) { lastResult = { frozen: true }; return; }
      lastResult = await runTick({ db, config, workerId: `heartbeat:${process.pid}` });
      ticks++;
      if (lastResult.goalsClaimed || lastResult.effectsRefused) {
        logger.info("autonomy tick", {
          goals: lastResult.goalsClaimed,
          steps: lastResult.stepsExecuted,
          refused: lastResult.effectsRefused
        });
      }
    } catch (error) {
      // A tick that throws must not kill the timer. The failure is logged and
      // the next beat tries again; goals park on consecutive step failures.
      logger.warn("autonomy tick failed", { error: String(error?.message || error).slice(0, 300) });
      lastResult = { error: String(error?.message || error).slice(0, 300) };
    } finally {
      running = false;
    }
  }

  timer = setInterval(beat, every);
  if (typeof timer?.unref === "function") timer.unref();

  return {
    intervalMs: every,
    get ticksRun() { return ticks; },
    get lastResult() { return lastResult; },
    get running() { return running; },
    /** Run one slice immediately. Used by ops and by tests. */
    async beatNow() { await beat(); return lastResult; },
    /** Idempotent. Awaited by graceful shutdown before the pool closes. */
    async stop() {
      stopping = true;
      if (timer) { clearInterval(timer); timer = null; }
      // Give an in-flight tick a bounded window to finish and release its lease.
      for (let i = 0; i < 100 && running; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { stopped: !running };
    }
  };
}
