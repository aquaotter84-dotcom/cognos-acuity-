#!/usr/bin/env node
// v51 — Chat as the front door: the consolidated control set (persona, answer
// style, web lookup, research help) with active-choice chips, and the improved
// first-run / loading / error / citation / research-consent states.
//
// Source-structure tests (same pattern as test/nav-structure.mjs) plus a real
// unit test of the citation tokenizer: they read the shipped sources and
// assert on what Jeremy would tap.

import assert from "node:assert/strict";
import fs from "node:fs";

const repoRoot = new URL("../", import.meta.url);
const readSrc = (p) => fs.readFileSync(new URL(p, repoRoot), "utf8");

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const chatJsx = readSrc("src/pages/Chat.jsx");
const controls = readSrc("src/components/chat/ChatControls.jsx");
const chatInput = readSrc("src/components/chat/ChatInput.jsx");
const sourceComposer = readSrc("src/components/chat/SourceComposer.jsx");
const chatMessage = readSrc("src/components/chat/ChatMessage.jsx");
const welcome = readSrc("src/components/chat/WelcomeScreen.jsx");
const researchCard = readSrc("src/components/chat/ResearchDecisionCard.jsx");
const mobileNav = readSrc("src/components/chat/MobileNav.jsx");
const pkg = JSON.parse(readSrc("package.json"));

// ---------------------------------------------------------------------------
// The consolidated control set
// ---------------------------------------------------------------------------

await test("chat header no longer hosts the persona/style selects or the web-search toggle", async () => {
  const headerOpen = chatJsx.indexOf("<header");
  const headerClose = chatJsx.indexOf("</header>", headerOpen);
  assert.ok(headerOpen >= 0 && headerClose > headerOpen, "header block exists");
  const header = chatJsx.slice(headerOpen, headerClose);
  assert.ok(!header.includes("<select"), "no <select> in the header");
  assert.ok(!header.includes("setWebSearch"), "no web-search toggle in the header");
  assert.ok(!header.includes("Globe"), "no Globe icon in the header");
});

await test("the four choices live in one control set: sheet + active-choice chips", async () => {
  assert.ok(controls.includes("export function ChatControlSheet"), "ChatControlSheet exported");
  assert.ok(controls.includes("export function ActiveChoiceChips"), "ActiveChoiceChips exported");
  assert.ok(chatJsx.includes("<ChatControlSheet"), "Chat renders the sheet");
  assert.ok(chatJsx.includes("<ActiveChoiceChips"), "Chat renders the chip strip");
  for (const prop of ["style={style}", "webSearch={webSearch}", "personas={personas}", "activePersonaId={activePersonaId}", "agentMode={agentMode}", "onOpen="]) {
    assert.ok(chatJsx.includes(prop), `chip strip receives ${prop}`);
  }
});

await test("control labels are warm plain language, not jargon", async () => {
  for (const label of ["Easygoing", "Big picture", "Open my links", "Research for me"]) {
    assert.ok(controls.includes(`label: '${label}'`), `warm label present: ${label}`);
  }
  // No raw internal value leaks into a visible label.
  assert.ok(!controls.includes("label: 'read_only'"), "no raw 'read_only' label");
  assert.ok(!controls.includes("label: 'balanced'"), "no raw 'balanced' label");
  for (const section of ["How it talks", "Answer style", "Looking things up", "Research help"]) {
    assert.ok(controls.includes(section), `sheet section present: ${section}`);
  }
  assert.ok(controls.includes("Search the web"), "web lookup has a plain name");
});

await test("active choices surface as chips, each opening the sheet", async () => {
  assert.ok(controls.includes("persona.id !== 'default'"), "persona chip only for non-default voices");
  assert.ok(controls.includes("style !== 'balanced'"), "style chip only for non-default styles");
  assert.ok(controls.includes("if (webSearch)"), "web chip only when lookup is on");
  assert.ok(controls.includes("agentModeLabel(agentMode)"), "current research mode always shown as a chip");
  // Every chip opens the sheet.
  const chipBlock = controls.slice(controls.indexOf("export function ActiveChoiceChips"));
  assert.ok(chipBlock.includes("onClick={onOpen}"), "chips open the sheet");
  assert.ok(controls.includes('aria-label="Adjust how COGNOS answers"'), "tune button is labeled");
});

await test("choices persist: device-local settings and the server-side persona", async () => {
  for (const key of ["cognos.chatStyle", "cognos.webSearch", "cognos.agentMode"]) {
    assert.ok(chatJsx.includes(`'${key}'`), `persists ${key}`);
  }
  assert.ok(chatJsx.includes("api.activatePersona"), "persona choice persists server-side");
  assert.ok(controls.includes('role="dialog"'), "sheet is a dialog");
  assert.ok(controls.includes("Escape"), "sheet closes on Escape");
});

await test("the agent-mode selector left the composer row", async () => {
  assert.ok(!sourceComposer.includes("onAgentModeChange"), "SourceComposer no longer takes onAgentModeChange");
  assert.ok(!sourceComposer.includes('aria-label="Agent mode"'), "no agent-mode select in the composer");
  assert.ok(!chatInput.includes("onAgentModeChange"), "ChatInput no longer forwards onAgentModeChange");
  // The mode still rides along with every send.
  assert.ok(chatInput.includes("onSend(trimmed, { sources, agentMode })"), "agentMode still sent with each message");
  assert.ok(chatJsx.includes("agentMode={agentMode}") && chatJsx.includes("<ChatInput"), "Chat still passes the mode to the composer");
});

// ---------------------------------------------------------------------------
// First-run: welcoming, shows what the app can do, no overwhelm
// ---------------------------------------------------------------------------

await test("first-run is welcoming and plain-spoken", async () => {
  assert.ok(welcome.includes("Welcome to COGNOS"), "welcome headline");
  assert.ok(welcome.includes("shows its work"), "says what it does in plain words");
  assert.ok(welcome.includes("asks you before it opens a thing"), "consent-first promise up front");
  assert.ok(welcome.includes("choices under the header"), "points at the consolidated controls");
  for (const jargon of ["council", "SSE", "Governor", "PGlite"]) {
    assert.ok(!welcome.toLowerCase().includes(jargon.toLowerCase()), `no jargon on the welcome screen: ${jargon}`);
  }
});

await test("the Orbit face is untouched: same mark, same orbit classes", async () => {
  assert.ok(welcome.includes('aria-label="COGNOS"'), "the Mark is still the welcome face");
  assert.ok(welcome.includes("<svg viewBox=\"0 0 200 200\""), "the Mark svg is unchanged");
  for (const cls of ["orbit-eyebrow", "orbit-page-title", "orbit-page-sub", "orbit-agent-card"]) {
    assert.ok(welcome.includes(cls), `orbit class intact: ${cls}`);
  }
});

// ---------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------

await test("opening a conversation shows a calm loading state, not a blank screen", async () => {
  assert.ok(chatJsx.includes("loadingConversation"), "loading flag exists");
  assert.ok(chatJsx.includes("setLoadingConversation(true)"), "loading starts with the fetch");
  assert.ok(chatJsx.includes("Opening conversation…"), "calm loading copy");
  assert.ok(chatJsx.includes('role="status"'), "loading region is announced");
});

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

await test("a failed conversation load gets an honest error with retry, not the welcome screen", async () => {
  assert.ok(chatJsx.includes("loadError"), "load error flag exists");
  assert.ok(chatJsx.includes("Couldn't open this conversation."), "honest load-error copy");
  assert.ok(chatJsx.includes("setReloadToken"), "retry re-runs the fetch");
});

await test("failed turns render a calm error card with a retry", async () => {
  assert.ok(chatMessage.includes("message.processing_status === 'error'"), "error status branches to the card");
  assert.ok(chatMessage.includes("That didn't go through."), "warm error title");
  assert.ok(chatMessage.includes("Try again"), "retry button");
  assert.ok(chatMessage.includes("onRetry(message.retryText)"), "retry resends the original text");
  // Both error paths in Chat attach the text to retry with.
  const retryCount = (chatJsx.match(/retryText: text/g) || []).length;
  assert.ok(retryCount >= 2, `retryText attached on both error paths (found ${retryCount})`);
  assert.ok(!chatJsx.includes("The council could not answer"), "the old alarming error copy is gone");
});

await test("error content stays clean server-side; old rows are stripped client-side", async () => {
  const chatRoute = readSrc("server/routes/chat.js");
  assert.ok(!chatRoute.includes("The council could not answer"), "server persists just the detail now");
  assert.ok(chatMessage.includes("LEGACY_ERROR_PREFIX"), "card strips the legacy prefix from pre-v51 rows");
});

// ---------------------------------------------------------------------------
// Source citations
// ---------------------------------------------------------------------------

const citations = await import(new URL("../src/lib/citations.js", import.meta.url));

await test("citation tokenizer: source, memory, and goal-note locators", async () => {
  const toks = citations.splitCitationTokens("See [src_abc123] and [graph_def456], plus [goal_abc:n3].");
  const cites = toks.filter((t) => t.type === "cite");
  assert.equal(cites.length, 3, "three locators tokenized");
  assert.equal(cites[0].citation.kind, "source");
  assert.equal(cites[0].citation.label, "Source");
  assert.equal(cites[1].citation.kind, "memory");
  assert.equal(cites[1].citation.label, "Memory");
  assert.equal(cites[2].citation.kind, "note");
  assert.equal(cites[2].citation.label, "Note 3");
});

await test("citation tokenizer: custom source labels and non-citations", async () => {
  const toks = citations.splitCitationTokens("Read [src_abc123:Winterizing guide] first.");
  const cite = toks.find((t) => t.type === "cite");
  assert.ok(cite, "labeled locator tokenized");
  assert.equal(cite.citation.label, "Winterizing guide");
  assert.equal(citations.describeCitation("[not_a_cite]"), null, "non-locator returns null");
  assert.equal(citations.hasCitation("just words"), false);
  assert.equal(citations.hasCitation("see [src_a1] here"), true);
});

await test("answers render citations as chips, not raw bracket text", async () => {
  assert.ok(chatMessage.includes("splitCitationTokens"), "ChatMessage tokenizes citations");
  assert.ok(chatMessage.includes("<CitationChip"), "citations render as chips");
  assert.ok(chatMessage.includes("title={citation.locator}"), "chip keeps the locator reachable");
  // Only paragraph text is tokenized — citations inside links or code stay verbatim.
  const pRenderer = chatMessage.indexOf("p: ({ children })");
  assert.ok(pRenderer >= 0 && chatMessage.slice(pRenderer, pRenderer + 120).includes("withCitations"), "p renderer applies citation chips");
  const codeRenderer = chatMessage.indexOf("code: ({ children })");
  assert.ok(codeRenderer >= 0 && !chatMessage.slice(codeRenderer, codeRenderer + 120).includes("withCitations"), "code spans untouched");
});

// ---------------------------------------------------------------------------
// Research-consent state
// ---------------------------------------------------------------------------

await test("research consent stays explicit and gets calmer on phones", async () => {
  assert.ok(researchCard.includes("Approve &amp; run") || researchCard.includes("Approve & run"), "approve stays explicit");
  assert.ok(researchCard.includes("Decline"), "decline stays explicit");
  assert.ok(researchCard.includes("only the exact URLs listed above"), "consent is still scoped to the exact URLs");
  assert.ok(researchCard.includes("Show all"), "long step lists collapse with a show-all toggle");
  assert.ok(researchCard.includes("flex-wrap"), "action row wraps on narrow phones");
});

// ---------------------------------------------------------------------------
// v50 nav structure untouched
// ---------------------------------------------------------------------------

await test("v50 navigation structure is intact", async () => {
  for (const label of ["Chat", "Projects", "Memory", "Studio"]) {
    assert.ok(mobileNav.includes(`label: '${label}'`), `primary destination intact: ${label}`);
  }
  assert.ok(mobileNav.includes("More destinations"), "More overflow intact");
});

await test("the new test file is wired into npm test", async () => {
  assert.ok(pkg.scripts.test.includes("node test/chat-frontdoor.mjs"), "chat-frontdoor.mjs runs in npm test");
});

console.log(`\nchat-frontdoor: ${passed} passed`);
