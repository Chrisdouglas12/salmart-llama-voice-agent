'use strict';

/**
 * Keyless tests for the touch-to-buy path.
 *
 * Run: node --test tests/ai-touch-buy.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const touchBuy = require('../services/ai/touchBuy');
const taskState = require('../services/ai/taskState');

const PRODUCT_ID = '64b7f0a1c2d3e4f5a6b7c8d9';
const SELLER_ID = '64b7f0a1c2d3e4f5a6b7c8d0';

test('touch: spoken confirmation names the item, price and description', () => {
  const line = touchBuy.buildPickReply({
    title: 'Black leather bag',
    price: 18500,
    description: 'Strong leather bag with a long strap.',
    hasSeller: true,
  });

  assert.match(line, /Black leather bag/);
  assert.match(line, /₦18,500/);
  assert.match(line, /Strong leather bag with a long strap\./);
  assert.match(line, /chat the seller/i);
});

test('touch: no seller means no chat question; no description is not invented', () => {
  const line = touchBuy.buildPickReply({
    title: 'Blender', price: 12000, description: '', hasSeller: false,
  });

  assert.equal(
    line,
    'I have added Blender to your cart. It costs ₦12,000.',
  );
});

test('touch: a description that only repeats the title is omitted', () => {
  const line = touchBuy.buildPickReply({
    title: 'Blender', price: 12000, description: 'Blender', hasSeller: false,
  });

  assert.equal(line, 'I have added Blender to your cart. It costs ₦12,000.');
});

test('touch: a long description is cut at a word boundary', () => {
  const long = `${'This bag is strong and roomy. '.repeat(20)}`;
  const line = touchBuy.buildPickReply({ title: 'Bag', price: 5000, description: long });

  assert.ok(line.length < 260, `reply too long: ${line.length}`);
  assert.match(line, /This bag is strong/);
  assert.doesNotMatch(line, /\s\./);
});

test('touch: the seller draft carries the item and price', () => {
  assert.equal(
    touchBuy.buildEnquiryDraft({ title: 'Black bag', price: 18500 }),
    'Hi, I want to buy Black bag (₦18,500). Is it still available?',
  );
});

test('task: a touch pick is remembered for the next voice turn', () => {
  const collected = taskState.applyPick(
    { task: { goal: 'I want to buy a bag', updatedAt: Date.now(), status: 'active' } },
    {
      productId: PRODUCT_ID,
      title: 'Black bag',
      price: 18500,
      sellerId: SELLER_ID,
      sellerName: 'Ada',
      itemType: 'post',
      at: Date.now(),
    },
  );

  const block = taskState.buildPromptBlock(collected.task);
  assert.match(block, new RegExp(PRODUCT_ID));
  assert.match(block, /Black bag/);
  assert.match(block, /₦18500/);

  // A following correction keeps the pick.
  const next = taskState.beginTurn({ collectedInfo: collected, message: 'Yes, chat him' });
  assert.equal(next.task.lastPick.productId, PRODUCT_ID);
});

test('task: a malformed pick is ignored', () => {
  const collected = taskState.applyPick(null, { productId: 'not-an-id', title: 'Fake' });
  assert.equal(collected, null);
});

test('task: a fresh search clears the old touch pick', () => {
  const collected = taskState.applyPick(
    { task: { goal: 'buy a bag', updatedAt: Date.now(), status: 'active' } },
    { productId: PRODUCT_ID, title: 'Black bag', price: 18500, at: Date.now() },
  );
  const task = taskState.normalizeTask(collected);
  assert.ok(task.lastPick);

  taskState.applyToolResults(task, [{
    name: 'searchProducts', ok: true,
    data: { products: [{ productId: PRODUCT_ID }], total: 1 },
  }]);

  assert.equal(task.lastPick, null);
});
