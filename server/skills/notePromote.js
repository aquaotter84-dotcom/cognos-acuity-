// T1 — REQUEST promotion of a note into durable memory.
//
// This deliberately does not write a memory. Promotion is the weakest link in
// the whole design: it is the one path by which an autonomous loop could turn
// its own hunch into a fact about the user. So the skill records the request,
// and the actual promotion happens only through the explicit-ask path (Phase
// 20), where a Governor-approved answer carries the finding — and even then it
// lands as evidence_level 'inferred', never 'direct'.
//
// Anything that writes a memory row directly would be laundering, not promotion.

export async function requestPromotion({ db, goal, agent, args, tickId }) {
  const noteId = String(args.noteId || "");
  if (!noteId) return { ok: false, error: "noteId is required" };

  const notes = await db.GoalNote.list(goal.id, 500);
  const note = (notes || []).find(n => n.id === noteId);
  if (!note) return { ok: false, error: "note not found on this goal" };

  const request = await db.GoalNote.append({
    goal_id: goal.id,
    agent_id: agent?.id || null,
    tick_id: tickId || null,
    kind: "decision",
    body: `Promotion requested for note ${note.ordinal} (${note.kind}). It awaits the explicit-ask path; it is not yet memory.`,
    refs: [{ note_id: note.id }]
  });
  return {
    ok: true,
    output: { requested: true, noteOrdinal: note.ordinal, requestNoteId: request.id, promoted: false }
  };
}
