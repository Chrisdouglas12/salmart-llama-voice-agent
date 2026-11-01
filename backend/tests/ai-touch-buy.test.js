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

test('touch: the model prompt carries the live listing and the seller rule', () => {
  const prompt = touchBuy.buildPickPrompt({
    title: 'Black leather bag',
    price: 18500,
    description: 'Strong leather bag with a long strap.',
    hasSeller: true,
    sellerName: 'Ada',
    lang: 'yor',
  });

  assert.match(prompt.system, /Yoruba/);
  assert.match(prompt.system, /chat the seller/);
  assert.match(prompt.user, /Black leather bag/);
  assert.match(prompt.user, /₦18,500/);
  assert.match(prompt.user, /long strap/);
  assert.match(prompt.user, /Ada/);

  const noSeller = touchBuy.buildPickPrompt({ title: 'Bag', price: 100, hasSeller: false });
  assert.match(noSeller.system, /do not mention a seller/i);
  assert.match(noSeller.user, /not reachable/);
});

test('touch: a good model reply is accepted and cleaned', () => {
  const line = touchBuy.acceptModelReply(
    '**I added the black leather bag to your cart.** It costs ₦18,500. Do you want me to chat the seller?',
    { price: 18500, hasSeller: true },
  );

  assert.equal(
    line,
    'I added the black leather bag to your cart. It costs ₦18,500. Do you want me to chat the seller?',
  );
});

test('touch: a translated reply is accepted without the English word "cart"', () => {
  const line = touchBuy.acceptModelReply(
    'A ti fi baagi alawọ dudu kun kaa rẹ. O jẹ ₦18,500.',
    { price: 18500, hasSeller: true, lang: 'yor' },
  );

  assert.equal(line, 'A ti fi baagi alawọ dudu kun kaa rẹ. O jẹ ₦18,500.');
});

test('touch: a translated reply still cannot change the price', () => {
  assert.equal(
    touchBuy.acceptModelReply('O jẹ ₦20,000.', {
      price: 18500, hasSeller: true, lang: 'yor',
    }),
    null,
  );
});

test('touch: an English reply without a cart confirmation is still rejected', () => {
  assert.equal(
    touchBuy.acceptModelReply('The black bag costs ₦18,500.', {
      price: 18500, hasSeller: true, lang: null,
    }),
    null,
  );
});

test('touch: a model reply that changes the price is rejected', () => {
  assert.equal(
    touchBuy.acceptModelReply('I added it to your cart for ₦20,000.', {
      price: 18500, hasSeller: true,
    }),
    null,
  );
});

test('touch: a model reply that invents a seller is rejected when none is reachable', () => {
  assert.equal(
    touchBuy.acceptModelReply('I added the bag to your cart. Do you want me to chat the seller?', {
      price: 18500, hasSeller: false,
    }),
    null,
  );
});

test('touch: payment and delivery claims are rejected', () => {
  for (const text of [
    'I added the bag to your cart. It is already paid.',
    'I added the bag to your cart. It will be delivered tomorrow for ₦18,500.',
  ]) {
    assert.equal(touchBuy.acceptModelReply(text, { price: 18500, hasSeller: true }), null);
  }
});

test('touch: a model reply without a cart confirmation is rejected', () => {
  assert.equal(
    touchBuy.acceptModelReply('The black bag costs ₦18,500.', { price: 18500, hasSeller: true }),
    null,
  );
});

test('touch: a long model reply is cut at a sentence boundary', () => {
  const long = `${'I added the bag to your cart. It costs ₦18,500. '.repeat(12)}`;
  const line = touchBuy.acceptModelReply(long, { price: 18500, hasSeller: false });

  assert.ok(line && line.length <= 360, `reply too long: ${line && line.length}`);
  assert.match(line, /₦18,500/);
});

