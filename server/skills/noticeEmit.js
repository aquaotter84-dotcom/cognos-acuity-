// T2 — emit a templated notice.
//
// A notice is a TEMPLATE ID plus stored fields. This module never composes
// prose; it only names which template to render and hands over record values.
// The renderer lives in server/autonomy/notice.js and is the single place where
// a template id becomes text (pin.notice_deterministic).
//
// The effect is staged, not performed — staging is not acting (pin.effect_staged).

import { NOTICE_TEMPLATES, validateNoticeFields } from "../autonomy/notice.js";

export async function emitNotice({ goal, agent, args, tickId }) {
  const templateId = String(args.templateId || "");
  if (!NOTICE_TEMPLATES[templateId]) {
    return { ok: false, error: `unknown notice template: ${templateId}` };
  }
  const check = validateNoticeFields(templateId, args.fields || {});
  if (!check.ok) return { ok: false, error: check.errors.join("; ") };

  // Traceability fields (tickId, stepId) are deliberately NOT in the payload.
  // The payload is what the idempotency key is hashed from, so a tick id in
  // here would make every tick's notice look like a new effect — the dedup
  // would never fire and a repeated notice would be delivered twice. They are
  // recorded on the outbox row's own columns instead, where they belong.
  return {
    ok: true,
    output: { templateId, fields: check.fields, severity: args.severity || "info" },
    stages: [{
      skillId: "notice.emit",
      tier: "T2",
      effectType: "notify",
      payload: {
        templateId,
        fields: check.fields,
        severity: args.severity || "info",
        goalId: goal.id,
        agentId: agent?.id || null
      }
    }]
  };
}
