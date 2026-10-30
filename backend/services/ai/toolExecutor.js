'use strict';

/**
 * services/ai/toolExecutor.js
 *
 * Single choke-point for every tool invocation requested by the model.
 * See previous message for the full rationale; this file is unchanged from
 * the last delivery. Included here so the current state of the codebase is
 * in one message.
 */

const Ajv = require('ajv');
const { getTool } = require('./toolRegistry');
const pendingAction = require('./pendingAction');

const ajv = new Ajv({ allErrors: true, coerceTypes: true, strict: false });
const validatorCache = new Map();
function getValidator(tool) {
  if (!validatorCache.has(tool.name)) validatorCache.set(tool.name, ajv.compile(tool.inputSchema));
  return validatorCache.get(tool.name);
}

const TOOL_TIMEOUT_MS = 15_000;
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => {
      const e = new Error('Tool execution timed out'); e.code = 'TOOL_TIMEOUT'; rej(e);
    }, ms)),
  ]);
}

function describePendingAction(toolName, args) {
  switch (toolName) {
    case 'updateProductPrice':
      return {
        summary: `Change the price of listing ${args.productId} to ₦${Number(args.newPrice).toLocaleString('en-NG')}.`,
        preview: { kind: 'price_change', productId: args.productId, newPrice: args.newPrice },
      };
    case 'sendSellerEnquiry':
      return {
        summary: `Send this message to the seller: "${String(args.body).slice(0, 200)}"`,
        preview: {
          kind: 'message_to_seller',
          productId: args.productId,
          sellerId: args.sellerId,
          body: String(args.body).slice(0, 500),
        },
      };
    case 'publishProductListing':
      return { summary: 'Publish the draft listing.', preview: { kind: 'publish_listing' } };
    default:
      return { summary: `Run ${toolName}.`, preview: null };
  }
}

async function execute(ctx, toolName, rawArgs) {
  const tool = getTool(toolName);
  if (!tool) return { ok: false, code: 'TOOL_UNKNOWN', error: `Unknown tool "${toolName}".` };
  if (tool.requiresAuth && !ctx.isAuthenticated) return { ok: false, code: 'AUTH_REQUIRED', error: 'Sign in first.' };
  if (!tool.wired) return { ok: false, code: 'TOOL_NOT_AVAILABLE', error: 'That action is not available yet.' };

  const validate = getValidator(tool);
  const args = rawArgs ?? {};
  if (!validate(args)) {
    return {
      ok: false, code: 'TOOL_BAD_ARGS',
      error: `Invalid arguments for ${toolName}.`,
      details: validate.errors?.slice(0, 5).map(e => ({ path: e.instancePath, msg: e.message })),
    };
  }

  const safeArgs = { ...args };
  delete safeArgs.userId;
  // sendSellerEnquiry legitimately needs the sellerId it was prepared with.
  // Every other tool must never receive an owner/seller id from the model.
  if (tool.name !== 'sendSellerEnquiry') {
    delete safeArgs.sellerId;
  }

  if (tool.requiresConfirmation) {
    if (!ctx.conversationId) {
      return {
        ok: false, code: 'CONFIRMATION_UNAVAILABLE',
        error: 'Confirmation flow requires an active conversation.',
      };
    }
    const { summary, preview } = describePendingAction(toolName, safeArgs);
    const doc = await pendingAction.create({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      toolName,
      args: safeArgs,
      summary,
      preview,
    });
    return {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      error: summary,
      actionId: doc.actionId,
      summary,
      preview,
      toolName,
    };
  }

  try {
    const data = await withTimeout(Promise.resolve(tool.handler(ctx, safeArgs)), TOOL_TIMEOUT_MS);
    return { ok: true, data };
  } catch (err) {
    if (err.code === 'TOOL_NOT_WIRED') return { ok: false, code: 'TOOL_NOT_AVAILABLE', error: 'Not available yet.' };
    if (err.code === 'TOOL_BAD_ARGS')   return { ok: false, code: 'TOOL_BAD_ARGS',   error: err.message };
    if (err.code === 'FORBIDDEN')       return { ok: false, code: 'FORBIDDEN',       error: err.message };
    if (err.code === 'AUTH_REQUIRED')   return { ok: false, code: 'AUTH_REQUIRED',   error: err.message };
    ctx.logger?.warn?.(`[toolExecutor] ${toolName}: ${err.code || err.name}: ${err.message}`);
    return { ok: false, code: err.code || 'TOOL_FAILED', error: 'Could not complete that. Please try again.' };
  }
}

async function executeConfirmed({ ctx, actionId }) {
  const doc = await pendingAction.find(actionId);
  if (!doc) return { ok: false, code: 'NOT_FOUND' };
  if (String(doc.userId) !== String(ctx.userId)) return { ok: false, code: 'FORBIDDEN' };

  const tool = getTool(doc.toolName);
  if (!tool || !tool.wired) return { ok: false, code: 'TOOL_NOT_AVAILABLE' };
  if (!tool.requiresConfirmation) {
    return { ok: false, code: 'BAD_STATE' };
  }

  const validate = getValidator(tool);
  if (!validate(doc.args)) {
    return { ok: false, code: 'TOOL_BAD_ARGS', error: 'The action is no longer valid.' };
  }

  try {
    const data = await withTimeout(
      Promise.resolve(tool.handler(ctx, doc.args)),
      TOOL_TIMEOUT_MS
    );
    return { ok: true, data };
  } catch (err) {
    if (err.code === 'TOOL_NOT_WIRED') return { ok: false, code: 'TOOL_NOT_AVAILABLE', error: 'Not available yet.' };
    if (err.code === 'TOOL_BAD_ARGS')   return { ok: false, code: 'TOOL_BAD_ARGS',   error: err.message };
    if (err.code === 'FORBIDDEN')       return { ok: false, code: 'FORBIDDEN',       error: err.message };
    if (err.code === 'AUTH_REQUIRED')   return { ok: false, code: 'AUTH_REQUIRED',   error: err.message };
    ctx.logger?.warn?.(`[toolExecutor.confirm] ${doc.toolName}: ${err.code || err.name}: ${err.message}`);
    return { ok: false, code: err.code || 'TOOL_FAILED', error: 'Could not complete that. Please try again.' };
  }
}

module.exports = { execute, executeConfirmed };