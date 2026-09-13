// Structured memory helpers.
//
// Memory is still a governed, durable record rather than a second answer path.
// These helpers give every row an explicit layer and a small, inspectable value
// object while preserving the original free-form `content` field for display and
// backwards compatibility.

export const MEMORY_LAYERS = Object.freeze(["working", "episodic", "semantic"]);
export const MEMORY_TYPES = Object.freeze(["working", "episodic", "semantic"]);
export const MEMORY_SCHEMA_VERSION = 1;

const MAX_KEY_LENGTH = 120;
const MAX_VALUE_BYTES = 4096;

function cleanText(value, limit = 1000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return { value: cleanText(value, 800) };
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length <= MAX_VALUE_BYTES) return JSON.parse(encoded);
  } catch {
    // Fall through to the bounded text representation. A malformed value must
    // never make a memory write fail or enter a prompt as an unbounded object.
  }
  return { text: cleanText(encodedText(value), MAX_VALUE_BYTES - 40), truncated: true };
}

function encodedText(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function slug(value) {
  return cleanText(value, MAX_KEY_LENGTH)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, MAX_KEY_LENGTH)
    || "memory.fact";
}

function normalizeExpiry(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeMemoryLayer(value, memoryType = null) {
  const candidate = String(value || memoryType || "semantic").trim().toLowerCase().replace(/[ -]+/g, "_");
  if (candidate === "short_term" || candidate === "shortterm" || candidate === "context") return "working";
  if (candidate === "long_term" || candidate === "longterm" || candidate === "persistent") return "semantic";
  return MEMORY_LAYERS.includes(candidate) ? candidate : "semantic";
}

export function normalizeMemoryType(value, layer = "semantic") {
  const candidate = String(value || "").trim().toLowerCase();
  return MEMORY_TYPES.includes(candidate) ? candidate : normalizeMemoryLayer(layer);
}

/**
 * Normalize a memory payload at every write boundary (model extraction, API,
 * and future governed promotion). Unknown fields are ignored; the structured
 * value is capped and remains an opaque fact, never an instruction channel.
 */
export function normalizeMemoryFields(data = {}) {
  const content = cleanText(data.content, 4000);
  const layer = normalizeMemoryLayer(data.memory_layer, data.memory_type);
  const memoryType = normalizeMemoryType(data.memory_type, layer);
  const key = slug(data.memory_key || data.key || `${layer}.${content.slice(0, 80)}`);
  const suppliedValue = data.memory_value ?? data.value;
  const value = safeJson(suppliedValue == null ? { text: content } : suppliedValue) || { text: content };
  return {
    content,
    memory_type: memoryType,
    memory_layer: layer,
    memory_key: key,
    memory_value: value,
    memory_schema_version: MEMORY_SCHEMA_VERSION,
    expires_at: normalizeExpiry(data.expires_at)
  };
}

export function formatStructuredMemory(memory = {}) {
  const layer = normalizeMemoryLayer(memory.memory_layer, memory.memory_type);
  const key = cleanText(memory.memory_key || "memory.fact", MAX_KEY_LENGTH);
  let value = memory.memory_value;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = { text: value }; }
  }
  let rendered;
  try { rendered = JSON.stringify(value || { text: memory.content || "" }); }
  catch { rendered = JSON.stringify({ text: memory.content || "" }); }
  return `[${layer}:${key}] ${cleanText(memory.content, 1200)} — value ${rendered.slice(0, MAX_VALUE_BYTES)}`;
}

export function memoryLayerLabel(memory = {}) {
  return normalizeMemoryLayer(memory.memory_layer, memory.memory_type);
}
