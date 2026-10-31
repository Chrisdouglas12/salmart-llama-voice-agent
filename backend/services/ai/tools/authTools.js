'use strict';

/**
 * services/ai/tools/authTools.js
 *
 * Onboarding and sign-in helpers for the assistant. These tools explain the
 * sign-in options that already exist and return a URL handled by the official
 * auth flow. They never receive credentials, tokens or consent.
 *
 * Existing auth routes:
 *   Web:     GET /auth/google?source=mobile&platform=<android|ios>&ref=<code>
 *            redirects to salmart://auth/callback?...
 *   Native:  POST /auth/google/mobile  body { idToken }  returns { success, token }
 *                                                     or { success, setup_token }
 *   Email:   POST /register  (see userRoutesIndex.js)
 */

const User = require('../../../models/userSchema');
const { explainAuthError } = require('../../../lib/assistant/authGuidance');
const { planAuthHelp } = require('../../../lib/assistant/authIntents');
const logger = require('../../logger');
const { normalizePlatform, platformFromContext } = require('../platform');

const APP_BASE_URL = process.env.APP_BASE_URL
  || (process.env.NODE_ENV === 'production'
      ? 'https://salmart.onrender.com'
      : 'http://localhost:3000');

function publicAuthBase() {
  // Some deployments sit behind a proxy; APP_BASE_URL lets ops override.
  return APP_BASE_URL.replace(/\/$/, '');
}

// ─── getAvailableAuthenticationMethods ───────────────────────────────────────

async function getAvailableAuthenticationMethods() {
  return {
    methods: [
      {
        id: 'google',
        label: 'Continue with Google',
        description:
          'Fastest if you already use Google on this device. Your Google account is used only for sign-in.',
        supported: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      },
      {
        id: 'email',
        label: 'Sign up with email',
        description:
          'Create an account with your email address and a password. You will verify your email.',
        supported: true,
      },
    ],
    note: 'Both options are supported. Choose the one you find easier.',
    recovery:
      'Salmart can email a password-reset link. It cannot find an account by name, and there is no SMS or backup-email recovery.',
  };
}

// ─── beginAuthHelp ───────────────────────────────────────────────────────────

/**
 * Return the next step for an authentication intent. The model only chooses
 * the intent; the state, screen and spoken sentence come from the fixed table
 * in lib/assistant/authIntents.js.
 *
 * The route passes in the stored auth state and registration draft. Neither
 * contains a password or an email value the tool could echo back.
 */
async function beginAuthHelp(ctx, { intent } = {}) {
  const plan = planAuthHelp({
    intent,
    prior: ctx && ctx.auth,
    registerDraft: ctx && ctx.registerDraft,
    emailProvided: !!(ctx && ctx.emailProvided),
    phoneProvided: !!(ctx && ctx.phoneProvided),
    emailDeclined: !!(ctx && ctx.emailDeclined),
    passwordSet: !!(ctx && ctx.passwordSet),
    agreed: !!(ctx && ctx.agreed),
    registration: (ctx && ctx.registration) || null,
  });
  if (!plan) {
    const e = new Error(
      'Unknown authentication intent. Use one of the listed AUTH_INTENTS.'
    );
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }
  logger.info(`[authTools] beginAuthHelp intent=${plan.intent} state=${plan.state} retry=${plan.retry}`);
  return plan;
}

// ─── getOnboardingState ──────────────────────────────────────────────────────

/**
 * States returned:
 *   'anonymous'                 — no user in context
 *   'profile_incomplete'        — authenticated but isProfileComplete=false
 *   'onboarding_complete'       — authenticated and profile complete
 */
async function getOnboardingState(ctx) {
  if (!ctx.userId) {
    return {
      state: 'anonymous',
      message: 'You are not signed in yet.',
      nextStep: 'You can sign up or sign in with Google or email.',
    };
  }
  const user = await User.findById(ctx.userId)
    .select('firstName lastName email isProfileComplete authProvider isVerified')
    .lean();
  if (!user) {
    return { state: 'anonymous', message: 'Session no longer valid.', nextStep: 'Please sign in again.' };
  }
  if (!user.isProfileComplete) {
    return {
      state: 'profile_incomplete',
      message:
        'You signed in, but your profile still needs a few details before you can sell or buy.',
      nextStep: 'Finish your profile in the app (name, phone, photo).',
      user: {
        firstName: user.firstName || null,
        lastName: user.lastName || null,
        authProvider: user.authProvider || 'local',
        isVerified: !!user.isVerified,
      },
    };
  }
  return {
    state: 'onboarding_complete',
    message: `You're all set, ${user.firstName || 'there'}.`,
    user: { firstName: user.firstName, lastName: user.lastName, email: user.email },
  };
}

// ─── startGoogleAuthentication ──────────────────────────────────────────────

/**
 * Returns a URL the client opens in a system browser. The model never sees the
 * resulting OAuth code; the app hands it back to the existing callback route,
 * which verifies it and issues a JWT.
 *
 * On native Android and iOS the client opens this URL in a system browser and
 * the callback redirects to `salmart://auth/callback?...`.
 *
 * `platform` may be omitted by the model. The route passes the client's
 * `Platform.OS` in screen context, so the app does not have to repeat it.
 * Explicit arguments win when both are present.
 */
async function startGoogleAuthentication(ctx, { platform, ref } = {}) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    const e = new Error('Google sign-in is not configured.');
    e.code = 'TOOL_FAILED';
    throw e;
  }

  const p = platformFromContext(platform, ctx);
  if (!p) {
    const e = new Error('Specify platform as "android" or "ios".');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }

  const safeRef = /^[A-Za-z0-9_-]{1,64}$/.test(String(ref || '')) ? String(ref) : null;

  const url = new URL(`${publicAuthBase()}/auth/google`);
  url.searchParams.set('source', 'mobile');
  url.searchParams.set('platform', p);
  if (safeRef) url.searchParams.set('ref', safeRef);

  logger.info(`[authTools] google initiation issued for platform=${p}`);
  return {
    authMethod: 'google',
    platform: p,
    url: url.toString(),
    // How the frontend should handle the result:
    //   Open the URL in a system browser (not the in-app WebView) so the
    //   Google consent screen appears with the phone's own Google session.
    //   After the redirect the client captures `salmart://auth/callback?token=…`
    //   and stores the token as it already does for manual Google sign-in.
    instructions:
      'Open this URL in a system browser. After Google sign-in, the app receives a callback and signs you in.',
  };
}

/**
 * Explain an authentication outcome in one short spoken sentence.
 *
 * `code` is a fixed allowlist (email_exists, invalid_password, no_account,
 * google_only, unverified, expired_link, verification_pending, suspended,
 * recovery_failed, google_cancelled, session_expired). Raw backend messages
 * are never passed through because they can contain the user's email. Unknown
 * codes get generic guidance, never an invented diagnosis.
 */
function explainAuthenticationError(ctx, { code } = {}) {
  return explainAuthError(code);
}

module.exports = {
  getOnboardingState,
  getAvailableAuthenticationMethods,
  beginAuthHelp,
  startGoogleAuthentication,
  explainAuthenticationError,
};