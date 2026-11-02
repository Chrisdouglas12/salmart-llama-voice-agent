'use strict';

/**
 * Selling walkthrough contract: quantity is always asked, the recap reads
 * start to end, and every post-failure code has a short spoken fix.
 *
 * Run: node --test tests/ai-selling-recap.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const selling = require('../lib/assistant/sellingFlow');
const session = require('../services/ai/sellingSession');

const AFTER_PRICE = { photo: true, title: true, caption: true, priceValid: true, quantity: false };

test('selling: quantity is asked after price, never skipped to discount', () => {
  const n = selling.nextStep('regular', AFTER_PRICE, []);
  assert.equal(n.step, 'quantity');
  assert.match(n.ask, /how many/i);
});

test('selling: discount comes only after a real quantity', () => {
  const n = selling.nextStep('regular', { ...AFTER_PRICE, quantity: true }, []);
  assert.equal(n.step, 'discount');
});

test('selling: complete form yields an ordered recap, not another question', () => {
  const task = {
    adDraft: {
      title: 'iPhone 12', description: 'Neatly used', price: 150000,
      quantity: 3, bulkDiscountMinQty: 5, bulkDiscountOff: 500,
      condition: 'Good', category: 'electronics', location: 'Lagos',
    },
  };
  const snap = {
    photo: true, title: true, caption: true, priceValid: true, quantity: true,
    bulkDiscount: true, condition: true, category: true, location: true,
  };
  const block = session.promptBlock(
    { postType: 'regular', asked: [], currentStep: null, updatedAt: Date.now() },
    snap, task,
  );
  const lines = block.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.deepEqual(lines.map((l) => l.replace(/^\d+\. ([A-Za-z]+):.*$/, '$1')), [
    'Item', 'Description', 'Price', 'Quantity', 'Discount', 'Condition', 'Category', 'Location',
  ]);
  assert.match(block, /Should I post it\?/);
  assert.ok(!/next question/i.test(block), 'no next-question trailer when complete');
});

test('selling: every listing failure code explains itself in one short line', () => {
  for (const code of ['photo_missing', 'price_invalid', 'quantity_invalid', 'field_missing', 'content_blocked', 'network_unavailable', 'publish_failed']) {
    const out = selling.explainListingError(code);
    assert.equal(out.code, code);
    assert.ok(out.say.length > 0 && out.say.length <= 160, `${code} must stay speakable`);
  }
  assert.equal(selling.explainListingError('bogus').code, 'publish_failed');
});
