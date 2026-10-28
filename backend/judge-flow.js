/* ------------------------------------------------------------------
 * Aya judge flow — keyless standalone runner (no keys, no DB, no app).
 *
 * Runs the 7-turn judge script through the REAL deterministic brain
 * (lib/assistant/mockAgent.js) and the REAL tool contract
 * (lib/assistant/tools.js), with a small clearly-labelled SAMPLE catalogue
 * injected at the documented `context.searchProducts` seam — the same seam
 * the live server fills with Mongo. Session (draft, products) persists
 * across turns exactly like the server session; navigation updates the
 * context screen the way the phone does.
 *
 * What this proves: intent → tools → verified envelope, deterministically.
 * What it does NOT prove: live Meta brains (need META_API_KEY), real
 * listings, or the phone UI. Those are covered by the hosted demo + video.
 * Run: `npm run demo` (or `node judge-flow.js`).
 * ------------------------------------------------------------------ */

const { runMockAgent } = require('./lib/assistant/mockAgent.js');

// ─── SAMPLE catalogue (judge data only — never presented as real) ──────────
const SAMPLE = [
  { postId: 'p-iphone-11', title: 'iPhone 11 64GB', price: 195000, category: 'electronics', sellerId: 's-ada', sellerName: 'Adaeze' },
  { postId: 'p-iphone-13', title: 'iPhone 13 128GB', price: 320000, category: 'electronics', sellerId: 's-ada', sellerName: 'Adaeze' },
  { postId: 'p-rice', title: 'Bag of rice 50kg', price: 85000, category: 'food_items', sellerId: 's-musa', sellerName: 'Musa' },
  { postId: 'p-shoes', title: 'Nike Air Force 1 Sneakers', price: 45000, category: 'fashion', sellerId: 's-ada', sellerName: 'Adaeze' },
  { postId: 'p-sofa', title: 'Fairly used 3-seater sofa', price: 120000, category: 'home', sellerId: 's-emi', sellerName: 'Emeka' },
  { postId: 'p-flat', title: 'Two bedroom flat', price: 50000, category: 'home', sellerId: 's-emi', sellerName: 'Emeka' },
];

async function searchProducts({ query = '', minPrice, maxPrice, category, limit = 6 } = {}) {
  const tokens = String(query).toLowerCase().split(/[\s,]+/).filter(t => t.length > 1);
  let out = SAMPLE.filter(p => {
    const hay = `${p.title} ${p.category}`.toLowerCase();
    if (tokens.length && !tokens.every(t => hay.includes(t))) return false;
    if (category && p.category !== category) return false;
    if (minPrice != null && p.price < Number(minPrice)) return false;
    if (maxPrice != null && p.price > Number(maxPrice)) return false;
    return true;
  });
  out = out.slice(0, Math.min(Number(limit) || 6, 10));
  return { products: out, source: 'sample-catalogue' };
}

// ─── The 7-turn judge script ───────────────────────────────────────────────
const TURNS = [
  'I want to sell something',
  'Open my gallery, I just snapped one house',
  'Pick the second one',
  'Two bedroom flat, 50k, Abuja, brand new',
  'Find me iPhone under 200k',
  'Add it to cart',
  'Take me to checkout',
];

async function main() {
  const session = { draft: {}, products: [] };
  const context = { screen: 'market', searchProducts };
  console.log('Aya judge flow — deterministic brain + SAMPLE catalogue (keyless)\n');

  for (const say of TURNS) {
    const collected = { actions: [], navigations: [] };
    const res = await runMockAgent({
      messages: [{ role: 'user', content: say }],
      history: [],
      context,
      session,
      collected,
    });
    console.log(`YOU: ${say}`);
    console.log(`AYA: ${res.message}`);
    for (const a of collected.actions) console.log(`  action: ${JSON.stringify(a)}`);
    for (const n of collected.navigations) console.log(`  nav:    ${JSON.stringify(n)}`);
    if (collected.products?.length) {
      for (const p of collected.products) console.log(`  item:   ${p.title} — ₦${p.price} (${p.postId})`);
    }
    console.log('');
    // Mirror the phone: follow navigations, open the picker after gallery.
    const lastNav = collected.navigations[collected.navigations.length - 1];
    if (lastNav?.screen) context.screen = lastNav.screen;
    if (collected.actions.some(a => a.type === 'pick_photo')) context.gallery = { open: true, count: 3 };
    if (collected.actions.some(a => a.type === 'choose_photo')) context.gallery = null;
  }
  console.log('Done. Nothing was published: the seller always taps Post.');
}

main().catch(e => { console.error('judge flow failed:', e?.message || e); process.exit(1); });
