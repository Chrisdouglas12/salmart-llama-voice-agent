'use strict';

/**
 * services/ai/tools/messagingTools.js
 *
 * Message a seller about a specific product. Mirrors
 * assistantRoutes.startChatWithSeller: creates a Message document directly
 * via the Message model. No new service.
 *
 * prepareSellerEnquiry is READ-ONLY — it just validates the target and
 * returns the composed text so the user can confirm it.
 * sendSellerEnquiry actually persists the message. Called only after
 * confirmation via the pending-action flow.
 */

const mongoose = require('mongoose');
const Message = require('../../../models/messageSchema');
const Post = require('../../../models/postSchema');
const User = require('../../../models/userSchema');

async function prepareSellerEnquiry(ctx, { productId, body }) {
  if (!ctx.userId) {
    const e = new Error('Sign in to message a seller.'); e.code = 'AUTH_REQUIRED'; throw e;
  }
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    const e = new Error('Invalid productId.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }
  const text = String(body || '').trim().slice(0, 500);
  if (!text) {
    const e = new Error('Message body is empty.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }

  const post = await Post.findOne({ _id: productId, status: 'active' })
    .select('title price photo createdBy')
    .lean();
  if (!post) {
    return { found: false, reason: 'product_not_found' };
  }
  const sellerId = String(post.createdBy?.userId || '');
  if (!sellerId) {
    return { found: false, reason: 'seller_missing' };
  }
  if (sellerId === String(ctx.userId)) {
    const e = new Error('You cannot message yourself.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }

  // Verify the seller hasn't blocked the current user — same as the existing
  // route checks (see socketRoutes.sendMessage and startChatWithSeller).
  const seller = await User.findById(sellerId).select('blockedUsers firstName lastName').lean();
  if (!seller) {
    return { found: false, reason: 'seller_missing' };
  }
  if (Array.isArray(seller.blockedUsers) &&
      seller.blockedUsers.some(id => String(id) === String(ctx.userId))) {
    const e = new Error('You cannot message this seller.'); e.code = 'FORBIDDEN'; throw e;
  }

  return {
    found: true,
    prepared: {
      productId: String(productId),
      productTitle: post.title,
      productImageUrl: post.photo || null,
      productPrice: typeof post.price === 'number' ? post.price : null,
      sellerId,
      sellerName: `${seller.firstName || ''} ${seller.lastName || ''}`.trim() || 'Seller',
      body: text,
    },
    note: 'Message prepared. Show the draft with the product photo, ask the user to confirm, then open the seller chat.',
  };
}

async function sendSellerEnquiry(ctx, { productId, sellerId, body }) {
  if (!ctx.userId) {
    const e = new Error('Sign in to message a seller.'); e.code = 'AUTH_REQUIRED'; throw e;
  }
  // Re-validate everything the prepare step validated: the model must not be
  // able to skip past the pre-flight checks by calling send directly.
  const prepared = await prepareSellerEnquiry(ctx, { productId, body });
  if (!prepared.found) {
    const e = new Error('Product or seller not found.'); e.code = 'TOOL_FAILED'; throw e;
  }
  if (String(prepared.prepared.sellerId) !== String(sellerId)) {
    const e = new Error('Seller does not match the product.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }

  const hasImage = !!prepared.prepared.productImageUrl;
  const msg = await new Message({
    senderId: new mongoose.Types.ObjectId(ctx.userId),
    receiverId: new mongoose.Types.ObjectId(sellerId),
    text: prepared.prepared.body,
    messageType: hasImage ? 'image' : 'text',
    ...(hasImage
      ? { attachment: { url: prepared.prepared.productImageUrl, type: 'image' } }
      : {}),
    metadata: { productId: new mongoose.Types.ObjectId(productId), source: 'ai_enquiry' },
    status: 'sent',
  }).save();

  return {
    success: true,
    messageId: String(msg._id),
    sentText: prepared.prepared.body,
    sellerName: prepared.prepared.sellerName,
    sellerId: String(prepared.prepared.sellerId),
    productId: String(prepared.prepared.productId),
    productImageUrl: prepared.prepared.productImageUrl,
  };
}

module.exports = { prepareSellerEnquiry, sendSellerEnquiry };