/* ------------------------------------------------------------------
 * Salmart Intelligence task planning helpers (Phase 3: multi-turn task state).
 *
 * The ReAct tool loop stays in routes/assistantRoutes.js. Multi-turn memory
 * lives here, dependency-free, so the planning layer can be unit-tested
 * standalone (backend/tests/agent-tasks.test.js) without Mongo or providers.
 *
 * A task is { goal, adDraft, lastSearch, updatedAt }. Turns append to it;
 * corrections patch it; a scope change ("forget the shoes, sell a blender
 * instead") resets it. Nothing here touches the network or the database.
 * ------------------------------------------------------------------ */

const TASK_TTL_MS = 30 * 60 * 1000;

/* Signals that the previous objective is dead and a new task begins.
 * Kept narrow on purpose: "instead" alone is too broad, so the blender
 * pattern requires "sell <x> instead". Bare price talk ("make it 70k")
 * must NEVER match — that is a correction, not a reset. */
const SCOPE_RESET_RX = /\b(forget (it|this|that|them|about .+|everything)|never ?mind|start over|scratch that|change of plan|different item|sell .+ instead|not (that|this).*(any ?more|anymore))\b/i;

function scopeResetDetected(text) {
  return SCOPE_RESET_RX.test(String(text || ''));
}

/* Flow-aware listening: the AI must follow a new request instead of
 * replaying an unfinished task the user walked away from. Each flow owns its
 * screens and drafts (selling→createAd/adDraft, registration→register,
 * request→createRequest, profile→editProfile, buying→market/search/pick).
 * A message that clearly starts a different flow than the stored task resets
 * the task — unless it reads as a continuation of the old one (a correction,
 * a yes/no answer, or a detail like "make it seventy thousand"). */
const FLOW_INTENT_RX = {
  selling: /\b(sell|advertise|advert|post (an? )?(ad|listing)|create (an? )?(ad|listing)|my (ads?|listings?))\b/i,
  buying: /\b(buy|search|find|looking for|how much|order|checkout|cart|my orders?)\b/i,
  registration: /\b(register|sign ?up|create (an? )?account|get started|i'?m new)\b/i,
  request: /\b(request|i need (a|an|someone)|find (me )?(someone|a (vendor|plumber|tailor|driver|caterer)))\b/i,
  profile: /\b(my profile|edit (my )?profile|change my name|my bio)\b/i,
};

// Continuations of the current task, never a new request on their own.
const CONTINUATION_RX = /\b(make it|change .* to|no,? (it'?s|that)|yes|yeah|yep|correct|same (one|item)|that one|chat (him|her|them|seller)|save it|add .*cart|more|less|fewer|too (much|little|high|low)|negotiate)\b/i;

function messageFlow(text) {
  const s = String(text || '');
  for (const [flow, rx] of Object.entries(FLOW_INTENT_RX)) {
    if (rx.test(s)) return flow;
  }
  return null;
}

/** Which flow does the stored task belong to, if any. */
function taskFlow(task) {
  if (!task || typeof task !== 'object') return null;
  if (Object.keys(task.adDraft || {}).length) return 'selling';
  const d = task.drafts || {};
  if (Object.keys(d.register || {}).length || task.emailProvided || task.phoneProvided || task.emailDeclined) return 'registration';
  if (Object.keys(d.request || {}).length) return 'request';
  if (Object.keys(d.profile || {}).length) return 'profile';
  if (task.lastPick) return 'buying';
  if (task.lastSearch && /^(searchProducts|getMyOrders|addToCart)$/.test(String(task.lastSearch.tool || ''))) return 'buying';
  // A goal with no drafts yet still names a flow ("I want to sell a blender").
  return messageFlow(task.goal) || null;
}

/**
 * True when the user starts a different flow than the stored unfinished
 * task. The new request wins: the caller drops the old drafts and starts
 * clean instead of nagging about a page the user already left.
 */
function flowSwitchDetected(message, task) {
  const from = taskFlow(task);
  if (!from) return false;
  const to = messageFlow(message);
  if (!to || to === from) return false;
  return !CONTINUATION_RX.test(String(message || ''));
}

function createTask(goal = '') {
  return {
    goal: String(goal || '').slice(0, 160),
    adDraft: {},
    lastSearch: null,
    updatedAt: Date.now(),
  };
}

/* Merge newly filled ad fields into the task draft. Only real values win;
 * undefined/null/'' never clobber what a previous turn collected. */
function mergeTaskDraft(task, fields) {
  if (!task || !fields) return task;
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') task.adDraft[k] = v;
  }
  task.updatedAt = Date.now();
  return task;
}

/* Pure price validation shared by the update_listing_price tool and tests.
 * Returns { ok, unchanged, price } or { ok:false, error }. Whole Naira:
 * fractional input is rounded, never rejected, so the model is not punished
 * for "70000.00". Anything absurd needs a human re-check, not a write. */
/* Pure field normalizers shared by the profile/request fill tools and tests.
 * Only safe, non-sensitive fields pass: names, bio, state, city for profiles;
 * category, text, budget, location for requests. Passwords, phones, bank
 * details, photos and files are NEVER fillable — those stay manual. */
function normalizeProfilePatch(raw, validStates) {
  const out = {};
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  if (raw.firstName && str(raw.firstName, 40)) out.firstName = str(raw.firstName, 40);
  if (raw.lastName && str(raw.lastName, 40)) out.lastName = str(raw.lastName, 40);
  if (raw.bio !== undefined && str(raw.bio, 500)) out.bio = str(raw.bio, 500);
  const states = Array.isArray(validStates) ? validStates : [];
  const matchState = v => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return '';
    return states.find(x => String(x).toLowerCase() === s) || '';
  };
  if (raw.state && matchState(raw.state)) out.state = matchState(raw.state);
  if (raw.city && str(raw.city, 60)) out.city = str(raw.city, 60);
  return out;
}

function normalizeRequestPatch(raw) {
  const out = {};
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  if (raw.category && str(raw.category, 40)) out.category = str(raw.category, 40);
  if (raw.text && str(raw.text, 1000)) out.text = str(raw.text, 1000);
  if (raw.budget !== undefined && raw.budget !== null && raw.budget !== '') {
    const n = Number(raw.budget);
    if (Number.isFinite(n) && n >= 0 && n <= 1000000000) out.budget = String(Math.round(n));
  }
  if (raw.location && str(raw.location, 80)) out.location = str(raw.location, 80);
  return out;
}

function validatePriceChange(currentPrice, newPrice) {
  const next = Number(newPrice);
  if (!Number.isFinite(next)) return { ok: false, error: 'Give a price in Naira, e.g. 70000.' };
  if (next < 0) return { ok: false, error: 'Price cannot be negative.' };
  if (next > 1000000000) return { ok: false, error: 'That price looks wrong. Confirm the amount first.' };
  const price = Math.round(next);
  if (Number(currentPrice) === price) return { ok: true, unchanged: true, price };
  return { ok: true, unchanged: false, price };
}

/* First half of the two-call confirm gate. Never writes anything: it tells
 * the model exactly what would change so it can ask the user. The route only
 * executes on a second call with confirm:true. */
function proposePriceChange({ postId, title, currentPrice }, newPrice) {
  const v = validatePriceChange(currentPrice, newPrice);
  if (!v.ok) return { success: false, code: 'BAD_PRICE', message: v.error };
  if (v.unchanged) {
    return { success: true, postId: String(postId), title, price: v.price, unchanged: true };
  }
  return {
    success: true,
    requiresConfirmation: true,
    postId: String(postId),
    title,
    currentPrice: Number(currentPrice),
    newPrice: v.price,
    message: `Change "${title}" from \u20A6${Number(currentPrice)} to \u20A6${v.price}?`,
  };
}

/* Compact task rendering for the system prompt. Small by design: goal, draft
 * key=value pairs, last result count. Never user ids, never full history. */
function formatTaskBlock(task) {
  if (!task) return 'None yet.';
  const draft = task.adDraft && Object.keys(task.adDraft).length
    ? Object.entries(task.adDraft).map(([k, v]) => `${k}=${v}`).join(', ')
    : 'none';
  const search = task.lastSearch ? `${task.lastSearch.tool} x${task.lastSearch.count}` : 'none';
  return `Goal: ${task.goal || 'unknown'}\nDraft so far: ${draft}\nLast results: ${search}`;
}

class TaskStore {
  constructor(ttlMs = TASK_TTL_MS) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  get(userId) {
    const key = String(userId);
    const t = this.map.get(key);
    if (!t || Date.now() - t.updatedAt > this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    return t;
  }
  getOrCreate(userId, goal) {
    let t = this.get(userId);
    if (!t) {
      t = createTask(goal);
      this.map.set(String(userId), t);
    }
    return t;
  }
  reset(userId, goal) {
    const t = createTask(goal);
    this.map.set(String(userId), t);
    return t;
  }
  touch(userId) {
    const t = this.map.get(String(userId));
    if (t) t.updatedAt = Date.now();
  }
}

module.exports = {
  TASK_TTL_MS,
  SCOPE_RESET_RX,
  scopeResetDetected,
  messageFlow,
  taskFlow,
  flowSwitchDetected,
  createTask,
  mergeTaskDraft,
  validatePriceChange,
  normalizeProfilePatch,
  normalizeRequestPatch,
  proposePriceChange,
  formatTaskBlock,
  TaskStore,
};
