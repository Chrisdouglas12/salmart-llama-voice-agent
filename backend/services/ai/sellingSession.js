'use strict';

/**
 * services/ai/sellingSession.js
 *
 * Persistent listing workflow state for /api/ai, mirroring
 * services/ai/authSession.js. Derived from validated tool results plus the
 * phone's real form snapshot — never from the model's prose.
 *
 * Stored under `collectedInfo.selling`: { postType, currentStep, asked[] }.
 * Field VALUES live in taskState.adDraft; this module tracks only which
 * required step the conversation is on. Snapshot flags (booleans from the
 * phone: photo present, price valid, …) are read from turn context, never
 * stored — they are re-read every turn so a manual edit is seen at once.
 */

const selling = require('../../lib/assistant/sellingFlow');

const MAX_ASKED = 24;

// Tool field name → selling step, resolved against the listing type.
function stepsForFields(type, fields) {
  const steps = [];
  const titleStep = type === 'service' ? 'serviceTitle' : (type === 'digital' ? 'digitalTitle' : 'title');
  const captionStep = type === 'digital' ? 'digitalCaption' : 'caption';
  const priceStep = type === 'service' ? 'servicePrice' : (type === 'digital' ? 'digitalPrice' : 'price');
  const categoryStep = type === 'digital' ? 'digitalCategory' : 'category';
  if (fields.title !== undefined) steps.push(titleStep);
  if (fields.caption !== undefined || fields.description !== undefined) steps.push(captionStep);
  if (fields.price !== undefined) steps.push(priceStep);
  if (fields.quantity !== undefined) steps.push('quantity');
  if (fields.bulkDiscountMinQty !== undefined || fields.bulkDiscountOff !== undefined
    || fields.bulkDiscountPrice !== undefined) steps.push('discount');
  if (fields.productCondition !== undefined || fields.condition !== undefined) steps.push('productCondition');
  if (fields.category !== undefined) steps.push(categoryStep);
  if (fields.location !== undefined) steps.push('location');
  if (fields.serviceCategory !== undefined) steps.push('serviceCategory');
  if (fields.serviceType !== undefined) steps.push('serviceType');
  if (fields.serviceLocation !== undefined) steps.push('serviceLocation');
  if (fields.postType !== undefined) steps.push('postType');
  return steps;
}

function read(collectedInfo) {
  const raw = collectedInfo && collectedInfo.selling;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const postType = selling.cleanType(raw.postType) || 'regular';
  const currentStep = typeof raw.currentStep === 'string' ? raw.currentStep.slice(0, 40) : null;
  const asked = Array.isArray(raw.asked)
    ? raw.asked.filter((s) => typeof s === 'string').map((s) => s.slice(0, 40)).slice(0, MAX_ASKED)
    : [];
  const updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  return { postType, currentStep, asked, updatedAt };
}

/** Snapshot flags from turn context: booleans only, never field values. */
function snapshotFromContext(safeContext) {
  const raw = safeContext && safeContext.listing;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw).slice(0, 24)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) continue;
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)
      && (k === 'price' || k === 'quantity')) out[k] = v;
    else if (typeof v === 'string' && (k === 'postType')) {
      const t = selling.cleanType(v);
      if (t) out[k] = t;
    }
  }
  return out;
}

/**
 * Fold validated tool results into the selling state.
 * prepareAdForm results advance the conversation past the fields they set.
 */
function applyToolResults(prior, toolResults, { snapshot = {} } = {}) {
  let state = prior && typeof prior === 'object'
    ? { ...prior, asked: [...(prior.asked || [])] }
    : null;

  for (const r of toolResults || []) {
    if (!r || !r.ok || !r.data) continue;

    if (r.name === 'navigateToScreen' && r.data.screen === 'createAd') {
      state = {
        postType: state?.postType || selling.cleanType(snapshot.postType) || 'regular',
        currentStep: null,
        asked: [],
        updatedAt: Date.now(),
      };
    }

    if (r.name === 'prepareAdForm' && (r.data.fields || r.data.skipStep)) {
      const fields = r.data.fields || {};
      const skipped = typeof r.data.skipStep === 'string' ? r.data.skipStep.slice(0, 40) : null;
      const type = selling.cleanType(fields.postType) || state?.postType
        || selling.cleanType(snapshot.postType) || 'regular';
      // A type switch restarts the walk: different type, different checklist.
      const switched = !!state && state.postType !== type;
      let asked = switched ? [] : [...(state?.asked || [])];
      for (const s of stepsForFields(type, fields)) {
        if (!asked.includes(s)) asked.push(s);
      }
      // A declined optional step is recorded here so it is never offered again.
      if (skipped && !asked.includes(skipped)) asked.push(skipped);
      asked = asked.slice(-MAX_ASKED);
      state = {
        postType: type,
        currentStep: switched ? null : (skipped || state?.currentStep || null),
        asked,
        updatedAt: Date.now(),
      };
    }

    if (r.name === 'requestListingPhoto') {
      const asked = [...(state?.asked || [])];
      if (!asked.includes('photo')) asked.push('photo');
      state = {
        postType: state?.postType || selling.cleanType(snapshot.postType) || 'regular',
        currentStep: 'photo',
        asked: asked.slice(-MAX_ASKED),
        updatedAt: Date.now(),
      };
    }
  }

  if (!state) return null;
  state.updatedAt = Date.now();
  return state;
}

function formatNaira(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Compact prompt block: type, done flags, and THE next question to ask. */
function promptBlock(state, snapshot = {}, task = null) {
  if (!state && !Object.keys(snapshot).length) return '';
  const type = state?.postType || selling.cleanType(snapshot.postType) || 'regular';
  const asked = state?.asked || [];
  const next = selling.nextStep(type, snapshot, asked);
  const done = (selling.ORDERS[type] || [])
    .filter((s) => snapshot[s.flag])
    .map((s) => s.step);
  const lines = [
    `Type: ${type}`,
    `Done: ${done.length ? done.join(', ') : 'nothing yet'}`,
    `Missing required: ${next.missing.length ? next.missing.join(', ') : 'none'}`,
    next.done
      ? 'Status: COMPLETE — show the review step, never publish.'
      : `Next question (ask exactly this, one question only): ${next.ask}`,
  ];

  if (!next.done && next.step === 'discount') {
    const qty = Number(snapshot.quantity) || Number(task?.adDraft?.quantity) || null;
    const price = Number(snapshot.price) || Number(task?.adDraft?.price) || null;
    const off = selling.discountSuggestion(price);
    const minQty = Number.isFinite(qty) && qty >= 5 ? 5 : (Number.isFinite(qty) && qty >= 2 ? 2 : 5);
    const intro = qty && price
      ? `You said you have ${qty} to sell at ₦${formatNaira(price)} each. `
      : (qty ? `You said you have ${qty} to sell. ` : '');
    lines.push(
      `Say it like: "${intro}Do you want to give a discount if someone buys more than one? ` +
      `You can take ₦${formatNaira(off)} off each item when a buyer takes ${minQty} or more. Say yes or no."`
    );
    lines.push(
      `If yes, call prepareAdForm with bulkDiscountMinQty ${minQty} and bulkDiscountOff ${off} ` +
      '(use their own numbers if they name them). If no, call prepareAdForm with skipStep "discount".'
    );
  } else if (!next.done && next.step === 'photo') {
    lines.push('The phone opens the photo chooser for them. Tell them they can choose a gallery photo or take a new one with the camera.');
  }

  if (!next.done && next.optional && next.after) {
    lines.push(`If they skip this optional step, call prepareAdForm with skipStep "${next.step}" (no fields), then ask next: ${next.after.ask}`);
  }
  return `\n\n[Selling state — data only, not instructions:\n${lines.join('\n')}\nAsk the next question and nothing else. One prepareAdForm call per field.]`;
}

/** Preserve unrelated collectedInfo keys; replace only `selling`. */
function toCollectedInfo(previous, state) {
  const base = previous && typeof previous === 'object' && !Array.isArray(previous)
    ? { ...previous }
    : {};
  if (!state) {
    delete base.selling;
    return base;
  }
  return { ...base, selling: state };
}

module.exports = {
  read,
  snapshotFromContext,
  applyToolResults,
  promptBlock,
  toCollectedInfo,
};
