'use strict';

/**
 * services/ai/tools/sellerTools.js
 *
 * Seller-facing tools. Every write goes through an explicit ownership check
 * against ctx.userId (from trusted JWT). The model can never pass an owner id.
 *
 * `createProductDraft` and `updateProductPrice` are prepared as pending
 * actions by the executor — the handler here only runs after user confirmation.
 * `getMyListings` is read-only and safe to call directly.
 */

const mongoose = require('mongoose');
const Post = require('../../../models/postSchema');

const MAX_LISTINGS = 20;

// Mirrors the schema's category enum. Rejects model guesses.
const VALID_CATEGORIES = [
  'electronics', 'fashion', 'home', 'vehicles', 'music',
  'books', 'food_items', 'others', 'services', 'digital',
];

async function getMyListings(ctx, { limit }) {
  if (!ctx.userId) {
    const e = new Error('Sign in to view your listings.');
    e.code = 'AUTH_REQUIRED';
    throw e;
  }

  const docs = await Post.find({
    'createdBy.userId': new mongoose.Types.ObjectId(ctx.userId),
    status: 'active',
    isSold: { $ne: true },
  })
    .select('_id title price photo photos category location productCondition postType createdAt')
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 10, MAX_LISTINGS))
    .lean();

  return {
    listings: docs.map(d => ({
      productId: String(d._id),
      title: d.title,
      price: d.price,
      photo: d.photo || (d.photos && d.photos[0]) || null,
      category: d.category,
      condition: d.productCondition || null,
      location: d.location || null,
      postType: d.postType,
      createdAt: d.createdAt,
    })),
    total: docs.length,
    ...(docs.length === 0 && { hint: 'You have no active listings yet.' }),
  };
}

/**
 * updateProductPrice — CONSEQUENTIAL. Only called by the executor after the
 * user has confirmed the exact change via the pending-action flow.
 */
async function updateProductPrice(ctx, { productId, newPrice }) {
  if (!ctx.userId) {
    const e = new Error('Sign in to change a listing price.');
    e.code = 'AUTH_REQUIRED';
    throw e;
  }
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    const e = new Error('Invalid productId.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }
  const price = Number(newPrice);
  if (!Number.isFinite(price) || price < 0) {
    const e = new Error('Price must be a non-negative number.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }

  const post = await Post.findById(productId).lean();
  if (!post) {
    const e = new Error('Listing not found.'); e.code = 'TOOL_FAILED'; throw e;
  }
  if (String(post.createdBy?.userId) !== String(ctx.userId)) {
    const e = new Error('You can only change your own listings.'); e.code = 'FORBIDDEN'; throw e;
  }
  if (post.isSold) {
    const e = new Error('That listing is already sold.'); e.code = 'TOOL_FAILED'; throw e;
  }

  const oldPrice = Number(post.price);

  // Matches assistantRoutes.updateListingPrice: manual price change clears an
  // active discount so the UI does not show a stale struck-through price.
  const updated = await Post.findByIdAndUpdate(
    productId,
    { $set: { price, updatedAt: new Date() }, $unset: { discount: '' } },
    { new: true }
  ).lean();

  if (!updated || Number(updated.price) !== price) {
    const e = new Error('Price change did not persist. Try again.');
    e.code = 'TOOL_FAILED';
    throw e;
  }

  return { success: true, productId: String(productId), title: updated.title, oldPrice, newPrice: price };
}

/**
 * createProductDraft — CONSEQUENTIAL at publish time, but the draft itself is
 * not visible to buyers, so we do NOT require confirmation here. Publishing is
 * a separate tool that DOES require confirmation.
 *
 * A draft is stored on the AIConversation.collectedInfo.draft, NOT as a Post.
 * Rationale: keeping unfinished drafts out of the live `Post` collection means
 * a buyer's search can never surface a half-completed listing, and there is no
 * schema field to make a "draft" Post invisible. The publish tool is what
 * turns the draft into a real Post — after user confirmation and after
 * revalidating the fields against the live schema.
 */
async function createProductDraft(ctx, { title, price, category, description }) {
  if (!ctx.userId) {
    const e = new Error('Sign in to create a listing.'); e.code = 'AUTH_REQUIRED'; throw e;
  }

  const cleanTitle = String(title || '').trim().slice(0, 120);
  const cleanCategory = String(category || '').toLowerCase();
  const cleanDescription = String(description || '').trim().slice(0, 2000);
  const cleanPrice = Number(price);

  if (cleanTitle.length < 3) {
    const e = new Error('Title is too short.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }
  if (!VALID_CATEGORIES.includes(cleanCategory)) {
    const e = new Error(`Category must be one of: ${VALID_CATEGORIES.join(', ')}`);
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }
  if (!Number.isFinite(cleanPrice) || cleanPrice < 100) {
    const e = new Error('Price must be at least ₦100.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }

  return {
    draft: {
      title: cleanTitle,
      price: cleanPrice,
      category: cleanCategory,
      description: cleanDescription,
    },
    note: 'Draft prepared. Publishing requires confirmation — photo/file and remaining required fields may still be missing.',
  };
}

module.exports = { getMyListings, updateProductPrice, createProductDraft, VALID_CATEGORIES };