'use strict';

/**
 * services/ai/structuredBlocks.js
 *
 * Pure conversion of agent tool results into the typed `structured[]` array the
 * mobile app renders. No Express, no Mongo, no provider — so it is unit-testable.
 *
 * Contract (see routes/aiRoutes.js header):
 *   - form fills are merged per target into one block;
 *   - at most ONE `navigate` block is emitted per turn (last request wins) and
 *     its target is re-checked against the server allowlist;
 *   - unknown tools contribute nothing.
 */

const navigationTools = require('./tools/navigationTools');

/**
 * Only an auth initiation URL may be rendered as a tappable block. The backend
 * already built it from APP_BASE_URL; this second check rejects a forged or
 * non-HTTP scheme and any path other than the Google initiation route, so a
 * compromised model response cannot become a `javascript:` or arbitrary link.
 */
function safeAuthUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (!/^\/auth\/google\/?$/.test(url.pathname)) return null;
    const out = url.toString();
    return out.length <= 2048 ? out : null;
  } catch (_e) {
    return null;
  }
}

function buildStructured(toolResults) {
  const out = [];
  const push = (entry) => { if (entry) out.push(entry); };

  const drafts = { ad: [], request: [], profile: [], register: [] };
  const navigations = [];
  // A create-ad navigation for a physical item opens the photo chooser on the
  // phone automatically (the selling walkthrough starts from the photo).
  // A service/digital listing in the same turn suppresses it.
  let openPhotoChooser = false;
  let nonRegularAd = false;

  for (const r of toolResults || []) {
    if (!r || !r.ok || !r.data) continue;

    switch (r.name) {
      case 'searchProducts':
        if (Array.isArray(r.data.products)) {
          push({
            type: 'product_results',
            products: r.data.products,
            total: r.data.total || r.data.products.length,
            hint: r.data.hint || null,
          });
        }
        break;
      case 'getProductDetails':
        if (r.data.found) push({ type: 'product_details', product: r.data.product });
        break;
      case 'getMyListings':
        if (Array.isArray(r.data.listings)) {
          push({ type: 'listing_list', listings: r.data.listings, total: r.data.total });
        }
        break;
      case 'getMyOrders':
        if (Array.isArray(r.data.orders)) {
          push({ type: 'order_information', orders: r.data.orders, total: r.data.total });
        }
        break;
      case 'getOrderDetails':
        push({ type: 'order_details', found: !!r.data.found, order: r.data.order || null });
        break;
      case 'getAvailableAuthenticationMethods':
        if (Array.isArray(r.data.methods)) {
          push({ type: 'onboarding_options', methods: r.data.methods });
        }
        break;
      case 'prepareSellerEnquiry':
        if (r.data.prepared) {
          push({ type: 'message_preview', prepared: r.data.prepared });
          push({
            type: 'chat_handoff',
            sellerId: r.data.prepared.sellerId,
            sellerName: r.data.prepared.sellerName,
            productId: r.data.prepared.productId,
            productTitle: r.data.prepared.productTitle,
            imageUrl: r.data.prepared.productImageUrl || null,
            price: r.data.prepared.productPrice ?? null,
            draft: r.data.prepared.body,
          });
        }
        break;
      case 'getSellerThread':
        if (r.data && r.data.found) push({ type: 'seller_thread', thread: r.data });
        break;
      case 'findSellerThreads':
        if (r.data && r.data.found) push({ type: 'seller_thread_list', threads: r.data.threads || [] });
        break;
      case 'summarizeSellerReplies':
        if (r.data && r.data.found) push({ type: 'seller_replies_digest', digest: r.data });
        break;
      case 'getAvailableAppCapabilities':
        if (Array.isArray(r.data.capabilities)) {
          push({ type: 'capabilities', capabilities: r.data.capabilities });
        }
        break;

      // ── auth handoff ────────────────────────────────────────────────────
      case 'startGoogleAuthentication': {
        const url = safeAuthUrl(r.data.url);
        if (url) {
          push({
            type: 'auth_url',
            authMethod: 'google',
            platform: r.data.platform || null,
            url,
          });
        }
        break;
      }

      // ── form-fill bridge ────────────────────────────────────────────────
      case 'prepareAdForm':
      case 'createProductDraft':
        if (r.data.fields || r.data.draft) {
          drafts.ad.push({
            fields: r.data.fields || r.data.draft,
            say: r.data.note || null,
          });
        }
        if ((r.data.fields?.postType || r.data.draft?.postType)
          && (r.data.fields?.postType || r.data.draft?.postType) !== 'regular') {
          nonRegularAd = true;
        }
        break;
      case 'fillRequestForm':
        if (r.data.fields) drafts.request.push({ fields: r.data.fields, say: r.data.note || null });
        break;
      case 'fillProfileForm':
        if (r.data.fields) drafts.profile.push({ fields: r.data.fields, say: r.data.note || null });
        break;
      case 'prepareRegistration':
        if (r.data.fields) drafts.register.push({ fields: r.data.fields, say: r.data.note || null });
        break;

      // ── picker request ─────────────────────────────────────────────────
      case 'requestListingPhoto':
        if (r.data.kind === 'photo' || r.data.kind === 'camera' || r.data.kind === 'digitalFile') {
          push({ type: 'open_picker', target: 'createAd', kind: r.data.kind, say: r.data.note || null });
        }
        break;

      // ── navigation ─────────────────────────────────────────────────────
      case 'navigateToScreen':
        if (r.data.screen && navigationTools.isAllowedScreen(r.data.screen)) {
          navigations.push({
            target: r.data.screen,
            query: r.data.query || null,
          });
          if (r.data.screen === 'createAd') openPhotoChooser = true;
        }
        break;

      default: break;
    }
  }

  // Merge per target into one block, matching the old AssistantContext
  // contract where adjacent fill actions became one patch.
  if (drafts.ad.length) {
    push({
      type: 'fill_ad',
      target: 'createAd',
      fields: Object.assign({}, ...drafts.ad.map(d => d.fields)),
      say: drafts.ad.map(d => d.say).filter(Boolean).slice(-1)[0] || null,
    });
  }
  if (drafts.request.length) {
    push({
      type: 'fill_request',
      target: 'createRequest',
      fields: Object.assign({}, ...drafts.request.map(d => d.fields)),
      say: drafts.request.map(d => d.say).filter(Boolean).slice(-1)[0] || null,
    });
  }
  if (drafts.profile.length) {
    push({
      type: 'fill_profile',
      target: 'editProfile',
      fields: Object.assign({}, ...drafts.profile.map(d => d.fields)),
      say: drafts.profile.map(d => d.say).filter(Boolean).slice(-1)[0] || null,
    });
  }
  if (drafts.register.length) {
    push({
      type: 'fill_register',
      target: 'register',
      fields: Object.assign({}, ...drafts.register.map(d => d.fields)),
      say: drafts.register.map(d => d.say).filter(Boolean).slice(-1)[0] || null,
    });
  }

  // One navigation per turn. If the model asked for several (it should not),
  // the last one wins rather than bouncing the user through intermediate
  // screens. Emitted after form fills so the patch is already in the response
  // when the target screen mounts.
  if (navigations.length) {
    const last = navigations[navigations.length - 1];
    // The physical-item selling walkthrough starts with the picture: the
    // create-ad screen opens its gallery/camera chooser on arrival. A service
    // or digital listing has no photo step, so it is skipped there.
    if (last.target === 'createAd' && openPhotoChooser && !nonRegularAd
      && !out.some(b => b.type === 'open_picker')) {
      push({ type: 'open_picker', target: 'createAd', kind: 'photo', say: null, auto: true });
    }
    push({ type: 'navigate', target: last.target, query: last.query || null });
  }

  return out;
}

module.exports = { buildStructured, safeAuthUrl };
