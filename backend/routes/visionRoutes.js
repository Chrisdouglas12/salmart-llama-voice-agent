/* CommonJS port of salmart-llama-voice-agent/backend/routes/visionRoutes.js. */
/**
 * Vision endpoints used by the mobile app's gallery picker and photo autofill.
 *
 *   POST /api/assistant/rank-photos   multipart: images[] (max 24), query
 *     -> { success, matches: [{ index, score, label }], provider, model }
 *
 *   POST /api/assistant/ad-from-image multipart: image, text?, draft?
 *     -> the same envelope as /chat, with a fill_ad action
 *
 * Live mode asks the Meta vision model. Demo mode (or any model failure) uses a
 * deterministic filename heuristic, so the judge-facing demo never stalls.
 */
const express = require("express");
const multer = require("multer");
const { config, shouldUseMock } = require("../lib/assistant/config.js");
const { parseJsonLoose, visionJSON } = require("../lib/assistant/llama.js");
const { CONDITIONS, CATEGORY_LABELS, POST_CATEGORIES, NIGERIAN_LOCATIONS, inferCategory, parseListing, sanitizeAdFields, titleCase, } = require("../lib/assistant/form.js");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 24 },
});

// ── Demo-mode photo matching ─────────────────────────────────────────────────

const SYNONYMS = {
  house: ["house", "flat", "apartment", "duplex", "bungalow", "building", "home", "self contain", "selfcon"],
  land: ["land", "plot", "acre"],
  shoes: ["shoe", "shoes", "sneaker", "sneakers", "slippers", "sandal", "slipper"],
  bag: ["bag", "handbag", "purse"],
  phone: ["phone", "iphone", "samsung", "tecno", "infinix", "itel", "android"],
  laptop: ["laptop", "macbook", "computer", "pc"],
  car: ["car", "toyota", "honda", "lexus", "benz", "camry", "corolla"],
  rice: ["rice"],
  sofa: ["sofa", "couch"],
  generator: ["generator", "gen"],
  fridge: ["fridge", "freezer"],
  tv: ["tv", "television"],
  bed: ["bed", "mattress"],
  dress: ["dress", "gown"],
  shirt: ["shirt", "top"],
  wig: ["wig"],
  watch: ["watch"],
  book: ["book", "novel"],
  bike: ["bike", "motorcycle"],
  guitar: ["guitar"],
};

function queryTerms(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];
  const out = new Set(q.split(/\s+/).filter(Boolean));
  for (const [label, words] of Object.entries(SYNONYMS)) {
    if (words.some(w => q.includes(w)) || q.includes(label)) {
      out.add(label);
      for (const w of words) out.add(w);
    }
  }
  return [...out];
}

function fileLabel(file) {
  return String(file.originalname || file.filename || "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .toLowerCase()
    .trim();
}

function rankByFilename(files, query) {
  const terms = queryTerms(query);
  const matches = [];

  files.forEach((file, index) => {
    const base = fileLabel(file);
    if (!base) return;

    let score = 0;
    let label = "";

    if (!terms.length) {
      score = 0.6;
      label = base;
    } else {
      for (const term of terms) {
        if (!term || term.length < 3) continue;
        const hit = base === term || base.includes(term) || term.includes(base);
        if (hit) {
          score = Math.max(score, base === term ? 0.98 : 0.9);
          label = term;
        }
      }
      if (!score) {
        // "shoes" vs "shoe", "house 1" vs "houses"
        const baseWords = base.split(/\s+/);
        for (const term of terms) {
          if (baseWords.some(w => w.length > 3 && (w.startsWith(term.slice(0, 4)) || term.startsWith(w.slice(0, 4))))) {
            score = 0.55;
            label = term;
          }
        }
      }
    }

    if (score > 0) matches.push({ index, score: Number(score.toFixed(2)), label });
  });

  return matches.sort((a, b) => b.score - a.score);
}

// ── POST /rank-photos ────────────────────────────────────────────────────────

const RANK_PROMPT = (query) =>
  `You are a photo matcher for a Nigerian marketplace. Does this photo clearly show "${query}"? ` +
  `Reply with JSON only, no prose: {"match": true or false, "score": 0 to 1, "label": "2-4 word label of what is in the photo"}. ` +
  `Use a score below 0.35 when the item is not clearly visible.`;

async function rankLive(files, query) {
  const out = [];
  const results = new Array(files.length).fill(null);
  let cursor = 0;
  let failed = 0;

  const worker = async () => {
    while (cursor < files.length) {
      const index = cursor;
      cursor += 1;
      const file = files[index];
      try {
        const { data } = await visionJSON({
          prompt: RANK_PROMPT(query),
          images: [{ base64: file.buffer.toString("base64"), mime: file.mimetype || "image/jpeg" }],
          maxTokens: 120,
        });
        const score = Number(data?.score);
        results[index] = {
          index,
          score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : data?.match ? 0.9 : 0,
          label: String(data?.label || query || "").slice(0, 60),
        };
      } catch (_e) {
        failed += 1;
        const fallback = rankByFilename([file], query)[0];
        results[index] = fallback ? { ...fallback, index } : { index, score: 0, label: "" };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(5, files.length) }, worker));
  for (const r of results) if (r && r.score > 0) out.push(r);
  return { matches: out.sort((a, b) => b.score - a.score), failed };
}

router.post("/rank-photos", upload.array("images", 24), async (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];
  const query = String(req.body?.query || "").trim();

  if (!files.length) {
    return res.status(200).json({ success: false, code: "NO_IMAGES", matches: [] });
  }

  if (!shouldUseMock()) {
    try {
      const { matches, failed } = await rankLive(files, query);
      const allFailed = failed >= files.length;
      return res.json({
        success: true,
        matches: allFailed ? rankByFilename(files, query) : matches,
        provider: allFailed ? "demo-vision" : "meta-llama",
        model: allFailed ? "filename-heuristic" : config.meta.visionModel,
        ...(failed ? { warning: `${failed} photo(s) fell back to filename matching` } : {}),
      });
    } catch (e) {
      console.error("[rank-photos] vision failed, using demo matcher:", e.message);
    }
  }

  return res.json({
    success: true,
    matches: rankByFilename(files, query),
    provider: "demo-vision",
    model: "filename-heuristic",
  });
});

// ── POST /ad-from-image ──────────────────────────────────────────────────────

const AD_PROMPT = `You are filling a marketplace listing from one photo for a Nigerian seller.
Reply with JSON only, no prose:
{"title":"short item name, max 8 words","description":"one clear sentence","price":null,"condition":null,"category":null,"location":null,"itemType":"house|shoes|phone|car|bag|..."}
Rules:
- condition must be one of: ${CONDITIONS.join(", ")}. Use null if you cannot tell.
- category must be one of: ${POST_CATEGORIES.join(", ")} (${POST_CATEGORIES.map(k => CATEGORY_LABELS[k]).join(", ")}).
- location must be one of: ${NIGERIAN_LOCATIONS.join(", ")}. Never guess a location - use null.
- Never invent a price or a phone number. Use null for price when it is not visible.
- Describe only what is visible.`;

function guessFromFilename(file) {
  const base = fileLabel(file);
  const fields = {};
  if (!base) return fields;
  const category = inferCategory(base);
  fields.title = titleCase(base.replace(/\b\d+\b/g, "").trim() || base);
  if (category) fields.category = category;
  if (category === "electronics" && /phone|iphone|samsung|tecno/.test(base)) fields.title = titleCase(base);
  fields.description = `${fields.title} for sale.`;
  return fields;
}

function stripGalleryCommand(text) {
  return String(text || "")
    .replace(/\b(?:open|check|look at|scan|show)\s+(?:my|the)\s+(?:recent\s+)?(?:gallery|album|photos?|pictures?)\b/gi, " ")
    .replace(/\b(?:i\s+)?(?:just\s+)?(?:snapped|took|taken)\s+(?:one\s+|a\s+|an\s+)?/gi, " ")
    .replace(/\b(?:pick|choose|select)\s+(?:the\s+)?(?:first|second|third|fourth|fifth|best|one|\d+)(?:\s+one)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeFields({ modelFields, textFields, guess }) {
  const vision = sanitizeAdFields(modelFields || {});
  const spoken = parseListing(stripGalleryCommand(textFields));
  const merged = { ...vision, ...spoken };

  if (!merged.title && guess.title) merged.title = guess.title;
  if (!merged.category && guess.category) merged.category = guess.category;
  if (!merged.description) {
    merged.description = spoken.description
      || vision.description
      || (merged.title ? `${merged.title} for sale.` : "");
  }
  if (!merged.condition && guess.condition) merged.condition = guess.condition;
  return sanitizeAdFields(merged);
}

function fillMessage(fields) {
  const labels = {
    title: "name", description: "caption", price: "price", quantity: "quantity",
    condition: "condition", category: "category", location: "location",
    postType: "type", serviceCategory: "service category", serviceType: "delivery type",
    serviceLocation: "location",
  };
  const filled = Object.keys(fields).map(k => labels[k]).filter(Boolean);
  if (!filled.length) {
    return "I can see the photo but I need the item name, price and place. Tell me and I'll fill am.";
  }
  const missing = [];
  if (!fields.title) missing.push("item name");
  if (!fields.price) missing.push("price");
  if (!fields.location && fields.postType !== "digital") missing.push("place");
  const head = `I see ${fields.title || "the item"} for the photo. I don fill ${filled.join(", ")}.`;
  if (missing.length) return `${head} Still need ${missing.join(", ")}. Talk am.`;
  return `${head} Check am, then tap Post.`;
}

router.post("/ad-from-image", upload.single("image"), async (req, res) => {
  const file = req.file;
  const text = String(req.body?.text || "").trim();
  let draft = {};
  try { draft = JSON.parse(req.body?.draft || "{}") || {}; } catch { draft = {}; }

  if (!file) {
    return res.status(200).json({
      success: false, code: "NO_IMAGE",
      message: "I didn't get the photo. Try again.",
      products: [], actions: [], navigations: [],
    });
  }

  const guess = guessFromFilename(file);
  let modelFields = null;
  let provider = "demo-vision";
  let model = "filename-heuristic";

  if (!shouldUseMock()) {
    try {
      const { data, text: raw, model: used } = await visionJSON({
        prompt: `${AD_PROMPT}\n\nSeller's words (may be empty): "${text}"`,
        images: [{ base64: file.buffer.toString("base64"), mime: file.mimetype || "image/jpeg" }],
        maxTokens: 500,
      });
      modelFields = data || parseJsonLoose(raw);
      provider = "meta-llama";
      model = used || config.meta.visionModel;
    } catch (e) {
      console.error("[ad-from-image] vision failed, using demo fields:", e.message);
    }
  }

  const fields = mergeFields({ modelFields, textFields: text, guess });
  const merged = { ...draft, ...fields };
  const actions = Object.keys(fields).length ? [{ type: "fill_ad", fields }] : [];

  return res.json({
    success: true,
    message: fillMessage(merged),
    fields,
    products: [],
    actions,
    navigations: [],
    provider,
    model,
  });
});

module.exports = router;
