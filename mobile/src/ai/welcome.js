/**
 * Voice-help preference for the sign-in and registration screens.
 *
 * The spoken first-run welcome now belongs to FirstRunWelcome (firstRun.js),
 * so these screens only pulse the global mic button and offer the mute toggle.
 * Keeping the spoken welcome out of this module means the onboarding can never
 * be interrupted by a second welcome starting behind it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Speech from 'expo-speech';

const MUTED_KEY = 'salmart:ai:voiceMuted';

export async function isVoiceMuted() {
  try {
    return (await AsyncStorage.getItem(MUTED_KEY)) === '1';
  } catch (_e) {
    return false;
  }
}

export async function setVoiceMuted(muted) {
  try {
    await AsyncStorage.setItem(MUTED_KEY, muted ? '1' : '0');
  } catch (_e) { /* prefs are best-effort */ }
  try {
    if (muted) Speech.stop();
  } catch (_e) { /* speech is optional */ }
}

/**
 * Run the auth-screen voice hint once per visit. It never records audio and
 * never speaks; the first-run welcome is handled by FirstRunWelcome.
 */
export async function runAuthWelcome({ nudgeMic }) {
  if (await isVoiceMuted()) return 'silent';
  try {
    nudgeMic?.('Tap to talk');
  } catch (_e) { /* pulse is best-effort */ }
  return 'visual';
}
