#!/usr/bin/env node
// Native-bridge origin regression test. Guards against the 2026-10-01
// incident where every native plugin (TTS, mic dictation, notifications)
// was silently dead on the app page: Capacitor injects window.androidBridge
// only on origins matching capacitor.config.ts's allowNavigation, and
// entries not starting with "http" are prefixed "https://" by Capacitor
// (Bridge.java setAllowedOriginRules). The embedded Node server serves the
// app page at http://127.0.0.1:<PORT>/ (PORT hardcoded in
// mobile/boot-index.html), whose origin matched the "https://127.0.0.1" rule
// not at all — so the bridge was never injected and
// Capacitor.isNativePlatform() was false on the app page.
//
// Contract: the served origin (scheme + host + port) must appear VERBATIM
// in allowNavigation. If the boot PORT ever changes, this test fails until
// the rule is updated alongside it.

import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; };

// --- the served origin --------------------------------------------------------
const bootHtml = read('mobile/boot-index.html');
const portMatch = bootHtml.match(/var PORT = (\d+);/);
ok('boot page pins the loopback PORT', () => {
  assert.ok(portMatch, 'mobile/boot-index.html must hardcode `var PORT = <n>;`');
});
const PORT = portMatch[1];
const servedOrigin = `http://127.0.0.1:${PORT}`;

// --- the rule -----------------------------------------------------------------
const config = read('capacitor.config.ts');
ok('capacitor.config.ts has an allowNavigation block', () => {
  assert.match(config, /allowNavigation\s*:\s*\[/, 'allowNavigation block is missing');
});

ok(`served origin ${servedOrigin} is allow-listed verbatim`, () => {
  // Only a verbatim http://host:port entry matches the served page's origin:
  // Capacitor prefixes "https://" to entries not starting with "http", so a
  // bare hostname can never cover a plain-HTTP loopback origin with a port.
  assert.ok(
    config.includes(`'${servedOrigin}'`) || config.includes(`"${servedOrigin}"`),
    `allowNavigation must contain '${servedOrigin}' verbatim — without it ` +
    'window.androidBridge is never injected and no native plugin works on the app page',
  );
});

ok('cleartext stays enabled for the loopback server', () => {
  assert.match(config, /cleartext\s*:\s*true/, 'cleartext must stay true for plain-HTTP loopback');
});

console.log(`CAPACITOR-ORIGIN RESULT: ${passed} passed, 0 failed`);
