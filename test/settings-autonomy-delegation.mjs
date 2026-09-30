// Autonomy switch delegation files (server/delegation-files.mjs).
//
// The five *_UI_CONTROL env vars hand the Autonomy page's switches to the UI.
// On a phone there is no operator shell, so mobile/entry.mjs reads these files
// from the data dir at boot instead. The contract under test:
//   - the allow-list names exactly the five switches (anything else refused)
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
// and a distinct device file.
ok(AUTONOMY_DELEGATION_FILES.length === 5, "exactly five delegation switches");
const names = AUTONOMY_DELEGATION_FILES.map((s) => s.name).sort();
ok(JSON.stringify(names) === JSON.stringify(["auto_authorize", "autonomy", "bypass_earning", "outbox", "rungs"]),
  "switch names are the five expected");
ok(AUTONOMY_DELEGATION_FILES.every((s) => s.env.startsWith("COGNOS_") && s.file.endsWith(".txt")),
  "every switch maps a COGNOS_ env var to a .txt device file");
ok(new Set(AUTONOMY_DELEGATION_FILES.map((s) => s.env)).size === 5, "env vars are distinct");
ok(new Set(AUTONOMY_DELEGATION_FILES.map((s) => s.file)).size === 5, "files are distinct");

// Allow-list: the five pass, everything else is refused.
for (const name of names) ok(isDelegationName(name), `accepts "${name}"`);
ok(delegationEntry("autonomy")?.env === "COGNOS_AUTONOMY_UI_CONTROL", "entry resolves the env var");
ok(delegationEntry("outbox")?.file === "autonomy_outbox_ui_control.txt", "entry resolves the file");
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

ok(applyAutonomyDelegationFiles(null).length === 0, "null data dir applies nothing");
ok(applyAutonomyDelegationFiles("/nonexistent-dir-xyz").length === 0, "missing data dir applies nothing");

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\nsettings-autonomy-delegation: ${pass} checks passed`);
