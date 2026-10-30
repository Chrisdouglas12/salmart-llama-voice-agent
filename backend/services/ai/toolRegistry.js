'use strict';

/**
 * services/ai/toolRegistry.js
 *
 * Central allowlist of actions the agent may request. The model can only pick
 * from these names. Every field here is required by spec §5/§6.
 *
 * `wired: true` means the handler is real and calls a verified service.
 * `wired: false` means the executor refuses with TOOL_NOT_AVAILABLE, so the
 * model cannot hallucinate a success.
 *
 * Tools tagged `category: 'form'` produce a structured block consumed by a
 * native form screen (create_ad, createRequest, editProfile). They are pure
 * — they validate and normalise the model's field patch, but never touch a
 * database. The actual write happens on the client.
 */

const productTools = require('./tools/productTools');
const sellerTools = require('./tools/sellerTools');
const authTools = require('./tools/authTools');
const messagingTools = require('./tools/messagingTools');
const chatThreadTools = require('./tools/chatThreadTools');
const orderTools = require('./tools/orderTools');
const formTools = require('./tools/formTools');
const navigationTools = require('./tools/navigationTools');
const cartTools = require('./tools/cartTools');
const { AUTH_INTENTS } = require('../../lib/assistant/authIntents');

/** @type {Record<string, object>} */
const TOOLS = Object.create(null);

function define(spec) {
  if (!spec.name || typeof spec.name !== 'string') throw new Error('Tool needs a name');
  if (TOOLS[spec.name]) throw new Error(`Duplicate tool: ${spec.name}`);
  TOOLS[spec.name] = spec;
}

// ─── ONBOARDING ──────────────────────────────────────────────────────────────

define({
  name: 'getOnboardingState',
  category: 'onboarding',
  description:
    'Return the current onboarding state for the caller (anonymous, ' +
    'profile_incomplete, onboarding_complete). Use first when the user asks ' +
    'how to get started or "help me register".',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresAuth: false,
  permissions: [],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx) => authTools.getOnboardingState(ctx),
});

define({
  name: 'getAvailableAuthenticationMethods',
  category: 'onboarding',
  description:
    'List sign-up / sign-in options the backend supports (Google, email+password). ' +
    'Never invent methods.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresAuth: false,
  permissions: [],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: () => authTools.getAvailableAuthenticationMethods(),
});

define({
  name: 'beginAuthHelp',
  category: 'onboarding',
  description:
    'Start or continue help with an account problem. Choose ONE intent from the ' +
    'allowed list; the tool returns the state, the next screen, and the single ' +
    'sentence you may say. Always call it before giving sign-in, registration, ' +
    'password, email-verification, or Google guidance. It never asks for a ' +
    'password or a code.',
  inputSchema: {
    type: 'object',
    properties: {
      intent: { type: 'string', enum: AUTH_INTENTS },
    },
    required: ['intent'],
    additionalProperties: false,
  },
  requiresAuth: false,
  permissions: [],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => authTools.beginAuthHelp(ctx, args),
});

define({
  name: 'startGoogleAuthentication',
  category: 'onboarding',
  description:
    'Return a URL the app should open so the user can sign in with Google. ' +
    'The app handles the callback; the AI never sees credentials. Omit ' +
    '`platform` when the screen context already supplies it.',
  inputSchema: {
    type: 'object',
    properties: {
      platform: { type: 'string', enum: ['android', 'ios'] },
      ref: { type: 'string', maxLength: 64 },
    },
    additionalProperties: false,
  },
  requiresAuth: false,
  permissions: [],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => authTools.startGoogleAuthentication(ctx, args),
});

define({
  name: 'explainAuthError',
  category: 'onboarding',
  description:
    'Explain a sign-in / sign-up / recovery outcome in one short spoken sentence. ' +
    'Call with the outcome code only (email_exists, invalid_password, no_account, ' +
    'google_only, unverified, expired_link, verification_pending, suspended, ' +
    'recovery_failed, google_cancelled, session_expired, verification_not_received, ' +
    'verification_rate_limited, reset_google_account, email_access_unavailable, ' +
    'identifier_unknown, email_invalid, registration_email_failed, network_unavailable). ' +
    'NEVER pass raw backend messages, emails, passwords, or tokens — they are rejected. ' +
    'Follow the returned nextScreen with navigateToScreen when one is given.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', maxLength: 32 },
    },
    additionalProperties: false,
  },
  requiresAuth: false,
  permissions: [],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => authTools.explainAuthenticationError(ctx, args),
});

// ─── PRODUCTS ────────────────────────────────────────────────────────────────

define({
  name: 'searchProducts',
  category: 'product',
  description:
    'Search live Salmart listings. Use when the user wants to find products. ' +
    'Returns real listings only — never invents.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 120 },
      category: { type: 'string', maxLength: 40 },
      minPrice: { type: 'number', minimum: 0 },
      maxPrice: { type: 'number', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 12, default: 8 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  requiresAuth: false,
  permissions: ['product:read'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => productTools.searchProducts(args),
});

define({
  name: 'getProductDetails',
  category: 'product',
  description: 'Fetch full details of one Salmart listing by productId.',
  inputSchema: {
    type: 'object',
    properties: { productId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
    required: ['productId'],
    additionalProperties: false,
  },
  requiresAuth: false,
  permissions: ['product:read'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => productTools.getProductDetails(args),
});

// ─── SELLER ──────────────────────────────────────────────────────────────────

define({
  name: 'getMyListings',
  category: 'seller',
  description: "List the authenticated seller's own active listings.",
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } },
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['seller:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => sellerTools.getMyListings(ctx, args),
});

define({
  name: 'createProductDraft',
  category: 'seller',
  description:
    'Prepare a DRAFT of a new listing in the conversation state. Does not ' +
    'create a live listing. Publishing is a separate confirmed action.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 3, maxLength: 120 },
      price: { type: 'number', minimum: 100 },
      category: { type: 'string', maxLength: 40 },
      description: { type: 'string', maxLength: 2000 },
    },
    required: ['title', 'price', 'category'],
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['seller:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => sellerTools.createProductDraft(ctx, args),
});

define({
  name: 'updateProductPrice',
  category: 'seller',
  description:
    "Change the price on one of the caller's own listings. CONSEQUENTIAL — " +
    'the assistant will ask the user to confirm before this runs.',
  inputSchema: {
    type: 'object',
    properties: {
      productId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      newPrice: { type: 'number', minimum: 0 },
    },
    required: ['productId', 'newPrice'],
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['seller:own', 'product:write'],
  requiresConfirmation: true,
  mutates: true,
  idempotent: false,
  wired: true,
  handler: (ctx, args) => sellerTools.updateProductPrice(ctx, args),
});

define({
  name: 'publishProductListing',
  category: 'seller',
  description:
    'Publish a draft listing. Consequential; must go through confirmation. ' +
    'NOT YET IMPLEMENTED — publishing requires the seller\'s photo/file ' +
    'upload, which only the mobile client produces.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresAuth: true,
  permissions: ['seller:own'],
  requiresConfirmation: true,
  mutates: true,
  idempotent: false,
  wired: false,
  handler: async () => {
    const e = new Error('Publishing requires the photo/file upload in the app.');
    e.code = 'TOOL_NOT_WIRED';
    throw e;
  },
});

// ─── FORM FILL ───────────────────────────────────────────────────────────────
// Pure UI patches. `mutates: false` because nothing in Mongo changes when these
// run — the corresponding screen applies the patch and the user submits.

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

define({
  name: 'navigateToScreen',
  category: 'navigation',
  description:
    'Open one of the app screens for the user. Use when they ask to go somewhere ' +
    '("open my messages", "take me to my ads") or when the next step of a task ' +
    'lives on another screen. Allowed screens: ' + Object.keys(navigationTools.SCREENS).join(', ') + '. ' +
    'For search pass a short query. Never use this to open the AI chat screen, ' +
    'and do not chain several screen changes in one turn.',
  inputSchema: {
    type: 'object',
    properties: {
      screen: { type: 'string', enum: Object.keys(navigationTools.SCREENS) },
      query: { type: 'string', maxLength: 120 },
    },
    required: ['screen'],
    additionalProperties: false,
  },
  requiresAuth: false,
  permissions: [],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => navigationTools.navigateToScreen(ctx, args),
});

define({
  name: 'prepareAdForm',
  category: 'form',
  description:
    'Fill the create-ad form the user is looking at with fields they have said. ' +
    'Include only fields the user actually gave. Never guess prices, quantities, ' +
    'categories, or locations. Use one call per field. For a bulk discount pass ' +
    'bulkDiscountMinQty plus bulkDiscountOff (naira off each item) or ' +
    'bulkDiscountPrice (final per-unit price). If the user declines an optional ' +
    'step, call with only skipStep: "discount", "servicePrice", or ' +
    '"digitalCaption" so it is never asked again. Use this INSTEAD of ' +
    'createProductDraft when the user is on the create-ad screen.',
  inputSchema: {
    type: 'object',
    properties: {
      postType: { type: 'string', enum: ['regular', 'service', 'digital'] },
      title: { type: 'string', maxLength: 120 },
      description: { type: 'string', maxLength: 2000 },
      price: { type: 'number', minimum: 0 },
      quantity: { type: 'integer', minimum: 1, maximum: 10000 },
      bulkDiscountMinQty: { type: 'integer', minimum: 2, maximum: 10000 },
      bulkDiscountOff: { type: 'number', minimum: 1 },
      bulkDiscountPrice: { type: 'number', minimum: 1 },
      skipStep: { type: 'string', enum: ['discount', 'servicePrice', 'digitalCaption'] },
      condition: { type: 'string', maxLength: 40 },
      category: { type: 'string', maxLength: 40 },
      location: { type: 'string', maxLength: 80 },
      serviceType: { type: 'string', enum: ['remote', 'onsite', 'both'] },
    },
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['seller:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => formTools.prepareAdForm(ctx, args),
});

define({
  name: 'requestListingPhoto',
  category: 'form',
  description:
    'Ask the create-ad screen to open its existing photo picker (kind "photo"), ' +
    'the phone camera (kind "camera"), or the digital-file picker (kind ' +
    '"digitalFile"). "photo" opens the gallery; use "camera" when the user says ' +
    'the picture is not on their phone yet. Call ONLY after the user agrees to ' +
    'pick one — the user chooses, the phone\'s snapshot proves what was ' +
    'selected, and a cancel simply leaves the photo step open.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['photo', 'camera', 'digitalFile'], default: 'photo' },
    },
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['seller:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => formTools.requestListingPhoto(ctx, args),
});

define({
  name: 'fillRequestForm',
  category: 'form',
  description:
    'Fill the create-request form with fields the user has said. Category must ' +
    'be one of: electronics, fashion, home, vehicles, music, others.',
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: ['electronics', 'fashion', 'home', 'vehicles', 'music', 'others'] },
      text: { type: 'string', maxLength: 500 },
      budget: { type: 'number', minimum: 0 },
      location: { type: 'string', maxLength: 80 },
    },
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['seller:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => formTools.fillRequestForm(ctx, args),
});

define({
  name: 'fillProfileForm',
  category: 'form',
  description:
    'Fill the edit-profile form with fields the user has said. Only names, bio, ' +
    'state, city. Never passwords, phone numbers, bank details, or photos — ' +
    'those stay manual for security.',
  inputSchema: {
    type: 'object',
    properties: {
      firstName: { type: 'string', maxLength: 60 },
      lastName: { type: 'string', maxLength: 60 },
      bio: { type: 'string', maxLength: 500 },
      state: { type: 'string', maxLength: 50 },
      city: { type: 'string', maxLength: 50 },
    },
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['seller:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => formTools.fillProfileForm(ctx, args),
});

define({
  name: 'prepareRegistration',
  category: 'form',
  description:
    'Pre-fill the create-account screen for a voice-first user. Only first name, ' +
    'last name, email and referral code. NEVER a password, phone number, or bank ' +
    'detail — the user must choose their own password and accept the terms. ' +
    'Combine with navigateToScreen("register") when they are not already there.',
  inputSchema: {
    type: 'object',
    properties: {
      firstName: { type: 'string', maxLength: 60 },
      lastName: { type: 'string', maxLength: 60 },
      email: { type: 'string', maxLength: 254 },
      referrer: { type: 'string', maxLength: 64 },
    },
    additionalProperties: false,
  },
  requiresAuth: false,
  permissions: [],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => formTools.prepareRegistration(ctx, args),
});

// ─── MESSAGING ───────────────────────────────────────────────────────────────

define({
  name: 'prepareSellerEnquiry',
  category: 'messaging',
  description: 'Compose a draft message to a seller about a product. Does NOT send.',
  inputSchema: {
    type: 'object',
    properties: {
      productId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      body: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['productId', 'body'],
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['message:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => messagingTools.prepareSellerEnquiry(ctx, args),
});

define({
  name: 'sendSellerEnquiry',
  category: 'messaging',
  description: 'Send a previously-prepared message. Goes through confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      productId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      sellerId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      body: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['productId', 'sellerId', 'body'],
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['message:own'],
  requiresConfirmation: true,
  mutates: true,
  idempotent: false,
  wired: true,
  handler: (ctx, args) => messagingTools.sendSellerEnquiry(ctx, args),
});

// ─── CHAT THREAD (read-only seller replies) ──────────────────────────────────

define({
  name: 'getSellerThread',
  category: 'messaging',
  description:
    'Read the last messages with one seller so you can summarise what they said. Read-only, own threads only.',
  inputSchema: {
    type: 'object',
    properties: {
      partnerId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      limit: { type: 'integer', minimum: 1, maximum: 15 },
    },
    required: ['partnerId'],
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['message:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => chatThreadTools.getSellerThread(ctx, args),
});

define({
  name: 'findSellerThreads',
  category: 'messaging',
  description:
    'List my recent seller chats (partner, last message, linked product) so you can resolve "the bag seller" globally. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['message:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => chatThreadTools.findSellerThreads(ctx, args),
});

define({
  name: 'summarizeSellerReplies',
  category: 'messaging',
  description:
    'One-call digest of what sellers replied about an item (any item, e.g. "bag", "shoe"). Covers every matching seller plus who has not replied. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      about: { type: 'string', maxLength: 120 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['message:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => chatThreadTools.summarizeSellerReplies(ctx, args),
});

// ─── ORDERS ──────────────────────────────────────────────────────────────────

define({
  name: 'getMyOrders',
  category: 'order',
  description:
    "Return the authenticated buyer's recent orders. Never returns other " +
    "users' orders. Never fabricates status.",
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 } },
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['order:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => orderTools.getMyOrders(ctx, args),
});

define({
  name: 'getOrderDetails',
  category: 'order',
  description: "Fetch one of the caller's own orders by transactionId.",
  inputSchema: {
    type: 'object',
    properties: { transactionId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
    required: ['transactionId'],
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['order:own'],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: (ctx, args) => orderTools.getOrderDetails(ctx, args),
});

define({
  name: 'addToCart',
  category: 'order',
  description:
    'Add a product to the signed-in buyer\'s cart (quantity defaults to 1). ' +
    'Only call after the user agrees to buy or reserve the item. Sold items, ' +
    'missing listings, and the buyer\'s own listings are refused. ' +
    'This only holds the item — checkout and payment stay manual on the ' +
    'cart screen, where escrow protects the buyer.',
  inputSchema: {
    type: 'object',
    properties: {
      productId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      quantity: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
      itemType: { type: 'string', enum: ['post', 'showroom'], default: 'post' },
    },
    required: ['productId'],
    additionalProperties: false,
  },
  requiresAuth: true,
  permissions: ['order:own'],
  requiresConfirmation: false,
  mutates: true,
  idempotent: false,
  wired: true,
  handler: (ctx, args) => cartTools.addToCart(ctx, args),
});

// ─── HELP ────────────────────────────────────────────────────────────────────

define({
  name: 'getAvailableAppCapabilities',
  category: 'help',
  description:
    'List what the AI can actually do right now. Never claim more than this returns.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  requiresAuth: false,
  permissions: [],
  requiresConfirmation: false,
  mutates: false,
  idempotent: true,
  wired: true,
  handler: async () => ({
    capabilities: Object.values(TOOLS)
      .filter(t => t.wired)
      .map(t => ({
        name: t.name,
        description: t.description,
        mutates: t.mutates,
        requiresConfirmation: t.requiresConfirmation,
      })),
  }),
});

// ─── ACCESSORS ───────────────────────────────────────────────────────────────

function getTool(name) {
  return TOOLS[name] || null;
}

function toolsForContext({ isAuthenticated, allowedPermissions = [] }) {
  return Object.values(TOOLS).filter(t => {
    if (t.requiresAuth && !isAuthenticated) return false;
    for (const p of t.permissions) {
      if (!allowedPermissions.includes(p)) return false;
    }
    return true;
  });
}

function toModelDefs(tools) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

module.exports = {
  TOOLS,
  define,
  getTool,
  toolsForContext,
  toModelDefs,
};