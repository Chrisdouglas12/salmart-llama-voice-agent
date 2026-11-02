'use strict';

/**
 * services/ai/touchBuy.js
 *
 * Wording for the touch-to-buy flow. When a buyer touches a product card on
 * the phone, the server reads that exact listing's title and description and
 * asks whether to save it for later or chat the seller. The tap itself does
 * NOT write the cart: the item is saved only after the buyer says so in the
 * next voice turn, through the validated addToCart tool.
 *
 * Keeping the wording here (no Express, no Mongo) makes it unit-testable.
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
 * The description as spoken words. It is bounded so a spoken reply never runs
 * on for half a minute, and cut at a word boundary so it never leaves a stump.
 * A description that only repeats the title is omitted.
 */
function spokenDescription(description, title, max = 400) {
  const text = cleanText(description, 600);
  if (!text) return '';
  const name = cleanText(title, 160);
  if (name && text.toLowerCase() === name.toLowerCase()) return '';

  const cut = text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') : text;
  if (!cut) return '';
  return /[.!?]$/.test(cut) ? cut : `${cut}.`;
}

/**
 * Spoken line right after the buyer touches a product. It reads the listing
 * back, then asks the one question that decides the next step. The cart is
 * still untouched at this point.
 */
function buildSelectionReply({ title, price, description, hasSeller } = {}) {
  const name = cleanText(title, 120) || 'this item';
  const priceText = money(price);
  const desc = spokenDescription(description, name);

  let out = `You picked ${name}.`;
  if (priceText) out += ` It costs ${priceText}.`;
  if (desc) out += ` ${desc}`;
  out += hasSeller
    ? ' Should I save it for you so you can buy it later, or do you want me to chat the seller for you?'
    : ' Should I save it for you so you can buy it later?';
  return out;
}

/**
 * Spoken confirmation after the buyer says save. Used as the fixed fallback
 * wording, so the promise ("ask me to open the cart") is never left out.
 */
function buildSavedReply({ title, hasSeller } = {}) {
  const name = cleanText(title, 120) || 'that item';
  let out = `I saved ${name} in your cart. When you are ready to buy, just ask me to open the cart for you.`;
  if (hasSeller) {
    out += ' Should I chat the seller to ask if it is still available, so you can pay whenever you are ready?';
  }
  return out;
}

/** The draft that opens in the seller chat. The user still presses send. */
function buildEnquiryDraft({ title, price } = {}) {
  const name = cleanText(title, 120) || 'this item';
  const priceText = money(price);
  return `Hi, I want to buy ${name}${priceText ? ` (${priceText})` : ''}. Is it still available?`;
}

module.exports = {
  buildSelectionReply,
  buildSavedReply,
  buildEnquiryDraft,
  spokenDescription,
  money,
};
