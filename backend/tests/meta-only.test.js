'use strict';

/**
 * Hackathon compliance guard: the extract must run on Meta models only.
 * Mirrors the live repo's tests/meta-only.test.js over the files this
 * extract actually carries (pre-existing route files enter only as patch
 * context lines, so they are checked by review, not here).
 *
 * Run: node --test tests/meta-only.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function src(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

const FILES = [
  'lib/assistant/llama.js',
  'lib/assistant/config.js',
  'lib/assistant/speechLang.js',
  'lib/assistant/mmsTts.js',
  'lib/assistant/glimmer.js',
  'lib/assistant/authGuidance.js',
  'services/ai/agentRunner.js',
  'services/ai/metaProvider.js',
  'services/ai/toolRegistry.js',
  'services/ai/toolExecutor.js',
  'routes/aiRoutes.js',
  'scripts/ai-eval.js',
];

const BANNED = [
  'groq-sdk',
  '@google/genai',
  'GoogleGenAI',
  'new Groq(',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_MODELS',
  'GROQ_MODELS',
  'runGroqAgent',
  'runGeminiAgent',
  'geminiTTS',
  'groqVision',
  'geminiVision',
  'geminiBatch',
  'groqBatch',
];

test('meta-only: no third-party provider reference in extract source', () => {
  const hits = [];
  for (const f of FILES) {
    const text = src(f);
    for (const token of BANNED) {
      if (text.includes(token)) hits.push(`${f}: ${token}`);
    }
  }
  assert.deepEqual(hits, [], `non-Meta provider references found:\n${hits.join('\n')}`);
});

test('meta-only: extract manifest has no third-party provider SDK', () => {
  const pkg = JSON.parse(src('package.json'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const banned of ['groq-sdk', '@google/genai']) {
    assert.ok(!(banned in deps), `${banned} must not be a dependency`);
  }
});
