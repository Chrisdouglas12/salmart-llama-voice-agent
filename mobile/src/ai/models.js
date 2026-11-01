/**
 * Display names for the real model ids the server reports.
 *
 * Every id shown here arrives from the backend (`models.brain`,
 * `models.stt`, or the transcribe `model` field) — nothing is hardcoded as
 * the answering model. This file only shortens known Muse id prefixes for a
 * small card header; an unknown id is shown verbatim.
 */

export function shortModelName(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  // muse-voice-transcribe-1.0 -> "Muse transcribe"
  const voice = raw.match(/^muse-voice-([a-z]+)(?:[-_][\d.]+)?$/i);
  if (voice) return `Muse ${voice[1].toLowerCase()}`;
  return raw;
}
