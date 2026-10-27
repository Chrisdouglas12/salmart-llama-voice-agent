'use strict';

/**
 * Aya Shelfie: one photo of a table, shelf or stall becomes several draft
 * listings.
 *
 * CommonJS port of salmart-llama-voice-agent/backend/lib/shelfie.js. Same
 * behaviour, but the two host-specific dependencies are injected by the route:
 *
 *   search(query)            -> routes/assistantRoutes.js searchProducts()
 *   normalizeFields(raw)     -> routes/assistantRoutes.js normalizeAdFields()
 *
 * That keeps this file free of Mongo and of the host's form vocabulary, so it
 * can be unit-tested on its own.
 *
 * The model never prices anything. It only describes what it sees and draws a
 * box around it; prices come from real Salmart listings, and the same
 * comparables always produce the same band. Nothing is published: the route
 * returns drafts and the phone opens the normal Create Ad form.
 */

const { spawn } = require('child_process');
const { config, shouldUseMock } = require('./config.js');
const { visionJSON } = require('./llama.js');

// Optional, exactly like the voice path: if the bundled binary is missing we
// still try an ffmpeg on PATH, and if there is none the cards use a full-frame
// thumbnail instead of a crop.
let ffmpegBin = null;
try {
  ffmpegBin = require('@ffmpeg-installer/ffmpeg').path;
} catch (_e) {
  ffmpegBin = null;
}

const MAX_ITEMS = 6;
const THUMB_WIDTH = 480;
const CROP_TIMEOUT_MS = 8000;
const CROP_CONCURRENCY = 3;

// The form's vocabulary. Keep in sync with AD_CATEGORIES / AD_CONDITIONS in
// routes/assistantRoutes.js and src/assistant/adDraft.js in the mobile app.
const POST_CATEGORIES = [
  'electronics', 'fashion', 'books', 'food_items', 'home',
  'vehicles', 'music', 'services', 'digital', 'others',
];

const CATEGORY_LABELS = {
  electronics: 'Electronics',
  fashion: 'Fashion',
  books: 'Books',
  food_items: 'Food',
  home: 'Home & Garden',
  vehicles: 'Vehicles',
  music: 'Music Gear',
  services: 'Services',
  digital: 'Digital',
  others: 'Other',
};

const CONDITIONS = ['New', 'Like New', 'Good', 'Fair', 'For Parts'];

const CATEGORY_KEYWORDS = {
  electronics: [
    'iphone', 'phone', 'laptop', 'computer', 'tv', 'television', 'camera', 'speaker',
    'headphone', 'earphone', 'charger', 'tablet', 'ipad', 'console', 'playstation',
    'xbox', 'monitor', 'printer', 'power bank', 'generator', 'router', 'smartwatch',
  ],
  fashion: [
    'shoe', 'sneaker', 'bag', 'handbag', 'dress', 'shirt', 'trouser', 'jean',
    'jacket', 'wig', 'watch', 'sunglasses', 'sandal', 'slipper', 'cloth', 'gown',
  ],
  books: ['book', 'novel', 'textbook', 'journal', 'bible', 'magazine'],
  food_items: ['food', 'rice', 'beans', 'garri', 'oil', 'pepper', 'tomato', 'chicken', 'fish', 'snack', 'cake'],
  home: [
    'sofa', 'chair', 'table', 'bed', 'mattress', 'fridge', 'freezer', 'cooker',
    'pot', 'curtain', 'rug', 'fan', 'blender', 'microwave', 'wardrobe', 'mirror',
  ],
  vehicles: ['car', 'toyota', 'honda', 'lexus', 'bike', 'motorcycle', 'tyre', 'tire', 'engine', 'bus'],
  music: ['guitar', 'piano', 'drum', 'microphone', 'violin', 'saxophone', 'trumpet'],
  digital: ['ebook', 'course', 'template', 'account', 'subscription', 'software'],
};

// ── Vision prompt ────────────────────────────────────────────────────────────

const SHELF_PROMPT = `You are Aya, the shelf scanner for Salmart, a Nigerian marketplace. You see ONE photo of a table, shelf, stall, bed or floor where a seller has arranged several different items for sale.

Find every distinct, sellable physical item. Ignore the surface itself, the wall, hands, price tags, packaging and duplicates of the same physical object.

Reply with JSON only, no prose:
{"items":[{"title":"3-6 word item name","description":"one short sentence a buyer would understand","condition":"New|Like New|Good|Fair|For Parts|null","category":"electronics|fashion|books|food_items|home|vehicles|music|services|digital|others|null","bbox":[x,y,width,height],"confidence":0.0}]}

Rules:
- bbox is the item's box in normalised coordinates: x and y are the top-left corner, width and height are fractions of the image, all from 0 to 1.
- Return at most ${MAX_ITEMS} items. Put the clearest or most valuable items first.
- Title must be specific: "Nike Air Force 1 sneakers", not "shoes".
- condition must be one of ${CONDITIONS.join(', ')}. Use null unless the photo clearly shows it.
- category must be one of ${POST_CATEGORIES.join(', ')} (${POST_CATEGORIES.map(k => CATEGORY_LABELS[k]).join(', ')}). Use null if unsure.
- NEVER invent a price, an amount in Naira, a phone number or a location. Price is computed later from real Salmart listings.
- If the photo shows one item, return one item. If it shows nothing sellable, return {"items":[]}.
- Describe only what is visible.`;

// ── Local vocabulary helpers ─────────────────────────────────────────────────

const matchList = (arr, v) => {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return arr.find(x => x.toLowerCase() === s) || '';
};

function normalizeCategory(value) {
  return matchList(POST_CATEGORIES, value);
}

function inferCategory(text) {
  const s = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  for (const [key, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      const needle = w.replace(/[^a-z0-9]+/g, ' ');
      if (!needle) continue;
      if (s.includes(` ${needle} `) || s.includes(` ${needle}s `)) return key;
    }
  }
  return '';
}

function normalizeCondition(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return '';
  const exact = matchList(CONDITIONS, s);
  if (exact) return exact;
  if (/\b(like new|almost new|nearly new|open box|sealed)\b/.test(s)) return 'Like New';
  if (/\b(brand new|new|unused|never used)\b/.test(s)) return 'New';
  if (/\b(fairly used|second hand|secondhand|used|tokunbo|okrika|foreign used)\b/.test(s)) return 'Good';
  if (/\b(fair|fair condition|manageable|manage)\b/.test(s)) return 'Fair';
  if (/\b(for parts|broken|spoilt|spoiled|faulty|scrap|not working)\b/.test(s)) return 'For Parts';
  return '';
}

function itemTokens(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

// ── Boxes ────────────────────────────────────────────────────────────────────

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const floor4 = v => Math.floor(v * 10000 + 1e-4) / 10000;
const round2 = v => Math.round(v * 100) / 100;
const clamp01 = v => Math.max(0, Math.min(1, v));

/**
 * Accept a normalised box as [x, y, width, height] or as an object, and return
 * `{ x, y, w, h }` clamped inside the frame. Percent boxes (0-100) are tolerated
 * because models drift. Pixel boxes are rejected: we never know the image size
 * here, and a wrong crop is worse than the full photo.
 */
function normalizeBbox(raw) {
  let box = null;

  if (Array.isArray(raw) && raw.length >= 4) {
    const [x, y, w, h] = raw.slice(0, 4).map(num);
    if ([x, y, w, h].every(v => v !== null)) box = { x, y, w, h };
  } else if (raw && typeof raw === 'object') {
    if (raw.x != null && raw.y != null && (raw.w != null || raw.width != null) && (raw.h != null || raw.height != null)) {
      box = {
        x: num(raw.x), y: num(raw.y),
        w: num(raw.w != null ? raw.w : raw.width),
        h: num(raw.h != null ? raw.h : raw.height),
      };
    } else if (raw.left != null && raw.top != null && raw.right != null && raw.bottom != null) {
      const left = num(raw.left);
      const top = num(raw.top);
      const right = num(raw.right);
      const bottom = num(raw.bottom);
      if ([left, top, right, bottom].every(v => v !== null)) {
        box = { x: left, y: top, w: right - left, h: bottom - top };
      }
    }
  }

  if (!box || [box.x, box.y, box.w, box.h].some(v => v === null)) return null;

  const max = Math.max(box.x, box.y, box.w, box.h);
  if (max > 1.0001) {
    if (max > 100) return null;
    box = { x: box.x / 100, y: box.y / 100, w: box.w / 100, h: box.h / 100 };
  }

  const x = clamp01(box.x);
  const y = clamp01(box.y);
  const w = Math.min(Math.max(box.w, 0.04), 1 - x);
  const h = Math.min(Math.max(box.h, 0.04), 1 - y);
  if (w < 0.04 || h < 0.04) return null;

  // Floor, never round: x + w must stay <= 1 or ffmpeg's crop filter errors.
  const rx = floor4(x);
  const ry = floor4(y);
  let rw = floor4(w);
  let rh = floor4(h);
  if (rx + rw > 1) rw = Math.max(0.04, floor4(1 - rx));
  if (ry + rh > 1) rh = Math.max(0.04, floor4(1 - ry));
  if (rw < 0.04 || rh < 0.04) return null;

  return { x: rx, y: ry, w: rw, h: rh };
}

function bboxIoU(a, b) {
  if (!a || !b) return 0;
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return 0;
  const inter = (right - left) * (bottom - top);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** ffmpeg video filter for one card photo (normalised crop + downscale). */
function bboxCropFilter(bbox, width = THUMB_WIDTH) {
  const b = normalizeBbox(bbox);
  const scale = `scale=${width}:-2`;
  if (!b) return scale;
  return `crop=iw*${b.w}:ih*${b.h}:iw*${b.x}:ih*${b.y},${scale}`;
}

// ── Item normalisation / de-duplication ──────────────────────────────────────

function cleanTitle(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*\d+[.)]\s*/, '')
    .trim()
    .slice(0, 90);
}

function slug(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'item';
}

function normalizeShelfItem(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanTitle(raw.title != null ? raw.title : (raw.name != null ? raw.name : raw.label));
  if (!title) return null;

  const description = String(raw.description != null ? raw.description : (raw.caption != null ? raw.caption : ''))
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300) || `${title} for sale.`;
  const category = normalizeCategory(raw.category) || inferCategory(`${title} ${description}`) || 'others';
  const condition = normalizeCondition(raw.condition != null ? raw.condition : raw.productCondition);
  const confidence = round2(Math.max(0.4, Math.min(1, num(raw.confidence) != null ? num(raw.confidence) : 0.5)));

  return {
    id: `shelf-${index + 1}-${slug(title)}`,
    index,
    title,
    description,
    condition,
    category,
    categoryLabel: CATEGORY_LABELS[category] || category,
    bbox: normalizeBbox(raw.bbox != null ? raw.bbox : raw.box),
    confidence,
  };
}

function sameItem(a, b) {
  const ta = new Set(itemTokens(a.title));
  const tb = new Set(itemTokens(b.title));
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  const containment = shared / Math.min(ta.size, tb.size);
  if (containment >= 0.8) return true;
  return bboxIoU(a.bbox, b.bbox) >= 0.6 && containment >= 0.4;
}

/** The model sometimes lists the same shoe twice. Keep the more confident one. */
function dedupeShelfItems(items = []) {
  const out = [];
  for (const item of items) {
    if (!item) continue;
    const at = out.findIndex(existing => sameItem(existing, item));
    if (at === -1) out.push(item);
    else if (item.confidence > out[at].confidence) out[at] = item;
  }
  return out.map((item, index) => ({ ...item, index, id: `shelf-${index + 1}-${slug(item.title)}` }));
}

// ── Deterministic price bands ────────────────────────────────────────────────

function priceStep(value) {
  const n = Math.abs(Number(value) || 0);
  if (n < 5000) return 100;
  if (n < 20000) return 500;
  if (n < 100000) return 1000;
  if (n < 500000) return 5000;
  if (n < 2000000) return 10000;
  return 50000;
}

const roundTo = (value, step) => Math.max(step, Math.round(value / step) * step);

/**
 * Median with an inter-quartile band, rounded to human Naira steps. Pure and
 * deterministic: the same comparables always produce the same three numbers.
 */
function computePriceBand(prices = []) {
  const list = prices
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (!list.length) return null;

  const quantile = (p) => {
    const i = (list.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return list[lo] + (list[hi] - list[lo]) * (i - lo);
  };

  const mid = quantile(0.5);
  let low = quantile(0.25);
  let high = quantile(0.75);
  if (high <= low) {
    low = mid * 0.85;
    high = mid * 1.15;
  }

  const step = priceStep(mid);
  const priceMin = Math.max(step, Math.floor(low / step) * step);
  const priceMax = Math.max(priceMin + step, Math.ceil(high / step) * step);
  const price = Math.min(priceMax, Math.max(priceMin, roundTo(mid, step)));

  return { price, priceMin, priceMax };
}

/**
 * Comparable listings for one item. The first query is the item title; the
 * category is only a fallback, and a fallback is reported as low confidence so
 * the UI does not pretend a handbag comp priced a wristwatch.
 */
async function findComps(item, search) {
  let res = await search({ query: item.title, category: item.category, limit: 8 });
  let products = (res.products || []).filter(p => Number(p.price) > 0);

  const tokens = new Set(itemTokens(item.title));
  // A comp must share a real part of the title, not merely the category. This
  // is what stops an iPhone 12 from pricing an iPhone 11 listing.
  const sharesTitle = (p) => {
    if (!tokens.size) return false;
    const words = new Set(itemTokens(p.title));
    let shared = 0;
    for (const t of tokens) if (words.has(t)) shared += 1;
    if (!shared) return false;
    return shared / Math.min(tokens.size, words.size) >= 0.6;
  };
  let matched = products.filter(sharesTitle);

  if (!matched.length) {
    const byCategory = await search({ category: item.category, limit: 8 });
    products = (byCategory.products || []).filter(p => Number(p.price) > 0);
    matched = products.filter(sharesTitle);
    res = byCategory;
  }

  const seen = new Set();
  const comps = (matched.length ? matched : products).filter((p) => {
    const key = String(p.postId || p._id || p.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    comps,
    matched: matched.length > 0,
    // The host always searches the real Post collection.
    source: res.source === 'demo' ? 'demo-listings' : 'salmart-listings',
  };
}

/** Mirror of the mobile form's required set for a regular listing. */
function missingRequired(draft = {}) {
  const missing = [];
  if (!String(draft.title || '').trim()) missing.push('item name');
  if (!String(draft.description || draft.caption || '').trim()) missing.push('caption');
  if (!Number.isFinite(Number(draft.price)) || Number(draft.price) <= 0) missing.push('price');
  if (!String(draft.condition || draft.productCondition || '').trim()) missing.push('condition');
  if (!String(draft.category || '').trim()) missing.push('category');
  if (!String(draft.location || '').trim()) missing.push('location');
  return missing;
}

async function buildDraft(item, location, { search, normalizeFields }) {
  let band = null;
  let priceSource = null;
  let priceConfidence = null;
  let compTitles = [];
  let compCount = 0;

  try {
    const { comps, matched, source } = await findComps(item, search);
    compCount = comps.length;
    compTitles = [...new Set(comps.map(c => c.title).filter(Boolean))].slice(0, 3);
    band = computePriceBand(comps.map(c => c.price));
    if (band) {
      priceSource = source;
      priceConfidence = !matched
        ? 'low'
        : compCount >= 3 ? 'high' : compCount === 2 ? 'medium' : 'low';
    }
  } catch (e) {
    console.warn(`[shelfie] comps failed for "${item.title}": ${e.message}`);
  }

  const fields = normalizeFields({
    postType: 'regular',
    title: item.title,
    description: item.description,
    condition: item.condition || undefined,
    category: item.category,
    location,
    ...(band ? { price: band.price } : {}),
  }, 'regular');

  return {
    ...item,
    location: fields.location || '',
    price: band ? band.price : null,
    priceMin: band ? band.priceMin : null,
    priceMax: band ? band.priceMax : null,
    priceSource,
    priceConfidence,
    compCount,
    compTitles,
    fields,
    missing: missingRequired(fields),
  };
}

// ── Canned shelf (explicit fallback only) ────────────────────────────────────

/**
 * A believable seller's table. Used only when the caller opts in, and always
 * marked `fallback: true` in the response. The boxes are normalised so the
 * crops still land in sensible places on whatever photo was uploaded.
 */
function cannedShelfItems() {
  return [
    {
      title: 'Nike Air Force 1 Sneakers',
      description: 'White Nike Air Force 1 sneakers, size 43, worn twice.',
      condition: 'Like New', category: 'fashion',
      bbox: [0.06, 0.15, 0.38, 0.36], confidence: 0.5,
    },
    {
      title: 'Ladies Leather Handbag',
      description: 'Black leather handbag with a gold chain strap.',
      condition: 'Good', category: 'fashion',
      bbox: [0.5, 0.1, 0.3, 0.34], confidence: 0.45,
    },
    {
      title: 'iPhone 11 64GB',
      description: 'iPhone 11, 64GB, clean screen, Face ID works.',
      condition: 'Good', category: 'electronics',
      bbox: [0.1, 0.58, 0.3, 0.3], confidence: 0.42,
    },
    {
      title: 'Acoustic Guitar',
      description: 'Acoustic guitar with a soft bag, good sound.',
      condition: 'Good', category: 'music',
      bbox: [0.48, 0.52, 0.42, 0.44], confidence: 0.4,
    },
  ].map((raw, index) => ({ ...normalizeShelfItem(raw, index), fallback: true }));
}

// ── Photo crops ──────────────────────────────────────────────────────────────

function runCrop(input, filter) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (buf) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(buf);
    };

    let child;
    try {
      child = spawn(ffmpegBin || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vf', filter,
        '-frames:v', '1',
        '-f', 'image2pipe',
        '-c:v', 'mjpeg',
        '-q:v', '4',
        'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (_e) {
      return finish(null);
    }

    const out = [];
    timer = setTimeout(() => {
      try { child.kill(); } catch (_e) { /* already gone */ }
      finish(null);
    }, CROP_TIMEOUT_MS);

    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', () => { /* exit code says enough */ });
    child.on('error', () => finish(null));
    child.on('close', code => finish(code === 0 && out.length ? Buffer.concat(out) : null));
    child.stdin.on('error', () => { /* reported by close/error */ });
    child.stdin.end(input);
  });
}

const dataUri = buf => `data:image/jpeg;base64,${buf.toString('base64')}`;

/**
 * Crop one thumbnail per item. A failed crop falls back to a full-frame
 * thumbnail, so every card still has a photo; a missing ffmpeg returns nulls
 * and the app renders a placeholder.
 */
async function cropThumbnails(buffer, boxes = [], { width = THUMB_WIDTH } = {}) {
  if (!buffer || !buffer.length) return boxes.map(() => null);

  const results = new Array(boxes.length).fill(null);
  let cursor = 0;

  const worker = async () => {
    while (cursor < boxes.length) {
      const i = cursor;
      cursor += 1;
      const cropped = await runCrop(buffer, bboxCropFilter(boxes[i], width));
      if (cropped) results[i] = dataUri(cropped);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CROP_CONCURRENCY, boxes.length) }, worker));

  if (results.some(r => !r)) {
    const full = await runCrop(buffer, `scale=${width}:-2`);
    if (full) {
      for (let i = 0; i < results.length; i += 1) if (!results[i]) results[i] = dataUri(full);
    }
  }

  return results;
}

// ── Model output ─────────────────────────────────────────────────────────────

function payloadItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['items', 'products', 'listings', 'objects', 'shelf']) {
    if (Array.isArray(data[key])) return data[key];
  }
  if (data.title || data.name) return [data];
  return [];
}

function parseShelfPayload(data) {
  return payloadItems(data);
}

// ── Message ──────────────────────────────────────────────────────────────────

function joinNames(names) {
  if (names.length <= 1) return names[0] || 'one item';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function shelfMessage(items, { fallback = false } = {}) {
  const priced = items.filter(i => i.price != null).length;
  const noPrice = items.length - priced;
  const bits = [];

  if (fallback) bits.push("I can't read photos in this mode, so this is a sample shelf.");
  bits.push(`I see ${items.length} ${items.length === 1 ? 'item' : 'items'} here: ${joinNames(items.map(i => i.title))}.`);
  if (priced) {
    bits.push(priced === items.length
      ? 'I priced each one from similar Salmart listings.'
      : `I priced ${priced} of them from similar Salmart listings.`);
  }
  if (noPrice) bits.push(`${noPrice} still ${noPrice === 1 ? 'needs' : 'need'} a price — talk am and I'll fill it.`);
  bits.push(`Tap ${items.length === 1 ? 'the card' : 'a card'} to check am, then Post. I no dey post by myself.`);

  return bits.join(' ');
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * Scan one photo and return priced drafts.
 *
 * @param {object}   args
 * @param {Buffer}   args.buffer            image bytes
 * @param {string}   [args.mime]            image mime type
 * @param {string}   [args.text]            what the seller said with the photo
 * @param {string}   [args.location]        seller's state, or found in `text`
 * @param {boolean}  [args.fallback]        allow the canned shelf if nothing is detected
 * @param {Function} args.search            injected searchProducts()
 * @param {Function} args.normalizeFields   injected normalizeAdFields()
 * @param {Function} [args.normalizeLocation]
 * @param {Function} [args.findLocation]
 */
async function scanShelfImage({
  buffer,
  mime = 'image/jpeg',
  text = '',
  location = '',
  fallback = false,
  search,
  normalizeFields,
  normalizeLocation,
  findLocation,
} = {}) {
  if (typeof search !== 'function' || typeof normalizeFields !== 'function') {
    throw new Error('shelfie: search and normalizeFields must be injected');
  }

  if (!buffer || !buffer.length) {
    return {
      success: false, code: 'NO_IMAGE',
      message: "I didn't get the photo. Try again.",
      items: [], actions: [], navigations: [],
    };
  }

  const words = String(text || '').trim();
  const givenPlace = typeof normalizeLocation === 'function' ? normalizeLocation(location) : String(location || '').trim();
  const place = givenPlace || (typeof findLocation === 'function' ? findLocation(words) : '');
  let raw = [];
  let provider = 'demo-vision';
  let model = 'shelfie-fallback';
  let warning;
  let usedFallback = false;

  if (!shouldUseMock()) {
    try {
      const { data, model: used } = await visionJSON({
        prompt: `${SHELF_PROMPT}\n\nSeller's words (may be empty): "${words}"`,
        images: [{ base64: buffer.toString('base64'), mime: mime || 'image/jpeg' }],
        maxTokens: 1800,
        reasoningEffort: 'minimal',
      });
      raw = parseShelfPayload(data);
      provider = 'meta-model-api';
      model = used || config.meta.visionModel;
      if (!raw.length) warning = 'The model did not find a sellable item in this photo.';
    } catch (e) {
      console.error('[shelfie] vision failed:', e.message);
      warning = 'The photo scan failed, so the shelf could not be read.';
    }
  } else {
    warning = 'Demo mode: the photo was not sent to a vision model.';
  }

  let items = dedupeShelfItems(
    raw.map((r, i) => normalizeShelfItem(r, i)).filter(Boolean),
  ).slice(0, MAX_ITEMS);

  if (!items.length) {
    if (!fallback) {
      return {
        success: false,
        code: 'NO_ITEMS',
        message: "I couldn't pick out any item in that photo. Move closer, use better light, or list one item with the photo button.",
        items: [],
        actions: [],
        navigations: [],
        provider,
        model,
        ...(warning ? { warning } : {}),
      };
    }
    items = cannedShelfItems();
    usedFallback = true;
    provider = 'canned-shelf';
    model = 'shelfie-fallback';
  }

  const drafts = [];
  for (const item of items) drafts.push(await buildDraft(item, place, { search, normalizeFields }));

  const photos = await cropThumbnails(buffer, drafts.map(d => d.bbox));
  drafts.forEach((draft, i) => { draft.photo = photos[i] || null; });

  return {
    success: true,
    message: shelfMessage(drafts, { fallback: usedFallback }),
    count: drafts.length,
    items: drafts,
    actions: [{ type: 'shelf_drafts', count: drafts.length }],
    navigations: [],
    provider,
    model,
    ...(warning ? { warning } : {}),
    ...(usedFallback ? { fallback: true } : {}),
  };
}

module.exports = {
  MAX_ITEMS,
  THUMB_WIDTH,
  SHELF_PROMPT,
  normalizeBbox,
  bboxIoU,
  bboxCropFilter,
  normalizeShelfItem,
  dedupeShelfItems,
  priceStep,
  computePriceBand,
  cannedShelfItems,
  cropThumbnails,
  parseShelfPayload,
  shelfMessage,
  scanShelfImage,
};
