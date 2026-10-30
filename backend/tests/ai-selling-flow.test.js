'use strict';

/* Keyless tests for the guided-selling workflow.
 * Run: node --test tests/ai-selling-flow.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const flow = require('../lib/assistant/sellingFlow');
const session = require('../services/ai/sellingSession');

test('selling: regular starts with photo, discount follows quantity, then review', () => {
  // Photo is the first step of the walk.
  assert.equal(flow.nextStep('regular', {}).step, 'photo');
  const order = ['photo', 'title', 'caption', 'price', 'quantity', 'discount', 'productCondition', 'category', 'location'];
  const snap = {};
  for (const step of order) {
    const next = flow.nextStep('regular', snap);
    assert.equal(next.done, false, `expected open walk, stuck before ${step}`);
    const flag = flow.ORDERS.regular.find((s) => s.step === step).flag;
    snap[flag] = true;
  }
  const done = flow.nextStep('regular', snap);
  assert.equal(done.done, true);
  assert.equal(done.step, 'review');
});

test('selling: single unit skips the discount step', () => {
  const snap = { photo: true, title: true, caption: true, priceValid: true, quantity: 1 };
  const next = flow.nextStep('regular', snap);
  assert.equal(next.step, 'productCondition');
});

test('selling: discount suggestion stays below the item price', () => {
  assert.equal(flow.discountSuggestion(50000), 500);
  assert.equal(flow.discountSuggestion(2000), 200);
  assert.ok(flow.discountSuggestion(150) < 150);
});

test('selling: service and digital follow their own checklists', () => {
  const service = flow.nextStep('service', { title: true, caption: true });
  assert.equal(service.step, 'serviceCategory');
  const digital = flow.nextStep('digital', { title: true, caption: true, priceValid: true });
  assert.equal(digital.step, 'digitalCategory');
  // Digital caption is optional: offered once, then completion is reachable.
  const digitalDone = flow.nextStep('digital', {
    title: true, priceValid: true, digitalCategory: true, digitalFile: true,
  }, ['digitalCaption']);
  assert.equal(digitalDone.done, true);
});

test('selling: optional steps stay skipped once offered', () => {
  const snap = {
    title: true, caption: true, serviceCategory: true,
    serviceType: true, serviceLocation: true,
  };
  const offer = flow.nextStep('service', snap, []);
  assert.equal(offer.step, 'servicePrice');
  const afterSkip = flow.nextStep('service', snap, ['servicePrice']);
  assert.notEqual(afterSkip.step, 'servicePrice');
});

test('selling: spoken prices parse to naira', () => {
  const cases = [
    ['150000', 150000],
    ['₦150,000', 150000],
    ['70k', 70000],
    ['1.5m', 1500000],
    ['one hundred and fifty thousand naira', 150000],
    ['two', 2],
    ['twenty five thousand', 25000],
  ];
  for (const [text, want] of cases) {
    assert.equal(flow.parsePriceWords(text), want, text);
  }
  assert.equal(flow.parsePriceWords('I do not know'), null);
  assert.equal(flow.parsePriceWords(''), null);
});

test('selling: price and quantity rules match the form', () => {
  assert.equal(flow.validatePrice(150000, 'regular'), null);
  assert.equal(flow.validatePrice(50, 'regular'), 'below_minimum');
  assert.equal(flow.validatePrice(0, 'regular'), 'not_positive');
  assert.equal(flow.validatePrice(0, 'service'), null); // negotiable
  assert.equal(flow.validateQuantity(2), null);
  assert.equal(flow.validateQuantity(0), 'too_small');
  assert.equal(flow.validateQuantity(10001), 'too_big');
});

test('selling: session advances from validated tool results only', () => {
  let state = session.applyToolResults(null,
    [{ name: 'navigateToScreen', ok: true, data: { screen: 'createAd' } }],
    { snapshot: {} });
  assert.equal(state.postType, 'regular');

  state = session.applyToolResults(state,
    [{ name: 'prepareAdForm', ok: true, data: { fields: { title: 'Galaxy A54' } } }],
    { snapshot: { title: true } });
  assert.ok(state.asked.includes('title'));

  // A type switch restarts the walk.
  const switched = session.applyToolResults(state,
    [{ name: 'prepareAdForm', ok: true, data: { fields: { postType: 'service' } } }],
    { snapshot: {} });
  assert.equal(switched.postType, 'service');
  assert.deepEqual(switched.asked, ['postType']);
});

test('selling: prompt block names one question and the missing list', () => {
  const block = session.promptBlock(
    { postType: 'regular', currentStep: null, asked: [], updatedAt: Date.now() },
    { title: true },
  );
  assert.ok(block.includes('Next question'));
  assert.ok(block.includes('Missing required'));
  assert.ok(!/galaxy|150000|password|token/i.test(block), 'no values or secrets');
});

test('selling: registry wires requestListingPhoto for signed-in sellers', () => {
  let registry;
  try {
    registry = require('../services/ai/toolRegistry');
  } catch {
    return; // extract lacks host models; pure-module tests above still guard
  }
  const def = registry.getTool('requestListingPhoto');
  assert.ok(def, 'requestListingPhoto must be registered');
  assert.equal(def.category, 'form');
  assert.equal(def.requiresAuth, true);
  assert.equal(def.wired, true);
  assert.equal(def.requiresConfirmation, false);
  const authed = registry.toolsForContext({
    isAuthenticated: true,
    allowedPermissions: ['product:read', 'seller:own', 'message:own', 'order:own'],
  });
  assert.ok(authed.some((t) => t.name === 'requestListingPhoto'));
  const anon = registry.toolsForContext({ isAuthenticated: false, allowedPermissions: [] });
  assert.ok(!anon.some((t) => t.name === 'requestListingPhoto'));
});
