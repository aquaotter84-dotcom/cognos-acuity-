// Plain language for the autonomy surface — Phase 25.
//
// WHY THIS FILE EXISTS. The Autonomy page and the Goal Card both used to show
// the system's internal vocabulary to the person operating it: `awaiting_authorization`,
// `parked / budget_exhausted`, `T2`, `Rung 3`. Those names are correct in code
// and in the audit trail, and useless on a screen — an operator who cannot tell
// "parked" from "cancelled" cannot tell a system that is waiting from a system
// that has stopped.
//
// THE RULE. Jargon is not removed, it is DEMOTED. Every label here has the
// machine string next to it in a "Technical details" disclosure, and nothing in
// this file changes what is stored or sent: the API keeps returning
// `awaiting_authorization`, the ledger keeps recording `budget_exhausted`, and
// the pill says "Waiting for you". A label is a reading, never a rewrite —
// pin.truthful_self_model applies to the words on the screen too.
//
// Shared by src/pages/Autonomy.jsx and src/components/chat/GoalCard.jsx so the
// same status cannot read one way on the page and another way in chat.

/** Goal status -> what it means for the person who has to act on it. */
export const GOAL_STATUS_LABEL = {
  proposed: 'Drafted',
  awaiting_authorization: 'Waiting for you',
  active: 'Running',
  parked: 'Paused with a reason',
  completed: 'Finished',
  cancelled: 'Ended',
  expired: 'Authorization expired',
};

/**
 * The label, falling back to a de-snake-cased string rather than a blank pill:
 * an unknown status is a new status, and hiding it would be worse than showing
 * it raw.
 */
export function goalStatusLabel(status) {
  const key = String(status || '');
  return GOAL_STATUS_LABEL[key] || key.replace(/_/g, ' ') || '—';
}

/** Why a goal parked. The reason is recorded; this is how it reads. */
export const PARK_REASON_LABEL = {
  awaiting_approval: 'Waiting for your approval',
  budget_exhausted: 'Ran out of budget',
  blocked_on_evidence: 'Blocked — it needs evidence it does not have',
  error_backoff: 'Failed repeatedly, so it backed off',
  paused_by_user: 'You paused it',
  kill_switch: 'Stopped by a kill switch',
  scope_expired: 'Its authorization expired',
};

export function parkReasonLabel(reason) {
  if (!reason) return null;
  const key = String(reason);
  return PARK_REASON_LABEL[key] || key.replace(/_/g, ' ');
}

/**
 * Effect tiers in words. The tier letter stays visible in the technical
 * disclosure — an operator reading the logs needs the same token the code uses.
 */
export const TIER_LABEL = {
  T0: 'Observes only — nothing leaves the system',
  T1: 'Writes inside COGNOS — reversible',
  T2: 'Sends you a templated notice',
  T3: 'Reads one allowlisted page',
  T4: 'Writes outside COGNOS',
  T5: 'Irreversible — not built yet',
};

export function tierLabel(tier) {
  return TIER_LABEL[String(tier || '')] || String(tier || '—');
}

/** Staged-effect statuses, as the Outbox shows them. */
export const EFFECT_STATUS_LABEL = {
  staged: 'Waiting for your decision',
  would_release: 'Would have run — held in shadow',
  released: 'Ran',
  refused: 'Refused',
  reverted: 'Undone',
  failed: 'Failed',
};

export function effectStatusLabel(status) {
  const key = String(status || '');
  return EFFECT_STATUS_LABEL[key] || key.replace(/_/g, ' ') || '—';
}

/** "Every 15m" / "Once a day" — an interval a person can picture. */
export function humanInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 60_000) return `${Math.round(n / 1000)} seconds`;
  const minutes = Math.round(n / 60_000);
  if (minutes < 60) return minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'Every hour' : `Every ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'Once a day' : `Every ${days} days`;
}

/** The budget lines a person cares about, in words. */
export const BUDGET_LABEL = {
  maxSteps: 'Steps',
  maxModelCalls: 'Model calls',
  maxTokensIn: 'Tokens in',
  maxTokensOut: 'Tokens out',
  maxCostUsd: 'Spend',
  maxWallClockMs: 'Runs for at most',
  maxNoticesPerDay: 'Notices per day',
  maxExternalEffects: 'Outside effects (lifetime)',
  maxEffectsPerDay: 'Outside effects per day',
};

export function budgetLabel(key) {
  return BUDGET_LABEL[String(key || '')] || String(key || '').replace(/^max/, '').replace(/([A-Z])/g, ' $1').trim();
}

function effectNames(entry) {
  if (typeof entry === 'string') return [entry];
  if (!entry || typeof entry !== 'object') return [];
  return [entry.effect, entry.skill, entry.effectType, entry.skillId].filter(v => typeof v === 'string');
}

function hasEffect(effects, names) {
  const wanted = new Set(names);
  return (Array.isArray(effects) ? effects : []).some(entry => effectNames(entry).some(n => wanted.has(n)));
}

function writeDestinations(effects) {
  const out = [];
  for (const entry of Array.isArray(effects) ? effects : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const names = effectNames(entry);
    if (!names.includes('webhook.post') && !names.includes('external_write')) continue;
    for (const dest of Array.isArray(entry.destinations) ? entry.destinations : []) {
      if (typeof dest === 'string' && dest.trim()) out.push(dest.trim());
    }
  }
  return out;
}

function humanDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const days = Math.round(n / 86_400_000);
  if (days >= 1) return days === 1 ? 'one day' : `${days} days`;
  const hours = Math.round(n / 3_600_000);
  if (hours >= 1) return hours === 1 ? 'one hour' : `${hours} hours`;
  const minutes = Math.round(n / 60_000);
  if (minutes >= 1) return minutes === 1 ? 'one minute' : `${minutes} minutes`;
  return `${Math.round(n / 1000)} seconds`;
}

/**
 * What authorizing this scope means, in sentences. The JSON stays in
 * Technical details — hashes belong there too.
 */
export function describeScope(scope) {
  const s = scope && typeof scope === 'object' ? scope : {};
  const effects = s.effectsAllowed;
  const lines = [];
  if (hasEffect(effects, ['notify'])) {
    lines.push('It may send you templated notices — never free-written messages.');
  } else {
    lines.push('It will not send you notices.');
  }
  const urls = Array.isArray(s.urlAllowlist) ? s.urlAllowlist.filter(u => typeof u === 'string' && u.trim()) : [];
  if (hasEffect(effects, ['external_read']) && urls.length) {
    lines.push(`It may read only ${urls.length === 1 ? 'this page' : 'these pages'}: ${urls.join(', ')}.`);
  } else if (hasEffect(effects, ['external_read'])) {
    lines.push('It may read the web, but no page is allowlisted — so it can reach nothing.');
  } else {
    lines.push('It may not fetch any web page.');
  }
  const dest = writeDestinations(effects);
  if (hasEffect(effects, ['webhook.post', 'external_write']) && dest.length) {
    lines.push(`It may POST only to: ${dest.join(', ')}.`);
  } else if (hasEffect(effects, ['webhook.post', 'external_write'])) {
    lines.push('Outside writes are named, but no destination is granted — so it can post nowhere.');
  } else {
    lines.push('It may not write outside COGNOS.');
  }
  return lines;
}

/** How far the budget lets it go, in sentences. */
export function describeBudget(budget) {
  const b = budget && typeof budget === 'object' ? budget : {};
  const lines = [];
  if (b.maxSteps != null && Number.isFinite(Number(b.maxSteps))) {
    lines.push(`Up to ${Number(b.maxSteps).toLocaleString()} steps.`);
  }
  if (b.maxCostUsd != null && Number.isFinite(Number(b.maxCostUsd))) {
    lines.push(`Spend at most $${Number(b.maxCostUsd).toFixed(2)}.`);
  }
  if (b.maxNoticesPerDay != null && Number.isFinite(Number(b.maxNoticesPerDay))) {
    const n = Number(b.maxNoticesPerDay);
    lines.push(`At most ${n} notice${n === 1 ? '' : 's'} per day.`);
  }
  const lasts = humanDuration(b.maxWallClockMs);
  if (lasts) lines.push(`This authorization lasts ${lasts}.`);
  if (!lines.length) lines.push('The default budget ceilings apply.');
  return lines;
}

/**
 * The glossary behind the "?" button. One line each, in the order a new
 * operator meets them. `technical` carries the jargon the line replaces, so the
 * drawer teaches the vocabulary instead of hiding it.
 */
export const GLOSSARY = [
  {
    term: 'Resident',
    technical: 'autonomy_agents row',
    body: 'A named worker with a purpose, operating instructions, and its own list of skills. It wakes on a schedule, does a bounded slice of work, and writes down what it found.',
  },
  {
    term: 'Brief',
    technical: 'autonomy_agents.brief (versioned)',
    body: 'The operating text a resident was given. Changing it writes a NEW version and keeps the old one, so you can always see what it was told when it did the thing you are looking at.',
  },
  {
    term: 'Goal',
    technical: 'autonomy_goals row',
    body: 'One objective with a scope and a budget. A goal does no work at all until you authorize the exact scope and budget you are shown.',
  },
  {
    term: 'Authorization',
    technical: 'goal_authorizations row + scope hashes',
    body: 'Your consent, recorded against a hash of the scope and budget. Widening either is a new decision, never an edit — so "what did I approve?" stays answerable.',
  },
  {
    term: 'Skills',
    technical: 'the code-owned skill registry',
    body: 'The only things a resident can do. They live in code, not in a table: no brief, no draft and no database row can add one. A resident may use only the skills on its allowlist that this deployment can actually run.',
  },
  {
    term: 'Heartbeat and slice',
    technical: 'tick.intervalMs / tick.sliceMs',
    body: 'The heartbeat is how often the loop wakes. A slice is the bounded amount of work one wake-up may do, so no single goal can occupy the system.',
  },
  {
    term: 'Working note',
    technical: 'goal_notes row',
    body: 'What a goal wrote down: a finding, a question, a dead end. Notes are untrusted evidence — they are never shown as COGNOS speaking, and they become an answer only when you ask about one.',
  },
  {
    term: 'The outbox',
    technical: 'autonomy_outbox row',
    body: 'Every action that would touch something is staged here first and judged. Nothing in the outbox has happened yet; approving it is what makes it happen.',
  },
  {
    term: 'Staged effect',
    technical: 'status = staged',
    body: 'An action waiting on you: a notice to send, a page to fetch, a webhook to call. It carries the verdict of the judge that reviewed it.',
  },
  {
    term: 'Shadow mode',
    technical: 'COGNOS_AUTONOMY_OUTBOX_MODE=shadow, or autonomy_settings.outbox_mode',
    body: 'The loop decides everything and delivers nothing. It is how the system earns evidence that its judgements are sound before an outside effect is ever released.',
  },
  {
    term: 'Going live',
    technical: 'autonomy_settings.outbox_mode = live',
    body: 'A release verdict is performed instead of only recorded. It is a decision you make, not a mode you inherit: the flip is refused until a recorded shadow corpus still satisfies the gate, the rung is switched on, and the corpus was aimed at the destination you approved. Going back to shadow is never refused — a brake you have to earn is not a brake.',
  },
  {
    term: 'Approved destination',
    technical: 'COGNOS_AUTONOMY_LIVE_DESTINATION',
    body: 'The one endpoint this deployment may send to. A live outside write needs it AND the destination granted in the goal\'s own authorization, so both gates have to agree. Unset or malformed means nowhere: nothing is delivered, and the flip to live is refused.',
  },
  {
    term: 'Notice',
    technical: 'autonomy_notices row',
    body: 'How a background goal reports without composing an answer: a template id plus stored fields. A model cannot write free text into one.',
  },
  {
    term: 'Promotion',
    technical: 'note_promotions row',
    body: 'The only route from a working note to durable knowledge — a memory or a belief. It always needs your approval, and it lands as inferred, never as direct evidence.',
  },
  {
    term: 'Park',
    technical: 'status = parked + park_reason',
    body: 'A goal that stopped itself and said why: out of budget, blocked, failing repeatedly. Parking is the safe outcome of hitting any ceiling — nothing is silently queued.',
  },
  {
    term: 'Rung and tier',
    technical: 'rung flags / TIERS T0–T5',
    body: 'A tier is how far an action reaches: T0 observes, T1 writes inside COGNOS, T2 notifies you, T3 reads an allowlisted page, T4 writes outside, T5 would be irreversible and is not built. A rung is the deployment-level switch for a tier, and it needs recorded evidence before it is earned.',
  },
  {
    term: 'The switch',
    technical: 'COGNOS_AUTONOMY_ENABLED / COGNOS_AUTONOMY_UI_CONTROL',
    body: 'Autonomy is off by default. An operator can pin it on in the environment, or delegate the on/off switch to this UI. A pin always outranks the UI, and every flip is recorded.',
  },
];
