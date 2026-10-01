/** Phase 33 — on-device TTS adapter.
 *
 * Wraps the Capacitor TextToSpeech plugin (Android's native TextToSpeech —
 * no keys, no network, works offline). The plugin instance is injected so
 * node tests can pass a mock; the real one is loaded lazily and only on
 * native platforms.
 *
 * Plugin contract (verified against the plugin's Android source):
 * - speak() resolves when the utterance FINISHES, rejects on engine error.
 * - `voice` is an index into getSupportedVoices() order; -1 = engine default.
 * - queueStrategy 0 = flush in-flight, 1 = queue behind in-flight.
 * - stop() clears the queue; in-flight speak() promises may then never
 *   settle, so callers must never await the chunk loop from stop().
 */

export const QueueStrategy = Object.freeze({ FLUSH: 0, ADD: 1 });

/**
 * Lazily loads the plugin. Resolves to `{ plugin }` (never the proxy itself):
 * awaiting a Capacitor plugin proxy throws, because the proxy wraps every
 * property — including `then` — in a method wrapper. The wrapper object is a
 * plain value, so `const { plugin } = await loadNativePlugin()` is safe.
 */
export function loadNativePlugin() {
  return import('@capacitor-community/text-to-speech').then(
    (mod) => ({ plugin: mod && mod.TextToSpeech ? mod.TextToSpeech : null }),
    () => ({ plugin: null }),
  );
}

export function createNativeTts(plugin) {
  if (!plugin || typeof plugin.speak !== 'function') {
    throw new Error('A TextToSpeech plugin instance is required');
  }

  return {
    /** Raw voice list from the engine, in plugin order. */
    async getVoices() {
      try {
        const result = await plugin.getSupportedVoices();
        return Array.isArray(result && result.voices) ? result.voices : [];
      } catch {
        return [];
      }
    },

    /**
     * Speak chunks in order. The first chunk flushes anything in flight;
     * the rest queue behind it. Resolves true when the last chunk
     * completes, false when aborted via shouldContinue (stop was called).
     */
    async speakChunks(chunks, options = {}) {
      const { lang, rate, pitch, volume, voiceIndex, shouldContinue } = options;
      const list = Array.isArray(chunks) ? chunks.filter((c) => c && String(c).trim()) : [];
      if (!list.length) return false;
      let first = true;
      for (const chunk of list) {
        if (typeof shouldContinue === 'function' && !shouldContinue()) return false;
        await plugin.speak({
          text: String(chunk),
          lang: lang || 'en-US',
          rate: rate ?? 1,
          pitch: pitch ?? 1,
          volume: volume ?? 1,
          voice: typeof voiceIndex === 'number' ? voiceIndex : -1,
          queueStrategy: first ? QueueStrategy.FLUSH : QueueStrategy.ADD,
        });
        first = false;
      }
      return true;
    },

    /** Fire-and-forget: never await the chunk loop from here. */
    stop() {
      try {
        const r = plugin.stop();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {
        /* engine already gone */
      }
    },

    /** Android only: opens the system voice-data installer. */
    async openInstall() {
      if (typeof plugin.openInstall !== 'function') return false;
      try {
        await plugin.openInstall();
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Probe the native TTS engine. Pure decision logic over injected dependencies
 * so node tests can exercise every branch without a device.
 *
 * @param {object} deps
 * @param {() => boolean} deps.isNativePlatform  e.g. () => Capacitor.isNativePlatform()
 * @param {() => Promise<{ plugin }>} deps.loadPlugin  e.g. loadNativePlugin
 * @returns {Promise<{ ok: boolean, plugin: object|null, tts: object|null, rawVoices: Array,
 *                     detail: { isNative: boolean, pluginLoaded: boolean, voices: number, error: string } }>}
 *
 * ok === true means the native engine is usable. Zero voices is still ok —
 * the phone may simply have no voice data installed; the UI keeps
 * engine='native' and offers the system voice-data installer instead of
 * declaring TTS unavailable.
 */
export async function probeNativeTts({ isNativePlatform, loadPlugin } = {}) {
  const detail = { isNative: false, pluginLoaded: false, voices: 0, error: '' };
  try {
    const isNative = typeof isNativePlatform === 'function' ? isNativePlatform() : false;
    detail.isNative = isNative === true;
    if (!detail.isNative) return { ok: false, plugin: null, tts: null, rawVoices: [], detail };
    const { plugin } = await loadPlugin();
    detail.pluginLoaded = !!plugin;
    if (!plugin) return { ok: false, plugin: null, tts: null, rawVoices: [], detail };
    const tts = createNativeTts(plugin); // throws when the plugin shape is wrong
    const rawVoices = await tts.getVoices(); // never throws; [] on engine error
    detail.voices = rawVoices.length;
    return { ok: true, plugin, tts, rawVoices, detail };
  } catch (e) {
    detail.error = String((e && e.message) || e || '').slice(0, 160);
    return { ok: false, plugin: null, tts: null, rawVoices: [], detail };
  }
}
