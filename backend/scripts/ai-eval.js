'use strict';

/**
 * scripts/ai-eval.js
 *
 * Scripted evaluation for the Salmart AI agent. Two modes:
 *
 *   node scripts/ai-eval.js
 *       Offline contract checks. No keys, no Mongo, no network. Exercises the
 *       pure layers that decide what the app is allowed to render: navigation,
 *       form fills, the Google handoff URL gate, and persisted task memory.
 *
 *   node scripts/ai-eval.js --live --base https://your-api [--token JWT] [--soft]
 *       Sends a fixed set of utterances to a running /api/ai and checks the
 *       real replies/structured blocks and latency. Without --token it creates
 *       an anonymous conversation, which also verifies anonymous voice paths.
 *
 * Nothing here writes user data. Live mode creates one throwaway conversation.
 */

'use strict';

let dotenv = null;
try { dotenv = require('dotenv'); } catch (_e) { /* optional */ }
if (dotenv) dotenv.config();

const navigationTools = require('../services/ai/tools/navigationTools');
const { buildStructured, safeAuthUrl } = require('../services/ai/structuredBlocks');
const { normalizePlatform, platformFromContext } = require('../services/ai/platform');
const { explainAuthError } = require('../lib/assistant/authGuidance');
const taskState = require('../services/ai/taskState');

const results = [];

function check(id, label, fn) {
  try {
    fn();
    results.push({ id, label, ok: true });
  } catch (err) {
    results.push({ id, label, ok: false, detail: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function offline() {
  check('nav-allow', 'navigation: allowed screens are accepted', () => {
    for (const screen of ['market', 'messages', 'search', 'createAd', 'register', 'signin']) {
      assert(navigationTools.isAllowedScreen(screen), `${screen} should be allowed`);
    }
  });

  check('nav-deny', 'navigation: AI and id-based screens are refused', () => {
    for (const screen of ['ai', 'assistant', 'checkout', 'chat', 'showroom', 'admin', '']) {
      assert(!navigationTools.isAllowedScreen(screen), `${screen} should be refused`);
    }
  });

  check('nav-block', 'structured: one navigate block, last wins', () => {
    const blocks = buildStructured([
      { name: 'navigateToScreen', ok: true, data: { screen: 'search', query: 'blender' } },
      { name: 'navigateToScreen', ok: true, data: { screen: 'market' } },
    ]);
    assert(blocks.length === 1, 'expected one block');
    assertEqual(blocks[0].type, 'navigate', 'block type');
    assertEqual(blocks[0].target, 'market', 'last target wins');
  });

  check('register-fill', 'registration: name/email fill, password never', () => {
    const blocks = buildStructured([{
      name: 'prepareRegistration',
      ok: true,
      data: {
        fields: { firstName: 'Ada', lastName: 'Okafor', email: 'ada@example.com' },
        note: 'Choose your own password.',
      },
    }]);
    const fill = blocks.find(b => b.type === 'fill_register');
    assert(fill, 'missing fill_register');
    assertEqual(fill.fields.firstName, 'Ada', 'first name');
    assertEqual(fill.fields.email, 'ada@example.com', 'email for the form');
    assert(fill.fields.password === undefined, 'password must never be filled');
  });

  check('auth-url', 'google: valid URL becomes an auth_url block', () => {
    const url = 'https://app.salmartonline.com.ng/auth/google?source=mobile&platform=android';
    const blocks = buildStructured([{
      name: 'startGoogleAuthentication', ok: true, data: { platform: 'android', url },
    }]);
    assertEqual(blocks.length, 1, 'block count');
    assertEqual(blocks[0].type, 'auth_url', 'block type');
    assertEqual(blocks[0].url, url, 'url');
  });

  check('auth-forged', 'google: forged schemes and foreign paths are dropped', () => {
    for (const url of ['javascript:alert(1)', 'https://evil.example.com/steal', 'https://evil.example.com/auth/google/../../x']) {
      assertEqual(safeAuthUrl(url), null, url);
    }
  });

  check('platform', 'google: platform falls back to screen context', () => {
    assertEqual(normalizePlatform('ANDROID'), 'android', 'explicit');
    assertEqual(platformFromContext(undefined, { platform: 'ios' }), 'ios', 'context');
    assertEqual(platformFromContext(undefined, {}), null, 'missing');
  });

  check('task-reset', 'task: correction keeps draft, scope reset clears it', () => {
    const first = taskState.beginTurn({ collectedInfo: null, message: 'Sell a blender' });
    taskState.applyToolResults(first.task, [{
      name: 'prepareAdForm', ok: true, data: { fields: { title: 'Blender', price: 12000 } },
    }]);

    const corrected = taskState.beginTurn({
      collectedInfo: taskState.toCollectedInfo(null, first.task),
      message: 'Make it seventy thousand',
    });
    assertEqual(corrected.reset, false, 'correction is not a reset');
    assertEqual(corrected.task.adDraft.title, 'Blender', 'draft retained');

    const reset = taskState.beginTurn({
      collectedInfo: taskState.toCollectedInfo(null, corrected.task),
      message: 'Forget it, sell a generator instead',
    });
    assertEqual(reset.reset, true, 'reset detected');
    assertEqual(Object.keys(reset.task.adDraft).length, 0, 'draft cleared');
  });

  check('task-privacy', 'task: email/password/phone are not stored or prompted', () => {
    const { task } = taskState.beginTurn({ collectedInfo: null, message: 'Register me' });
    taskState.applyToolResults(task, [{
      name: 'prepareRegistration',
      ok: true,
      data: { fields: { firstName: 'Ada', email: 'ada@example.com', password: 'hunter2', phone: '0801' } },
    }]);
    const json = JSON.stringify(task);
    assert(!json.includes('ada@example.com'), 'email stored');
    assert(!json.includes('hunter2'), 'password stored');
    assert(!json.includes('0801'), 'phone stored');
    assert(task.emailProvided === true, 'emailProvided flag');
  });

  check('task-prompt', 'task: prompt block stays compact and secret-free', () => {
    const { task } = taskState.beginTurn({ collectedInfo: null, message: 'Sell a blender for 12000 naira in Abuja' });
    taskState.applyToolResults(task, [{
      name: 'prepareAdForm', ok: true, data: { fields: { title: 'Blender', price: 12000, location: 'Abuja' } },
    }]);
    const block = taskState.buildPromptBlock(task);
    assert(block.includes('Blender'), 'draft missing from prompt');
    assert(block.length < 800, 'prompt block too long');
  });

  check('auth-guidance', 'onboarding: error codes map to short safe guidance', () => {
    const known = explainAuthError('email_exists');
    assertEqual(known.code, 'email_exists', 'code');
    assertEqual(known.nextScreen, 'signin', 'screen');
    assert(known.say.length > 0 && known.say.length <= 160, 'one short sentence');
    const unknown = explainAuthError('ada@example.com');
    assertEqual(unknown.code, 'unknown', 'email is not a code');
    assertEqual(unknown.nextScreen, null, 'no invented screen');
    assert(!unknown.say.includes('ada@example.com'), 'input echoed');
    for (const g of ['invalid_password', 'google_only', 'unverified', 'session_expired']) {
      assert(explainAuthError(g).say.length <= 160, `${g} too long`);
    }
  });

  return results;
}

const LIVE_SCENARIOS = [
  {
    id: 'live-find',
    say: 'Show me a blender under 20,000 naira',
    expectAny: ['product_results'],
  },
  {
    id: 'live-nav',
    say: 'Open my messages',
    expectAny: ['navigate'],
    expectTarget: 'messages',
  },
  {
    id: 'live-auth',
    say: 'Help me sign in with Google',
    expectAny: ['auth_url', 'onboarding_options'],
  },
  {
    id: 'live-register',
    say: 'Help me create an account. My name is Ada Okafor and my email is ada@example.com.',
    expectAny: ['fill_register', 'navigate'],
  },
  {
    id: 'live-recover',
    say: 'I forgot my password',
    expectAny: ['navigate'],
    expectTarget: 'passwordReset',
  },
  {
    id: 'live-sell',
    say: 'I want to sell a blender for fifteen thousand naira',
    expectAny: ['fill_ad', 'navigate'],
  },
  {
    id: 'live-help',
    say: 'How do I use this app?',
    expectAny: [],
  },
  {
    id: 'live-orders',
    say: 'Where is my order?',
    expectAny: ['order_information', 'order_details', 'onboarding_options'],
    authOnly: true,
  },
];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function jsonFetch(url, options) {
  const started = Date.now();
  const res = await fetch(url, options);
  const ms = Date.now() - started;
  let body = null;
  try { body = await res.json(); } catch (_e) { body = null; }
  return { status: res.status, body, ms };
}

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
    : 0;
  return { p50: at(50), p95: at(95), max: sorted.length ? sorted[sorted.length - 1] : 0 };
}

async function live() {
  const base = String(arg('base', process.env.AI_EVAL_BASE || '')).replace(/\/+$/, '');
  if (!base) {
    console.error('--live needs --base https://your-api (or AI_EVAL_BASE).');
    process.exitCode = 2;
    return [];
  }
  const token = arg('token', process.env.AI_EVAL_TOKEN || '');
  const soft = hasFlag('soft');
  const delayMs = Number(arg('delay', '350')) || 0;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const created = await jsonFetch(`${base}/api/ai/conversations`, {
    method: 'POST', headers, body: JSON.stringify({}),
  });
  if (!created.body?.success || !created.body?.conversationId) {
    console.error(`Could not create conversation: HTTP ${created.status} ${JSON.stringify(created.body)}`);
    process.exitCode = 2;
    return [];
  }

  const conversationId = created.body.conversationId;
  const anonymousId = created.body.anonymousId;
  console.log(`Conversation: ${conversationId}${anonymousId ? ' (anonymous)' : ''}`);

  const out = [];
  for (const scenario of LIVE_SCENARIOS) {
    if (scenario.authOnly && !token) {
      out.push({ id: scenario.id, label: scenario.say, ok: true, skipped: true, detail: 'auth-only' });
      continue;
    }
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));

    const body = {
      conversationId,
      message: scenario.say,
      context: { platform: 'android', screen: 'home' },
    };
    if (anonymousId) body.anonymousId = anonymousId;

    const res = await jsonFetch(`${base}/api/ai/turn`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const reply = String(res.body?.reply || '');
    const structured = Array.isArray(res.body?.structured) ? res.body.structured : [];
    const types = structured.map(b => b && b.type).filter(Boolean);

    const problems = [];
    if (res.status !== 200 || !res.body?.success) problems.push(`HTTP ${res.status}`);
    if (!reply.trim()) problems.push('empty reply');
    if (scenario.expectAny?.length && !scenario.expectAny.some(t => types.includes(t))) {
      problems.push(`missing any of ${scenario.expectAny.join(', ')} (got ${types.join(', ') || 'none'})`);
    }
    if (scenario.expectTarget) {
      const nav = structured.find(b => b?.type === 'navigate');
      if (!nav || nav.target !== scenario.expectTarget) {
        problems.push(`expected navigate to ${scenario.expectTarget}`);
      }
    }

    const ok = problems.length === 0;
    out.push({
      id: scenario.id,
      label: scenario.say,
      ok: ok || soft,
      strictOk: ok,
      ms: res.ms,
      types,
      detail: problems.join('; '),
    });
    console.log(`${ok ? 'PASS' : soft ? 'WARN' : 'FAIL'}  ${scenario.id}  ${res.ms}ms  ${scenario.say}`);
    if (!ok) console.log(`      ${problems.join('; ')}${soft ? ' (soft)' : ''}`);
  }
  return out;
}

function printTable(rows) {
  if (!rows.length) return;
  const width = Math.max(...rows.map(r => r.id.length), 12);
  for (const r of rows) {
    const mark = r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    const ms = r.ms !== undefined ? `${r.ms}ms` : '';
    console.log(`${mark}  ${r.id.padEnd(width)}  ${ms.padStart(7)}  ${r.detail || ''}`);
  }
}

function printSummary(rows) {
  const ran = rows.filter(r => !r.skipped);
  const passed = ran.filter(r => r.ok).length;
  const failed = ran.length - passed;
  const latencies = ran.filter(r => Number.isFinite(r.ms)).map(r => r.ms);
  console.log(`\n${passed}/${ran.length} passed${failed ? `, ${failed} failed` : ''}`);
  if (latencies.length) {
    const p = percentiles(latencies);
    console.log(`Latency p50=${p.p50}ms p95=${p.p95}ms max=${p.max}ms`);
  }
  if (failed) process.exitCode = 1;
}

(async () => {
  console.log('Salmart AI — scripted evaluation\n');
  if (hasFlag('live')) {
    const rows = await live();
    printTable(rows);
    printSummary(rows);
    return;
  }

  const rows = offline();
  printTable(rows);
  printSummary(rows);
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
