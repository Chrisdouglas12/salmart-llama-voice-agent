'use strict';

/**
 * services/ai/spokenFallback.js
 *
 * The line the assistant speaks when the model spends its turn calling tools
 * and returns no final text. Pure data and a pure function: no provider, no
 * config, no dotenv, so the keyless tests can exercise it directly.
 *
 * `say` is the phone-card line, `nextAsk` the next registration/selling
 * question, `note` the older assistant note, and `message`/`reply`/`text`
 * plain result lines. The field order is the contract: a card line beats a
 * model-facing note.
 */

const SPOKEN_FIELDS = Object.freeze(['say', 'nextAsk', 'note', 'message', 'reply', 'text']);

/**
 * Last meaningful spoken line from this turn's successful tool results.
 * Results are read newest first, because the newest tool usually names the
 * next step.
 */
function spokenFallback(toolResults) {
  const results = Array.isArray(toolResults) ? toolResults : [];
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const r = results[i];
    if (!r || !r.ok || !r.data || typeof r.data !== 'object') continue;
    for (const field of SPOKEN_FIELDS) {
      const value = r.data[field];
      if (typeof value !== 'string') continue;
      const line = value.replace(/\s+/g, ' ').trim();
      if (line.length >= 4) return line;
    }
  }
  return '';
}

module.exports = { spokenFallback, SPOKEN_FIELDS };
