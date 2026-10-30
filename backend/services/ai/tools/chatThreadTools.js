'use strict';

/**
 * services/ai/tools/chatThreadTools.js
 *
 * Read-only seller-thread summary for "what did the seller say?".
 * Loads the last messages with the given partner via Message.getConversation
 * and returns a compact, chronological digest the model can summarise in
 * plain words (typos and all). Never returns other users' threads.
 */

const mongoose = require('mongoose');
const Message = require('../../../models/messageSchema');

const MAX_SNIPPET = 280;

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET);
}

async function getSellerThread(ctx, { partnerId, limit }) {
  if (!ctx.userId) {
    const e = new Error('Sign in to read your chats.'); e.code = 'AUTH_REQUIRED'; throw e;
  }
  if (!mongoose.Types.ObjectId.isValid(partnerId)) {
    const e = new Error('Invalid partnerId.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }
  if (String(partnerId) === String(ctx.userId)) {
    const e = new Error('That conversation is with yourself.'); e.code = 'TOOL_BAD_ARGS'; throw e;
  }
  const n = Math.min(Math.max(Number(limit) || 15, 1), 15);
  const rows = await Message.getConversation(ctx.userId, partnerId, { limit: n });
  // getConversation returns newest-first; flip to chronological for the model.
  const ordered = (Array.isArray(rows) ? rows : []).slice().reverse();
  // Split by author. Only sellerMessages are the seller's own words — the
  // model must never read the buyer's messages back as if the seller said
  // them (that was a real, confusing bug). myMessages is context only.
  const shape = (m) => ({
    text: snippet(m.text),
    hasImage: m.messageType === 'image' || !!m.attachment?.url,
    hasOffer: typeof m.offerDetails?.proposedPrice === 'number',
    proposedPrice: typeof m.offerDetails?.proposedPrice === 'number'
      ? m.offerDetails.proposedPrice : null,
    at: m.createdAt || null,
  });
  const sellerMessages = ordered
    .filter(m => String(m.senderId) !== String(ctx.userId))
    .map(shape);
  const myMessages = ordered
    .filter(m => String(m.senderId) === String(ctx.userId))
    .map(shape);

  return {
    found: true,
    partnerId: String(partnerId),
    count: ordered.length,
    hasSellerReply: sellerMessages.length > 0,
    sellerMessageCount: sellerMessages.length,
    myMessageCount: myMessages.length,
    sellerMessages,
    myMessages,
    note: sellerMessages.length
      ? 'Only sellerMessages are the seller\'s words. Summarise those in one or two short sentences, key fact first. myMessages is what the buyer wrote — never present it as the seller\'s reply.'
      : 'The seller has not replied yet — only the buyer has written. Say that plainly, never invent a reply.',
  };
}

module.exports = { getSellerThread, findSellerThreads, summarizeSellerReplies };

/**
 * Global resolver for "that person we chatted about the bag, what did they
 * say?". Lists the caller's recent DM partners (newest first) with the last
 * message snippet, direction, unread count guess, and any linked AI-enquiry
 * product. The model matches by product/task memory, then calls
 * getSellerThread for the full summary. Read-only, own threads only.
 */
async function findSellerThreads(ctx, { limit } = {}) {
  if (!ctx.userId) {
    const e = new Error('Sign in to read your chats.'); e.code = 'AUTH_REQUIRED'; throw e;
  }
  const n = Math.min(Math.max(Number(limit) || 10, 1), 10);
  const me = new mongoose.Types.ObjectId(ctx.userId);
  const recent = await Message.find({
    $or: [{ senderId: me }, { receiverId: me }],
    groupId: { $exists: false },
  })
    .sort({ createdAt: -1 })
    .limit(60)
    .select('senderId receiverId text messageType attachment createdAt metadata')
    .lean();

  const byPartner = new Map();
  for (const m of recent) {
    const other = String(m.senderId) === String(ctx.userId)
      ? String(m.receiverId) : String(m.senderId);
    if (!other || other === 'undefined') continue;
    if (!byPartner.has(other)) {
      byPartner.set(other, {
        partnerId: other,
        lastDirection: String(m.senderId) === String(ctx.userId) ? 'me' : 'seller',
        lastText: snippet(m.text),
        lastHasImage: m.messageType === 'image' || !!m.attachment?.url,
        lastAt: m.createdAt || null,
        productId: m.metadata?.productId ? String(m.metadata.productId) : null,
        messageCount: 1,
      });
    } else {
      const e = byPartner.get(other);
      e.messageCount += 1;
      if (!e.productId && m.metadata?.productId) e.productId = String(m.metadata.productId);
    }
    if (byPartner.size >= n && [...byPartner.values()].every(v => v.messageCount > 1)) break;
  }
  const threads = [...byPartner.values()].slice(0, n);

  // Attach names + product titles/categories for the model to match against.
  const User = require('../../../models/userSchema');
  const Post = require('../../../models/postSchema');
  await Promise.all(threads.map(async (t) => {
    try {
      const u = await User.findById(t.partnerId).select('firstName lastName').lean();
      if (u) t.sellerName = `${u.firstName || ''} ${u.lastName || ''}`.trim() || null;
    } catch (_e) { /* name stays missing */ }
    if (t.productId) {
      try {
        const p = await Post.findById(t.productId).select('title price category').lean();
        if (p) { t.productTitle = p.title || null; t.productPrice = p.price ?? null; t.productCategory = p.category || null; }
      } catch (_e) { /* title stays missing */ }
    }
  }));

  return {
    found: true,
    count: threads.length,
    threads,
    note: threads.length
      ? 'Match by product title/task memory, then call getSellerThread for the full thread.'
      : 'No chats yet.',
  };
}

function keywords(raw) {
  const words = String(raw || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  // Very light plural handling: "bags" should match a chat that says "bag".
  const out = new Set(words);
  for (const w of words) {
    if (w.length > 3 && w.endsWith('s')) out.add(w.slice(0, -1));
  }
  return [...out];
}

/**
 * Multi-seller digest for "what did the bag sellers say?". Fully dynamic —
 * works for any item, not just bags. Matches `about` against each thread's
 * linked product AND the words used inside the thread, so chats started by
 * hand (no product link) still match. Reports per seller: the seller's own
 * reply lines, or "has not replied yet". Never includes the buyer's messages.
 * Read-only, own threads only.
 */
async function summarizeSellerReplies(ctx, { about, limit } = {}) {
  if (!ctx.userId) {
    const e = new Error('Sign in to read your chats.'); e.code = 'AUTH_REQUIRED'; throw e;
  }
  const n = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const listed = await findSellerThreads(ctx, { limit: 10 });
  const threads = listed.threads || [];
  const words = keywords(about);
  const wantsItem = words.length > 0;

  // Load each candidate thread once, then use the same rows for matching and
  // for the digest so the item can be recognised from what was actually said.
  const loaded = [];
  for (const t of threads) {
    const rows = await Message.getConversation(ctx.userId, t.partnerId, { limit: 20 });
    const ordered = (Array.isArray(rows) ? rows : []).slice().reverse();
    const sellerMsgs = ordered.filter(m => String(m.senderId) !== String(ctx.userId));
    const myMsgs = ordered.filter(m => String(m.senderId) === String(ctx.userId));
    loaded.push({ t, ordered, sellerMsgs, myMsgs });
  }

  let candidates = loaded;
  if (wantsItem) {
    candidates = loaded
      .map((row) => {
        // Match the item anywhere in the thread — the buyer usually names it.
        const hay = [
          row.t.productTitle || '',
          row.t.productCategory || '',
          ...row.ordered.map(m => m.text || ''),
        ].join(' ').toLowerCase();
        const hits = words.filter(w => hay.includes(w)).length;
        return { row, hits };
      })
      .filter(s => s.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .map(s => s.row);
  }
  candidates = candidates.slice(0, n);

  const sellers = candidates.map(({ t, sellerMsgs }) => {
    const lastSeller = sellerMsgs[sellerMsgs.length - 1] || null;
    const lines = sellerMsgs.slice(-4).map(m => snippet(m.text)).filter(Boolean);
    return {
      partnerId: t.partnerId,
      sellerName: t.sellerName || null,
      productTitle: t.productTitle || null,
      productPrice: t.productPrice ?? null,
      replied: sellerMsgs.length > 0,
      sellerMessageCount: sellerMsgs.length,
      sellerLines: lines,
      lastSellerText: lastSeller ? snippet(lastSeller.text) : null,
      lastSellerHasOffer: lastSeller
        ? typeof lastSeller.offerDetails?.proposedPrice === 'number' : false,
      lastSellerPrice: lastSeller?.offerDetails?.proposedPrice ?? null,
      lastSellerAt: lastSeller?.createdAt || null,
    };
  });

  // An item was asked for but nothing matched: say so plainly instead of
  // dumping unrelated chats (which is how the assistant used to read back
  // the buyer's own words from a different thread).
  if (wantsItem && sellers.length === 0) {
    return {
      found: true,
      about: String(about || '').slice(0, 120),
      matched: false,
      count: 0,
      repliedCount: 0,
      sellers: [],
      note: `No chat matched "${String(about).slice(0, 60)}". Say plainly you could not find a chat about that item, then ask which item or seller they mean. Do not summarise unrelated chats and never repeat the buyer's own words as a reply.`,
    };
  }

  return {
    found: true,
    about: String(about || '').slice(0, 120) || null,
    matched: !wantsItem || sellers.length > 0,
    count: sellers.length,
    repliedCount: sellers.filter(s => s.replied).length,
    sellers,
    note: sellers.length
      ? 'Only sellerLines/lastSellerText are the sellers\' words. Summarise per seller in short sentences: who replied with what key fact, and name plainly whoever has not replied yet. Never invent replies.'
      : 'No chats yet — say so plainly.',
  };
}
