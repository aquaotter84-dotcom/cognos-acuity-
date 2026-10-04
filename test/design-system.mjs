#!/usr/bin/env node
// v52 — design system pass: one kit, token-based colors, readable type,
// visible focus, progressive disclosure.
//
// Source-structure tests (same pattern as test/nav-structure.mjs): they read
// the shipped sources and assert the covered screens (Projects, Memory,
// Studio, Settings) build from the kit instead of one-off classes.

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

const kit = readSrc("src/components/ui/CognosUi.jsx");
const css = readSrc("src/index.css");
const tailwind = readSrc("tailwind.config.js");
const projects = readSrc("src/pages/Projects.jsx");
const memory = readSrc("src/pages/Memory.jsx");
const settings = readSrc("src/pages/Settings.jsx");
const autonomy = readSrc("src/pages/Autonomy.jsx");
const ideas = readSrc("src/components/studio/IdeasTab.jsx");
const appUpdates = readSrc("src/components/settings/AppUpdatesSection.jsx");
const systemUi = readSrc("src/components/system/SystemUi.jsx");
const designerDrawer = readSrc("src/components/autonomy/DesignerDrawer.jsx");
const residentTools = readSrc("src/components/autonomy/ResidentTools.jsx");

const SCREENS = { projects, memory, settings, autonomy, ideas, appUpdates, designerDrawer, residentTools };

// ---------------------------------------------------------------------------
// The kit exists and exports the whole system
// ---------------------------------------------------------------------------

await test("kit exports every standardized component and token map", async () => {
  for (const name of [
    "export function Btn", "export function IconBtn", "export function Card",
    "export function SectionCard", "export function Badge", "export function Field",
    "export function TextInput", "export function TextArea", "export function Select",
    "export function Meta", "export function EmptyState", "export function Disclosure",
    "export const LAYER_TONES", "export const EVIDENCE_TONES", "export const VOLATILITY_TONES",
  ]) {
    assert.ok(kit.includes(name), `${name} is exported`);
  }
});

await test("Btn carries all variants incl. the one deliberate warm accent", async () => {
  for (const v of ["primary:", "secondary:", "ghost:", "danger:", "accentSoft:", "warm:"]) {
    assert.ok(kit.includes(v), `Btn variant ${v} defined`);
  }
  // The warm accent is documented as the single exception, living in the kit.
  assert.match(kit, /the one deliberate accent/);
});

await test("Badge tones are semantic and token-based", async () => {
  assert.match(kit, /ok:\s*'bg-ok\/15 text-ok'/);
  assert.match(kit, /warn:\s*'bg-warn\/15 text-warn'/);
  assert.match(kit, /bad:\s*'bg-destructive\/15 text-destructive'/);
  assert.match(kit, /info:\s*'bg-primary\/15 text-primary'/);
});

await test("the memory category palette is centralized with light+dark pairs", async () => {
  for (const layer of ["self:", "events:", "entities:", "knowledge:", "goals:"]) {
    assert.ok(kit.includes(layer), `LAYER_TONES has ${layer}`);
  }
  assert.ok(kit.includes("dark:text-violet-300"), "self layer has a dark treatment");
  assert.ok(kit.includes("dark:text-cyan-300"), "entities layer has a dark treatment");
  for (const level of ["direct:", "repeated:", "inferred:", "assumed:"]) {
    assert.ok(kit.includes(level), `EVIDENCE_TONES has ${level}`);
  }
  for (const level of ["low:", "medium:", "high:"]) {
    assert.ok(kit.includes(level), `VOLATILITY_TONES has ${level}`);
  }
});

await test("SystemUi Pill is the kit Badge — one badge, not two", async () => {
  assert.match(systemUi, /export \{ Badge as Pill \} from '\.\.\/ui\/CognosUi'/);
  assert.ok(!systemUi.includes("bg-green-500/15"), "no legacy green tone in Pill");
  assert.ok(!systemUi.includes("bg-yellow-500/15"), "no legacy yellow tone in Pill");
});

// ---------------------------------------------------------------------------
// Colors: tokens, no one-offs
// ---------------------------------------------------------------------------

await test("ok/warn tokens exist in both themes and in the tailwind config", async () => {
  assert.match(css, /:root\s*{[^}]*--ok:/s);
  assert.match(css, /:root\s*{[^}]*--warn:/s);
  assert.match(css, /\.dark\s*{[^}]*--ok:/s);
  assert.match(css, /\.dark\s*{[^}]*--warn:/s);
  assert.match(tailwind, /ok:\s*'hsl\(var\(--ok\)\)'/);
  assert.match(tailwind, /warn:\s*'hsl\(var\(--warn\)\)'/);
});

await test("no raw hex colors remain in the app stylesheet", async () => {
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), "index.css is hex-free");
});

await test("the Orbit classes ride the shared tokens (face kept, hex gone)", async () => {
  for (const cls of ["orbit-eyebrow", "orbit-page-title", "orbit-page-sub", "orbit-agent-card", "orbit-btn-dark", "orbit-pill-lime"]) {
    assert.ok(css.includes(`.${cls}`), `.${cls} still defined`);
  }
  const orbitBlock = css.slice(css.indexOf("Orbit's visual language"), css.indexOf("@layer utilities"));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(orbitBlock), "orbit classes are hex-free");
  assert.ok(orbitBlock.includes("hsl(var(--foreground))"), "titles use the foreground token");
  assert.ok(orbitBlock.includes("hsl(var(--muted-foreground))"), "subs use the muted token");
});

// Raw status-palette classes must not appear in the covered screens. The
// warm card chrome (amber-50/200/900/950 tints) and the kit's centralized
// category palette are the documented exceptions — they don't appear here.
const BANNED = [
  "text-green-500", "text-green-400", "text-green-600", "bg-green-500",
  "text-yellow-500", "text-yellow-400", "text-yellow-600", "bg-yellow-500", "border-yellow-500",
  "text-amber-400", "text-amber-600", "bg-amber-500",
  "text-violet-400", "bg-violet-500", "text-cyan-400", "bg-cyan-500",
  "text-red-400", "bg-red-500",
];

await test("no one-off status palette classes in the covered screens", async () => {
  for (const [name, src] of Object.entries(SCREENS)) {
    for (const cls of BANNED) {
      assert.ok(!src.includes(cls), `${name}: no ${cls}`);
    }
  }
});

await test("the covered screens use the ok/warn tokens", async () => {
  assert.ok(autonomy.includes("text-ok"), "Studio uses text-ok");
  assert.ok(autonomy.includes("bg-warn") || autonomy.includes("text-warn"), "Studio uses warn");
  assert.ok(settings.includes("text-ok"), "Settings uses text-ok");
  assert.ok(settings.includes("text-warn") || settings.includes("bg-warn"), "Settings uses warn");
  assert.ok(memory.includes("text-warn"), "Memory uses text-warn");
});

// ---------------------------------------------------------------------------
// Typography: reading sizes, metadata scale
// ---------------------------------------------------------------------------

await test("kit form controls read at text-sm (comfortable on a phone)", async () => {
  assert.ok(kit.includes("px-3 py-2 text-sm"), "inputs are text-sm");
});

await test("no sub-metadata type in the covered screens", async () => {
  for (const [name, src] of Object.entries(SCREENS)) {
    assert.ok(!src.includes("text-[9px]"), `${name}: no text-[9px]`);
  }
});

await test("the Meta component owns the metadata scale", async () => {
  assert.match(kit, /text-\[10px\] uppercase tracking-wide/);
  assert.ok(projects.includes("<Meta"), "Projects uses <Meta>");
});

// ---------------------------------------------------------------------------
// Focus states
// ---------------------------------------------------------------------------

await test("one global focus-visible rule covers every control", async () => {
  assert.ok(css.includes("button:focus-visible"), "buttons covered");
  assert.ok(css.includes("input:focus-visible"), "inputs covered");
  assert.ok(css.includes("select:focus-visible"), "selects covered");
  assert.ok(css.includes("textarea:focus-visible"), "textareas covered");
  assert.ok(css.includes("hsl(var(--ring))"), "the ring uses the ring token");
});

await test("kit buttons never suppress the focus ring", async () => {
  const btnBlock = kit.slice(kit.indexOf("export function Btn"), kit.indexOf("export function IconBtn"));
  const iconBtnBlock = kit.slice(kit.indexOf("export function IconBtn"), kit.indexOf("export function Card"));
  assert.ok(!btnBlock.includes("outline-none"), "Btn has no outline-none");
  assert.ok(!iconBtnBlock.includes("outline-none"), "IconBtn has no outline-none");
});

// ---------------------------------------------------------------------------
// Standardized structure per screen
// ---------------------------------------------------------------------------

await test("Settings sections build from SectionCard", async () => {
  for (const title of ["AI models", "Database", "Personas", "App updates", "Workspace", "Appearance", "Voice", "Governance", "Runtime"]) {
    assert.ok(settings.includes(`title="${title}"`) || appUpdates.includes(`title="${title}"`), `SectionCard "${title}"`);
  }
});

await test("Studio Section delegates to the kit SectionCard", async () => {
  assert.ok(autonomy.includes("function Section("), "local Section still the seam");
  assert.ok(autonomy.includes("<SectionCard"), "it delegates to SectionCard");
});

await test("Projects and Memory build from the kit", async () => {
  assert.ok(projects.includes("<Btn"), "Projects uses <Btn>");
  assert.ok(projects.includes("<EmptyState"), "Projects uses <EmptyState>");
  assert.ok(memory.includes("<Badge"), "Memory uses <Badge>");
  assert.ok(memory.includes("LAYER_TONES"), "Memory uses the centralized palette");
  assert.ok(!memory.includes("typeColors") && !memory.includes("layerColors"), "the four ad-hoc maps are gone");
});

await test("Studio decision buttons build from the kit", async () => {
  assert.ok(autonomy.includes('<Btn variant="primary"'), "primary decisions are kit buttons");
  assert.ok(autonomy.includes('<Btn variant="danger"'), "destructive decisions are kit buttons");
  assert.ok(autonomy.includes("<TextInput"), "Studio forms use kit inputs");
});

// ---------------------------------------------------------------------------
// Progressive disclosure: summary first, detail on tap
// ---------------------------------------------------------------------------

await test("Settings runtime detail is disclosed, not dumped", async () => {
  assert.ok(settings.includes('<Disclosure summary="More runtime detail"'), "runtime disclosure exists");
  // The headline rows stay visible; the machinery goes one tap deep.
  const runtimeAt = settings.indexOf('title="Runtime"');
  const disclosureAt = settings.indexOf('<Disclosure summary="More runtime detail"');
  const modelDeadlineAt = settings.indexOf('label="Model deadline"');
  assert.ok(runtimeAt < disclosureAt && disclosureAt < modelDeadlineAt, "deadline row lives inside the disclosure");
});

await test("Memory structured values are disclosed, not dumped", async () => {
  assert.ok(memory.includes('<Disclosure summary="Structured value"'), "memory_value disclosure exists");
});

await test("the kit Disclosure is a real details/summary", async () => {
  assert.ok(kit.includes("<details"), "Disclosure renders <details>");
  assert.ok(kit.includes("<summary"), "Disclosure renders <summary>");
});

console.log(`\ndesign-system: ${passed} tests passed`);
