'use strict';

/**
 * services/ai/tools/navigationTools.js
 *
 * The only way the agent may move the user between screens.
 *
 * The model can only name a screen key from SCREENS — a hand-written
 * allowlist that mirrors the mobile app's native routes
 * (src/state/routes.js NATIVE_SCREENS). Anything the app does not own natively
 * is refused, and `ai` is deliberately absent: the global mic must never
 * bounce the user into the AI chat screen.
 *
 * Screens that need an id (checkout, chat, profile-by-id, showroom) are NOT
 * here. The assistant cannot invent a listing/partner id, so opening one would
 * only produce an empty screen. Those stay a tap on real data.
 */

// route key → human label used when the model wants to describe the move.
const SCREENS = Object.freeze({
  market: 'Market',
  requests: 'Requests',
  alerts: 'Notifications',
  messages: 'Messages',
  deals: 'Deals and orders',
  profile: 'Profile',
  search: 'Search',
  cart: 'Cart',
  referral: 'Referral',
  createAd: 'Create a listing',
  createRequest: 'Create a request',
  editProfile: 'Edit profile',
  ads: 'My ads',
  promote: 'Promote',
  showrooms: 'Showrooms',
  vtu: 'Pay bills',
  register: 'Create account',
  signin: 'Sign in',
  verifyEmail: 'Verify email',
  passwordReset: 'Reset password',
});

// Bottom-nav roots are switched to, not stacked, so Back returns to the app.
const PANEL_SCREENS = Object.freeze([
  'market', 'requests', 'alerts', 'messages', 'deals', 'profile',
]);

const clean = (v, n = 120) =>
  String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, n);

function isAllowedScreen(screen) {
  return Object.prototype.hasOwnProperty.call(SCREENS, String(screen || ''));
}

/**
 * Validate + normalise one navigation request. Pure: the client performs the
 * actual push, so nothing here touches state.
 */
async function navigateToScreen(_ctx, args = {}) {
  const screen = clean(args.screen, 40);
  if (!isAllowedScreen(screen)) {
    const e = new Error('That screen cannot be opened by the assistant.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }

  const out = {
    screen,
    label: SCREENS[screen],
    panel: PANEL_SCREENS.includes(screen),
  };

  // Only search uses the query today. Keep it short and single-line so it
  // cannot smuggle instructions into the screen.
  const query = clean(args.query, 120);
  if (query) out.query = query;

  return out;
}

module.exports = {
  SCREENS,
  PANEL_SCREENS,
  isAllowedScreen,
  navigateToScreen,
};
