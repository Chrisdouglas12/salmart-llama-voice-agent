/**
 * Authentication outcome passed to the next AI turn.
 *
 * Auth screens know why a step failed (401, 403, 429, no network). Only the
 * fixed outcome code is passed on, never raw server text, an email address or
 * a password, so the assistant can explain the failure using a real code.
 *
 * The value is kept in memory because it is only useful for the next sentence.
 */

// Must match lib/assistant/authGuidance.js on the backend.
const VALID = new Set([
  'email_exists',
  'invalid_password',
  'no_account',
  'google_only',
  'unverified',
  'expired_link',
  'verification_pending',
  'suspended',
  'recovery_failed',
  'google_cancelled',
  'session_expired',
  'verification_not_received',
  'verification_rate_limited',
  'reset_google_account',
  'email_access_unavailable',
  'identifier_unknown',
  'email_invalid',
  'registration_email_failed',
  'network_unavailable',
]);

let pending = null;

/** Record the code for the next AI turn. Unknown codes are ignored. */
export function reportAuthOutcome(code) {
  const key = String(code || '').trim().toLowerCase();
  if (VALID.has(key)) pending = key;
}

/** Read and clear the pending code. */
export function takeAuthOutcome() {
  const value = pending;
  pending = null;
  return value;
}

/** Inspect without clearing. Used by tests and debugging. */
export function peekAuthOutcome() {
  return pending;
}

export const AUTH_OUTCOME_CODES = Array.from(VALID);
