'use strict';

/* Fraud-filter tests: slang numerals (Naija spellings + Yoruba, with and
 * without diacritics) must trip the same gates as plain digits, while
 * innocent collisions ("wan", "hate", "ewa") must pass.
 * Run: node --test tests/chat-content-filter.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { scanMessage } = require('../routes/chatContentFilter.server.js');

const blocked = (text) => scanMessage(text).blocked;

test('slang account number is blocked', () => {
  // 10 digits in Naija spellings → same as 0123456789
  assert.equal(blocked('aza sero hate sero tiri wan tu tiri erin faif siks'), true);
  // Too short to be a number — stays unblocked.
  assert.equal(blocked('na sero hate sero tiri wan tu'), false);
});

test('slang phone number is blocked', () => {
  assert.equal(blocked('call me on sero hate sero tiri wan tu tiri erin faif siks'), true);
});

test('yoruba numerals with diacritics are blocked', () => {
  assert.equal(blocked('nọmba mi ni ẹẹta mẹẹta'), false); // too short
  assert.equal(blocked('nomba okan eji eta erin arun efa eje ejo esan ewa'), true);
  assert.equal(blocked('owo ẹẹsan ẹẹwà'), false); // too short
});

test('innocent collisions pass', () => {
  for (const text of [
    'i wan sell my phone',
    'i hate this network',
    'ewa and bread for sale',
    'tiri is not a word i know',
    'the price is negotiable',
  ]) {
    assert.equal(blocked(text), false, text);
  }
});

test('plain-digit gates still hold', () => {
  assert.equal(blocked('my account is 0123456789'), true);
  assert.equal(blocked('call 08031234567'), true);
  assert.equal(blocked('hello how are you'), false);
});
