'use strict';

/**
 * routes/aiFormBridge.js
 *
 * Mounted at /api/ai/forms in app.js:
 *   app.use('/api/ai/forms', require('./routes/aiFormBridge.js'));
 *
 * One endpoint: POST /drain. The 3 native form screens (CreateAdScreen,
 * CreateRequestScreen, EditProfileScreen) call this on mount and on focus.
 * If a patch was queued by a turn that ran while the screen was unmounted,
 * the drain returns it once and deletes it. Subsequent calls return null.
 *
 * Auth-required. Ownership is derived from the JWT only — the target is
 * validated against an allowlist so a screen cannot ask for someone else's
 * patch.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const verifyToken = require('../middleware/auths');
const pendingFormPatch = require('../services/ai/pendingFormPatch');
const logger = require('../services/logger');

const router = express.Router();

const drainLimiter = rateLimit({
  windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please wait a moment.' },
});

const ALLOWED_TARGETS = new Set(['createAd', 'createRequest', 'editProfile', 'register']);

router.post('/drain', verifyToken, drainLimiter, async (req, res) => {
  try {
    const { target } = req.body || {};
    if (!target || !ALLOWED_TARGETS.has(target)) {
      return res.status(400).json({ success: false, message: 'Unknown form target.' });
    }
    const patch = await pendingFormPatch.drain({ userId: req.user.userId, target });
    if (!patch) return res.json({ success: true, patch: null });
    return res.json({
      success: true,
      patch: {
        fields: patch.fields,
        say: patch.say || null,
        createdAt: patch.createdAt,
      },
    });
  } catch (err) {
    logger.error(`[aiFormBridge] drain failed: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Could not read pending form patch.' });
  }
});

module.exports = router;