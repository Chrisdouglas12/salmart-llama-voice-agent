'use strict';

/**
 * Keyless contract tests for the voice-first registration script.
 *
 * The spoken order is: full name -> welcome by that name -> email question ->
 * (no email) phone number -> password box -> agreement -> read-back -> confirm
 * card -> the user's own tap. These tests guard the pure pieces that order the
 * conversation, the recap that must never contain a password, and the guidance
 * used when the real registration endpoint rejects a sign-up.
 *
 * Run: node --test tests/ai-registration-script.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const intents = require('../lib/assistant/authIntents');
const { AUTH_GUIDANCE, explainAuthError } = require('../lib/assistant/authGuidance');
const formTools = require('../services/ai/tools/formTools');
const { buildStructured } = require('../services/ai/structuredBlocks');

const NAME = { fullName: 'Ada Obi' };

function registerPlan(extra = {}) {
  return intents.planAuthHelp({ intent: 'REGISTER', ...extra });
}

test('registration: steps arrive in the spoken order and never skip', () => {
  assert.equal(registerPlan().field, 'fullName');
  assert.equal(registerPlan({ registerDraft: NAME }).field, 'email');
  assert.equal(
    registerPlan({ registerDraft: NAME, emailDeclined: true }).field,
    'phone',
    'only "no email" moves the user to the phone',
  );
  assert.equal(
    registerPlan({ registerDraft: NAME, emailProvided: true }).field,
    'password',
  );
  assert.equal(
    registerPlan({ registerDraft: NAME, emailProvided: true, passwordSet: true }).field,
    'agreement',
  );
});

test('registration: a complete form asks for the final tap, not a submission', () => {
  const plan = registerPlan({
    registerDraft: NAME, emailProvided: true, passwordSet: true, agreed: true,
  });
  assert.equal(plan.state, 'REGISTRATION_READY');
  assert.equal(plan.field, 'confirm');
  assert.equal(plan.nextScreen, 'register');
  assert.match(plan.say, /read your details back/i);
  assert.doesNotMatch(plan.say, /creat(e|ing) your account now/i);
});

test('registration: recap lists only provided fields, in order, never a password', () => {
  assert.deepEqual(intents.registrationRecap({}), []);
  assert.deepEqual(
    intents.registrationRecap({
      fullName: 'Ada Obi',
      email: 'ada@example.com',
      phoneNumber: '08031234567',
    }),
    ['Full name: Ada Obi', 'Email: ada@example.com', 'Phone number: 08031234567'],
  );
  const text = intents.registrationRecap({
    fullName: 'Ada Obi',
    password: 'Secret123',
    passwordValue: 'Secret123',
  }).join('\n');
  assert.match(text, /Ada Obi/);
  assert.doesNotMatch(text, /Secret123/);
  assert.doesNotMatch(text, /password/i);
});

test('registration: guidance explains every sign-up failure without technical text', () => {
  for (const code of [
    'phone_exists', 'invalid_phone', 'weak_password', 'missing_identifier',
    'registration_invalid', 'registration_failed',
  ]) {
    const g = explainAuthError(code);
    assert.equal(g.code, code, `${code} is a real guidance code`);
    assert.ok(g.say.length > 0 && g.say.length <= 160, `${code} is short enough to speak`);
    assert.ok(
      ['register', 'signin', null].includes(g.nextScreen),
      `${code} points at a fixing screen`,
    );
    assert.doesNotMatch(g.say, /undefined|\[object/i);
  }
  assert.equal(AUTH_GUIDANCE.phone_exists.nextScreen, 'signin');
  assert.equal(AUTH_GUIDANCE.weak_password.nextScreen, 'register');
});

test('registration: a full name is saved, welcomed and followed by the email question', async () => {
  const ctx = {};
  const r = await formTools.prepareRegistration(ctx, { fullName: 'Ada Obi' });
  assert.equal(r.fields.firstName, 'Ada');
  assert.equal(r.fields.lastName, 'Obi');
  assert.equal(r.welcome, 'Welcome Ada Obi.');
  assert.match(r.say, /^Welcome Ada Obi\. Do you have an email\?/);
  assert.doesNotMatch(r.say, /password|secret code/i);
  assert.equal(ctx.registerDraft.fullName, 'Ada Obi');
});

test('registration: a split first and last name still gets one welcome', async () => {
  const ctx = {};
  const first = await formTools.prepareRegistration(ctx, { firstName: 'Ada' });
  assert.match(first.nextAsk, /last name/i);
  const last = await formTools.prepareRegistration(ctx, { lastName: 'Obi' });
  assert.equal(last.welcome, 'Welcome Ada Obi.');
  assert.match(last.nextAsk, /email/i);
});

test('registration: "no email" asks for the phone and saves no field', async () => {
  const ctx = {};
  await formTools.prepareRegistration(ctx, { fullName: 'Ada Obi' });
  const r = await formTools.prepareRegistration(ctx, { noEmail: true });
  assert.deepEqual(r.fields, {});
  assert.equal(r.emailDeclined, true);
  assert.match(r.nextAsk, /phone number/i);
  assert.equal(ctx.emailDeclined, true);
});

test('registration: a phone number is saved, read back, and leads to the password box', async () => {
  const ctx = { registerDraft: { fullName: 'Ada Obi' }, emailDeclined: true };
  const r = await formTools.prepareRegistration(ctx, { phoneNumber: '+234 803 123 4567' });
  assert.equal(r.fields.phoneNumber, '08031234567');
  assert.match(r.note, /read the number back/i);
  assert.match(r.nextAsk, /secret code/i);
  assert.equal(ctx.phoneProvided, true);
});

test('registration: an incomplete email or phone is rejected with help, never invented', async () => {
  await assert.rejects(
    () => formTools.prepareRegistration({}, { email: 'ada@example' }),
    (e) => e.code === 'TOOL_BAD_ARGS' && /one part at a time/i.test(e.message),
  );
  await assert.rejects(
    () => formTools.prepareRegistration({}, { phoneNumber: '0803123' }),
    (e) => e.code === 'TOOL_BAD_ARGS' && /11 digits/i.test(e.message),
  );
});

test('registration: a password never enters the patch, the note or the card line', async () => {
  const r = await formTools.prepareRegistration(
    { registration: { password: true, agreed: true, email: true } },
    { fullName: 'Ada Obi', password: 'Secret123' },
  );
  assert.equal(r.fields.password, undefined);
  assert.doesNotMatch(JSON.stringify(r), /Secret123/);
  assert.match(r.nextAsk, /microphone/i);
  assert.match(r.nextAsk, /register me/i);
  assert.match(r.nextAsk, /change/i);
  assert.ok(r.manualSteps.includes('confirm'));
});

test('registration: the no-email turn emits no empty fill that hides the phone focus', () => {
  const blocks = buildStructured([
    {
      name: 'prepareRegistration',
      ok: true,
      data: { fields: {}, say: 'What phone number should we use?' },
    },
    { name: 'beginAuthHelp', ok: true, data: { nextScreen: 'register', field: 'phone' } },
  ]);
  assert.equal(blocks.some(b => b.type === 'fill_register'), false);
  const focus = blocks.find(b => b.type === 'register_focus');
  assert.equal(focus.field, 'phone');
});

test('registration: the phone card uses the short say, not the model-facing note', () => {
  const blocks = buildStructured([
    {
      name: 'prepareRegistration',
      ok: true,
      data: {
        fields: { firstName: 'Ada', lastName: 'Obi' },
        say: 'Welcome Ada Obi. Do you have an email?',
        note: 'long model-facing note',
      },
    },
  ]);
  const fill = blocks.find(b => b.type === 'fill_register');
  assert.equal(fill.say, 'Welcome Ada Obi. Do you have an email?');
});

test('registration: a complete form without a confirm prior still reads the details back', () => {
  // Open the summary the first time: the phone reads the recap itself.
  const plan = registerPlan({
    registerDraft: NAME, emailProvided: true, passwordSet: true, agreed: true,
  });
  assert.equal(plan.submitting, false);
  assert.match(plan.say, /read your details back/i);
});

test('registration: "register me" from the open summary acknowledges and submits', () => {
  const plan = registerPlan({
    prior: { intent: 'REGISTER', field: 'confirm', attempts: 1 },
    registerDraft: NAME,
    emailProvided: true,
    passwordSet: true,
    agreed: true,
  });
  assert.equal(plan.state, 'REGISTRATION_READY');
  assert.equal(plan.field, 'confirm');
  assert.equal(plan.submitting, true, 'the phone is told to submit');
  assert.match(plan.say, /^Alright Ada Obi, I am creating your account now\.$/);
  assert.doesNotMatch(plan.say, /read your details back/i);
});

test('registration: the creating line falls back to the neutral form without a name', () => {
  const plan = registerPlan({
    prior: { intent: 'REGISTER', field: 'confirm', attempts: 1 },
    registration: { fullName: true, email: true, password: true, agreed: true },
  });
  assert.equal(plan.submitting, true);
  assert.equal(plan.say, 'Alright, I am creating your account now.');
});

test('registration: only the confirm step sets submitting', () => {
  const step = registerPlan({ registerDraft: NAME });
  assert.equal(step.submitting, false);
});

test('registration: the password question explains the password and privacy rule', () => {
  const plan = registerPlan({
    registerDraft: NAME, emailProvided: true,
  });
  assert.equal(plan.field, 'password');
  assert.match(plan.say, /secret code/i);
  assert.match(plan.say, /eight characters/i);
  assert.match(plan.say, /never share/i);
  assert.match(plan.say, /not even someone/i);
  assert.ok(plan.say.length <= intents.MAX_SAY);
});

test('registration: the agreement question explains the privacy policy and terms', () => {
  const plan = registerPlan({
    registerDraft: NAME, emailProvided: true, passwordSet: true,
  });
  assert.equal(plan.field, 'agreement');
  assert.match(plan.say, /Privacy Policy/i);
  assert.match(plan.say, /Terms and Conditions/i);
  assert.match(plan.say, /tick the box/i);
  assert.match(plan.say, /only if you agree/i);
  assert.ok(plan.say.length <= intents.MAX_SAY);
});

test('registration: the register_focus block carries the server say and submitting flag', () => {
  const blocks = buildStructured([
    {
      name: 'beginAuthHelp',
      ok: true,
      data: {
        nextScreen: 'register',
        field: 'confirm',
        say: 'Alright Ada Obi, I am creating your account now.',
        submitting: true,
      },
    },
  ]);
  const focus = blocks.find(b => b.type === 'register_focus');
  assert.equal(focus.field, 'confirm');
  assert.equal(focus.say, 'Alright Ada Obi, I am creating your account now.');
  assert.equal(focus.submitting, true);
});

test('registration: a step focus without submitting omits the flag and keeps its say', () => {
  const blocks = buildStructured([
    {
      name: 'beginAuthHelp',
      ok: true,
      data: {
        nextScreen: 'register',
        field: 'password',
        say: 'Now choose your secret code on the screen.',
      },
    },
  ]);
  const focus = blocks.find(b => b.type === 'register_focus');
  assert.equal(focus.field, 'password');
  assert.equal(focus.say, 'Now choose your secret code on the screen.');
  assert.equal(focus.submitting, undefined);
});

test('registration: the password and agreement summaries stay within the speech cap', () => {
  for (const [step, extra] of [
    ['password', { registerDraft: NAME, emailProvided: true }],
    ['agreement', { registerDraft: NAME, emailProvided: true, passwordSet: true }],
  ]) {
    const plan = registerPlan(extra);
    assert.equal(plan.field, step);
    assert.ok(plan.say.length <= intents.MAX_SAY, `${step} fits one turn`);
  }
});
