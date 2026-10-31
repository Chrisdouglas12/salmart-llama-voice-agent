/**
 * HTTP client for /api/ai/*.
 *
 * All requests go through src/api/client.js, which handles auth, timeouts,
 * retries and ApiError. Functions throw ApiError, so callers can branch on
 * .status, .code or .isNetwork.
 */

import { apiGet, apiPost } from '../api/client';

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