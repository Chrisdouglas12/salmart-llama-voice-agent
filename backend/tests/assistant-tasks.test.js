/* Aya agent eval — task-planning layer (Phase 4).
 *
 * Covers the prompt's evaluation categories that are unit-testable without
 * Mongo or providers: scope-change detection, mid-task correction (draft
 * merge), price-gate validation, task TTL/expiry, and prompt-block accuracy.
 * Tool/DB behaviour (ownership checks, verified writes) is exercised live
 * against the host server, not here. Run: node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scopeResetDetected,
  mergeTaskDraft,
  validatePriceChange,
  proposePriceChange,
  formatTaskBlock,
  TaskStore,
  createTask,
} = require('../lib/assistant/tasks.js');

test('scope change: genuine resets are detected', () => {
  assert.equal(scopeResetDetected('Forget the shoes. I want to sell a blender instead.'), true);
  assert.equal(scopeResetDetected('Never mind, start over.'), true);
  assert.equal(scopeResetDetected('Scratch that, list my generator.'), true);
  assert.equal(scopeResetDetected('I want to sell my shoes instead of the bag.'), true);
});

test('scope change: corrections and continuations are NOT resets', () => {
  assert.equal(scopeResetDetected('Actually, make it 70000.'), false);
  assert.equal(scopeResetDetected('Make the description shorter.'), false);
  assert.equal(scopeResetDetected('Change that price to 70k.'), false);
  assert.equal(scopeResetDetected('Find me iPhone under 200k.'), false);
  assert.equal(scopeResetDetected('Yes, go ahead.'), false);
  assert.equal(scopeResetDetected(''), false);
});

test('draft merge: corrections preserve unrelated fields', () => {
  const task = createTask('sell shoes');
  mergeTaskDraft(task, { title: 'Nike shoes', price: 75000, location: 'Lagos' });
  mergeTaskDraft(task, { price: 70000 }); // "actually, make it 70k"
  assert.deepEqual(task.adDraft, { title: 'Nike shoes', price: 70000, location: 'Lagos' });
});

test('draft merge: empty values never clobber collected fields', () => {
  const task = createTask('sell shoes');
  mergeTaskDraft(task, { title: 'Nike shoes' });
  mergeTaskDraft(task, { title: '', price: null, location: undefined });
  assert.deepEqual(task.adDraft, { title: 'Nike shoes' });
});

test('price validation: rejects bad input, rounds decimals, detects no-op', () => {
  assert.equal(validatePriceChange(75000, -5).ok, false);
  assert.equal(validatePriceChange(75000, 'free').ok, false);
  assert.equal(validatePriceChange(75000, 99999999999).ok, false);
  assert.deepEqual(validatePriceChange(70000, 70000), { ok: true, unchanged: true, price: 70000 });
  assert.deepEqual(validatePriceChange(75000, 70000.4), { ok: true, unchanged: false, price: 70000 });
  assert.deepEqual(validatePriceChange(75000, 0), { ok: true, unchanged: false, price: 0 });
});

test('price proposal: first call asks for confirmation, never executes', () => {
  const p = proposePriceChange({ postId: 'abc123', title: 'Nike shoes', currentPrice: 75000 }, 70000);
  assert.equal(p.success, true);
  assert.equal(p.requiresConfirmation, true);
  assert.equal(p.postId, 'abc123');
  assert.equal(p.currentPrice, 75000);
  assert.equal(p.newPrice, 70000);
  assert.match(p.message, /75/) ;
  const bad = proposePriceChange({ postId: 'abc123', title: 'X', currentPrice: 1 }, -2);
  assert.equal(bad.success, false);
  assert.equal(bad.code, 'BAD_PRICE');
});

test('task store: create, touch, TTL expiry, reset', () => {
  const store = new TaskStore(1000);
  const t = store.getOrCreate('u1', 'sell shoes');
  assert.equal(t.goal, 'sell shoes');
  assert.equal(store.getOrCreate('u1', 'other').goal, 'sell shoes'); // same task kept
  t.updatedAt = Date.now() - 2000; // force expiry
  assert.equal(store.get('u1'), null);
  const r = store.reset('u1', 'sell blender');
  assert.equal(r.goal, 'sell blender');
  assert.deepEqual(r.adDraft, {});
});

test('prompt block: reflects goal, draft and last results honestly', () => {
  assert.equal(formatTaskBlock(null), 'None yet.');
  const task = createTask('sell shoes');
  mergeTaskDraft(task, { price: 70000 });
  task.lastSearch = { tool: 'get_my_listings', count: 3 };
  const block = formatTaskBlock(task);
  assert.match(block, /sell shoes/);
  assert.match(block, /price=70000/);
  assert.match(block, /get_my_listings x3/);
});
