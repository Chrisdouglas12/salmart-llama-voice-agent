'use strict';

/*
 Keyless tests for AI metrics sanitisation and aggregation.
 Run: node --test tests/ai-metrics.test.js
 No Mongo connection is opened: the schema is declared at import time and the
 functions under test are pure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const metrics = require('../services/ai/metrics');

test('metrics: free text is never stored', () => {
  const doc = metrics.sanitize({
    kind: 'turn',
    ok: true,
    message: 'my password is hunter2',
    reply: 'Sure, Ada at ada@example.com',
    summary: 'Change "iPhone" to ₦70,000',
    preview: 'seller phone 08012345678',
    messageChars: 24,
    replyChars: 30,
    latencyMs: 812,
    llmMs: 700,
    toolMs: 100,
    screen: 'create_ad',
    platform: 'android',
    tools: [{
      name: 'prepareAdForm',
      ok: true,
      code: 'OK',
      ms: 12,
      summary: 'iPhone 13',
      preview: 'nope',
    }],
  });

  const json = JSON.stringify(doc);
  assert.ok(!json.includes('hunter2'));
  assert.ok(!json.includes('ada@example.com'));
  assert.ok(!json.includes('iPhone'));
  assert.ok(!json.includes('08012345678'));

  assert.equal(doc.messageChars, 24);
  assert.equal(doc.replyChars, 30);
  assert.equal(doc.latencyMs, 812);
  assert.equal(doc.tools[0].name, 'prepareAdForm');
  assert.equal(doc.tools[0].ms, 12);
  assert.equal(doc.tools[0].summary, undefined);
});

test('metrics: only known kinds/actions are accepted', () => {
  assert.equal(metrics.sanitize({ kind: 'other', ok: true }), null);
  assert.equal(metrics.sanitize(null), null);

  const action = metrics.sanitize({ kind: 'action', action: 'execute-everything', ok: false });
  assert.equal(action.action, null);

  const confirm = metrics.sanitize({ kind: 'action', action: 'confirm', ok: true });
  assert.equal(confirm.action, 'confirm');
});

test('metrics: negative and non-finite numbers are dropped', () => {
  const doc = metrics.sanitize({
    kind: 'turn', ok: true, latencyMs: -1, llmMs: Number.NaN, toolMs: 'x',
  });
  assert.equal(doc.latencyMs, undefined);
  assert.equal(doc.llmMs, undefined);
  assert.equal(doc.toolMs, undefined);
});

test('metrics: summary reports latency, errors, tools, and actions', () => {
  const rows = [
    {
      kind: 'turn', ok: true, latencyMs: 100, stopReason: 'final', anonymous: true,
      platform: 'android', screen: 'home',
      tools: [{ name: 'searchProducts', ok: true }],
    },
    {
      kind: 'turn', ok: true, latencyMs: 300, stopReason: 'final', anonymous: false,
      platform: 'ios', screen: 'chat',
      tools: [{ name: 'searchProducts', ok: false, code: 'TOOL_FAILED' }, { name: 'navigateToScreen', ok: true }],
    },
    {
      kind: 'turn', ok: false, latencyMs: 200, stopReason: 'error', errorCode: 'TURN_FAILED',
      anonymous: false,
    },
    { kind: 'action', action: 'confirm', ok: true, latencyMs: 50 },
    { kind: 'action', action: 'cancel', ok: false, latencyMs: 20 },
  ];

  const out = metrics.summarize(rows, { from: 'a', to: 'b', days: 7 });

  assert.equal(out.totals.turns, 3);
  assert.equal(out.totals.okTurns, 2);
  assert.equal(out.totals.failedTurns, 1);
  assert.equal(out.totals.anonymousTurns, 1);
  assert.equal(out.totals.errorRate, 0.3333);
  assert.equal(out.latencyMs.p50, 200);
  assert.equal(out.latencyMs.p95, 300);
  assert.equal(out.latencyMs.max, 300);
  assert.equal(out.stops.final, 2);
  assert.equal(out.errorCodes.TURN_FAILED, 1);
  assert.equal(out.errorCodes.TOOL_FAILED, 1);
  assert.equal(out.tools.searchProducts.calls, 2);
  assert.equal(out.tools.searchProducts.errors, 1);
  assert.equal(out.tools.navigateToScreen.calls, 1);
  assert.deepEqual(out.actions.confirm, { ok: 1, errors: 0 });
  assert.deepEqual(out.actions.cancel, { ok: 0, errors: 1 });

  assert.ok(!JSON.stringify(out).includes('message'));
});
