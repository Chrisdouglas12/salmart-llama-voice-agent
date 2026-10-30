'use strict';

/**
 * services/ai/tools/cartTools.js
 *
 * Buyer-side cart write for the agent. Mirrors the guards in
 * routes/cartRoutes.js#POST /api/cart exactly — valid id, listing exists,
 * not sold out, and never the buyer's own listing — so the agent cannot put
 * anything in the cart the cart screen itself would reject.
 *
 * Adding to cart is reversible (the cart screen can remove it) and only ever
 * runs after the user agrees in conversation, so it executes inline with no
 * confirmation card. Payment itself is never touched: checkout stays manual
 * on the cart screen, where escrow protects the buyer.
 */

const mongoose = require('mongoose');
const Cart = require('../../../models/cartSchema.js');
const Post = require('../../../models/postSchema.js');
const Showroom = require('../../../models/showRoomSchema.js');

const MAX_CART_ITEMS = 50;
const MAX_QUANTITY = 10000;

function sellerIdOf(product, itemType) {
  if (!product) return null;
  if (itemType === 'showroom') return product.seller ? String(product.seller) : null;
  return product.createdBy?.userId ? String(product.createdBy.userId) : null;
}

/**
 * addToCart({ productId, quantity?, itemType? })
 * Returns { added, title, quantity, cartCount }. Throws AUTH_REQUIRED,
 * TOOL_BAD_ARGS, or TOOL_FAILED with plain user-safe messages.
 */
async function addToCart(ctx, { productId, quantity = 1, itemType = 'post' } = {}) {
  if (!ctx.userId) {
    const e = new Error('Sign in to add items to your cart.');
    e.code = 'AUTH_REQUIRED';
    throw e;
  }
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    const e = new Error('Invalid productId.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }
  const type = itemType === 'showroom' ? 'showroom' : 'post';
  const qty = Math.min(Math.max(parseInt(quantity, 10) || 1, 1), MAX_QUANTITY);

  const product = type === 'showroom'
    ? await Showroom.findById(productId).lean()
    : await Post.findById(productId).lean();
  if (!product) {
    const e = new Error('That item is no longer available.');
    e.code = 'TOOL_FAILED';
    throw e;
  }
  if (product.isSold) {
    const e = new Error('That item is already sold.');
    e.code = 'TOOL_FAILED';
    throw e;
  }

  const sellerId = sellerIdOf(product, type);
  if (!sellerId) {
    const e = new Error('That item has no seller.');
    e.code = 'TOOL_FAILED';
    throw e;
  }
  if (sellerId === String(ctx.userId)) {
    const e = new Error('You cannot add your own listing to the cart.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }

  const isService = type === 'post' && product.postType === 'service';
  const isDigital = type === 'post' && product.postType === 'digital';
  const addQty = (isService || isDigital) ? 1 : qty;

  let cart = await Cart.findOne({ buyerId: ctx.userId });
  if (!cart) cart = await Cart.create({ buyerId: ctx.userId, items: [] });

  const existing = cart.items.find((i) => String(i.postId) === String(productId));
  if (existing) {
    existing.quantity = Math.min(existing.quantity + addQty, MAX_QUANTITY);
  } else {
    if (cart.items.length >= MAX_CART_ITEMS) {
      const e = new Error(`Your cart is full (max ${MAX_CART_ITEMS} items).`);
      e.code = 'TOOL_FAILED';
      throw e;
    }
    cart.items.push({
      postId: productId,
      postModel: type === 'showroom' ? 'Showroom' : 'Post',
      sellerId,
      quantity: addQty,
    });
  }
  await cart.save();

  return {
    added: true,
    title: product.title || product.description || 'Item',
    quantity: existing ? existing.quantity : addQty,
    cartCount: cart.items.length,
    note: 'Item added to the cart. Checkout stays manual on the cart screen.',
  };
}

module.exports = { addToCart };
