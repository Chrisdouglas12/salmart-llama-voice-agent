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

test('touch: the read-back names the item, price and description then asks save or chat', () => {
  const line = touchBuy.buildSelectionReply({
    title: 'Black leather bag',
    price: 18500,
    description: 'Strong leather bag with a long strap.',
    hasSeller: true,
  });

  assert.match(line, /Black leather bag/);
  assert.match(line, /₦18,500/);
  assert.match(line, /Strong leather bag with a long strap\./);
  assert.match(line, /save it for you/i);
  assert.match(line, /chat the seller/i);
  assert.doesNotMatch(line, /added .* cart|called/i);
});

test('touch: no seller means no chat question; no description is not invented', () => {
  const line = touchBuy.buildSelectionReply({
    title: 'Blender', price: 12000, description: '', hasSeller: false,
  });

  assert.equal(
    line,
    'You picked Blender. It costs ₦12,000. Should I save it for you so you can buy it later?',
  );
});

test('touch: a description that only repeats the title is omitted', () => {
  const line = touchBuy.buildSelectionReply({
    title: 'Blender', price: 12000, description: 'Blender', hasSeller: false,
  });

  assert.equal(
    line,
    'You picked Blender. It costs ₦12,000. Should I save it for you so you can buy it later?',
  );
});

test('touch: a long description is cut at a word boundary', () => {
  const long = `${'This bag is strong and roomy. '.repeat(20)}`;
  const line = touchBuy.buildSelectionReply({ title: 'Bag', price: 5000, description: long });

  assert.ok(line.length < 560, `reply too long: ${line.length}`);
  assert.match(line, /This bag is strong/);
  assert.doesNotMatch(line, /\s\./);
});

test('touch: the saved reply tells the buyer to ask for the cart and offers the seller check', () => {
  const line = touchBuy.buildSavedReply({ title: 'Black bag', hasSeller: true });

  assert.match(line, /saved Black bag in your cart/i);
  assert.match(line, /ask me to open the cart/i);
  assert.match(line, /chat the seller/i);
  assert.match(line, /still available/i);
});

test('touch: the seller draft carries the item and price', () => {
  assert.equal(
    touchBuy.buildEnquiryDraft({ title: 'Black bag', price: 18500 }),
    'Hi, I want to buy Black bag (₦18,500). Is it still available?',
  );
});

test('task: a touch pick is remembered as not saved, and names the save step', () => {
  const collected = taskState.applyPick(
    { task: { goal: 'I want to buy a bag', updatedAt: Date.now(), status: 'active' } },
    {
      productId: PRODUCT_ID,
      title: 'Black bag',
      price: 18500,
      sellerId: SELLER_ID,
      sellerName: 'Ada',
      itemType: 'post',
      saved: false,
      at: Date.now(),
    },
  );

  const block = taskState.buildPromptBlock(collected.task);
  assert.match(block, new RegExp(PRODUCT_ID));
  assert.match(block, /Black bag/);
  assert.match(block, /₦18500/);
  assert.match(block, /NOT in the cart yet/);
  assert.match(block, /call addToCart once/);

  // A following correction keeps the pick.
  const next = taskState.beginTurn({ collectedInfo: collected, message: 'Yes, chat him' });
  assert.equal(next.task.lastPick.productId, PRODUCT_ID);
});

test('task: a successful addToCart marks the pick saved so it is never added twice', () => {
  const collected = taskState.applyPick(
    { task: { goal: 'buy a bag', updatedAt: Date.now(), status: 'active' } },
    { productId: PRODUCT_ID, title: 'Black bag', price: 18500, at: Date.now() },
  );
  const task = taskState.normalizeTask(collected);

  taskState.applyToolResults(task, [{
    name: 'cart.addToCart', ok: true,
    data: { added: true, productId: PRODUCT_ID, title: 'Black bag', price: 18500, cartCount: 1 },
  }]);

  assert.equal(task.lastPick.saved, true);
  const block = taskState.buildPromptBlock(task);
  assert.match(block, /already saved in the cart/i);
  assert.match(block, /do NOT add it again/);
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

test('touch: a save shows the cart card only after addToCart really ran', () => {
  const { buildStructured } = require('../services/ai/structuredBlocks');

  assert.deepEqual(buildStructured([{
    name: 'cart.addToCart',
    ok: false,
    data: { added: true, productId: PRODUCT_ID },
  }]), []);

  const blocks = buildStructured([{
    name: 'cart.addToCart',
    ok: true,
    data: {
      added: true,
      productId: PRODUCT_ID,
      title: 'Black bag',
      price: 18500,
      description: 'Strong leather bag.',
      photo: null,
      sellerId: SELLER_ID,
      sellerName: 'Ada',
      itemType: 'post',
      cartCount: 2,
    },
  }]);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'product_added');
  assert.equal(blocks[0].product.productId, PRODUCT_ID);
  assert.equal(blocks[0].cartCount, 2);
});

