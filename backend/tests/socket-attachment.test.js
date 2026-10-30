'use strict';

/**
 * Regression: photo messages were dropped inside the socket handler because
 * clients send `attachment.fileType` while the Message schema requires
 * `attachment.type`. Mongoose failed validation, the sender got "Server error"
 * and nothing was delivered. normaliseAttachment bridges both spellings.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { normaliseAttachment } = require('../routes/socketRoutes');
const Message = require('../models/messageSchema');

describe('socket attachment normalisation', () => {
  it('accepts the legacy fileType spelling used by web and mobile', () => {
    const out = normaliseAttachment({ url: 'https://cdn.example/bag.jpg', fileType: 'image' }, 'image');
    assert.equal(out.type, 'image');
    assert.equal(out.url, 'https://cdn.example/bag.jpg');
    assert.equal(out.fileType, undefined);
  });

  it('keeps an explicit type untouched', () => {
    const given = { url: 'https://cdn.example/doc.pdf', type: 'file' };
    assert.deepEqual(normaliseAttachment(given, 'document'), given);
  });

  it('maps non-image attachments to file and receipts to receipt', () => {
    assert.equal(normaliseAttachment({ url: 'u1', fileType: 'document' }, 'document').type, 'file');
    assert.equal(normaliseAttachment({ url: 'u2' }, 'document').type, 'file');
    assert.equal(normaliseAttachment({ url: 'u3', fileType: 'receipt' }, 'image').type, 'receipt');
  });

  it('leaves url-less attachments (location) alone', () => {
    const loc = { latitude: 6.5, longitude: 3.3 };
    assert.deepEqual(normaliseAttachment(loc, 'location'), loc);
  });

  it('a normalised image attachment now passes schema validation', () => {
    const legacy = { url: 'https://cdn.example/bag.jpg', fileType: 'image', cloudinaryPublicId: 'abc' };
    const doc = new Message({
      senderId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      receiverId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      text: 'Hello, is this bag still available?',
      messageType: 'image',
      attachment: normaliseAttachment(legacy, 'image'),
      status: 'sent',
    });
    assert.equal(doc.validateSync(), undefined);
    assert.equal(doc.attachment.type, 'image');
    assert.equal(doc.attachment.cloudinaryPublicId, 'abc');
  });

  it('the raw legacy attachment is what used to fail validation', () => {
    const doc = new Message({
      senderId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      receiverId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      text: 'photo',
      messageType: 'image',
      attachment: { url: 'https://cdn.example/bag.jpg', fileType: 'image' },
      status: 'sent',
    });
    const err = doc.validateSync();
    assert.ok(err && err.errors['attachment.type'], 'expected a missing attachment.type error');
  });
});
