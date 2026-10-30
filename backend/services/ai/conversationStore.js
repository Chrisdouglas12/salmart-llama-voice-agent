'use strict';

/**
 * services/ai/conversationStore.js
 *
 * Persistent AI conversation state. Backed by the AIConversation model.
 * Bound to either a userId (authenticated) or an anonymousId (pre-auth).
 *
 * Ownership rules:
 *   - A conversation with a userId may only be opened by that userId.
 *   - A conversation with only an anonymousId may only be opened by the
 *     client that holds that anonymousId.
 *   - `rebindToUser` transitions an anonymous conversation into an
 *     authenticated one, but only when the caller can prove possession of
 *     the original anonymousId AND the conversation is still anonymous.
 *     This is the ONLY path that flips ownership, and it is one-way.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const messageSchema = new mongoose.Schema({
  role:       { type: String, enum: ['user', 'assistant', 'tool', 'system'], required: true },
  content:    { type: String, default: '' },
  toolCalls:  { type: Array, default: undefined },
  toolCallId: { type: String, default: undefined },
  name:       { type: String, default: undefined },
  at:         { type: Date, default: Date.now },
}, { _id: false });

const aiConversationSchema = new mongoose.Schema({
  conversationId:  { type: String, required: true, unique: true, index: true },
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  anonymousId:     { type: String, default: null, index: true },
  messages:        { type: [messageSchema], default: [] },
  currentTask:     { type: String, default: null },
  collectedInfo:   { type: mongoose.Schema.Types.Mixed, default: {} },
  pendingActionId: { type: String, default: null, index: true },
  status:          { type: String, enum: ['active', 'awaiting_confirmation', 'completed', 'expired'], default: 'active' },
  createdAt:       { type: Date, default: Date.now },
  updatedAt:       { type: Date, default: Date.now },
  expiresAt:       { type: Date, index: { expires: 0 } },
});

aiConversationSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  if (!this.expiresAt) {
    const days = this.userId ? 30 : 1;
    this.expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
  next();
});

const AIConversation = mongoose.models.AIConversation
  || mongoose.model('AIConversation', aiConversationSchema);

// ── Store API ────────────────────────────────────────────────────────────────

/**
 * Get or create a conversation.
 *
 * Returns:
 *   { created: true, doc }
 *   { created: false, doc }
 *   { created: false, doc: null, forbidden: true }
 *   { created: false, doc: null }
 *
 * `forbidden` and `not found` are indistinguishable to the caller by design.
 */
async function getOrCreate({ conversationId, userId, anonymousId }) {
  if (conversationId) {
    const existing = await AIConversation.findOne({ conversationId });
    if (!existing) return { created: false, doc: null };

    if (existing.userId) {
      if (String(existing.userId) !== String(userId)) {
        return { created: false, doc: null, forbidden: true };
      }
      return { created: false, doc: existing };
    }

    // Anonymous conversation — requires the exact anonymousId issued when it
    // was created. If the caller omits it, refuse: otherwise a guessed
    // conversationId alone would open someone else's conversation. An
    // authenticated caller must use rebindToUser (below) after auth.
    if (existing.anonymousId) {
      if (!anonymousId || existing.anonymousId !== anonymousId) {
        return { created: false, doc: null, forbidden: true };
      }
    }

    return { created: false, doc: existing };
  }

  const doc = await AIConversation.create({
    conversationId: crypto.randomUUID(),
    userId: userId || null,
    anonymousId: userId ? null : (anonymousId || crypto.randomUUID()),
  });
  return { created: true, doc };
}

async function appendMessages(conversationId, msgs) {
  await AIConversation.updateOne(
    { conversationId },
    { $push: { messages: { $each: msgs } }, $set: { updatedAt: new Date() } }
  );
}

async function setTask(conversationId, { currentTask, collectedInfo, pendingActionId, status }) {
  const patch = { updatedAt: new Date() };
  if (currentTask !== undefined)     patch.currentTask = currentTask;
  if (collectedInfo !== undefined)   patch.collectedInfo = collectedInfo;
  if (pendingActionId !== undefined) patch.pendingActionId = pendingActionId;
  if (status !== undefined)          patch.status = status;
  await AIConversation.updateOne({ conversationId }, { $set: patch });
}

/**
 * Mark the stored task after a confirm/cancel outcome. The conversation
 * `status` enum only knows active/awaiting_confirmation/completed/expired, so a
 * cancelled task returns to `active` while the task object keeps the reason.
 */
async function setTaskStatus(conversationId, taskStatus) {
  if (!conversationId) return;
  const conversationStatus = taskStatus === 'completed' ? 'completed' : 'active';
  await AIConversation.updateOne(
    { conversationId },
    {
      $set: {
        status: conversationStatus,
        'collectedInfo.task.status': taskStatus,
        'collectedInfo.task.updatedAt': Date.now(),
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * rebindToUser — transition an anonymous conversation into an authenticated
 * one. Called by the frontend after successful sign-in, with:
 *   - conversationId: the anonymous conversation's id
 *   - anonymousId:    the same value the client received when creating it
 *   - userId:         the newly authenticated user (from trusted JWT)
 *
 * Enforced invariants:
 *   - The conversation MUST currently be anonymous (userId === null).
 *   - The anonymousId MUST match the one stored — no one can rebind a
 *     conversation they didn't create.
 *   - After rebinding, `anonymousId` is cleared. The conversation becomes
 *     addressable only by the userId.
 *   - Rebinding is one-way: an authenticated conversation cannot be rebound
 *     to a different user. If that ever needs to happen it is a delete +
 *     create, not a rebind — and it should be a deliberate product decision,
 *     not a side effect of a race.
 *
 * Returns:
 *   { ok: true, doc }
 *   { ok: false, reason: 'not_found' }
 *   { ok: false, reason: 'anonymous_id_mismatch' }
 *   { ok: false, reason: 'already_authenticated', doc }
 */
async function rebindToUser({ conversationId, anonymousId, userId }) {
  if (!conversationId || !anonymousId || !userId) {
    return { ok: false, reason: 'bad_args' };
  }

  // findOneAndUpdate is atomic. The query conditions encode the invariants,
  // so two concurrent rebind calls cannot both succeed.
  const doc = await AIConversation.findOneAndUpdate(
    {
      conversationId,
      anonymousId,
      userId: null,
    },
    {
      $set: { userId, anonymousId: null, updatedAt: new Date() },
    },
    { new: true }
  );

  if (doc) return { ok: true, doc };

  // Distinguish the failure cases for the caller without leaking whether the
  // conversation exists. Both `not_found` and `anonymous_id_mismatch` return
  // 404 to the client; the distinction is only for our logs.
  const existing = await AIConversation.findOne({ conversationId }).lean();
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.userId) {
    if (String(existing.userId) === String(userId)) {
      return { ok: false, reason: 'already_authenticated', doc: existing };
    }
    return { ok: false, reason: 'not_found' };
  }
  if (existing.anonymousId !== anonymousId) {
    return { ok: false, reason: 'anonymous_id_mismatch' };
  }
  return { ok: false, reason: 'not_found' };
}

module.exports = {
  AIConversation,
  getOrCreate,
  appendMessages,
  setTask,
  setTaskStatus,
  rebindToUser,
};