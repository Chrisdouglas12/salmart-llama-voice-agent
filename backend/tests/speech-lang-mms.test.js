'use strict';

/**
 * Keyless tests for same-language voice: speechLang detection and the
 * Meta MMS TTS contract (fetch stubbed, no network, no HF key needed).
 *
 * Run: node --test tests/speech-lang-mms.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectSpeechLang, normalizeSpeechLang, LANGS } = require('../lib/assistant/speechLang');

test('speechLang: empty or English text is eng', () => {
  assert.equal(detectSpeechLang(''), 'eng');
  assert.equal(detectSpeechLang('   '), 'eng');
  assert.equal(detectSpeechLang('Find me an iPhone under 200k'), 'eng');
  assert.equal(detectSpeechLang('I want to sell my Toyota Camry in Lagos'), 'eng');
});

test('speechLang: Yoruba diacritics decide immediately', () => {
  assert.equal(detectSpeechLang('Mo fẹ́ ra ọkọ̀'), 'yor');
  assert.equal(detectSpeechLang('Ẹ ṣeun'), 'yor');
});

test('speechLang: Igbo diacritics decide immediately', () => {
  assert.equal(detectSpeechLang('Daalụ, achọrọ m ịzụta ụgbọ ala'), 'ibo');
});

test('speechLang: Hausa diacritics decide immediately', () => {
  assert.equal(detectSpeechLang('Ina son ƙaramin waya'), 'hau');
});

test('speechLang: distinctive words vote without diacritics', () => {
  assert.equal(detectSpeechLang('Sannu, ina sayar da shinkafa? Lafiya lau'), 'hau');
  assert.equal(detectSpeechLang('Kedu ka ị mere? Biko help me'), 'ibo');
  assert.equal(detectSpeechLang('Kaabo, bawo ni? Mo fe ra bata'), 'yor');
});

test('speechLang: ambiguous English stays eng', () => {
  // "ore" alone is an English word (iron ore) — must not flip to Yoruba.
  assert.equal(detectSpeechLang('I sell iron ore in Jos'), 'eng');
  // A lone ọ with no other signal is too ambiguous to act on.
  assert.equal(detectSpeechLang('The ọkọ is here'), 'eng');
});

test('speechLang: hints normalize, garbage is null', () => {
  assert.deepEqual(LANGS, ['eng', 'yor', 'hau', 'ibo']);
  assert.equal(normalizeSpeechLang('yor'), 'yor');
  assert.equal(normalizeSpeechLang('Yoruba'), 'yor');
  assert.equal(normalizeSpeechLang('HA'), 'hau');
  assert.equal(normalizeSpeechLang('igbo'), 'ibo');
  assert.equal(normalizeSpeechLang('en'), 'eng');
  assert.equal(normalizeSpeechLang('french'), null);
  assert.equal(normalizeSpeechLang(''), null);
  assert.equal(normalizeSpeechLang(null), null);
});

test('mmsTts: posts to the per-language model and returns the speak contract', async () => {
  process.env.HF_API_KEY = 'test-hf-key';
  process.env.TTS_MODE = 'mms';
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization });
    return {
      ok: true,
      headers: { get: (k) => (k === 'content-type' ? 'audio/wav' : null) },
      arrayBuffer: async () => new Uint8Array([82, 73, 70, 70]).buffer,
    };
  };
  try {
    delete require.cache[require.resolve('../lib/assistant/mmsTts')];
    const { metaTTS } = require('../lib/assistant/mmsTts');
    const out = await metaTTS('Sannu sannu, lafiya lau?', { lang: 'hau' });
    assert.equal(out.provider, 'meta-mms');
    assert.equal(out.voice, 'hau');
    assert.equal(out.model, 'facebook/mms-tts-hau');
    assert.equal(out.mimeType, 'audio/wav');
    assert.ok(out.audio.length > 0);
    assert.ok(calls[0].url.endsWith('/facebook/mms-tts-hau'));
    assert.equal(calls[0].auth, 'Bearer test-hf-key');
  } finally {
    global.fetch = realFetch;
    delete process.env.HF_API_KEY;
    delete process.env.TTS_MODE;
  }
});

test('mmsTts: detects the voice from the text when no hint is given', async () => {
  process.env.HF_API_KEY = 'test-hf-key';
  process.env.TTS_MODE = 'mms';
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push(String(url));
    return {
      ok: true,
      headers: { get: () => 'audio/flac' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };
  try {
    delete require.cache[require.resolve('../lib/assistant/mmsTts')];
    const { metaTTS } = require('../lib/assistant/mmsTts');
    const out = await metaTTS('Mo fẹ́ ra ọkọ̀');
    assert.equal(out.voice, 'yor');
    assert.ok(calls[0].endsWith('/facebook/mms-tts-yor'));
    assert.equal(out.mimeType, 'audio/flac');
  } finally {
    global.fetch = realFetch;
    delete process.env.HF_API_KEY;
    delete process.env.TTS_MODE;
  }
});

test('mmsTts: empty text and missing key throw the route contract codes', async () => {
  delete require.cache[require.resolve('../lib/assistant/mmsTts')];
  const { metaTTS, mmsConfigured } = require('../lib/assistant/mmsTts');
  delete process.env.HF_API_KEY;
  delete process.env.HUGGINGFACE_API_KEY;
  await assert.rejects(() => metaTTS('   '), /empty_text/);
  await assert.rejects(() => metaTTS('hello'), /tts_not_configured/);
  assert.equal(mmsConfigured(), false);
});

test('mmsTts: device voice is the default, so /speak answers without a network call', async () => {
  // The hosted Meta MMS route is gone (HF retired it). Default mode must not
  // pretend otherwise: no key present, no fetch, immediate TTS_UNAVAILABLE so
  // the app uses the phone's own voice.
  process.env.HF_API_KEY = 'test-hf-key';
  delete process.env.TTS_MODE;
  const realFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should not be called'); };
  try {
    delete require.cache[require.resolve('../lib/assistant/mmsTts')];
    const { metaTTS, mmsConfigured } = require('../lib/assistant/mmsTts');
    await assert.rejects(() => metaTTS('hello'), /tts_not_configured/);
    assert.equal(called, false, 'device mode must not call an inference host');
    assert.equal(mmsConfigured(), false);
  } finally {
    global.fetch = realFetch;
    delete process.env.HF_API_KEY;
    delete process.env.TTS_MODE;
  }
});

test('mmsTts: an HF error status surfaces with the status attached', async () => {
  process.env.HF_API_KEY = 'test-hf-key';
  process.env.TTS_MODE = 'mms';
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized', headers: { get: () => null } });
  try {
    delete require.cache[require.resolve('../lib/assistant/mmsTts')];
    const { metaTTS } = require('../lib/assistant/mmsTts');
    await assert.rejects(() => metaTTS('hello'), (e) => e.status === 401);
  } finally {
    global.fetch = realFetch;
    delete process.env.HF_API_KEY;
    delete process.env.TTS_MODE;
  }
});
