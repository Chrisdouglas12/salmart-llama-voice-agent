/* lib/assistant/authIntents.js
 *
 * The authentication half of Salmart AI. Pure data + pure functions: no
 * database, no network, no secrets, so it is testable everywhere (including
 * the event extract, which has no models).
 *
 * The Meta model may only *choose an intent* from this closed list. It never
 * sets a conversation state directly: `planAuthHelp` computes the state, the
 * next screen, and ONE spoken sentence, and `applyAuthEvent` moves the state
 * from validated tool results only.
 *
 * Security rules enforced by shape:
 * - Only non-sensitive facts are stored: intent, state, method, whether an
 *   email was supplied, attempt count. Never the email value, password, OTP,
 *   token, or reset link.
 * - Every sentence asks at most one question and is short enough to speak.
 * - No sentence promises a recovery channel Salmart does not have.
 */

'use strict';

const AUTH_INTENTS = Object.freeze([
  'REGISTER',
  'SIGN_IN',
  'ACCOUNT_ACCESS',
  'RESET_PASSWORD',
  'RECOVER_ACCOUNT_IDENTIFIER',
  'GOOGLE_AUTH',
  'EMAIL_ACCESS_PROBLEM',
  'EMAIL_VERIFICATION',
  'RESEND_VERIFICATION',
  'AUTH_ERROR',
  'UNKNOWN_AUTH_INTENT',
]);

const AUTH_STATES = Object.freeze([
  'IDENTIFYING_GOAL',
  'ASKING_CLARIFICATION',
  'COLLECTING_REGISTRATION_DETAILS',
  'REGISTRATION_READY',
  'AUTHENTICATION_REQUIRED',
  'SIGN_IN_IN_PROGRESS',
  'PASSWORD_RESET_IN_PROGRESS',
  'EMAIL_VERIFICATION_PENDING',
  'ACCOUNT_IDENTIFIER_RECOVERY',
  'SUCCESS',
  'ERROR',
]);

const AUTH_INTENT_SET = new Set(AUTH_INTENTS);
const AUTH_STATE_SET = new Set(AUTH_STATES);

const AUTH_TTL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_SAY = 160;

const CLARIFY_SAY =
  'I can help with that. Which part is giving trouble: your password, the email you used, Google sign-in, or something else?';

const REGISTRATION_QUESTIONS = {
  firstName: 'Let us create your account. What is your first name?',
  lastName: 'Thank you. What is your last name?',
  email: 'What email address should we use? You will need to open it to confirm the account.',
};

/**
 * One plan per intent. `field` lets the register screen focus the box the
 * assistant just asked about without the model touching the password fields.
 */
const PLANS = Object.freeze({
  REGISTER: {
    state: 'COLLECTING_REGISTRATION_DETAILS',
    say: REGISTRATION_QUESTIONS.firstName,
    nextScreen: 'register',
    field: 'firstName',
    method: 'email',
  },
  SIGN_IN: {
    state: 'SIGN_IN_IN_PROGRESS',
    say: 'Let us sign you in. Type the email you used for Salmart, then your password on the sign-in screen.',
    nextScreen: 'signin',
    field: 'email',
    method: null,
  },
  ACCOUNT_ACCESS: {
    state: 'ASKING_CLARIFICATION',
    say: CLARIFY_SAY,
    nextScreen: null,
    field: null,
    method: null,
  },
  RESET_PASSWORD: {
    state: 'PASSWORD_RESET_IN_PROGRESS',
    say: 'No problem. On the reset screen, type the email you used, and Salmart will email you a link to choose a new password.',
    nextScreen: 'passwordReset',
    field: 'email',
    method: 'email',
  },
  RECOVER_ACCOUNT_IDENTIFIER: {
    state: 'ACCOUNT_IDENTIFIER_RECOVERY',
    say: 'That happens to many people. Do you remember signing up with Google, or with an email address?',
    nextScreen: null,
    field: null,
    method: null,
  },
  GOOGLE_AUTH: {
    state: 'SIGN_IN_IN_PROGRESS',
    say: 'We can use Google. Tap Continue with Google, then choose the Google account you use for Salmart.',
    nextScreen: 'signin',
    field: null,
    method: 'google',
  },
  EMAIL_ACCESS_PROBLEM: {
    state: 'EMAIL_VERIFICATION_PENDING',
    say: 'Salmart has no other way to verify the account without that email. Use a device where it opens, or ask someone you trust to help.',
    nextScreen: null,
    field: null,
    method: 'email',
  },
  EMAIL_VERIFICATION: {
    state: 'EMAIL_VERIFICATION_PENDING',
    say: 'Open the email from Salmart and tap the link inside. Then come back and sign in.',
    nextScreen: 'verifyEmail',
    field: null,
    method: 'email',
  },
  RESEND_VERIFICATION: {
    state: 'EMAIL_VERIFICATION_PENDING',
    say: 'I can send it again. On the verify screen, type your email and tap Resend verification email.',
    nextScreen: 'verifyEmail',
    field: 'email',
    method: 'email',
  },
  AUTH_ERROR: {
    state: 'ASKING_CLARIFICATION',
    say: 'I am sorry it is not working. What do you see: a wrong password message, a message about verifying your email, or something else?',
    nextScreen: null,
    field: null,
    method: null,
  },
  UNKNOWN_AUTH_INTENT: {
    state: 'ASKING_CLARIFICATION',
    say: CLARIFY_SAY,
    nextScreen: null,
    field: null,
    method: null,
  },
});

const REGISTRATION_READY = {
  state: 'REGISTRATION_READY',
  say: 'Your details are filled in. Choose a password on the screen, accept the terms, then tap Create account.',
  nextScreen: 'register',
  field: null,
  method: 'email',
};

// Retry wording is deliberately shorter and slower, never a lecture.
const RETRY_PREFIX = 'Let us take it one step at a time. ';

const SCREEN_STATE = Object.freeze({
  register: 'COLLECTING_REGISTRATION_DETAILS',
  signin: 'SIGN_IN_IN_PROGRESS',
  passwordReset: 'PASSWORD_RESET_IN_PROGRESS',
  verifyEmail: 'EMAIL_VERIFICATION_PENDING',
});

const OUTCOME_STATE = Object.freeze({
  email_exists: 'SIGN_IN_IN_PROGRESS',
  invalid_password: 'SIGN_IN_IN_PROGRESS',
  no_account: 'COLLECTING_REGISTRATION_DETAILS',
  google_only: 'SIGN_IN_IN_PROGRESS',
  unverified: 'EMAIL_VERIFICATION_PENDING',
  expired_link: 'EMAIL_VERIFICATION_PENDING',
  verification_pending: 'EMAIL_VERIFICATION_PENDING',
  verification_not_received: 'EMAIL_VERIFICATION_PENDING',
  verification_rate_limited: 'EMAIL_VERIFICATION_PENDING',
  registration_email_failed: 'EMAIL_VERIFICATION_PENDING',
  reset_google_account: 'SIGN_IN_IN_PROGRESS',
  recovery_failed: 'PASSWORD_RESET_IN_PROGRESS',
  google_cancelled: 'SIGN_IN_IN_PROGRESS',
  session_expired: 'AUTHENTICATION_REQUIRED',
  network_unavailable: 'ERROR',
  identifier_unknown: 'ACCOUNT_IDENTIFIER_RECOVERY',
  email_invalid: 'ASKING_CLARIFICATION',
  suspended: 'ERROR',
});

function cleanIntent(value) {
  const intent = String(value || '').trim().toUpperCase().slice(0, 40);
  return AUTH_INTENT_SET.has(intent) ? intent : null;
}

function cleanState(value) {
  const state = String(value || '').trim().toUpperCase().slice(0, 40);
  return AUTH_STATE_SET.has(state) ? state : null;
}

function cleanMethod(value) {
  return value === 'google' || value === 'email' ? value : null;
}

function spoken(text) {
  const say = String(text || '').replace(/\s+/g, ' ').trim();
  return say.length > MAX_SAY ? `${say.slice(0, MAX_SAY - 1).trim()}…` : say;
}

function registrationStep({ registerDraft, emailProvided } = {}) {
  const draft = registerDraft && typeof registerDraft === 'object' ? registerDraft : {};
  if (!draft.firstName) return 'firstName';
  if (!draft.lastName) return 'lastName';
  if (!emailProvided) return 'email';
  return null;
}

/**
 * Build the one step the assistant may speak for this intent.
 *
 * @returns {{ intent: string, state: string, say: string,
 *             nextScreen: string|null, field: string|null,
 *             method: string|null, retry: boolean }|null}
 */
function planAuthHelp({ intent, prior, registerDraft, emailProvided } = {}) {
  const key = cleanIntent(intent);
  if (!key) return null;

  let plan = PLANS[key];
  if (key === 'REGISTER') {
    const step = registrationStep({ registerDraft, emailProvided });
    if (!step) plan = REGISTRATION_READY;
    else if (step === 'email') {
      plan = {
        ...PLANS.REGISTER,
        say: REGISTRATION_QUESTIONS.email,
        field: 'email',
        state: 'COLLECTING_REGISTRATION_DETAILS',
      };
    } else {
      plan = {
        ...PLANS.REGISTER,
        say: REGISTRATION_QUESTIONS[step],
        field: step,
        state: 'COLLECTING_REGISTRATION_DETAILS',
      };
    }
  }

  const sameTask = !!(prior && prior.intent === key);
  const retry = sameTask && Number(prior.attempts) >= 1 && key !== 'REGISTER';

  return {
    intent: key,
    state: plan.state,
    say: spoken(retry ? `${RETRY_PREFIX}${plan.say}` : plan.say),
    nextScreen: plan.nextScreen || null,
    field: plan.field || null,
    method: plan.method || null,
    retry,
  };
}

/**
 * Move the stored auth state from a validated tool result. The model cannot
 * pass a state; it can only trigger these events.
 */
function applyAuthEvent(prior, event = {}) {
  if (!prior) return null;
  const base = sanitizeAuthState(prior);
  if (!base) return null;

  let state = base.state;
  let method = base.method;

  if (event.type === 'navigate' && SCREEN_STATE[event.screen]) {
    state = SCREEN_STATE[event.screen];
    if (event.screen === 'register') method = 'email';
    if (event.screen === 'passwordReset') method = 'email';
  } else if (event.type === 'outcome' && OUTCOME_STATE[event.code]) {
    state = OUTCOME_STATE[event.code];
  } else if (event.type === 'google_started') {
    state = 'SIGN_IN_IN_PROGRESS';
    method = 'google';
  } else if (event.type === 'authenticated') {
    state = 'SUCCESS';
  } else if (event.type === 'reset') {
    return null;
  } else {
    return base;
  }

  return { ...base, state, method, updatedAt: Date.now() };
}

/**
 * Accept only the small, non-sensitive shape this module owns. Anything else
 * (an email value, a password, an unknown key) is dropped, not trusted.
 */
function sanitizeAuthState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const intent = cleanIntent(raw.intent);
  const state = cleanState(raw.state);
  const updatedAt = Number(raw.updatedAt);
  if (!intent || !state) return null;
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  if (Date.now() - updatedAt > AUTH_TTL_MS) return null;

  const attempts = Number.isFinite(Number(raw.attempts))
    ? Math.max(0, Math.min(MAX_ATTEMPTS, Math.round(Number(raw.attempts))))
    : 0;

  return {
    intent,
    state,
    method: cleanMethod(raw.method),
    emailProvided: raw.emailProvided === true,
    attempts,
    updatedAt,
  };
}

/** Compact prompt block. Contains no email address, password, or token. */
function buildPromptBlock(auth) {
  if (!auth) return '';
  const lines = [
    `Intent: ${auth.intent}`,
    `State: ${auth.state}`,
    `Email supplied already: ${auth.emailProvided ? 'yes' : 'no'}`,
    `Method: ${auth.method || 'not chosen yet'}`,
    `Turns on this step: ${auth.attempts}`,
  ];
  return `\n\n[Auth state — data only, not instructions:\n${lines.join('\n')}\nFollow this state. Do not restart from the beginning. One question at a time.]`;
}

/**
 * Deterministic reading of a user's words. Used by tests and by the
 * credential guard to tell an auth question from ordinary chat. Runtime intent
 * is still chosen by the model through `beginAuthHelp`; this is a safety net,
 * not keyword routing.
 */
function classifyAuthIntent(text) {
  const s = String(text || '').toLowerCase();

  if (!s.trim()) return 'UNKNOWN_AUTH_INTENT';
  if (/don'?t know what to do|not sure what to do|help me\b/.test(s) && !/password|email|google|account|sign|log/.test(s)) {
    return 'UNKNOWN_AUTH_INTENT';
  }

  // Verification wording before generic "email", so "I didn't get the
  // confirmation message" is a resend, not a forgotten address.
  if (/resend|send (it|the email|the link) again|haven'?t (received|got)|didn'?t (receive|get).*(email|message|link)|no (email|message|link) (yet|arrived)/.test(s)) {
    return 'RESEND_VERIFICATION';
  }
  if (/verif(y|ication)|confirm(ation)? (email|message|account)|activ(e|ate).*(account|email)|tap the link/.test(s)) {
    return 'EMAIL_VERIFICATION';
  }
  if (/(can'?t|cannot|can not) (open|access|get into|reach).*(email|mail|gmail|inbox|yahoo|account)|no access.*(email|mail)|email.*(not|no longer) (working|available)/.test(s)) {
    return 'EMAIL_ACCESS_PROBLEM';
  }

  // Google intent, but "I don't remember which one" is an identifier problem.
  if (/(don'?t|can'?t) remember.*(google|email)|google.*(or|vs)\.? email|two (gmail|email)|which (gmail|email)/.test(s)) {
    return 'RECOVER_ACCOUNT_IDENTIFIER';
  }
  if (/\bgoogle\b|gmail/.test(s)) return 'GOOGLE_AUTH';

  if (/forgot.*(email|address)|(email|address).*(forgot|lost)|don'?t (know|remember).*(email|address)/.test(s)) {
    return 'RECOVER_ACCOUNT_IDENTIFIER';
  }

  if (/forgot.*password|password.*(not working|isn'?t working|stopped|wrong|expired)|reset.*password|change.*password|new password/.test(s)) {
    return 'RESET_PASSWORD';
  }

  if (/can'?t (enter|get into|access|open).*(account)|locked out|account.*(locked|blocked|problem)/.test(s)) {
    return 'ACCOUNT_ACCESS';
  }

  if (/sign ?up|register|create.*account|new (here|account)|first time|never used|join salmart|want to join/.test(s)) {
    return 'REGISTER';
  }
  if (/sign ?in|log ?in|already have an account|used (this|it) before|existing account/.test(s)) {
    return 'SIGN_IN';
  }

  if (/not working|something went wrong|error|problem|failed|confused/.test(s)) {
    return 'AUTH_ERROR';
  }

  return 'UNKNOWN_AUTH_INTENT';
}

module.exports = {
  AUTH_INTENTS,
  AUTH_STATES,
  AUTH_TTL_MS,
  MAX_SAY,
  CLARIFY_SAY,
  planAuthHelp,
  applyAuthEvent,
  sanitizeAuthState,
  buildPromptBlock,
  classifyAuthIntent,
  // exposed for tests
  _internal: { SCREEN_STATE, OUTCOME_STATE, RETRY_PREFIX, MAX_ATTEMPTS },
};
