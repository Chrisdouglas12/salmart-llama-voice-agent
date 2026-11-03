'use strict';

/**
 * services/ai/tools/formTools.js
 *
 * Form-fill handlers. The model writes a `{ fields }` patch for whichever
 * form the user is standing on; the corresponding screen drains it and writes
 * it into its own state. These handlers are pure — they validate and normalise
 * the model's output, nothing more. The frontend does the actual writing.
 *
 * Every rule here mirrors the constraints the target screen already enforces
 * (see src/screens/CreateAdScreen.js validate(), CreateRequestScreen.js,
 * EditProfileScreen.js). We normalise here so the model cannot put an invalid
 * value into the screen that the screen itself would reject on save.
 */

// ── Vocabulary (kept in sync with theme.js on the frontend) ─────────────────
const selling = require('../../../lib/assistant/sellingFlow');

const AD_CATEGORIES = [
  'electronics', 'fashion', 'home', 'vehicles', 'music',
  'books', 'food_items', 'others', 'services', 'digital',
];
const SERVICE_CATEGORIES = [
  'tech', 'design', 'writing', 'marketing', 'repair', 'tutoring', 'logistics', 'other',
];
const AD_CONDITIONS = ['New', 'Like New', 'Good', 'Fair', 'For Parts'];
const SERVICE_TYPES = ['remote', 'onsite', 'both'];
const NIGERIAN_STATES = [
  'Nationwide', 'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi',
  'Bayelsa', 'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo',
  'Ekiti', 'Enugu', 'FCT - Abuja', 'Gombe', 'Imo', 'Jigawa', 'Kaduna',
  'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa',
  'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto',
  'Taraba', 'Yobe', 'Zamfara',
];
const CONDITION_ALIASES = {
  'brand new': 'New', new: 'New', sealed: 'New',
  'like new': 'Like New', 'almost new': 'Like New', 'barely used': 'Like New', refurbished: 'Like New',
  used: 'Good', 'fairly used': 'Good', 'uk used': 'Good', 'foreign used': 'Good', tokunbo: 'Good', good: 'Good',
  fair: 'Fair', 'for parts': 'For Parts', faulty: 'For Parts', 'not working': 'For Parts', spoilt: 'For Parts',
};
const LOCATION_ALIASES = {
  abuja: 'FCT - Abuja', fct: 'FCT - Abuja', 'fct abuja': 'FCT - Abuja',
  'akwa-ibom': 'Akwa Ibom', 'cross-river': 'Cross River',
};
const REQUEST_CATEGORIES = ['electronics', 'fashion', 'home', 'vehicles', 'music', 'others'];

const clean = (v, n = 200) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, n);const matchList = (arr, v) => {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return arr.find(x => x.toLowerCase() === s) || '';
};

// ── prepareAdForm ────────────────────────────────────────────────────────────

function normalizeAdFields(raw, currentType = 'regular') {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  const type = matchList(['regular', 'service', 'digital'], r.postType);
  if (type) out.postType = type;
  const t = type || (['regular', 'service', 'digital'].includes(currentType) ? currentType : 'regular');

  const title = clean(r.title, 120);
  if (title) out.title = title;
  const description = String(r.description == null ? '' : r.description).trim().slice(0, 2000);
  if (description) out.description = description;

  if (r.price != null && r.price !== '') {
    const n = parseFloat(String(r.price).replace(/[^\d.]/g, ''));
    if (!isNaN(n) && n >= 0) out.price = n;
  }
  const qty = parseInt(r.quantity, 10);
  if (qty >= 1) out.quantity = Math.min(qty, 10000);

  if (t === 'regular') {
    const key = String(r.condition == null ? '' : r.condition).trim().toLowerCase();
    const cond = matchList(AD_CONDITIONS, r.condition) || CONDITION_ALIASES[key] || '';
    if (cond) out.condition = cond;

    // Bulk discount: "buy at least N units and get X off each" (regular posts
    // only). The model may pass either an explicit discounted price or an
    // amount off; the form calculates the final per-unit price.
    const bMin = parseInt(r.bulkDiscountMinQty, 10);
    if (Number.isInteger(bMin) && bMin >= 2) out.bulkDiscountMinQty = Math.min(bMin, 10000);
    const bOff = parseFloat(String(r.bulkDiscountOff == null ? '' : r.bulkDiscountOff).replace(/[^\d.]/g, ''));
    if (Number.isFinite(bOff) && bOff > 0) out.bulkDiscountOff = bOff;
    const bPrice = parseFloat(String(r.bulkDiscountPrice == null ? '' : r.bulkDiscountPrice).replace(/[^\d.]/g, ''));
    if (Number.isFinite(bPrice) && bPrice > 0) out.bulkDiscountPrice = bPrice;
  }

  if (t === 'service') {
    const sc = matchList(SERVICE_CATEGORIES, r.category);
    if (sc) out.category = sc;
    const st = matchList(SERVICE_TYPES, r.serviceType);
    if (st) out.serviceType = st;
    const loc = clean(r.location, 80);
    if (loc) out.location = loc;
  } else {
    const c = matchList(AD_CATEGORIES, r.category);
    if (c) out.category = c;
    if (t === 'regular') {
      const key = String(r.location == null ? '' : r.location).trim().toLowerCase();
      const loc = matchList(NIGERIAN_STATES, r.location) || LOCATION_ALIASES[key] || '';
      if (loc) out.location = loc;
    }
  }
  return out;
}

const SKIPPABLE_STEPS = ['discount', 'servicePrice', 'digitalCaption'];

async function prepareAdForm(ctx, args) {
  const fields = normalizeAdFields(args || {}, 'regular');
  const skipStep = SKIPPABLE_STEPS.includes(args?.skipStep) ? args.skipStep : null;
  if (!Object.keys(fields).length && !skipStep) {
    const e = new Error('No valid fields to fill. Ask the user for the missing details.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }
  // The form validates this too, but a discount at or above the regular price
  // can never be valid. Reject it here so the model gets a clear error.
  if (fields.price && fields.bulkDiscountPrice && fields.bulkDiscountPrice >= fields.price) {
    const e = new Error('The bulk discount price must be below the regular price.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }
  if (fields.price && fields.bulkDiscountOff && fields.bulkDiscountOff >= fields.price) {
    const e = new Error('The discount amount must be below the regular price.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }
  // Three sources, freshest last: what earlier turns filled (the validated
  // draft), what the phone reported before this turn, and what this patch
  // writes now. The model sees the result in the same turn (the tool result
  // feeds the next model call), so a reply written after a fill can never ask
  // for the value it just received — the "tell me the price" loop stops here.
  const draft = ctx?.adDraft && typeof ctx.adDraft === 'object' ? ctx.adDraft : {};
  const phone = ctx?.listing && typeof ctx.listing === 'object' ? ctx.listing : {};
  const type = selling.cleanType(fields.postType) || selling.cleanType(phone.postType)
    || selling.cleanType(draft.postType) || 'regular';
  const after = {
    ...selling.flagsForFields(type, draft),
    ...phone,
    ...selling.flagsForFields(type, fields),
  };
  const asked = Array.isArray(ctx?.sellingAsked) ? ctx.sellingAsked : [];
  if (skipStep) asked.push(skipStep);
  const next = selling.nextStep(type, after, asked);

  return {
    fields,
    // The phone's form state after this patch: the model must not ask for these
    // again, and `next` is the only question it may ask.
    filled: Object.keys(fields),
    remaining: next.missing,
    nextStep: next.step,
    nextAsk: next.ask,
    complete: next.done,
    ...(skipStep ? { skipStep } : {}),
    note: skipStep
      ? `That optional step was skipped. Ask only: "${next.ask}"`
      : `Saved: ${Object.keys(fields).join(', ') || 'nothing'}. `
        + (next.done
          ? 'The listing is complete. Tell them they can tap Publish/Post now, and ask once whether they want the filled details read back first. Do not read the details unless they say yes.'
          : `Now ask only: "${next.ask}"`),
  };
}

// ── fillRequestForm ──────────────────────────────────────────────────────────

function normalizeRequestPatch(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const cat = matchList(REQUEST_CATEGORIES, r.category);
  if (cat) out.category = cat;
  const text = String(r.text == null ? '' : r.text).trim().slice(0, 500);
  if (text) out.text = text;
  if (r.budget != null && r.budget !== '') {
    const n = parseFloat(String(r.budget).replace(/[^\d.]/g, ''));
    if (!isNaN(n) && n >= 0) out.budget = n;
  }
  const loc = clean(r.location, 80);
  if (loc) out.location = loc;
  return out;
}

async function fillRequestForm(_ctx, args) {
  const fields = normalizeRequestPatch(args || {});
  if (!Object.keys(fields).length) {
    const e = new Error('No valid request fields. Ask what they need, and the budget if any.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }
  return {
    fields,
    note: 'Fields applied to the request form. The user still has to review and post it.',
  };
}

// ── fillProfileForm ──────────────────────────────────────────────────────────

function normalizeProfilePatch(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  const first = clean(r.firstName, 60);
  if (first) out.firstName = first;
  const last = clean(r.lastName, 60);
  if (last) out.lastName = last;
  const bio = String(r.bio == null ? '' : r.bio).trim().slice(0, 500);
  if (bio) out.bio = bio;
  const state = matchList(NIGERIAN_STATES, r.state);
  if (state) out.state = state;
  const city = clean(r.city, 50);
  if (city) out.city = city;
  // Deliberately excluded: phone, bank, password, photo. Those stay manual.
  return out;
}

async function fillProfileForm(_ctx, args) {
  const fields = normalizeProfilePatch(args || {});
  if (!Object.keys(fields).length) {
    const e = new Error('No valid profile fields. Ask for a name, bio, state or city.');
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }
  return {
    fields,
    note: 'Fields applied to the profile form. The user still has to review and tap Save.',
  };
}

// ── prepareRegistration ──────────────────────────────────────────────────────
//
// Voice-first sign-up: the assistant may pre-fill the harmless part of the
// register form (name, email, referral code) so a user who cannot type
// comfortably does not have to. It never receives, repeats or sets a password,
// and it cannot complete the email verification step. Those stay with the user.
// Keeping the password out of the patch also means it never leaves the device,
// not even to our own server.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^0[789][01]\d{8}$/;

function normalizeNgPhone(value) {
  let digits = String(value == null ? '' : value).replace(/[^\d+]/g, '');
  if (digits.startsWith('+234')) digits = '0' + digits.slice(4);
  else if (digits.startsWith('234') && digits.length === 13) digits = '0' + digits.slice(3);
  else if (/^[789][01]\d{8}$/.test(digits)) digits = '0' + digits;
  return PHONE_RE.test(digits) ? digits : '';
}

function normalizeRegistrationPatch(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  // The assistant collects one full name question. Split it here so the
  // server's existing first/last fields stay the source of truth.
  const fullName = clean(r.fullName, 120);
  if (fullName) {
    const parts = fullName.split(/\s+/).filter(Boolean);
    if (parts.length) {
      out.firstName = parts[0].slice(0, 60);
      if (parts.length > 1) out.lastName = parts.slice(1).join(' ').slice(0, 60);
    }
  }

  const first = clean(r.firstName, 60);
  if (first) out.firstName = first;
  const last = clean(r.lastName, 60);
  if (last) out.lastName = last;

  const email = String(r.email == null ? '' : r.email).trim().toLowerCase().slice(0, 254);
  if (email && EMAIL_RE.test(email)) out.email = email;

  const phone = normalizeNgPhone(r.phoneNumber);
  if (phone) out.phoneNumber = phone;

  // Same shape the register screen / backend referral service accepts.
  const ref = String(r.referrer == null ? '' : r.referrer).trim();
  if (/^[A-Za-z0-9_-]{1,64}$/.test(ref)) out.referrer = ref;

  // Excluded on purpose: password. It is entered once on the phone's secure
  // keyboard and is never part of a patch or a model request.
  return out;
}

async function prepareRegistration(_ctx, args) {
  const raw = args && typeof args === 'object' ? args : {};
  const fields = normalizeRegistrationPatch(raw);
  const noEmail = raw.noEmail === true;

  // A partial email or phone is not saved, but the model must hear why so it
  // can help the user finish it instead of silently asking again.
  const rawEmail = String(raw.email == null ? '' : raw.email).trim();
  if (rawEmail && !EMAIL_RE.test(rawEmail.toLowerCase())) {
    const e = new Error(
      'That email is not complete yet. Ask them to say it again slowly, one part at a time: '
      + 'the name, then "at", then the mail service, then "dot com" or the ending. Never invent a domain.'
    );
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }
  const rawPhone = String(raw.phoneNumber == null ? '' : raw.phoneNumber).trim();
  if (rawPhone && !normalizeNgPhone(rawPhone)) {
    const e = new Error(
      'That phone number is not complete. Ask them to say the 11 digits again, starting with zero. '
      + 'Never guess or add a missing digit.'
    );
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }

  if (!Object.keys(fields).length && !noEmail) {
    const e = new Error(
      'No usable sign-up fields. Ask for their full name, then an email address or a phone number.'
    );
    e.code = 'TOOL_BAD_ARGS';
    throw e;
  }

  // Keep the same-turn context current so a beginAuthHelp call that follows in
  // this turn does not ask for a field that was just supplied. Only booleans
  // and names are mirrored here; the phone and email values stay in `fields`.
  if (_ctx && typeof _ctx === 'object') {
    if (fields.firstName && fields.lastName) {
      _ctx.registerDraft = {
        ...(_ctx.registerDraft || {}),
        fullName: `${fields.firstName} ${fields.lastName}`,
        firstName: fields.firstName,
        lastName: fields.lastName,
      };
    } else if (fields.firstName || fields.lastName) {
      _ctx.registerDraft = {
        ...(_ctx.registerDraft || {}),
        ...(fields.firstName ? { firstName: fields.firstName } : {}),
        ...(fields.lastName ? { lastName: fields.lastName } : {}),
      };
    }
    if (fields.email) _ctx.emailProvided = true;
    if (fields.phoneNumber) _ctx.phoneProvided = true;
    if (noEmail) _ctx.emailDeclined = true;
  }

  let note = 'I filled what you gave me.';

  // What the register screen holds after this patch, computed the same way on
  // every turn. The reply after a fill therefore names the real next step and
  // can never claim a saved field is still missing.
  const snap = _ctx?.registration && typeof _ctx.registration === 'object'
    ? _ctx.registration
    : {};
  const draft = _ctx?.registerDraft && typeof _ctx.registerDraft === 'object'
    ? _ctx.registerDraft
    : {};
  const hasName = !!(fields.firstName && fields.lastName)
    || (snap.firstName === true && snap.lastName === true)
    || !!(draft.firstName && draft.lastName)
    || !!(draft.fullName && String(draft.fullName).trim().split(/\s+/).length >= 2);
  const hasEmail = !!fields.email || !!_ctx?.emailProvided || snap.email === true;
  const hasPhone = !!fields.phoneNumber || !!_ctx?.phoneProvided || snap.phone === true;
  const declined = noEmail || !!_ctx?.emailDeclined || snap.emailDeclined === true;
  const passwordSet = !!_ctx?.passwordSet || snap.password === true;
  const agreed = !!_ctx?.agreed || snap.agreed === true;

  if (noEmail) note += ' They have no email, so ask for their phone number next.';

  const remaining = [];
  if (!hasName) remaining.push('full name');
  if (!hasEmail && !hasPhone && !declined) remaining.push('email or phone number');
  if (!passwordSet) remaining.push('secret code (on the screen, never in chat)');
  if (!agreed) remaining.push('agree to the terms (on the screen)');
  const nextAction = remaining[0] || 'confirm account';

  // The exact order from the walkthrough. The email question comes before the
  // phone: only a "no" moves the user to the phone field.
  let nextAsk;
  if (!hasName) {
    nextAsk = fields.firstName && !fields.lastName
      ? 'Thank you. What is your last name?'
      : 'What is your full name, first and last?';
  } else if (!hasEmail && !declined) {
    nextAsk = 'Do you have an email? It can be Google, Yahoo, or any other email.';
  } else if (!hasEmail && !hasPhone) {
    nextAsk = 'What phone number should we use? It can be MTN, Airtel, Glo, or any other network.';
  } else if (!passwordSet) {
    nextAsk = 'Now choose your secret code on the screen. Use at least eight characters, with a letter and a number, '
      + 'and never share it with anyone. You can type one or use the suggested code.';
  } else if (!agreed) {
    nextAsk = 'Now read the Privacy Policy and Terms and Conditions. Tick the box only if you agree, then tell me when it is done.';
  } else {
    nextAsk = 'Your details are ready. Ask them to tap the microphone and say register me, '
      + 'or tell you which detail to change.';
  }

  // The name step is the one moment the user hears their own name back. It
  // works when the first and last name arrive in the same turn or in two, and
  // it never repeats once the name is complete.
  const draftName = [draft.firstName, draft.lastName].filter(Boolean).join(' ').trim();
  const fullName = fields.firstName && fields.lastName
    ? `${fields.firstName} ${fields.lastName}`
    : (draftName || draft.fullName || '');
  const nameJustCompleted = !!(fullName && hasName && (fields.firstName || fields.lastName));
  const welcome = nameJustCompleted ? `Welcome ${fullName}.` : null;

  // A phone number is the one value a person cannot see themselves type when
  // they speak it, so the model reads it back before the next step.
  const readBackPhone = fields.phoneNumber
    ? `Read the number back once ("${fields.phoneNumber}") and let them correct any digit. `
    : '';

  return {
    fields,
    filled: Object.keys(fields),
    remaining,
    nextAction,
    nextAsk,
    ...(welcome ? { welcome } : {}),
    note: `${note} Saved: ${Object.keys(fields).join(', ') || 'nothing'}. `
      + readBackPhone
      + (welcome ? `Say "${welcome}" first, then ask only: "${nextAsk}". ` : '')
      + (remaining.length
        ? `The only thing left is: ${remaining.join(', ')}.`
        : 'Everything on this form is done. Let them confirm, then the phone shows the final button.'),
    // Short line for the phone's assistant card. Never contains a password.
    say: welcome ? `${welcome} ${nextAsk}` : nextAsk,
    ...(noEmail ? { emailDeclined: true } : {}),
    // These are never part of `fields`, so the model can never report that it
    // filled a password or accepted the agreement for the user.
    manualSteps: ['password', 'agreement', 'confirm', 'create_account'],
  };
}

// ── requestListingPhoto ────────────────────────────────────────────────────
//
// A photo or digital file cannot travel through a text patch, and the user
// chooses it. The model calls this only after the user agrees to pick one; the
// client opens its existing picker, and the next turn's form snapshot shows
// whether anything was selected. If the user cancels, the snapshot flag stays
// false and the model asks again instead of assuming a picture was added.

async function requestListingPhoto(_ctx, args) {
  const kind = args && args.kind === 'digitalFile' ? 'digitalFile'
    : args && args.kind === 'camera' ? 'camera' : 'photo';
  return {
    kind,
    note: kind === 'digitalFile'
      ? 'Ask the user to choose the file on their phone now.'
      : kind === 'camera'
        ? 'Ask the user to get the item ready — the phone opens the camera now.'
        : 'Ask the user to choose a photo on their phone now.',
  };
}

/**
 * Explain a listing post failure in one short spoken sentence.
 *
 * `code` is a fixed allowlist (photo_missing, price_invalid,
 * quantity_invalid, field_missing, content_blocked, network_unavailable,
 * publish_failed). Raw backend messages are never passed through. Unknown
 * codes get the generic guidance, never an invented diagnosis.
 */
function explainListingError(ctx, { code } = {}) {
  return selling.explainListingError(code);
}

module.exports = {
  prepareAdForm,
  fillRequestForm,
  fillProfileForm,
  prepareRegistration,
  requestListingPhoto,
  explainListingError,
  // Exposed for tests
  _internal: {
    normalizeAdFields,
    normalizeRequestPatch,
    normalizeProfilePatch,
    normalizeRegistrationPatch,
  },
};