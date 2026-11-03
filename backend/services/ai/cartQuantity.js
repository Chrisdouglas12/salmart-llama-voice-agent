'use strict';

/**
 * services/ai/cartQuantity.js
 *
 * Pure cart-quantity arithmetic, kept free of Mongoose/Express so both repos
 * can unit-test it without a database.
 *
 * The voice flow asks "how many do you want?" — so the number the buyer says
 * is the TOTAL they expect in the cart, not an extra amount on top of what was
 * already there. Adding the requested number on top is what made the assistant
 * put more units in the cart than the buyer asked for.
 */

const MAX_QUANTITY = 10000;

/** Integer 1..MAX_QUANTITY; anything unreadable falls back to one. */
function normalizeQuantity(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_QUANTITY);
}

function wholeNumber(value, fallback = 0) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Work out the final cart quantity before anything is written.
 *
 * @param {object} input
 * @param {number} input.requested  Number the buyer said.
 * @param {number} [input.inCart]   Units already in the cart for this item.
 * @param {number|null} [input.stock] Server stock; null = uncounted/unlimited.
 * @param {'set'|'add'} [input.mode] `set` (default) = the cart should end up
 *   with exactly `requested`. `add` = put `requested` MORE units in, for an
 *   explicit "add two more".
 * @param {boolean} [input.unitOnly] Services/digitals are never counted.
 *
 * @returns {{
 *   requested: number, mode: 'set'|'add', previous: number, target: number,
 *   total: number, addedNow: number, reduced: boolean, capped: boolean,
 *   available: number|null
 * }}
 */
function resolveCartQuantity({
  requested,
  inCart = 0,
  stock = null,
  mode = 'set',
  unitOnly = false,
} = {}) {
  const asked = normalizeQuantity(requested);
  const previous = wholeNumber(inCart);
  const addMode = mode === 'add';

  // What the cart should hold after this call, before stock is applied.
  const target = unitOnly
    ? 1
    : Math.min(addMode ? previous + asked : asked, MAX_QUANTITY);

  const shelf = stock == null ? null : wholeNumber(stock);
  const total = shelf == null ? target : Math.min(target, shelf);

  return {
    requested: asked,
    mode: addMode ? 'add' : 'set',
    previous,
    target,
    total,
    addedNow: Math.max(0, total - previous),
    reduced: total < previous,
    // The server cut the buyer's number down to what is actually left.
    capped: total < target,
    available: shelf == null ? null : Math.max(0, shelf - total),
  };
}

module.exports = { MAX_QUANTITY, normalizeQuantity, resolveCartQuantity };
