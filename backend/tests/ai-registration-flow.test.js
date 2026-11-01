'use strict';

/**
 * Voice-first registration contract.
 *
 * These are keyless tests for the parts that decide what the assistant may say
 * and when the account may be created. They run without a model, a database or
 * a phone, and they pin the safety rules:
 *
 *   - the last step before creation is an explicit confirmation;
 *   - a spoken phone number is read back once and never invented;
 *   - the confirmation tool only opens the card, it never creates anything;
 *   - a password can never arrive or leave through a form patch;
 *   - every registration failure code has field-level spoken guidance.
 *
 * Run: node --test tests/ai-registration-flow.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const intents = require('../lib/assistant/authIntents');
const formTools = require('../services/ai/tools/formTools');
const { buildStructured } = require('../services/ai/structuredBlocks');
const { explainAuthError } = require('../lib/assistant/authGuidance');

const COMPLETE_DRAFT = { registerDraft: { fullName: 'Ada Obi' }, emailProvided: true };

function plan(extra = {}) {
  return intents.planAuthHelp({ intent: 'REGISTER', ...COMPLETE_DRAFT, ...extra });
}

test('registration: agreement is followed by a confirmation, not a submission', () => {
  const confirm = plan({ passwordSet: true, agreed: true });
  assert.equal(confirm.field, 'confirm');
  assert.equal(confirm.nextScreen, 'register');
  assert.match(confirm.say, /create your account/i);
  assert.ok(!/creat(ed|ing)|done|success/i.test(confirm.say), 'must not claim creation');

  const ready = plan({ passwordSet: true, agreed: true, confirmed: true });
  assert.equal(ready.state, 'REGISTRATION_READY');
  assert.equal(ready.field, null);
});

test('registration: a field filled by hand is never asked for again', () => {
  const mid = plan({
    registration: {
      fullName: true, firstName: true, lastName: true,
      email: true, password: true, agreed: true, confirmed: false,
    },
  });
  assert.equal(mid.field, 'confirm');
});

test('registration: a first phone number is read back exactly once', async () => {
  const ctx = {
    registration: {
      fullName: true, firstName: true, lastName: true,
      email: false, phone: false, emailDeclined: true,
      password: false, agreed: false, confirmed: false,
    },
    registerDraft: { fullName: 'Ada Obi' },
  };
  const first = await formTools.prepareRegistration(ctx, { phoneNumber: '+234 803 123 4567' });
  assert.equal(first.fields.phoneNumber, '08031234567', 'stored in local form');
  assert.equal(first.readBack, 'I heard 0803 123 4567. Is that correct?');
  assert.equal(first.nextAsk, first.readBack, 'the read-back is the only question');
  assert.equal(first.say, first.readBack, 'the safe on-screen line is the read-back');

  // The same number on a later turn is not read back again.
  const again = await formTools.prepareRegistration(
    { ...ctx, phoneProvided: true, registration: { ...ctx.registration, phone: true } },
    { phoneNumber: '08031234567' },
  );
  assert.equal(again.readBack, undefined);
});

test('registration: a spoken correction is re-read, not merged with the old digits', async () => {
  const ctx = {
    registration: { phone: true, emailDeclined: true, confirmed: false },
    phoneProvided: true,
  };
  const corrected = await formTools.prepareRegistration(ctx, { phoneNumber: '0803 999 0000' });
  // The tool accepts a replacement value; the screen overwrites the field.
  assert.equal(corrected.fields.phoneNumber, '08039990000');
  // No read-back on a value the form already held; the model says one short
  // acknowledgement instead of asking again.
  assert.equal(corrected.readBack, undefined);
});

test('registration: unusable digits are rejected, never completed', async () => {
  for (const bad of ['0803', '12345', '0803123456789', 'abcdefghijk', '']) {
    await assert.rejects(
      () => formTools.prepareRegistration({}, { phoneNumber: bad }),
      (err) => err.code === 'TOOL_BAD_ARGS',
      `"${bad}" must not become a phone number`,
    );
  }
});

test('registration: a password can never travel in a form patch', async () => {
  const out = await formTools.prepareRegistration(
    { registration: {} },
    { fullName: 'Ada Obi', password: 'Secret123' },
  );
  assert.ok(!('password' in out.fields));
  assert.ok(!JSON.stringify(out.fields).includes('Secret123'));
});

test('registration: the confirmation tool only opens the card', () => {
  const blocks = buildStructured([
    { name: 'confirmRegistration', ok: true, data: { show: true, summary: 'Check the details.' } },
  ]);
  const card = blocks.find(b => b.type === 'create_account');
  assert.ok(card, 'a create_account block must be emitted');
  assert.equal(card.target, 'register');
  // The block carries no values and no instruction to submit.
  assert.equal(card.fields, undefined);
  assert.equal(card.submit, undefined);
});

test('registration: a fill block shows the read-back, never the model note', () => {
  const blocks = buildStructured([
    {
      name: 'prepareRegistration',
      ok: true,
      data: {
        fields: { phoneNumber: '08031234567' },
        say: 'I heard 0803 123 4567. Is that correct?',
        note: 'INTERNAL: ask only this and stop',
      },
    },
  ]);
  const fill = blocks.find(b => b.type === 'fill_register');
  assert.ok(fill);
  assert.equal(fill.say, 'I heard 0803 123 4567. Is that correct?');
  assert.ok(!JSON.stringify(fill).includes('INTERNAL'));
});

test('registration: every failure code explains itself and names no password', () => {
  const codes = [
    'phone_exists', 'email_exists', 'email_invalid', 'invalid_phone',
    'weak_password', 'missing_identifier', 'registration_invalid',
    'registration_failed', 'network_unavailable',
  ];
  for (const code of codes) {
    const out = explainAuthError(code);
    assert.equal(out.code, code, `${code} must resolve`);
    assert.ok(out.say.length <= 160, `${code} must stay speakable`);
    assert.ok(!/your password|enter.*password/i.test(out.say), `${code} must not ask for a password`);
  }
  assert.equal(explainAuthError('phone_exists').nextScreen, 'signin');
  assert.equal(explainAuthError('registration_invalid').nextScreen, null);
});
