'use strict';

/**
 * Hackathon compliance guard: the voice/assistant surface must run on Meta
 * models only. No third-party provider SDK may be imported, instantiated, or
 * referenced by the shipped code — a silent non-Meta fallback would violate
 * the event rules and hide outages like the Oct 29 Render 404s.
 *
 * This test reads source text; it needs no keys, no network, no Mongo.
 * Run: node --test tests/meta-only.test.js
 *
 * NOTE: the extract keeps its own adapted copy of this file (it checks only
 * the files the extract carries). Never sync this file into the extract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function src(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

// Every file that ships event voice/assistant behavior, plus the shared clients.
const FILES = [
  'routes/assistantRoutes.js',
  'routes/assistantGallery.js',
  'lib/assistant/llama.js',
  'lib/assistant/config.js',
  'lib/assistant/speechLang.js',
  'lib/assistant/mmsTts.js',
  'lib/assistant/glimmer.js',
  'services/ai/agentRunner.js',
  'services/ai/metaProvider.js',
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

test('meta-only: no third-party provider reference in shipped source', () => {
  const hits = [];
  for (const f of FILES) {
    const text = src(f);
    for (const token of BANNED) {
      if (text.includes(token)) hits.push(`${f}: ${token}`);
    }
  }
  assert.deepEqual(hits, [], `non-Meta provider references found:\n${hits.join('\n')}`);
});

test('meta-only: live package.json has no third-party provider SDK', () => {
  const pkg = JSON.parse(src('package.json'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const banned of ['groq-sdk', '@google/genai']) {
    assert.ok(!(banned in deps), `${banned} must not be a dependency`);
  }
});
