'use strict';

/**
 * services/ai/toolCallIds.js
 *
 * Normalizes the model's raw tool calls and guarantees unique ids within a
 * message.
 *
 * Some OpenAI-compatible gateways reuse one id for parallel calls (all
 * `call_0`, or a copied id). The stored history then holds two calls that a
 * single tool message appears to answer, which is the exact "missing tool
 * response" shape that rejects every later replay. Renaming the repeat keeps
 * both calls and both responses pairable; the model never needs the old id
 * again once the turn is stored.
 *
 * Kept free of config/dotenv imports so keyless tests can load it.
 */

function normalizeToolCalls(rawCalls) {
  const used = new Set();
  const out = [];
  for (const tc of Array.isArray(rawCalls) ? rawCalls : []) {
    let args = {};
    if (typeof tc?.function?.arguments === 'string') {
      try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
    } else if (tc?.function?.arguments && typeof tc.function.arguments === 'object') {
      args = tc.function.arguments;
    }
    let id = tc?.id || `call_${Math.random().toString(36).slice(2)}`;
    if (used.has(id)) {
      const base = id;
      let n = 2;
      while (used.has(`${base}_${n}`)) n++;
      id = `${base}_${n}`;
    }
    used.add(id);
    out.push({ id, name: tc?.function?.name, arguments: args });
  }
  return out;
}

module.exports = { normalizeToolCalls };
