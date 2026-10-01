// Council switch delegation (Settings → Governance handover).
//
// The Critic/Governor toggles are dead until COGNOS_COUNCIL_UI_CONTROL is
// handed over — the same bug class as the Autonomy switches. The fix puts the
// council entry on the same delegation allow-list and the same generic
// /api/settings/autonomy-delegation endpoints, and adds the handover panel to
// the Governance section. The contract under test:
//   - the settings API lists the "council" switch with its labels
//   - POST {name:"council"} writes the delegation file (mode 600); the switch
//     is NOT live until the restart (honest: delegated=false, fileDelegated=true)
//   - unknown names are refused; DELETE removes the file
//   - a real env var keeps winning over the file
//   - SAFETY: handing over never changes the rest state — both seats rest ON,
//     and the toggles stay unusable until the restart applies the file
//   - the Governance section renders the handover panel while uiControl is off

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootHarness } from "./harness.mjs";

let pass = 0;
function ok(cond, name) {
  if (!cond) { console.error("FAIL:", name); process.exit(1); }
  pass++;
  console.log("ok:", name);
}

delete process.env.COGNOS_COUNCIL_UI_CONTROL;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cognos-council-delegation-"));

const t = await bootHarness({ COGNOS_DATA_DIR: dataDir });
try {
  // --- GET lists the council switch -----------------------------------------
  const get1 = await t.raw("/api/settings/autonomy-delegation");
  ok(get1.status === 200, "GET delegation -> 200");
  ok(get1.json.managed === "device", "delegation is device-managed with COGNOS_DATA_DIR");
  const council = (get1.json.switches || []).find((s) => s.name === "council");
  ok(!!council, "the switch list includes \"council\"");
  ok(council.envVar === "COGNOS_COUNCIL_UI_CONTROL", "council switch names the council env var");
  ok(typeof council.label === "string" && council.label.length > 0, "council switch has a label");
  ok(typeof council.cta === "string" && council.cta.length > 0, "council switch has a CTA");
  ok(typeof council.blurb === "string" && council.blurb.length > 0, "council switch has a blurb");
  ok(council.delegated === false && council.fileDelegated === false, "council starts not delegated");

  // --- safety baseline: both seats rest ON, toggles not usable ----------------
  const cs1 = await t.raw("/api/council/settings");
  ok(cs1.status === 200, "GET /api/council/settings -> 200");
  ok(cs1.json.governorEnabled === true && cs1.json.criticEnabled === true, "both seats rest ON");
  ok(cs1.json.uiControl === false, "uiControl is false before handover");
  ok(cs1.json.canToggleGovernor === false && cs1.json.canToggleCritic === false, "toggles are refused before handover");

  // --- POST hands over: file written, not yet live ----------------------------
  const post = await t.raw("/api/settings/autonomy-delegation", {
    method: "POST",
    body: { name: "council" },
  });
  ok(post.status === 200 && post.json.ok === true, "POST council -> ok");
  ok(post.json.restartRequired === true, "handover says a restart is required");
  const fp = path.join(dataDir, "council_ui_control.txt");
  ok(fs.existsSync(fp), "the council delegation file was written");
  ok(fs.readFileSync(fp, "utf8").trim() === "true", "the file carries exactly \"true\"");
  ok((fs.statSync(fp).mode & 0o777) === 0o600, "the file is mode 600");
  const echoed = (post.json.switches || []).find((s) => s.name === "council");
  ok(echoed && echoed.fileDelegated === true && echoed.delegated === false,
    "after handover: fileDelegated but NOT delegated — the page must not pretend the switch is live");

  // --- safety: the handover changed nothing about the seats -------------------
  const cs2 = await t.raw("/api/council/settings");
  ok(cs2.json.governorEnabled === true && cs2.json.criticEnabled === true,
    "handing over does not flip either seat — both still rest ON");
  ok(cs2.json.uiControl === false, "uiControl stays false until the restart applies the file");

  // --- unknown names are refused ------------------------------------------------
  const bad = await t.raw("/api/settings/autonomy-delegation", {
    method: "POST",
    body: { name: "nope" },
  });
  ok(bad.status === 400, "POST unknown name -> 400");
  const badDel = await t.raw("/api/settings/autonomy-delegation", {
    method: "DELETE",
    body: { name: "nope" },
  });
  ok(badDel.status === 400, "DELETE unknown name -> 400");

  // --- DELETE takes it back ------------------------------------------------------
  const del = await t.raw("/api/settings/autonomy-delegation", {
    method: "DELETE",
    body: { name: "council" },
  });
  ok(del.status === 200 && del.json.ok === true, "DELETE council -> ok");
  ok(!fs.existsSync(fp), "the council delegation file was removed");

  // --- a real env var keeps winning ------------------------------------------------
  process.env.COGNOS_COUNCIL_UI_CONTROL = "true";
  const get2 = await t.raw("/api/settings/autonomy-delegation");
  const council2 = (get2.json.switches || []).find((s) => s.name === "council");
  ok(council2 && council2.delegated === true, "a real env var delegates without any file");
  delete process.env.COGNOS_COUNCIL_UI_CONTROL;

  // --- the Governance section wires the handover panel ---------------------------
  // No DOM harness in this repo, so this is a wiring check on the source: the
  // panel must exist, render while uiControl is off, and hand over "council".
  const src = fs.readFileSync(new URL("../src/pages/Settings.jsx", import.meta.url), "utf8");
  ok(src.includes("function CouncilHandover("), "Settings.jsx defines the CouncilHandover panel");
  ok(src.includes("!(council?.uiControl)") && src.includes("<CouncilHandover />"),
    "the panel renders while the council switches are not handed over");
  ok(src.includes("handOverAutonomySwitch('council')") && src.includes("takeBackAutonomySwitch('council')"),
    "the panel hands over and takes back the \"council\" switch through the delegation API");
  ok(src.includes("close and reopen the app") || src.includes("Close and reopen the app"),
    "the panel is honest that the handover takes effect on restart");
} finally {
  await t.stop();
  delete process.env.COGNOS_COUNCIL_UI_CONTROL;
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\nsettings-council-delegation: ${pass} checks passed`);
