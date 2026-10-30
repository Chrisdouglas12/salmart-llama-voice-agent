/**
 * Salmart AI Mode — HTTP client for /api/ai/*
 *
 * Uses the existing src/api/client.js funnel (auth, timeout, retry, ApiError).
 * Every function throws ApiError so callers branch on .status / .code /
 * .isNetwork — no boolean sniffing.
 */

import { apiGet, apiPost } from '../api/client';

/** POST /api/ai/conversations → { success, conversationId, created, status, anonymousId? } */
export function createConversation({ conversationId, anonymousId } = {}) {
  return apiPost('/api/ai/conversations', { conversationId, anonymousId }, { retries: 0 });
}

/** POST /api/ai/conversations/rebind — auth required. Throws 404 on anonId mismatch. */
export function rebindConversation({ conversationId, anonymousId }) {
  return apiPost('/api/ai/conversations/rebind', { conversationId, anonymousId }, { retries: 0 });
}

/**
 * POST /api/ai/turn → { success, reply, stopReason, structured?, confirmation_required? }
 * `message` capped at 2000 chars server-side; we clamp client-side too.
 * `context` is a shallow object of primitives — screen hints, not instructions.
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

/** POST /api/ai/actions/:id/confirm — 200 | 400 | 404 | 409 | 410 */
export function confirmAction(actionId) {
  return apiPost(`/api/ai/actions/${encodeURIComponent(actionId)}/confirm`, {}, { retries: 0 });
}

/** POST /api/ai/actions/:id/cancel — idempotent */
export function cancelAction(actionId) {
  return apiPost(`/api/ai/actions/${encodeURIComponent(actionId)}/cancel`, {}, { retries: 0 });
}

/** GET /api/ai/tasks/:id — poll target after a network-timeout confirm */
export function getTaskStatus(actionId) {
  return apiGet(`/api/ai/tasks/${encodeURIComponent(actionId)}`, { retries: 0 });
}

/**
 * POST /api/ai/forms/drain — pull a queued fill patch for a form target.
 * `target` must be one of: 'createAd' | 'createRequest' | 'editProfile'.
 * Returns { success, patch: { fields, say, createdAt } | null }.
 *
 * Screens call this on mount and on focus (see useAIPatch below).
 */
export function drainFormPatch(target) {
  return apiPost('/api/ai/forms/drain', { target }, { retries: 0 });
}