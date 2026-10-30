'use strict';

/**
 * Keyless tests for persisted /api/ai task memory.
 *
 * Run: node --test tests/ai-task-state.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const taskState = require('../services/ai/taskState');

function adResult(fields) {
  return { name: 'prepareAdForm', ok: true, data: { fields, note: 'Filled.' } };
}

test('task: first message creates a goal with empty drafts', () => {
  const { task, reset } = taskState.beginTurn({ collectedInfo: null, message: 'I want to sell a blender' });

  assert.equal(reset, false);
  assert.equal(task.goal, 'I want to sell a blender');
  assert.deepEqual(task.adDraft, {});
  assert.deepEqual(task.drafts, { request: {}, profile: {}, register: {} });
  assert.equal(task.status, 'active');
  assert.ok(task.updatedAt > 0);
});

test('task: a correction keeps the draft; a scope reset drops it', () => {
  const first = taskState.beginTurn({ collectedInfo: null, message: 'Sell a blender' });
  taskState.applyToolResults(first.task, [adResult({ title: 'Blender', price: 12000 })]);

  const correction = taskState.beginTurn({
    collectedInfo: taskState.toCollectedInfo(null, first.task),
    message: 'Make it seventy thousand',
  });
  assert.equal(correction.reset, false);
  assert.equal(correction.task.adDraft.title, 'Blender');
  assert.equal(correction.task.adDraft.price, 12000);

  const reset = taskState.beginTurn({
    collectedInfo: taskState.toCollectedInfo(null, correction.task),
    message: 'Forget the blender, sell a generator instead',
  });
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.task.adDraft, {});
  assert.match(reset.task.goal, /generator/i);
});

test('task: ad fields merge without blank values clobbering earlier ones', () => {
  const { task } = taskState.beginTurn({ collectedInfo: null, message: 'Sell a phone' });
  taskState.applyToolResults(task, [adResult({ title: 'iPhone 13', price: 450000 })]);
  taskState.applyToolResults(task, [adResult({ title: '', price: undefined, location: 'Abuja' })]);

  assert.equal(task.adDraft.title, 'iPhone 13');
  assert.equal(task.adDraft.price, 450000);
  assert.equal(task.adDraft.location, 'Abuja');
});

test('task: registration stores names but never email, password, or phone', () => {
  const { task } = taskState.beginTurn({ collectedInfo: null, message: 'Help me register' });
  taskState.applyToolResults(task, [{
    name: 'prepareRegistration',
    ok: true,
    data: {
      fields: {
        firstName: 'Ada',
        lastName: 'Okafor',
        email: 'ada@example.com',
        password: 'hunter2',
        phone: '08012345678',
        referrer: 'FRIEND10',
      },
    },
  }]);

  assert.equal(task.drafts.register.firstName, 'Ada');
  assert.equal(task.drafts.register.lastName, 'Okafor');
  assert.equal(task.drafts.register.referrer, 'FRIEND10');
  assert.equal(task.drafts.register.email, undefined);
  assert.equal(task.drafts.register.password, undefined);
  assert.equal(task.drafts.register.phone, undefined);
  assert.equal(task.emailProvided, true);

  const block = taskState.buildPromptBlock(task);
  assert.ok(!block.includes('ada@example.com'));
  assert.ok(!block.includes('hunter2'));
  assert.ok(!block.includes('08012345678'));
  assert.match(block, /email already supplied/i);
});

test('task: search results are counted without storing the query', () => {
  const { task } = taskState.beginTurn({ collectedInfo: null, message: 'Find a blender' });
  taskState.applyToolResults(task, [{
    name: 'searchProducts',
    ok: true,
    data: { products: [{ title: 'A' }, { title: 'B' }], total: 2 },
  }]);

  assert.deepEqual(task.lastSearch, { tool: 'searchProducts', count: 2 });
  assert.deepEqual(Object.keys(task.lastSearch).sort(), ['count', 'tool']);
});

test('task: expired or malformed state is discarded', () => {
  assert.equal(taskState.normalizeTask(null), null);
  assert.equal(taskState.normalizeTask({ goal: 'x' }), null);
  assert.equal(taskState.normalizeTask({ goal: 'x', updatedAt: Date.now() - 31 * 60 * 1000 }), null);
  assert.equal(taskState.normalizeTask({ goal: '', adDraft: {}, updatedAt: Date.now() }), null);
});

test('task: a confirmation pauses the task and a reset clears the old action', () => {
  const { task } = taskState.beginTurn({ collectedInfo: null, message: 'Change the price' });
  taskState.finishTurn(task, { pendingConfirmation: { actionId: 'a1' } });
  assert.equal(task.status, 'awaiting_confirmation');
  assert.equal(taskState.persistedStatus(task), 'awaiting_confirmation');

  taskState.finishTurn(task, {});
  assert.equal(task.status, 'active');
});

test('task: collectedInfo keeps unrelated keys', () => {
  const { task } = taskState.beginTurn({ collectedInfo: null, message: 'Find a phone' });
  const info = taskState.toCollectedInfo({ language: 'en', lastIntent: 'search' }, task);
  assert.equal(info.language, 'en');
  assert.equal(info.lastIntent, 'search');
  assert.equal(info.task.goal, 'Find a phone');
});
