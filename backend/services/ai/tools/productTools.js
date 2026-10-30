'use strict';

/**
 * services/ai/tools/productTools.js
 *
 * Real product tools. Wraps the SAME internal query helpers that
 * GET /search uses (via routes/searchRoutes.js `_internal` export), so the
 * AI agent and the app's search screen can never drift apart.
 *
 * No new search logic here. If search changes, it changes in one file.
 */

const mongoose = require('mongoose');
const Post = require('../../../models/postSchema');
const searchRoutes = require('../../../routes/searchRoutes');

const { buildProductCriteria, runProductQuery, shapeProduct, enrichSellers, VALID_CATEGORIES } =
  searchRoutes._internal || {};

if (!buildProductCriteria) {
  // Fail loud at boot rather than silently returning empty results later.
  throw new Error(
    'searchRoutes._internal missing — apply the append-only export block to routes/searchRoutes.js'
  );
}

const MAX_RESULTS = 12;

/**
 * searchProducts({ query, category, minPrice, maxPrice, limit })
 *
 * Public — no auth required. Mirrors what the buyer sees on the Search screen.
 */
async function searchProducts({ query, category, minPrice, maxPrice, limit }) {
  const q = String(query || '').trim();
  if (!q) {
    return { products: [], hint: 'Ask the user what they are looking for.' };
  }

  const safeCategory =
    category && VALID_CATEGORIES.includes(String(category).toLowerCase())
      ? String(category).toLowerCase()
      : undefined;

  const criteria = buildProductCriteria({
    q,
    category: safeCategory,
    minPrice: typeof minPrice === 'number' ? minPrice : undefined,
    maxPrice: typeof maxPrice === 'number' ? maxPrice : undefined,
  });

  const { rows, total } = await runProductQuery({
    criteria,
    q,
    sort: 'relevance',
    skip: 0,
    limit: Math.min(Number(limit) || 8, MAX_RESULTS),
    userId: null,
  });

  const products = rows.map(shapeProduct).filter(Boolean);
  await enrichSellers(products);

  return {
    products: products.map(p => ({
      productId: String(p._id),
      title: p.title,
      price: p.price,
      listPrice: p.listPrice || null,
      photo: p.photo,
      category: p.category,
      condition: p.productCondition || null,
      location: p.location || null,
      sellerId: p.seller?.id ? String(p.seller.id) : null,
      sellerName: p.seller?.name || null,
      sellerVerified: !!p.seller?.isVerifiedSeller,
      isDeal: !!p.isDeal,
    })),
    total,
    ...(products.length === 0 && {
      hint: 'Nothing found. Ask the user to broaden the search or suggest an alternative.',
    }),
  };
}

/**
 * getProductDetails({ productId })
 *
 * Only returns a listing that is currently active and not sold. Owner
 * listings are included; the AI never invents fields.
 */
async function getProductDetails({ productId }) {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    const e = new Error('Invalid productId.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }

  // Fetching via the model directly (not the search pipeline) because this
  // needs the seller + reviews even when the listing is not in a search result.
  const doc = await Post.findOne({ _id: productId, status: 'active' }).lean();
  if (!doc) {
    return { found: false, reason: 'not_found_or_inactive' };
  }

  const [shaped] = [shapeProduct(doc)];
  if (shaped) await enrichSellers([shaped]);

  return {
    found: true,
    product: {
      productId: String(shaped._id),
      title: shaped.title,
      description: shaped.description,
      price: shaped.price,
      listPrice: shaped.listPrice || null,
      photos: shaped.photos || (shaped.photo ? [shaped.photo] : []),
      category: shaped.category,
      condition: shaped.productCondition || null,
      location: shaped.location || null,
      isSold: shaped.isSold,
      seller: shaped.seller
        ? {
            id: shaped.seller.id ? String(shaped.seller.id) : null,
            name: shaped.seller.name,
            isVerified: !!shaped.seller.isVerifiedSeller,
            rating: shaped.seller.rating,
            reviewCount: shaped.seller.reviewCount,
          }
        : null,
    },
  };
}

module.exports = { searchProducts, getProductDetails };