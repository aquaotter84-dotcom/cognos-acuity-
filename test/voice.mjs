#!/usr/bin/env node
// Pure voice-layer regressions. Browser playback itself is feature-detected at
// runtime; these tests pin the text transformation and long-answer chunking.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chunkSpeechText, markdownToSpeechText } from '../src/lib/speechText.js';

const markdown = `# Result

Use **COGNOS** with [the guide](https://example.com/guide).

\`inline code\` is retained.

\`\`\`js
const secret = "not spoken";
\`\`\`

1. First point
2. Second point

See https://example.com/private for more.`;

const spoken = markdownToSpeechText(markdown);
assert.equal(spoken.includes('https://'), false);
assert.equal(spoken.includes('**'), false);
assert.equal(spoken.includes('const secret'), false);
assert.match(spoken, /Code block omitted from speech/);
assert.match(spoken, /COGNOS/);
assert.match(spoken, /the guide/);

const longText = Array.from({ length: 80 }, (_, index) => `Sentence ${index + 1} explains one useful detail.`).join(' ');
const chunks = chunkSpeechText(longText, 120);
assert.ok(chunks.length > 1);
assert.ok(chunks.every(chunk => chunk.length <= 120));
assert.equal(chunks.join(' '), longText);
assert.deepEqual(chunkSpeechText(''), []);

// The only automatic playback call site must consume the terminal governed
// response—not progress stages, token deltas, or the transient draft.
const chatSource = await readFile(new URL('../src/pages/Chat.jsx', import.meta.url), 'utf8');
assert.match(chatSource, /speakAutomatically\(data\.response,/);
assert.doesNotMatch(chatSource, /speakAutomatically\((?:data\.delta|draft|data\.message\.content)/);

console.log('VOICE RESULT: 12 passed, 0 failed');
