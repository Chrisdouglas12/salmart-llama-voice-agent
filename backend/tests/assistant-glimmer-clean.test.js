/* Aya eval — Glimmer client + background-clean contract (Phase 5).
 *
 * Unit-testable without keys, network, Mongo or sharp: fetch is stubbed,
 * sharp loads lazily only on the composite path (never exercised here).
 * Run: node --test tests/assistant-glimmer-clean.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { glimmerCfg, glimmerConfigured, glimmerChat } = require('../lib/assistant/glimmer.js');
const { bgCfg, bgConfigured, fetchRgba } = require('../lib/assistant/clean.js');

function withEnv(patch, fn) {
  const keep = {};
  for (const k of Object.keys(patch)) {
    keep[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(patch)) {
        if (keep[k] === undefined) delete process.env[k];
        else process.env[k] = keep[k];
      }
    });
}

test('glimmer: disabled without key, enabled with key', async () => {
  await withEnv({ TOGETHER_API_KEY: undefined }, () => {
    assert.equal(glimmerConfigured(), false);
  });
  await withEnv({ TOGETHER_API_KEY: 'tk-test', GLIMMER_MODEL: 'm' }, () => {
    assert.equal(glimmerConfigured(), true);
  });
});

test('glimmer: throws before any network without key', async () => {
  await withEnv({ TOGETHER_API_KEY: undefined }, async () => {
    await assert.rejects(() => glimmerChat({ messages: [] }), /glimmer_not_configured/);
  });
});

test('glimmer: posts OpenAI-shaped body with Meta best practices', async () => {
  let seen = null;
  const stubFetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Done.', tool_calls: [] } }] }) };
  };
  const realFetch = global.fetch;
  global.fetch = stubFetch;
  try {
    await withEnv({ TOGETHER_API_KEY: 'tk-test', GLIMMER_MODEL: 'm-glimmer' }, async () => {
      const out = await glimmerChat({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 't' } }],
      });
      assert.equal(out.model, 'm-glimmer');
      assert.equal(out.raw.choices[0].message.content, 'Done.');
    });
  } finally {
    global.fetch = realFetch;
  }
  assert.match(seen.url, /chat\/completions$/);
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.model, 'm-glimmer');
  assert.equal(body.temperature, 1.0);
  assert.equal(body.top_p, 0.95);
  assert.ok(Array.isArray(body.tools));
  assert.match(String(seen.opts.headers.Authorization), /^Bearer /);
});

test('glimmer: http errors surface with status', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  try {
    await withEnv({ TOGETHER_API_KEY: 'tk-test' }, async () => {
      await assert.rejects(() => glimmerChat({ messages: [] }), /glimmer_http_401/);
    });
  } finally {
    global.fetch = realFetch;
  }
});

test('bgclean: disabled without url/key, contract rejects bad input offline', async () => {
  await withEnv({ BG_API_URL: undefined, BG_API_KEY: undefined }, async () => {
    assert.equal(bgConfigured(), false);
    assert.equal(bgCfg().label, 'bg-matting');
    await assert.rejects(() => fetchRgba({ buffer: Buffer.from([1]), mime: 'image/jpeg' }), /bgclean_not_configured/);
  });
  await withEnv({ BG_API_URL: 'https://bg.example/clean', BG_API_KEY: 'k' }, async () => {
    assert.equal(bgConfigured(), true);
    await assert.rejects(() => fetchRgba({ buffer: Buffer.from([1]), mime: 'image/gif' }), /unsupported_image_type/);
    await assert.rejects(() => fetchRgba({ buffer: Buffer.alloc(0), mime: 'image/jpeg' }), /empty_image/);
  });
});

test('bgclean: non-image responses are rejected, never trusted', async () => {
  const stubFetch = async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
  });
  await withEnv({ BG_API_URL: 'https://bg.example/clean', BG_API_KEY: 'k' }, async () => {
    await assert.rejects(
      () => fetchRgba({ buffer: Buffer.from([1, 2, 3]), mime: 'image/jpeg' }, stubFetch),
      /bgclean_bad_response/,
    );
  });
});
