// Temporary baseline check of the unmodified app (commit ec38f1b) through the harness.
import { bootHarness } from "./harness.mjs";

const h = await bootHarness();
const health = await h.raw("/api/health");
console.log("health", health.status, health.ms + "ms", JSON.stringify(health.json));

const turn = await h.chat("Hello council, what is 2+2?");
console.log("events:", turn.events.map(e => e.event).join(", "));
console.log("tokens:", JSON.stringify(turn.tokens.slice(0, 80)));
console.log("done.response:", JSON.stringify(turn.done?.response));
console.log("council keys:", Object.keys(turn.done?.council || {}));

const msgs = await h.sql("SELECT role, left(content, 40) AS content, processing_status FROM messages ORDER BY created_date");
console.log("messages:", JSON.stringify(msgs));
const mems = await h.sql("SELECT count(*)::int AS n FROM memories");
const audit = await h.sql("SELECT count(*)::int AS n FROM audit_events");
const conv = await h.sql("SELECT summary FROM conversations");
console.log("memories:", JSON.stringify(mems), "audit:", JSON.stringify(audit), "summary:", JSON.stringify(conv));
await h.stop();
process.exit(0);
