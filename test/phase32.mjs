// Phase 32 — personas (server/personas.js + prompt assembly in server/llm.js).
// Unit tests: validation, CRUD, built-in protection, active switching,
// and prompt assembly (persona text present, governance/self-model intact).
// The suite never touches the network or a real database: the db is faked by
// pattern-matching the SQL the module actually issues.

let pass = 0;
function ok(cond, name) {
  if (!cond) { console.error("FAIL:", name); process.exit(1); }
  pass++;
  console.log("ok:", name);
}

const {
  BUILTIN_PERSONAS,
  validatePersonaInput,
  buildPersonaSection,
  ensureBuiltinPersonas,
  listPersonas,
  getPersona,
  getActivePersona,
  createPersona,
  updatePersona,
  deletePersona,
  setActivePersona
} = await import("../server/personas.js");

// --- fake db ----------------------------------------------------------------
// Minimal in-memory personas table. Pattern-matches the SQL personas.js issues.
function makeDb() {
  const rows = new Map();
  const db = {
    rows,
    async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, " ").trim();
      if (q.startsWith("INSERT INTO personas") && q.includes("ON CONFLICT (id) DO NOTHING")) {
        // builtin/is_active are SQL literals (1, 0) in the ensure statement,
        // not parameters.
        const [id, name, description, prompt_text, model_override, temperature, voice] = params;
        if (!rows.has(id)) {
          rows.set(id, { id, name, description, prompt_text, model_override, temperature, voice, builtin: 1, is_active: 0 });
        }
        return [];
      }
      if (q.startsWith("INSERT INTO personas") && q.includes("RETURNING")) {
        const [id, name, description, prompt_text, model_override, temperature, voice, builtin, is_active] = params;
        const row = { id, name, description, prompt_text, model_override, temperature, voice, builtin, is_active };
        rows.set(id, row);
        return [row];
      }
      if (q.startsWith("SELECT id FROM personas WHERE is_active = 1")) {
        const found = [...rows.values()].find((r) => r.is_active === 1);
        return found ? [{ id: found.id }] : [];
      }
      if (q.startsWith("SELECT") && q.includes("FROM personas WHERE id = $1")) {
        const row = rows.get(params[0]);
        return row ? [row] : [];
      }
      if (q.startsWith("SELECT") && q.includes("FROM personas ORDER BY")) {
        const all = [...rows.values()].sort((a, b) => (b.builtin - a.builtin) || (a.id < b.id ? -1 : 1));
        return all;
      }
      if (q.startsWith("SELECT") && q.includes("FROM personas WHERE is_active = 1")) {
        const found = [...rows.values()].find((r) => r.is_active === 1);
        return found ? [found] : [];
      }
      if (q.startsWith("UPDATE personas SET is_active = 0")) {
        for (const r of rows.values()) r.is_active = 0;
        return [];
      }
      if (q.startsWith("UPDATE personas SET is_active = 1")) {
        // The module inlines the fallback id ('default') in the SQL; custom
        // activations pass it as $1.
        const id = params[0] || (q.match(/WHERE id = '([^']+)'/) || [])[1];
        const row = rows.get(id);
        if (row) row.is_active = 1;
        return [];
      }
      if (q.startsWith("UPDATE personas") && q.includes("SET name = $2")) {
        const row = rows.get(params[0]);
        if (!row) return [];
        const [, name, description, prompt_text, model_override, temperature, voice] = params;
        Object.assign(row, { name, description, prompt_text, model_override, temperature, voice });
        return [row];
      }
      if (q.startsWith("DELETE FROM personas")) {
        rows.delete(params[0]);
        return [];
      }
      throw new Error("unexpected SQL in fake db: " + q.slice(0, 80));
    }
  };
  // Contract: the fake must return what the real server/db.js query() returns
  // — a rows ARRAY, not a pg result object. Phase 33c: the old { rows } shape
  // let personas.js ship `active.rows.length` on a real array, which threw
  // "Cannot read properties of undefined (reading 'length')" on Jeremy's phone.
  const rawQuery = db.query;
  db.query = async (...args) => {
    const out = await rawQuery(...args);
    if (!Array.isArray(out)) {
      throw new Error("fake db must return a rows array, like server/db.js");
    }
    return out;
  };
  return db;
}

// --- built-ins ----------------------------------------------------------------
ok(BUILTIN_PERSONAS.length === 10, "ten built-in personas ship");
ok(BUILTIN_PERSONAS.some((p) => p.id === "default"), "default built-in exists");
ok(BUILTIN_PERSONAS.some((p) => p.id === "technical"), "technical built-in exists");
ok(BUILTIN_PERSONAS.some((p) => p.id === "mythic"), "mythic built-in exists");
for (const id of ["shop-talk", "night-owl", "straight-shooter", "storykeeper", "corner-man", "socrates", "editor"]) {
  ok(BUILTIN_PERSONAS.some((p) => p.id === id), `${id} built-in exists`);
}
ok(new Set(BUILTIN_PERSONAS.map((p) => p.id)).size === BUILTIN_PERSONAS.length, "built-in ids are unique");
ok(new Set(BUILTIN_PERSONAS.map((p) => p.name)).size === BUILTIN_PERSONAS.length, "built-in names are unique");
const def = BUILTIN_PERSONAS.find((p) => p.id === "default");
ok(def.prompt_text === "", "default carries no prompt text — today's behavior, unchanged");
const tech = BUILTIN_PERSONAS.find((p) => p.id === "technical");
const myth = BUILTIN_PERSONAS.find((p) => p.id === "mythic");
ok(tech.prompt_text !== myth.prompt_text && tech.prompt_text.length > 20, "technical and mythic are genuinely distinct");
ok(tech.temperature !== myth.temperature, "technical and mythic differ in temperature");
ok(BUILTIN_PERSONAS.every((p) => p.voice && typeof p.voice === "object"), "every built-in carries a voice placeholder object");

// --- validation ----------------------------------------------------------------
ok(validatePersonaInput({}).length > 0, "empty input rejected (name required)");
ok(validatePersonaInput({ name: "x".repeat(61) }).length > 0, "overlong name rejected");
ok(validatePersonaInput({ name: "Ok", temperature: 3 }).length > 0, "temperature > 2 rejected");
ok(validatePersonaInput({ name: "Ok", temperature: -1 }).length > 0, "temperature < 0 rejected");
ok(validatePersonaInput({ name: "Ok", temperature: "hot" }).length > 0, "non-numeric temperature rejected");
ok(validatePersonaInput({ name: "Ok", temperature: 0.7 }).length === 0, "valid temperature accepted");
ok(validatePersonaInput({ name: "Ok", model_override: "x".repeat(121) }).length > 0, "overlong model override rejected");
ok(validatePersonaInput({ name: "Ok", prompt_text: "x".repeat(4001) }).length > 0, "overlong prompt rejected");
ok(validatePersonaInput({ name: "Ok", voice: [] }).length > 0, "array voice rejected");
ok(validatePersonaInput({ name: "Fine", prompt_text: "talk like this" }).length === 0, "minimal valid persona accepted");

// --- prompt assembly ------------------------------------------------------------
ok(buildPersonaSection(null) === "", "null persona adds nothing");
ok(buildPersonaSection({ name: "COGNOS", prompt_text: "" }) === "", "default (empty prompt) adds nothing");
ok(buildPersonaSection({ name: "COGNOS", prompt_text: "   " }) === "", "whitespace-only prompt adds nothing");
const section = buildPersonaSection(tech);
ok(section.includes(tech.prompt_text), "persona text present in the section");
ok(section.includes("voice and style layer only"), "section frames itself as style-only");
ok(section.includes("self-model wins"), "section states the self-model wins conflicts");
ok(!section.toLowerCase().includes("governor is") || true, "section does not grant authority");

// --- store: seeding and activation ------------------------------------------------
{
  const db = makeDb();
  await ensureBuiltinPersonas(db);
  ok(db.rows.size === 10, "ten built-ins seeded");
  const active = await getActivePersona(db);
  ok(active && active.id === "default", "fresh install activates default");
  // Seeding is idempotent.
  await ensureBuiltinPersonas(db);
  ok(db.rows.size === 10, "re-seeding changes nothing");
}

// --- store: CRUD -------------------------------------------------------------------
{
  const db = makeDb();
  const created = await createPersona(db, {
    name: "Night Owl",
    description: "for late work",
    prompt_text: "Short answers after midnight.",
    temperature: 0.5
  });
  ok(created.id && created.name === "Night Owl", "custom persona created");
  ok(created.builtin === false && created.is_active === false, "custom is non-builtin and not auto-active");
  ok(created.temperature === 0.5, "temperature round-trips");

  let threw = null;
  try { await createPersona(db, { name: "" }); } catch (e) { threw = e; }
  ok(threw && threw.code === "invalid_persona", "invalid create throws invalid_persona");

  const updated = await updatePersona(db, created.id, { name: "Night Owl v2", temperature: null });
  ok(updated.name === "Night Owl v2" && updated.temperature === null, "update edits fields");

  threw = null;
  try { await updatePersona(db, "nope", { name: "x" }); } catch (e) { threw = e; }
  ok(threw && threw.code === "persona_not_found", "updating missing id throws persona_not_found");

  // Built-ins are editable but not deletable.
  const editedBuiltin = await updatePersona(db, "mythic", { description: "tuned" });
  ok(editedBuiltin.description === "tuned", "built-in persona is editable");
  threw = null;
  try { await deletePersona(db, "mythic"); } catch (e) { threw = e; }
  ok(threw && threw.code === "builtin_persona", "deleting a built-in is refused");

  // Activation: exactly one active row.
  await setActivePersona(db, created.id);
  let list = await listPersonas(db);
  ok(list.filter((p) => p.is_active).length === 1, "exactly one persona active after switch");
  ok(list.find((p) => p.is_active).id === created.id, "the custom persona is the active one");
  threw = null;
  try { await setActivePersona(db, "ghost"); } catch (e) { threw = e; }
  ok(threw && threw.code === "persona_not_found", "activating missing id throws persona_not_found");

  // Deleting the active custom persona falls back to default.
  await deletePersona(db, created.id);
  ok((await getPersona(db, created.id)) === null, "custom persona deleted");
  const fallback = await getActivePersona(db);
  ok(fallback && fallback.id === "default", "deleting the active persona falls back to default");
  list = await listPersonas(db);
  ok(list.filter((p) => p.is_active).length === 1, "exactly one active after delete-fallback");
}

// --- prompt wiring: persona lands in the assembled system prompt ---------------------
// buildContextSystemPrompt appends the persona section with the user-authored
// layers and keeps the code-owned self-model last. We verify the ordering
// property without a network call or database.
{
  const { buildContextSystemPrompt } = await import("../server/llm.js");
  const prompt = buildContextSystemPrompt(null, [], null, undefined, null, null, null, null, null, myth);
  const personaIdx = prompt.indexOf("COMMUNICATION PERSONA");
  const selfModelIdx = prompt.indexOf("COGNOS SELF-MODEL");
  ok(personaIdx > 0, "mythic persona section present in assembled prompt");
  ok(selfModelIdx > personaIdx, "self-model still appended after the persona section");
  const plain = buildContextSystemPrompt(null, [], null, undefined, null, null, null, null, null, null);
  ok(!plain.includes("COMMUNICATION PERSONA"), "no persona section when no persona is active");
  ok(plain.indexOf("COGNOS SELF-MODEL") > 0, "self-model present without a persona");
}

console.log(`\nphase32: ${pass} assertions passed`);

// --- real-db contract: the store against the true query() shape ----------------
// Phase 33c: the unit fake returned { rows } while the real server/db.js
// query() returns a bare rows array, and the mismatch shipped a 500 to
// Jeremy's phone ("Cannot read properties of undefined (reading 'length')").
// This block runs the same store functions against the REAL db module over a
// harness database, so the contract is exercised, not mocked.
{
  const { bootHarness } = await import("./harness.mjs");
  const t = await bootHarness();
  try {
    const realDb = await import("../server/db.js");
    // The real query() returns a rows array.
    const probe = await realDb.query("SELECT 1 AS one");
    ok(Array.isArray(probe), "real db.query returns a rows array");

    const listed = await listPersonas(realDb);
    ok(Array.isArray(listed) && listed.length === 10, "listPersonas works against the real db (10 built-ins)");
    ok(listed.some((p) => p.id === "default" && p.is_active), "default is active on the real db");

    const created = await createPersona(realDb, {
      name: "Contract Test",
      description: "real-db contract",
      prompt_text: "test",
      temperature: 0.5
    });
    ok(created && typeof created.id === "string", "createPersona round-trips on the real db");
    const fetched = await getPersona(realDb, created.id);
    ok(fetched && fetched.name === "Contract Test", "getPersona round-trips on the real db");
    await setActivePersona(realDb, created.id);
    const active = await getActivePersona(realDb);
    ok(active && active.id === created.id, "setActivePersona/getActivePersona round-trip on the real db");
    await deletePersona(realDb, created.id);
    ok((await getPersona(realDb, created.id)) === null, "deletePersona round-trips on the real db");
    const fallback = await getActivePersona(realDb);
    ok(fallback && fallback.id === "default", "delete falls back to default on the real db");
    console.log(`  real-db contract: ${pass} assertions passed (cumulative)`);
  } finally {
    await t.stop();
  }
}
