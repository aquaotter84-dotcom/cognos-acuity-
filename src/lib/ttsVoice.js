/** Phase 33 — TTS voice resolution (pure logic, no DOM, no plugins).
 *
 * A "device voice" is the normalized shape both engines share:
 *   { voiceURI, name, lang, localService, default }
 * The array order is the plugin's voice order — resolveTtsVoice returns the
 * index the native plugin expects (its `voice` option is an index, -1 means
 * the engine default).
 *
 * Persona tie-in: persona.voice may carry { voiceURI, lang, rate, pitch }.
 * The persona's voice identity wins over the global voice setting when the
 * device actually has that voice; rate/pitch fall back to the global sliders.
 */

export const TTS_DEFAULT_LANG = 'en-US';
export const TTS_RATE_RANGE = Object.freeze([0.6, 1.6]);
export const TTS_PITCH_RANGE = Object.freeze([0.7, 1.3]);

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** Normalize a raw plugin voice list into device voices, preserving order. */
export function mapNativeVoices(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v) => v && typeof v === 'object')
    .map((v) => ({
      voiceURI: typeof v.voiceURI === 'string' && v.voiceURI ? v.voiceURI : String(v.name || ''),
      name: typeof v.name === 'string' && v.name ? v.name : String(v.voiceURI || 'Voice'),
      lang: typeof v.lang === 'string' && v.lang ? v.lang : TTS_DEFAULT_LANG,
      localService: v.localService !== false,
      default: v.default === true,
    }));
}

/** Keep only the TTS fields a persona is allowed to store, validated. */
export function normalizePersonaTtsVoice(voice) {
  if (voice == null || typeof voice !== 'object' || Array.isArray(voice)) return {};
  const out = {};
  if (typeof voice.voiceURI === 'string' && voice.voiceURI.trim()) {
    out.voiceURI = voice.voiceURI.trim().slice(0, 120);
  }
  if (typeof voice.lang === 'string' && voice.lang.trim()) {
    out.lang = voice.lang.trim().slice(0, 20);
  }
  const rate = Number(voice.rate);
  if (voice.rate != null && Number.isFinite(rate)) {
    out.rate = Math.min(4, Math.max(0.25, rate));
  }
  const pitch = Number(voice.pitch);
  if (voice.pitch != null && Number.isFinite(pitch)) {
    out.pitch = Math.min(4, Math.max(0.25, pitch));
  }
  return out;
}

/**
 * Resolve which device voice (by index) and which speech parameters to use.
 *
 * @param {object} args
 * @param {object} args.personaVoice  normalized persona.voice (may be {})
 * @param {object} args.settings     global voice settings { voiceURI, rate, pitch, volume }
 * @param {Array}  args.voices       device voices in plugin order
 * @returns {{ voiceIndex, voiceURI, lang, rate, pitch, volume, matched }}
 */
export function resolveTtsVoice({ personaVoice = {}, settings = {}, voices = [] } = {}) {
  const persona = normalizePersonaTtsVoice(personaVoice);
  const list = Array.isArray(voices) ? voices : [];

  const wantedURI = persona.voiceURI || (typeof settings.voiceURI === 'string' ? settings.voiceURI : '');
  let voiceIndex = -1;
  let matchedVoice = null;
  if (wantedURI) {
    const idx = list.findIndex((v) => v && v.voiceURI === wantedURI);
    if (idx >= 0) {
      voiceIndex = idx;
      matchedVoice = list[idx];
    }
  }

  return {
    voiceIndex,
    voiceURI: matchedVoice ? matchedVoice.voiceURI : '',
    lang: persona.lang || (matchedVoice ? matchedVoice.lang : TTS_DEFAULT_LANG),
    rate: clampNumber(persona.rate ?? settings.rate, TTS_RATE_RANGE[0], TTS_RATE_RANGE[1], 1),
    pitch: clampNumber(persona.pitch ?? settings.pitch, TTS_PITCH_RANGE[0], TTS_PITCH_RANGE[1], 1),
    volume: clampNumber(settings.volume, 0, 1, 1),
    matched: voiceIndex >= 0,
  };
}
