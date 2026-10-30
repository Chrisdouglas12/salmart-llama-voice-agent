'use strict';

/**
 * services/ai/pendingFormPatch.js
 *
 * Durable one-shot buffer for the fill_* blocks the AI prepares. Persists a
 * patch in Mongo so a form screen that mounts LATER (after the user leaves AI
 * Mode) can drain it. Each patch is consumed exactly once; a screen that
 * mounts and drains a patch clears it here, so re-opening the form later does
 * not re-apply stale values.
 *
 * Design rules:
 *   - One active patch per (userId, target). A newer patch overwrites an older
 *     unconsumed one — the same "latest wins" contract the old AssistantContext
 *     adPatch had, but durable across app restarts.
 *   - TTL: 10 minutes. Long enough for the user to navigate back; short enough
 *     that a forgotten patch never surprises anyone.
 *   - Ownership is enforced at drain time: the drain endpoint requires auth
 *     and filters by req.userId, so a guessed target cannot read someone
 *     else's patch.
 */

const mongoose = require('mongoose');

const pendingFormPatchSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  target: {
    type: String,
    required: true,
    enum: ['createAd', 'createRequest', 'editProfile', 'register'],
    index: true,
  },
  fields: { type: mongoose.Schema.Types.Mixed, required: true },
  say: { type: String, default: null },
  conversationId: { type: String, default: null },
  requestId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  // TTL index — the mongoose driver removes expired rows automatically.
  expiresAt: { type: Date, index: { expires: 0 } },
});

// Compound uniqueness: one live patch per (user, target). Upsert on write
// keeps it to a single row without racing concurrent turns.
pendingFormPatchSchema.index({ userId: 1, target: 1 }, { unique: true });

const AIPendingFormPatch = mongoose.models.AIPendingFormPatch
  || mongoose.model('AIPendingFormPatch', pendingFormPatchSchema);

const TTL_MS = 10 * 60 * 1000;

/**
 * Upsert a patch for (userId, target). A newer patch overwrites an older
 * unconsumed one — matching the "latest wins" contract of the old assistant.
 */
async function enqueue({ userId, target, fields, say, conversationId, requestId }) {
  if (!userId || !target || !fields) throw new Error('enqueue: missing required field');
  const expiresAt = new Date(Date.now() + TTL_MS);
  return AIPendingFormPatch.findOneAndUpdate(
    { userId, target },
    {
      $set: { fields, say: say || null, conversationId: conversationId || null, requestId: requestId || null, createdAt: new Date(), expiresAt },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Atomically drain the patch for (userId, target). Returns the patch if it
 * existed and was not expired, otherwise null. A successful drain deletes the
 * row so the same patch is never applied twice.
 *
 * This is what the frontend hits when a form mounts and sees no fresh
 * fill_* block in the last turn response.
 */
async function drain({ userId, target }) {
  if (!userId || !target) return null;
  const doc = await AIPendingFormPatch.findOneAndDelete({
    userId,
    target,
    expiresAt: { $gt: new Date() },
  }).lean();
  return doc || null;
}

module.exports = { AIPendingFormPatch, enqueue, drain };