/**
 * HTTP client for /api/ai/*.
 *
 * All requests go through src/api/client.js, which handles auth, timeouts,
 * retries and ApiError. Functions throw ApiError, so callers can branch on
 * .status, .code or .isNetwork.
 */

import { apiGet, apiPost } from '../api/client';
import { API_BASE, getAuthToken } from '../api/client';

/** POST /api/ai/conversations returns { success, conversationId, created, status, anonymousId? } */
export function createConversation({ conversationId, anonymousId } = {}) {
  return apiPost('/api/ai/conversations', { conversationId, anonymousId }, { retries: 0 });
}

/** POST /api/ai/conversations/rebind. Requires auth; throws 404 on anonId mismatch. */
export function rebindConversation({ conversationId, anonymousId }) {
  return apiPost('/api/ai/conversations/rebind', { conversationId, anonymousId }, { retries: 0 });
}

/**
 * POST /api/ai/turn returns { success, reply, stopReason, structured?, confirmation_required? }.
 * The server caps `message` at 2000 characters, and the client applies the
 * same limit. `context` is a shallow object of primitives: screen hints, not
 * instructions.
 */
export function sendTurn({ conversationId, message, anonymousId, context } = {}) {
  const body = {
    conversationId,
    message: String(message || '').slice(0, 2000),
  };
  if (anonymousId) body.anonymousId = anonymousId;
  if (context) body.context = context;
  return apiPost('/api/ai/turn', body, { retries: 0 });
}

/**
 * POST /api/ai/turn with `Accept: text/event-stream`.
 *
 * The server runs the identical turn (same tools, same safety rules), then
 * emits one `sentence` event per reply sentence and a final `done` event
 * carrying the full turn payload. `onSentence` fires per sentence so the UI
 * can render and the voice can start before the turn completes. Resolves with
 * the `done` payload, shaped exactly like sendTurn's response.
 *
 * Anything unexpected (no stream support, a parse failure, the network) throws
 * and the caller falls back to sendTurn.
 */
export async function sendTurnStream({ conversationId, message, anonymousId, context, onSentence } = {}) {
  const body = {
    conversationId,
    message: String(message || '').slice(0, 2000),
  };
  if (anonymousId) body.anonymousId = anonymousId;
  if (context) body.context = context;
  const token = getAuthToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch(`${API_BASE}/api/ai/turn`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw Object.assign(new Error(`turn stream HTTP ${res.status}`), { status: res.status });
  }
  const contentType = String(res.headers?.get?.('content-type') || '');
  if (!contentType.includes('text/event-stream') || !res.body?.getReader) {
    // The server answered with one JSON body instead of a stream.
    const data = await res.json();
    if (data?.reply && onSentence) onSentence(String(data.reply));
    return data;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = null;
  const dispatch = (event, raw) => {
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_e) { return; }
    if (event === 'sentence') {
      const text = String(data?.text || '').trim();
      if (text && onSentence) onSentence(text);
    } else if (event === 'done' && data) {
      done = data;
    }
  };
  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop();
    for (const block of blocks) {
      let event = 'message';
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length) dispatch(event, dataLines.join('\n'));
    }
    if (done) {
      try { await reader.cancel(); } catch (_e) { /* stream already ended */ }
      break;
    }
  }
  if (!done || done.success === false) {
    throw new Error(done?.message || 'turn_stream_failed');
  }
  return done;
}

/**
 * POST /api/ai/cart/select — the touch-to-buy path.
 *
 * The app sends the exact productId the buyer touched; the server runs the
 * same cart validation as addToCart and returns one spoken line, the product,
 * and an optional seller-chat handoff. Requires auth.
 */
export function selectProductToCart({ productId, itemType, conversationId, lang } = {}) {
  return apiPost('/api/ai/cart/select', { productId, itemType, conversationId, lang }, { retries: 0 });
}

/** POST /api/ai/actions/:id/confirm. Returns 200, 400, 404, 409 or 410. */
export function confirmAction(actionId) {
  return apiPost(`/api/ai/actions/${encodeURIComponent(actionId)}/confirm`, {}, { retries: 0 });
}

/** POST /api/ai/actions/:id/cancel. Idempotent. */
export function cancelAction(actionId) {
  return apiPost(`/api/ai/actions/${encodeURIComponent(actionId)}/cancel`, {}, { retries: 0 });
}

/** GET /api/ai/tasks/:id. Poll target after a confirm request times out. */
export function getTaskStatus(actionId) {
  return apiGet(`/api/ai/tasks/${encodeURIComponent(actionId)}`, { retries: 0 });
}

/**
 * POST /api/ai/forms/drain. Pulls a queued fill patch for a form target.
 * `target` must be one of 'createAd', 'createRequest', 'editProfile' or
 * 'register'. Returns { success, patch: { fields, say, createdAt } | null }.
 *
 * Screens call this on mount and on focus through useAIPatch.
 */
export function drainFormPatch(target) {
  return apiPost('/api/ai/forms/drain', { target }, { retries: 0 });
}