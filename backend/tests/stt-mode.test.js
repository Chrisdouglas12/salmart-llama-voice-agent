/**
 * Keyless tests for the speech-to-text request shape.
 *
 * The app records one push-to-talk clip per turn, so the request must use
 * Meta's PUSH_TO_TALK mode (single turn) rather than making the model search
 * for turn edges inside a clip the user already finished. No network: fetch is
 * stubbed and the audio is accepted as-is.
 *
 * Run: node --test tests/stt-mode.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Set before require so dotenv cannot override them from a local .env.
process.env.META_API_KEY = 'test-key';
process.env.STT_API_KEY = 'test-key';
process.env.STT_MODEL = 'muse-voice-transcribe-1.0';

/** Minimal RIFF/WAVE: mono, 16-bit PCM, 16 kHz, a few silent samples. */
function metaWav(samples = 160) {
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);       // fmt chunk size
  header.writeUInt16LE(1, 20);        // PCM
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(16000, 24);    // sample rate
  header.writeUInt32LE(16000 * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);        // block align
  header.writeUInt16LE(16, 34);       // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Stub fetch and return the JSON request part it was sent. */
function captureRequest() {
  const original = global.fetch;
  const seen = {};
  global.fetch = async (_url, init) => {
    const form = init.body;
    seen.request = JSON.parse(await form.get('request').text());
    seen.accept = init.headers?.Accept;
    return new Response(JSON.stringify({ transcript: 'hello there' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { seen, restore: () => { global.fetch = original; } };
}

let config = null;
let transcribeAudio = null;
try {
  config = require('../lib/assistant/config').config;
  transcribeAudio = require('../lib/assistant/llama').transcribeAudio;
} catch (e) {
  // The slim submission extract omits server runtime dependencies.
  if (e?.code !== 'MODULE_NOT_FOUND') throw e;
}
const skip = config && transcribeAudio ? false : 'runtime dependencies omitted in this extract';

test('stt: a finished clip is transcribed as one PUSH_TO_TALK turn', { skip }, async () => {
  assert.equal(config.stt.mode, 'PUSH_TO_TALK');
  assert.equal(config.stt.timeoutMs, 25000);

  const { seen, restore } = captureRequest();
  try {
    const text = await transcribeAudio({ buffer: metaWav(), mimetype: 'audio/wav' });
    assert.equal(text, 'hello there');
    assert.equal(seen.request.mode, 'PUSH_TO_TALK');
    assert.equal(seen.request.model, 'muse-voice-transcribe-1.0');
    assert.equal(seen.request.audioEncoding, 'WAV');
    assert.equal(seen.accept, 'application/json');
  } finally {
    restore();
  }
});

test('stt: an explicit mode still wins for a multi-turn recording', { skip }, async () => {
  const { seen, restore } = captureRequest();
  try {
    await transcribeAudio({ buffer: metaWav(), mimetype: 'audio/wav', mode: 'ENDPOINTING' });
    assert.equal(seen.request.mode, 'ENDPOINTING');
  } finally {
    restore();
  }
});
