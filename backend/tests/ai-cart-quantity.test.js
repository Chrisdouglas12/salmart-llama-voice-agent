'use strict';

/**
 * Keyless tests for the assistant's cart quantity arithmetic.
 *
 * The voice flow asks "how many do you want?" so the number the buyer says is
 * the TOTAL, not an amount added on top of what the cart already holds. These
 * tests pin that (and the stock clamp) so a refactor cannot bring back the
 * over-add bug.
 *
 * Run: node --test tests/ai-cart-quantity.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_QUANTITY,
  normalizeQuantity,
  resolveCartQuantity,
} = require('../services/ai/cartQuantity');

test('cart quantity: the requested number is the total, not an extra amount', () => {
  const plan = resolveCartQuantity({ requested: 2, inCart: 1, stock: 10 });
  assert.equal(plan.mode, 'set');
  assert.equal(plan.total, 2);
  assert.equal(plan.addedNow, 1);
  assert.equal(plan.capped, false);
  assert.equal(plan.reduced, false);
  assert.equal(plan.available, 8);
});

test('cart quantity: a smaller request lowers the total instead of adding', () => {
  const plan = resolveCartQuantity({ requested: 1, inCart: 3, stock: 10 });
  assert.equal(plan.total, 1);
  assert.equal(plan.addedNow, 0);
  assert.equal(plan.reduced, true);
});

test('cart quantity: mode add is only for an explicit "two more"', () => {
  const plan = resolveCartQuantity({ requested: 2, inCart: 3, stock: 10, mode: 'add' });
  assert.equal(plan.mode, 'add');
  assert.equal(plan.total, 5);
  assert.equal(plan.addedNow, 2);
  assert.equal(plan.available, 5);
});

test('cart quantity: the server stock caps the total before anything is written', () => {
  const plan = resolveCartQuantity({ requested: 5, inCart: 0, stock: 3 });
  assert.equal(plan.total, 3);
  assert.equal(plan.addedNow, 3);
  assert.equal(plan.capped, true);
  assert.equal(plan.available, 0);
});

test('cart quantity: add mode cannot push the cart past the stock', () => {
  const plan = resolveCartQuantity({ requested: 5, inCart: 1, stock: 3, mode: 'add' });
  assert.equal(plan.total, 3);
  assert.equal(plan.addedNow, 2);
  assert.equal(plan.capped, true);
  assert.equal(plan.available, 0);
});

test('cart quantity: repeating the same request adds nothing more', () => {
  const first = resolveCartQuantity({ requested: 2, inCart: 0, stock: 10 });
  const second = resolveCartQuantity({ requested: 2, inCart: first.total, stock: 10 });
  assert.equal(second.total, 2);
  assert.equal(second.addedNow, 0);
  assert.equal(second.capped, false);
});

test('cart quantity: an item already at stock reports zero added, not an error', () => {
  const plan = resolveCartQuantity({ requested: 3, inCart: 3, stock: 3 });
  assert.equal(plan.total, 3);
  assert.equal(plan.addedNow, 0);
  assert.equal(plan.capped, false);
});

test('cart quantity: uncounted stock leaves the cart unbounded by availability', () => {
  const plan = resolveCartQuantity({ requested: 4, inCart: 1, stock: null });
  assert.equal(plan.total, 4);
  assert.equal(plan.available, null);
});

test('cart quantity: services and digitals are never counted', () => {
  const plan = resolveCartQuantity({ requested: 9, inCart: 4, stock: null, unitOnly: true });
  assert.equal(plan.total, 1);
  assert.equal(plan.addedNow, 0);
  assert.equal(plan.reduced, true);
});

test('cart quantity: bad input becomes one, and the ceiling is enforced', () => {
  assert.equal(normalizeQuantity(undefined), 1);
  assert.equal(normalizeQuantity('0'), 1);
  assert.equal(normalizeQuantity('-4'), 1);
  assert.equal(normalizeQuantity('abc'), 1);
  assert.equal(normalizeQuantity(MAX_QUANTITY + 50), MAX_QUANTITY);

  const plan = resolveCartQuantity({ requested: MAX_QUANTITY + 50, inCart: 0, stock: null });
  assert.equal(plan.total, MAX_QUANTITY);
});
