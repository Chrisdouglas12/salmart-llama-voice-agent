/* CommonJS port of salmart-llama-voice-agent/backend/lib/tools.js.
 * Generated from the hackathon repo; keep the two in sync. */
/**
 * Tool declarations + server-side execution.
 *
 * The model never touches Salmart directly. It calls these tools; we translate
 * each call into the exact `actions` / `navigations` envelope the mobile app
 * already understands (src/state/AssistantContext.js).
 */
const { CONDITIONS, NIGERIAN_LOCATIONS, POST_CATEGORIES, SERVICE_CATEGORIES, SERVICE_TYPES, inferItemType, missingRequired, normalizePostType, sanitizeAdFields, } = require("./form.js");

const SCREENS = ["market", "search", "create_ad", "cart", "checkout", "deals", "profile", "referral", "messages", "assistant"];

const SALMART_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search Salmart listings when the buyer wants to buy, find, compare or see options. Use short product keywords; put price, condition and location in their own fields, never in the query text.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product keywords only, e.g. 'iphone 12', 'two bedroom flat', 'rice'" },
          category: { type: "string", enum: POST_CATEGORIES },
          minPrice: { type: "number", description: "Minimum Naira price" },
          maxPrice: { type: "number", description: "Maximum Naira price" },
          location: { type: "string", enum: NIGERIAN_LOCATIONS },
          condition: { type: "string", enum: CONDITIONS },
          limit: { type: "integer", minimum: 1, maximum: 8 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_gallery",
      description: "Open the seller's recent phone photos and scan them for a specific item. Use when they say open my gallery, check my photos, I just snapped it, or find my picture. The app scans on-device; this only asks it to start.",
      parameters: {
        type: "object",
        properties: {
          itemType: { type: "string", description: "What to look for: house, shoes, bag, phone, car, rice..." },
          hoursBack: { type: "integer", minimum: 1, maximum: 336, description: "How far back to look, default 48 hours" },
        },
        required: ["itemType"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "choose_photo",
      description: "Pick a photo from the gallery results that are currently open, by position. Use when the seller says pick the first one, the second one, or the best one.",
      parameters: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 1, description: "1-based position; the best match is 1" },
        },
        required: ["index"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fill_ad",
      description: "Fill the Create Ad form live while the seller speaks. Send only the fields you heard; the form merges them. Never publish - the seller always taps Post.",
      parameters: {
        type: "object",
        properties: {
          postType: { type: "string", enum: ["regular", "service", "digital"] },
          title: { type: "string", description: "Short item name, max 120 characters" },
          description: { type: "string", description: "The seller's words cleaned into a caption" },
          price: { type: "number", description: "Naira amount, digits only, e.g. 50000" },
          quantity: { type: "integer", minimum: 1 },
          condition: { type: "string", enum: CONDITIONS },
          category: { type: "string", enum: POST_CATEGORIES },
          location: { type: "string", enum: NIGERIAN_LOCATIONS },
          serviceCategory: { type: "string", enum: SERVICE_CATEGORIES },
          serviceType: { type: "string", enum: SERVICE_TYPES },
          serviceLocation: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Move the user to another Salmart screen. Screens: market, search, create_ad, cart, checkout, deals, profile, referral, messages, assistant.",
      parameters: {
        type: "object",
        properties: {
          screen: { type: "string", enum: SCREENS },
          postId: { type: "string" },
          title: { type: "string" },
          price: { type: "number" },
          productType: { type: "string" },
          query: { type: "string", description: "For the search screen" },
        },
        required: ["screen"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description: "Add a product the assistant last showed to the buyer's cart.",
      parameters: {
        type: "object",
        properties: {
          postId: { type: "string" },
          quantity: { type: "integer", minimum: 1 },
        },
        required: ["postId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "contact_seller",
      description: "Open a chat with the seller of a product the assistant last showed.",
      parameters: {
        type: "object",
        properties: {
          postId: { type: "string" },
          message: { type: "string", description: "Optional first message" },
        },
        required: ["postId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "take_photo",
      description: "Open the camera so the seller can take a new photo of the item.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

function parseToolArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function compactProduct(p) {
  return {
    postId: p.postId,
    title: p.title,
    price: p.price,
    location: p.location,
    condition: p.condition,
    category: p.category,
    postType: p.postType,
    sellerId: p.sellerId,
  };
}

function findProduct(session, postId) {
  const list = session?.products || [];
  if (!postId) return list[0] || null;
  return list.find(p => String(p.postId) === String(postId)) || null;
}

/**
 * Execute one tool call.
 * @returns {Promise<object>} a small object for the model + side effects on `collected`.
 */
async function runTool(name, args = {}, { context = {}, session = {}, collected } = {}) {
  const pushAction = (action) => {
    if (!collected.actions.some(a => JSON.stringify(a) === JSON.stringify(action))) {
      collected.actions.push(action);
    }
  };
  const pushNav = (nav) => {
    if (!collected.navigations.some(n => JSON.stringify(n) === JSON.stringify(nav))) {
      collected.navigations.push(nav);
    }
  };

  switch (name) {
    case "search_products": {
      // The main backend injects its Mongo search here; the hackathon repo
      // injects the demo catalogue. Same tool contract either way.
      const search = context.searchProducts;
      if (typeof search !== "function") {
        return { ok: false, error: "Product search is not configured on this server." };
      }
      const found = await search(args);
      const products = Array.isArray(found) ? found : (found?.products || []);
      const source = Array.isArray(found) ? "salmart" : (found?.source || "salmart");
      session.products = products;
      session.lastQuery = args.query || "";
      collected.products = products;
      return {
        ok: true,
        source,
        count: products.length,
        products: products.map(compactProduct),
        note: products.length
          ? "Show these to the buyer and ask which one they want."
          : "Nothing matched. Offer to search again with simpler words.",
      };
    }

    case "open_gallery": {
      const itemType = String(args.itemType || "").trim() || inferItemType(context.adDraft?.title || "") || "item";
      const hoursBack = Math.max(1, Math.min(Number(args.hoursBack) || 48, 336));
      pushAction({ type: "pick_photo", query: itemType, hoursBack });
      return { ok: true, opened: true, itemType, hoursBack };
    }

    case "choose_photo": {
      const index = Math.max(1, parseInt(args.index, 10) || 1);
      pushAction({ type: "choose_photo", index });
      return { ok: true, index };
    }

    case "request_system_photo": {
      pushAction({ type: "system_pick_photo" });
      return { ok: true, note: "The app opens the phone gallery now. The seller picks; the photo lands on the Create Ad form." };
    }

    case "fill_ad": {
      const currentType = normalizePostType(context.adDraft?.postType || "regular");
      const fields = sanitizeAdFields(args, currentType);

      if (!Object.keys(fields).length) {
        return { ok: false, error: "No valid form fields in that request." };
      }

      // Multiple fill_ad calls in one turn are merged by the app; mirror that
      // here so the model's "what's missing" answer is accurate.
      session.draft = { ...(session.draft || context.adDraft || {}), ...fields, ...(fields.description ? { caption: fields.description } : {}) };
      const missing = missingRequired(session.draft);

      pushAction({ type: "fill_ad", fields });
      return {
        ok: true,
        filled: Object.keys(fields),
        fields,
        missing,
        note: missing.length
          ? `Still missing: ${missing.join(", ")}. Ask one short question.`
          : "Everything required is filled. Tell the seller to review and tap Post.",
      };
    }

    case "navigate": {
      const screen = String(args.screen || "").toLowerCase();
      if (!SCREENS.includes(screen)) return { ok: false, error: `Unknown screen: ${screen}` };

      const nav = { screen };
      if (screen === "checkout") {
        const product = findProduct(session, args.postId);
        if (product) {
          nav.postId = product.postId;
          nav.title = product.title;
          nav.price = product.price;
          nav.productType = product.postType;
        }
      }
      if (screen === "search" && args.query) nav.params = { q: args.query };
      if (screen === "create_ad" && args.postId) nav.params = { postId: args.postId };
      pushNav(nav);
      return { ok: true, screen };
    }

    case "add_to_cart": {
      const product = findProduct(session, args.postId);
      if (!product) return { ok: false, error: "That product is not in the last results. Search again first." };
      pushAction({ type: "add_to_cart", postId: product.postId, quantity: Math.max(1, parseInt(args.quantity, 10) || 1), product: compactProduct(product) });
      return { ok: true, added: product.title, price: product.price };
    }

    case "contact_seller": {
      const product = findProduct(session, args.postId);
      if (!product) return { ok: false, error: "That product is not in the last results. Search again first." };
      pushAction({ type: "contact_seller", postId: product.postId, sellerId: product.sellerId, message: String(args.message || "") });
      pushNav({
        screen: "chat",
        params: {
          userId: product.sellerId,
          postId: product.postId,
          listing: { _id: product.postId, title: product.title, price: product.price, postType: product.postType },
        },
      });
      return { ok: true, seller: product.sellerName, title: product.title };
    }

    case "take_photo": {
      pushAction({ type: "take_photo" });
      return { ok: true, opened: true };
    }

    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

module.exports = {
  SCREENS,
  SALMART_TOOLS,
  runTool,
  parseToolArgs,
};
