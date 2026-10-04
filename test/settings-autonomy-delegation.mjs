// Switch delegation files (server/delegation-files.mjs).
//
// The *_UI_CONTROL env vars hand the switches to the UI: the five autonomy
// switches plus the council switches (Critic, Governor). On a phone there is
// no operator shell, so mobile/entry.mjs reads these files from the data dir
// at boot instead. The contract under test:
//   - the allow-list names exactly the six switches (anything else refused)
//   - only a trimmed "true" delegates (allow-list semantics, like envFlag)
//   - an env var already set keeps winning over a file

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
function ok(cond, name) {
  if (!cond) { console.error("FAIL:", name); process.exit(1); }
  pass++;
  console.log("ok:", name);
}

const {
  AUTONOMY_DELEGATION_FILES,
  isDelegationName,
  delegationEntry,
  readDelegationFile,
  applyAutonomyDelegationFiles,
} = await import("../server/delegation-files.mjs");

// The allow-list is exactly the five switches, each with a distinct env var
// and a distinct device file. (Phase 34: bypass_earning is gone with earning.)
ok(AUTONOMY_DELEGATION_FILES.length === 5, "exactly five delegation switches");
const names = AUTONOMY_DELEGATION_FILES.map((s) => s.name).sort();
ok(JSON.stringify(names) === JSON.stringify(["auto_authorize", "autonomy", "council", "outbox", "rungs"]),
  "switch names are the five expected");
ok(AUTONOMY_DELEGATION_FILES.every((s) => s.env.startsWith("COGNOS_") && s.file.endsWith(".txt")),
  "every switch maps a COGNOS_ env var to a .txt device file");
ok(new Set(AUTONOMY_DELEGATION_FILES.map((s) => s.env)).size === 5, "env vars are distinct");
ok(new Set(AUTONOMY_DELEGATION_FILES.map((s) => s.file)).size === 5, "files are distinct");

// Allow-list: the six pass, everything else is refused.
for (const name of names) ok(isDelegationName(name), `accepts "${name}"`);
ok(delegationEntry("autonomy")?.env === "COGNOS_AUTONOMY_UI_CONTROL", "entry resolves the env var");
ok(delegationEntry("outbox")?.file === "autonomy_outbox_ui_control.txt", "entry resolves the file");
// The council entry is the Governance fix: the Critic/Governor toggles get the
// same on-device handover as the autonomy switches.
ok(delegationEntry("council")?.env === "COGNOS_COUNCIL_UI_CONTROL", "council entry resolves the council env var");
ok(delegationEntry("council")?.file === "council_ui_control.txt", "council entry resolves the council file");
ok(!isDelegationName("nope"), "rejects unknown name");
ok(!isDelegationName(""), "rejects empty name");
ok(!isDelegationName(null), "rejects null");
ok(!isDelegationName("AUTONOMY"), "rejects wrong case");
ok(delegationEntry("nope") === null, "entry returns null for unknown name");

// File semantics in a temp data dir.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cognos-delegation-"));
const f = path.join(dir, "autonomy_ui_control.txt");
ok(readDelegationFile(dir, "autonomy_ui_control.txt") === false, "absent file is not delegated");
fs.writeFileSync(f, "true\n");
ok(readDelegationFile(dir, "autonomy_ui_control.txt") === true, "trimmed 'true' delegates");
fs.writeFileSync(f, "  true  ");
ok(readDelegationFile(dir, "autonomy_ui_control.txt") === true, "surrounding whitespace is trimmed");
fs.writeFileSync(f, "false");
ok(readDelegationFile(dir, "autonomy_ui_control.txt") === false, "'false' does not delegate");
fs.writeFileSync(f, "yes");
ok(readDelegationFile(dir, "autonomy_ui_control.txt") === false, "'yes' does not delegate — only exact 'true'");
fs.writeFileSync(f, "");
ok(readDelegationFile(dir, "autonomy_ui_control.txt") === false, "empty file does not delegate");

// applyAutonomyDelegationFiles: file -> env, and a pre-set env var wins.
const ENV = "COGNOS_AUTONOMY_UI_CONTROL";
delete process.env[ENV];
fs.writeFileSync(f, "true");
const applied = applyAutonomyDelegationFiles(dir);
ok(applied.includes("autonomy"), "apply returns the applied switch name");
ok(process.env[ENV] === "true", "apply sets the env var from the file");

process.env[ENV] = "1"; // a real operator's shell value
fs.rmSync(f);
const applied2 = applyAutonomyDelegationFiles(dir);
ok(!applied2.includes("autonomy"), "apply skips a switch whose env var is already set");
ok(process.env[ENV] === "1", "a pre-set env var keeps winning");
delete process.env[ENV];

// The council entry rides the same boot path: file -> env.
const COUNCIL_ENV = "COGNOS_COUNCIL_UI_CONTROL";
delete process.env[COUNCIL_ENV];
const cf = path.join(dir, "council_ui_control.txt");
fs.writeFileSync(cf, "true\n");
const applied3 = applyAutonomyDelegationFiles(dir);
ok(applied3.includes("council"), "apply picks up the council delegation file");
ok(process.env[COUNCIL_ENV] === "true", "apply sets the council env var from the file");
delete process.env[COUNCIL_ENV];

ok(applyAutonomyDelegationFiles(null).length === 0, "null data dir applies nothing");
ok(applyAutonomyDelegationFiles("/nonexistent-dir-xyz").length === 0, "missing data dir applies nothing");

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nsettings-autonomy-delegation: ${pass} checks passed`);
