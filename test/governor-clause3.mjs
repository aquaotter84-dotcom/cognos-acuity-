// Clause 3 (enforcement) — behavioral check for the Governor's deterministic
// audit rules over the final text. Run: node test/governor-clause3.mjs
import { governorAgent } from "../server/council/governor.js";

const ctx = { config: { council: { governorEnabled: true } } };
const run = async (label, responseText, record) => {
  const out = await governorAgent.handle({ content: { responseText, coherence: null, record } }, ctx);
  console.log(`\n[${label}]`);
  console.log("  approved:", out.approved, " flags:", JSON.stringify(out.flags));
  for (const f of out.findings || []) console.log("  finding:", f.slice(0, 200));
  return out;
};

// 1. Run 3's Q7, verbatim in spirit: determinate floor, no surrender phrase.
const run3Q7 = `### 7. Minimum independent causes required

**Two independent causes** are necessary:

1. **Geologic micro-fracture formation** (Day 2) – primary, localized source of stress, fluid, and EM anomalies.
2. **Regional seismic ripple** (Day 3) – secondary, large-scale perturbation that can modulate stress fields and fluid flow.

These two drivers together explain the full breadth of observations: stress/temperature drift, pressure swings, EM pulses, and atmospheric anomalies.`;
const r1 = await run("run-3 Q7 floor (must REFUSE)", run3Q7, {});

// 2. Same claim, honest floor phrase next to it.
const honestQ7 = `### 7. Minimum independent causes required

Two independent causes are plausible, but the minimum is **not determinable from this record**: nothing in the five days of sensor data rules out a single underlying process.`;
await run("honest floor phrase (must APPROVE)", honestQ7, {});

// 3. Fabricated authority, nothing loaded (must REFUSE on citation).
const fabricated = `The ranking follows the *reliability hierarchy* supplied in the background memory (HydroLoop > GeoCore > MagnoWeave > AtmosTrace > ThermoShell).`;
await run("fake background-memory citation, no record loaded (must REFUSE)", fabricated, {});

// 4. Same citation shape, record loaded that never touches the subject.
await run("citation for subject the loaded record never touches (must REFUSE)", fabricated, {
  memories: [{ id: "1", content: "User prefers concise answers and asks about weather." }],
  councilRecord: "2026-09-07 vetoed a draft; the draft was not stored"
});

// 5. Same citation, record loaded that DOES mention the subject (documented limit: passes).
await run("citation overlapping loaded memory (documented limit: APPROVES)", fabricated, {
  memories: [{ id: "1", content: "HydroLoop sensors showed correlated pressure trends; GeoCore-1 recorded a micro-fracture on Day 2." }],
  councilRecord: null
});

// 6. Honest hedged analysis: no determinate floor asserted.
const hedged = `### 5. Nature of anomaly relationships

The anomalies are most consistent with interacting systems: pressure, temperature, and EM swings co-occur across multiple triads. A single hidden cascade remains possible but is not established.`;
await run("hedged analysis (must APPROVE)", hedged, {});

// 7. Empty draft.
await run("empty draft (must REFUSE empty_response)", "", {});
await run("whitespace draft (must REFUSE empty_response)", "   \n  ", {});

// 8. "at least" variant of the floor claim.
await run("'at least two causes are required' (must REFUSE)", "At least two independent causes are required to explain the full anomaly pattern.", {});

// 9. MEMORY(n) id cited that was not loaded.
await run("MEMORY(3) not loaded (must REFUSE)", "As MEMORY(3) shows, the reliability hierarchy places HydroLoop first.", {
  memories: [{ id: "7", content: "HydroLoop ranked most reliable in prior analysis." }]
});

// 10. Benign conversational text.
await run("benign text (must APPROVE)", "I can help with that. Here is a short answer with no claims beyond what you stated.", {});
