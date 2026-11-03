/* lib/assistant/sellingFlow.js
 *
 * Listing steps for the selling flow. Pure data and pure functions: no
 * database, no network, no secrets.
 *
 * The assistant model does not choose the question order. It reads the
 * [Selling state] prompt block (built from the phone's form snapshot) and
 * asks the next question named there, one per turn, filling one field per
 * prepareAdForm call. This module owns the order, the questions and the
 * validation helpers used by the backend.
 *
 * The step orders follow the CreateAdScreen visual order and its required
 * sets (postRoutes.js). A regular listing needs title, caption, price,
 * quantity, condition, category, location and photo. A service needs title,
 * caption, category, type and location, and its price is optional because it
 * may be negotiable. A digital listing needs title, price, category and file,
 * and its caption is optional.
 */

'use strict';

const POST_TYPES = ['regular', 'service', 'digital'];

const MIN_PRICE = 100;
const MAX_QTY = 10000;

// Human-readable category names for speech (keys are the real enum values).
function readableCategory(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const STEPS = {
  postType: {
    ask: 'What are you selling — a physical item, a service, or a digital file you send on the phone?',
    optional: false,
  },
  title: {
    ask: 'What is the item called?',
    optional: false,
  },
  serviceTitle: {
    ask: 'What service do you offer? For example, phone repair or house cleaning.',
    optional: false,
  },
  digitalTitle: {
    ask: 'What is the name of the file you want to sell?',
    optional: false,
  },
  caption: {
    ask: 'Describe it briefly — what shape is it in, and anything a buyer should know?',
    optional: false,
  },
  digitalCaption: {
    ask: 'Add a short description if you like, or we can skip this.',
    optional: true,
    defer: true,
  },
  price: {
    ask: 'How much do you want to sell it?',
    optional: false,
  },
  servicePrice: {
    ask: 'What do you charge? Say negotiable if the price depends on the job.',
    optional: true,
    defer: true,
  },
  digitalPrice: {
    ask: 'What price in naira? The lowest allowed is 100 naira.',
    optional: false,
  },
  quantity: {
    ask: 'How many of these items do you have to sell?',
    optional: false,
  },
  discount: {
    ask: 'Will you like to give any discount or reduce if someone buys more than one?',
    optional: true,
  },
  productCondition: {
    ask: 'Is this item new or fairly used?',
    optional: false,
  },
  category: {
    ask: 'Which group fits it best? I will read the choices when we get there.',
    optional: false,
  },
  location: {
    ask: 'What state or location are you selling this item from?',
    optional: false,
  },
  serviceCategory: {
    ask: 'Which kind of service is it? For example, repair, tutoring, or logistics.',
    optional: false,
  },
  serviceType: {
    ask: 'Do you work remote, on-site at the customer, or both?',
    optional: false,
  },
  serviceLocation: {
    ask: 'Where do you offer this service? Tell me the state or city.',
    optional: false,
  },
  digitalCategory: {
    ask: 'Which group fits it best? I will read the choices when we get there.',
    optional: false,
  },
  photo: {
    ask: 'First, pick a photo of the item you want to sell. Choose one from your gallery, or say camera to take a new one. When you pick one I will ask if that is all or you want to pick more.',
    optional: false,
  },
  digitalFile: {
    ask: 'Which file will the buyer receive? We will pick it from your phone together.',
    optional: false,
  },
  review: {
    ask: 'I have filled all the information. Here is what we have filled so far. Will you like to change anything?',
    optional: false,
  },
};

// Visual top-to-bottom order per listing type. `flag` is the snapshot key.
const ORDERS = {
  regular: [
    { step: 'photo', flag: 'photo' },
    { step: 'title', flag: 'title' },
    { step: 'caption', flag: 'caption' },
    { step: 'price', flag: 'priceValid' },
    { step: 'quantity', flag: 'quantity' },
    { step: 'discount', flag: 'bulkDiscount' },
    { step: 'productCondition', flag: 'condition' },
    { step: 'category', flag: 'category' },
    { step: 'location', flag: 'location' },
  ],
  service: [
    { step: 'serviceTitle', flag: 'title' },
    { step: 'caption', flag: 'caption' },
    { step: 'serviceCategory', flag: 'serviceCategory' },
    { step: 'serviceType', flag: 'serviceType' },
    { step: 'serviceLocation', flag: 'serviceLocation' },
    { step: 'servicePrice', flag: 'priceValid' },
  ],
  digital: [
    { step: 'digitalTitle', flag: 'title' },
    { step: 'digitalCaption', flag: 'caption' },
    { step: 'digitalPrice', flag: 'priceValid' },
    { step: 'digitalCategory', flag: 'digitalCategory' },
    { step: 'digitalFile', flag: 'digitalFile' },
  ],
};

function cleanType(value) {
  const t = String(value || '').trim().toLowerCase().slice(0, 20);
  if (t === 'regular' || t === 'service' || t === 'digital') return t;
  if (/serv/.test(t)) return 'service';
  if (/digital|file|download|ebook|e-book/.test(t)) return 'digital';
  if (/item|product|physical|good/.test(t)) return 'regular';
  return null;
}

/**
 * First incomplete step for this type, from the phone's snapshot flags.
 * Returns { step, ask, optional, done, missing[] }, where `missing` lists
 * every required step still open.
 *
 * `asked` holds steps already offered, so an optional step is asked once and
 * then left alone. Steps marked `defer` wait until the earlier steps are
 * done. The discount step is not deferred: it is offered right after
 * quantity, not after location.
 */
function nextStep(postType, snapshot = {}, asked = []) {
  const type = cleanType(postType) || 'regular';
  const order = ORDERS[type];
  const offered = new Set(Array.isArray(asked) ? asked : []);
  // `quantity` arrives as a completion flag, and the count (when the phone
  // knows it) as `quantityCount`. A boolean must never be read as the number 1,
  // or the discount step would be skipped for every listing.
  const qty = Number.isFinite(Number(snapshot.quantityCount))
    ? Number(snapshot.quantityCount)
    : (typeof snapshot.quantity === 'number' && Number.isFinite(snapshot.quantity)
      ? snapshot.quantity
      : null);

  const open = order.filter((s) => {
    if (snapshot[s.flag]) return false;
    const meta = STEPS[s.step];
    if (meta.optional && offered.has(s.step)) return false;
    // A single unit has nothing to discount for multiple units.
    if (s.step === 'discount' && Number.isFinite(qty) && qty <= 1) return false;
    return true;
  });
  const missing = open.filter((s) => !STEPS[s.step].optional);
  const first = open.find((s) => !STEPS[s.step].defer) || open[0] || null;
  if (!first) {
    return {
      type, step: 'review', ask: STEPS.review.ask, optional: false,
      done: true, missing: [], after: null,
    };
  }
  const second = open.find((s) => s.step !== first.step) || null;
  return {
    type,
    step: first.step,
    ask: STEPS[first.step].ask,
    optional: !!STEPS[first.step].optional,
    done: false,
    missing: missing.map((s) => s.step),
    after: second ? { step: second.step, ask: STEPS[second.step].ask } : { step: 'review', ask: STEPS.review.ask },
  };
}

/**
 * Plain-language bulk-discount suggestion for a price. Keeps the suggestion
 * below the item price (500 naira off a 200-naira item would be impossible)
 * and rounds to a friendly 50-naira step where possible.
 */
function discountSuggestion(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 500;
  const raw = Math.min(500, Math.floor(p * 0.1));
  if (raw >= 100) return Math.max(50, Math.floor(raw / 50) * 50);
  return Math.max(1, raw);
}

// ─── Spoken number parsing ("one hundred and fifty thousand naira") ─────────

const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

/**
 * Parse a spoken or typed price into naira. Handles digits ("150,000",
 * "₦150000", "70k", "1.5m") and English number words up to millions.
 * Returns a number or null when nothing parseable is present.
 */
function parsePriceWords(raw) {
  if (raw == null) return null;
  let s = String(raw).toLowerCase().replace(/[₦₦$,\s]+/g, ' ').trim();
  s = s.replace(/\bnaira\b/g, '').trim();
  if (!s) return null;

  const mult = s.match(/^([\d.]+)\s*([km])$/);
  if (mult) {
    const n = parseFloat(mult[1]);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * (mult[2] === 'm' ? 1000000 : 1000));
  }

  if (/^[\d. ]+$/.test(s)) {
    const n = parseFloat(s.replace(/ /g, ''));
    return Number.isFinite(n) ? n : null;
  }

  const words = s.replace(/-/g, ' ').split(/\s+/).filter((w) => w && w !== 'and');
  if (!words.length || words.some((w) => !(w in ONES) && !(w in TENS) && w !== 'hundred' && w !== 'thousand' && w !== 'million')) {
    return null;
  }
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (w in ONES) current += ONES[w];
    else if (w in TENS) current += TENS[w];
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; }
    else if (w === 'million') { total += (current || 1) * 1000000; current = 0; }
  }
  return total + current;
}

function validatePrice(n, postType) {
  if (!Number.isFinite(n)) return 'not_a_number';
  if (postType === 'service') return n >= 0 ? null : 'negative';
  if (n <= 0) return 'not_positive';
  if (n < MIN_PRICE) return 'below_minimum';
  return null;
}

function validateQuantity(n) {
  if (!Number.isInteger(n)) return 'not_a_number';
  if (n < 1) return 'too_small';
  if (n > MAX_QTY) return 'too_big';
  return null;
}

// ─── Listing post-error guidance ─────────────────────────────────────────────
// Fixed codes the phone reports when posting fails (validation or server).
// Each maps to one short spoken sentence that names the fix. Unknown codes
// get a gentle generic line, never an invented diagnosis.
const LISTING_GUIDANCE = {
  photo_missing: 'Your ad needs a photo. Choose one from your gallery or take a new one with the camera, then tap Post again.',
  price_invalid: 'The price is not right. Type the price in naira, numbers only, at least 100, then tap Post again.',
  quantity_invalid: 'Tell me how many you have. Type a number from 1 to 10,000, then tap Post again.',
  field_missing: 'One box on the form is still empty. I have moved you to it. Fill it and tap Post again.',
  content_blocked: 'Some words in the ad are not allowed. Remove phone numbers, account numbers and web links, then tap Post again.',
  network_unavailable: 'No internet connection. Your ad is saved here. Check the network and tap Post again.',
  publish_failed: 'Posting did not work just now. Nothing was lost. Check the connection and tap Post again.',
};

function explainListingError(code) {
  const key = String(code || '').trim().toLowerCase().slice(0, 32);
  const say = LISTING_GUIDANCE[key] || LISTING_GUIDANCE.publish_failed;
  return { code: LISTING_GUIDANCE[key] ? key : 'publish_failed', say };
}

// ─── Review readout ──────────────────────────────────────────────────────────
// Ordered recap of the validated draft for the final read-back. The model
// reads these lines start to end before asking the seller to post. Values
// come from tool-validated drafts only, never from model text.
function reviewRecap(type, draft = {}) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const naira = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0
      ? `₦${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
      : '';
  };
  const lines = [];
  const title = String(d.title || '').trim();
  if (title) lines.push(`Item: ${title}`);
  const desc = String(d.description || '').trim();
  if (desc) lines.push(`Description: ${desc.slice(0, 200)}`);
  if (d.price !== undefined && d.price !== '') {
    const p = naira(d.price);
    if (p) lines.push(`Price: ${p}`);
  }
  if (type === 'regular') {
    if (d.quantity !== undefined) lines.push(`Quantity: ${d.quantity}`);
    if (d.bulkDiscountMinQty || d.bulkDiscountOff || d.bulkDiscountPrice) {
      const bits = [];
      if (d.bulkDiscountMinQty) bits.push(`from ${d.bulkDiscountMinQty} units`);
      if (d.bulkDiscountOff) bits.push(`${naira(d.bulkDiscountOff)} off each`);
      if (d.bulkDiscountPrice && !d.bulkDiscountOff) bits.push(`at ${naira(d.bulkDiscountPrice)} each`);
      if (bits.length) lines.push(`Discount: ${bits.join(', ')}`);
    }
    if (d.condition) lines.push(`Condition: ${d.condition}`);
  }
  if (d.category) lines.push(`Category: ${readableCategory(d.category)}`);
  if (d.location) lines.push(`Location: ${d.location}`);
  if (d.serviceType) lines.push(`Service type: ${d.serviceType}`);
  return lines;
}

/**
 * Snapshot flags for fields a patch just wrote, so the same turn can tell the
 * model what is now done. Mirrors the flag names CreateAdScreen reports in
 * `reportFormSnapshot`, which is what `nextStep` reads.
 */
function flagsForFields(postType, fields = {}) {
  const type = cleanType(postType) || 'regular';
  const f = fields && typeof fields === 'object' ? fields : {};
  const out = {};
  if (f.title !== undefined) out.title = true;
  if (f.description !== undefined) out.caption = true;
  if (f.price !== undefined) out.priceValid = true;
  if (f.quantity !== undefined) {
    out.quantity = true;
    out.quantityCount = Number(f.quantity) || null;
  }
  if (f.bulkDiscountMinQty !== undefined || f.bulkDiscountOff !== undefined
    || f.bulkDiscountPrice !== undefined) out.bulkDiscount = true;
  if (f.condition !== undefined) out.condition = true;
  if (f.category !== undefined) {
    if (type === 'service') out.serviceCategory = true;
    else if (type === 'digital') out.digitalCategory = true;
    else out.category = true;
  }
  if (f.location !== undefined) {
    if (type === 'service') out.serviceLocation = true;
    else out.location = true;
  }
  if (f.serviceType !== undefined) out.serviceType = true;
  if (f.postType !== undefined) out.postType = type;
  return out;
}

module.exports = {
  POST_TYPES,
  STEPS,
  ORDERS,
  MIN_PRICE,
  MAX_QTY,
  readableCategory,
  cleanType,
  nextStep,
  flagsForFields,
  discountSuggestion,
  parsePriceWords,
  validatePrice,
  validateQuantity,
  LISTING_GUIDANCE,
  explainListingError,
  reviewRecap,
};
