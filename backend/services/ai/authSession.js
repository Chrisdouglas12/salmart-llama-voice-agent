'use strict';

/**
 * services/ai/authSession.js
 *
 * Persists the authentication task across turns using only the non-sensitive
 * facts owned by lib/assistant/authIntents.js. It is derived from validated
 * tool results, never from the model's prose and never from a client field.
 *
 * Stored under `collectedInfo.auth`, beside the existing `task`. The email
 * value, password, OTP, tokens, and links are never written here.
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
function applyToolResults(prior, toolResults, { isAuthenticated, task } = {}) {
  let auth = read({ auth: prior });

  const emailProvided = !!(task && task.emailProvided);
  const registerDraft = (task && task.drafts && task.drafts.register) || {};

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
          emailProvided,
        });
        if (!plan) break;
        const same = !!(auth && auth.intent === plan.intent);
        auth = {
          intent: plan.intent,
          state: plan.state,
          method: plan.method,
          emailProvided,
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
            method: 'email',
            emailProvided: false,
            attempts: 0,
            updatedAt: Date.now(),
          };
        }
        if (r.data.fields && r.data.fields.email) auth = { ...auth, emailProvided: true };
        const draft = (task && task.drafts && task.drafts.register) || registerDraft;
        const ready = !!(draft.firstName && draft.lastName && (auth.emailProvided || emailProvided));
        auth = {
          ...auth,
          state: ready ? 'REGISTRATION_READY' : 'COLLECTING_REGISTRATION_DETAILS',
          method: 'email',
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
