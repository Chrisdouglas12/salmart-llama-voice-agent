/**
 * Listing post outcome passed to the next AI turn.
 *
 * CreateAdScreen knows why a post failed (validation message, offline,
 * server rejection). Only the fixed outcome code is passed on, never raw
 * server text, so the assistant can explain the failure and name the fix
 * using a real code.
 *
 * The value is kept in memory because it is only useful for the next sentence.
 */

// Must match LISTING_GUIDANCE in lib/assistant/sellingFlow.js on the backend.
const VALID = new Set([
  'photo_missing',
  'price_invalid',
  'quantity_invalid',
  'field_missing',
  'content_blocked',
  'network_unavailable',
  'publish_failed',
]);

let pending = null;

/** Record the code for the next AI turn. Unknown codes are ignored. */
export function reportListingOutcome(code) {
  const key = String(code || '').trim().toLowerCase();
  if (VALID.has(key)) pending = key;
}

/** Read and clear the pending code. */
export function takeListingOutcome() {
  const value = pending;
  pending = null;
  return value;
}

/** Inspect without clearing. Used by tests and debugging. */
export function peekListingOutcome() {
  return pending;
}

export const LISTING_OUTCOME_CODES = Array.from(VALID);
