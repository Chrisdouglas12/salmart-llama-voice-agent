'use strict';

/**
 * Keyless tests for the AI form-fill bridge.
 *
 * These exercise the pure normalisers that turn model output into the exact
 * values CreateAdScreen / CreateRequestScreen / EditProfileScreen already
 * accept. No Mongo, no provider key, no network.
 *
 * Run: node --test tests/ai-form-tools.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prepareAdForm,
  fillRequestForm,
  fillProfileForm,
  prepareRegistration,
  _internal,
} = require('../services/ai/tools/formTools.js');

const {
  normalizeAdFields,
  normalizeRequestPatch,
  normalizeProfilePatch,
  normalizeRegistrationPatch,
} = _internal;

test('ad form: Nigerian aliases become exact screen values', () => {
  const fields = normalizeAdFields({
    title: '  iPhone 13 Pro  ',
    price: '₦450,000',
    quantity: '2',
    category: 'Electronics',
    condition: 'tokunbo',
    location: 'abuja',
  });

  assert.equal(fields.title, 'iPhone 13 Pro');
  assert.equal(fields.price, 450000);
  assert.equal(fields.quantity, 2);
  assert.equal(fields.category, 'electronics');
  assert.equal(fields.condition, 'Good');
  assert.equal(fields.location, 'FCT - Abuja');
});

test('ad form: service listings keep service category and type', () => {
  const fields = normalizeAdFields({
    postType: 'service',
    title: 'Phone repair',
    price: '15000',
    category: 'repair',
    serviceType: 'onsite',
    location: 'Lagos',
  });

  assert.equal(fields.postType, 'service');
  assert.equal(fields.category, 'repair');
  assert.equal(fields.serviceType, 'onsite');
  assert.equal(fields.location, 'Lagos');
  assert.equal(fields.condition, undefined);
});

test('ad form: unknown category/location are dropped, never guessed', () => {
  const fields = normalizeAdFields({
    title: 'Generator',
    price: 80000,
    category: 'spaceships',
    location: 'Atlantis',
  });

  assert.equal(fields.title, 'Generator');
  assert.equal(fields.category, undefined);
  assert.equal(fields.location, undefined);
});

test('ad form: bulk discount fields pass through for regular posts', () => {
  const fields = normalizeAdFields({
    title: 'Rice bags',
    bulkDiscountMinQty: '5',
    bulkDiscountOff: '500',
  });
  assert.equal(fields.bulkDiscountMinQty, 5);
  assert.equal(fields.bulkDiscountOff, 500);
});

test('ad form: skipStep records a declined optional step without fields', async () => {
  const res = await prepareAdForm({ userId: 'u1' }, { skipStep: 'discount' });
  assert.equal(res.skipStep, 'discount');
  await assert.rejects(
    () => prepareAdForm({ userId: 'u1' }, { skipStep: 'photo' }),
    (err) => err.code === 'TOOL_BAD_ARGS'
  );
});

test('listing photo: gallery, camera, and file kinds are accepted', async () => {
  const { requestListingPhoto } = require('../services/ai/tools/formTools.js');
  assert.equal((await requestListingPhoto({}, { kind: 'photo' })).kind, 'photo');
  assert.equal((await requestListingPhoto({}, { kind: 'camera' })).kind, 'camera');
  assert.equal((await requestListingPhoto({}, { kind: 'digitalFile' })).kind, 'digitalFile');
  assert.equal((await requestListingPhoto({}, {})).kind, 'photo');
});

test('ad form: empty patch is rejected instead of silently applied', async () => {
  await assert.rejects(
    () => prepareAdForm({ userId: 'u1' }, {}),
    (err) => err.code === 'TOOL_BAD_ARGS'
  );
});

test('request form: only allowlisted categories and numeric budget', () => {
  const fields = normalizeRequestPatch({
    category: 'fashion',
    text: '  Looking for a size 42 sneaker ',
    budget: '25,000',
    location: 'Lagos',
  });

  assert.deepEqual(fields, {
    category: 'fashion',
    text: 'Looking for a size 42 sneaker',
    budget: 25000,
    location: 'Lagos',
  });

  assert.deepEqual(normalizeRequestPatch({ category: 'spaceships' }), {});
});

test('profile form: sensitive fields are never part of the patch', () => {
  const fields = normalizeProfilePatch({
    firstName: ' Ada ',
    lastName: 'Okafor',
    bio: '  I sell phones.  ',
    state: 'Lagos',
    city: 'Ikeja',
    phone: '08000000000',
    password: 'hunter2',
    bankAccount: '1234567890',
    profilePicture: 'https://example.com/x.jpg',
  });

  assert.deepEqual(fields, {
    firstName: 'Ada',
    lastName: 'Okafor',
    bio: 'I sell phones.',
    state: 'Lagos',
    city: 'Ikeja',
  });
  assert.equal('phone' in fields, false);
  assert.equal('password' in fields, false);
  assert.equal('bankAccount' in fields, false);
  assert.equal('profilePicture' in fields, false);
});

test('request/profile handlers reject an empty patch', async () => {
  await assert.rejects(
    () => fillRequestForm({ userId: 'u1' }, {}),
    (err) => err.code === 'TOOL_BAD_ARGS'
  );
  await assert.rejects(
    () => fillProfileForm({ userId: 'u1' }, {}),
    (err) => err.code === 'TOOL_BAD_ARGS'
  );
});

test('registration: no password or agreement ever enters the patch', () => {
  const fields = normalizeRegistrationPatch({
    firstName: ' Ada ',
    lastName: 'Okafor',
    email: ' ADA@EXAMPLE.COM ',
    referrer: 'ref_42',
    password: 'hunter2',
    confirm: 'hunter2',
    phoneNumber: '08000000000',
    agreed: true,
  });

  assert.deepEqual(fields, {
    firstName: 'Ada',
    lastName: 'Okafor',
    email: 'ada@example.com',
    phoneNumber: '08000000000',
    referrer: 'ref_42',
  });
  assert.equal('password' in fields, false);
  assert.equal('confirm' in fields, false);
  assert.equal('agreed' in fields, false);
});

test('registration: invalid email is dropped instead of filled', () => {
  assert.deepEqual(
    normalizeRegistrationPatch({ firstName: 'Ada', email: 'not-an-email' }),
    { firstName: 'Ada' }
  );
  assert.deepEqual(normalizeRegistrationPatch({ email: '' }), {});
});

test('registration: handler rejects an empty patch and states manual steps', async () => {
  await assert.rejects(
    () => prepareRegistration({}, { password: 'hunter2' }),
    (err) => err.code === 'TOOL_BAD_ARGS'
  );

  const res = await prepareRegistration({}, {
    firstName: 'Ada',
    lastName: 'Okafor',
    email: 'ada@example.com',
  });
  assert.equal(res.fields.email, 'ada@example.com');
  assert.equal('password' in res.fields, false);
  assert.deepEqual(res.manualSteps, ['password', 'agreement', 'create_account']);
});
