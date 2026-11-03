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
function promptBlock(auth, { screen } = {}) {
  return intents.buildPromptBlock(auth, { screen });
}

// A registration may only continue on the screens that show it. The AI screen
// is included because the user can open the conversation without leaving the
// form. Any other screen means they moved on.
const REGISTRATION_SCREENS = new Set(['register', 'ai']);

/**
 * True when a stored auth task no longer matches this turn. A signed-in user
 * has finished authentication, and a registration step cannot follow the user
 * to Market or any other screen.
 */
function isStale(auth, { isAuthenticated, screen, event } = {}) {
  if (!auth) return false;
  if (isAuthenticated) return true;
  if (event === 'registration_complete') return true;
  if (auth.intent === 'REGISTER' && screen && !REGISTRATION_SCREENS.has(screen)) return true;
  return false;
}

/**
 * Remove a finished registration from memory: the auth task, the registration
 * draft, and the "already supplied" flags. Other task drafts survive, so a
 * buyer or seller who also started signing up does not lose their real work.
 */
function withoutRegistration(collectedInfo) {
  if (!collectedInfo || typeof collectedInfo !== 'object' || Array.isArray(collectedInfo)) {
    return null;
  }
  const base = { ...collectedInfo };
  const auth = intents.sanitizeAuthState(base.auth);
  delete base.auth;
  if (!auth || auth.intent !== 'REGISTER') return base;

  const task = base.task;
  if (!task || typeof task !== 'object' || Array.isArray(task)) return base;

  const next = { ...task };
  if (next.drafts && typeof next.drafts === 'object' && !Array.isArray(next.drafts)) {
    next.drafts = { ...next.drafts, register: {} };
  }
  delete next.emailProvided;
  delete next.phoneProvided;
  delete next.emailDeclined;

  const hasOtherWork = !!(
    (next.adDraft && Object.keys(next.adDraft).length)
    || (next.drafts?.request && Object.keys(next.drafts.request).length)
    || (next.drafts?.profile && Object.keys(next.drafts.profile).length)
    || next.lastSearch
  );
  if (hasOtherWork) base.task = next;
  else delete base.task;

  return base;
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
  const registerDraft = (task && task.drafts && task.drafts.register) || {};
  // taskState may replace the draft object later in this same turn (after a
  // prepareRegistration). Re-read it at each plan so beginAuthHelp sees the
  // name that was just saved instead of the stale pre-turn object.
  const currentRegisterDraft = () => (task && task.drafts && task.drafts.register) || {};
  // A supplied value stays supplied even when this turn carries no form
  // snapshot (the user looked at another screen for a moment). Without this
  // fallback the flags flipped back to "no" and the assistant asked again for
  // a name and email it had already been given.
  let nameProvided = !!(registerDraft.fullName
    || (registerDraft.firstName && registerDraft.lastName))
    || !!(auth && auth.nameProvided);
  let emailProvided = !!(task && task.emailProvided) || snap.email === true
    || !!(auth && auth.emailProvided);
  let phoneProvided = !!(task && task.phoneProvided) || snap.phone === true
    || !!(auth && auth.phoneProvided);
  let emailDeclined = !!(task && task.emailDeclined) || snap.emailDeclined === true
    || !!(auth && auth.emailDeclined);
  // The password and the agreement live only on the phone's form. They are
  // never carried over from an earlier turn, so a remounted empty form is
  // never treated as already complete.
  const passwordSet = snap.password === true;
  const agreed = snap.agreed === true;

  const flags = () => ({
    nameProvided,
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
          registerDraft: currentRegisterDraft(),
          ...flags(),
          registration: snap,
        });
        if (!plan) break;
        const same = !!(auth && auth.intent === plan.intent);
        auth = {
          intent: plan.intent,
          state: plan.state,
          method: plan.method,
          field: plan.field,
          ...flags(),
          // A tool call does not un-pause a registration the user walked away
          // from; only returning to the register screen does (see the route).
          paused: !!(auth && auth.paused),
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
            field: 'fullName',
            nameProvided: false,
            paused: false,
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
        if (r.data.fields && (r.data.fields.firstName || r.data.fields.lastName || r.data.fields.fullName)) {
          nameProvided = true;
        }
        if (r.data.emailDeclined) emailDeclined = true;
        const plan = intents.planAuthHelp({
          intent: 'REGISTER',
          prior: auth,
          registerDraft: currentRegisterDraft(),
          ...flags(),
          registration: snap,
        });
        auth = {
          ...auth,
          state: plan ? plan.state : 'COLLECTING_REGISTRATION_DETAILS',
          field: plan ? plan.field : auth.field,
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
  isStale,
  withoutRegistration,
  applyToolResults,
  toCollectedInfo,
};
