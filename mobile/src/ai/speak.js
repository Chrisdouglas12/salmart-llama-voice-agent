/**
 * Salmart AI — spoken replies
 *
 * The server voice (/api/assistant/speak → Meta MMS voices) is the preferred
 * voice; it matches what the old assistant used. The voice follows the
 * speaker's own language (`lang` from transcription). When the server voice
 * is unavailable we fall back to the phone's own TTS so a reply is never
 * silent.
 *
 * Playback goes through expo-audio's createAudioPlayer().
 */

import * as FileSystem from 'expo-file-system';
import * as Speech from 'expo-speech';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

import { assistantSpeak } from '../api/endpoints';

let player = null;
// Set only when the server explicitly says TTS is not configured. A transient
// network/auth failure falls back for that one reply and retries next time.
let serverVoiceDown = false;

// ISO 639-3 (server) → BCP-47 (expo-speech) for the device fallback voice.
const DEVICE_LANG = { eng: 'en', yor: 'yo', hau: 'ha', ibo: 'ig' };

function releasePlayer() {
  const p = player;
  player = null;
  if (!p) return;
  try { p.pause(); } catch (_e) { /* already stopped */ }
  try { p.remove(); } catch (_e) { /* already released */ }
}

/** Stop any speech, server or device, before recording or a new reply. */
export async function stopSpeaking() {
  try { Speech.stop(); } catch (_e) { /* speech is optional */ }
  releasePlayer();
}

async function playServerVoice(line, lang) {
  const res = await assistantSpeak(lang ? { text: line, lang } : { text: line });
  if (!res || !res.success || !res.audio) {
    const err = new Error((res && res.code) || 'tts_failed');
    err.code = res && res.code;
    throw err;
  }

  const dir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!dir) throw new Error('no_cache_dir');

  const uri = `${dir}ai-reply-${Date.now()}.wav`;
  await FileSystem.writeAsStringAsync(uri, res.audio, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Play through the loudspeaker, not the earpiece left over from recording.
  try {
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  } catch (_e) { /* non-fatal */ }

  releasePlayer();
  const next = createAudioPlayer({ uri });
  player = next;
  next.play();
}

/**
 * Speak one assistant reply. Resolves when playback has been started; playback
 * itself continues in the background. `lang` mirrors the speaker's own
 * language so the voice matches what they spoke.
 */
export async function speakReply(text, lang) {
  const line = String(text || '').trim();
  if (!line) return;

  // A fresh reply always interrupts the previous one.
  try { Speech.stop(); } catch (_e) { /* speech is optional */ }
  releasePlayer();

  if (!serverVoiceDown) {
    try {
      await playServerVoice(line, lang);
      return;
    } catch (e) {
      if (e?.code === 'TTS_UNAVAILABLE' || e?.code === 'tts_not_configured') {
        serverVoiceDown = true;
      }
    }
  }

  try { Speech.speak(line, { rate: 1.05, language: DEVICE_LANG[lang] || undefined }); } catch (_e) { /* speech is optional */ }
}
