#!/usr/bin/env node
// Seeds the Archivist — the first real resident.
//
// Idempotent: running it twice updates the existing resident's brief (creating
// a new version) rather than creating a duplicate.
//
// The goal it creates is left awaiting_authorization on purpose. Authorizing is
// the barrier, and it is the operator's decision — not something a seed script
// should make on their behalf. Authorize it on /autonomy, or:
//
//   curl -X POST localhost:3000/api/autonomy/goals/<id>/decision \
//     -H 'Content-Type: application/json' -d '{"decision":"authorize"}'

import { ARCHIVIST } from "../src/lib/archivist.js";

const BASE = process.env.COGNOS_BASE_URL || "http://127.0.0.1:3000";
const HEARTBEAT_MS = Number(process.env.ARCHIVIST_HEARTBEAT_MS || ARCHIVIST.heartbeat_interval_ms);

const call = async (path, options = {}) => {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${options.method || "GET"} ${path} -> ${res.status} ${json?.error || text?.slice(0, 200)}`);
  return json;
};

const main = async () => {
  const existing = await call("/api/autonomy/agents");
  let resident = existing.find(r => r.slug === ARCHIVIST.slug);

  if (resident) {
    if (resident.brief.trim() === ARCHIVIST.brief.trim()) {
      console.log(`archivist: unchanged (brief v${resident.brief_version})`);
    } else {
      const updated = await call(`/api/autonomy/agents/${resident.id}`, {
        method: "PATCH", body: { brief: ARCHIVIST.brief }
      });
      console.log(`archivist: brief v${resident.brief_version} -> v${updated.agent.brief_version} (v${resident.brief_version} kept)`);
      resident = updated.agent;
    }
  } else {
    resident = await call("/api/autonomy/agents", {
      method: "POST",
      body: {
        name: ARCHIVIST.name,
        slug: ARCHIVIST.slug,
        purpose: ARCHIVIST.purpose,
        brief: ARCHIVIST.brief,
        skill_allowlist: ARCHIVIST.skill_allowlist,
        heartbeat_interval_ms: HEARTBEAT_MS,
        enabled: true
      }
    });
    console.log(`archivist: created (brief v${resident.brief_version})`);
  }

  const goals = await call("/api/autonomy/goals");
  const existingGoal = goals.find(g => g.title === ARCHIVIST.goalTitle && g.agent_id === resident.id);
  if (existingGoal) {
    console.log(`goal: already present — ${existingGoal.id} (${existingGoal.status})`);
  } else {
    const made = await call("/api/autonomy/goals", {
      method: "POST",
      body: { title: ARCHIVIST.goalTitle, objective: ARCHIVIST.goalObjective, agent_id: resident.id }
    });
    console.log(`goal: created ${made.goal.id} — ${made.goal.status}`);
    console.log(`     authorize it on /autonomy, or:`);
    console.log(`     curl -X POST ${BASE}/api/autonomy/goals/${made.goal.id}/decision \\`);
    console.log(`       -H 'Content-Type: application/json' -d '{"decision":"authorize"}'`);
  }

  console.log("\nskills: " + (resident.skill_allowlist || []).join(", "));
  console.log(`wake-up: every ${Math.round(HEARTBEAT_MS / 60_000)} minutes`);
};

main().catch(error => {
  console.error(`seed-archivist failed: ${error.message}`);
  console.error(`  is the server running at ${BASE}?`);
  process.exit(1);
});
