// Council operator — Governor (sovereignty). A deterministic, model-free policy
// gate over the FINAL response text. It decides by rules, never by opinion.
//
// Rulebook:
//   empty_response                  the draft said nothing.
//   potential_secret_leak           the draft looked like it would leak a
//                                   credential (SECRET_PATTERNS below).
//   minimum_cause_without_floor     CLAUSE 3 (enforcement): the draft asserts a
//                                   determinate minimum number of causes
//                                   ("at least N", "N causes are necessary",
//                                   "cannot be explained without X") and does
//                                   not carry the honest floor phrase next to
//                                   the claim ("not determinable from this
//                                   record", or equivalent surrender words).
//   authority_citation_unverifiable CLAUSE 3 (enforcement): the draft leans on
//                                   a record authority — "the background
//                                   memory", "stored beliefs", "as established
//                                   in an earlier run", "the ledger", MEMORY(n)
//                                   — that this session never loaded, or that
//                                   never touches the subject it is cited for.
//
// ORIGIN STORY (why Clause 3 exists): run 3 of the Omega epistemic audit
// (2026-09-07) shipped an answer its own Critic scored 2/10. It fabricated a
// "reliability hierarchy supplied in the background memory" that the loaded
// record did not contain, kept "Two independent causes are necessary" as the
// minimum-cause floor while the key sensor was dark for the decisive stretch,
// and contradicted beliefs it had itself stored. The revision loop is capped
// at one pass, so the half-compliant draft reached the Governor, whose
// rulebook was only "not empty, no leaked secrets", and was approved blind:
// the Critic's flinch rode along in the trace but never reached the veto.
// Clause 3 gives the last gate its own audit, as deterministic rules over the
// final text. When the orchestrator sees an epistemic flag it sends the draft
// back to the Synthesizer once (council.governorMaxRevisions) with these
// findings plus the last Critic evaluation as the critique; if the revised
// draft still violates, a fixed refusal ships and the draft is never stored.
//
// The gate is deliberately NARROWER than the Critic's charter audit: it
// enforces the forms that actually shipped — determinate minimum-cause floors
// and citations to session-record authorities — not every epistemic sin. It
// will occasionally refuse a draft a human would pass; it prefers that to
// shipping one the record cannot carry, and the redraft pass exists so an
// honest draft survives with one clarifying sentence. What it CANNOT do is
// verify the truth of a claim against memory contents: when a loaded memory
// mentions the same subject, the overlap check passes and the contradiction
// layer (the Critic, the coherence monitor, the ledger) carries that finding
// instead. Coherence is data, never a vote (pin.veto_integrity).
//
// PHASE 14 ADDITION (informational only): the Governor is handed the Coherence
// Monitor's report as data, and returns it on its verdict so the trace, the
// ledger and the telemetry record all carry what was measured. Coherence can
// never approve something the Governor would refuse, and can never refuse
// something it would have approved (pin.veto_integrity: the veto semantics do
// not change — coherence never votes).

import { defineAgent } from "../shared/runtime.js";

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9]{20,}/i
];

// --- Clause 3, Rule 1: determinate minimum-cause floors ---------------------
// Assertions that a minimum number of causes is REQUIRED, stated as fact.
// Hedged language ("likely", "suggests", "consistent with") is deliberately
// NOT here: the gate polices the determinate forms that shipped, not analytic
// prose. When one of these fires, the honest floor phrase must stand in the
// same block or the block right after it — burying the uncertainty at the end
// of the answer is not compliance.

const FLOOR_CLAIM_PATTERNS = [
  /\b(?:at least|a minimum of|no fewer than|minimum of)\s+(?:one|two|three|four|five|six|[0-9]+)\s+(?:(?:independent|separate|necessary|distinct|hidden|primary|underlying|causal)\s+){0,2}(?:causes?|mechanisms?|drivers?|processes?|explanations?)/i,
  /\b(?:one|two|three|four|five|six|[0-9]+)\s+(?:(?:independent|separate|distinct|hidden|causal)\s+)?(?:causes?|mechanisms?|drivers?)\b[\s*_~#`:]*\s+(?:are|is)\s+(?:necessary|required|needed)\b/i,
  /\b(?:requires?|needs?)\s+(?:at least\s+|a minimum of\s+)?(?:one|two|three|four|five|six|[0-9]+)\s+(?:(?:independent|separate|necessary|distinct|causal)\s+)?(?:causes?|mechanisms?|drivers?)/i,
  /\bcannot\s+be\s+explained\s+(?:without|by\s+fewer\s+than)\b/i,
  /\bminimum(?:\s+number\s+of)?(?:\s+independent)?\s+(?:causes?|mechanisms?|drivers?)\s+(?:required|needed|necessary)\b[^.\n]{0,100}\b(?:is|are|stands?\s+at)\s+(?:one|two|three|four|five|six|[0-9]+)\b/i,
  /\b(?:together|coupled|combined)\b[^.\n]{0,50}\bexplains?\s+(?:everything|all|the full|the entire)\b/i,
  /\bno single\s+(?:cause|causal\s+mechanism|mechanism|driver|process|explanation)\b[^.\n]{0,80}\b(?:can|can'?t|could|is\s+able\s+to)\b/i,
  /\b(?:is|remains|constitutes)\s+(?:the\s+)?(?:most\s+)?(?:consistent|likely|probable|plausible|sufficient)?\s*(?:a\s+|the\s+)?single\s+(?:hidden\s+)?(?:cascade|cause|causal\s+mechanism|mechanism|driver|framework|explanation)\b/i
];

const FLOOR_SURRENDER_PATTERNS = [
  /not determinable from this record/i,
  /not determinable\b/i,
  /\b(?:cannot|can'?t|unable to|no (?:way|basis|means|grounds) to|impossible to)\b[^.\n]{0,60}\bdetermin/i,
  /insufficient (?:evidence|data|information|record)[^.\n]{0,60}\bdetermin/i,
  /indeterminate\b/i,
  /cannot rule out|cannot be ruled out|can'?t rule out|can'?t be ruled out/i,
  /remains? (?:possible|plausible|unknown|uncertain)\b/i,
  /\buncertain\b|\bnot certain\b/i,
  /(?:cannot|can'?t)\s+be\s+known\b|(?:cannot|can'?t)\s+know\b/i
];

// --- Clause 3, Rule 2: authority citations vs. the loaded record ------------
// Triggers when the draft leans on a record authority OUTSIDE the user's own
// message: the background/stored memory, the ledger, an earlier run or
// session, MEMORY(n). What the council may legitimately cite is exactly what
// the session loaded: the selected memories and the council record
// (improvement ledger + veto events). Everything else is an invention, and
// inventions are what run 3 shipped. Bare references to "the record" or "the
// stated facts" are deliberately NOT here: those usually mean the scenario the
// user provided, which lives in the conversation, not in the loaded record.

const AUTHORITY_CITATION_PATTERNS = [
  /background\s+memor/gi,
  /stored\s+(?:memory|belief|record|knowledge|hierarchy)/gi,
  /\bthe\s+(?:memory|belief|ledger|hierarchy|knowledge\s+base)\s+(?:shows|states|says|indicates|contains?|supplied|established|ranks?|records?|lists?)/gi,
  /according\s+to\s+(?:the\s+)?(?:memory|ledger)/gi,
  /as\s+(?:stated|recorded|established|supplied|shown|ranked)\s+(?:in|by)\s+(?:the\s+)?(?:memory|ledger|stored\s+record)/gi,
  /\b(?:previous|earlier|prior)\s+(?:run|session)\b/gi,
  /MEMORY\s*\(\s*[0-9]+\s*\)/gi,
  /\bmemory\s+#?[0-9]+\b/gi
];

// --- Helpers ----------------------------------------------------------------

const STOP_WORDS = new Set(
  ("a an the and or but not no nor for with without from into onto over under between " +
   "through during after before about against because while when where which who whom " +
   "this that these those their there they we our its it is are was were be been being " +
   "has have had having will would could should can may might must of to by on at in " +
   "out up as so than then them his her you your").split(" ")
);

function contentTokens(s) {
  const tokens = new Set();
  for (const raw of String(s || "").toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []) {
    if (!STOP_WORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}

function sharesAny(a, b) {
  if (!a.size || !b.size) return false;
  for (const t of a) {
    if (b.has(t)) return true;
  }
  return false;
}

// A bounded window around a match, roughly one sentence or one line.
function sentenceWindow(text, index) {
  let start = index;
  let guard = 0;
  while (start > 0 && guard < 200) {
    start--;
    guard++;
    const c = text[start];
    if (c === "\n") { start++; break; }
    if (c === "." && (start + 1 >= text.length || text[start + 1] === " " || text[start + 1] === "\n")) { start += 2; break; }
  }
  let end = index;
  guard = 0;
  while (end < text.length && guard < 280) {
    const c = text[end];
    if (c === "\n") break;
    if (c === "." && (end + 1 >= text.length || text[end + 1] === " " || text[end + 1] === "\n")) { end++; break; }
    end++;
    guard++;
  }
  return text.slice(Math.max(0, start), Math.min(text.length, end + 1));
}

function auditMinimumCauseFloors(text) {
  const findings = [];
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const claim = FLOOR_CLAIM_PATTERNS.find((p) => p.test(block));
    if (!claim) continue;
    const nearby = `${block}\n\n${blocks[i + 1] || ""}`;
    const surrendered = FLOOR_SURRENDER_PATTERNS.some((p) => p.test(nearby));
    if (!surrendered) {
      const flat = block.replace(/\s+/g, " ");
      const snippet = flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
      findings.push(`minimum-cause floor asserted without the honest floor phrase near it ("${snippet}"). The clause demands the draft say the floor out loud — "not determinable from this record" — or cite the evidence that rules out N-1 causes.`);
    }
  }
  return findings;
}

function auditAuthorityCitations(text, record) {
  const findings = [];
  const memories = Array.isArray(record?.memories) ? record.memories : [];
  const councilRecord =
    typeof record?.councilRecord === "string" && record.councilRecord.trim() ? record.councilRecord : null;
  const loadedAnything = memories.length > 0 || !!councilRecord;
  const memoryIds = new Set(memories.map((m) => String(m?.id ?? "").trim()).filter(Boolean));
  const hasNumericIds = [...memoryIds].some((id) => /^[0-9]+$/.test(id));
  const corpusTokens = contentTokens([
    ...memories.map((m) => String(m?.content ?? "")),
    councilRecord || ""
  ].join(" "));
  for (const pattern of AUTHORITY_CITATION_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = pattern.exec(text)) !== null && guard < 40) {
      guard++;
      const window = sentenceWindow(text, m.index);
      const idRefs = [...String(window).matchAll(/(?:MEMORY\s*\(\s*|memory\s+#?)([0-9]+)/gi)].map((x) => x[1]);
      if (idRefs.length && hasNumericIds) {
        const missing = idRefs.filter((id) => !memoryIds.has(id));
        if (missing.length) {
          findings.push(`cites memory id ${missing.join(", ")} but this session loaded no memory with that id`);
        }
        continue;
      }
      if (!loadedAnything) {
        findings.push(`cites "${m[0]}" but this session loaded no memory and no council record to cite`);
        continue;
      }
      const windowTokens = contentTokens(window);
      if (windowTokens.size > 0 && !sharesAny(windowTokens, corpusTokens)) {
        findings.push(`cites "${m[0]}" for subject matter the loaded record never touches`);
      }
    }
  }
  return findings;
}

export const governorAgent = defineAgent({
  name: "governor",
  type: "post",
  async handle(message, ctx) {
    if (!ctx.config.council.governorEnabled) {
      return { approved: true, flags: [], findings: [] };
    }
    const { responseText, coherence, record } = message.content;
    const flags = [];
    const findings = [];
    const text = responseText || "";
    if (!text.trim()) {
      flags.push("empty_response");
    } else {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(text)) {
          flags.push("potential_secret_leak");
          break;
        }
      }
      // Clause 3 — the verdict is decided above, by the rules, before this
      // section runs. The audits are pure text checks; every finding is a
      // quoted fact about the draft, never an opinion about it.
      const floorFindings = auditMinimumCauseFloors(text);
      const citationFindings = auditAuthorityCitations(text, record);
      if (floorFindings.length) flags.push("minimum_cause_without_floor");
      if (citationFindings.length) flags.push("authority_citation_unverifiable");
      findings.push(...floorFindings, ...citationFindings);
    }
    // The coherence measurement rides along; it does not vote.
    return {
      approved: flags.length === 0,
      flags,
      findings: findings.slice(0, 6),
      coherence: coherence
        ? { verdict: coherence.verdict || null, checked: coherence.checked !== false, contradictions: (coherence.contradictions || []).length }
        : null
    };
  }
});
