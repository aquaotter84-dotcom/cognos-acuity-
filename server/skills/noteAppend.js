// T0 — append a typed working note to the goal's scratchpad.
//
// Notes are append-only and untrusted by default: a note is what the agent
// SAID, not what is true. Nothing here can be edited later; a correction is a
// new note with supersedes_note_id (see goal_notes in the Phase 19 schema).

import { cleanText } from "../sources/extract.js";

export async function appendNote({ db, goal, agent, args, tickId, subAgentId = null }) {
  // Provenance is code-owned: a model-supplied sub_agent_id ref is stripped,
  // and the real worker id (which only the sub-agent runner passes) is added.
  const refs = (Array.isArray(args.refs) ? args.refs.slice(0, 20) : [])
    .filter(r => !r || typeof r !== "object" || !("sub_agent_id" in r));
  if (subAgentId) refs.push({ sub_agent_id: subAgentId });
  const note = await db.GoalNote.append({
    goal_id: goal.id,
    agent_id: agent?.id || null,
    tick_id: tickId || null,
    kind: args.kind,
    body: cleanText(String(args.body || "")).slice(0, 2000),
    refs
  });
  return { ok: true, output: { noteId: note.id, ordinal: note.ordinal, kind: note.kind } };
}
