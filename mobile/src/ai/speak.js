/**
 * Spoken replies through the device's standard text-to-speech voice.
 *
 * No custom voice, locale or pitch is selected: the phone speaks in the voice
 * the owner already chose in the system settings. The reply text is written in
 * the user's everyday language, so the default voice reads it naturally.
 */

import * as Speech from 'expo-speech';

/** Stop any speech before recording or a new reply. */
export async function stopSpeaking() {
  try {
    Speech.stop();
  } catch (_e) { /* speech is optional */ }
}

/**
 * Speak one assistant reply with the device's default voice. Resolves once
 * playback starts.
 */
export async function speakReply(text) {
  const line = String(text || '').trim();
  if (!line) return;

  // A fresh reply always interrupts the previous one.
  try {
    Speech.stop();
  } catch (_e) { /* speech is optional */ }

  try {
    Speech.speak(line, { rate: 1.0 });
  } catch (_e) { /* speech is optional */ }
}
