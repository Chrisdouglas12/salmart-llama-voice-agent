'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildStructured } = require('../services/ai/structuredBlocks');
const registry = require('../services/ai/toolRegistry');

describe('chat handoff: prepareSellerEnquiry emits preview + chat_handoff with image', () => {
  it('builds a handoff block the app can open', () => {
    const blocks = buildStructured([{
      name: 'prepareSellerEnquiry',
      ok: true,
      code: 'ok',
      data: {
        prepared: {
          productId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          productTitle: 'School bag',
          productImageUrl: 'https://cdn.example/bag.jpg',
          productPrice: 15000,
          sellerId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          sellerName: 'Ada Seller',
          body: 'Hello, is this bag still available?',
        },
      },
    }]);
    const handoff = blocks.find(b => b.type === 'chat_handoff');
    assert.ok(handoff, 'expected a chat_handoff block');
    assert.equal(handoff.sellerId, 'bbbbbbbbbbbbbbbbbbbbbbbb');
    assert.equal(handoff.draft, 'Hello, is this bag still available?');
    assert.equal(handoff.imageUrl, 'https://cdn.example/bag.jpg');
    assert.equal(handoff.price, 15000);
  });
});

describe('chat handoff: registry', () => {
  it('getSellerThread is wired, auth-gated, read-only', () => {
    const def = registry.getTool('getSellerThread');
    assert.ok(def, 'getSellerThread must be registered');
    assert.equal(def.wired, true);
    assert.equal(def.requiresAuth, true);
    assert.equal(def.requiresConfirmation, false);
    assert.equal(def.mutates, false);
  });

  it('getSellerThread rejects a bad partner id without touching the DB', async () => {
    const def = registry.getTool('getSellerThread');
    await assert.rejects(
      def.handler({ userId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }, { partnerId: 'nope' }),
      /Invalid partnerId/
    );
  });

  it('seller_thread tool results become a structured block', () => {
    const blocks = buildStructured([{
      name: 'getSellerThread',
      ok: true,
      code: 'ok',
      data: { found: true, partnerId: 'bbbbbbbbbbbbbbbbbbbbbbbb', count: 1, messages: [] },
    }]);
    assert.ok(blocks.some(b => b.type === 'seller_thread'));
  });

  it('findSellerThreads is wired, auth-gated, read-only', () => {
    const def = registry.getTool('findSellerThreads');
    assert.ok(def, 'findSellerThreads must be registered');
    assert.equal(def.wired, true);
    assert.equal(def.requiresAuth, true);
    assert.equal(def.requiresConfirmation, false);
    assert.equal(def.mutates, false);
  });

  it('findSellerThreads results become a seller_thread_list block', () => {
    const blocks = buildStructured([{
      name: 'findSellerThreads',
      ok: true,
      code: 'ok',
      data: { found: true, count: 1, threads: [{ partnerId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }] },
    }]);
    assert.ok(blocks.some(b => b.type === 'seller_thread_list'));
  });

  it('summarizeSellerReplies is wired, auth-gated, read-only', () => {
    const def = registry.getTool('summarizeSellerReplies');
    assert.ok(def, 'summarizeSellerReplies must be registered');
    assert.equal(def.wired, true);
    assert.equal(def.requiresAuth, true);
    assert.equal(def.requiresConfirmation, false);
    assert.equal(def.mutates, false);
  });

  it('summarizeSellerReplies rejects signed-out callers without touching the DB', async () => {
    const def = registry.getTool('summarizeSellerReplies');
    await assert.rejects(
      def.handler({ userId: null }, { about: 'bag' }),
      /Sign in/
    );
  });

  it('summarizeSellerReplies results become a seller_replies_digest block', () => {
    const blocks = buildStructured([{
      name: 'summarizeSellerReplies',
      ok: true,
      code: 'ok',
      data: { found: true, about: 'bag', matched: true, count: 2, repliedCount: 1, sellers: [] },
    }]);
    assert.ok(blocks.some(b => b.type === 'seller_replies_digest'));
  });
});

// The slim extract intentionally omits model files; chatThreadTools resolves
// them lazily, so these DB-shaped tests only run where they exist.
let sellerModelsAvailable = true;
try {
  require('../models/userSchema');
  require('../models/postSchema');
} catch (_e) {
  sellerModelsAvailable = false;
}
const sellerTestOpts = sellerModelsAvailable ? {} : { skip: 'model files omitted in this extract' };

describe('seller replies: only the seller\'s words, never the buyer\'s', sellerTestOpts, () => {
  const Message = require('../models/messageSchema');
  const me = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const seller = 'bbbbbbbbbbbbbbbbbbbbbbbb';

  function withStubs(rows, fn) {
    const originalConversation = Message.getConversation;
    const originalFind = Message.find;
    const User = require('../models/userSchema');
    const originalUserFindById = User.findById;
    Message.getConversation = async () => rows;
    Message.find = () => ({
      sort() { return this; },
      limit() { return this; },
      select() { return this; },
      lean() { return Promise.resolve(rows); },
    });
    // Threads carry no linked product in these fixtures, so only the partner
    // name lookup runs — keep it off the network.
    User.findById = () => ({ select() { return this; }, lean() { return Promise.resolve(null); } });
    return Promise.resolve(fn()).finally(() => {
      Message.getConversation = originalConversation;
      Message.find = originalFind;
      User.findById = originalUserFindById;
    });
  }

  it('getSellerThread separates sellerMessages from myMessages', async () => {
    const rows = [
      { senderId: seller, text: 'Yes, still available. 15 thousand.', createdAt: new Date() },
      { senderId: me, text: 'I want the bag, is it available?', createdAt: new Date() },
    ];
    await withStubs(rows, async () => {
      const def = registry.getTool('getSellerThread');
      const out = await def.handler({ userId: me }, { partnerId: seller });
      assert.equal(out.hasSellerReply, true);
      assert.deepEqual(out.sellerMessages.map(m => m.text), ['Yes, still available. 15 thousand.']);
      assert.deepEqual(out.myMessages.map(m => m.text), ['I want the bag, is it available?']);
      assert.ok(!out.sellerMessages.some(m => /I want the bag/.test(m.text)));
    });
  });

  it('getSellerThread says plainly when only the buyer wrote', async () => {
    const rows = [
      { senderId: me, text: 'Do you still have the bag?', createdAt: new Date() },
      { senderId: me, text: 'Hello?', createdAt: new Date() },
    ];
    await withStubs(rows, async () => {
      const def = registry.getTool('getSellerThread');
      const out = await def.handler({ userId: me }, { partnerId: seller });
      assert.equal(out.hasSellerReply, false);
      assert.equal(out.sellerMessages.length, 0);
      assert.match(out.note, /has not replied/i);
    });
  });

  it('summarizeSellerReplies returns matched:false for an unrelated item', async () => {
    const rows = [
      { senderId: me, text: 'Hello about the phone', createdAt: new Date() },
      { senderId: seller, text: 'The phone is 80 thousand', createdAt: new Date() },
    ];
    await withStubs(rows, async () => {
      const def = registry.getTool('summarizeSellerReplies');
      const out = await def.handler({ userId: me }, { about: 'bag' });
      assert.equal(out.matched, false);
      assert.equal(out.count, 0);
      assert.equal(out.sellers.length, 0);
      assert.match(out.note, /could not find a chat/i);
    });
  });

  it('summarizeSellerReplies matches from words used inside a hand-started chat', async () => {
    const rows = [
      { senderId: me, text: 'I need a school bag for my son', createdAt: new Date() },
      { senderId: seller, text: 'Yes, the bag is 15 thousand', createdAt: new Date() },
    ];
    await withStubs(rows, async () => {
      const def = registry.getTool('summarizeSellerReplies');
      const out = await def.handler({ userId: me }, { about: 'bags' });
      assert.equal(out.matched, true);
      assert.equal(out.count, 1);
      assert.equal(out.repliedCount, 1);
      assert.deepEqual(out.sellers[0].sellerLines, ['Yes, the bag is 15 thousand']);
    });
  });
}, sellerTestOpts);
