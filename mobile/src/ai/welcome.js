/**
 * First-run voice welcome for the auth screens.
 *
 * - The microphone is only pulsed; it is never started automatically.
 * - First visit: one short spoken welcome, a mic pulse and a visual hint.
 * - Later visits: the visual hint only.
 * - When voice is muted: nothing.
 *
 * A ref in the component prevents repeat runs on re-render, and the stored
 * `welcomeSeen` flag prevents the welcome from returning on later visits.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Speech from 'expo-speech';

const SEEN_KEY = 'salmart:ai:welcomeSeen';
const MUTED_KEY = 'salmart:ai:voiceMuted';

export const WELCOME_LINE =
  'Welcome to Salmart! You can buy things, sell your products, or create an account. ' +
  'If you need help, tap the green button and tell me what you want to do. ' +
  'You can also continue with the form yourself.';

export async function hasSeenWelcome() {
  try {
    return (await AsyncStorage.getItem(SEEN_KEY)) === '1';
  } catch (_e) {
    return false;
  }
}

export async function markWelcomeSeen() {
  try {
    await AsyncStorage.setItem(SEEN_KEY, '1');
  } catch (_e) { /* prefs are best-effort */ }
}

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

export function stopWelcomeSpeech() {
  try {
    Speech.stop();
  } catch (_e) { /* speech is optional */ }
}

/**
 * Run the welcome once per screen visit. Returns 'spoken', 'visual' or
 * 'silent'. It does not record audio or open the mic.
 */
export async function runAuthWelcome({ nudgeMic }) {
  if (await isVoiceMuted()) return 'silent';
  const seen = await hasSeenWelcome();
  try {
    nudgeMic?.('Tap to talk');
  } catch (_e) { /* pulse is best-effort */ }
  if (!seen) {
    try {
      Speech.stop();
      Speech.speak(WELCOME_LINE, { rate: 0.95 });
    } catch (_e) { /* speech is optional */ }
    await markWelcomeSeen();
    return 'spoken';
  }
  return 'visual';
}
