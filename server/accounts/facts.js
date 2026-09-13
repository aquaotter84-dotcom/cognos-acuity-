// Phase 24 — the authoritative-fact registry.
//
// The account service never invents user facts. Every fact it asserts about a
// person comes from a trust-annotated Atlas row (Phase 23, graph_nodes) whose
// trust annotation says it is truth-bearing. This module is the single place
// where those graph ids are named in code, so a reviewer can trace any claim
// the API makes back to the exact row that carries it.
//
// RULE (mirrors the atlas contract in server/knowledge/graph.js):
//   * Only rows annotated `trusted` (or `verified`) are truth-bearing and may
//     be used to generate assertions.
//   * Any row NOT truth-bearing is contextual only and must NEVER back an
//     assertion here. This registry therefore holds trusted rows exclusively —
//     the pure test in test/phase24.mjs enforces that nothing else slips in.

/**
 * Trusted Atlas facts. `value` is what the row states; `trust` is the row's
 * annotation. Nothing outside this table may be presented as an authoritative
 * fact by /api/accounts/me or any other surface.
 */
export const TRUSTED_ATLAS_FACTS = Object.freeze({
  // Registered fact: user.name.full — trusted, truth-bearing.
  graph_mu02bqyvnd1cmlmv: Object.freeze({
    subject: "user.name.full",
    value: "Jeremy Bryan Perritt",
    trust: "trusted",
    note: "The canonical legal name. Truth-bearing."
  }),
  // Registered fact: user.role — trusted.
  graph_mu02bqun6vptjczp: Object.freeze({
    subject: "user.role",
    value: "developer of the assistant",
    trust: "trusted",
    note: "The operator's relationship to this system."
  }),
  // Registered fact: user.preferred.name — trusted.
  graph_mu02br2ofvew5mqm: Object.freeze({
    subject: "user.preferred.name",
    value: "Patches",
    trust: "trusted",
    note: "Preferred address. Seeds the default display name (see DEFAULT_DISPLAY_NAME)."
  }),
  // Registered fact: user.values — trusted.
  graph_mu02br6ged2v5219: Object.freeze({
    subject: "user.values",
    value: ["autonomy", "deep work", "maker mindset", "subtractive innovation",
            "opposes bureaucracy", "opposes merit-ocracy"],
    trust: "trusted",
    note: "Values surfaced verbatim by /api/accounts/me; never editorialized."
  }),
  // Registered fact: user.name.variant — trusted.
  graph_mu02bra9qiw2n5kp: Object.freeze({
    subject: "user.name.variant",
    value: "Jeremy Brian Perritt",
    trust: "trusted",
    note: "Known spelling variant; a distinct row from the canonical full name."
  }),
  // Registered fact: user.name.middle — trusted. Spelled "Bryan".
  graph_mu01yzi4hosh3erz: Object.freeze({
    subject: "user.name.middle",
    value: "Bryan",
    trust: "trusted",
    note: "Middle name spelling; prefer this over the variant row's spelling."
  }),
  // Registered fact: conservative duplicate of the name — trusted.
  graph_mtzt7k3ei9ozy2ci: Object.freeze({
    subject: "user.name.duplicate",
    value: "Jeremy Brian Perritt",
    trust: "trusted",
    note: "A conservative duplicate of the name row. Held, never merged away."
  }),
  // Registered fact: the assistant is no longer tied to the Base44 layer — trusted.
  graph_mtzt7jzlg5oklort: Object.freeze({
    subject: "assistant.integration",
    value: "no longer tied to the Base44 integration layer",
    trust: "trusted",
    note: "Historical note the API may assert about itself."
  })
});

/**
 * Preferred name comes from trusted graph row [graph_mu02br2ofvew5mqm].
 * Used as the default display_name when a registration provides none.
 * Override per deployment with COGNOS_DEFAULT_DISPLAY_NAME.
 */
export const DEFAULT_DISPLAY_NAME = "Patches";

/** Values come from trusted graph row [graph_mu02br6ged2v5219]. */
export const TRUSTED_VALUES = TRUSTED_ATLAS_FACTS.graph_mu02br6ged2v5219.value;

/** Look up one trusted fact by its exact graph id (with or without brackets). */
export function trustedFact(graphId) {
  const id = String(graphId || "").replace(/^\[|\]$/g, "").trim();
  return TRUSTED_ATLAS_FACTS[id] || null;
}

/**
 * The annotated fact list returned by GET /api/accounts/me. Every entry names
 * the row it came from, so the client can cite provenance the same way the
 * atlas does: [graph_mu02br2ofvew5mqm] — preferred name "Patches", trusted.
 */
export function authoritativeFacts() {
  return Object.entries(TRUSTED_ATLAS_FACTS).map(([graphId, fact]) => ({
    graph_id: `[${graphId}]`,
    subject: fact.subject,
    value: fact.value,
    trust: fact.trust,
    note: fact.note
  }));
}
