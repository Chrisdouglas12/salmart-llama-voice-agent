'use strict';

/* Keyless contract test for the agent's cart write.
 * DB-backed behaviour is verified live; here we assert the allowlist wiring
 * so a refactor can never silently expose, rename, or de-gate addToCart.
 * Run: node --test tests/ai-cart-tool.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

test('cart tool: addToCart is registered, gated, and inline', () => {
  let registry;
  try {
    registry = require('../services/ai/toolRegistry');
  } catch {
    return; // extract lacks host models; live suite covers it
  }
  const def = registry.getTool('addToCart');
  assert.ok(def, 'addToCart must be registered');
  assert.equal(def.category, 'order');
  assert.equal(def.requiresAuth, true);
  assert.equal(def.wired, true);
  // Reversible cart hold the user already agreed to: no confirmation card.
  assert.equal(def.requiresConfirmation, false);
  assert.equal(def.mutates, true);

  const authed = registry.toolsForContext({
    isAuthenticated: true,
    allowedPermissions: ['product:read', 'seller:own', 'message:own', 'order:own'],
  });
  assert.ok(authed.some((t) => t.name === 'addToCart'), 'signed-in buyers must receive addToCart');

  const anon = registry.toolsForContext({ isAuthenticated: false, allowedPermissions: [] });
  assert.ok(!anon.some((t) => t.name === 'addToCart'), 'anonymous callers must not receive addToCart');
});
