/* lib/assistant/speechLang.js
 *
 * Same-language replies for voice-first users.
 *
 * The speech-to-text transcript tells us which language the person actually
 * spoke. This module maps that transcript to one of the four MMS voices we
 * serve (English, Yoruba, Hausa, Igbo) so the reply comes back in the same
 * language instead of always in English.
 *
 * Dependency-free and deterministic: diacritics unique to a script decide
 * first (ẹ/ọ/ṣ are Yoruba, ị/ụ/ṇ are Igbo, ɓ/ɗ/ƙ/ƴ are Hausa), then
 * distinctive everyday words break ties. Anything uncertain is English —
 * an English reply to a local-language speaker is a recoverable miss, while
 * a Yoruba reply to an English speaker would be confusing.
 */

'use strict';

const LANGS = ['eng', 'yor', 'hau', 'ibo'];

// Characters that appear in only one of the four scripts.
const DIACRITICS = {
  yor: /[ẹṣ]/i,
  ibo: /[ịụṇ]/i,
  hau: /[ɓɗƙƴ]/i,
};

// ọ is shared by Yoruba and Igbo; it only votes when a sibling diacritic
// or a word list already points that way.
const SHARED_O = /ọ/i;

// Distinctive everyday words (lowercased, matched on word boundaries).
// Kept to long or unambiguous words so English sentences rarely collide.
const WORDS = {
  yor: ['kaabo', 'bawo', 'se', 'pupo', 'dara', 'jowo', 'ejo', 'owo', 'omo', 'ife', 'ore', 'ile', 'ounje', 'omi', 'owo'],
  hau: ['sannu', 'lafiya', 'nagode', 'godiya', 'safiya', 'lafia', 'gida', 'ruwa', 'abinci', 'yaya', 'lafiyayye'],
  ibo: ['daalu', 'kedu', 'biko', 'nnoo', 'otito', 'ezigbo', 'ulo', 'mmiri', 'nri', 'onye', 'ifeoma', 'obodo'],
};

function countWords(lower, words) {
  let hits = 0;
  let longest = 0;
  for (const w of words) {
    // Short words (se, omo, ife, nri...) need boundaries on both sides.
    const rx = new RegExp(`(^|[^a-zà-ʯ])${w}([^a-zà-ʯ]|$)`);
    if (rx.test(lower)) {
      hits += 1;
      if (w.length > longest) longest = w.length;
    }
  }
  return { hits, longest };
}

/**
 * @param {*} text transcript or reply text
 * @returns {'eng'|'yor'|'hau'|'ibo'} — always one of the four, never null.
 */
function detectSpeechLang(text) {
  const s = String(text || '');
  if (!s.trim()) return 'eng';
  const lower = s.toLowerCase();

  // 1. Unique diacritics decide immediately.
  if (DIACRITICS.yor.test(s)) return 'yor';
  if (DIACRITICS.ibo.test(s)) return 'ibo';
  if (DIACRITICS.hau.test(s)) return 'hau';

  // 2. Word lists vote; need a clear winner. A single short word is not
  // enough on its own ("ore" is also an English word) — it needs a sibling
  // hit or the shared ọ to confirm.
  const scores = {
    yor: countWords(lower, WORDS.yor),
    hau: countWords(lower, WORDS.hau),
    ibo: countWords(lower, WORDS.ibo),
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1].hits - a[1].hits);
  const [best, bestScore] = ranked[0];
  const [, secondScore] = ranked[1];
  if (bestScore.hits >= 2 && bestScore.hits > secondScore.hits) return best;
  if (bestScore.hits === 1 && bestScore.hits > secondScore.hits
    && (bestScore.longest >= 4 || SHARED_O.test(s))) return best;

  // 3. A lone ọ with no other signal stays English: too ambiguous to act on.
  return 'eng';
}

/** Coerce a client-supplied lang hint to the allowlist, or null. */
function normalizeSpeechLang(value) {
  const v = String(value || '').trim().toLowerCase().slice(0, 8);
  if (LANGS.includes(v)) return v;
  // Accept common aliases without failing the turn.
  if (v === 'yo' || v === 'yoruba') return 'yor';
  if (v === 'ha' || v === 'hausa') return 'hau';
  if (v === 'ig' || v === 'igbo') return 'ibo';
  if (v === 'en' || v === 'english') return 'eng';
  return null;
}

module.exports = { LANGS, detectSpeechLang, normalizeSpeechLang };
