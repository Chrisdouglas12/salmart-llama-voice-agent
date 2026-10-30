'use strict';

/**
 * Keyless tests for the muse chat model fallback.
 *
 * A deploy whose MODEL_BRAIN is stale/mistyped makes Meta answer
 * 404 `{"error":{"code":"model_not_found"}}`. The client must recover on its
 * own instead of failing every assistant turn.
 *
 * Run: node --test tests/llama-model-fallback.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.META_API_KEY = process.env.META_API_KEY || 'test-key';
process.env.MODEL_BRAIN = 'not-a-real-model';
process.env.MODEL_BRAIN_FALLBACK = 'also-not-real';
process.env.META_TIMEOUT_MS = process.env.META_TIMEOUT_MS || '5000';

const realFetch = global.fetch;

const AVAILABLE = ['muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1', 'muse-wonder-1.0', 'muse-voice-transcribe-1.0'];

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

/** Stub fetch: /models lists AVAILABLE, chat only accepts a listed id. */
function stubProvider({ chatCalls = [] } = {}) {
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/models')) {
      return jsonResponse(200, { data: AVAILABLE.map(id => ({ id })) });
    }
    const body = JSON.parse(init.body);
    chatCalls.push(body.model);
    if (!AVAILABLE.includes(body.model)) {
      return jsonResponse(404, {
        error: { code: 'model_not_found', message: 'The requested model was not found.' },
      });
    }
    return jsonResponse(200, {
      model: body.model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
    });
  };
  return chatCalls;
}

test.after(() => { global.fetch = realFetch; });

function freshLlama() {
  delete require.cache[require.resolve('../lib/assistant/llama')];
  const mod = require('../lib/assistant/llama');
  mod.__resetModelState();
  return mod;
}

test('llama: an unknown MODEL_BRAIN is replaced with a model /models advertises', async () => {
  const chatCalls = stubProvider();
  const { chatCompletion } = freshLlama();

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const res = await chatCompletion({ messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(res.message.content, 'pong');
    assert.equal(res.model, 'muse-spark-1.3');
  } finally {
    console.warn = realWarn;
  }

  assert.deepEqual(chatCalls, ['not-a-real-model', 'muse-spark-1.3']);
  assert.ok(
    warnings.some(w => w.includes('not-a-real-model') && w.includes('muse-spark-1.3')),
    'the retry must be logged with both ids',
  );
});

test('llama: the working id is reused, so later turns skip the dead model', async () => {
  const chatCalls = stubProvider();
  const { chatCompletion } = require('../lib/assistant/llama');

  await chatCompletion({ messages: [{ role: 'user', content: 'again' }] });
  await chatCompletion({ messages: [{ role: 'user', content: 'and again' }] });

  assert.deepEqual(chatCalls, ['muse-spark-1.3', 'muse-spark-1.3']);
});

test('llama: a 404 that is not model_not_found is surfaced, not retried', async () => {
  const chatCalls = [];
  global.fetch = async (url, init) => {
    chatCalls.push(JSON.parse(init.body).model);
    return jsonResponse(404, { error: { code: null, message: 'Not Found' } });
  };
  const { chatCompletion } = freshLlama();

  await assert.rejects(
    () => chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'some-other-model' }),
    (err) => err.status === 404 && err.message.includes('[model=some-other-model]'),
  );
  assert.deepEqual(chatCalls, ['some-other-model']);
});

test('llama: when the provider rejects every id, the error lists everything tried', async () => {
  const chatCalls = [];
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/models')) return jsonResponse(200, { data: [] });
    chatCalls.push(JSON.parse(init.body).model);
    return jsonResponse(404, {
      error: { code: 'model_not_found', message: 'The requested model was not found.' },
    });
  };
  // Fresh module: no cached /models list, no remembered working id.
  const { chatCompletion } = freshLlama();

  await assert.rejects(
    () => chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'ghost-model' }),
    (err) => err.status === 404 && /\[tried: ghost-model/.test(err.message),
  );
  assert.equal(chatCalls[0], 'ghost-model');
  assert.ok(chatCalls.length > 2, `expected a full candidate walk, got ${chatCalls.join(', ')}`);
});

test('llama: a 200 /models with no ids still walks the known list and says why', async () => {
  const chatCalls = [];
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.endsWith('/models')) return jsonResponse(200, { data: [] });
    chatCalls.push(JSON.parse(init.body).model);
    return jsonResponse(404, {
      error: { code: 'model_not_found', message: 'The requested model was not found.' },
    });
  };
  const mod = freshLlama();

  await assert.rejects(
    () => mod.chatCompletion({ messages: [{ role: 'user', content: 'hi' }], model: 'ghost-model' }),
    (err) => err.status === 404 && /no model ids/.test(err.message),
  );
  // Empty list must not strand us: the known ids are still tried in order.
  assert.deepEqual(chatCalls.slice(0, 3), ['ghost-model', 'also-not-real', 'muse-spark-1.3']);
  assert.match(mod.activeBrainModel().modelsError, /no model ids/);
});

test('llama: chatSelfTest proves the deploy machine reaches the model', async () => {
  global.fetch = async () => jsonResponse(200, {
    model: 'muse-spark-1.3',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
  });
  const { chatSelfTest } = freshLlama();
  const r = await chatSelfTest();
  assert.equal(r.ok, true);
  assert.equal(r.model, 'muse-spark-1.3');
});

test('llama: chatSelfTest reports a deploy-side 404 without throwing', async () => {
  global.fetch = async () => jsonResponse(404, {
    error: { code: 'model_not_found', message: 'The requested model was not found.' },
  });
  const { chatSelfTest } = freshLlama();
  const r = await chatSelfTest();
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('llama: verifyBrainModel reports a configured id Meta does not serve', async () => {
  stubProvider();
  const { verifyBrainModel } = freshLlama();

  const r = await verifyBrainModel();
  assert.equal(r.ok, false);
  assert.equal(r.model, 'not-a-real-model');
  assert.equal(r.fallback, 'muse-spark-1.3');
  assert.ok(r.available.includes('muse-spark-1.3'));
});

test('llama: verifyBrainModel stays quiet when /models cannot be read', async () => {
  global.fetch = async () => { throw new Error('offline'); };
  const { verifyBrainModel } = freshLlama();

  const r = await verifyBrainModel();
  assert.equal(r.ok, null);
  assert.match(r.reason, /\/models/);
});

test('llama: an answer cut off by the reasoning budget is retried with more tokens', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ model: body.model, max_tokens: body.max_tokens });
    if (body.max_tokens < 3200) {
      return jsonResponse(200, {
        model: body.model,
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }],
        usage: { completion_tokens_details: { reasoning_tokens: body.max_tokens } },
      });
    }
    return jsonResponse(200, {
      model: body.model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } }],
    });
  };
  const { chatCompletion } = freshLlama();

  const res = await chatCompletion({ messages: [{ role: 'user', content: 'ping' }], model: 'muse-spark-1.3' });
  assert.equal(res.message.content, 'pong');
  assert.deepEqual(calls.map(c => c.max_tokens), [1600, 3200]);
});
