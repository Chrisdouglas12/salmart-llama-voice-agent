'use strict';

/**
 * Keyless contract tests for the server-owned first-run welcome.
 *
 * The phone fetches these four spoken lines from POST /api/ai/onboarding and
 * reads them with its normal TTS pipeline. The copy lives on the server so a
 * model can write it, but the sanitizer must always return something safe and
 * speakable, even with no provider key and no model reply.
 *
 * Run: node --test tests/ai-onboarding.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const onboarding = require('../lib/assistant/onboarding');

const LINES = ['welcome', 'thanks', 'denied', 'allowHint'];

test('onboarding: an empty body still yields all four safe lines', () => {
  const lines = onboarding.sanitizeOnboarding(null);
  for (const key of LINES) {
    assert.equal(typeof lines[key], 'string', `${key} is present`);
    assert.ok(lines[key].length > 0, `${key} is not empty`);
    assert.ok(lines[key].length <= onboarding.MAX_WELCOME, `${key} is speakable`);
  }
  assert.match(lines.welcome, /Salmart/i);
  assert.match(lines.welcome, /microphone/i);
  assert.match(lines.denied, /type|allow/i);
  assert.match(lines.allowHint, /allow/i);
});

test('onboarding: every fallback line is a single clean sentence block', () => {
  for (const key of LINES) {
    const line = onboarding.ONBOARDING_FALLBACK[key];
    assert.doesNotMatch(line, /\s{2,}/, `${key} has no double spaces`);
    assert.doesNotMatch(line, /[*#`]/, `${key} has no markdown`);
    assert.equal(line, line.trim(), `${key} is trimmed`);
  }
});

test('onboarding: a partial model reply keeps server copy for missing keys', () => {
  const lines = onboarding.sanitizeOnboarding({ welcome: 'Hello and welcome to Salmart.' });
  assert.equal(lines.welcome, 'Hello and welcome to Salmart.');
  assert.equal(lines.thanks, onboarding.ONBOARDING_FALLBACK.thanks);
  assert.equal(lines.denied, onboarding.ONBOARDING_FALLBACK.denied);
  assert.equal(lines.allowHint, onboarding.ONBOARDING_FALLBACK.allowHint);
});

test('onboarding: whitespace and over-long text is normalised, never truncated mid-word', () => {
  const lines = onboarding.sanitizeOnboarding({
    welcome: '  Welcome\n\n  to   Salmart.  ',
    thanks: 'x'.repeat(onboarding.MAX_LINE + 50),
  });
  assert.equal(lines.welcome, 'Welcome to Salmart.');
  assert.ok(lines.thanks.length <= onboarding.MAX_LINE);
  assert.ok(lines.thanks.endsWith('…'));
});

test('onboarding: non-string and array input falls back instead of leaking', () => {
  const lines = onboarding.sanitizeOnboarding({ welcome: 42, thanks: ['a'], denied: null });
  assert.equal(lines.welcome, onboarding.ONBOARDING_FALLBACK.welcome);
  assert.equal(lines.thanks, onboarding.ONBOARDING_FALLBACK.thanks);
  assert.equal(lines.denied, onboarding.ONBOARDING_FALLBACK.denied);
});

test('onboarding: a JSON model reply is parsed into the four lines', () => {
  const reply = '{"welcome":"Welcome to Salmart. May I use your microphone?",'
    + '"thanks":"Tap the green mic any time.","denied":"You can type instead.",'
    + '"allowHint":"Tap Allow to begin."}';
  const lines = onboarding.parseOnboardingReply(reply);
  assert.equal(lines.welcome, 'Welcome to Salmart. May I use your microphone?');
  assert.equal(lines.thanks, 'Tap the green mic any time.');
  assert.equal(lines.denied, 'You can type instead.');
  assert.equal(lines.allowHint, 'Tap Allow to begin.');
});

test('onboarding: JSON wrapped in prose is still parsed', () => {
  const reply = 'Here you go:\n'
    + '{"welcome":"Welcome to Salmart, Nigeria\'s marketplace. May I use your microphone?"}'
    + '\nThanks!';
  const lines = onboarding.parseOnboardingReply(reply);
  assert.match(lines.welcome, /Salmart/);
  assert.equal(lines.thanks, onboarding.ONBOARDING_FALLBACK.thanks);
});

test('onboarding: a plain welcome is accepted and the rest falls back', () => {
  const lines = onboarding.parseOnboardingReply(
    'Welcome to Salmart. I can help you buy and sell with your voice. May I use your microphone?',
  );
  assert.match(lines.welcome, /May I use your microphone/);
  assert.equal(lines.allowHint, onboarding.ONBOARDING_FALLBACK.allowHint);
});

test('onboarding: a short or empty model reply is rejected so the caller uses fallback', () => {
  assert.equal(onboarding.parseOnboardingReply(''), null);
  assert.equal(onboarding.parseOnboardingReply('   '), null);
  assert.equal(onboarding.parseOnboardingReply('too short'), null);
});

test('onboarding: the system prompt asks for JSON only and the exact keys', () => {
  assert.match(onboarding.ONBOARDING_SYSTEM_PROMPT, /JSON only/i);
  for (const key of LINES) {
    assert.match(onboarding.ONBOARDING_SYSTEM_PROMPT, new RegExp(`"${key}"`));
  }
});
