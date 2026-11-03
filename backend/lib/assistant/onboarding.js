/* lib/assistant/onboarding.js
 *
 * First-run welcome copy. The phone asks the server for these four lines and
 * speaks them with its normal TTS pipeline; nothing here is rendered as a hard
 * block of mobile text.
 *
 * The lines are deliberately short, plain and truthful. The welcome ends with
 * the microphone question because the permission card is revealed only after
 * the welcome finishes. `thanks` and `denied` describe what the microphone can
 * do, never a capability Salmart does not have.
 *
 * The module is pure so the keyless event extract and the tests can use it
 * without a model key.
 */

'use strict';

const MAX_WELCOME = 600;
const MAX_LINE = 260;

const ONBOARDING_FALLBACK = Object.freeze({
  welcome:
    "Welcome to Salmart, Nigeria's social marketplace. I can help you buy and sell "
    + 'with your voice, no typing needed. To hear you, I need to use your microphone. '
    + 'Is that okay?',
  thanks:
    'Thank you. You can talk to me from anywhere by tapping the green mic button. '
    + 'How can I help you today?',
  denied:
    'No problem. You can still type, and you can allow the microphone later by '
    + 'tapping the mic button.',
  allowHint:
    'Tap Allow on the microphone prompt. I only listen after you tap the mic.',
});

const ONBOARDING_SYSTEM_PROMPT = `You write the first-run welcome for Salmart, a Nigerian social marketplace.
The listener may have low digital literacy, so use short sentences and plain words.
Write for the ear: no markdown, no bullet points, no emoji, no technical words.
The welcome must: (1) say welcome to Salmart, Nigeria's social marketplace; (2) say the
assistant can help them buy and sell with their voice, no typing; (3) ask for microphone
permission in one clear question. Never promise money, free items, or instant success.
Reply with JSON only, in this exact shape:
{"welcome":"...","thanks":"...","denied":"...","allowHint":"..."}
"welcome" is 2 to 4 short sentences. "thanks" says what to do after permission is
allowed. "denied" says they can still type and can allow the microphone later.
"allowHint" is one short line that tells them to tap Allow on the microphone prompt.`;

function cleanLine(value, max) {
  const text = typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}…`;
}

/**
 * Accept only the four allowed spoken lines. A missing or empty key falls back
 * to the server-owned copy, so the phone can always speak something safe.
 */
function sanitizeOnboarding(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    welcome: cleanLine(src.welcome, MAX_WELCOME) || ONBOARDING_FALLBACK.welcome,
    thanks: cleanLine(src.thanks, MAX_LINE) || ONBOARDING_FALLBACK.thanks,
    denied: cleanLine(src.denied, MAX_LINE) || ONBOARDING_FALLBACK.denied,
    allowHint: cleanLine(src.allowHint, MAX_LINE) || ONBOARDING_FALLBACK.allowHint,
  };
}

/**
 * Parse a model answer. The model is asked for JSON, but a plain welcome is
 * still useful: it becomes `welcome` and the other three lines keep the safe
 * server copy.
 */
function parseOnboardingReply(text) {
  const body = String(text || '').trim();
  if (!body) return null;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return sanitizeOnboarding(JSON.parse(body.slice(start, end + 1)));
    } catch (_e) {
      // Fall through to the plain-text shape below.
    }
  }
  if (body.length < 20) return null;
  return sanitizeOnboarding({ welcome: body });
}

module.exports = {
  ONBOARDING_FALLBACK,
  ONBOARDING_SYSTEM_PROMPT,
  MAX_WELCOME,
  MAX_LINE,
  sanitizeOnboarding,
  parseOnboardingReply,
  _internal: { cleanLine },
};
