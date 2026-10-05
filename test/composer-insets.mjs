#!/usr/bin/env node
// Chat-composer bottom-inset regression test (v57).
//
// Phone-verified 2026-10-04: in the resident chat drawer, the message input +
// send button sat underneath Android's 3-button system navigation bar — taps
// landed on the phone's back/home/recents buttons instead. The WebView draws
// edge-to-edge, so every bottom-anchored composer must pad for the system
// bottom inset or it ends up under the nav bar.
//
// Contract guarded here:
//  1. index.html keeps viewport-fit=cover — without it, env(safe-area-inset-*)
//     reports 0 and every inset below silently stops working.
//  2. Every bottom-anchored chat composer references env(safe-area-inset-bottom)
//     in its bottom padding:
//       - src/components/chat/ChatInput.jsx (main chat)
//       - src/components/autonomy/ResidentChatDrawer.jsx (per-resident chat)

import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

let passed = 0;
const ok = (name, fn) => { fn(); passed += 1; console.log('ok -', name); };

// --- viewport-fit=cover -------------------------------------------------------
const indexHtml = read('index.html');
ok('index.html keeps viewport-fit=cover', () => {
  assert.match(
    indexHtml,
    /viewport-fit=cover/,
    'index.html must keep viewport-fit=cover or env(safe-area-inset-*) reports 0'
  );
});

// --- bottom-anchored composers ------------------------------------------------
const composers = [
  'src/components/chat/ChatInput.jsx',
  'src/components/autonomy/ResidentChatDrawer.jsx',
];
for (const file of composers) {
  const src = read(file);
  ok(`${file} pads for the system bottom inset`, () => {
    assert.match(
      src,
      /env\(safe-area-inset-bottom/,
      `${file} must reference env(safe-area-inset-bottom) so its composer clears the Android nav bar`
    );
  });
}

console.log(`\n${passed} checks passed.`);
