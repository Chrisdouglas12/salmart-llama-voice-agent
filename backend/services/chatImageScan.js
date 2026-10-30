'use strict';

/**
 * services/chatImageScan.js
 *
 * Closes the photo hole in chat fraud filtering: account/phone numbers sent
 * as PICTURES skip every text filter. For image messages the server reads
 * the picture with the SAME Meta vision model the assistant already uses
 * (lib/assistant/llama.js#visionJSON — no new provider), transcribes visible
 * text, and runs it through the existing text filter
 * (routes/chatContentFilter.server.js#scanMessage).
 *
 * Cost control (Meta credit is finite — every scanned photo is one vision
 * call, kept tiny: minimal reasoning, 300 max tokens):
 *   - CHAT_IMAGE_SCAN=false disables photo scanning entirely (text filters
 *     keep working). Default: enabled.
 *   - Only http(s) image URLs under MAX_BYTES are fetched; anything else is
 *     skipped, never blocked.
 *   - Fail-OPEN: a vision error, timeout, or oversize image never blocks a
 *     message. Fraud scanning must not break legitimate chat.
 *
 * Latency: scans run AFTER the message is saved (fire-and-forget). A dirty
 * picture is visible for seconds, then retracted for everyone via the same
 * `messageDeletedForEveryone` event the client already handles — instead of
 * holding every innocent photo hostage to a 30s vision call.
 */

const { scanMessage } = require('../routes/chatContentFilter.server.js');
const { visionJSON } = require('../lib/assistant/llama.js');
const logger = require('./logger');

const ENABLED = process.env.CHAT_IMAGE_SCAN !== 'false';
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 3 * 1024 * 1024;

const OCR_PROMPT =
  'Transcribe ALL visible text in this image EXACTLY as shown: letters, digits, ' +
  'phone numbers, account numbers, words in any language including Yoruba, Hausa, ' +
  'Igbo, Pidgin, or stylized spellings. Keep digit groups and spacing. ' +
  'Reply with the transcription only — no commentary, no extra words. ' +
  'If there is no text, reply with exactly: NOTEXT';

async function fetchImageBytes(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '');
    if (!type.startsWith('image/')) throw new Error(`not an image: ${type}`);
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_BYTES) throw new Error('image too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('image too large');
    if (buf.length === 0) throw new Error('empty image');
    const mime = type.split(';')[0].trim() || 'image/jpeg';
    return { base64: buf.toString('base64'), mime };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scan one chat image URL. Always resolves (never rejects):
 * { blocked, categories, message, ocrText, skipped }
 */
async function scanChatImage(url) {
  const clean = String(url || '').trim();
  if (!ENABLED) return { blocked: false, categories: [], message: null, ocrText: '', skipped: 'disabled' };
  if (!/^https?:\/\//i.test(clean)) return { blocked: false, categories: [], message: null, ocrText: '', skipped: 'bad_url' };

  try {
    const { base64, mime } = await fetchImageBytes(clean);
    const { text } = await visionJSON({
      prompt: OCR_PROMPT,
      images: [{ base64, mime }],
      maxTokens: 300,
      reasoningEffort: 'minimal',
    });
    const ocrText = String(text || '').trim();
    if (!ocrText || /^notext$/i.test(ocrText)) {
      return { blocked: false, categories: [], message: null, ocrText: '', skipped: 'no_text' };
    }
    // The OCR text goes through the SAME pipeline as typed chat — including
    // slang numerals ("sero hate tiri…") and the digit-run heuristic.
    const result = scanMessage(ocrText);
    if (result.blocked) {
      logger.warn(`[chatImageScan] blocked photo — ${result.categories.join(',')} | ocr="${ocrText.slice(0, 120)}"`);
    }
    return { ...result, ocrText: ocrText.slice(0, 500), skipped: null };
  } catch (e) {
    // Fail open: never break chat because vision failed.
    logger.warn(`[chatImageScan] skipped (${e?.message || e})`);
    return { blocked: false, categories: [], message: null, ocrText: '', skipped: 'error' };
  }
}

module.exports = { scanChatImage, OCR_PROMPT, ENABLED };
