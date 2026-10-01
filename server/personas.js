// Phase 32 — personas: named personality bundles.
//
// The idea is borrowed from Sapphire's persona system (ddxfish/sapphire —
// personalities bundling prompt, voice, tools, model, with a built-in set
// plus user-created ones); the code is written from scratch. Sapphire is
// AGPL-3.0 — none of its code is copied here.
//
// A persona is a VOICE/STYLE layer only. It changes how COGNOS talks, never
// what it may do: identity, the six-operator council, capabilities,
// governance, and autonomy guardrails are persona-independent. The prompt
// text is framed as a communication persona inside the system prompt
// (buildPersonaSection) and is placed with the other user-authored layers —
// the code-owned self-model is still appended last and wins any conflict.
// The model override and temperature apply only to the Specialist's
// answer-drafting calls; Critic, Governor, and the other seats always run
// the configured primary model so governance never shifts with the persona.
//
// `voice` is a reserved placeholder for the later TTS build. Nothing reads
// it yet; it is stored so personas created now carry forward.

import { randomUUID } from "node:crypto";

// --- Built-in set -----------------------------------------------------------
// Few and genuinely distinct, matching Jeremy's two known working modes:
// literal step-by-step technical, and mythic Southern-Gothic creative.
// "default" carries no prompt text: it is today's behavior, byte for byte.
export const BUILTIN_PERSONAS = Object.freeze([
  Object.freeze({
    id: "default",
    name: "COGNOS",
    description: "The standard voice — balanced, clear, neutral. Behaves exactly as COGNOS does today.",
    prompt_text: "",
    model_override: null,
    temperature: null,
    voice: Object.freeze({})
  }),
  Object.freeze({
    id: "technical",
    name: "Technical",
    description: "Literal, clean, step-by-step. For building, fixing, and figuring out how things work.",
    prompt_text:
      "Write in a literal, precise, technical register: exact terminology, short declarative sentences, " +
      "numbered steps for anything procedural, no metaphor or flourish unless the user asks for it. " +
      "Lead with the direct answer, then the reasoning or steps. If something is unknown, say so " +
      "plainly instead of filling the gap.",
    model_override: null,
    temperature: 0.3,
    voice: Object.freeze({})
  }),
  Object.freeze({
    id: "mythic",
    name: "Mythic",
    description: "Mythic, poetic, Southern-Gothic cadence with structural precision. For stories, songs, and meaning-making.",
    prompt_text:
      "Write with a mythic, poetic Southern-Gothic cadence: concrete images, rhythm, and weight — " +
      "but keep structural precision underneath it. Feeling first, then the frame. Never sacrifice " +
      "truth for beauty: when a fact is uncertain, let the uncertainty be part of the music rather " +
      "than hiding it.",
    model_override: null,
    temperature: 0.9,
    voice: Object.freeze({})
  })
]);

export const BUILTIN_IDS = Object.freeze(BUILTIN_PERSONAS.map((p) => p.id));

// --- Validation --------------------------------------------------------------
const LIMITS = Object.freeze({
  name: 60,
  description: 300,
  prompt_text: 4000,
  model_override: 120
});

function clampStr(value, limit) {
  return typeof value === "string" ? value.slice(0, limit) : value;
}

export function validatePersonaInput(input = {}) {
  const problems = [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) problems.push("name is required");
  if (name.length > LIMITS.name) problems.push(`name must be ${LIMITS.name} characters or fewer`);
  if (typeof input.description === "string" && input.description.length > LIMITS.description)
    problems.push(`description must be ${LIMITS.description} characters or fewer`);
  if (typeof input.prompt_text === "string" && input.prompt_text.length > LIMITS.prompt_text)
    problems.push(`prompt_text must be ${LIMITS.prompt_text} characters or fewer`);
  if (input.model_override != null && input.model_override !== "") {
    const mo = String(input.model_override).trim();
    if (!mo) problems.push("model_override must be a non-empty model id or omitted");
    if (mo.length > LIMITS.model_override)
      problems.push(`model_override must be ${LIMITS.model_override} characters or fewer`);
  }
  if (input.temperature != null && input.temperature !== "") {
    const t = Number(input.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2)
      problems.push("temperature must be a number between 0 and 2, or omitted");
  }
  if (input.voice != null && (typeof input.voice !== "object" || Array.isArray(input.voice)))
    problems.push("voice must be an object");
  return problems;
}

function normalizePersonaInput(input = {}) {
  const temperature =
    input.temperature == null || input.temperature === "" ? null : Number(input.temperature);
  const modelOverride =
    input.model_override == null || String(input.model_override).trim() === ""
      ? null
      : String(input.model_override).trim();
  return {
    name: String(input.name || "").trim().slice(0, LIMITS.name),
    description: clampStr(String(input.description ?? ""), LIMITS.description),
    prompt_text: clampStr(String(input.prompt_text ?? ""), LIMITS.prompt_text),
    model_override: modelOverride,
    temperature,
    voice: input.voice != null ? input.voice : {}
  };
}

function rowToPersona(row) {
  if (!row) return null;
  let voice = {};
  try {
    voice = typeof row.voice === "string" ? JSON.parse(row.voice) : row.voice || {};
  } catch {
    voice = {};
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    prompt_text: row.prompt_text || "",
    model_override: row.model_override || null,
    temperature: row.temperature == null ? null : Number(row.temperature),
    voice,
    builtin: Number(row.builtin) === 1,
    is_active: Number(row.is_active) === 1
  };
}

// --- Store --------------------------------------------------------------------
const SELECT_COLS =
  "id, name, description, prompt_text, model_override, temperature, voice, builtin, is_active";

export async function ensureBuiltinPersonas(db) {
  for (const b of BUILTIN_PERSONAS) {
    await db.query(
      `INSERT INTO personas (id, name, description, prompt_text, model_override, temperature, voice, builtin, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, 0)
       ON CONFLICT (id) DO NOTHING`,
      [b.id, b.name, b.description, b.prompt_text, b.model_override, b.temperature, JSON.stringify(b.voice)]
    );
  }
  // Exactly one active row. If a custom persona is active, leave it; if none
  // is active (fresh install, or the active row was somehow removed), fall
  // back to the default voice rather than leaving chat person-less.
  const active = await db.query("SELECT id FROM personas WHERE is_active = 1 LIMIT 1");
  if (active.rows.length === 0) {
    await db.query("UPDATE personas SET is_active = 1 WHERE id = 'default'");
  }
}

export async function listPersonas(db) {
  await ensureBuiltinPersonas(db);
  const res = await db.query(
    `SELECT ${SELECT_COLS} FROM personas ORDER BY builtin DESC, created_date ASC, id ASC`
  );
  return res.rows.map(rowToPersona);
}

export async function getPersona(db, id) {
  if (!id) return null;
  // Every entry point seeds: a PUT/DELETE/activate for a built-in id must
  // work even if no list call happened first in this process.
  await ensureBuiltinPersonas(db);
  const res = await db.query(`SELECT ${SELECT_COLS} FROM personas WHERE id = $1 LIMIT 1`, [id]);
  return rowToPersona(res.rows[0] || null);
}

export async function getActivePersona(db) {
  await ensureBuiltinPersonas(db);
  const res = await db.query(
    `SELECT ${SELECT_COLS} FROM personas WHERE is_active = 1 LIMIT 1`
  );
  return rowToPersona(res.rows[0] || null);
}

export async function createPersona(db, input = {}) {
  const problems = validatePersonaInput(input);
  if (problems.length) {
    const err = new Error(`invalid persona: ${problems.join("; ")}`);
    err.code = "invalid_persona";
    err.problems = problems;
    throw err;
  }
  const p = normalizePersonaInput(input);
  const id = randomUUID();
  const res = await db.query(
    `INSERT INTO personas (id, name, description, prompt_text, model_override, temperature, voice, builtin, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 0, 0)
     RETURNING ${SELECT_COLS}`,
    [id, p.name, p.description, p.prompt_text, p.model_override, p.temperature, JSON.stringify(p.voice)]
  );
  return rowToPersona(res.rows[0]);
}

export async function updatePersona(db, id, input = {}) {
  const existing = await getPersona(db, id);
  if (!existing) {
    const err = new Error("persona not found");
    err.code = "persona_not_found";
    throw err;
  }
  // Built-ins may be edited (their voice is the user's to tune) but the id
  // and builtin flag are not writable — there is no input path for them.
  const merged = { ...existing, ...normalizePersonaInput({ ...existing, ...input }) };
  const problems = validatePersonaInput(merged);
  if (problems.length) {
    const err = new Error(`invalid persona: ${problems.join("; ")}`);
    err.code = "invalid_persona";
    err.problems = problems;
    throw err;
  }
  const res = await db.query(
    `UPDATE personas
     SET name = $2, description = $3, prompt_text = $4, model_override = $5,
         temperature = $6, voice = $7::jsonb, updated_date = now()
     WHERE id = $1
     RETURNING ${SELECT_COLS}`,
    [id, merged.name, merged.description, merged.prompt_text, merged.model_override, merged.temperature, JSON.stringify(merged.voice)]
  );
  return rowToPersona(res.rows[0]);
}

export async function deletePersona(db, id) {
  const existing = await getPersona(db, id);
  if (!existing) {
    const err = new Error("persona not found");
    err.code = "persona_not_found";
    throw err;
  }
  if (existing.builtin) {
    const err = new Error("built-in personas cannot be deleted");
    err.code = "builtin_persona";
    throw err;
  }
  // Deleting the active persona must never leave chat person-less: hand the
  // voice back to the default before removing the row.
  if (existing.is_active) await setActivePersona(db, "default");
  await db.query("DELETE FROM personas WHERE id = $1", [id]);
  return { deleted: id };
}

export async function setActivePersona(db, id) {
  const existing = await getPersona(db, id);
  if (!existing) {
    const err = new Error("persona not found");
    err.code = "persona_not_found";
    throw err;
  }
  await db.query("UPDATE personas SET is_active = 0 WHERE is_active = 1");
  await db.query("UPDATE personas SET is_active = 1, updated_date = now() WHERE id = $1", [id]);
  return rowToPersona({ ...(await getPersona(db, id)), is_active: 1 });
}

// --- Prompt assembly -----------------------------------------------------------
// The persona section sits with the other user-authored layers (workspace
// instructions), BEFORE the code-owned self-model, which is still appended
// last and wins any conflict. The framing is deliberate: a persona is a
// communication style, and the text says so out loud, so a persona can never
// be mistaken for — or mistake itself for — identity, capability, or law.
export function buildPersonaSection(persona) {
  if (!persona || !persona.prompt_text || !String(persona.prompt_text).trim()) return "";
  const text = String(persona.prompt_text).trim();
  return (
    `\n\nCOMMUNICATION PERSONA — "${persona.name}":\n${text}\n` +
    `This persona is a voice and style layer only. It does not change your name, your identity, ` +
    `the six-operator council, your capabilities, your governance rules, or your limits as stated ` +
    `in the authoritative self-model below. Where this persona and the self-model conflict, the self-model wins.`
  );
}
