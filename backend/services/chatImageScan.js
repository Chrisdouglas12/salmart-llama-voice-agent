'use strict';

/**
 * services/chatImageScan.js
 *
 * Photo support for the chat fraud filter. Account and phone numbers sent as
 * pictures would otherwise skip the text filter. For image messages the
 * server reads the picture with the Meta vision model already used by the
 * assistant (lib/assistant/llama.js#visionJSON), transcribes the visible text
 * and runs it through the existing text filter
 * (routes/chatContentFilter.server.js#scanMessage).
 *
 * Cost control: every scan is one vision call, so each call uses minimal
 * reasoning and 300 max tokens.
 * - CHAT_IMAGE_SCAN=true re-enables photo scanning; it is OFF by default
 *   because the vision wait was delaying photo sends. Text filters keep
 *   working either way.
 * - Only http(s) image URLs under MAX_BYTES are fetched. Anything else is
 *   skipped, never blocked.
 * - Errors fail open: a vision error, timeout or oversize image never blocks a
 *   message. Fraud scanning must not break legitimate chat.
 *
 * Timing: a scan runs after the message is saved (fire-and-forget). A bad
 * picture is visible for a few seconds, then retracted for everyone through
 * the `messageDeletedForEveryone` event the client already handles. Holding
 * every photo until a slow vision call finished would delay innocent messages.
 */

const { scanMessage } = require('../routes/chatContentFilter.server.js');
const { visionJSON } = require('../lib/assistant/llama.js');
const Message = require('../models/messageSchema.js');
const logger = require('./logger');

const ENABLED = process.env.CHAT_IMAGE_SCAN === 'true';
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
    // The OCR text goes through the same pipeline as typed chat, including
    // slang numerals ("sero hate tiri...") and the digit-run heuristic.
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

module.exports = { scanChatImage, retractFraudPhoto, OCR_PROMPT, ENABLED };

/**
 * Post-send safety net: OCR an already-saved image message and retract it for
 * everyone when it is dirty. Used by the socket and REST send paths for
 * clients too old to pre-scan. `notify(result)` delivers the sender notice
 * (a socket emit, or nothing for REST because the next fetch omits the
 * message). Errors are swallowed.
 */
async function retractFraudPhoto({ io, room, messageId, url, notify }) {
  let result;
  try {
    result = await scanChatImage(url);
  } catch (_e) {
    return;
  }
  if (!result || !result.blocked) return;
  try {
    await Message.deleteOne({ _id: messageId });
  } catch (_e) { /* already gone */ }
  try {
    io.to(room).emit('messageDeletedForEveryone', { messageId: String(messageId) });
  } catch (_e) { /* sockets are best-effort */ }
  try {
    if (typeof notify === 'function') await notify(result);
  } catch (_e) { /* notice is best-effort */ }
}
