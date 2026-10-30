/* lib/assistant/mmsTts.js
 *
 * Spoken replies with Meta voices: facebook/mms-tts-* via the Hugging Face
 * Inference Providers router. Voice output only — no other provider involved.
 *
 * Status (checked Oct 2026): Hugging Face retired `api-inference.huggingface.co`
 * (DNS no longer resolves) and the current router answers
 * "Model not supported by provider hf-inference" for the MMS voice repos: they
 * have no hosted inference provider. So this path currently reports
 * `TTS_UNAVAILABLE` and the app speaks with the phone's own voice, which is
 * fully offline. The module stays wired for the moment a Meta MMS endpoint is
 * reachable (self-hosted base via HF_INFERENCE_BASE, or a provider that adds
 * the repos): no client or route change is needed.
 *
 * Contract matches the previous TTS return shape so the route and the
 * mobile client are unchanged:
 *   { audio: base64, mimeType, provider: 'meta-mms', model, voice }
 *
 * `voice` is the language code ('eng' | 'yor' | 'hau' | 'ibo'). The caller
 * passes the language detected from the user's own utterance (`lang`); when
 * it is missing or invalid we detect from the reply text, which degrades to
 * English for English replies.
 *
 * Env:
 *   TTS_MODE                            — 'device' (default) or 'mms'
 *   HF_API_KEY (or HUGGINGFACE_API_KEY) — required for TTS_MODE=mms
 *   HF_INFERENCE_BASE                   — override (e.g. a self-hosted MMS)
 *   MMS_TTS_MODEL_ENG/YOR/HAU/IBO       — override a voice model id
 *   TTS_TIMEOUT_MS (default 30000), TTS_MAX_CHARS (default 500)
 */

'use strict';

const { normalizeSpeechLang, detectSpeechLang } = require('./speechLang');

const HF_API_KEY = () => String(process.env.HF_API_KEY || process.env.HUGGINGFACE_API_KEY || '').trim();
// 'device' is the default because the hosted Meta MMS route does not exist
// today (see header). The app immediately uses the phone's own voice, with no
// pointless network round-trip on the first reply. Set TTS_MODE=mms when a
// reachable Meta MMS endpoint is configured.
const TTS_MODE = () => String(process.env.TTS_MODE || 'device').trim().toLowerCase();
// Current Hugging Face inference host. `.../models` is appended per request.
const HF_BASE = () => String(process.env.HF_INFERENCE_BASE || 'https://router.huggingface.co/hf-inference/models').replace(/\/+$/, '');
const TTS_TIMEOUT_MS = () => Number(process.env.TTS_TIMEOUT_MS) || 30000;
const TTS_MAX_CHARS = () => Number(process.env.TTS_MAX_CHARS) || 500;

// Ten-minute circuit breaker. A provider-side "not supported" answer or a dead
// DNS name will not fix itself inside one conversation, so retrying on every
// turn only adds latency and log noise; the app speaks with the device voice
// meanwhile. It re-probes later without needing a restart, and a single
// transient network blip does not silence the server voice for long.
const RETRY_AFTER_MS = 10 * 60 * 1000;
let unavailableUntil = 0;
let unavailableReason = '';

function markUnavailable(reason) {
  unavailableUntil = Date.now() + RETRY_AFTER_MS;
  unavailableReason = String(reason || 'unavailable').slice(0, 160);
  console.warn(`[mmsTts] server voice unavailable for ${Math.round(RETRY_AFTER_MS / 60000)} min: ${unavailableReason}`);
}

function isUnavailable() {
  return Date.now() < unavailableUntil;
}

const DEFAULT_MODELS = {
  eng: 'facebook/mms-tts-eng',
  yor: 'facebook/mms-tts-yor',
  hau: 'facebook/mms-tts-hau',
  ibo: 'facebook/mms-tts-ibo',
};

function modelFor(lang) {
  const key = `MMS_TTS_MODEL_${String(lang || '').toUpperCase()}`;
  return String(process.env[key] || '').trim() || DEFAULT_MODELS[lang] || DEFAULT_MODELS.eng;
}

function withTimeout(promise, ms, label) {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => {
      const e = new Error(`${label} timed out after ${ms}ms`);
      e.isTimeout = true;
      rej(e);
    }, ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/**
 * @param {string} text reply to speak
 * @param {{ lang?: string }} opts language from the user's own utterance
 * @returns {Promise<{ audio: string, mimeType: string, provider: string, model: string, voice: string }>}
 * @throws Error('empty_text') | Error('tts_not_configured') | upstream errors
 */
async function metaTTS(text, { lang } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS());
  if (!clean) throw new Error('empty_text');
  if (TTS_MODE() === 'device') throw new Error('tts_not_configured');
  const key = HF_API_KEY();
  if (!key) throw new Error('tts_not_configured');
  // Same error the route already maps to TTS_UNAVAILABLE, so the client stops
  // asking for a while and uses the device voice immediately.
  if (isUnavailable()) throw new Error('tts_not_configured');

  const voice = normalizeSpeechLang(lang) || detectSpeechLang(clean);
  const model = modelFor(voice);

  let res;
  try {
    res = await withTimeout(fetch(`${HF_BASE()}/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: clean }),
    }), TTS_TIMEOUT_MS(), 'Meta MMS TTS');
  } catch (e) {
    // DNS/connection failures (ENOTFOUND when a host is retired) are reported
    // like an unreachable provider rather than a per-reply crash.
    markUnavailable(`network: ${e?.cause?.code || e?.message || 'fetch failed'}`);
    throw e;
  }

  if (!res.ok) {
    const e = new Error(`mms tts failed with HTTP ${res.status}`);
    e.status = res.status;
    try { e.body = await res.text(); } catch (_) { /* body is optional */ }
    // The provider explicitly saying it does not serve this model will not
    // change within a conversation: open the breaker.
    if (res.status === 400 || res.status === 404 || res.status === 410 || res.status === 429 || res.status >= 500) {
      markUnavailable(`HTTP ${res.status}: ${String(e.body || '').slice(0, 120)}`);
    }
    throw e;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('no_audio_part');
  const mime = String(res.headers?.get?.('content-type') || '').split(';')[0].trim() || 'audio/wav';

  return {
    audio: buf.toString('base64'),
    mimeType: mime,
    provider: 'meta-mms',
    model,
    voice,
  };
}

function mmsConfigured() {
  return TTS_MODE() !== 'device' && Boolean(HF_API_KEY());
}

module.exports = { metaTTS, modelFor, mmsConfigured };
