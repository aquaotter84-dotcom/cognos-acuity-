// The notice renderer — the ONLY place a template id becomes text.
//
// pin.notice_deterministic: a notice is a deterministic rendering of stored
// records through a fixed template, containing no model-generated text. A
// notice is not an answer.
//
// This module is small on purpose, and strict on purpose. Every template
// declares exactly which fields it accepts, and validateNoticeFields() REJECTS
// any key that is not declared. That single rule is what stops a model from
// smuggling prose into the UI through an undeclared field: there is no channel
// from model output to notice text except a template id and a value that fits
// a declared, length-bounded slot.

const bounded = (value, max) => String(value ?? "")
  .replace(/[\u0000-\u001F\u007F]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const oneOf = (value, allowed, fallback) =>
  allowed.includes(value) ? value : fallback;

/**
 * Every template: the fields it accepts, and the renderer.
 * Field values are primitives only — never nested prose, never arrays of text.
 */
export const NOTICE_TEMPLATES = Object.freeze({
  goal_parked: Object.freeze({
    fields: Object.freeze({
      goalTitle: "string",
      agentName: "string",
      parkReason: "enum",
      stepsExecuted: "number",
      findings: "number",
      effectsAwaitingApproval: "number"
    }),
    enums: Object.freeze({
      parkReason: ["awaiting_approval", "budget_exhausted", "blocked_on_evidence",
        "error_backoff", "paused_by_user", "kill_switch", "scope_expired"]
    }),
    severity: "warning",
    render: (f) => `Goal parked: "${f.goalTitle}" — ${f.parkReason.replace(/_/g, " ")}.`
      + ` ${f.stepsExecuted} step(s) run, ${f.findings} finding(s) recorded.`
      + (f.effectsAwaitingApproval ? ` ${f.effectsAwaitingApproval} effect(s) awaiting approval.` : "")
  }),

  goal_completed: Object.freeze({
    fields: Object.freeze({
      goalTitle: "string",
      agentName: "string",
      stepsExecuted: "number",
      findings: "number"
    }),
    enums: Object.freeze({}),
    severity: "info",
    render: (f) => `Goal complete: "${f.goalTitle}".`
      + ` ${f.stepsExecuted} step(s), ${f.findings} finding(s). Ask COGNOS about it to turn findings into an answer.`
  }),

  finding_ready: Object.freeze({
    fields: Object.freeze({
      goalTitle: "string",
      agentName: "string",
      findings: "number",
      sourcesProduced: "number"
    }),
    enums: Object.freeze({}),
    severity: "info",
    render: (f) => `${f.agentName || "A resident"} recorded ${f.findings} new finding(s) on "${f.goalTitle}"`
      + (f.sourcesProduced ? ` and produced ${f.sourcesProduced} evidence snapshot(s).` : ".")
  }),

  budget_warning: Object.freeze({
    fields: Object.freeze({
      goalTitle: "string",
      agentName: "string",
      budgetLine: "string",
      spent: "number",
      limit: "number"
    }),
    enums: Object.freeze({}),
    severity: "warning",
    render: (f) => `Budget warning on "${f.goalTitle}": ${f.budgetLine} at ${f.spent} of ${f.limit}.`
  })
});

export const NOTICE_TEMPLATE_IDS = Object.freeze(Object.keys(NOTICE_TEMPLATES));

const MAX_STRING = 120;

/**
 * Coerce and bound every field, rejecting anything the template did not
 * declare. Unknown keys are an ERROR, not a silent drop — a model trying to
 * pass `prose: "..."` should see a recorded refusal, not a quiet success.
 */
export function validateNoticeFields(templateId, fields = {}) {
  const template = NOTICE_TEMPLATES[templateId];
  if (!template) return { ok: false, errors: [`unknown template: ${templateId}`], fields: {} };

  const errors = [];
  const clean = {};
  const source = fields && typeof fields === "object" && !Array.isArray(fields) ? fields : {};

  for (const key of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(template.fields, key)) {
      errors.push(`${key} is not a field of ${templateId}`);
    }
  }

  for (const [key, type] of Object.entries(template.fields)) {
    const raw = source[key];
    if (raw === undefined || raw === null) {
      if (type === "number") clean[key] = 0;
      else if (type === "enum") clean[key] = (template.enums?.[key] || ["unknown"])[0];
      else clean[key] = "";
      continue;
    }
    if (type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) errors.push(`${key} must be a number`);
      else clean[key] = Math.max(0, Math.trunc(n));
    } else if (type === "enum") {
      const allowed = template.enums?.[key] || [];
      if (!allowed.includes(raw)) errors.push(`${key} must be one of: ${allowed.join(", ")}`);
      else clean[key] = raw;
    } else {
      const text = bounded(raw, MAX_STRING);
      if (!text) errors.push(`${key} must be a non-empty string`);
      clean[key] = text;
    }
  }

  return { ok: errors.length === 0, errors, fields: clean };
}

/**
 * Render a validated notice to text. Deterministic: same fields, same string,
 * forever. `agentName` and `goalTitle` are stored record values (a resident's
 * name, a goal's title) — both bounded at insert time.
 */
/**
 * Build a template's field set and nothing else.
 *
 * A caller that passes the union of every template's fields produces a payload
 * carrying keys the template never declared — which defeats the point of
 * pin.notice_deterministic. Unknown keys are dropped here rather than
 * validated-and-refused, because this is the system filling in its own record
 * values, not a model submitting text.
 */
export function buildNoticeFields(templateId, values = {}) {
  const template = NOTICE_TEMPLATES[templateId];
  if (!template) return null;
  const out = {};
  for (const [key, type] of Object.entries(template.fields)) {
    const raw = values?.[key];
    if (type === "number") {
      const n = Number(raw);
      out[key] = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
    } else if (type === "enum") {
      const allowed = template.enums?.[key] || [];
      out[key] = allowed.includes(raw) ? raw : (allowed[0] ?? "unknown");
    } else {
      out[key] = String(raw ?? "").slice(0, MAX_STRING);
    }
  }
  return out;
}

export function renderNotice(templateId, fields = {}) {
  const template = NOTICE_TEMPLATES[templateId];
  if (!template) return null;
  const check = validateNoticeFields(templateId, fields);
  if (!check.ok) return null;
  try {
    return template.render(check.fields);
  } catch {
    return null;   // a renderer that throws produces no notice, never a partial one
  }
}

/** The safe public shape: a template id and fields, never prose from a model. */
export function publicNotice(row) {
  const fields = typeof row.fields === "string" ? safeJson(row.fields) : (row.fields || {});
  return {
    id: row.id,
    templateId: row.template_id,
    fields,
    severity: oneOf(row.severity, ["info", "warning", "error"], "info"),
    text: renderNotice(row.template_id, fields),
    goalId: row.goal_id || null,
    agentId: row.agent_id || null,
    createdMs: Number(row.created_ms) || null,
    ackedMs: row.acked_ms === null || row.acked_ms === undefined ? null : Number(row.acked_ms)
  };
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return {}; }
}
