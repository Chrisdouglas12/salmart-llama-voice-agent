'use strict';

/**
 * Mongo-backed product search for the main Salmart backend.
 *
 * The hackathon agent calls one tool (`search_products`). The demo repo points
 * that tool at its local catalogue; here it points at the real Post collection,
 * and returns rows in the same compact shape the mobile app already renders.
 */

const Post = require('../../models/postSchema.js');

const STOP = new Set([
  'a', 'an', 'the', 'for', 'me', 'to', 'of', 'in', 'on', 'and', 'with',
  'some', 'any', 'new', 'brand', 'please', 'abeg',
]);
const FIELDS = ['title', 'description', 'category', 'tags'];

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tokensOf(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

function shapeProduct(p) {
  const seller = p.createdBy && typeof p.createdBy === 'object' ? p.createdBy : {};
  const photo = p.photo || (p.photos && p.photos[0]) || null;
  return {
    postId: String(p._id),
    title: p.title,
    description: p.description || '',
    price: p.price,
    photo,
    photos: p.photos && p.photos.length ? p.photos : (photo ? [photo] : []),
    condition: p.productCondition || null,
    sellerId: seller.userId ? String(seller.userId) : (seller._id ? String(seller._id) : null),
    sellerName: seller.name || null,
    sellerPicture: seller.profilePicture || null,
    category: p.category,
    location: p.location,
    postType: p.postType || 'regular',
  };
}

/**
 * @param {{query?:string, category?:string, minPrice?:number, maxPrice?:number, location?:string, condition?:string, limit?:number}} args
 * @returns {Promise<{products:Array, source:string}>}
 */
async function searchMongo({ query, category, minPrice, maxPrice, location, condition, limit = 6 } = {}) {
  const tokens = tokensOf(query);
  if (!tokens.length && !category) return { products: [], source: 'salmart' };

  const base = { isSold: { $ne: true }, isBlocked: { $ne: true } };
  if (category) base.category = new RegExp(esc(category), 'i');
  if (location) base.location = new RegExp(esc(location), 'i');
  if (condition) base.productCondition = new RegExp(esc(condition), 'i');
  if (minPrice != null || maxPrice != null) {
    base.price = {};
    if (minPrice != null) base.price.$gte = Number(minPrice);
    if (maxPrice != null) base.price.$lte = Number(maxPrice);
  }

  const tokenClause = t => ({ $or: FIELDS.map(f => ({ [f]: new RegExp(esc(t), 'i') })) });
  const run = filter =>
    Post.find(filter)
      .select('_id title description price photo photos category location createdBy postType quantity productCondition')
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 6, 10))
      .lean();

  let posts = tokens.length ? await run({ ...base, $and: tokens.map(tokenClause) }) : [];
  if (!posts.length && tokens.length > 1) {
    posts = await run({ ...base, $or: tokens.map(tokenClause) });
  }
  // A category-only request (e.g. "show me phones") still needs results.
  if (!posts.length && !tokens.length && category) {
    posts = await run(base);
  }

  return { products: posts.map(shapeProduct), source: 'salmart' };
}

module.exports = { searchMongo, shapeProduct };
