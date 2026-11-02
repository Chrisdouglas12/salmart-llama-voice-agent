/**
 * First-run voice onboarding state.
 *
 * The onboarding is shown once per install, before the user has done anything
 * else. It owns the spoken welcome, so the auth screens no longer speak one of
 * their own (see welcome.js).
 *
 * The flag is marked only after the user chooses "Yes" or "Maybe later". If the
 * app is closed while the onboarding is still on screen, the welcome is shown
 * again on the next launch instead of disappearing unanswered.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const SEEN_KEY = 'salmart:ai:firstRunSeen';

export const FIRST_RUN_WELCOME =
  "Welcome to Salmart, Nigeria's social marketplace. I can help you buy and sell " +
  'with your voice, no typing needed. To hear you, I need to use your microphone. ' +
  'Is that okay?';

export const FIRST_RUN_THANKS =
  'THANK YOU! Now just speak to me from anywhere. How can I help you today?';

export const FIRST_RUN_DENIED =
  'No problem, you can still type or allow permission later by clicking the mic ' +
  'button from anywhere in the app.';

export const FIRST_RUN_ALLOW_HINT =
  'Press Allow on the microphone prompt to continue.';

export async function hasSeenFirstRun() {
  try {
    return (await AsyncStorage.getItem(SEEN_KEY)) === '1';
  } catch (_e) {
    return false;
  }
}

export async function markFirstRunSeen() {
  try {
    await AsyncStorage.setItem(SEEN_KEY, '1');
  } catch (_e) { /* prefs are best-effort */ }
}
