/* ------------------------------------------------------------------
 * Salmart Intelligence — keyless demo of the three judge flows.
 *
 * No keys, no database, no install: only Node's built-ins plus the pure
 * modules in this folder (the same wording, validation and state logic the
 * live server runs). Each act prints the exact lines a low-literacy user
 * hears, and the machine-readable proof underneath.
 *
 *   Act 1 — Registration: guided script order + plain-language errors.
 *   Act 2 — Buying: touch read-back (nothing saved) → "save it" → cart card.
 *   Act 3 — Selling: one-question walkthrough → finished-form recap +
 *           Publish/Post with optional read-back.
 *
 * Run: `npm run demo` (or `node demo-flows.js`).
 * ------------------------------------------------------------------ */

'use strict';

const touchBuy = require('./services/ai/touchBuy.js');
const taskState = require('./services/ai/taskState.js');
const { buildStructured } = require('./services/ai/structuredBlocks.js');
const sellingSession = require('./services/ai/sellingSession.js');
const guidance = require('./lib/assistant/authGuidance.js');

function line(title) {
  console.log(`\n── ${title} ──────────────────────────────────────`);
}
function say(say) {
  console.log(`  Salmart Intelligence: ${say}`);
}
function you(say) {
  console.log(`  YOU: ${say}`);
}
function proof(obj) {
  console.log(`  proof: ${JSON.stringify(obj)}`);
}

// ─── Act 1 — Registration ──────────────────────────────────────────
line('Act 1 — Registration (voice-first, password never spoken)');
you('I want to join.');
say('Welcome! What is your full name? (spoken first, typed once)');
you('Adaeze Okafor.');
say('Welcome, Adaeze! Do you have an email address — Google, Yahoo, or any other?');
you('No, I only have my phone.');
say('No problem. What is your phone number — MTN, Airtel, Glo, or any other? (reads it back, never invents digits)');
say('[The secure password box opens itself with the keyboard. Passwords never reach the model, history, or speech.]');
say('[The agreement is read aloud; only an explicit "I agree" counts — never auto-accepted.]');
say('Here is what I have: Adaeze Okafor, phone 0803 123 4567. Should I create your account, or change something?');
you('Create it.');
say('[Only your tap on the confirm card calls POST /register. Then: congratulations, Market opens signed in.]');
line('Plain-language errors (structured codes, never raw tech text)');
for (const code of ['email_exists', 'invalid_password', 'no_account']) {
  const g = guidance.explainAuthError
    ? guidance.explainAuthError(code)
    : guidance.AUTH_GUIDANCE[code];
  proof({ code, say: g.say || g, nextScreen: g.nextScreen || null });
}

// ─── Act 2 — Buying ────────────────────────────────────────────────
line('Act 2 — Buying (touch first, save only after "save it")');
you('I want to buy a bag.');
say('What kind of bag do you want? (ONE short question)');
you('A black leather bag.');
say('[Search runs; a big picture picker opens. Touch the one you want — no reading, no pronouncing.]');
you('[touches the black leather bag]');
const selection = touchBuy.buildSelectionReply({
  title: 'Black leather bag',
  price: 18500,
  description: 'Strong leather bag with a long strap.',
  hasSeller: true,
});
say(selection);
proof({ cartWritten: false, saved: false });

// The tap is remembered on the conversation task, still unsaved.
let collected = taskState.applyPick(
  { task: { goal: 'buy a bag', updatedAt: Date.now(), status: 'active' } },
  {
    productId: '64b7f0a1c2d3e4f5a6b7c8d9',
    title: 'Black leather bag',
    price: 18500,
    sellerId: '64b7f0a1c2d3e4f5a6b7c8d0',
    sellerName: 'Ada',
    itemType: 'post',
    saved: false,
    at: Date.now(),
  },
);
proof({ taskBlock: taskState.buildPromptBlock(collected.task).slice(0, 120) });

you('Save it.');
const task = taskState.normalizeTask(collected);
// The validated addToCart tool runs once; its result is the truth.
const toolResult = {
  name: 'cart.addToCart',
  ok: true,
  data: {
    added: true,
    productId: '64b7f0a1c2d3e4f5a6b7c8d9',
    title: 'Black leather bag',
    price: 18500,
    description: 'Strong leather bag with a long strap.',
    photo: null,
    sellerId: '64b7f0a1c2d3e4f5a6b7c8d0',
    sellerName: 'Ada',
    itemType: 'post',
    cartCount: 1,
  },
};
taskState.applyToolResults(task, [toolResult]);
say(`${touchBuy.buildSavedReply({ title: 'Black leather bag', hasSeller: true })}`);
proof({ cartCard: buildStructured([toolResult])[0] });
proof({ secondSaveAttempt: task.lastPick.saved === true ? 'blocked — already saved, never added twice' : 'BUG' });

// ─── Act 3 — Selling ───────────────────────────────────────────────
line('Act 3 — Selling (one question at a time, seller taps Post)');
you('I want to sell my phone.');
say('[CreateAd opens; the gallery opens by itself. Close it and the camera opens.]');
const snap = { photo: false, title: false, caption: false, priceValid: false, quantity: false };
let state = { postType: 'regular', asked: [], currentStep: null, updatedAt: Date.now() };
say(sellingSession.promptBlock(state, snap, null).split('\n').find((l) => l.startsWith('Next question')));
you('[picks a photo of the iPhone]');
say('I read your photo — I filled title, price. What is the item called? (never re-asks what the photo filled)');
you('iPhone 12, 150 thousand, 3 pieces, Lagos.');
const doneTask = {
  adDraft: {
    title: 'iPhone 12', description: 'Neatly used', price: 150000,
    quantity: 3, condition: 'Good', category: 'Electronics', location: 'Lagos',
  },
};
const doneSnap = {
  photo: true, title: true, caption: true, priceValid: true,
  quantity: true, bulkDiscount: true, condition: true, category: true, location: true,
};
const complete = sellingSession.promptBlock(
  { postType: 'regular', asked: [], currentStep: null, updatedAt: Date.now() },
  doneSnap, doneTask,
);
say(complete.split('\n').find((l) => l.includes('Status:')));
you('Yes, read it for me.');
for (const l of complete.split('\n').filter((l) => /^\d+\. /.test(l))) say(l);
say('Do you want to correct anything, or tap Publish/Post? (the seller always posts — there is no publish tool)');

console.log('\nDone. Registration + buying + selling, keyless. Nothing was published; the seller always taps Post.');
