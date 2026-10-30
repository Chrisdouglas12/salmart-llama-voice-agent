'use strict';

/**
 * Keyless tests for the Google auth handoff block.
 *
 * The URL builder itself lives in tools/authTools.js (which needs the User
 * model); these tests cover the pure platform normaliser and the structured
 * block gate that decides whether a URL is allowed to become tappable.
 *
 * Run: node --test tests/ai-auth-url.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildStructured, safeAuthUrl } = require('../services/ai/structuredBlocks');
const { normalizePlatform, platformFromContext } = require('../services/ai/platform');

test('auth: platform comes from the tool arg or the client screen context', () => {
  assert.equal(normalizePlatform('ANDROID'), 'android');
  assert.equal(normalizePlatform(' ios '), 'ios');
  assert.equal(normalizePlatform('web'), null);
  assert.equal(normalizePlatform(undefined), null);

  assert.equal(platformFromContext('ios', { platform: 'android' }), 'ios');
  assert.equal(platformFromContext(undefined, { platform: 'android' }), 'android');
  assert.equal(platformFromContext(undefined, {}), null);
});

test('auth: a valid initiation URL becomes one auth_url block', () => {
  const blocks = buildStructured([{
    name: 'startGoogleAuthentication',
    ok: true,
    data: {
      authMethod: 'google',
      platform: 'android',
      url: 'https://app.salmartonline.com.ng/auth/google?source=mobile&platform=android&ref=FRIEND10',
    },
  }]);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'auth_url');
  assert.equal(blocks[0].authMethod, 'google');
  assert.equal(blocks[0].platform, 'android');
  assert.match(blocks[0].url, /^https:\/\/app\.salmartonline\.com\.ng\/auth\/google\?/);
});

test('auth: forged schemes, foreign paths, and credentials are dropped', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://evil.example.com/steal',
    'https://evil.example.com/auth/google/../../steal',
    'https://user:pass@app.salmartonline.com.ng/auth/google',
    'not a url',
  ]) {
    assert.equal(safeAuthUrl(url), null, url);
    assert.deepEqual(buildStructured([{
      name: 'startGoogleAuthentication',
      ok: true,
      data: { platform: 'android', url },
    }]), [], url);
  }
});

test('auth: a failed tool result emits nothing', () => {
  assert.deepEqual(buildStructured([{
    name: 'startGoogleAuthentication',
    ok: false,
    code: 'TOOL_FAILED',
    data: null,
  }]), []);
});
