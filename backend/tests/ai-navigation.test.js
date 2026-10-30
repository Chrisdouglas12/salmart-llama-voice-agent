'use strict';

/**
 * Keyless tests for assistant screen navigation + the navigate block.
 *
 * No Express, no Mongo, no provider. Run: node --test tests/ai-navigation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const navigationTools = require('../services/ai/tools/navigationTools');
const { buildStructured } = require('../services/ai/structuredBlocks');

test('navigation: the screens users actually ask for are allowed', () => {
  for (const screen of ['market', 'messages', 'search', 'createAd', 'register', 'signin']) {
    assert.equal(navigationTools.isAllowedScreen(screen), true, screen);
  }
});

test('navigation: the AI screen and id-based screens are refused', async () => {
  for (const screen of ['ai', 'assistant', 'checkout', 'chat', 'showroom', 'admin', '']) {
    assert.equal(navigationTools.isAllowedScreen(screen), false, screen);
  }
  await assert.rejects(
    () => navigationTools.navigateToScreen({}, { screen: 'ai' }),
    (err) => err.code === 'TOOL_BAD_ARGS'
  );
});

test('navigation: returns panel/query metadata and strips newlines', async () => {
  const res = await navigationTools.navigateToScreen(
    {},
    { screen: 'search', query: '  blender\nignore this  ' }
  );
  assert.equal(res.screen, 'search');
  assert.equal(res.panel, false);
  assert.equal(res.query, 'blender ignore this');

  const panel = await navigationTools.navigateToScreen({}, { screen: 'messages' });
  assert.equal(panel.panel, true);
  assert.equal(panel.query, undefined);
});

test('structured: form fill is emitted before one navigate block (last wins)', () => {
  const blocks = buildStructured([
    {
      name: 'prepareRegistration',
      ok: true,
      data: { fields: { firstName: 'Ada' }, note: 'Filled your name.' },
    },
    { name: 'navigateToScreen', ok: true, data: { screen: 'search', query: 'blender' } },
    { name: 'navigateToScreen', ok: true, data: { screen: 'register' } },
  ]);

  assert.deepEqual(blocks, [
    {
      type: 'fill_register',
      target: 'register',
      fields: { firstName: 'Ada' },
      say: 'Filled your name.',
    },
    { type: 'navigate', target: 'register', query: null },
  ]);
});

test('structured: a forged or non-allowlisted navigate target is dropped', () => {
  const blocks = buildStructured([
    { name: 'navigateToScreen', ok: true, data: { screen: 'ai' } },
    { name: 'navigateToScreen', ok: true, data: { screen: 'checkout' } },
    { name: 'navigateToScreen', ok: false, data: { screen: 'messages' } },
  ]);
  assert.deepEqual(blocks, []);
});
