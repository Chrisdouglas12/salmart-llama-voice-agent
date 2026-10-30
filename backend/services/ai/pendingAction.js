'use strict';

/**
 * services/ai/pendingAction.js
 *
 * Persists consequential actions the model has proposed but the user has not
 * confirmed. The confirm/cancel endpoints are the ONLY way a pending action
 * can run — the model literally has no other path, because the executor
 * refuses to run requiresConfirmation tools inline (see toolExecutor.js).
 *
 * Security invariants enforced here:
 *   - Pending action is bound to userId (conversationId is recorded for
 *     context); confirm must match the owning user. A foreign action is
 *     indistinguishable from a missing one.
 *   - Payload is a JSON snapshot of toolName + args at prepare time. It is
 *     never re-read from the model.
 *   - Confirm revalidates auth AND current resource state; if the world has
 *     changed (listing deleted, price already different), the confirm is
 *     rejected with a clear reason instead of executing against stale intent.
 *   - Cancel is idempotent — a second cancel on a cancelled record is a no-op.
 *   - Expiry: TTL index; a confirmed/cancelled record is kept for audit but
 *     cannot be replayed (state transitions are one-way).
 */

const mongoose = require('mongoose');

const pendingActionSchema = new mongoose.Schema({
  actionId: { type: String, required: true, unique: true, index: true },
  conversationId: { type: String, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  toolName: { type: String, required: true },
  // The exact args the model produced at PREPARE time. Never mutated after.
  args: { type: mongoose.Schema.Types.Mixed, required: true },
  // Human-readable summary shown to the user before they confirm.
  summary: { type: String, required: true },
  // Structured preview for the frontend (e.g. old/new price, target product).
  preview: { type: mongoose.Schema.Types.Mixed, default: null },
  state: {
    type: String,
    enum: ['pending', 'executing', 'executed', 'failed', 'cancelled', 'expired'],
    default: 'pending',
    index: true,
  },
  // Result of the actual tool execution (only set on executed/failed).
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  // Set atomically when confirm starts — ensures double-confirm cannot race.
  executionLockedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  // 10-minute TTL for `pending` records. Executed/cancelled records also
  // expire (30 days) so we do not keep state around forever — but they are
  // distinct documents so the audit trail is retained if you choose to
  // disable auto-expiry later.
  expiresAt: { type: Date, index: { expires: 0 } },
});

const AIPendingAction = mongoose.models.AIPendingAction
  || mongoose.model('AIPendingAction', pendingActionSchema);

const PENDING_TTL_MS = 10 * 60 * 1000;

const crypto = require('crypto');

async function create({ conversationId, userId, toolName, args, summary, preview }) {
  const actionId = crypto.randomUUID();
  const doc = await AIPendingAction.create({
    actionId,
    conversationId,
    userId,
    toolName,
    args,
    summary,
    preview: preview || null,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
  });
  return doc;
}

/**
 * Atomically transition pending → executing. If another request already
 * claimed it (double-tap on confirm), returns null and the caller sends 409.
 */
async function claim(actionId, userId) {
  return AIPendingAction.findOneAndUpdate(
    { actionId, userId, state: 'pending', expiresAt: { $gt: new Date() } },
    { $set: { state: 'executing', executionLockedAt: new Date() } },
    { new: true }
  );
}

async function finish(actionId, { state, result }) {
  return AIPendingAction.findOneAndUpdate(
    { actionId },
    { $set: { state, result: result || null, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } },
    { new: true }
  );
}

/**
 * Cancel is idempotent: cancelling an already-cancelled action is a no-op
 * success, cancelling an executed one is a conflict (the caller learns the
 * truth instead of a silent no-op).
 */
async function cancel(actionId, userId) {
  const doc = await AIPendingAction.findOne({ actionId, userId });
  if (!doc) return { ok: false, code: 'NOT_FOUND' };
  if (doc.state === 'cancelled') return { ok: true, alreadyCancelled: true };
  if (doc.state === 'executed' || doc.state === 'executing') {
    return { ok: false, code: 'ALREADY_EXECUTED' };
  }
  await AIPendingAction.updateOne(
    { actionId, state: { $in: ['pending', 'failed'] } },
    { $set: { state: 'cancelled', expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } }
  );
  return { ok: true };
}

async function find(actionId) {
  return AIPendingAction.findOne({ actionId }).lean();
}

module.exports = { AIPendingAction, create, claim, finish, cancel, find };