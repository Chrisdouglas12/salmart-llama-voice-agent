'use strict';

/**
 * services/ai/tools/cartTools.js
 *
 * Buyer-side cart writes for the agent. The checks match
 * routes/cartRoutes.js#POST /api/cart: valid id, listing exists, not sold out,
 * and never the buyer's own listing. The agent cannot add anything the cart
 * screen itself would reject.
 *
 * Adding to the cart is reversible, and it only runs after the user agrees in
 * conversation, so it executes inline without a confirmation card. Payment is
 * never touched: checkout stays manual on the cart screen, where escrow
 * protects the buyer.
 */

const mongoose = require('mongoose');
const Cart = require('../../../models/cartSchema.js');
const Post = require('../../../models/postSchema.js');
const Showroom = require('../../../models/showRoomSchema.js');
const { resolveCartQuantity } = require('../cartQuantity');

const MAX_CART_ITEMS = 50;

function sellerIdOf(product, itemType) {
  if (!product) return null;
  if (itemType === 'showroom') return product.seller ? String(product.seller) : null;
  return product.createdBy?.userId ? String(product.createdBy.userId) : null;
}

/**
 * Load and validate one buyable listing without writing anything.
 *
 * Shared by `previewProduct` (the touch picker) and `addToCart` (the save
 * step), so the buyer can only preview and save an item the cart screen itself
 * would accept. Throws AUTH_REQUIRED, TOOL_BAD_ARGS, or TOOL_FAILED with plain
 * user-safe messages.
 */
async function loadProduct(ctx, { productId, itemType = 'post' } = {}) {
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    const e = new Error('Invalid productId.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }
  const type = itemType === 'showroom' ? 'showroom' : 'post';

  const product = type === 'showroom'
    ? await Showroom.findById(productId).lean()
    : await Post.findById(productId).lean();
  if (!product) {
    const e = new Error('That item is no longer available.');
    e.code = 'TOOL_FAILED';
    throw e;
  }
  if (product.isSold) {
    const e = new Error('That item is already sold.');
    e.code = 'TOOL_FAILED';
    throw e;
  }

  const sellerId = sellerIdOf(product, type);
  if (!sellerId) {
    const e = new Error('That item has no seller.');
    e.code = 'TOOL_FAILED';
    throw e;
  }
  if (ctx.userId && sellerId === String(ctx.userId)) {
    const e = new Error('You cannot add your own listing to the cart.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }

  const photo = product.photo
    || (Array.isArray(product.photos) && product.photos[0])
    || null;
  const sellerName = type === 'showroom' ? (product.sellerName || product.businessName || null)
    : (product.createdBy?.name || null);

  // How many units the seller still has. Services and digitals are not
  // counted — they are always available. A regular post's `quantity` is the
  // server's truth; null means unlimited/unknown, never zero.
  const isServicePost = type === 'post' && product.postType === 'service';
  const isDigitalPost = type === 'post' && product.postType === 'digital';
  const stock = (isServicePost || isDigitalPost || type === 'showroom')
    ? null
    : (Number.isFinite(Number(product.quantity)) ? Math.max(0, Math.floor(Number(product.quantity))) : null);

  return {
    product,
    type,
    sellerId,
    sellerName,
    photo,
    title: product.title || product.description || 'Item',
    price: typeof product.price === 'number' ? product.price : null,
    description: product.description ? String(product.description).slice(0, 600) : null,
    stock,
  };
}

/**
 * Read-only preview for the touch picker. The buyer hears the title and
 * description and decides whether to save it. Nothing is written here, so a
 * tap alone never changes the cart.
 */
async function previewProduct(ctx, { productId, itemType = 'post' } = {}) {
  const loaded = await loadProduct(ctx, { productId, itemType });
  return {
    productId: String(loaded.product._id),
    itemType: loaded.type,
    title: loaded.title,
    price: loaded.price,
    description: loaded.description,
    photo: loaded.photo,
    sellerId: loaded.sellerId,
    sellerName: loaded.sellerName,
  };
}

/**
 * addToCart({ productId, quantity?, itemType?, mode? })
 *
 * `quantity` is the TOTAL the buyer wants in the cart, because the voice flow
 * asks "how many do you want?". It is not added on top of what is already
 * there - that used to make the assistant put more units in the cart than the
 * buyer asked for. Pass `mode: 'add'` only for an explicit "add two more".
 *
 * The server stock is checked BEFORE writing, and the final total never
 * exceeds it. Returns { added, title, quantity, addedNow, requested, mode,
 * previousQuantity, capped, reduced, available, cartCount }. `available` is how
 * many are left AFTER this call (null when the item is uncounted). Throws
 * AUTH_REQUIRED, TOOL_BAD_ARGS, or TOOL_FAILED with plain user-safe messages.
 */
async function addToCart(
  ctx,
  { productId, quantity = 1, itemType = 'post', mode = 'set' } = {},
) {
  if (!ctx.userId) {
    const e = new Error('Sign in to add items to your cart.');
    e.code = 'AUTH_REQUIRED';
    throw e;
  }
  const loaded = await loadProduct(ctx, { productId, itemType });
  const { product, type, sellerId, photo, sellerName, stock } = loaded;

  const isService = type === 'post' && product.postType === 'service';
  const isDigital = type === 'post' && product.postType === 'digital';

  let cart = await Cart.findOne({ buyerId: ctx.userId });
  if (!cart) cart = await Cart.create({ buyerId: ctx.userId, items: [] });

  const existing = cart.items.find((i) => String(i.postId) === String(productId));
  const inCart = existing ? (Number(existing.quantity) || 0) : 0;

  if (stock != null && stock <= 0) {
    const e = new Error('That item is sold out.');
    e.code = 'TOOL_FAILED';
    throw e;
  }

  // One decision point for the final count: set-vs-add, the 10,000 ceiling and
  // the seller's stock are all applied here before a single byte is written.
  const plan = resolveCartQuantity({
    requested: quantity,
    inCart,
    stock,
    mode,
    unitOnly: isService || isDigital,
  });
  if (plan.total <= 0) {
    const e = new Error('That item is sold out.');
    e.code = 'TOOL_FAILED';
    throw e;
  }

  if (existing) {
    existing.quantity = plan.total;
  } else {
    if (cart.items.length >= MAX_CART_ITEMS) {
      const e = new Error(`Your cart is full (max ${MAX_CART_ITEMS} items).`);
      e.code = 'TOOL_FAILED';
      throw e;
    }
    cart.items.push({
      postId: productId,
      postModel: type === 'showroom' ? 'Showroom' : 'Post',
      sellerId,
      quantity: plan.total,
    });
  }
  await cart.save();

  let note;
  if (plan.reduced) {
    note = `Cart quantity set to ${plan.total}. Checkout stays manual on the cart screen.`;
  } else if (plan.addedNow === 0) {
    note = `The cart already has ${plan.total}. Checkout stays manual on the cart screen.`;
  } else {
    note = `Added ${plan.addedNow}; the cart now has ${plan.total}. Checkout stays manual on the cart screen.`;
  }

  return {
    added: true,
    productId: String(product._id),
    itemType: type,
    title: loaded.title,
    price: loaded.price,
    description: loaded.description,
    photo,
    sellerId,
    sellerName,
    quantity: plan.total,
    addedNow: plan.addedNow,
    requested: plan.requested,
    mode: plan.mode,
    previousQuantity: plan.previous,
    capped: plan.capped,
    reduced: plan.reduced,
    available: plan.available,
    cartCount: cart.items.length,
    note,
  };
}

module.exports = { addToCart, previewProduct };
