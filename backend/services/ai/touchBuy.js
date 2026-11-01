'use strict';

/**
 * services/ai/touchBuy.js
 *
 * Pure wording for the touch-to-buy flow. When a buyer touches a product card
 * on the phone, the server adds the listing to their cart and returns one
 * short line to speak. Keeping the wording here (no Express, no Mongo) makes
 * it testable and keeps the model out of a path that must work every time.
 *
 * The line always names the price and the description because the buyer may
 * not read the screen. The seller-chat question is added only when a real
 * seller was validated for the listing.
 */

function cleanText(value, max = 200) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  return `₦${n.toLocaleString('en-NG')}`;
}

/**
 * The first useful sentence of the description, without repeating the title.
 * Bounded so a spoken reply never runs on for half a minute.
 */
function shortDescription(description, title) {
  const text = cleanText(description, 600);
  if (!text) return '';
  const name = cleanText(title, 160);
  if (name && text.toLowerCase() === name.toLowerCase()) return '';

  const cut = text.length > 180 ? text.slice(0, 180).replace(/\s+\S*$/, '') : text;
  if (!cut) return '';
  return /[.!?]$/.test(cut) ? cut : `${cut}.`;
}

/** Spoken confirmation after a touch. */
function buildPickReply({ title, price, description, hasSeller } = {}) {
  const name = cleanText(title, 120) || 'that item';
  const priceText = money(price);
  const desc = shortDescription(description, name);

  let out = `I have added ${name} to your cart.`;
  if (priceText) out += ` It costs ${priceText}.`;
  if (desc) out += ` ${desc}`;
  if (hasSeller) {
    out += ' Do you want me to chat the seller to check it is still available?';
  }
  return out;
}

/** The draft that opens in the seller chat. The user still presses send. */
function buildEnquiryDraft({ title, price } = {}) {
  const name = cleanText(title, 120) || 'this item';
  const priceText = money(price);
  return `Hi, I want to buy ${name}${priceText ? ` (${priceText})` : ''}. Is it still available?`;
}

module.exports = { buildPickReply, buildEnquiryDraft, shortDescription, money };
