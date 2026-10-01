#!/usr/bin/env node
// Phase 33 — on-device TTS regressions. Native playback itself is
// feature-detected at runtime; these tests pin voice resolution, the plugin
// adapter contract, persona voice validation, and the client wiring.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  mapNativeVoices,
  normalizePersonaTtsVoice,
  resolveTtsVoice,
  TTS_DEFAULT_LANG,
} from '../src/lib/ttsVoice.js';
import { createNativeTts, loadNativePlugin, QueueStrategy } from '../src/lib/ttsNative.js';
import { validatePersonaInput } from '../server/personas.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; };

// --- mapNativeVoices ---------------------------------------------------------
ok('mapNativeVoices normalizes and preserves plugin order', () => {
  const raw = [
    { voiceURI: 'b', name: 'English United States', lang: 'en-US', localService: true, default: false },
    { voiceURI: 'a', name: 'English United Kingdom', lang: 'en-GB', localService: true, default: true },
    null,
    'junk',
  ];
  const voices = mapNativeVoices(raw);
  assert.equal(voices.length, 2);
  assert.equal(voices[0].voiceURI, 'b');
  assert.equal(voices[1].default, true);
  assert.equal(voices[1].lang, 'en-GB');
});
ok('mapNativeVoices tolerates missing fields and non-arrays', () => {
  assert.deepEqual(mapNativeVoices(null), []);
  assert.deepEqual(mapNativeVoices('x'), []);
  const [v] = mapNativeVoices([{}]);
  assert.equal(v.lang, TTS_DEFAULT_LANG);
  assert.equal(v.localService, true);
});

// --- normalizePersonaTtsVoice --------------------------------------------------
ok('normalizePersonaTtsVoice keeps valid TTS fields, drops junk', () => {
  const out = normalizePersonaTtsVoice({ voiceURI: '  b  ', lang: 'en-US', rate: 1.2, pitch: 0.9, evil: 1 });
  assert.deepEqual(out, { voiceURI: 'b', lang: 'en-US', rate: 1.2, pitch: 0.9 });
  assert.deepEqual(normalizePersonaTtsVoice(null), {});
  assert.deepEqual(normalizePersonaTtsVoice('x'), {});
  assert.deepEqual(normalizePersonaTtsVoice([]), {});
});
ok('normalizePersonaTtsVoice clamps rate/pitch and ignores non-numeric', () => {
  assert.equal(normalizePersonaTtsVoice({ rate: 99 }).rate, 4);
  assert.equal(normalizePersonaTtsVoice({ pitch: 0 }).pitch, 0.25);
  assert.deepEqual(normalizePersonaTtsVoice({ rate: 'fast' }), {});
});

// --- resolveTtsVoice -----------------------------------------------------------
const VOICES = [
  { voiceURI: 'voice-a', name: 'English United States', lang: 'en-US', localService: true, default: false },
  { voiceURI: 'voice-b', name: 'English United Kingdom', lang: 'en-GB', localService: true, default: true },
];

ok('resolveTtsVoice prefers the persona voiceURI when the device has it', () => {
  const r = resolveTtsVoice({
    personaVoice: { voiceURI: 'voice-b' },
    settings: { voiceURI: 'voice-a', rate: 1, pitch: 1, volume: 1 },
    voices: VOICES,
  });
  assert.equal(r.voiceIndex, 1);
  assert.equal(r.matched, true);
  assert.equal(r.lang, 'en-GB');
});

ok('resolveTtsVoice falls back to the global voice setting', () => {
  const r = resolveTtsVoice({
    personaVoice: {},
    settings: { voiceURI: 'voice-a', rate: 1.1, pitch: 0.9, volume: 0.5 },
    voices: VOICES,
  });
  assert.equal(r.voiceIndex, 0);
  assert.equal(r.rate, 1.1);
  assert.equal(r.pitch, 0.9);
  assert.equal(r.volume, 0.5);
});

ok('resolveTtsVoice yields the engine default when nothing matches', () => {
  const r = resolveTtsVoice({
    personaVoice: { voiceURI: 'missing' },
    settings: { voiceURI: '', rate: 1, pitch: 1, volume: 1 },
    voices: VOICES,
  });
  assert.equal(r.voiceIndex, -1);
  assert.equal(r.matched, false);
  assert.equal(r.lang, TTS_DEFAULT_LANG);
});

ok('resolveTtsVoice lets the persona override lang/rate/pitch', () => {
  const r = resolveTtsVoice({
    personaVoice: { lang: 'en-AU', rate: 9, pitch: -3 },
    settings: { voiceURI: '', rate: 1, pitch: 1, volume: 1 },
    voices: VOICES,
  });
  assert.equal(r.lang, 'en-AU');
  assert.equal(r.rate, 1.6);
  assert.equal(r.pitch, 0.7);
});

// --- createNativeTts (mock plugin) ---------------------------------------------
function mockPlugin() {
  const calls = [];
  return {
    calls,
    async speak(opts) { calls.push({ method: 'speak', opts }); },
    async stop() { calls.push({ method: 'stop' }); },
    async getSupportedVoices() { return { voices: [{ voiceURI: 'v1' }] }; },
    async openInstall() { calls.push({ method: 'openInstall' }); },
  };
}

ok('speakChunks speaks in order: first flushes, the rest queue', async () => {
  const plugin = mockPlugin();
  const tts = createNativeTts(plugin);
  const done = await tts.speakChunks(['one', 'two', 'three'], {
    lang: 'en-US', rate: 1, pitch: 1, volume: 1, voiceIndex: 2,
  });
  assert.equal(done, true);
  const speaks = plugin.calls.filter((c) => c.method === 'speak');
  assert.deepEqual(speaks.map((c) => c.opts.text), ['one', 'two', 'three']);
  assert.deepEqual(
    speaks.map((c) => c.opts.queueStrategy),
    [QueueStrategy.FLUSH, QueueStrategy.ADD, QueueStrategy.ADD]
  );
  assert.equal(speaks[0].opts.voice, 2);
});

ok('speakChunks skips blanks, returns false when aborted or empty', async () => {
  const plugin = mockPlugin();
  const tts = createNativeTts(plugin);
  assert.equal(await tts.speakChunks([], {}), false);
  assert.equal(await tts.speakChunks(['  '], {}), false);
  const aborted = await tts.speakChunks(['one', 'two'], { shouldContinue: () => false });
  assert.equal(aborted, false);
  assert.equal(plugin.calls.filter((c) => c.method === 'speak').length, 0);
});

ok('stop and getVoices degrade gracefully', async () => {
  const plugin = mockPlugin();
  const tts = createNativeTts(plugin);
  tts.stop(); // fire-and-forget by contract
  assert.equal(plugin.calls[0].method, 'stop');
  assert.deepEqual(await tts.getVoices(), [{ voiceURI: 'v1' }]);
  const failing = createNativeTts({ ...plugin, getSupportedVoices: async () => { throw new Error('x'); } });
  assert.deepEqual(await failing.getVoices(), []);
});

ok('createNativeTts requires a plugin with speak', () => {
  assert.throws(() => createNativeTts(null), /plugin/i);
  assert.throws(() => createNativeTts({}), /plugin/i);
});

ok('loadNativePlugin resolves { plugin } without awaiting the proxy', async () => {
  // The plugin's web fallback touches `window` at registration; stub the
  // global so the module can load in node. The browser needs no stub.
  // The proxy itself must never be awaited (Capacitor wraps `then` in a
  // method wrapper that throws), so the loader wraps it in a plain object.
  // Method calls are exercised through createNativeTts with a mock above.
  if (typeof globalThis.window === 'undefined') globalThis.window = {};
  const result = await loadNativePlugin();
  assert.ok(result && typeof result === 'object');
  assert.ok('plugin' in result);
});

// --- server persona voice validation -------------------------------------------
ok('validatePersonaInput accepts a valid TTS voice object', () => {
  const problems = validatePersonaInput({
    name: 'Night Owl',
    voice: { voiceURI: 'voice-a', lang: 'en-US', rate: 1.1, pitch: 0.9 },
  });
  assert.deepEqual(problems, []);
});

ok('validatePersonaInput flags bad TTS voice fields', () => {
  const problems = validatePersonaInput({
    name: 'Night Owl',
    voice: { voiceURI: 42, lang: 'x'.repeat(21), rate: 99, pitch: 'high' },
  });
  assert.ok(problems.some((p) => p.includes('voice.voiceURI')));
  assert.ok(problems.some((p) => p.includes('voice.lang')));
  assert.ok(problems.some((p) => p.includes('voice.rate')));
  assert.ok(problems.some((p) => p.includes('voice.pitch')));
});

// --- client wiring contracts -----------------------------------------------------
const ctxSource = await readFile(new URL('../src/lib/voiceContext.jsx', import.meta.url), 'utf8');
ok('voiceContext exposes the native engine surface', () => {
  assert.match(ctxSource, /engine,\s*\/\/ 'native' \| 'browser' \| null/);
  assert.match(ctxSource, /setActivePersona/);
  assert.match(ctxSource, /openInstallVoiceData/);
  assert.match(ctxSource, /resolveTtsVoice\(/);
  // The mount probe runs through the testable probeNativeTts helper, with the
  // plugin loader injected (retried — the native bridge may lag app mount).
  assert.match(ctxSource, /probeNativeTts\(/);
  assert.match(ctxSource, /loadPlugin: loadNativePlugin/);
});

const inputSource = await readFile(new URL('../src/components/chat/ChatInput.jsx', import.meta.url), 'utf8');
ok('dictation start silences in-flight speech (audio focus)', () => {
  assert.match(inputSource, /stopSpeaking\(\);/);
  assert.match(inputSource, /startDictation/);
});

const chatSource = await readFile(new URL('../src/pages/Chat.jsx', import.meta.url), 'utf8');
ok('chat pushes the active persona into the voice context', () => {
  assert.match(chatSource, /setVoicePersona\(/);
});

const settingsSource = await readFile(new URL('../src/pages/Settings.jsx', import.meta.url), 'utf8');
ok('settings offers voice-data install and per-persona spoken voices', () => {
  assert.match(settingsSource, /Install voice data/);
  assert.match(settingsSource, /Spoken voice/);
  assert.match(settingsSource, /Device voice/);
});

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
ok('package.json carries the on-device TTS plugin', () => {
  assert.ok(pkg.dependencies['@capacitor-community/text-to-speech']);
});


// --- probeNativeTts -------------------------------------------------------------
// Pure probe logic (src/lib/ttsNative.js): every branch the voice context's
// mount effect depends on, including the empty-voices contract (plugin loads
// but the phone has no voice data → still ok, UI offers the installer).
import { probeNativeTts } from '../src/lib/ttsNative.js';

const fakePlugin = (voices) => ({
  speak: async () => {},
  stop: async () => {},
  // Real plugin resolves { voices: [...] } — the adapter unwraps it.
  getSupportedVoices: async () => ({ voices }),
});

{
  const r = await probeNativeTts({
    isNativePlatform: () => true,
    loadPlugin: async () => ({ plugin: fakePlugin([{ voiceURI: 'v1', name: 'V1', lang: 'en-US' }]) }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.detail.isNative, true);
  assert.equal(r.detail.pluginLoaded, true);
  assert.equal(r.detail.voices, 1);
  assert.equal(r.detail.error, '');
  passed += 1;
}
{
  // Empty voices: engine still usable — installer banner, not "unavailable".
  const r = await probeNativeTts({
    isNativePlatform: () => true,
    loadPlugin: async () => ({ plugin: fakePlugin([]) }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.detail.voices, 0);
  assert.equal(r.rawVoices.length, 0);
  passed += 1;
}
{
  // Engine error inside getVoices is swallowed by the adapter → [] → ok.
  const r = await probeNativeTts({
    isNativePlatform: () => true,
    loadPlugin: async () => ({ plugin: { speak: async () => {}, getSupportedVoices: async () => { throw new Error('no engine'); } } }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.detail.voices, 0);
  passed += 1;
}
{
  // Dynamic import failed (chunk missing at runtime) → not ok, no throw.
  let called = false;
  const r = await probeNativeTts({
    isNativePlatform: () => true,
    loadPlugin: async () => { called = true; throw new Error('chunk 404'); },
  });
  assert.equal(called, true);
  assert.equal(r.ok, false);
  assert.equal(r.detail.isNative, true);
  assert.equal(r.detail.pluginLoaded, false);
  assert.match(r.detail.error, /chunk 404/);
  passed += 1;
}
{
  // Plugin with the wrong shape → createNativeTts throws → not ok, error kept.
  const r = await probeNativeTts({
    isNativePlatform: () => true,
    loadPlugin: async () => ({ plugin: {} }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.detail.pluginLoaded, true);
  assert.ok(r.detail.error.length > 0);
  passed += 1;
}
{
  // Not a native platform → probe skips the plugin entirely.
  let called = false;
  const r = await probeNativeTts({
    isNativePlatform: () => false,
    loadPlugin: async () => { called = true; return { plugin: null }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.detail.isNative, false);
  assert.equal(called, false);
  passed += 1;
}

// --- settings diagnostic wiring ------------------------------------------------
const voiceSource = await readFile(new URL('../src/lib/voiceContext.jsx', import.meta.url), 'utf8');
ok('settings voice section shows the probe diagnostic and the no-voice-data banner', () => {
  assert.match(settingsSource, /probe: native/);
  assert.match(settingsSource, /voice\.probe/);
  assert.match(settingsSource, /No voice data on this device yet/);
});
ok('voice context retries the native probe and exposes the diagnostics', () => {
  assert.match(voiceSource, /probeNativeTts/);
  assert.match(voiceSource, /PROBE_ATTEMPTS/);
  assert.match(voiceSource, /probe,/);
});

console.log(`TTS RESULT: ${passed} passed, 0 failed`);
