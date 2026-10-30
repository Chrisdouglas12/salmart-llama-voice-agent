// scripts/muse-diag.js
//
// Runtime diagnostic for "Meta works locally but not on Render".
// Run: `node scripts/muse-diag.js` (loads .env) or require('./muse-diag')
// and call museDiag() from a route/console. Never prints the API key —
// only a fingerprint (length + last 4 chars) so you can compare the Render
// key against your local key without pasting either.
//
// Env names match lib/assistant/config.js exactly:
//   META_API_KEY, META_API_BASE (default https://api.meta.ai/v1),
//   MODEL_BRAIN / META_MODEL, MODEL_BRAIN_FALLBACK,
//   META_TIMEOUT_MS, META_REASONING_EFFORT,
//   HTTPS_PROXY / HTTP_PROXY (presence only, never the value).

'use strict';

const dns = require('dns').promises;

const trimSlash = (v) => String(v || '').replace(/\/+$/, '');
const cleanModel = (v) => String(v || '').trim().replace(/^['"]+|['"]+$/g, '').trim();

function fingerprint(key) {
  if (!key) return null;
  return { length: key.length, last4: key.slice(-4), quoted: /^['"]/.test(key) || /['"]$/.test(key) };
}

async function timedFetch(url, { timeoutMs = 15000, ...opts } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function museDiag() {
  const base = trimSlash(process.env.META_API_BASE || 'https://api.meta.ai/v1');
  const key = String(process.env.META_API_KEY || '').trim();
  const brain = cleanModel(process.env.MODEL_BRAIN)
    || cleanModel(process.env.META_MODEL)
    || 'muse-spark-1.3';
  const fallback = cleanModel(process.env.MODEL_BRAIN_FALLBACK) || 'muse-spark-1.2';
  const timeoutMs = Number(process.env.META_TIMEOUT_MS || 15000);

  const out = {
    node: process.version,
    render: !!process.env.RENDER,
    base,
    key: key ? fingerprint(key) : null,
    keyPresent: !!key,
    models: { brain, fallback },
    proxy: {
      // Presence only — a proxy value can itself contain credentials.
      https: !!(process.env.HTTPS_PROXY || process.env.https_proxy),
      http: !!(process.env.HTTP_PROXY || process.env.http_proxy),
    },
  };

  if (!key) {
    out.modelsSkipped = 'META_API_KEY is empty — set it in the Render dashboard (Environment tab) and redeploy.';
    console.log('[muse-diag]', JSON.stringify(out));
    return out;
  }

  let host = null;
  try {
    host = new URL(base).hostname;
  } catch (e) {
    out.baseErr = `META_API_BASE is not a URL: ${base}`;
    console.log('[muse-diag]', JSON.stringify(out));
    return out;
  }

  try {
    out.ipv4 = await dns.resolve4(host);
  } catch (e) { out.ipv4Err = e.code || e.message; }
  try {
    out.ipv6 = await dns.resolve6(host);
  } catch (e) { out.ipv6Err = e.code || e.message; }

  try {
    const r = await timedFetch('https://api.ipify.org', { timeoutMs: 10000 });
    out.egressIp = (await r.text()).trim();
  } catch (e) {
    out.egressErr = e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message);
  }

  // 1) /models — the provider's own list. This is what llama.js reads first;
  // a 401 here means the Render key is wrong/revoked, a timeout/DNS error
  // means egress, and a 404 means META_API_BASE points at the wrong host.
  try {
    const r = await timedFetch(`${base}/models`, {
      timeoutMs,
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await r.text();
    let ids = null;
    try {
      const json = JSON.parse(body);
      const list = Array.isArray(json.data) ? json.data : [];
      ids = list.map((m) => m.id || m.name).filter(Boolean).slice(0, 20);
    } catch (_e) { /* non-JSON body: keep the preview below */ }
    out.modelsEndpoint = {
      status: r.status,
      ids,
      brainListed: ids ? ids.includes(brain) : null,
      bodyPreview: body.slice(0, 300),
    };
  } catch (e) {
    out.modelsErr = {
      code: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message),
      hint: 'DNS/timeout here = Render cannot reach api.meta.ai (egress or proxy).',
    };
  }

  // 2) Minimal chat completion with the exact brain model config.js resolves.
  // Skipped when /models already failed: the chat call would fail the same way.
  if (!out.modelsErr && out.modelsEndpoint && out.modelsEndpoint.status === 200) {
    try {
      const r = await timedFetch(`${base}/chat/completions`, {
        timeoutMs,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: brain,
          messages: [{ role: 'user', content: 'Reply with the word ok.' }],
          max_tokens: 8,
        }),
      });
      const body = await r.text();
      out.chatProbe = { status: r.status, model: brain, bodyPreview: body.slice(0, 300) };
    } catch (e) {
      out.chatErr = { code: e.name === 'AbortError' ? 'timeout' : (e.cause?.code || e.message) };
    }
  } else {
    out.chatSkipped = 'chat probe skipped because /models did not return 200.';
  }

  console.log('[muse-diag]', JSON.stringify(out));
  return out;
}

if (require.main === module) {
  // `node scripts/muse-diag.js` — load .env like app boot does.
  try {
    require('dotenv').config();
  } catch (_e) { /* dotenv optional on Render */ }
  museDiag().then(
    () => {},
    (e) => { console.error('[muse-diag] failed:', e?.message || e); process.exitCode = 1; },
  );
}

module.exports = { museDiag };
