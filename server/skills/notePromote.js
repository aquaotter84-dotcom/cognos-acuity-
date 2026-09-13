// T1 — REQUEST promotion of a note into durable knowledge.
//
// This deliberately does not write a memory. Promotion is the weakest link in
// the whole design: it is the one path by which an autonomous loop could turn
// its own hunch into a fact about the user. So the skill records a REQUEST
// row (server/autonomy/promote.js), and the note applies only through one of
// two gates: a human confirm, or a Governor-approved answer that cites the
// finding's locator. Either way it lands evidence_level 'inferred' with
// origin tags — never 'direct'.
//
// Rung 3: requesting needs COGNOS_AUTONOMY_RESIDENTS. Anything that writes a
// memory row directly would be laundering, not promotion.

import { requestPromotion as requestPromotionRow } from "../autonomy/promote.js";

export async function requestPromotion({ db, goal, agent, args, tickId, stepId, config }) {
  const noteId = String(args?.noteId || "");
  if (!noteId) return { ok: false, error: "noteId is required" };

  const result = await requestPromotionRow({
    db, goal, agent, noteId,
    target: args?.target || "memory",
    tickId: tickId || null, stepId: stepId || null, config
  });
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    output: {
      requested: result.status === "requested",
      status: result.status,
      promotionId: result.promotionId,
      noteOrdinal: result.noteOrdinal ?? null,
      ...(result.requestNoteId ? { requestNoteId: result.requestNoteId } : {}),
      ...(result.duplicate ? { duplicate: true } : {}),
      promoted: false
    }
  };
}
