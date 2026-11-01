'use strict';

/**
 * app.js — Salmart server entry point.
 *
 * CART WIRING (fixes the 404 on GET /api/cart):
 *   - Added `const cartRoutes = require('./routes/cartRoutes.js');`
 *   - Added `app.use('/api/cart', cartRoutes);` in the route-registration block.
 *
 * The cart router was written to be mounted at /api/cart (see its own header
 * comment) but was never registered, so every /api/cart request fell through
 * to the 404 handler. Both lines are marked `CART WIRING` below.
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const winston = require('winston');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const compression = require('compression');
const helmet = require('helmet');
const MongoStore = require('connect-mongo').default;
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
require('dotenv').config();

// ─────────────────────────────────────────────
// LOG SCOPE
// ─────────────────────────────────────────────
// Only the AI interaction log is wanted right now. Set LOG_SCOPE=all to get
// the old firehose back. Boot and Mongo lines always survive, and warnings and
// errors are never dropped, so a real failure still shows up.
const LOG_SCOPE = String(process.env.LOG_SCOPE || 'ai').trim().toLowerCase();
const LOG_EVERYTHING = LOG_SCOPE === 'all';
const STARTUP_LOG_RE = /(mongo|mongoose|server (is )?running|now listening|listening on|firebase admin|meta model api|redis (connected|ready)|connected to redis|log scope|node version|startup)/i;

if (!LOG_EVERYTHING) {
  // console.log/info/debug bypass winston, so the filter has to sit here too.
  // Some modules log through console directly; without this they would still
  // flood the output.
  for (const level of ['log', 'info', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const line = args.map(a => (typeof a === 'string' ? a : '')).join(' ');
      if (STARTUP_LOG_RE.test(line)) original(...args);
    };
  }
}

// Models
const User = require('./models/userSchema.js');
const Post = require('./models/postSchema.js');
const Notification = require('./models/notificationSchema.js');
const Message = require('./models/messageSchema.js');

// Routes
const userRoutesIndex = require('./routes/userRoutesIndex.js');
const userRoutesCore = require('./routes/userRoutesCore.js');
const userRoutesAuths = require('./routes/userRoutesAuths.js');
const userRoutesInteractive = require('./routes/userRoutesInteractive.js');
const postRoutes = require('./routes/postRoutes.js');
const postRoutes_2 = require('./routes/postRoutes_2.js');
const postRoutes_3 = require('./routes/postRoutes_3.js');
const requestRoutes = require('./routes/requestRoutes.js');
const notificationRoutes = require('./routes/notificationRoutes.js');
const messageRoutes = require('./routes/messageRoutes.js');
const paymentRoutes = require('./routes/paymentRoutes.js');
const transactionRoutes = require('./routes/transactionRoutes.js');
const adminRoutes = require('./routes/adminRoutes.js');
const adminRoutes1 = require('./routes/adminRoutes1.js');
const promoteRoutes = require('./routes/promoteRoutes.js');
const cleanupPromotions = require('./cron/promotionCleanUp.js');
const { initializeSocket } = require('./routes/socketRoutes.js');
const referralRoutes = require('./routes/referralRoutes');
const { startPromotionalCron } = require('./services/promotionalNotification');
const { startRecommendationCron } = require('./services/productRecommendationCron');
const { startEngagementCron } = require('./services/engagementNotificationService');
const chinaPayoutRoutes = require('./routes/chinaPayoutRoutes.js');

const profileMetaRoutes = require('./routes/profileMeta');
const groupRoutes = require('./routes/groupRoutes')
const groupListingRoute = require('./routes/groupListingRoute')
const { startShowroomExpiryJob } = require('./cron/showRoomCron');
const { startRequestExpiryJob } = require('./cron/requestExpiryCron');
const showroomRoutes = require('./routes/showroomRoutes');
const forumRoutes = require('./routes/forumRoutes');
const recommendedRoutes = require('./routes/recommendedRoutes');
const billboardRoutes = require('./routes/billboardRoutes');
const searchRoutes = require('./routes/searchRoutes.js');
const assistantRoutes = require('./routes/assistantRoutes.js');
const cartRoutes = require('./routes/cartRoutes.js'); 
const aiRoutes = require('./routes/aiRoutes.js');
const aiFormBridge = require('./routes/aiFormBridge.js');


// ─────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────
// Only boot, Mongo and failure lines reach the server log (see LOG_SCOPE).
// Everything else here would compete with the AI log, which is the one this
// build cares about.
const keepServerLog = winston.format((info) => {
  const level = String(info.level || '').toLowerCase();
  if (level === 'warn' || level === 'error' || level === 'fatal') return info;
  const msg = typeof info.message === 'string' ? info.message : String(info.message || '');
  return STARTUP_LOG_RE.test(msg) ? info : false;
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    keepServerLog(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/server.log' }),
    new winston.transports.Console()
  ]
});

logger.info(`Log scope: ${LOG_EVERYTHING ? 'all' : 'ai only'} (set LOG_SCOPE=all for every request log)`);

// ─────────────────────────────────────────────
// FIREBASE ADMIN SDK
// ─────────────────────────────────────────────
try {
  const firebaseKey = Buffer.from(process.env.FIREBASE_ADMIN_KEY_BASE64, 'base64').toString('utf8');
  const serviceAccount = JSON.parse(firebaseKey);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://salmart-330ab.firebaseio.com'
  });
  logger.info('✅ Firebase Admin SDK initialized successfully');
} catch (error) {
  // console.error is synchronous, so it prints before process.exit (winston is async and was swallowed)
  console.error(`❌ Firebase Admin SDK initialization failed: ${error.message}`);
  logger.error(`❌ Firebase Admin SDK initialization failed: ${error.message}`);
  process.exit(1);
}

// ─────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────
const app = express();

app.get('/.well-known/assetlinks.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: 'com.salmartTech.salmart',
      sha256_cert_fingerprints: [
        'D5:3D:0B:29:A7:D6:2A:B2:66:A4:9A:4E:2D:9B:5E:E4:E6:2E:A0:9A:CF:2A:0C:12:F0:1D:E1:E9:D6:77:74:1D'
      ]
    }
  }]);
});

// ─────────────────────────────────────────────
// CORE MIDDLEWARE
// ─────────────────────────────────────────────
app.use(helmet());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

app.use(cors({
  origin: [
    'http://localhost:8158',
    'http://localhost:5500',
    'http://localhost:5501',
    'http://localhost:3000',
    'https://salmart.onrender.com',
    'https://salmart.vercel.app',
    'https://res.cloudinary.com',
    'https://cloudinary.com',
    'https://salmartonline.com.ng',
    'http://10.0.2.2:3000',
    'null'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'x-media-type'],
}));

app.use((req, res, next) => {
  logger.info(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ─────────────────────────────────────────────
// RATE LIMITING - REMOVED FOR NOW
// Will be re-implemented when user base grows
// TODO: Add back rate limiting with proper thresholds
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// SESSION & PASSPORT  (must come before routes)
// ─────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'salmart_session_secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: 'sessions'
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 10 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// ─────────────────────────────────────────────
// PASSPORT — GOOGLE STRATEGY
// ─────────────────────────────────────────────
passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.NODE_ENV === 'production'
      ? 'https://salmart.onrender.com/auth/google/callback'
      : 'http://localhost:3000/auth/google/callback',
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email) return done(new Error('No email returned from Google'), null);

      let user = await User.findOne({
        $or: [{ googleId: profile.id }, { email }]
      });

      if (user) {
        if (!user.googleId) {
          user.googleId = profile.id;
          user.authProvider = 'google';
          user.isVerified = true;
          await user.save();
        }
        return done(null, user);
      }

      const googleFirstName = profile.name?.givenName || profile.displayName?.split(' ')[0] || '';
      const googleLastName = profile.name?.familyName || '';

      user = new User({
        googleId: profile.id,
        email,
        authProvider: 'google',
        isVerified: true,
        isProfileComplete: false,
        firstName: googleFirstName || 'User',
        lastName: googleLastName || 'Pending',
        password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      });

      await user.save();
      logger.info(`✅ New Google user created: ${email}`);
      return done(null, user);

    } catch (err) {
      const oauthDetail = err.oauthError ? (typeof err.oauthError.data === 'string' ? err.oauthError.data : JSON.stringify(err.oauthError.data || {})) : '';
      logger.error(`❌ Google Strategy error: ${err.message}${oauthDetail ? ` — ${oauthDetail}` : ''}${err.stack ? `\n${err.stack}` : ''}`);
      return done(err, null);
    }
  }
));

passport.serializeUser((user, done) => {
  done(null, user._id.toString());
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

// ─────────────────────────────────────────────
// GOOGLE AUTH ROUTES
// ─────────────────────────────────────────────
const FRONTEND_URL = process.env.NODE_ENV === 'production'
  ? 'https://salmartonline.com.ng'
  : 'http://localhost:5500';

// ── SINGLE /auth/google initiator ───────────────────────────────
app.get('/auth/google', (req, res, next) => {
  const source   = req.query.source;
  const platform = req.query.platform;
  const refCode  = req.query.ref || null;

  // Encode state as  "web"  |  "mobile_app"  |  "web|REF_CODE"  |  "mobile_app|REF_CODE"
  // so the callback can always split on "|" to recover both parts
  const base  = source === 'mobile' ? `mobile_${platform || 'app'}` : 'web';
  const state = refCode ? `${base}|${encodeURIComponent(refCode)}` : base;

  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state,
  })(req, res, next);
});

// ── /auth/google/callback ────────────────────────────────────────
app.get('/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: `${FRONTEND_URL}/#/register?error=google_failed`,
    session: true,
  }),
  async (req, res) => {
    try {
      const user  = req.user;
      const state = req.query.state || 'web';

      // Parse state — format is "base"  or  "base|REF_CODE"
      const [base, encodedRef] = state.split('|');
      const isMobileApp        = base.startsWith('mobile');
      const refCode            = encodedRef ? decodeURIComponent(encodedRef) : null;

      logger.info(`📱 OAuth callback — base: "${base}", ref: "${refCode || 'none'}", isMobileApp: ${isMobileApp}, user: ${user.email}`);

      // Link referral for brand-new Google users
      // `user._isNew` isn't reliable with Passport, so we check isProfileComplete
      // which is only false on the very first OAuth login
      if (refCode && !user.isProfileComplete) {
        try {
          const { linkReferral } = require('./services/referralService');
          await linkReferral(user._id, refCode);
          logger.info(`🔗 Referral linked for Google user ${user.email} via code "${refCode}"`);
        } catch (refErr) {
          // Non-fatal — don't block the login
          logger.error(`[google/callback] referral link failed (non-fatal): ${refErr.message}`);
        }

        // Also ensure the new Google user gets their own referral code
        try {
          const { ensureReferralCode } = require('./services/referralService');
          await ensureReferralCode(user._id);
        } catch (refErr) {
          logger.error(`[google/callback] referral code gen failed (non-fatal): ${refErr.message}`);
        }
      }

      if (!user.isProfileComplete) {
        const googleFirstName = (user.firstName !== 'User'    && user.firstName !== '') ? user.firstName : '';
        const googleLastName  = (user.lastName  !== 'Pending' && user.lastName  !== '') ? user.lastName  : '';

        const setupToken = jwt.sign(
          {
            userId:          user._id,
            purpose:         'profile_setup',
            authProvider:    'google',
            googleFirstName,
            googleLastName,
          },
          process.env.JWT_SECRET,
          { expiresIn: '1h' }
        );

        logger.info(`🔀 New Google user ${user.email} → profile setup (mobile: ${isMobileApp})`);

        if (isMobileApp) {
          return res.redirect(`salmart://auth/callback?setup_token=${setupToken}`);
        }
        return res.redirect(`${FRONTEND_URL}/#/complete-profile?setup_token=${setupToken}`);
      }

      const token = jwt.sign(
        { userId: user._id, authProvider: 'google' },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
      );

      logger.info(`✅ Returning Google user ${user.email} — isMobileApp: ${isMobileApp}`);

      if (isMobileApp) {
        return res.redirect(
  `salmart://auth/callback` +
  `?token=${encodeURIComponent(token)}` +
  `&userId=${encodeURIComponent(user._id)}` +
  `&email=${encodeURIComponent(user.email || '')}` +
  `&firstName=${encodeURIComponent(user.firstName || '')}` +
  `&lastName=${encodeURIComponent(user.lastName || '')}` +
  `&profilePicture=${encodeURIComponent(user.profilePicture || '')}`
);
      }


return res.redirect(
  `${FRONTEND_URL}/app/app-redirect.html` +
  `?token=${encodeURIComponent(token)}` +
  `&userId=${encodeURIComponent(user._id)}` +
  `&email=${encodeURIComponent(user.email || '')}` +
  `&firstName=${encodeURIComponent(user.firstName || '')}` +
  `&lastName=${encodeURIComponent(user.lastName || '')}` +
  `&profilePicture=${encodeURIComponent(user.profilePicture || '')}`
);

    } catch (err) {
      logger.error(`❌ Google callback error: ${err.message}`);
      const isMobileApp = (req.query.state || '').split('|')[0].startsWith('mobile');
      if (isMobileApp) {
        return res.redirect(`salmart://auth/error?message=server_error`);
      }
      return res.redirect(`${FRONTEND_URL}/#/register?error=server_error`);
    }
  }
);

// ─────────────────────────────────────────────
// GOOGLE NATIVE SIGN-IN — idToken exchange
// The app (CONFIG.GOOGLE_AUTH_EXCHANGE_PATH) posts { idToken } here. Mirrors the
// Passport strategy: find/create the user, then return either a session token or
// a short-lived setup_token for a brand-new Google user.
// ─────────────────────────────────────────────
const { OAuth2Client } = require('google-auth-library');
const googleMobileClient = new OAuth2Client();
const GOOGLE_MOBILE_AUDIENCES = [
  process.env.GOOGLE_MOBILE_WEB_CLIENT_ID,
  '396604566472-n91niccvhda7o5duqjm6ps9kd1mdb63h.apps.googleusercontent.com',
].filter(Boolean);

app.post('/auth/google/mobile', async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) {
      return res.status(400).json({ success: false, message: 'idToken is required' });
    }

    let payload;
    try {
      const ticket = await googleMobileClient.verifyIdToken({
        idToken,
        audience: GOOGLE_MOBILE_AUDIENCES,
      });
      payload = ticket.getPayload();
    } catch (verifyErr) {
      logger.error(`❌ Google mobile idToken verify failed: ${verifyErr.message}`);
      return res.status(401).json({
        success: false,
        message: 'Google sign-in could not be verified. Please try again.',
      });
    }

    const email = payload && payload.email ? payload.email.toLowerCase() : null;
    if (!email || payload.email_verified === false) {
      return res.status(400).json({ success: false, message: 'Google account has no verified email.' });
    }

    let user = await User.findOne({ $or: [{ googleId: payload.sub }, { email }] });

    if (user) {
      if (!user.googleId) {
        user.googleId = payload.sub;
        user.authProvider = 'google';
        user.isVerified = true;
        await user.save();
      }
    } else {
      user = new User({
        googleId: payload.sub,
        email,
        authProvider: 'google',
        isVerified: true,
        isProfileComplete: false,
        firstName: payload.given_name || (payload.name ? payload.name.split(' ')[0] : '') || 'User',
        lastName: payload.family_name || 'Pending',
        password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      });
      await user.save();
      logger.info(`✅ New Google (mobile) user created: ${email}`);
    }

    if (!user.isProfileComplete) {
      const googleFirstName = (user.firstName !== 'User'    && user.firstName !== '') ? user.firstName : '';
      const googleLastName  = (user.lastName  !== 'Pending' && user.lastName  !== '') ? user.lastName  : '';
      const setupToken = jwt.sign(
        { userId: user._id, purpose: 'profile_setup', authProvider: 'google', googleFirstName, googleLastName },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      return res.json({ success: true, setup_token: setupToken, googleFirstName, googleLastName, email });
    }

    const token = jwt.sign(
      { userId: user._id, authProvider: 'google' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    const profile = {
      userId: user._id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      profilePicture: user.profilePicture || '',
    };
    return res.json({ success: true, token, ...profile, user: profile });

  } catch (err) {
    logger.error(`❌ Google mobile exchange error: ${err.message}`);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// PROFILE COMPLETION ENDPOINT
// ─────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';

let profileStorage;
if (isProduction) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  profileStorage = new CloudinaryStorage({
    cloudinary,
    params: { folder: 'profile_pictures', allowed_formats: ['jpg', 'png', 'jpeg', 'webp'] },
  });
} else {
  const uploadDir = path.join(__dirname, 'Uploads');
  const fs = require('fs');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  profileStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${path.extname(file.originalname)}`);
    },
  });
}

const profileUpload = multer({
  storage: profileStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.post('/auth/complete-profile', profileUpload.single('profilePicture'), async (req, res) => {
  try {
    const { setup_token, firstName, lastName, phoneNumber } = req.body;

    if (!setup_token) {
      return res.status(401).json({ success: false, message: 'Setup token is required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(setup_token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired setup token. Please sign in with Google again.',
      });
    }

    if (decoded.purpose !== 'profile_setup') {
      return res.status(401).json({ success: false, message: 'Invalid token purpose' });
    }

    if (!firstName?.trim()) {
      return res.status(400).json({ success: false, message: 'First name is required' });
    }

    const resolvedLastName = lastName?.trim() || decoded.googleLastName || `user_${decoded.userId.toString().slice(-5)}`;

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const updateData = {
      firstName: firstName.trim(),
      lastName: resolvedLastName,
      isProfileComplete: true,
    };

    if (phoneNumber?.trim()) {
      const phoneRegex = /^(\+234|0)[789][01]\d{8}$/;
      if (!phoneRegex.test(phoneNumber.trim())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid Nigerian phone number format',
        });
      }
      updateData.phoneNumber = phoneNumber.trim();
    }

    if (req.file) {
      updateData.profilePicture = isProduction
        ? req.file.path
        : `/Uploads/${req.file.filename}`;
    }

    await User.findByIdAndUpdate(decoded.userId, { $set: updateData }, { new: true });

    const token = jwt.sign(
      { userId: user._id, authProvider: 'google' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      message: 'Profile completed! Welcome to Salmart.',
      token,
      user: {
        userId: user._id,
        firstName: updateData.firstName,
        lastName: updateData.lastName,
        email: user.email,
      },
    });

  } catch (err) {
    logger.error(`❌ Complete profile error: ${err.message}`);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// STATIC FILES
// ─────────────────────────────────────────────
app.use('/Uploads', express.static(path.join(__dirname, 'Uploads')));
app.use('/receipts', express.static(path.join(__dirname, 'receipts')));
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// MONGODB
// ─────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  maxPoolSize: 20,
  minPoolSize: 5,
})
  .then(() => logger.info('✅ MongoDB connected successfully'))
  .catch((err) => {
    // console.error is synchronous, so it prints before process.exit
    console.error(`❌ MongoDB connection error: ${err.message}`);
    logger.error(`❌ MongoDB connection error: ${err.message}`);
    process.exit(1);
  });

mongoose.connection.once('open', async () => {
  await searchRoutes.setupSearchIndexes();
});

// ─────────────────────────────────────────────
// META MODEL API
// ─────────────────────────────────────────────
// Same idea as the MongoDB block above: one tiny live call at boot proves
// THIS machine reaches the model. Unlike Mongo, a failure never exits —
// Glimmer and the demo brain can still answer, and every later failure is
// logged per-turn with its requestId.
const { chatSelfTest } = require('./lib/assistant/llama.js');
chatSelfTest()
  .then((r) => {
    if (r.ok === true) {
      logger.info(`✅ Meta Model API connected successfully (model "${r.model}" replied "${r.reply}")`);
    } else if (r.ok === false) {
      logger.error(`❌ Meta Model API connection failed: model "${r.model}" status=${r.status} ${r.message}`);
      console.error(`❌ Meta Model API connection failed: model "${r.model}" status=${r.status} ${r.message}`);
    } else {
      logger.warn(`⚠️ Meta Model API skipped: ${r.reason}`);
    }
  })
  .catch((err) => {
    console.error(`❌ Meta Model API connection error: ${err.message}`);
    logger.error(`❌ Meta Model API connection error: ${err.message}`);
  });

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────
const server = require('http').createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      'http://localhost:8158',
      'https://salmart.onrender.com',
      'http://localhost:5500',
      'http://localhost:5501',
      'http://localhost:3000',
      'https://salmart.vercel.app',
      'https://salmartonline.com.ng',
      'http://10.0.2.2:3000',
      'null'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  },
  path: '/socket.io',
  auth: (socket, callback) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      logger.warn('Socket connection denied: No authentication token provided.');
      return callback(new Error('Authentication error: No token provided'));
    }
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.handshake.auth.userId = decoded.userId;
      logger.info(`Socket ${socket.id} authenticated for user ${decoded.userId}.`);
      callback(null, true);
    } catch (error) {
      logger.error(`Socket connection denied: Invalid token - ${error.message}`);
      callback(new Error('Authentication error: Invalid token'));
    }
  }
});

logger.info('✅ Socket.IO initialized');
initializeSocket(io);

// ─────────────────────────────────────────────
// APPLICATION ROUTES
// ─────────────────────────────────────────────
app.use(userRoutesIndex(io));
app.use(userRoutesCore);
app.use(userRoutesAuths);
app.use(userRoutesInteractive);
app.use(postRoutes(io));
app.use(postRoutes_2(io));
app.use(postRoutes_3(io));
app.use(requestRoutes(io));
app.use(notificationRoutes(io));
app.use(messageRoutes(io));
app.use(paymentRoutes(io));
app.use(transactionRoutes(io));
app.use(adminRoutes(io));
app.use(adminRoutes1(io));
app.use(promoteRoutes(io));
app.use(chinaPayoutRoutes); 
app.use('/api/assistant', assistantRoutes);
app.use(referralRoutes);
app.use(profileMetaRoutes);
app.use('/api', groupRoutes(io));
app.use('/api/billboard', billboardRoutes);

app.use('/api', groupListingRoute(io));
cleanupPromotions(io);

app.use('/api/showrooms', showroomRoutes(io));
startShowroomExpiryJob(io);

app.use('/api/forum', forumRoutes(io));
app.use('/api/recommended', recommendedRoutes(io));
app.use('/api/cart', cartRoutes);
app.use('/api/ai/forms', aiFormBridge);
app.use('/api/ai', aiRoutes);
startRequestExpiryJob(io);

app.use(searchRoutes);


// ─────────────────────────────────────────────
// UTILITY ENDPOINTS
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('Salmart API is running on port 3000');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

// Google Search Console verification — salmart.onrender.com
app.get('/googled6ddc6cb857e01ce.html', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html><html><head><meta name="google-site-verification" content="d6ddc6cb857e01ce"/></head><body>google-site-verification: googled6ddc6cb857e01ce.html</body></html>`);
});

// ─────────────────────────────────────────────
// NODEMAILER
// ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});
logger.info('✅ Nodemailer configured');

// ─────────────────────────────────────────────
// CLOUDINARY
// ─────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME || 'default',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
logger.info('✅ Cloudinary configured');

cloudinary.uploader.upload('./default-avater.png', { public_id: 'salmart_probe_v1' }).catch(() => {});

// ─────────────────────────────────────────────
// GLOBAL ERROR HANDLER  (must be last)
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`[error-handler] ${req.method} ${req.originalUrl} → ${err.stack || err.message}`);
  if (req.path.startsWith('/auth/google')) {
    const isMobileApp = (req.query.state || '').split('|')[0].startsWith('mobile');
    if (isMobileApp) {
      return res.redirect(`salmart://auth/error?message=${encodeURIComponent(err.message || 'server_error')}`);
    }
    return res.redirect(`${FRONTEND_URL}/#/register?error=${encodeURIComponent(err.message || 'server_error')}`);
  }
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal server error'),
  });
});

//test

app.get("/api/db-latency", async (req, res) => {
  const start = Date.now();

  try {
    await mongoose.connection.db.command({ ping: 1 });

    res.json({
      success: true,
      database: "MongoDB",
      latency_ms: Date.now() - start,
      server: mongoose.connection.host
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`✅ Server running on port ${PORT}`);
  startPromotionalCron();
  startRecommendationCron();
  startEngagementCron();
});

module.exports = { app, io, server, transporter };
