#!/usr/bin/env node
// Regression test for the 2026-10-01 "no native plugins on the app page"
// incident. Capacitor 7's Bridge.java loadWebView() registers the
// document-start script (which injects window.Capacitor.PluginHeaders — the
// thing that makes every native plugin callable from JS) via
// WebViewCompat.addDocumentStartJavaScript() with ONLY the appUrl origin
// (https://localhost/). The COGNOS app page runs on the loopback origin
// http://127.0.0.1:<PORT>/ (PORT hardcoded in mobile/boot-index.html), so it
// never received the plugin JS: every plugin call failed silently while
// window.Capacitor and window.androidBridge still existed.
//
// Contract: .github/workflows/android.yml must contain a CI patch (applied to
// node_modules/@capacitor/android/.../Bridge.java after npm ci) that
// registers the document-start script for BOTH origins. The patch must:
//  - be guarded by a marker comment (idempotent),
//  - fail loudly if the Bridge.java target line moves (Capacitor upgrade),
//  - derive the loopback port from mobile/boot-index.html (single source).

import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; };

const workflow = read('.github/workflows/android.yml');
const MARKER = 'COGNOS-DOCUMENT-START-ORIGINS';
const TARGET = 'WebViewCompat.addDocumentStartJavaScript(webView, injector.getScriptString(), Collections.singleton(allowedOrigin));';

ok('workflow patches the document-start script origins', () => {
  assert.ok(workflow.includes(MARKER), `workflow must contain the ${MARKER} marker`);
  assert.ok(
    workflow.includes('addDocumentStartJavaScript'),
    'workflow must patch the addDocumentStartJavaScript call in Bridge.java',
  );
});

ok('patched call registers both the appUrl and loopback origins', () => {
  assert.ok(
    workflow.includes('documentStartOrigins') || workflow.includes('allowedOrigin, "http://127.0.0.1'),
    'workflow patch must build an origin set containing allowedOrigin and the loopback origin',
  );
  assert.ok(
    workflow.includes('127.0.0.1'),
    'workflow patch must reference the 127.0.0.1 loopback origin',
  );
});

ok('patch derives the loopback port from mobile/boot-index.html', () => {
  assert.ok(
    workflow.includes('mobile/boot-index.html') && workflow.includes('var PORT'),
    'workflow patch must read PORT from mobile/boot-index.html (single source of truth)',
  );
  const bootHtml = read('mobile/boot-index.html');
  assert.match(bootHtml, /var PORT = \d+;/, 'mobile/boot-index.html must hardcode `var PORT = <n>;`');
});

ok('patch fails loudly when the Bridge.java target line moves', () => {
  assert.ok(
    workflow.includes(TARGET),
    'workflow must assert the exact Bridge.java target line so a Capacitor upgrade cannot silently unfix this',
  );
});

ok('patch is idempotent via the marker guard', () => {
  const idx = workflow.indexOf(MARKER);
  assert.ok(idx !== -1);
  const step = workflow.slice(Math.max(0, idx - 2000), idx + 500);
  assert.ok(
    step.includes('already patched') || step.includes('grep -q "$MARKER"'),
    'workflow patch step must skip re-application when the marker is present',
  );
});

// Early signal if node_modules is present: the upstream target line must
// still exist, otherwise the CI patch step itself will fail loudly.
try {
  const bridge = read('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/Bridge.java');
  ok('upstream Bridge.java still contains the patch target line', () => {
    assert.ok(
      bridge.includes(TARGET),
      'Bridge.java target line moved — update the CI patch in android.yml',
    );
  });
} catch {
  // node_modules not installed (e.g. lint-only run) — CI runs tests after npm ci.
}

console.log(`CAPACITOR-DOCSTART RESULT: ${passed} passed, 0 failed`);
