/* lib/assistant/authGuidance.js
 *
 * Spoken guidance for authentication moments. Pure data + one pure function:
 * no database, no network, no secrets, so it is unit-testable everywhere.
 *
 * Each entry maps a real backend/screen outcome (never a model invention) to
 * ONE short spoken sentence plus the screen that fixes it. The model must
 * call navigateToScreen itself — this module only supplies the words.
 *
 * Security rules enforced by shape, not by trust:
 * - Input is a closed allowlist of outcome codes. Free-text errors from the
 *   backend never reach the model verbatim (they could contain emails).
 * - Nothing here asks for, repeats, or fills a password. Ever.
 * - `nextScreen` is validated against the same allowlist the navigator uses.
 */

'use strict';

const NEXT_SCREENS = ['register', 'signin', 'verifyEmail', 'passwordReset', null];

const GUIDANCE = {
  // POST /register -> "User already exists."
  email_exists: {
    say: 'You already have an account with that email. Let us sign you in instead.',
    nextScreen: 'signin',
  },
  // POST /login -> "Invalid password"
  invalid_password: {
    say: 'That password did not match. Try again, or reset it and I will guide you.',
    nextScreen: 'signin',
  },
  // POST /login -> "User not found"
  no_account: {
    say: 'I could not find an account with that email. Let us create one — it takes a minute.',
    nextScreen: 'register',
  },
  // POST /login -> "This account uses Google Sign-In."
  google_only: {
    say: 'This account signs in with Google, so there is no password. Use Continue with Google.',
    nextScreen: 'signin',
  },
  // Login/registration when the email is not verified yet.
  unverified: {
    say: 'Your email is not verified yet. Open the Salmart email and tap the link, then come back.',
    nextScreen: 'verifyEmail',
  },
  // GET /verify-email -> "Invalid or expired verification token"
  expired_link: {
    say: 'That link has expired. I will get you a fresh one.',
    nextScreen: 'verifyEmail',
  },
  // Resend cooling down (429) or mail send failure.
  verification_pending: {
    say: 'The email is on its way. Check your inbox and spam, then tap the link.',
    nextScreen: 'verifyEmail',
  },
  // POST /login -> suspended.
  suspended: {
    say: 'This account is suspended. You will need to contact Salmart support to reopen it.',
    nextScreen: null,
  },
  // Password-reset request/reset failures (unknown email, bad token).
  recovery_failed: {
    say: 'That did not work. Check the email address and try again, or ask me to start over.',
    nextScreen: 'passwordReset',
  },
  // The native Google flow was cancelled or its module is missing.
  google_cancelled: {
    say: 'Google sign-in did not finish. You can try again, or sign in with email instead.',
    nextScreen: 'signin',
  },
  // Session/token expired mid-conversation.
  session_expired: {
    say: 'Your session expired. Sign in again and we will pick up where we left off.',
    nextScreen: 'signin',
  },
  // Verification email never arrived, or arrived without a link.
  verification_not_received: {
    say: 'Check the inbox and the spam folder. If it is still not there, the verify screen can send a fresh link.',
    nextScreen: 'verifyEmail',
  },
  // POST /resend-verification -> 429 with retryAfter.
  verification_rate_limited: {
    say: 'The last email went out less than a minute ago. Wait a moment, then tap Resend again.',
    nextScreen: 'verifyEmail',
  },
  // The account has no password because it was created with Google.
  reset_google_account: {
    say: 'This account signs in with Google, so there is nothing to reset. Use Continue with Google instead.',
    nextScreen: 'signin',
  },
  // The mailbox itself is unreachable; Salmart has no second channel.
  email_access_unavailable: {
    say: 'Salmart has no other way to verify this account without that email. Use a device where it opens, or ask someone you trust to help.',
    nextScreen: null,
  },
  // The user cannot remember which address or Google account they used.
  identifier_unknown: {
    say: 'Salmart cannot find an account by name alone. Tell me if you used Google or an email, and we will try that way.',
    nextScreen: null,
  },
  // The typed address is incomplete.
  email_invalid: {
    say: 'That does not look like a complete email address. Check it and type it again.',
    nextScreen: null,
  },
  // The account exists but the verification mail could not be sent.
  registration_email_failed: {
    say: 'Your account was created, but the email did not send. On the verify screen, tap Resend verification email.',
    nextScreen: 'verifyEmail',
  },
  // No connection to Salmart.
  network_unavailable: {
    say: 'The phone cannot reach Salmart right now. Check the connection and try again. Nothing was lost.',
    nextScreen: null,
  },
};

/**
 * @param {*} code outcome code (anything unknown → gentle generic guidance)
 * @returns {{ code: string, say: string, nextScreen: string|null }}
 */
function explainAuthError(code) {
  const key = String(code || '').trim().toLowerCase().slice(0, 32);
  const found = GUIDANCE[key];
  if (found && NEXT_SCREENS.includes(found.nextScreen)) {
    return { code: key, say: found.say, nextScreen: found.nextScreen };
  }
  return {
    code: 'unknown',
    say: 'Something did not work. Let us try a different way — I can guide you step by step.',
    nextScreen: null,
  };
}

module.exports = { AUTH_GUIDANCE: GUIDANCE, explainAuthError };
