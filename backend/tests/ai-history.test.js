'use strict';

/**
 * Keyless tests for history hygiene: orphaned tool_calls pairs must never
 * reach the model, or one timed-out turn bricks the whole conversation
 * (`400 Missing tool response for tool_call_id(s)` on every later turn).
 *
 * Run: node --test tests/ai-history.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeHistory, toModelMessages } = require('../services/ai/history');

const asst = (content = '') => ({ role: 'assistant', content });
const user = (content) => ({ role: 'user', content });
const calls = (ids, content = '') => ({
  role: 'assistant', content, toolCalls: ids.map(id => ({ id, type: 'function', function: { name: 'searchProducts', arguments: '{}' } })),
});
const tool = (id, content = '{}') => ({ role: 'tool', content, toolCallId: id, name: 'searchProducts' });

test('history: clean pairs pass through untouched', () => {
  const msgs = [user('hi'), calls(['a']), tool('a'), asst('done')];
  const { messages, dropped } = sanitizeHistory(msgs);
  assert.equal(dropped, 0);
  assert.deepEqual(messages, msgs);
});

test('history: trailing orphan tool_calls from a dead turn is dropped', () => {
  const msgs = [user('hi'), calls(['a']), tool('a'), user('again'), calls(['b'])];
  const { messages, dropped } = sanitizeHistory(msgs);
  assert.equal(dropped, 1);
  assert.deepEqual(messages, [user('hi'), calls(['a']), tool('a'), user('again')]);
});

test('history: partially answered pairs are dropped whole', () => {
  const msgs = [user('hi'), calls(['a', 'b']), tool('a')];
  const { messages, dropped } = sanitizeHistory(msgs);
  assert.equal(dropped, 1);
  assert.deepEqual(messages, [user('hi')]);
});

test('history: stray tool messages without a pair are dropped', () => {
  const msgs = [tool('x'), user('hi'), asst('hello')];
  const { messages, dropped } = sanitizeHistory(msgs);
  assert.equal(dropped, 1);
  assert.deepEqual(messages, [user('hi'), asst('hello')]);
});

test('history: non-object entries are dropped, never crash the turn', () => {
  const { messages, dropped } = sanitizeHistory([user('hi'), null, 'junk', 42, asst('ok')]);
  assert.equal(dropped, 3);
  assert.deepEqual(messages, [user('hi'), asst('ok')]);
});

test('history: non-array input sanitizes to empty', () => {
  assert.deepEqual(sanitizeHistory(null), { messages: [], dropped: 0 });
  assert.deepEqual(sanitizeHistory('junk'), { messages: [], dropped: 0 });
});

test('history: toModelMessages emits the wire shape', () => {
  const out = toModelMessages([user('hi'), calls(['a']), tool('a')]);
  assert.deepEqual(out, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'searchProducts', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', name: 'searchProducts', content: '{}' },
  ]);
});

test('history: every emitted assistant tool_calls has all its responses', () => {
  // Property-style: mixed orphans in, valid pairs out.
  const msgs = [
    user('a'), calls(['1']), tool('1'),
    calls(['2']), // orphan: no preceding user needed, still dropped with nothing consumed
    user('b'), calls(['3', '4']), tool('3'), tool('4'), asst('done'),
    calls(['5']), tool('5'), tool('orphan-tool-without-pair opener'),
  ];
  const { messages } = sanitizeHistory(msgs);
  const wire = toModelMessages(messages);
  const pending = new Map();
  for (const m of wire) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const c of m.tool_calls) pending.set(c.id, (pending.get(c.id) || 0) + 1);
    }
    if (m.role === 'tool') {
      assert.ok(pending.get(m.tool_call_id) > 0, `tool ${m.tool_call_id} has no pair`);
      pending.set(m.tool_call_id, pending.get(m.tool_call_id) - 1);
    }
  }
  for (const [id, n] of pending) assert.equal(n, 0, `tool_call ${id} unanswered`);
});
