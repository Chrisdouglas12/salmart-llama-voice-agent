/* CommonJS port of salmart-llama-voice-agent/backend/lib/form.js.
 * Generated from the hackathon repo; keep the two in sync. */
/**
 * The Salmart Create Ad vocabulary and language normalisation.
 *
 * This file is intentionally pure (no I/O). It mirrors the mobile app's
 * src/assistant/adDraft.js so a value that leaves the agent is guaranteed to be
 * a value CreateAdScreen can actually hold. Keep it in sync when the app adds a
 * category or a state.
 */

const CONDITIONS = ["New", "Like New", "Good", "Fair", "For Parts"];

const SERVICE_CATEGORIES = ["tech", "design", "writing", "marketing", "repair", "tutoring", "logistics", "other"];
const SERVICE_TYPES = ["remote", "onsite", "both"];

const POST_CATEGORIES = [
  "electronics", "fashion", "books", "food_items", "home",
  "vehicles", "music", "services", "digital", "others",
];

const CATEGORY_LABELS = {
  electronics: "Electronics",
  fashion: "Fashion",
  books: "Books",
  food_items: "Food",
  home: "Home & Garden",
  vehicles: "Vehicles",
  music: "Music Gear",
  services: "Services",
  digital: "Digital",
  others: "Other",
};

const NIGERIAN_LOCATIONS = [
  "Nationwide",
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi",
  "Bayelsa", "Benue", "Borno", "Cross River", "Delta",
  "Ebonyi", "Edo", "Ekiti", "Enugu", "FCT - Abuja",
  "Gombe", "Imo", "Jigawa", "Kaduna", "Kano",
  "Katsina", "Kebbi", "Kogi", "Kwara", "Lagos",
  "Nasarawa", "Niger", "Ogun", "Ondo", "Osun",
  "Oyo", "Plateau", "Rivers", "Sokoto", "Taraba",
  "Yobe", "Zamfara",
];

/** Cities / common spellings -> the state value the form accepts. */
const LOCATION_ALIASES = {
  abuja: "FCT - Abuja",
  fct: "FCT - Abuja",
  "fct abuja": "FCT - Abuja",
  "port harcourt": "Rivers",
  "port-harcourt": "Rivers",
  ph: "Rivers",
  "benin city": "Edo",
  benin: "Edo",
  jos: "Plateau",
  makurdi: "Benue",
  owerri: "Imo",
  uyo: "Akwa Ibom",
  calabar: "Cross River",
  warri: "Delta",
  asaba: "Delta",
  onitsha: "Anambra",
  awka: "Anambra",
  enugu: "Enugu",
  aba: "Abia",
  umuahia: "Abia",
  ibadan: "Oyo",
  abeokuta: "Ogun",
  sagamu: "Ogun",
  ilorin: "Kwara",
  lokoja: "Kogi",
  maiduguri: "Borno",
  sokoto: "Sokoto",
  katsina: "Katsina",
  gusau: "Zamfara",
  dutse: "Jigawa",
  damaturu: "Yobe",
  gombe: "Gombe",
  bauchi: "Bauchi",
  yola: "Adamawa",
  jalingo: "Taraba",
  lafia: "Nasarawa",
  minna: "Niger",
  "birnin kebbi": "Kebbi",
  akure: "Ondo",
  "ado ekiti": "Ekiti",
  osogbo: "Osun",
  abakaliki: "Ebonyi",
  yenagoa: "Bayelsa",
  kano: "Kano",
  kaduna: "Kaduna",
  lagos: "Lagos",
  ikeja: "Lagos",
  lekki: "Lagos",
  yaba: "Lagos",
  surulere: "Lagos",
  ikoyi: "Lagos",
  ajah: "Lagos",
  nationwide: "Nationwide",
};

const POST_TYPE_KEYS = ["regular", "service", "digital"];

const CATEGORY_KEYWORDS = {
  electronics: [
    "phone", "phones", "iphone", "samsung", "tecno", "infinix", "itel", "xiaomi",
    "redmi", "oppo", "vivo", "laptop", "macbook", "computer", "pc", "tablet",
    "ipad", "tv", "television", "monitor", "generator", "speaker", "headphone",
    "headphones", "earphone", "earphones", "charger", "camera", "console", "ps5",
    "xbox", "power bank", "powerbank", "router",
  ],
  fashion: [
    "shoe", "shoes", "sneaker", "sneakers", "slipper", "slippers", "sandal",
    "sandal", "bag", "bags", "handbag", "dress", "shirt", "trouser", "jean",
    "jeans", "cloth", "clothes", "wig", "watch", "jewelry", "jewellery", "cap",
    "hat", "ankara", "lace", "abaya", "hijab",
  ],
  books: ["book", "books", "novel", "textbook", "jamb", "waec", "bible", "quran", "magazine"],
  food_items: [
    "rice", "beans", "spaghetti", "noodles", "oil", "garri", "yam", "tomato",
    "pepper", "fish", "chicken", "food", "snack", "snacks", "drink", "water",
    "flour", "sugar", "milk", "eggs",
  ],
  home: [
    "house", "flat", "apartment", "land", "plot", "property", "sofa", "chair",
    "table", "bed", "mattress", "fridge", "freezer", "cooker", "pot", "curtain",
    "rug", "fan", "air conditioner", "ac", "wardrobe", "cupboard", "mirror",
  ],
  vehicles: [
    "car", "toyota", "honda", "lexus", "benz", "mercedes", "keke", "bike",
    "motorcycle", "bus", "truck", "vehicle", "tyre", "tire", "camry", "corolla",
    "sienna", "rav4", "hilux",
  ],
  music: ["guitar", "piano", "keyboard", "drum", "drums", "microphone", "mixer", "instrument"],
  services: [
    "service", "repair", "plumber", "electrician", "tailor", "tutoring", "tutor",
    "design", "delivery", "logistics", "cleaning", "barber", "hairdresser",
    "catering", "photography",
  ],
  digital: ["digital", "ebook", "e-book", "course", "template", "software", "subscription", "design file"],
  others: [],
};

/** Words that mean "this is the thing I want to sell / find". */
const ITEM_WORDS = [
  "house", "flat", "apartment", "land", "plot", "shoe", "shoes", "sneaker",
  "bag", "handbag", "phone", "iphone", "samsung", "laptop", "car", "toyota",
  "rice", "sofa", "generator", "fridge", "freezer", "tv", "bed", "mattress",
  "dress", "shirt", "wig", "watch", "book", "bike", "motorcycle", "guitar",
];

const pick = (list, v) => {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return list.find(x => String(x).toLowerCase() === s) || "";
};

/** Brands and acronyms that must not be shouted or lower-cased. */
const SPECIAL_CASE = {
  iphone: "iPhone", ipad: "iPad", ipod: "iPod", imac: "iMac", macbook: "MacBook",
  tv: "TV", ac: "AC", ps5: "PS5", ps4: "PS4", dvd: "DVD", usb: "USB",
  hp: "HP", lg: "LG", samsung: "Samsung", jamb: "JAMB", waec: "WAEC",
  suv: "SUV", cpu: "CPU", gpu: "GPU", ssd: "SSD", hdd: "HDD", ram: "RAM",
};

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[a-z0-9]+/g, (w) => SPECIAL_CASE[w] || w.charAt(0).toUpperCase() + w.slice(1));
}

function normalizePostType(value, fallback = "regular") {
  return pick(POST_TYPE_KEYS, value) || fallback;
}

function normalizeCategory(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s) return "";
  if (POST_CATEGORIES.includes(s)) return s;
  const byLabel = Object.entries(CATEGORY_LABELS).find(([, label]) => label.toLowerCase() === s);
  if (byLabel) return byLabel[0];
  if (/^food$/.test(s)) return "food_items";
  return "";
}

function inferCategory(text) {
  // Punctuation becomes a space so "flat," still matches the word "flat".
  const s = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const [key, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      const needle = ` ${w.replace(/[^a-z0-9]+/g, " ")} `;
      if (s.includes(needle) || s.includes(`${needle.trim()}s `) || s.includes(` ${needle.trim()}s `)) return key;
    }
  }
  return "";
}

function normalizeCondition(value) {
  const s = String(value || "").trim().toLowerCase();
  if (!s) return "";
  const exact = pick(CONDITIONS, s);
  if (exact) return exact;

  if (/\b(like new|almost new|nearly new|open box|sealed)\b/.test(s)) return "Like New";
  if (/\b(brand new|new|unused|never used)\b/.test(s)) return "New";
  if (/\b(fairly used|second hand|secondhand|used|tokunbo|okrika|foreign used)\b/.test(s)) return "Good";
  if (/\b(fair|fair condition|manageable|manage)\b/.test(s)) return "Fair";
  if (/\b(for parts|broken|spoilt|spoiled|faulty|scrap|not working)\b/.test(s)) return "For Parts";
  return "";
}

function normalizeLocation(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const s = raw.toLowerCase().replace(/[^a-z0-9 -]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s === "nationwide" || s === "anywhere") return "Nationwide";

  const exact = NIGERIAN_LOCATIONS.find(l => l.toLowerCase() === s);
  if (exact) return exact;

  if (LOCATION_ALIASES[s]) return LOCATION_ALIASES[s];

  // "I dey Ikeja, Lagos" -> Lagos. Longest match wins so Port Harcourt beats
  // the bare "Rivers" alias.
  const aliases = Object.keys(LOCATION_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (alias.length > 2 && s.includes(alias)) return LOCATION_ALIASES[alias];
  }
  for (const loc of NIGERIAN_LOCATIONS) {
    if (s.includes(loc.toLowerCase())) return loc;
  }
  return "";
}

/** First location phrase found in free text. */
function findLocation(text) {
  const s = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const aliases = Object.keys(LOCATION_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (s.includes(` ${alias} `)) return LOCATION_ALIASES[alias];
  }
  for (const loc of NIGERIAN_LOCATIONS) {
    if (s.includes(` ${loc.toLowerCase()} `)) return loc;
  }
  return "";
}

const ONES = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const SCALES = { hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000 };

function wordsToNumber(phrase) {
  const tokens = String(phrase || "").toLowerCase().replace(/-/g, " ").split(/\s+/).filter(t => t && t !== "and");
  let total = 0;
  let current = 0;
  let found = false;
  for (const t of tokens) {
    if (ONES[t] != null) { current += ONES[t]; found = true; }
    else if (TENS[t] != null) { current += TENS[t]; found = true; }
    else if (SCALES[t]) {
      const scale = SCALES[t];
      if (scale === 100) current = (current || 1) * 100;
      else { total += (current || 1) * scale; current = 0; }
      found = true;
    }
  }
  return found ? total + current : null;
}

/**
 * Reads a Naira price from natural speech:
 *   "50k", "₦50,000", "fifty thousand", "for 1.2m", "price na 20000".
 * Returns undefined when the number is not a price (e.g. "two bedroom").
 */
function parsePrice(text) {
  const s = String(text || "").toLowerCase().replace(/,/g, " ");
  if (!s.trim()) return undefined;

  let m = s.match(/(?:₦|naira|n)\s*(\d+(?:\.\d+)?)\s*(k|thousand|m|million)?\b/);
  if (m) return scalePrice(m[1], m[2]);

  m = s.match(/(\d+(?:\.\d+)?)\s*(k|thousand|m|million)\b/);
  if (m) return scalePrice(m[1], m[2]);

  m = s.match(/\b(?:price|cost|amount|na)\s*(?:be|is|na)?\s*(\d{1,9})\b/);
  if (m) return parseInt(m[1], 10);

  m = s.match(/\b(\d{4,9})\b/);
  if (m) return parseInt(m[1], 10);

  // Word numbers only when a price word or a scale word is present.
  const wordMatch = s.match(/\b((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\s*)+)\b/);
  if (wordMatch) {
    const phrase = wordMatch[1].trim();
    const hasScale = /\b(hundred|thousand|million)\b/.test(phrase);
    const hasPriceWord = /\b(price|cost|amount|naira|₦)\b/.test(s);
    if (hasScale || hasPriceWord) {
      const n = wordsToNumber(phrase);
      if (n != null && n > 0) return n;
    }
  }
  return undefined;
}

function scalePrice(num, unit) {
  let n = parseFloat(num);
  if (!Number.isFinite(n)) return undefined;
  const u = String(unit || "").toLowerCase();
  if (u === "k" || u === "thousand") n *= 1000;
  if (u === "m" || u === "million") n *= 1000000;
  return Math.round(n);
}

function parseQuantity(text) {
  const s = String(text || "").toLowerCase();
  let m = s.match(/\b(?:quantity|qty|how many)\s*(?:be|is|na)?\s*(\d{1,5})\b/);
  if (m) return Math.max(1, parseInt(m[1], 10));
  m = s.match(/\b(\d{1,5})\s*(?:pieces?|pcs?|units?|bottles?|bags?|cartons?|packs?)\b/);
  if (m) return Math.max(1, parseInt(m[1], 10));
  m = s.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:pieces?|pcs?|units?|bottles?|bags?|cartons?|packs?)\b/);
  if (m) return ONES[m[1]] || undefined;
  return undefined;
}

const LISTING_PREFIX = /^(?:(?:please|abeg|oya|ok|okay)\s+)*(?:(?:i|mi)\s+(?:want|wan|wanna|like|dey)\s+(?:to\s+)?(?:sell|post|list)|help\s+me\s+(?:to\s+)?(?:sell|post|list)|(?:i\s+am|i'm)\s+selling|selling|sell|post|list|create\s+(?:an?\s+)?ad(?:\s+for)?)\s+/i;

/** Strips phone numbers the backend rejects in titles/descriptions. */
function stripPhoneNumbers(text) {
  return String(text || "")
    .replace(/\b\+?\d{1,3}[-.\s]?\d{3,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g, " ")
    .replace(/\b0\d{10}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Turns a spoken listing sentence into Create Ad fields.
 * Only returns fields the seller actually said.
 */
function parseListing(text, base = {}) {
  const raw = stripPhoneNumbers(String(text || "").trim());
  if (!raw) return {};

  const price = parsePrice(raw);
  const condition = normalizeCondition(raw);
  const location = findLocation(raw);
  const quantity = parseQuantity(raw);
  const category = inferCategory(raw) || base.category || "";
  const postType = /(?:i\s+(?:dey\s+)?(?:offer|do)|service|repair|tutoring|tailor|design|delivery|logistics)/i.test(raw)
    ? "service"
    : /(?:ebook|e-book|digital|course|template|software)/i.test(raw) ? "digital" : "regular";

  // Remove the command prefix and the details that have their own fields.
  let core = raw.replace(LISTING_PREFIX, " ").trim();
  core = core
    .replace(/\b(?:for|at|price(?:\s+na)?|cost(?:ing)?)\s*₦?\s*\d[\d.,]*\s*(?:k|thousand|m|million)?\b/gi, " ")
    .replace(/₦\s*\d[\d.,]*\s*(?:k|thousand|m|million)?/gi, " ")
    .replace(/\b\d[\d.,]*\s*(?:k|thousand|m|million)\b/gi, " ")
    .replace(/\b(?:in|for|location(?:\s+na)?|e dey|dey)\s+([A-Za-z -]{3,25})$/gi, (m, loc) => (normalizeLocation(loc) ? " " : m))
    .replace(/\b(?:brand new|like new|almost new|fairly used|second hand|secondhand|tokunbo|used|new)\b/gi, " ")
    .replace(/\b(?:quantity|qty)\s*(?:na|be|is)?\s*\w+/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,.;:\s-]+|[,.;:\s-]+$/g, "")
    .trim();

  // Prefer the first clause; it is normally the item name.
  const firstClause = core.split(/[,.;]|\b(?:and|wey|for|with)\b/i)[0].trim();
  let title = titleCase(firstClause || core)
    // "my phone", "the house", "a bag" -> "Phone", "House", "Bag"
    .replace(/^(?:my|our|the|a|an)\s+/i, "")
    // "... for sale" is a caption, not part of the item name.
    .replace(/\s+for\s+sale$/i, "")
    .trim();
  if (title.length > 90) title = title.slice(0, 90).trim();
  if (/^(something|anything|item|thing|stuff)$/i.test(title)) title = "";

  const description = (() => {
    const clean = raw.replace(LISTING_PREFIX, " ").replace(/\s+/g, " ").trim();
    if (clean.length >= 12) return clean.slice(0, 800);
    if (title) return `${title} for sale${location ? ` in ${location}` : ""}.`;
    return "";
  })();

  const out = {};
  if (title) out.title = title;
  if (description) out.description = description;
  if (price != null) out.price = price;
  if (quantity != null) out.quantity = quantity;
  if (condition) out.condition = condition;
  if (category) out.category = category;
  if (location) out.location = location;
  if (postType !== "regular") out.postType = postType;
  if (postType === "service") {
    out.serviceCategory = pick(SERVICE_CATEGORIES, category) || "other";
    out.serviceType = /remote|online/i.test(raw) ? "remote" : /onsite|on-site|come/i.test(raw) ? "onsite" : "both";
    if (location) out.serviceLocation = location;
  }
  return out;
}

/** Short noun for the gallery query: "two bedroom flat" -> "house". */
function inferItemType(text) {
  const s = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const groups = [
    ["house", ["house", "flat", "apartment", "duplex", "bungalow", "building"]],
    ["land", ["land", "plot", "acre"]],
    ["shoes", ["shoe", "shoes", "sneaker", "slipper", "sandal"]],
    ["bag", ["bag", "handbag", "purse"]],
    ["phone", ["phone", "iphone", "samsung", "tecno", "infinix", "itel", "android"]],
    ["laptop", ["laptop", "macbook", "computer", "pc"]],
    ["car", ["car", "toyota", "honda", "lexus", "benz", "camry", "corolla"]],
    ["rice", ["rice"]],
    ["sofa", ["sofa", "couch"]],
    ["generator", ["generator", "gen"]],
    ["fridge", ["fridge", "freezer"]],
    ["tv", ["tv", "television"]],
    ["bed", ["bed", "mattress"]],
    ["dress", ["dress", "gown"]],
    ["shirt", ["shirt", "top"]],
    ["wig", ["wig"]],
    ["watch", ["watch"]],
    ["book", ["book", "novel"]],
    ["bike", ["bike", "motorcycle"]],
    ["guitar", ["guitar"]],
  ];
  for (const [label, words] of groups) {
    if (words.some(w => s.includes(` ${w} `) || s.includes(` ${w}s `) || s.includes(` ${w}s`))) return label;
  }
  return "";
}

/**
 * Accepts the model's raw field object (or anything the client sends) and
 * returns only values the app accepts, using the app's server-side vocabulary:
 * postType, title, description, price, quantity, condition, category, location,
 * serviceCategory, serviceType, serviceLocation.
 */
function sanitizeAdFields(raw, currentType = "regular") {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = {};

  const type = pick(POST_TYPE_KEYS, r.postType);
  if (type && type !== currentType) out.postType = type;
  const t = type || (POST_TYPE_KEYS.includes(currentType) ? currentType : "regular");

  const title = String(r.title == null ? "" : r.title).replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  if (title) out.title = title;

  const description = String(r.description ?? r.caption ?? "").trim().slice(0, 2000);
  if (description) out.description = description;

  const priceRaw = r.price;
  if (priceRaw != null && priceRaw !== "") {
    const n = typeof priceRaw === "number" ? priceRaw : parsePrice(priceRaw) ?? parseFloat(String(priceRaw).replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n >= 0) out.price = Math.round(n);
  }

  const qty = parseInt(r.quantity ?? r.qty, 10);
  if (qty >= 1) out.quantity = Math.min(qty, 10000);

  const condition = normalizeCondition(r.condition ?? r.productCondition);
  if (t === "regular" && condition) out.condition = condition;

  const category = normalizeCategory(r.category);
  const location = normalizeLocation(r.location);

  if (t === "service") {
    const sc = pick(SERVICE_CATEGORIES, r.serviceCategory ?? r.category);
    if (sc) out.serviceCategory = sc;
    const st = pick(SERVICE_TYPES, r.serviceType);
    if (st) out.serviceType = st;
    const sl = String(r.serviceLocation ?? r.location ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 80);
    if (sl) out.serviceLocation = sl;
  } else {
    if (category) out.category = category;
    if (t === "regular" && location) out.location = location;
    if (t === "digital" && location) out.location = location;
  }

  return out;
}

/** Same as sanitizeAdFields but keeps invalid values too (for debugging/mock). */
function normalizeAdFields(raw, currentType = "regular") {
  const r = raw && typeof raw === "object" ? raw : {};
  return sanitizeAdFields({
    ...r,
    title: r.title,
    description: r.description ?? r.caption,
    condition: normalizeCondition(r.condition ?? r.productCondition) || r.condition,
    category: normalizeCategory(r.category) || r.category,
    location: normalizeLocation(r.location) || r.location,
  }, currentType);
}

/** What the user still has to add, in human words. */
function missingRequired(draft = {}) {
  const t = normalizePostType(draft.postType);
  const missing = [];
  if (!String(draft.title || "").trim()) missing.push("item name");
  if (!String(draft.description || draft.caption || "").trim()) missing.push("caption");
  if (!Number.isFinite(Number(draft.price)) || Number(draft.price) <= 0) missing.push("price");

  if (t === "regular") {
    if (!String(draft.condition || draft.productCondition || "").trim()) missing.push("condition");
    if (!String(draft.category || "").trim()) missing.push("category");
    if (!String(draft.location || "").trim()) missing.push("location");
  } else if (t === "service") {
    if (!String(draft.category || draft.serviceCategory || "").trim()) missing.push("service category");
    if (!String(draft.serviceType || "").trim()) missing.push("delivery type");
    if (!String(draft.location || draft.serviceLocation || "").trim()) missing.push("location");
  } else {
    if (!String(draft.category || draft.digitalCategory || "").trim()) missing.push("category");
  }
  return missing;
}

/** Converts agent fields to the names the React Native form uses. */
function toFormFields(fields = {}) {
  const out = { ...fields };
  if (out.description !== undefined) { out.caption = out.description; delete out.description; }
  if (out.condition !== undefined) { out.productCondition = out.condition; delete out.condition; }
  return out;
}

module.exports = {
  CONDITIONS,
  SERVICE_CATEGORIES,
  SERVICE_TYPES,
  POST_CATEGORIES,
  CATEGORY_LABELS,
  NIGERIAN_LOCATIONS,
  CATEGORY_KEYWORDS,
  ITEM_WORDS,
  titleCase,
  normalizePostType,
  normalizeCategory,
  inferCategory,
  normalizeCondition,
  normalizeLocation,
  findLocation,
  wordsToNumber,
  parsePrice,
  parseQuantity,
  stripPhoneNumbers,
  parseListing,
  inferItemType,
  sanitizeAdFields,
  normalizeAdFields,
  missingRequired,
  toFormFields,
  LOCATION_ALIASES,
};
