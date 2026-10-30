'use strict';

/**
 * services/ai/platform.js
 *
 * The app reports its platform in screen context (`Platform.OS`). Auth tools
 * accept an explicit platform argument for API clients, but the model may omit
 * it; these helpers normalise both sources and keep the allowlist in one place.
 *
 * Pure, so it is testable without models, Mongo, or a provider.
 */

const NATIVE_PLATFORMS = Object.freeze(['android', 'ios']);
const NATIVE_SET = new Set(NATIVE_PLATFORMS);

function normalizePlatform(value) {
  const p = String(value == null ? '' : value).trim().toLowerCase();
  return NATIVE_SET.has(p) ? p : null;
}

/** Explicit tool argument first, then the client-supplied screen context. */
function platformFromContext(explicit, ctx) {
  return normalizePlatform(explicit) || normalizePlatform(ctx && ctx.platform);
}

module.exports = { NATIVE_PLATFORMS, normalizePlatform, platformFromContext };
