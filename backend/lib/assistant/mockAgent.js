/* CommonJS port of salmart-llama-voice-agent/backend/lib/mockAgent.js.
 * Generated from the hackathon repo; keep the two in sync. */
/**
 * Deterministic demo brain.
 *
 * This is the safety net: when META_API_KEY is blank (or DEMO_MODE=mock) the
 * whole product still works, with the same tool calls, the same response
 * envelope and the same app actions. It is intentionally rule-based, not a
 * second model - it is here so a hackathon demo never dies on venue Wi-Fi.
 */
const { CATEGORY_LABELS, ITEM_WORDS, findLocation, inferCategory, inferItemType, missingRequired, normalizeCondition, normalizeLocation, normalizePostType, parseListing, parsePrice, parseQuantity, } = require("./form.js");
const { runTool } = require("./tools.js");

const GALLERY_WORDS = /\b(gallery|album|photos?|pictures?|images?|snaps?|snapped|snapshot)\b/i;
const CAMERA_WORDS = /\b(camera|take (?:a )?(?:new )?photo|snap (?:a )?(?:new )?(?:photo|picture))\b/i;
const SELL_WORDS = /\b(sell|selling|list|post|create (?:an? )?ad|upload)\b/i;
const BUY_WORDS = /\b(buy|buying|find|search|look for|looking for|need|want)\b/i;
const GREETING = /^(hi|hello|hey|good (?:morning|afternoon|evening)|how far|wetin dey|how you dey|sannu)\b/i;
const THANKS = /\b(thank you|thanks|well done|nice one|correct)\b/i;

const ORDINALS = {
  first: 1, "1st": 1, one: 1, "number one": 1,
  second: 2, "2nd": 2, two: 2, "number two": 2,
  third: 3, "3rd": 3, three: 3, "number three": 3,
  fourth: 4, "4th": 4, four: 4, "number four": 4,
  fifth: 5, "5th": 5, five: 5, "number five": 5,
  best: 1, "the best": 1,
};

const SEARCH_PREFIX = /^(?:(?:please|abeg|oya|ok|okay)\s+)*(?:(?:i|mi)\s+(?:want|wan|wanna|need|dey)\s+(?:to\s+)?(?:buy|find|see|get|look for)|i'?m looking for|find(?: me)?|search(?: for)?|look for|show me|do you have|any)\s+/i;
const SEARCH_STOP = new Set([
  "a", "an", "the", "i", "im", "me", "my", "we", "you", "your", "want", "wan",
  "wanna", "need", "like", "please", "abeg", "find", "search", "buy", "buying",
  "sell", "selling", "looking", "look", "for", "of", "to", "in", "at", "on",
  "with", "and", "or", "is", "are", "be", "na", "dey", "one", "some", "any",
  "good", "cheap", "cheapest", "price", "under", "below", "less", "than",
  "around", "about", "budget", "max", "maximum", "min", "minimum", "used",
  "new", "brand", "fairly", "second", "hand", "tokunbo", "condition",
  "location", "show", "give", "get", "have", "there", "this", "that", "am",
  "something", "anything", "stuff", "things", "pls", "plz",
]);

function lastUserText(messages = [], history = []) {
  const all = [...(history || []), ...(messages || [])];
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const m = all[i];
    if (m && m.role === "user") {
      if (typeof m.content === "string") return m.content.trim();
      if (Array.isArray(m.content)) return m.content.map(p => p?.text || "").join(" ").trim();
    }
  }
  return "";
}

function ordinalIndex(text) {
  const s = String(text || "").toLowerCase();
  const m = s.match(/\b(?:number\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m && /\b(?:pick|choose|select|take|use|that|the)\b/.test(s)) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 20) return n;
  }
  const words = Object.keys(ORDINALS).sort((a, b) => b.length - a.length);
  for (const w of words) {
    if (new RegExp(`\\b${w.replace(" ", "\\s+")}\\b`).test(s)) return ORDINALS[w];
  }
  return null;
}

function parseSearch(text) {
  let s = String(text || "").toLowerCase();
  let maxPrice = null;
  let minPrice = null;

  const maxMatch = s.match(/\b(?:under|below|less than|not more than|max(?:imum)?|budget(?: of)?|around|about)\s*₦?\s*(\d+(?:[.,]\d+)?)\s*(k|thousand|m|million)?/);
  if (maxMatch) maxPrice = scale(maxMatch[1], maxMatch[2]);

  const minMatch = s.match(/\b(?:above|over|more than|from|starting from)\s*₦?\s*(\d+(?:[.,]\d+)?)\s*(k|thousand|m|million)?/);
  if (minMatch) minPrice = scale(minMatch[1], minMatch[2]);

  const location = findLocation(s);
  const condition = normalizeCondition(s);
  const category = inferCategory(s);

  // Remove the filters before extracting keywords.
  s = s
    .replace(/\b(?:under|below|less than|not more than|max(?:imum)?|budget(?: of)?|around|about|above|over|more than|from|starting from)\s*₦?\s*\d+(?:[.,]\d+)?\s*(?:k|thousand|m|million)?/g, " ")
    .replace(/\b(?:in|for|at|around|near)\s+[a-z -]{3,25}\b/g, (m) => (normalizeLocation(m.replace(/^(in|for|at|around|near)\s+/i, "")) ? " " : m))
    .replace(/\b(?:brand new|like new|almost new|fairly used|second hand|secondhand|tokunbo|used|new)\b/g, " ")
    .replace(SEARCH_PREFIX, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = s.split(/\s+/).filter(t => t && !SEARCH_STOP.has(t) && t.length > 1);
  let query = tokens.join(" ").trim();
  if (!query && category) query = CATEGORY_LABELS[category] || category;

  return { query, maxPrice, minPrice, location, condition, category };
}

function scale(num, unit) {
  let n = parseFloat(String(num).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const u = String(unit || "").toLowerCase();
  if (u === "k" || u === "thousand") n *= 1000;
  if (u === "m" || u === "million") n *= 1000000;
  return Math.round(n);
}

function hasListingDetail(text) {
  return Boolean(
    parsePrice(text) != null
    || findLocation(text)
    || normalizeCondition(text)
    || parseQuantity(text) != null
    || inferCategory(text)
    || ITEM_WORDS.some(w => new RegExp(`\\b${w}\\b`, "i").test(text))
  );
}

function formatNaira(n) {
  if (!Number.isFinite(Number(n))) return "";
  return `₦${Number(n).toLocaleString("en-NG")}`;
}

function fieldLabels(keys = []) {
  const map = {
    postType: "type", title: "name", description: "caption", price: "price",
    quantity: "quantity", condition: "condition", category: "category",
    location: "location", serviceCategory: "service category",
    serviceType: "delivery type", serviceLocation: "location",
  };
  return [...new Set(keys.map(k => map[k]).filter(Boolean))];
}

function fillReply(fields, missing) {
  const labels = fieldLabels(Object.keys(fields));
  const head = labels.length
    ? `I don fill ${labels.join(", ")}.`
    : "I don update your ad.";
  if (missing.length) return `${head} Still need ${missing.join(", ")}. Talk am.`;
  return `${head} Everything complete — check am, then tap Post.`;
}

async function runMockAgent({ messages = [], history = [], context = {}, session = {}, collected }) {
  const text = lastUserText(messages, history);
  const s = text.toLowerCase();
  const draft = { ...(session.draft || context.adDraft || {}) };
  const screen = context.screen || "market";
  const galleryOpen = Boolean(context.gallery?.open);

  // ── 1. Picking from an open gallery ──────────────────────────────────────
  // A pick phrase must name a photo/ordinal. "take me to checkout" also says
  // "take", so it must not be swallowed as a gallery pick.
  const PICK_PHRASE = /\b(?:pick|choose|select)\b[^.]*\b(?:one|photo|picture|image|it|that|this)\b|\b(?:first|second|third|fourth|fifth|best|that|this)\s+one\b|\btake (?:the )?(?:first|second|third|fourth|fifth|\d+)(?:\s+one)?\b/i;
  if (galleryOpen && PICK_PHRASE.test(s)) {
    const index = ordinalIndex(s) || 1;
    await runTool("choose_photo", { index }, { context, session, collected });
    return { message: `I don pick photo ${index}. I dey read the picture now — talk the price and place.` };
  }

  // ── 2. What's missing on the form ────────────────────────────────────────
  if (/\b(what(?:'s| is)? missing|wetin remain|what else|what do you need|wetn remain)\b/i.test(s)) {
    const missing = missingRequired(draft);
    return {
      message: missing.length
        ? `You still need ${missing.join(", ")}. Talk am one by one.`
        : "Everything don complete. Check the form, then tap Post.",
    };
  }

  // ── 3. Cart / seller actions on the last shown products ──────────────────
  if (/\b(add|put)\b.*\b(cart|basket)\b|\badd (?:it|this|that|the first one|the second one)\b|\bi(?:'ll| will) take (?:it|this|that|the first one)\b|\bi want am\b/i.test(s)) {
    if (!session.products?.length) {
      return { message: "Which product? Tell me what you wan buy first, make I show you." };
    }
    const idx = ordinalIndex(s);
    const product = idx ? session.products[idx - 1] : session.products[0];
    if (!product) return { message: "I no see that one. Check the list again." };
    const out = await runTool("add_to_cart", { postId: product.postId, quantity: 1 }, { context, session, collected });
    return { message: out.ok ? `I don put ${product.title} for your cart.` : out.error };
  }

  if (/\b(contact|message|chat|ask)\b.*\bseller\b/i.test(s)) {
    if (!session.products?.length) {
      return { message: "Which product? Tell me what you wan buy first." };
    }
    const product = session.products[0];
    const out = await runTool("contact_seller", { postId: product.postId }, { context, session, collected });
    return { message: out.ok ? `I dey open chat with ${product.sellerName} about ${product.title}.` : out.error };
  }

  // ── 4. Gallery / camera ───────────────────────────────────────────────────
  if (GALLERY_WORDS.test(s) || CAMERA_WORDS.test(s)) {
    const itemType = inferItemType(s) || inferItemType(draft.title || "");
    const wantsCamera = CAMERA_WORDS.test(s) && !/gallery|album|photos?|pictures?/i.test(s);

    if (wantsCamera) {
      await runTool("take_photo", {}, { context, session, collected });
      return { message: "Camera don open. Snap the item well, then come back make we fill the form." };
    }

    if (!itemType) {
      return { message: "Wetin you wan sell? Talk the item name, make I check your recent photos for am." };
    }

    await runTool("open_gallery", { itemType, hoursBack: 48 }, { context, session, collected });
    return { message: `I dey open your gallery, dey check your recent photos for ${itemType}.` };
  }

  // ── 5. Selling ────────────────────────────────────────────────────────────
  const selling = SELL_WORDS.test(s);
  if (selling) {
    const generic = /\b(something|anything|stuff|things|item)\b/i.test(s) && !hasListingDetail(s.replace(/\b(something|anything|stuff|things|item)\b/gi, ""));
    if (generic || !hasListingDetail(s)) {
      await runTool("request_system_photo", {}, { context, session, collected });
      return { message: "No wahala. Your gallery dey open — pick the photo of wetin you wan sell." };
    }

    const fields = parseListing(text, draft);
    const out = await runTool("fill_ad", fields, { context, session, collected });
    if (!out.ok) {
      await runTool("navigate", { screen: "create_ad" }, { context, session, collected });
      return { message: "Create Ad don open. Talk the item name, price and place." };
    }
    return { message: fillReply(out.fields, out.missing) };
  }

  // ── 6. Details while already on the form ─────────────────────────────────
  // An explicit buy/search command wins even if the seller is still on the
  // form: "find me iPhone under 200k" must not overwrite the ad draft.
  if (screen === "create_ad" && hasListingDetail(s) && !SEARCH_PREFIX.test(s)) {
    const fields = parseListing(text, draft);
    const out = await runTool("fill_ad", fields, { context, session, collected });
    if (out.ok) return { message: fillReply(out.fields, out.missing) };
  }

  // ── 7. Explicit navigation ───────────────────────────────────────────────
  // Only treat this as a navigation when the user actually asks to go
  // somewhere ("open my cart", "take me to checkout", or a bare screen name).
  // Otherwise "I need a home" would jump to the market feed instead of
  // searching listings.
  const NAV_VERB = /^(?:(?:please|abeg|oya|ok|okay)\s+)?(?:open|show|go to|goto|take me to|take me|switch to|navigate to|move to|bring up|enter|wetin dey (?:inside|in))\b/i;
  const navTargets = [
    ["cart", /\b(cart|basket)\b/i, "Your cart dey open."],
    ["checkout", /\b(checkout|check out|pay|payment|buy now)\b/i, "Checkout don open. Check the total before you pay."],
    ["deals", /\b(deals?|discount|promo)\b/i, "Deals don open."],
    ["profile", /\b(profile|account|my page)\b/i, "Your profile don open."],
    ["referral", /\b(referral|invite)\b/i, "Referral page don open."],
    ["messages", /\b(messages?|chats?)\b/i, "Messages don open."],
    ["market", /\b(market|home|main page)\b/i, "Market don open."],
    ["search", /\bsearch\b/i, "Search don open. Wetin you wan buy?"],
    ["create_ad", /\b(create ad|sell screen|post ad)\b/i, "Create Ad don open."],
  ];
  const bareScreen = s.trim().replace(/\s+/g, " ");
  for (const [target, re, reply] of navTargets) {
    const bare = bareScreen === target || bareScreen === target.replace(/_/g, " ");
    if (re.test(s) && (NAV_VERB.test(s) || bare)) {
      await runTool("navigate", { screen: target }, { context, session, collected });
      return { message: reply };
    }
  }

  // ── 8. Buying / searching ─────────────────────────────────────────────────
  if (BUY_WORDS.test(s) || inferCategory(s) || ITEM_WORDS.some(w => new RegExp(`\\b${w}\\b`, "i").test(s))) {
    const filters = parseSearch(text);
    if (!filters.query || /^(something|anything|stuff|things)$/i.test(filters.query)) {
      await runTool("navigate", { screen: "search" }, { context, session, collected });
      return { message: "Search don open. Wetin you wan buy? Talk the name, like iPhone, rice or shoes." };
    }

    const out = await runTool("search_products", { ...filters, limit: 6 }, { context, session, collected });
    if (!out.count) {
      return { message: `I no see ${filters.query} for Salmart right now. Try another name or wider budget?` };
    }
    const cheapest = out.products.reduce((a, b) => (a.price <= b.price ? a : b), out.products[0]);
    return {
      message: `I find ${out.count} ${filters.query} for you. The cheapest na ${formatNaira(cheapest.price)}. Which one you like?`,
    };
  }

  // ── 9. Small talk ─────────────────────────────────────────────────────────
  if (GREETING.test(s)) {
    return { message: "How far! I be Aya, your Salmart voice helper. You wan buy, sell, or check your photos?" };
  }
  if (THANKS.test(s)) {
    return { message: "You welcome. Anything else?" };
  }
  if (/^(thanks|thank you|ok|okay|yes|yeah|no|alright)$/i.test(s.trim())) {
    return { message: "Okay. I dey here if you need me." };
  }

  return {
    message: "I no catch that one. You fit say: 'I want to sell something', 'open my gallery for house', or 'find me iPhone under 200k'.",
  };
}

module.exports = {
  runMockAgent,
};
