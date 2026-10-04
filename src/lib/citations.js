// v51 — source citation tokens.
//
// Answers cite evidence with inline locators the Governor validates:
//   [src_<id>] or [src_<id>:label]  — an immutable source snapshot
//   [graph_<id>]                     — a knowledge-graph node
//   [goal_<tail>:n<ordinal>]         — a goal note
//
// This module splits message text on those locators so ChatMessage can
// render them as calm citation chips instead of raw bracket text. Pure:
// no DOM, no React — unit-testable from test/chat-frontdoor.mjs.

const COMBINED_RE = /(\[src_[a-z0-9]+(?::[^\]]+)?\]|\[graph_[a-z0-9]+\]|\[goal_[a-z0-9]+:n\d+\])/gi;

const SRC_RE = /^\[src_[a-z0-9]+(?::([^\]]+))?\]$/i;
const GRAPH_RE = /^\[graph_[a-z0-9]+\]$/i;
const GOAL_NOTE_RE = /^\[goal_[a-z0-9]+:n(\d+)\]$/i;

/** Describe one locator token for the chip. Returns null for non-locators. */
export function describeCitation(token) {
  const t = String(token || '');
  let m = t.match(SRC_RE);
  if (m) {
    const custom = (m[1] || '').trim();
    return {
      kind: 'source',
      label: custom ? custom.slice(0, 32) : 'Source',
      locator: t,
    };
  }
  if (GRAPH_RE.test(t)) return { kind: 'memory', label: 'Memory', locator: t };
  m = t.match(GOAL_NOTE_RE);
  if (m) return { kind: 'note', label: `Note ${m[1]}`, locator: t };
  return null;
}

/**
 * Split text into an ordered token list:
 *   [{ type: 'text', text }, { type: 'cite', token, citation }]
 * `citation` is the describeCitation() result (null when the token did not
 * parse — callers should render those as plain text).
 */
export function splitCitationTokens(text) {
  const input = String(text || '');
  const out = [];
  let last = 0;
  COMBINED_RE.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = COMBINED_RE.exec(input)) !== null && guard++ < 200) {
    if (m.index > last) out.push({ type: 'text', text: input.slice(last, m.index) });
    out.push({ type: 'cite', token: m[0], citation: describeCitation(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < input.length) out.push({ type: 'text', text: input.slice(last) });
  return out;
}

/** True when the text contains at least one citation locator. */
export function hasCitation(text) {
  COMBINED_RE.lastIndex = 0;
  return COMBINED_RE.test(String(text || ''));
}
