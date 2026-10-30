'use strict';

/**
 * services/ai/tools/orderTools.js
 *
 * Buyer-side order reads. Uses the SAME authorization shape as
 * routes/transactionRoutes.js#GET /get-transactions/:userId — a caller can
 * only read rows where they are the buyer. Seller rows are out of scope for
 * the AI in this phase (the seller's "my sales" surface already exists in the
 * app and has its own escrow/confirm-delivery UI).
 *
 * Field names and status values confirmed from models/transactionSchema.js.
 * Never invents a status: if a raw value is not in STATUS_TEXT it is returned
 * verbatim as `status` and the human label falls back to "Processing".
 */

const mongoose = require('mongoose');
const Transaction = require('../../../models/transactionSchema');

// Human labels for the enum. Anything not listed is still returned as the
// raw `status` — the label just falls back to a neutral string. This is
// deliberate: a schema migration must not silently produce "Unknown order".
const STATUS_TEXT = {
  awaiting_payment:        'Awaiting payment',
  pending:                 'Processing',
  in_escrow:               'Paid — funds held in escrow',
  transfer_initiated:      'Payout in progress to seller',
  confirmed_pending_payout:'Delivered — payout pending',
  released:                'Completed',
  refunded:                'Refunded',
  transfer_failed:         'Payout failed — support is looking into it',
  reversed:                'Reversed',
  cancelled:               'Cancelled',
  digital_hold:            'Delivered — 48-hour review window',
  disputed:                'Under dispute review',
  completed:               'Completed',
};

// Same allowlist used by the buyer in the UI today (see
// transactionRoutes.js#GET /pending-summary and the digital download route).
const VISIBLE_TO_BUYER = new Set(Object.keys(STATUS_TEXT));

function humanStatus(status) {
  return STATUS_TEXT[status] || 'Processing';
}

/**
 * getMyOrders({ limit })
 * Returns recent transactions where the CALLER is the buyer.
 * Never returns seller-side rows. Never touches sellerId in the query.
 */
async function getMyOrders(ctx, { limit } = {}) {
  if (!ctx.userId) {
    const e = new Error('Sign in to view your orders.'); e.code = 'AUTH_REQUIRED'; throw e;
  }
  const cap = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const buyerObjectId = new mongoose.Types.ObjectId(ctx.userId);

  const rows = await Transaction.find({ buyerId: buyerObjectId })
    .select(
      '_id postId postModel amount currencyUnit status createdAt productMetadata ' +
      'digitalDownloadUrl digitalDownloadExpiry dateReleased refundedAt disputeReason'
    )
    .sort({ createdAt: -1 })
    .limit(cap)
    .populate({ path: 'postId', select: 'title photo photos postType', model: undefined })
    .lean();

  const orders = rows
    .filter(r => VISIBLE_TO_BUYER.has(r.status))
    .map(r => {
      const post = r.postId && typeof r.postId === 'object' ? r.postId : null;
      return {
        transactionId: String(r._id),
        productId: post ? String(post._id) : null,
        title: post?.title || r.productMetadata?.productTitle || 'Order',
        photo:
          post?.photo ||
          (post?.photos && post.photos[0]) ||
          (r.productMetadata?.productImages && r.productMetadata.productImages[0]) ||
          null,
        amount: r.amount,
        currency: r.currency || 'NGN',
        status: r.status,
        statusLabel: humanStatus(r.status),
        createdAt: r.createdAt,
        // Only include download info when the file is actually releasable — a
        // buyer cannot download a `pending` order and pretending otherwise is
        // worse than a shorter response.
        downloadAvailable:
          ['digital_hold', 'completed', 'released'].includes(r.status) &&
          !!r.digitalDownloadUrl,
        downloadExpiresAt: r.digitalDownloadExpiry || null,
      };
    });

  return {
    orders,
    total: orders.length,
    ...(orders.length === 0 && {
      hint: 'No orders yet. Once you buy something it will appear here.',
    }),
  };
}

/**
 * getOrderDetails({ transactionId })
 * Single-order view. Enforces buyer-only access — the query filters on BOTH
 * _id and buyerId, so a guessed transactionId from another user returns the
 * same "not found" as a real miss. That is the correct behaviour for a
 * financial record.
 */
async function getOrderDetails(ctx, { transactionId } = {}) {
  if (!ctx.userId) {
    const e = new Error('Sign in to view order details.'); e.code = 'AUTH_REQUIRED'; throw e;
  }
  if (!mongoose.Types.ObjectId.isValid(transactionId)) {
    const e = new Error('Invalid transactionId.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }

  const r = await Transaction.findOne({
    _id: transactionId,
    buyerId: new mongoose.Types.ObjectId(ctx.userId),
  })
    .populate({ path: 'postId', select: 'title description photo photos postType category location productCondition' })
    .populate({ path: 'sellerId', select: 'firstName lastName profilePicture' })
    .lean();

  if (!r) return { found: false, reason: 'not_found' };

  const post = r.postId && typeof r.postId === 'object' ? r.postId : null;
  const seller = r.sellerId && typeof r.sellerId === 'object' ? r.sellerId : null;

  return {
    found: true,
    order: {
      transactionId: String(r._id),
      title: post?.title || r.productMetadata?.productTitle || 'Order',
      description: post?.description || r.productMetadata?.productDescription || null,
      photo:
        post?.photo ||
        (post?.photos && post.photos[0]) ||
        (r.productMetadata?.productImages && r.productMetadata.productImages[0]) ||
        null,
      category: post?.category || r.productMetadata?.productCategory || null,
      condition: post?.productCondition || r.productMetadata?.productCondition || null,
      location: post?.location || r.productMetadata?.productLocation || null,
      amount: r.amount,
      currency: r.currency || 'NGN',
      status: r.status,
      statusLabel: humanStatus(r.status),
      createdAt: r.createdAt,
      dateReleased: r.dateReleased || null,
      refundedAt: r.refundedAt || null,
      // Dispute reason is buyer-facing: it was written BY or FOR this buyer.
      dispute: r.status === 'disputed'
        ? { reason: r.disputeReason || null }
        : null,
      seller: seller
        ? {
            id: String(seller._id),
            name: `${seller.firstName || ''} ${seller.lastName || ''}`.trim() || 'Seller',
            profilePicture: seller.profilePicture || null,
          }
        : null,
      downloadAvailable:
        ['digital_hold', 'completed', 'released'].includes(r.status) &&
        !!r.digitalDownloadUrl,
      downloadExpiresAt: r.digitalDownloadExpiry || null,
    },
  };
}

module.exports = { getMyOrders, getOrderDetails, STATUS_TEXT };