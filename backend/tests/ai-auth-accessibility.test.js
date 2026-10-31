'use strict';

/* Covers the 15 auth accessibility scenarios at the state-machine level.
 * No network, no models, no secrets — run: node --test tests/ai-auth-accessibility.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const intents = require('../lib/assistant/authIntents');
const guard = require('../lib/assistant/credentialGuard');
const { explainAuthError } = require('../lib/assistant/authGuidance');

function plan(intent, extra = {}) {
  return intents.planAuthHelp({ intent, prior: null, ...extra });
}

test('vague account problem asks one clarifying question, never resets', () => {
  for (const words of ["I can't enter my account.", 'I am locked out.']) {
    assert.equal(intents.classifyAuthIntent(words), 'ACCOUNT_ACCESS');
  }
  const p = plan('ACCOUNT_ACCESS');
  assert.equal(p.state, 'ASKING_CLARIFICATION');
  assert.equal(p.nextScreen, null);
  assert.ok((p.say.match(/\?/g) || []).length <= 1, 'one question at most');
  assert.ok(p.say.length <= intents.MAX_SAY);
});

test('all 15 scenario utterances classify to a safe intent', () => {
  const cases = [
    ['I want to join Salmart.', 'REGISTER'],
    ['I already have an account.', 'SIGN_IN'],
    ["My password isn't working.", 'RESET_PASSWORD'],
    ['I forgot my password.', 'RESET_PASSWORD'],
    ['I forgot the email I used.', 'RECOVER_ACCOUNT_IDENTIFIER'],
    ['I have two Gmail accounts. Which one did I use?', 'RECOVER_ACCOUNT_IDENTIFIER'],
    ['I registered with Google.', 'GOOGLE_AUTH'],
    ["I haven't received any confirmation message.", 'RESEND_VERIFICATION'],
    ["I don't know what to do.", 'UNKNOWN_AUTH_INTENT'],
    ['I cannot open my email.', 'EMAIL_ACCESS_PROBLEM'],
  ];
  for (const [text, want] of cases) {
    assert.equal(intents.classifyAuthIntent(text), want, text);
  }
});

test('changing your mind resets the auth task, correcting a detail does not', () => {
  const prior = {
    intent: 'REGISTER', state: 'COLLECTING_REGISTRATION_DETAILS',
    method: 'email', emailProvided: false, attempts: 1, updatedAt: Date.now(),
  };
  assert.equal(intents.applyAuthEvent(prior, { type: 'reset' }), null);
  const kept = intents.applyAuthEvent(prior, { type: 'unknown' });
  assert.equal(kept.state, prior.state);
});

test('registration walks one field at a time, then goes ready', () => {
  const first = plan('REGISTER', { registerDraft: {} });
  assert.equal(first.field, 'firstName');
  const last = plan('REGISTER', { registerDraft: { firstName: 'Ada' } });
  assert.equal(last.field, 'lastName');
  const email = plan('REGISTER', { registerDraft: { firstName: 'Ada', lastName: 'Obi' } });
  assert.equal(email.field, 'email');
  const phone = plan('REGISTER', {
    registerDraft: { firstName: 'Ada', lastName: 'Obi' }, emailDeclined: true,
  });
  assert.equal(phone.field, 'phone');
  const password = plan('REGISTER', {
    registerDraft: { firstName: 'Ada', lastName: 'Obi' }, emailProvided: true,
  });
  assert.equal(password.field, 'password');
  const agreement = plan('REGISTER', {
    registerDraft: { firstName: 'Ada', lastName: 'Obi' }, emailProvided: true, passwordSet: true,
  });
  assert.equal(agreement.field, 'agreement');
  const ready = plan('REGISTER', {
    registerDraft: { firstName: 'Ada', lastName: 'Obi' }, emailProvided: true,
    passwordSet: true, agreed: true,
  });
  assert.equal(ready.state, 'REGISTRATION_READY');
  assert.equal(ready.field, null);
});

test('forgotten email never pushes a new account or a reset link', () => {
  const p = plan('RECOVER_ACCOUNT_IDENTIFIER');
  assert.equal(p.state, 'ACCOUNT_IDENTIFIER_RECOVERY');
  assert.equal(p.nextScreen, null);
  assert.ok(!/creat.*account|reset/i.test(p.say));
});

test('forgotten-email outcome keeps the recovery state, never success', () => {
  const prior = {
    intent: 'RECOVER_ACCOUNT_IDENTIFIER', state: 'ACCOUNT_IDENTIFIER_RECOVERY',
    method: null, emailProvided: false, attempts: 0, updatedAt: Date.now(),
  };
  const next = intents.applyAuthEvent(prior, { type: 'outcome', code: 'identifier_unknown' });
  assert.equal(next.state, 'ACCOUNT_IDENTIFIER_RECOVERY');
  assert.notEqual(next.state, 'SUCCESS');
});

test('verification problems land on the verify screen with a resend path', () => {
  for (const intent of ['EMAIL_VERIFICATION', 'RESEND_VERIFICATION']) {
    const p = plan(intent);
    assert.equal(p.state, 'EMAIL_VERIFICATION_PENDING');
    assert.equal(p.nextScreen, 'verifyEmail');
  }
  assert.equal(explainAuthError('verification_not_received').nextScreen, 'verifyEmail');
  assert.equal(explainAuthError('verification_rate_limited').nextScreen, 'verifyEmail');
});

test('no email access states the limit plainly', () => {
  const p = plan('EMAIL_ACCESS_PROBLEM');
  assert.equal(p.nextScreen, null);
  assert.ok(/no other way/i.test(p.say));
  assert.equal(explainAuthError('email_access_unavailable').nextScreen, null);
});

test('network failure never claims loss or success', () => {
  const out = explainAuthError('network_unavailable');
  assert.equal(out.nextScreen, null);
  assert.ok(/nothing was lost/i.test(out.say));
});

test('incomplete information stays in clarification, never guesses', () => {
  const p = plan('UNKNOWN_AUTH_INTENT');
  assert.equal(p.state, 'ASKING_CLARIFICATION');
  const invalid = intents.applyAuthEvent(
    { intent: 'SIGN_IN', state: 'SIGN_IN_IN_PROGRESS', method: null, emailProvided: false, attempts: 0, updatedAt: Date.now() },
    { type: 'outcome', code: 'email_invalid' },
  );
  assert.equal(invalid.state, 'ASKING_CLARIFICATION');
});

test('repeating a request rephrases instead of restarting', () => {
  const prior = {
    intent: 'RESET_PASSWORD', state: 'PASSWORD_RESET_IN_PROGRESS',
    method: 'email', emailProvided: false, attempts: 1, updatedAt: Date.now(),
  };
  const again = intents.planAuthHelp({ intent: 'RESET_PASSWORD', prior });
  assert.equal(again.retry, true);
  assert.equal(again.state, prior.state);
  assert.ok(again.say.startsWith(intents._internal.RETRY_PREFIX));
});

test('only the app session marks success', () => {
  const prior = {
    intent: 'SIGN_IN', state: 'SIGN_IN_IN_PROGRESS',
    method: 'email', emailProvided: false, attempts: 0, updatedAt: Date.now(),
  };
  assert.equal(intents.applyAuthEvent(prior, { type: 'google_started' }).state, 'SIGN_IN_IN_PROGRESS');
  assert.equal(intents.applyAuthEvent(prior, { type: 'authenticated' }).state, 'SUCCESS');
});

test('credentials in chat are refused and redacted', () => {
  const bad = [
    'my password is hunter2',
    'password: hunter2',
    'the OTP is 482913',
    'my verification code is 123456',
    'token: 9f2c7a1e5b4d8f0a3c6e9b2d5f8a1c4e',
    'reset link is https://salmartonline.com.ng/#/password-reset?token=abc',
  ];
  for (const text of bad) {
    const r = guard.inspect(text);
    assert.equal(r.blocked, true, text);
    assert.ok(!r.text.includes('hunter2') && !r.text.includes('482913'));
  }
  const ok = [
    'my password is not working',
    'I forgot my password',
    'the code on the screen confuses me',
    'is there a password I need?',
  ];
  for (const text of ok) {
    assert.equal(guard.inspect(text).blocked, false, text);
  }
});

test('sanitizer drops email values, passwords, and unknown keys', () => {
  const raw = {
    intent: 'REGISTER', state: 'COLLECTING_REGISTRATION_DETAILS',
    method: 'email', emailProvided: true, attempts: 0, updatedAt: Date.now(),
    email: 'ada@example.com', password: 'hunter2', token: 'abc',
  };
  const clean = intents.sanitizeAuthState(raw);
  assert.ok(!('email' in clean) && !('password' in clean) && !('token' in clean));
  assert.equal(clean.emailProvided, true);
});

test('auth state block never carries a secret', () => {
  const block = intents.buildPromptBlock({
    intent: 'REGISTER', state: 'COLLECTING_REGISTRATION_DETAILS',
    method: 'email', emailProvided: true, attempts: 0, updatedAt: Date.now(),
  });
  assert.ok(!/ada@|hunter2|token/i.test(block));
});
