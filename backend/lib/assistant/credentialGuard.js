/* lib/assistant/credentialGuard.js
 *
 * Stops a password, one-time code, token, or reset link from ever reaching
 * the Meta model, the conversation history, or a log line.
 *
 * The guard is intentionally conservative: it only fires when the message
 * actually contains a secret VALUE, not when someone says "my password is not
 * working" or "I forgot my password". On a hit it replaces the value with
 * `[removed]`, which is what the model and the store receive.
 *
 * Pure: no I/O, no logger. The caller must never log the original text.
 */

'use strict';

const REFUSAL =
  'Please do not type your password, a code, or a link here. Keep those on the Salmart screen only. I can still guide you without seeing them.';

const PROMPT_NOTE =
  '\n\n[Credential guard: the user typed something secret. It was removed before you saw it. '
  + 'Do not ask for it, do not guess it, and do not repeat it. Say plainly that passwords, codes, '
  + 'and links stay on the Salmart screen, then continue helping.]';

const MAX_INPUT = 2000;

function inspect(raw) {
  const original = String(raw == null ? '' : raw).slice(0, MAX_INPUT);
  let text = original;
  const kinds = [];

  const redact = (re, kind) => {
    text = text.replace(re, () => {
      kinds.push(kind);
      return '[removed]';
    });
  };

  // "my password is hunter2", "password: hunter2", "PIN = 1234"
  // A complaint ("my password is not working") is not a secret.
  redact(/\b(?:my\s+|the\s+)?(?:salmart\s+)?(?:password|pass[- ]?code|pin)\s*(?:is|:|=)\s*(?!not\b|wrong\b|incorrect\b|fine\b|okay\b|ok\b|expired\b|missing\b|forgotten\b|blank\b|empty\b|the\b|a\b|an\b)[^\s,;.!?]+/gi, 'password');
  redact(/\b(?:password|pass[- ]?code|pin)\s*(?:is|:|=)\s*"[^"]{1,80}"/gi, 'password');

  // "OTP 123456", "the verification code is 123456", "code: 4321"
  redact(/\b(?:otp|one[- ]?time\s+(?:code|password)|verification\s+code|security\s+code|confirmation\s+code|code)\b\s*(?:is|:|=)?\s*\d{3,8}\b/gi, 'otp');
  // "123456 is my OTP"
  redact(/\b\d{3,8}\b\s*(?:is|was)\s+(?:my|the)\s+(?:otp|code|pin|password)\b/gi, 'otp');

  // "token: 9f2c...", "reset link is https://...", long hex ids
  redact(/\b(?:token|verification\s+link|reset\s+link|magic\s+link)\b\s*(?:is|:|=)?\s*(?:https?:\/\/\S+|[A-Za-z0-9._~+/-]{16,})/gi, 'token');
  redact(/\b[a-f0-9]{32,}\b/gi, 'token');

  // A pasted OAuth/verification URL is a token even without a label.
  redact(/\bhttps?:\/\/\S*(?:token|code|otp)=\S+/gi, 'token');

  return {
    blocked: kinds.length > 0,
    kinds: Array.from(new Set(kinds)),
    text,
    refusal: REFUSAL,
    promptNote: kinds.length ? PROMPT_NOTE : '',
  };
}

module.exports = { inspect, REFUSAL, PROMPT_NOTE };
