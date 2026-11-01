'use strict';

/**
 * services/ai/touchBuy.js
 *
 * Wording for the touch-to-buy flow. When a buyer touches a product card on
 * the phone, the server adds that exact listing to their cart, then asks the
 * model to write the short line the buyer hears from the live listing data.
 * The model is not allowed to choose or change the product: the cart write is
 * deterministic. If the model is slow or its reply breaks a rule, the
 * template below is spoken instead, so the flow still works.
 *
 * Keeping the prompt, the reply check and the fallback here (no Express, no
 * Mongo) makes them unit-testable.
 */

const LANGUAGE_NAMES = Object.freeze({ yor: 'Yoruba', hau: 'Hausa', ibo: 'Igbo' });

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

/**
 * Prompt for the model-written pick reply. The listing is already in the
 * cart by the time this runs, so the model only phrases the confirmation.
 * Every rule the checker enforces is stated here first.
 */
function buildPickPrompt({ title, price, description, hasSeller, sellerName, lang } = {}) {
  const name = cleanText(title, 120) || 'the item';
  const priceText = money(price);
  const desc = cleanText(description, 500);
  const langName = LANGUAGE_NAMES[String(lang || '').toLowerCase()] || null;

  const system = [
    "You are Salmart's voice assistant. The buyer is often unable to read.",
    'The listing below is already in their cart. Write the reply they will hear.',
    'Rules:',
    '- 1 to 3 short sentences, plain spoken language, no lists, no emoji, no markdown.',
    '- Say clearly that it is in their cart.',
    priceText
      ? `- Say the exact price ${priceText}. Never change, round or discount it.`
      : '- The listing has no price: do not invent one.',
    '- Add one short useful detail from the description only if the description has one.',
    '- Do not invent details, discounts, delivery promises, or seller claims.',
    hasSeller
      ? '- End with one short question asking whether they want you to chat the seller.'
      : '- There is no reachable seller: do not mention a seller or a chat.',
    langName
      ? `- Reply in ${langName}, in warm everyday words.`
      : '- Reply in the language the buyer used; Pidgin in means Pidgin out.',
    '- Never say the item was paid for, shipped, delivered, or reserved.',
  ].join('\n');

  const user = [
    `Listing: ${name}`,
    `Price: ${priceText || 'not set'}`,
    `Description: ${desc || '(none)'}`,
    hasSeller ? `Seller: ${cleanText(sellerName, 80) || 'available'}` : 'Seller: not reachable',
    `Buyer language: ${langName || 'English or Pidgin'}`,
  ].join('\n');

  return { system, user };
}

/** All naira-marked amounts in a line, e.g. "₦18,500 and ₦2,000" -> [18500, 2000]. */
function nairaAmounts(text) {
  const out = [];
  const re = /₦\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g;
  let match;
  while ((match = re.exec(text))) {
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

/** True when the line states the given price and no other naira amount. */
function mentionsPrice(text, price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value < 0) return true;

  const marked = nairaAmounts(text);
  if (marked.length) return marked.every(amount => Math.abs(amount - value) < 0.01);

  const formatted = value.toLocaleString('en-NG');
  const plain = formatted.replace(/,/g, '');
  return new RegExp(`(^|[^0-9,])(${formatted}|${plain})([^0-9,]|$)`).test(text);
}

/**
 * Accept a model reply only when it is safe to speak. Returns the cleaned
 * line, or null so the caller speaks the deterministic fallback instead.
 */
function acceptModelReply(text, { price, hasSeller } = {}) {
  let out = String(text == null ? '' : text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '')
    .trim();
  if (!out) return null;

  if (out.length > 360) {
    const cut = out.slice(0, 360);
    const end = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    out = (end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '')).trim();
  }
  if (!out) return null;

  if (/https?:\/\//i.test(out)) return null;
  if (/\b(paid|payment|shipped|delivered|reserved)\b/i.test(out)) return null;
  if (!/\b(cart|added)\b/i.test(out)) return null;
  if (!mentionsPrice(out, price)) return null;
  if (!hasSeller && /\bseller\b/i.test(out)) return null;

  return out;
}

module.exports = {
  buildPickReply,
  buildEnquiryDraft,
  buildPickPrompt,
  acceptModelReply,
  shortDescription,
  money,
};

