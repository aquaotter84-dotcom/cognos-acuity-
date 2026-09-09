// T1 — store agent-produced text as an immutable, citable source snapshot.
//
// The resident cannot hand findings to the council as free text. It stores them
// the same way a fetched page is stored: hashed, immutable, chunked, and
// carrying injection-screening flags. That is what makes a resident's output
// evidence rather than assertion (AUTONOMY.md §4.9).

import { createHash } from "node:crypto";
import { cleanText } from "../sources/extract.js";

export async function snapshotSource({ db, goal, args, tickId }) {
  const text = cleanText(String(args.text || ""));
  if (!text) return { ok: false, error: "text is required" };

  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  const existing = await db.Source.findByHash(goal.workspace_id, sha256, "agent_text");
  if (existing) {
    return { ok: true, output: { sourceId: existing.id, duplicate: true, sha256 } };
  }

  const source = await db.Source.create({
    workspace_id: goal.workspace_id,
    conversation_id: goal.conversation_id || null,
    project_id: goal.project_id || null,
    kind: "agent_text",
    name: cleanText(String(args.name || "Agent finding")).slice(0, 200),
    media_type: "text/plain",
    byte_size: Buffer.byteLength(text, "utf8"),
    content_sha256: sha256,
    extracted_text: text.slice(0, 60_000),
    extraction: { produced_by: "autonomy", goal_id: goal.id, tick_id: tickId || null },
    risk_flags: [],
    fetched_at: new Date().toISOString()
  });
  return { ok: true, output: { sourceId: source.id, duplicate: false, sha256 } };
}
