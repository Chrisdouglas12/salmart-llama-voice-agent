'use strict';

const mongoose = require('mongoose');


// ─── Sub-schemas (keeps main schema clean + enables selective population) ────

const attachmentSchema = new mongoose.Schema(
  {
    url:                { type: String, required: true },
    type:               { type: String, enum: ['image', 'file', 'receipt'], required: true },
    cloudinaryPublicId: { type: String } // retained for Cloudinary cleanup jobs
  },
  { _id: false } // embedded, no need for its own _id
);

const offerDetailsSchema = new mongoose.Schema(
  {
    productId:     { type: String,  required: true },
    proposedPrice: { type: Number,  required: true },
    originalPrice: { type: Number,  required: true },
    // ✂️  productName + image REMOVED — look them up via productId when needed.
    //     Saves ~200–400 bytes per bargain message. On 10k messages = ~3MB saved.
    status: {
      type:    String,
      enum:    ['pending', 'accepted', 'declined', 'completed'],
      default: 'pending'
    },
    isCounterOffer: { type: Boolean, default: false }
  },
  { _id: false }
);

const viewOnceSchema = new mongoose.Schema(
  {
    enabled:  { type: Boolean, default: false },
    viewed:   { type: Boolean, default: false },
    viewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    viewedAt: { type: Date },
    deleteAt: { type: Date } // ← TTL index targets this field
  },
  { _id: false }
);

// ─── Listing sub-schema — for group product posts (image + buy button) ──────────
//
// When a seller uploads a product image to a group chat they fill in price,
// title, description, condition, and location. This creates a lightweight Post
// record AND stores these fields inline on the message so the bubble can render
// without an extra DB hop. listingPostId is the Post._id used by checkout.html.
//
const listingSchema = new mongoose.Schema(
  {
    title:       { type: String, required: true, maxlength: 120 },
    price:       { type: Number, required: true, min: 0 },
    description: { type: String, maxlength: 500 },
    condition:   { type: String, enum: ['New', 'Used - Like New', 'Used - Good', 'Used - Fair'], default: 'New' },
    location:    { type: String, maxlength: 100 },
    quantity:    { type: Number, default: 1, min: 1 }, // how many available
    imageUrl:    { type: String, required: true },   // Cloudinary URL
    imagePublicId: { type: String },                 // for cleanup
    listingPostId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' }, // real Post for checkout
    sellerId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

// ─── Digital delivery sub-doc ─────────────────────────────────────────────────
//
// Sent by paymentRoutes.deliverDigitalProduct the moment a digital purchase is
// paid for. The download URL lives here (and on the transaction) so the chat
// bubble can render a Download button instead of pasting a raw Cloudinary link
// into the message text, which is what the old flow did.
//
const digitalDeliverySchema = new mongoose.Schema(
  {
    downloadUrl:   { type: String, required: true },
    fileName:      { type: String },   // seller's original filename, kept intact
    productTitle:  { type: String },
    transactionId: { type: String },
    expiresAt:     { type: Date },     // end of the dispute window
  },
  { _id: false }
);

// ─── Main schema ──────────────────────────────────────────────────────────────

const messageSchema = new mongoose.Schema(
  {
    // Conversation parties
    // For DMs:    senderId + receiverId are both set, groupId is absent.
    // For groups: senderId + groupId are set, receiverId is absent.
    senderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    receiverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // optional for group msgs
    groupId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Group' }, // set only for group msgs

    // Content
    text:       { type: String },
    attachment: { type: attachmentSchema },

    // Status — single source of truth (removed redundant `isRead`)
    status: {
      type:    String,
      enum:    ['sent', 'delivered', 'seen'],
      default: 'sent'
    },

    // Message classification
    messageType: {
      type: String,
      enum: [
        'text',
        'image',
        'file',
        'bargainStart',
        'end-bargain',
        'buyerAccept',
        'sellerAccept',
        'sellerDecline',
        'buyerDeclineResponse',
        'offer',
        'sellerNotification',
        'counter-offer',
        'payment-completed',
        'digital_delivery', // ← paid digital product with a Download button
        'group-listing',  // ← group product post with buy button
        'ptt_clip'        // ← push-to-talk audio turn (see socketRoutes.js pttClip handler)
      ],
      default: 'text'
    },

    // Push-to-talk clip metadata — duration lets the client size the
    // waveform/playback UI without fetching the audio file first.
    pttClip: {
      durationSeconds: { type: Number, min: 0, max: 120 }, // hard cap enforced server-side too
      sessionId:       { type: String },
    },

    // Reply-to (swipe-to-reply / long-press reply) — denormalized preview so the
    // conversation thread query doesn't need a second lookup or populate() to
    // render the quoted snippet. Mirrors the offerDetails "keep it lean" pattern.
    replyTo:           { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    replyPreviewText:  { type: String, maxlength: 200 },
    replySenderName:   { type: String, maxlength: 80 },

    // Bargain/offer data — lean version (no denormalized product name/image)
    offerDetails: { type: offerDetailsSchema },

    // ViewOnce — optional, only present on eligible image messages
    viewOnce: { type: viewOnceSchema },

    // Group product listing — only present on group 'group-listing' messages
    listing: { type: listingSchema },

    // Digital delivery — only present on 'digital_delivery' messages
    digital: { type: digitalDeliverySchema },

    // System message flags
    metadata: {
      isSystemMessage: { type: Boolean, default: false },
      actionRequired:  { type: Boolean, default: false },
      // AI seller-enquiry link: which product this DM was started about, so
      // "what did the bag seller say?" can resolve without asking for ids.
      productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Post' },
      source: { type: String, maxlength: 40 }
    }
  },
  {
    timestamps: true, // ← Adds createdAt + updatedAt, managed by Mongoose

    // Tell Mongoose not to create a version key (__v) — saves a byte per doc
    // and eliminates a write on every update.
    versionKey: false
  }
);

// ─── INDEXES ──────────────────────────────────────────────────────────────────
//
// Rule of thumb: index for your 3 hottest queries, nothing else.
// Every extra index = slower writes + more RAM used by mongod.
//
// HOT QUERY 1 — Load conversation thread (most frequent)
//   db.messages.find({ senderId, receiverId }).sort({ createdAt: -1 }).limit(30)
//   db.messages.find({ senderId: B, receiverId: A }).sort(...)  ← reverse direction too
//
//   One compound index covers BOTH directions because MongoDB can traverse it
//   in reverse. We include status to make unread-count a covered query.
messageSchema.index(
  { senderId: 1, receiverId: 1, createdAt: -1 },
  { name: 'conversation_thread' }
);

// HOT QUERY 2 — Inbox list: "all conversations involving user X, latest message each"
//   This query fans out (user is either sender or receiver), so we need
//   BOTH single-field indexes so the query planner can union them efficiently.
messageSchema.index(
  { receiverId: 1, createdAt: -1 },
  { name: 'inbox_received' }
);
messageSchema.index(
  { senderId: 1, createdAt: -1 },
  { name: 'inbox_sent' }
);

// HOT QUERY 3 — Unread badge count per user
//   PARTIAL index: only indexes documents where status != 'seen'.
//   Since the majority of messages eventually become 'seen', this index
//   stays small and the count query is near-instant.
messageSchema.index(
  { receiverId: 1, status: 1 },
  {
    name: 'unread_count',
    partialFilterExpression: { status: { $in: ['sent', 'delivered'] } }
  }
);

// SPARSE TTL — viewOnce cleanup, handled natively by MongoDB
//   MongoDB's TTL thread checks this every 60 seconds and removes expired docs.
//   sparse: true means only documents that HAVE a deleteAt field are indexed —
//   so 99% of normal messages don't bloat this index at all.
messageSchema.index(
  { 'viewOnce.deleteAt': 1 },
  {
    name:               'viewonce_ttl',
    expireAfterSeconds: 0, // delete exactly at the deleteAt timestamp
    sparse:             true
  }
);

// HOT QUERY 4 — Group thread: load messages for a group (cursor-paginated)
//   db.messages.find({ groupId }).sort({ createdAt: -1 }).limit(40)
//   sparse: true — only indexes documents where groupId exists (~0% of DMs).
messageSchema.index(
  { groupId: 1, createdAt: -1 },
  { name: 'group_thread', sparse: true }
);

// HOT QUERY 5 — Fetch all active group listings (for group shop view)
//   db.messages.find({ groupId, messageType: 'group-listing' })
messageSchema.index(
  { groupId: 1, messageType: 1, createdAt: -1 },
  { name: 'group_listings', sparse: true }
);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

const SYSTEM_MESSAGE_TYPES = new Set([
  'bargainStart',
  'end-bargain',
  'buyerAccept',
  'sellerAccept',
  'sellerDecline',
  'buyerDeclineResponse',
  'payment-completed'
]);

// Structured message types that carry their own content sub-doc instead of
// text or attachment. Exempt from the text/attachment requirement.
const STRUCTURED_MESSAGE_TYPES = new Set([
  'group-listing',
  'digital_delivery',
]);

// pre-validate: only run expensive checks on NEW documents or messageType changes.
// Status updates (read receipts) skip this entirely → sub-millisecond writes.
messageSchema.pre('validate', function (next) {
  // Skip validation logic if only status/viewOnce fields changed
  if (!this.isNew && !this.isModified('messageType') && !this.isModified('text') && !this.isModified('attachment')) {
    return next();
  }

  // Every message must target either a user (DM) or a group
  if (!this.receiverId && !this.groupId) {
    return next(new Error('Message must have either receiverId (DM) or groupId (group message)'));
  }

  if (SYSTEM_MESSAGE_TYPES.has(this.messageType)) {
    this.metadata.isSystemMessage = true;
    if (!this.offerDetails?.productId) {
      return next(new Error('System messages must include offerDetails.productId'));
    }
  } else if (STRUCTURED_MESSAGE_TYPES.has(this.messageType)) {
    // Structured messages carry a dedicated sub-doc (e.g. listing) instead of
    // plain text or an attachment — no further content check needed.
  } else if (!this.text && !this.attachment?.url) {
    return next(new Error('Non-system messages must have either text or an attachment'));
  }

  if (this.viewOnce?.enabled && this.messageType !== 'image') {
    return next(new Error('viewOnce can only be enabled for image messages'));
  }

  next();
});

// pre-save: set viewOnce TTL timestamps
messageSchema.pre('save', function (next) {
  if (!this.viewOnce?.enabled) return next();

  // New viewOnce image — set 24h hard expiry
  if (this.isNew && !this.viewOnce.deleteAt) {
    this.viewOnce.deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  // Viewed — collapse TTL to 5 minutes post-view so UI can show "viewed" briefly
  if (this.viewOnce.viewed && this.viewOnce.viewedAt && this.isModified('viewOnce.viewed')) {
    this.viewOnce.deleteAt = new Date(this.viewOnce.viewedAt.getTime() + 5 * 60 * 1000);
  }

  next();
});

// ─── STATIC HELPERS ───────────────────────────────────────────────────────────
//
// Centralise your hottest queries here so routes never guess at index hints.

/**
 * Load a conversation page (cursor-based, WhatsApp style).
 * Always uses the conversation_thread index.
 *
 * @param {ObjectId} userA
 * @param {ObjectId} userB
 * @param {Object}   opts  - { limit=30, before=Date } for cursor pagination
 */
messageSchema.statics.getConversation = function (userA, userB, { limit = 30, before } = {}) {
  const filter = {
    $or: [
      { senderId: userA, receiverId: userB },
      { senderId: userB, receiverId: userA }
    ]
  };
  if (before) filter.createdAt = { $lt: before };

  return this.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    // Only fetch fields the chat UI actually renders — skip heavy offerDetails
    // unless the messageType requires it
    .select('senderId receiverId text attachment status messageType offerDetails metadata viewOnce replyTo replyPreviewText replySenderName pttClip digital createdAt updatedAt')
    .lean(); // ← .lean() returns plain JS objects, ~3× faster than Mongoose docs
};

/**
 * Count unread messages for a user (hits the partial unread_count index).
 *
 * @param {ObjectId} userId
 */
messageSchema.statics.countUnread = function (userId) {
  return this.countDocuments({
    receiverId: userId,
    status:     { $in: ['sent', 'delivered'] }
  });
};

/**
 * Bulk-mark a conversation as seen (single updateMany, one index hit).
 *
 * @param {ObjectId} readerId   — the user who just opened the chat
 * @param {ObjectId} senderId   — the other party
 */
messageSchema.statics.markConversationSeen = function (readerId, senderId) {
  return this.updateMany(
    {
      senderId:   senderId,
      receiverId: readerId,
      status:     { $in: ['sent', 'delivered'] }
    },
    {
      $set: { status: 'seen', updatedAt: new Date() }
    }
  );
};

/**
 * Load a group message thread (cursor-based).
 * Hits the sparse group_thread index.
 *
 * @param {ObjectId} groupId
 * @param {Object}   opts  - { limit=40, before=Date }
 */
messageSchema.statics.getGroupThread = function (groupId, { limit = 40, before } = {}) {
  const filter = { groupId };
  if (before) filter.createdAt = { $lt: before };
  return this.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('senderId groupId text attachment status messageType listing metadata replyTo replyPreviewText replySenderName createdAt updatedAt')
    .lean();
};

module.exports = mongoose.model('Message', messageSchema);