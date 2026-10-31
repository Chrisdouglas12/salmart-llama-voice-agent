'use strict';

/**
 * services/ai/authSession.js
 *
 * Persists the authentication task across turns using only the non-sensitive
 * facts owned by lib/assistant/authIntents.js. The state comes from validated
 * tool results, not from model text and not from a client field.
 *
 * Stored under `collectedInfo.auth`, beside the existing `task`. Email
 * addresses, passwords, OTPs, tokens and links are never written here.
 */

const intents = require('../../lib/assistant/authIntents');

function read(collectedInfo) {
  return intents.sanitizeAuthState(collectedInfo && collectedInfo.auth);
}

/** Prompt block for the stored state (no email, password, or token). */
function promptBlock(auth) {
  return intents.buildPromptBlock(auth);
}

/**
 * Fold this turn's validated tool results into the auth state.
 *
 * @param {object|null} prior  stored auth state (already sanitized)
 * @param {Array} toolResults  from agentRunner, each { name, ok, data }
 * @param {{ isAuthenticated?: boolean, task?: object }} options
 */
function applyToolResults(prior, toolResults, { isAuthenticated, task, registration } = {}) {
  let auth = read({ auth: prior });

  const snap = registration && typeof registration === 'object' ? registration : {};
  let emailProvided = !!(task && task.emailProvided) || snap.email === true;
  let phoneProvided = !!(task && task.phoneProvided) || snap.phone === true;
  let emailDeclined = !!(task && task.emailDeclined) || snap.emailDeclined === true;
  const passwordSet = snap.password === true;
  const agreed = snap.agreed === true;
  const registerDraft = (task && task.drafts && task.drafts.register) || {};

  const flags = () => ({
    emailProvided,
    phoneProvided,
    emailDeclined,
    passwordSet,
    agreed,
  });

  for (const r of toolResults || []) {
    if (!r || !r.ok || !r.data) continue;

    switch (r.name) {
      case 'beginAuthHelp': {
        // Recompute from the closed intent list so a tampered tool payload
        // cannot inject an arbitrary state.
        const plan = intents.planAuthHelp({
          intent: r.data.intent,
          prior: auth,
          registerDraft,
          ...flags(),
          registration: snap,
        });
        if (!plan) break;
        const same = !!(auth && auth.intent === plan.intent);
        auth = {
          intent: plan.intent,
          state: plan.state,
          method: plan.method,
          ...flags(),
          attempts: same ? Math.min((auth.attempts || 0) + 1, intents._internal.MAX_ATTEMPTS) : 0,
          updatedAt: Date.now(),
        };
        break;
      }

      case 'navigateToScreen':
        auth = intents.applyAuthEvent(auth, { type: 'navigate', screen: r.data.screen });
        break;

      case 'startGoogleAuthentication':
        auth = intents.applyAuthEvent(auth, { type: 'google_started' });
        break;

      case 'explainAuthError':
        auth = intents.applyAuthEvent(auth, { type: 'outcome', code: r.data.code });
        break;

      case 'prepareRegistration': {
        if (!auth) {
          auth = {
            intent: 'REGISTER',
            state: 'COLLECTING_REGISTRATION_DETAILS',
            method: null,
            emailProvided: false,
            phoneProvided: false,
            emailDeclined: false,
            passwordSet: false,
            agreed: false,
            attempts: 0,
            updatedAt: Date.now(),
          };
        }
        if (r.data.fields && r.data.fields.email) emailProvided = true;
        if (r.data.fields && r.data.fields.phoneNumber) phoneProvided = true;
        if (r.data.emailDeclined) emailDeclined = true;
        const plan = intents.planAuthHelp({
          intent: 'REGISTER',
          prior: auth,
          registerDraft,
          ...flags(),
          registration: snap,
        });
        auth = {
          ...auth,
          state: plan ? plan.state : 'COLLECTING_REGISTRATION_DETAILS',
          ...flags(),
          updatedAt: Date.now(),
        };
        break;
      }

      default:
        break;
    }
  }

  // Only the app's real session marks success; a Google button tap does not.
  if (isAuthenticated && auth) auth = intents.applyAuthEvent(auth, { type: 'authenticated' });

  // The frontend snapshot is authoritative for fields completed by hand, so it
  // is folded in even on a turn with no auth tool call.
  if (auth) auth = { ...auth, ...flags(), updatedAt: auth.updatedAt || Date.now() };

  return auth ? intents.sanitizeAuthState(auth) : null;
}

/** Preserve unrelated collectedInfo keys; replace only `auth`. */
function toCollectedInfo(previous, auth) {
  const base = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? { ...previous }
    : {};
  if (!auth) {
    delete base.auth;
    return base;
  }
  return { ...base, auth };
}

module.exports = {
  read,
  promptBlock,
  applyToolResults,
  toCollectedInfo,
};
