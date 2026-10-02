#!/usr/bin/env node
// Raw native TTS diagnostic tests. The JS wrapper (diagnoseTtsNative in
// src/lib/ttsNative.js) is exercised directly with a mocked updater plugin;
// the Java method and the Settings UI are pinned with source-shape
// assertions in the repo's existing style.

import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; };

const { diagnoseTtsNative } = await import('../src/lib/ttsNative.js');

const nativeFields = () => ({
  engineVisible: true,
  defaultEngine: 'com.google.android.tts',
  initStatus: 'SUCCESS',
  voiceCount: 8,
});
const mockLoader = (plugin) => async () => ({ plugin });

// --- diagnoseTtsNative ----------------------------------------------------------
ok('diagnoseTtsNative passes the native fields through verbatim', async () => {
  const r = await diagnoseTtsNative({
    loadUpdaterPlugin: mockLoader({ diagnoseTts: async () => nativeFields() }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.engineVisible, true);
  assert.equal(r.defaultEngine, 'com.google.android.tts');
  assert.equal(r.initStatus, 'SUCCESS');
  assert.equal(r.voiceCount, 8);
});
ok('diagnoseTtsNative keeps the error field when the engine bind failed natively', async () => {
  const r = await diagnoseTtsNative({
    loadUpdaterPlugin: mockLoader({
      diagnoseTts: async () => ({ engineVisible: false, initStatus: 'TIMEOUT', voiceCount: 0, error: 'bind timed out' }),
    }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.initStatus, 'TIMEOUT');
  assert.equal(r.voiceCount, 0);
  assert.equal(r.error, 'bind timed out');
});
ok('diagnoseTtsNative reports ok:false when the plugin is missing', async () => {
  const r = await diagnoseTtsNative({ loadUpdaterPlugin: mockLoader(null) });
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
});
ok('diagnoseTtsNative reports ok:false when diagnoseTts is not a function', async () => {
  const r = await diagnoseTtsNative({ loadUpdaterPlugin: mockLoader({}) });
  assert.equal(r.ok, false);
  assert.match(r.error, /not available/);
});
ok('diagnoseTtsNative never throws when the plugin call rejects', async () => {
  const r = await diagnoseTtsNative({
    loadUpdaterPlugin: mockLoader({ diagnoseTts: async () => { throw new Error('bridge exploded'); } }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bridge exploded');
});
ok('diagnoseTtsNative never throws when the loader itself rejects', async () => {
  const r = await diagnoseTtsNative({
    loadUpdaterPlugin: async () => { throw new Error('no bridge'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no bridge');
});
ok('diagnoseTtsNative tolerates a non-object plugin result', async () => {
  const r = await diagnoseTtsNative({
    loadUpdaterPlugin: mockLoader({ diagnoseTts: async () => null }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.engineVisible, undefined);
});

// --- native plugin: source shape ---------------------------------------------------
const pluginJava = read('plugins/cognos-updater/android/src/main/java/com/cognos/updater/CognosUpdaterPlugin.java');
ok('updater plugin exposes a diagnoseTts plugin method', () => {
  assert.match(pluginJava, /@PluginMethod/);
  assert.match(pluginJava, /public void diagnoseTts\(PluginCall call\)/);
});
ok('diagnoseTts reports engine visibility via getApplicationInfo', () => {
  assert.match(pluginJava, /engineVisible/);
  assert.match(pluginJava, /getApplicationInfo\(\s*"com\.google\.android\.tts", 0\s*\)/);
  assert.match(pluginJava, /NameNotFoundException/);
});
ok('diagnoseTts reads the system default engine', () => {
  assert.match(pluginJava, /defaultEngine/);
  assert.match(pluginJava, /TTS_DEFAULT_SYNTH/);
});
ok('diagnoseTts does a raw TextToSpeech bind with a bounded wait', () => {
  assert.match(pluginJava, /initStatus/);
  assert.match(pluginJava, /new TextToSpeech\(/);
  assert.match(pluginJava, /CountDownLatch/);
  assert.match(pluginJava, /await\(5, TimeUnit\.SECONDS\)/);
  assert.match(pluginJava, /"TIMEOUT"/);
  assert.match(pluginJava, /shutdown\(\)/);
});
ok('diagnoseTts reports the raw voice count', () => {
  assert.match(pluginJava, /voiceCount/);
  assert.match(pluginJava, /getVoices\(\)/);
});
ok('diagnoseTts never rejects on diagnostic failure', () => {
  // Every resolve path is guarded; the method documents the contract.
  assert.match(pluginJava, /NEVER\s*\*\s*rejected on diagnostic failure/);
  const body = pluginJava.slice(pluginJava.indexOf('public void diagnoseTts'));
  assert.ok(!/call\.reject\(/.test(body), 'diagnoseTts must not call reject');
});

// --- Settings UI: source shape -------------------------------------------------------
const settingsSource = read('src/pages/Settings.jsx');
ok('Settings imports the diagnostic wrapper', () => {
  assert.match(settingsSource, /import \{ diagnoseTtsNative \} from '@\/lib\/ttsNative'/);
});
ok('Settings has a Run TTS diagnostic button', () => {
  assert.match(settingsSource, /Run TTS diagnostic/);
  assert.match(settingsSource, /handleTtsDiagnostic/);
});
ok('Settings renders the diagnostic result verbatim in mono text', () => {
  assert.match(settingsSource, /JSON\.stringify\(ttsDiag, null, 2\)/);
  assert.match(settingsSource, /font-mono/);
});

// --- wiring ----------------------------------------------------------------------------
const pkg = JSON.parse(read('package.json'));
ok('package.json test script runs the diagnostic tests', () => {
  assert.match(pkg.scripts.test, /node test\/tts-diagnose\.mjs/);
});

console.log(`TTS-DIAGNOSE RESULT: ${passed} passed, 0 failed`);
