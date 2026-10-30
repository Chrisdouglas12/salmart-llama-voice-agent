'use strict';

/**
 * services/ai/metrics.js
 *
 * Operational metrics for /api/ai. This is instrumentation for judges and ops,
 * not analytics: it records latency, stop reasons, tool names/codes, and sizes.
 * It NEVER stores a user message, an assistant reply, a tool summary, a
 * product title, or any other free text. Only allowlisted fields are written.
 *
 * Every write is best-effort. A metrics failure must never fail a user turn.
 */

const mongoose = require('mongoose');

const toolMetricSchema = new mongoose.Schema({
  name: { type: String, maxlength: 64 },
  ok:   { type: Boolean, default: false },
  code: { type: String, maxlength: 64 },
  ms:   { type: Number, min: 0 },
}, { _id: false });

const aiMetricSchema = new mongoose.Schema({
  requestId:      { type: String, maxlength: 80, index: true },
  conversationId: { type: String, maxlength: 80, index: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  kind:           { type: String, enum: ['turn', 'action'], required: true, index: true },
  action:         { type: String, enum: ['confirm', 'cancel', 'read', null], default: null },
  anonymous:      { type: Boolean, default: false },
  ok:             { type: Boolean, required: true },
  stopReason:     { type: String, maxlength: 40 },
  errorCode:      { type: String, maxlength: 64 },
  latencyMs:      { type: Number, min: 0 },
  llmMs:          { type: Number, min: 0 },
  toolMs:         { type: Number, min: 0 },
  messageChars:   { type: Number, min: 0 },
  replyChars:     { type: Number, min: 0 },
  screen:         { type: String, maxlength: 80 },
  platform:       { type: String, maxlength: 20 },
  tools:          { type: [toolMetricSchema], default: undefined },
  createdAt:      { type: Date, default: Date.now },
}, { versionKey: false });

aiMetricSchema.index({ kind: 1, createdAt: -1 });
aiMetricSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const AIMetric = mongoose.models.AIMetric
  || mongoose.model('AIMetric', aiMetricSchema);

const MAX_ROWS = 10_000;
const MAX_TOOLS = 8;
const MAX_DAYS = 30;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

function str(value, max) {
  if (value === undefined || value === null) return undefined;
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) || undefined;
}

function cleanTools(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = [];
  for (const t of raw.slice(0, MAX_TOOLS)) {
    if (!t || typeof t !== 'object') continue;
    const name = str(t.name, 64);
    if (!name) continue;
    out.push({
      name,
      ok: t.ok === true,
      ...(t.code && { code: str(t.code, 64) }),
      ...(num(t.ms) !== undefined && { ms: num(t.ms) }),
    });
  }
  return out.length ? out : undefined;
}

/**
 * Explicit allowlist. Any extra key on the caller's object is ignored, which is
 * what keeps accidental message text out of the collection.
 */
function sanitize(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.kind !== 'turn' && entry.kind !== 'action') return null;

  const action = ['confirm', 'cancel', 'read'].includes(entry.action) ? entry.action : null;
  const out = {
    kind: entry.kind,
    ok: entry.ok === true,
    anonymous: entry.anonymous === true,
  };

  const requestId = str(entry.requestId, 80);
  if (requestId) out.requestId = requestId;
  const conversationId = str(entry.conversationId, 80);
  if (conversationId) out.conversationId = conversationId;
  if (entry.userId && mongoose.Types.ObjectId.isValid(String(entry.userId))) {
    out.userId = entry.userId;
  }
  if (entry.kind === 'action') out.action = action;

  for (const key of ['stopReason', 'errorCode']) {
    const v = str(entry[key], key === 'errorCode' ? 64 : 40);
    if (v) out[key] = v;
  }
  for (const key of ['latencyMs', 'llmMs', 'toolMs', 'messageChars', 'replyChars']) {
    const v = num(entry[key]);
    if (v !== undefined) out[key] = v;
  }
  for (const key of ['screen', 'platform']) {
    const v = str(entry[key], key === 'platform' ? 20 : 80);
    if (v) out[key] = v;
  }

  const tools = cleanTools(entry.tools);
  if (tools) out.tools = tools;

  return out;
}

async function record(entry) {
  try {
    const doc = sanitize(entry);
    if (!doc) return null;
    return await AIMetric.create(doc);
  } catch (_err) {
    // Metrics are optional infrastructure. Never surface this to a user.
    return null;
  }
}

function recordTurn(entry) {
  return record({ ...entry, kind: 'turn' });
}

function recordAction(entry) {
  return record({ ...entry, kind: 'action' });
}

function percentile(sorted, p) {
  if (!Array.isArray(sorted) || !sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function bump(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

/**
 * Pure aggregation over already-fetched rows. Exported so the shape is testable
 * without Mongo.
 */
function summarize(rows, { from, to, days } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const turns = list.filter(r => r && r.kind === 'turn');
  const actions = list.filter(r => r && r.kind === 'action');

  const latencies = turns.map(r => Number(r.latencyMs) || 0).sort((a, b) => a - b);
  const okTurns = turns.filter(r => r.ok === true).length;
  const anonymous = turns.filter(r => r.anonymous === true).length;

  const stops = {};
  const errorCodes = {};
  const toolByName = {};
  const screens = {};
  const platforms = {};
  let toolCalls = 0;
  let toolErrors = 0;

  for (const turn of turns) {
    bump(stops, turn.stopReason || 'unknown');
    if (!turn.ok) bump(errorCodes, turn.errorCode || 'TURN_FAILED');
    bump(screens, turn.screen || 'unknown');
    bump(platforms, turn.platform || 'unknown');

    for (const t of Array.isArray(turn.tools) ? turn.tools : []) {
      if (!t || !t.name) continue;
      toolCalls += 1;
      if (!t.ok) {
        toolErrors += 1;
        bump(errorCodes, t.code || 'TOOL_FAILED');
      }
      const row = toolByName[t.name] || { calls: 0, errors: 0 };
      row.calls += 1;
      if (!t.ok) row.errors += 1;
      toolByName[t.name] = row;
    }
  }

  const actionSummary = {};
  for (const a of actions) {
    const key = a.action || 'unknown';
    const row = actionSummary[key] || { ok: 0, errors: 0 };
    if (a.ok) row.ok += 1;
    else row.errors += 1;
    actionSummary[key] = row;
  }

  const errorRate = turns.length ? Number(((turns.length - okTurns) / turns.length).toFixed(4)) : 0;

  return {
    window: { from: from || null, to: to || null, days: days || null },
    totals: {
      turns: turns.length,
      actions: actions.length,
      okTurns,
      failedTurns: turns.length - okTurns,
      anonymousTurns: anonymous,
      authenticatedTurns: turns.length - anonymous,
      errorRate,
      toolCalls,
      toolErrors,
    },
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      max: latencies.length ? latencies[latencies.length - 1] : 0,
    },
    stops,
    errorCodes,
    tools: toolByName,
    actions: actionSummary,
    screens,
    platforms,
  };
}

/** Read a bounded window and aggregate it. Used by the admin endpoint. */
async function summary({ days = 7 } = {}) {
  const safeDays = Math.min(MAX_DAYS, Math.max(1, Number(days) || 7));
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const rows = await AIMetric.find({ createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(MAX_ROWS)
    .lean();

  return {
    ...summarize(rows, { from: since.toISOString(), to: new Date().toISOString(), days: safeDays }),
    sampled: rows.length,
    truncated: rows.length >= MAX_ROWS,
  };
}

module.exports = {
  AIMetric,
  MAX_DAYS,
  sanitize,
  record,
  recordTurn,
  recordAction,
  summarize,
  summary,
};
