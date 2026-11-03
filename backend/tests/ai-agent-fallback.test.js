'use strict';

/**
 * Keyless contract tests for the agent's empty-final fallback.
 *
 * A model can spend its turn calling a tool and return no final text. Speaking
 * a generic "please rephrase" makes the assistant look deaf, so the runner
 * speaks the last meaningful line from this turn's tool results instead. The
 * field order is the contract: a card line before a model-facing note.
 *
 * Run: node --test tests/ai-agent-fallback.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { spokenFallback } = require('../services/ai/spokenFallback');

function result(data, ok = true) {
  return { name: 'tool', ok, data };
}

test('agent fallback: a card `say` wins over a model-facing note', () => {
  const line = spokenFallback([
    result({ say: 'Tap the microphone and say register me.', note: 'long model note' }),
  ]);
  assert.equal(line, 'Tap the microphone and say register me.');
});

test('agent fallback: `nextAsk` is spoken when there is no card line', () => {
  assert.equal(
    spokenFallback([result({ nextAsk: 'What is your full name, first and last?' })]),
    'What is your full name, first and last?',
  );
});

test('agent fallback: `note`, `message`, `reply` and `text` are the remaining lines', () => {
  assert.equal(spokenFallback([result({ note: 'Saved your phone number.' })]), 'Saved your phone number.');
  assert.equal(spokenFallback([result({ message: 'Your cart is empty.' })]), 'Your cart is empty.');
  assert.equal(spokenFallback([result({ reply: 'Here are the listings.' })]), 'Here are the listings.');
  assert.equal(spokenFallback([result({ text: 'I opened the market.' })]), 'I opened the market.');
});

test('agent fallback: field order beats key order inside one result', () => {
  const line = spokenFallback([
    result({ message: 'plain message', nextAsk: 'the next question', say: 'the card line' }),
  ]);
  assert.equal(line, 'the card line');
});

test('agent fallback: the newest result is read first', () => {
  const line = spokenFallback([
    result({ say: 'older line' }),
    result({ say: 'newer line' }),
  ]);
  assert.equal(line, 'newer line');
});

test('agent fallback: failed, empty and non-object results are skipped', () => {
  assert.equal(spokenFallback([]), '');
  assert.equal(spokenFallback(null), '');
  assert.equal(spokenFallback([result({ say: 'ignored line' }, false)]), '');
  assert.equal(spokenFallback([result(null)]), '');
  assert.equal(spokenFallback([result({})]), '');
  assert.equal(spokenFallback([result({ say: '' })]), '');
  assert.equal(spokenFallback([result({ say: 'ok', nextAsk: 'fall through' })]), 'fall through');
});

test('agent fallback: a too-short value is not spoken as a sentence', () => {
  assert.equal(spokenFallback([result({ say: '...' })]), '');
  assert.equal(spokenFallback([result({ say: ' . ' })]), '');
});

test('agent fallback: whitespace is collapsed before speaking', () => {
  assert.equal(
    spokenFallback([result({ say: '  Hello\n\n there,   friend.  ' })]),
    'Hello there, friend.',
  );
});

test('agent fallback: a non-string value in a higher-priority field is skipped', () => {
  const line = spokenFallback([
    result({ say: 42, nextAsk: 'the real line' }),
  ]);
  assert.equal(line, 'the real line');
});
