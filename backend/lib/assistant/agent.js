/* CommonJS port of salmart-llama-voice-agent/backend/lib/agent.js.
 * Generated from the hackathon repo; keep the two in sync. */
/**
 * The agent orchestrator.
 *
 * Live path: Llama 4 -> tool calls -> runTool -> app actions.
 * Demo path: deterministic rules -> the same runTool -> the same app actions.
 * The response envelope is identical either way, so the mobile app never knows
 * (or cares) which brain answered.
 */
const { config, setRecoveryProbe, shouldUseMock } = require("./config.js");
const { chatCompletion, messageText } = require("./llama.js");
const { runMockAgent } = require("./mockAgent.js");
const { CONDITIONS, NIGERIAN_LOCATIONS, POST_CATEGORIES, SERVICE_CATEGORIES, SERVICE_TYPES, CATEGORY_LABELS, missingRequired, } = require("./form.js");
const { SALMART_TOOLS, parseToolArgs, runTool } = require("./tools.js");

// If a live call fails, stay on the demo brain until a real call succeeds.
setRecoveryProbe(() => chatCompletion({
  messages: [{ role: "user", content: "Reply with: OK" }],
  maxTokens: 500,
  temperature: 0,
        reasoningEffort: "minimal",
}));

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_STEPS = 5;
const sessions = new Map();

function getSession(id = "anon") {
  const key = String(id || "anon");
  const now = Date.now();
  const existing = sessions.get(key);
  if (existing && now - existing.updatedAt < SESSION_TTL_MS) return existing;

  const fresh = {
    id: key,
    products: [],
    draft: null,
    lastQuery: "",
    updatedAt: now,
  };
  sessions.set(key, fresh);
  return fresh;
}

function touch(session) {
  session.updatedAt = Date.now();
}

function normaliseConvo(rows = []) {
  return (rows || [])
    .filter(m => m && (m.role === "user" || m.role === "assistant"))
    .map(m => {
      let content = m.content;
      if (Array.isArray(content)) content = content.map(p => p?.text || "").join(" ");
      return { role: m.role, content: String(content || "").slice(0, 2000) };
    })
    .filter(m => m.content.trim())
    .slice(-20);
}

function productLine(p, i) {
  return `${i + 1}. ${p.title} - ₦${Number(p.price || 0).toLocaleString("en-NG")} (postId: ${p.postId}, sellerId: ${p.sellerId})`;
}

function buildSystemPrompt({ context = {}, session = {} } = {}) {
  const draft = session.draft || context.adDraft || null;
  const shown = (session.products || []).slice(0, 6);
  const shownText = shown.length ? shown.map(productLine).join("\n") : "None yet.";
  const draftText = draft && Object.keys(draft).length ? JSON.stringify(draft) : "Empty.";
  const gallery = context.gallery?.open ? `open with ${context.gallery.count || "some"} matches` : "closed";
  const screen = context.screen || "market";
  const missing = missingRequired(draft || {});

  return `You are Aya, Salmart's voice assistant for Nigeria. You help buyers shop and sellers post ads without typing. Many users cannot read or write well, so keep every reply short, warm and clear. Speak Nigerian English or light Pidgin. No markdown, no lists, no emoji.

YOU CONTROL THE SALMART APP WITH TOOLS. Always call a tool for an action. Never claim you did something unless you called the tool.

SELLING
- "I want to sell something" -> navigate create_ad. Then ask for the item name, price, place and condition, one short question at a time.
- The moment the seller mentions ANY listing detail, call fill_ad with only the fields you heard. Do not wait for everything.
- If they mention a photo, gallery, "I just snapped it", or "check my photos" -> call open_gallery with the item type (house, shoes, bag, phone, car...).
- If they say "pick the first one", "the second one" or "the best one" while the gallery is open -> call choose_photo.
- NEVER publish and NEVER ask for a phone number. The seller always taps Post themselves.

BUYING
- Call search_products with short keywords. Put price, condition and location in their own fields, never in the query.
- Resolve "the first one", "the cheaper one", "that one" using LAST SHOWN PRODUCTS below.
- Only add to cart or contact a seller using a real postId from LAST SHOWN PRODUCTS or a tool result. Never invent an id.
- If a search returns nothing, say so simply and suggest another word or a wider budget.

NAVIGATION
- cart, checkout, deals, profile, referral, messages, market, search, create_ad, assistant.
- "Take me to checkout" -> navigate checkout. If a product is clearly intended, pass its postId.
- "Open my cart" -> navigate cart.

FORM VALUES - use these EXACT values:
- postType: regular | service | digital
- condition: ${CONDITIONS.join(" | ")}
- category: ${POST_CATEGORIES.map(k => `${k} (${CATEGORY_LABELS[k]})`).join(" | ")}
- location: ${NIGERIAN_LOCATIONS.join(" | ")}
- serviceCategory: ${SERVICE_CATEGORIES.join(" | ")}
- serviceType: ${SERVICE_TYPES.join(" | ")}
- price is an integer in Naira: "50k" -> 50000, "1.2m" -> 1200000, "fifty thousand" -> 50000.
- "brand new" -> New. "like new" -> Like New. "fairly used", "second hand", "tokunbo" -> Good. "broken" -> For Parts.
- "Abuja" -> "FCT - Abuja". "Port Harcourt" or "PH" -> "Rivers". "Ikeja" -> "Lagos". Use the closest state.
- A house, flat, land or plot belongs to category "home".
- For services, put the location in serviceLocation and the category in serviceCategory.

CURRENT APP STATE
- Screen: ${screen}
- Gallery: ${gallery}
- Ad draft: ${draftText}
- Still missing: ${missing.length ? missing.join(", ") : "nothing"}

LAST SHOWN PRODUCTS
${shownText}

Reply in the same language the user used. If they speak Pidgin, answer in Pidgin. If they speak plain English, answer in plain English.`;
}

function mergeFillActions(actions = []) {
  const fills = actions.filter(a => a?.type === "fill_ad" && a.fields);
  if (fills.length <= 1) return actions;
  const merged = Object.assign({}, ...fills.map(a => a.fields));
  const firstIndex = actions.findIndex(a => a?.type === "fill_ad");
  return actions
    .filter((a, i) => a?.type !== "fill_ad" || i === firstIndex)
    .map((a, i) => (i === firstIndex ? { type: "fill_ad", fields: merged } : a));
}

function finalise({ message, collected, session, provider, model, warning }) {
  let actions = mergeFillActions(collected.actions || []);
  let navigations = collected.navigations || [];

  // If the agent fills the form, the app opens CreateAd itself. A create_ad
  // navigation on top of that would push the screen twice.
  if (actions.some(a => a?.type === "fill_ad")) {
    navigations = navigations.filter(n => n.screen !== "create_ad");
  }

  // A pick_photo action opens the picker; don't also navigate away.
  if (actions.some(a => a?.type === "pick_photo")) {
    navigations = navigations.filter(n => n.screen !== "create_ad");
  }

  touch(session);

  const out = {
    success: true,
    message: String(message || "Done.").trim() || "Done.",
    products: collected.products || [],
    actions,
    navigations,
    provider,
    model,
  };
  if (warning) out.warning = warning;
  return out;
}

async function runLiveAgent({ convo, context, session, collected }) {
  const llmMessages = [
    { role: "system", content: buildSystemPrompt({ context, session }) },
    ...convo,
  ];
  let lastModel = config.meta.brainModel;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const { message, model } = await chatCompletion({
      messages: llmMessages,
      tools: SALMART_TOOLS,
      temperature: 0.2,
      maxTokens: 1600,
    });
    lastModel = model || lastModel;

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) {
      return finalise({
        message: messageText(message) || "Done.",
        collected, session, provider: "meta-model-api", model: lastModel,
      });
    }

    llmMessages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: calls,
    });

    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      const name = call?.function?.name || "";
      const args = parseToolArgs(call?.function?.arguments);
      let result;
      try {
        result = await runTool(name, args, { context, session, collected });
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      collected.toolResults.push({ tool: name, args, result });
      llmMessages.push({
        role: "tool",
        tool_call_id: call?.id || `call_${step}_${i}_${name}`,
        content: JSON.stringify(result),
      });
    }

    // Re-state the state after tool calls so the model sees the updated draft.
    llmMessages[0] = { role: "system", content: buildSystemPrompt({ context, session }) };
  }

  return finalise({
    message: "Sorry, I got a bit tangled. Could you say that again?",
    collected, session, provider: "meta-model-api", model: lastModel,
  });
}

/**
 * Main entry point.
 * @returns {Promise<{success:boolean, message:string, products:Array, actions:Array, navigations:Array, provider:string, model:string}>}
 */
async function runAgent({ messages = [], history = [], context = {}, sessionId = "anon", searchProducts } = {}) {
  const session = getSession(sessionId);
  const convo = normaliseConvo([...(history || []), ...(messages || [])]);
  const collected = { products: [], actions: [], navigations: [], toolResults: [] };
  // The Mongo search lives in the main backend; the demo repo supplies its
  // catalogue in the same slot.
  const ctx = typeof searchProducts === "function" ? { ...context, searchProducts } : context;

  if (shouldUseMock()) {
    const { message } = await runMockAgent({ messages: convo, context: ctx, session, collected });
    return finalise({ message, collected, session, provider: "demo-brain", model: "rules" });
  }

  try {
    return await runLiveAgent({ convo, context: ctx, session, collected });
  } catch (e) {
    console.error("[agent] live model failed, using demo brain:", e.message);
    // Start clean so a half-finished tool call cannot leak into the fallback.
    collected.products = [];
    collected.actions = [];
    collected.navigations = [];
    collected.toolResults = [];
    session.draft = null;
    const { message } = await runMockAgent({ messages: convo, context: ctx, session, collected });
    return finalise({
      message, collected, session,
      provider: "demo-brain-fallback",
      model: "rules",
      warning: e.message,
    });
  }
}

module.exports = {
  runAgent,
  getSession,
};
