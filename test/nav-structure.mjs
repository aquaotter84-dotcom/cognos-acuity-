#!/usr/bin/env node
// v50 — navigation restructure tests: structure-level proof that every route
// is still reachable, the primary/secondary split is honored on both mobile
// and desktop, the Studio tabs are grouped with a "Needs your attention"
// landing, and no approval path got buried.
//
// These are source-structure tests (same pattern as test/studio.mjs):
// they read the shipped sources and assert on what Jeremy would tap.

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

const appJsx = readSrc("src/App.jsx");
const mobileNav = readSrc("src/components/chat/MobileNav.jsx");
const sidebar = readSrc("src/components/chat/Sidebar.jsx");
const autonomy = readSrc("src/pages/Autonomy.jsx");
const attentionRoute = readSrc("server/routes/autonomy.js");

// ---------------------------------------------------------------------------
// Routes: everything still exists, /signin stays standalone
// ---------------------------------------------------------------------------

await test("every destination route still exists under the app layout", async () => {
  for (const path of ["/", "/memory", "/activity", "/projects", "/autonomy", "/system", "/about", "/settings"]) {
    assert.match(appJsx, new RegExp(`path="${path.replace("/", "\\/")}"`), `route ${path} is registered`);
  }
});

await test("/signin stays standalone and hidden outside the app layout", async () => {
  const layoutOpen = appJsx.indexOf("<Route element={<CognosLayout />}>");
  assert.ok(layoutOpen >= 0, "CognosLayout route wrapper exists");
  // The first bare </Route> after the layout opens closes it (children are self-closing).
  const layoutClose = appJsx.indexOf("</Route>", layoutOpen);
  const signinAt = appJsx.indexOf('path="/signin"');
  assert.ok(signinAt > layoutClose, "/signin is rendered outside the CognosLayout route");
});

// ---------------------------------------------------------------------------
// Mobile: primary bottom bar = Chat, Projects, Memory, Studio + More
// ---------------------------------------------------------------------------

const PRIMARY_LABELS = ["Chat", "Projects", "Memory", "Studio"];
const MORE_LABELS = ["Activity", "System", "About COGNOS", "Settings"];

await test("mobile bottom bar carries only the four everyday destinations plus More", async () => {
  for (const label of PRIMARY_LABELS) {
    assert.match(mobileNav, new RegExp(`label: '${label}'`), `primary item '${label}' defined`);
  }
  assert.match(mobileNav, /More/, "a More overflow entry exists");
  // The advanced destinations must not be primary bottom-bar items.
  const primaryBlock = mobileNav.slice(
    mobileNav.indexOf("PRIMARY_ITEMS"),
    mobileNav.indexOf("MORE_ITEMS")
  );
  for (const label of MORE_LABELS) {
    assert.doesNotMatch(primaryBlock, new RegExp(`label: '${label}'`), `'${label}' is not a primary mobile item`);
  }
});

await test("mobile More sheet lists every advanced destination, none deleted", async () => {
  const moreBlock = mobileNav.slice(mobileNav.indexOf("MORE_ITEMS"));
  for (const label of MORE_LABELS) {
    assert.match(moreBlock, new RegExp(`label: '${label}'`), `More sheet contains '${label}'`);
  }
});

await test("mobile More sheet frames System as diagnostics", async () => {
  assert.match(mobileNav, /diagnostics/i, "System carries a diagnostics framing in the More sheet");
});

await test("mobile More sheet closes after navigating", async () => {
  assert.match(mobileNav, /onClick=\{\(\) => setMoreOpen\(false\)\}/, "tapping a More destination closes the sheet");
});

// ---------------------------------------------------------------------------
// Desktop: primary links on top, a labeled More group below
// ---------------------------------------------------------------------------

await test("desktop sidebar leads with Projects, Studio, Memory", async () => {
  for (const path of ["/projects", "/autonomy", "/memory"]) {
    assert.match(sidebar, new RegExp(`navLink\\('${path}'`), `sidebar links ${path} as primary`);
  }
});

await test("desktop sidebar groups Activity/System/About/Settings under a More heading", async () => {
  const moreHeading = sidebar.indexOf(">More<");
  assert.ok(moreHeading >= 0, "a More group heading exists");
  const afterMore = sidebar.slice(moreHeading);
  for (const path of ["/activity", "/system", "/about", "/settings"]) {
    assert.match(afterMore, new RegExp(`navLink\\('${path}'`), `${path} sits under the More group`);
  }
  // And none of them appear before the More heading.
  const beforeMore = sidebar.slice(0, moreHeading);
  for (const path of ["/activity", "/system", "/about", "/settings"]) {
    assert.doesNotMatch(beforeMore, new RegExp(`navLink\\('${path}'`), `${path} is not a primary sidebar link`);
  }
});

await test("desktop sidebar labels System as the diagnostic area", async () => {
  assert.match(sidebar, /System · diagnostics/, "System is labeled as diagnostics");
  assert.match(sidebar, /Ledger, telemetry, and laws/, "System carries a diagnostics subtitle");
});

// ---------------------------------------------------------------------------
// Studio: grouped tabs with a "Needs your attention" landing
// ---------------------------------------------------------------------------

const tabIds = [...autonomy.matchAll(/\{ id: '([a-z]+)', label:/g)].map(m => m[1]);

await test("Studio defines the attention landing tab first", async () => {
  assert.equal(tabIds[0], "attention", "attention is the first tab");
  assert.match(autonomy, /\{ id: 'attention', label: 'Needs your attention'/, "attention tab is labeled 'Needs your attention'");
});

await test("Studio opens on the attention landing by default", async () => {
  assert.match(autonomy, /useState\('attention'\)/, "the default Studio tab is the attention landing");
});

await test("Studio groups cover every tab exactly once", async () => {
  const gStart = autonomy.indexOf("const TAB_GROUPS");
  const gEnd = autonomy.indexOf("];", gStart);
  const groupsBlock = autonomy.slice(gStart, gEnd);
  const grouped = [...groupsBlock.matchAll(/'([a-z]+)'/g)].map(m => m[1])
    .filter(id => id !== "heading" && tabIds.includes(id));
  assert.deepEqual([...grouped].sort(), [...tabIds].sort(), "every tab id appears in exactly one group");
  const headings = [...groupsBlock.matchAll(/heading: '([^']+)'/g)].map(m => m[1]);
  assert.ok(headings.length >= 4, `at least four labeled groups exist (found ${headings.length})`);
  assert.ok(headings.includes("Start here"), "a 'Start here' group leads");
});

await test("the attention landing renders the aggregate panel, not a new decision surface", async () => {
  const landingAt = autonomy.indexOf("tab === 'attention'");
  assert.ok(landingAt >= 0, "an attention content branch exists");
  const landingBlock = autonomy.slice(landingAt, landingAt + 1200);
  assert.match(landingBlock, /<AttentionPanel/, "the landing renders the AttentionPanel aggregate");
  assert.match(landingBlock, /onJump=\{setTab\}/, "aggregate rows jump to the resolving tab in one tap");
});

await test("the attention panel appears exactly once (single landing)", async () => {
  const uses = [...autonomy.matchAll(/<AttentionPanel/g)].length;
  assert.equal(uses, 1, "AttentionPanel is rendered exactly once");
});

await test("the attention aggregate covers all five waiting kinds from the server", async () => {
  for (const kind of ["awaiting_authorization", "staged_effect", "unread_notice", "open_promotion", "open_cleanup"]) {
    assert.match(attentionRoute, new RegExp(`kind: "${kind}"`), `server attention queue includes ${kind}`);
  }
});

await test("every aggregate jump target is a real Studio tab (no approval path buried)", async () => {
  const targets = [...attentionRoute.matchAll(/\n\s*tab: "([a-z]+)"/g)].map(m => m[1]);
  assert.ok(targets.length >= 5, `attention queue names at least five resolving tabs (found ${targets.length})`);
  for (const t of new Set(targets)) {
    assert.ok(tabIds.includes(t), `attention jump target '${t}' is a real Studio tab`);
  }
  // The approval-bearing tabs specifically must still exist.
  for (const t of ["outbox", "notices", "promotions", "cleanup", "goals"]) {
    assert.ok(tabIds.includes(t), `approval-bearing tab '${t}' still exists`);
  }
});

console.log(`\nNAV-STRUCTURE RESULT: ${passed} passed`);
