/**
 * Housley (public) — auth routes
 * Email + password accounts, families, invite-code joining, PIN unlock with
 * lockout, JWT sessions, refresh tokens for biometric unlock.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { User, EmailVerification } = require('../models');
const { sendVerificationCode } = require('../lib/email');
const { requireAuth, requireRole, signToken, normalizePin } = require('../middleware/auth');
const { ah, sha256, randomToken, logActivity, canFundAnyone, getActivePeriod, getGroceryBalance, getPersonalBalance } = require('./helpers');

const router = express.Router();

const BCRYPT_ROUNDS = 12;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

const pinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts from this device. Please try again in a few minutes.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60, // register / login / join — raised to avoid false lockouts for large families
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again in a few minutes.' },
});

// Master factory-reset PIN. Change it in backend/.env (FACTORY_RESET_PIN).
const FACTORY_RESET_PIN = String(process.env.FACTORY_RESET_PIN || '0259').trim();

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many factory-reset attempts. Try again later.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_RE = /^\d{6}$/;
const AVATAR_COLORS = ['#ff6f91', '#4e9de6', '#7c5cd6', '#f7b32b', '#6fcf97', '#f39ac2', '#5bc0de', '#f2994a'];

/** Generate a random 6-digit verification code. */
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** Clean up expired / used verification codes for an email. */
async function cleanupVerifications(email) {
  await EmailVerification.deleteMany({
    email,
    $or: [{ used: true }, { expiresAt: { $lt: new Date() } }],
  });
}

function validateCredentials({ email, password }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(password || '');
  if (!EMAIL_RE.test(cleanEmail)) return { error: 'Enter a valid email address.' };
  if (cleanPassword.length < 8) return { error: 'Password must be at least 8 characters.' };
  return { email: cleanEmail, password: cleanPassword };
}

/** Build a session payload: token, refresh token, user, family, family profiles. */
async function buildSession(user) {
  const mongoose = require('mongoose');
  const { Family } = require('../models');
  const family = await Family.findById(user.familyId);
  if (!family) {
    const err = new Error('Your family no longer exists.');
    err.status = 410;
    throw err;
  }
  // IMPORTANT: +pinHash is required so toSafeJSON() can compute `hasPin` for
  // each profile. Without it, hasPin is always false after login/register/join
  // and the picker shows "Set PIN" even when a PIN already exists.
  const profiles = await User.find({ familyId: family._id })
    .select('+pinHash')
    .sort({ sortOrder: 1, name: 1 });
  const refreshToken = randomToken();
  user.refreshTokenHash = sha256(refreshToken);
  await user.save();
  return {
    token: signToken(user),
    refreshToken,
    user: user.toSafeJSON(),
    family: {
      _id: family._id,
      name: family.name,
      periodType: family.periodType,
      rolloverPolicy: family.rolloverPolicy,
      currency: family.currency,
      aiEnabled: family.aiEnabled !== false,
    },
    profiles: profiles.map((u) => u.toSafeJSON()),
  };
}

/** Create the family's first tracking period, balances and default categories. */
async function bootstrapFamily(familyId, userIds) {
  const mongoose = require('mongoose');
  const { TrackingPeriod, GroceryBalance, PersonalBalance, Category } = require('../models');
  const now = new Date();
  const period = await TrackingPeriod.create({
    familyId,
    startDate: new Date(now.getFullYear(), now.getMonth(), 1),
    endDate: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
    status: 'active',
  });
  await GroceryBalance.create({ familyId, periodId: period._id, funded: 0, spent: 0, budgetAmount: 0 });
  for (const userId of userIds) {
    await PersonalBalance.create({ userId, periodId: period._id, funded: 0, spent: 0, fundedBy: [] });
  }
  const DEFAULT_CATEGORIES = [
    'Groceries', 'Meat & Fish', 'Vegetables & Fruits', 'Dairy & Eggs', 'Petrol',
    'Restaurant & Eat Out', 'Pharmacy & Health', 'Utility Bills', 'Transport',
    'Education', 'Entertainment', 'Household', 'Personal Care', 'Other',
  ];
  await Category.insertMany(DEFAULT_CATEGORIES.map((name) => ({ familyId, name })));
}

/** GET /api/auth/profiles — the logged-in account's family profiles (no PIN hashes). */
router.get(
  '/profiles',
  requireAuth,
  ah(async (req, res) => {
    const users = await User.find({ familyId: req.user.familyId })
      .select('+pinHash')
      .sort({ sortOrder: 1, name: 1 });
    res.json({ users: users.map((u) => u.toSafeJSON()) });
  })
);

/**
 * POST /api/auth/send-verification — send a 6-digit code to verify an email.
 * Body: { email, purpose }  — purpose is 'register' or 'join'
 * Returns { verificationId, expiresAt }.
 */
router.post(
  '/send-verification',
  authLimiter,
  ah(async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const purpose = String((req.body || {}).purpose || '').trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!['register', 'join'].includes(purpose)) return res.status(400).json({ error: 'Purpose must be register or join.' });

    // Check email is not already taken
    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });

    // Rate-limit: max 3 codes per email per 15 minutes
    await cleanupVerifications(email);
    const recentCount = await EmailVerification.countDocuments({
      email,
      purpose,
      createdAt: { $gte: new Date(Date.now() - 15 * 60 * 1000) },
    });
    if (recentCount >= 3) {
      return res.status(429).json({ error: 'Too many codes sent. Please wait a few minutes.' });
    }

    const code = generateCode();
    const verification = await EmailVerification.create({
      email,
      code,
      purpose,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    });

    const result = await sendVerificationCode(email, code, purpose);
    if (!result.ok) {
      console.error('📧 Failed to send verification email:', result.error);
    }

    res.status(201).json({
      verificationId: verification._id,
      expiresAt: verification.expiresAt,
      // In dev mode (no Resend key), include the code for testing
      ...(result.dev ? { code } : {}),
    });
  })
);

/**
 * POST /api/auth/verify-email — verify a 6-digit code.
 * Body: { verificationId, code }
 * Returns { ok: true, email, purpose }.
 */
router.post(
  '/verify-email',
  authLimiter,
  ah(async (req, res) => {
    const verificationId = String((req.body || {}).verificationId || '').trim();
    const code = String((req.body || {}).code || '').trim();
    if (!verificationId) return res.status(400).json({ error: 'verificationId is required.' });
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Code must be 6 digits.' });

    const verification = await EmailVerification.findOne({
      _id: verificationId,
      used: false,
    });
    if (!verification) {
      return res.status(400).json({ error: 'Invalid verification. Request a new code.' });
    }
    if (verification.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: 'Verification code expired. Request a new one.' });
    }
    if (verification.code !== code) {
      return res.status(400).json({ error: 'Wrong verification code.' });
    }

    verification.used = true;
    await verification.save();

    res.json({ ok: true, email: verification.email, purpose: verification.purpose });
  })
);

/**
 * POST /api/auth/register — create an account AND a brand-new family.
 * Body: { email, password, familyName, name, verificationId, code }
 * The registrant becomes the provider of the new family.
 */
router.post(
  '/register',
  authLimiter,
  ah(async (req, res) => {
    const creds = validateCredentials(req.body || {});
    if (creds.error) return res.status(400).json({ error: creds.error });
    const familyName = String((req.body || {}).familyName || '').trim();
    const name = String((req.body || {}).name || '').trim();
    if (!familyName) return res.status(400).json({ error: 'Give your family a name.' });
    if (!name) return res.status(400).json({ error: 'Enter your name.' });
    if (familyName.length > 60) return res.status(400).json({ error: 'Family name is too long.' });

    const existing = await User.findOne({ email: creds.email });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });

    // Email verification check — require a verified code
    const verificationId = String((req.body || {}).verificationId || '').trim();
    const code = String((req.body || {}).code || '').trim();
    if (!verificationId || !CODE_RE.test(code)) {
      return res.status(400).json({ error: 'Email not verified. Please verify your email first.' });
    }
    const verification = await EmailVerification.findOne({
      _id: verificationId,
      email: creds.email,
      purpose: 'register',
      used: false,
    });
    if (!verification) {
      return res.status(400).json({ error: 'Invalid verification. Request a new code.' });
    }
    if (verification.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: 'Verification code expired. Request a new one.' });
    }
    if (verification.code !== code) {
      return res.status(400).json({ error: 'Wrong verification code.' });
    }
    verification.used = true;
    await verification.save();

    const { Family } = require('../models');
    // New families start on the Free plan — no trial. Pro must be purchased.
    const family = await Family.create({
      name: familyName.slice(0, 60),
      periodType: 'monthly',
      rolloverPolicy: 'carry_forward',
      currency: 'RM',
      // No trialEndsAt, no proTier — starts as Free
    });
    const user = await User.create({
      familyId: family._id,
      name: name.slice(0, 60),
      email: creds.email,
      passwordHash: await bcrypt.hash(creds.password, BCRYPT_ROUNDS),
      role: 'provider',
      sortOrder: 1,
      avatarColor: AVATAR_COLORS[0],
      emailVerified: true,
    });
    await bootstrapFamily(family._id, [user._id]);

    await logActivity({
      familyId: family._id,
      actor: user,
      type: 'period_opened',
      message: `${user.name} created the family. Welcome! 🏡`,
    });

    const session = await buildSession(user);
    res.status(201).json(session);
  })
);

/** POST /api/auth/login — email + password → session. */
router.post(
  '/login',
  authLimiter,
  ah(async (req, res) => {
    const creds = validateCredentials(req.body || {});
    if (creds.error) return res.status(400).json({ error: creds.error });
    const user = await User.findOne({ email: creds.email }).select('+passwordHash');
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    const ok = await bcrypt.compare(creds.password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Wrong email or password.' });
    const session = await buildSession(user);
    res.json(session);
  })
);

/** POST /api/auth/join — create an account and join an existing family by code. */
router.post(
  '/join',
  authLimiter,
  ah(async (req, res) => {
    const creds = validateCredentials(req.body || {});
    if (creds.error) return res.status(400).json({ error: creds.error });
    const name = String((req.body || {}).name || '').trim();
    const rawCode = String((req.body || {}).inviteCode || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (!name) return res.status(400).json({ error: 'Enter your name.' });
    if (!/^[A-Z0-9]{6}$/.test(rawCode)) return res.status(400).json({ error: 'Enter the 6-letter invite code from your family.' });

    const { Family } = require('../models');
    const family = await Family.findOne({ inviteCode: rawCode });
    if (!family) return res.status(404).json({ error: 'That invite code is not valid. Ask your family head for a fresh one.' });
    if (family.inviteCodeExpiresAt && new Date(family.inviteCodeExpiresAt).getTime() < Date.now()) {
      return res.status(410).json({ error: 'That invite code has expired. Ask your family head to create a new one.' });
    }
    if (family.inviteUsesLeft <= 0) {
      return res.status(410).json({ error: 'That invite code has been used too many times. Ask your family head for a new one.' });
    }

    const existing = await User.findOne({ email: creds.email });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });

    // Email verification check — require a verified code
    const verificationId = String((req.body || {}).verificationId || '').trim();
    const code = String((req.body || {}).code || '').trim();
    if (!verificationId || !CODE_RE.test(code)) {
      return res.status(400).json({ error: 'Email not verified. Please verify your email first.' });
    }
    const verification = await EmailVerification.findOne({
      _id: verificationId,
      email: creds.email,
      purpose: 'join',
      used: false,
    });
    if (!verification) {
      return res.status(400).json({ error: 'Invalid verification. Request a new code.' });
    }
    if (verification.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ error: 'Verification code expired. Request a new one.' });
    }
    if (verification.code !== code) {
      return res.status(400).json({ error: 'Wrong verification code.' });
    }
    verification.used = true;
    await verification.save();

    const user = await User.create({
      familyId: family._id,
      name: name.slice(0, 60),
      email: creds.email,
      passwordHash: await bcrypt.hash(creds.password, BCRYPT_ROUNDS),
      role: 'member',
      sortOrder: 99,
      avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      emailVerified: true,
    });

    family.inviteUsesLeft -= 1;
    await family.save();

    // Give the new member a personal balance in the active period, if any.
    const period = await getActivePeriod(family._id);
    if (period) await getPersonalBalance(user._id, period._id);

    await logActivity({
      familyId: family._id,
      actor: user,
      type: 'pin_set',
      subjectUserId: user._id,
      message: `${user.name} joined the family. 🎉`,
    });

    const session = await buildSession(user);
    res.status(201).json(session);
  })
);

/** POST /api/auth/set-pin — first-time PIN creation (account must be logged in). */
router.post(
  '/set-pin',
  requireAuth,
  pinLimiter,
  ah(async (req, res) => {
    const { userId, pin } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const normalized = normalizePin(pin);
    if (!normalized) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });

    const user = await User.findById(userId).select('+pinHash');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (String(user.familyId) !== String(req.user.familyId)) {
      return res.status(403).json({ error: 'That profile is not in your family.' });
    }
    if (user.pinHash) {
      return res.status(409).json({ error: 'This profile already has a PIN.' });
    }

    user.pinHash = await bcrypt.hash(normalized, BCRYPT_ROUNDS);
    user.failedAttempts = 0;
    user.lockedUntil = null;
    await user.save();

    await logActivity({
      familyId: user.familyId,
      actor: user,
      type: 'pin_set',
      subjectUserId: user._id,
      message: `${user.name} set their PIN.`,
    });

    const session = await buildSession(user);
    res.status(201).json(session);
  })
);

/** POST /api/auth/verify-pin — unlock a family profile with its PIN (enforces lockout). */
router.post(
  '/verify-pin',
  requireAuth,
  pinLimiter,
  ah(async (req, res) => {
    const { userId, pin } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const normalized = normalizePin(pin);
    if (!normalized) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });

    const user = await User.findById(userId).select('+pinHash +refreshTokenHash');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (String(user.familyId) !== String(req.user.familyId)) {
      return res.status(403).json({ error: 'That profile is not in your family.' });
    }
    if (!user.pinHash) {
      return res.status(409).json({ error: 'This profile has no PIN yet. Create one first.' });
    }

    // Lockout check
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      return res.status(423).json({
        error: `Too many wrong attempts. Profile locked for ${mins} more minute(s).`,
        locked: true,
        lockedUntil: user.lockedUntil,
      });
    }

    const ok = await bcrypt.compare(normalized, user.pinHash);
    if (!ok) {
      user.failedAttempts += 1;
      if (user.failedAttempts >= MAX_ATTEMPTS) {
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
        user.failedAttempts = 0;
        await user.save();
        return res.status(423).json({
          error: 'Too many wrong attempts. Profile locked for 15 minutes.',
          locked: true,
          lockedUntil: user.lockedUntil,
        });
      }
      await user.save();
      const left = MAX_ATTEMPTS - user.failedAttempts;
      return res
        .status(401)
        .json({ error: `Wrong PIN. ${left} attempt(s) left.`, attemptsLeft: left });
    }

    // Success — reset counters, rotate refresh token, issue JWT
    user.failedAttempts = 0;
    user.lockedUntil = null;
    const session = await buildSession(user);
    res.json(session);
  })
);

/** POST /api/auth/refresh — exchange a refresh token for a fresh JWT (biometric unlock). */
router.post(
  '/refresh',
  pinLimiter,
  ah(async (req, res) => {
    const { userId, refreshToken } = req.body || {};
    if (!userId || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'userId and refreshToken are required.' });
    }
    const user = await User.findById(userId).select('+pinHash +refreshTokenHash');
    if (!user || !user.refreshTokenHash) {
      return res.status(401).json({ error: 'Session not found. Please log in with your PIN.' });
    }
    // Only profiles that explicitly enabled biometric unlock may use this path.
    if (!user.biometricEnabled) {
      return res.status(403).json({ error: 'Biometric unlock is not enabled for this profile.' });
    }
    if (user.refreshTokenHash !== sha256(refreshToken)) {
      return res.status(401).json({ error: 'Session is invalid. Please log in with your PIN.' });
    }
    const session = await buildSession(user);
    res.json(session);
  })
);

/** POST /api/auth/change-pin — authenticated user changes their own PIN. */
router.post(
  '/change-pin',
  requireAuth,
  ah(async (req, res) => {
    const { currentPin, newPin } = req.body || {};
    const normalizedNew = normalizePin(newPin);
    if (!normalizedNew) {
      return res.status(400).json({ error: 'New PIN must be exactly 4 digits.' });
    }
    const user = await User.findById(req.user._id).select('+pinHash');
    const ok = user.pinHash ? await bcrypt.compare(String(currentPin || ''), user.pinHash) : false;
    if (!ok) return res.status(401).json({ error: 'Current PIN is incorrect.' });

    user.pinHash = await bcrypt.hash(normalizedNew, BCRYPT_ROUNDS);
    user.failedAttempts = 0;
    user.lockedUntil = null;
    await user.save();

    await logActivity({
      familyId: user.familyId,
      actor: user,
      type: 'pin_set',
      subjectUserId: user._id,
      message: `${user.name} changed their PIN.`,
    });
    res.json({ ok: true });
  })
);

/** POST /api/auth/reset-pin — provider resets anyone; grocery_spender resets dependents only. */
router.post(
  '/reset-pin',
  requireAuth,
  ah(async (req, res) => {
    const { userId, newPin } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    const normalized = normalizePin(newPin);
    if (!normalized) return res.status(400).json({ error: 'New PIN must be exactly 4 digits.' });

    const target = await User.findById(userId).select('+pinHash');
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (String(target.familyId) !== String(req.user.familyId)) {
      return res.status(403).json({ error: 'That profile is not in your family.' });
    }

    const { canResetPinFor } = require('./helpers');
    if (!canResetPinFor(req.user.role, target.role)) {
      return res.status(403).json({ error: 'You do not have permission to reset that PIN.' });
    }

    target.pinHash = await bcrypt.hash(normalized, BCRYPT_ROUNDS);
    target.failedAttempts = 0;
    target.lockedUntil = null;
    await target.save();

    await logActivity({
      familyId: target.familyId,
      actor: req.user,
      type: 'pin_reset',
      subjectUserId: target._id,
      message: `${req.user.name} reset ${target.name}'s PIN.`,
    });
    res.json({ ok: true, user: target.toSafeJSON() });
  })
);

/** POST /api/auth/biometric — toggle biometric unlock for the authenticated user. */
router.post(
  '/biometric',
  requireAuth,
  ah(async (req, res) => {
    const { enabled } = req.body || {};
    req.user.biometricEnabled = Boolean(enabled);
    await req.user.save();
    res.json({ user: req.user.toSafeJSON() });
  })
);

/** POST /api/auth/logout — invalidate the refresh token. */
router.post(
  '/logout',
  requireAuth,
  ah(async (req, res) => {
    req.user.refreshTokenHash = null;
    await req.user.save();
    res.json({ ok: true });
  })
);

/**
 * PATCH /api/auth/photo — set a member's profile photo (small data URL).
 * Anyone can set their own photo; provider/grocery_spender can set anyone's (in-family only).
 */
router.patch(
  '/photo',
  requireAuth,
  ah(async (req, res) => {
    const { userId, avatarPhoto } = req.body || {};
    const targetId = userId ? String(userId) : String(req.user._id);
    const isSelf = targetId === String(req.user._id);
    if (!isSelf && !canFundAnyone(req.user.role)) {
      return res.status(403).json({ error: 'Only the provider and grocery spender can change other people\'s photos.' });
    }

    const target = await User.findById(targetId);
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (!isSelf && String(target.familyId) !== String(req.user.familyId)) {
      return res.status(403).json({ error: 'That profile is not in your family.' });
    }

    // null / empty string clears the photo; anything else must be a small data URL
    if (avatarPhoto === null || avatarPhoto === '') {
      target.avatarPhoto = null;
      await target.save();
      return res.json({ user: target.toSafeJSON() });
    }
    if (avatarPhoto === undefined) {
      return res.status(400).json({ error: 'avatarPhoto is required.' });
    }
    if (
      typeof avatarPhoto !== 'string' ||
      !avatarPhoto.startsWith('data:image/') ||
      avatarPhoto.length > 1024 * 1024 // ~750 KB decoded — avatars are small
    ) {
      return res.status(400).json({ error: 'Photo must be a data URL under ~750 KB. Pick a smaller picture.' });
    }

    target.avatarPhoto = avatarPhoto;
    await target.save();
    res.json({ user: target.toSafeJSON() });
  })
);

/**
 * POST /api/auth/factory-reset — wipe THIS family back to brand-new.
 * Requires the master reset PIN (default 0259, override via FACTORY_RESET_PIN)
 * AND the provider role. Only the caller's family is touched — other families
 * are completely unaffected. Members, roles and default categories are kept;
 * every member's PIN is cleared so everyone sets a fresh one on first open.
 */
router.post(
  '/factory-reset',
  requireAuth,
  requireRole('provider'),
  resetLimiter,
  ah(async (req, res) => {
    const { pin } = req.body || {};
    if (String(pin || '').trim() !== FACTORY_RESET_PIN) {
      return res.status(403).json({ error: 'That reset PIN is not correct.' });
    }

    const models = require('../models');
    const { Family, TrackingPeriod, GroceryBalance, PersonalBalance, Category, User } = models;
    const family = await Family.findById(req.user.familyId);
    if (!family) return res.status(409).json({ error: 'No family found to reset.' });

    // --- wipe every piece of THIS family's data (keep Family + User documents) ---
    const wipe = [
      models.FundingTransaction,
      models.ExpenseTransaction,
      models.Shop,
      models.ActivityLog,
      models.GroceryChecklistItem,
      models.GroceryCatalogItem,
      models.CategoryBudget,
      models.RecurringBill,
      models.SavingsGoal,
      models.Shoutout,
      models.PinNote,
      models.Chore,
      models.MealPlan,
      TrackingPeriod,
      GroceryBalance,
      PersonalBalance,
    ];
    for (const M of wipe) await M.deleteMany({ familyId: family._id });
    await Category.deleteMany({ familyId: family._id });

    // --- reset this family's members to brand-new (no PIN, no biometric, no photo) ---
    await User.updateMany(
      { familyId: family._id },
      {
        $set: {
          pinHash: null,
          refreshTokenHash: null,
          biometricEnabled: false,
          avatarPhoto: null,
          failedAttempts: 0,
          lockedUntil: null,
        },
      }
    );

    // --- fresh tracking period + zero balances + default categories ---
    const now = new Date();
    const period = await TrackingPeriod.create({
      familyId: family._id,
      startDate: new Date(now.getFullYear(), now.getMonth(), 1),
      endDate: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      status: 'active',
    });
    await GroceryBalance.create({ familyId: family._id, periodId: period._id, funded: 0, spent: 0, budgetAmount: 0 });
    const users = await User.find({ familyId: family._id });
    for (const u of users) {
      await PersonalBalance.create({ userId: u._id, periodId: period._id, funded: 0, spent: 0, fundedBy: [] });
    }
    const DEFAULT_CATEGORIES = [
      'Groceries', 'Meat & Fish', 'Vegetables & Fruits', 'Dairy & Eggs', 'Petrol',
      'Restaurant & Eat Out', 'Pharmacy & Health', 'Utility Bills', 'Transport',
      'Education', 'Entertainment', 'Household', 'Personal Care', 'Other',
    ];
    await Category.insertMany(DEFAULT_CATEGORIES.map((name) => ({ familyId: family._id, name })));

    res.json({
      ok: true,
      message: 'Housley has been reset to brand-new. Every member starts fresh with a new PIN.',
    });
  })
);

// ---------------------------------------------------------------------------
// Security questions — setup & verify for password reset
// ---------------------------------------------------------------------------
const { SecurityQuestion, Family } = require('../models');

// Pre-defined questions the user can choose from
const SECURITY_QUESTIONS = [
  'What is the name of your first pet?',
  'What city were you born in?',
  'What is your mother\'s maiden name?',
  'What was the name of your first school?',
  'What is your favorite food?',
  'What street did you grow up on?',
  'What is the name of your best friend?',
  'What was your childhood nickname?',
];

/** GET /api/auth/security-questions — get the list of available questions. */
router.get('/security-questions', (req, res) => {
  res.json({ questions: SECURITY_QUESTIONS });
});

/** POST /api/auth/setup-security-questions — set up security questions (authenticated). */
router.post(
  '/setup-security-questions',
  requireAuth,
  pinLimiter,
  ah(async (req, res) => {
    const { questions } = req.body || {};
    if (!Array.isArray(questions) || questions.length < 2) {
      return res.status(400).json({ error: 'You must set up at least 2 security questions.' });
    }
    if (questions.length > 3) {
      return res.status(400).json({ error: 'Maximum 3 security questions.' });
    }

    const hashed = [];
    for (const q of questions) {
      if (!q.question || !q.answer) {
        return res.status(400).json({ error: 'Each question needs both a question and answer.' });
      }
      if (!SECURITY_QUESTIONS.includes(q.question)) {
        return res.status(400).json({ error: 'Invalid question. Choose from the list.' });
      }
      const answer = String(q.answer).trim().toLowerCase();
      if (answer.length < 2) {
        return res.status(400).json({ error: 'Answers must be at least 2 characters.' });
      }
      hashed.push({
        question: q.question,
        answerHash: await bcrypt.hash(answer, BCRYPT_ROUNDS),
      });
    }

    await SecurityQuestion.findOneAndUpdate(
      { userId: req.user._id },
      { userId: req.user._id, questions: hashed },
      { upsert: true, new: true }
    );

    res.json({ ok: true, message: 'Security questions saved.' });
  })
);

/** POST /api/auth/verify-security-questions — verify answers and reset password. */
router.post(
  '/verify-security-questions',
  authLimiter,
  ah(async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const { answers, newPassword } = req.body || {};

    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ error: 'Provide your security answers.' });
    }
    if (newPassword && newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    const sq = await SecurityQuestion.findOne({ userId: user._id });
    if (!sq || !sq.questions || sq.questions.length === 0) {
      return res.status(400).json({ error: 'This account has no security questions set up. Ask the family creator to reset your password.' });
    }

    // Verify answers against stored hashes
    let allCorrect = true;
    for (let i = 0; i < sq.questions.length && i < answers.length; i++) {
      const answer = String(answers[i] || '').trim().toLowerCase();
      const match = await bcrypt.compare(answer, sq.questions[i].answerHash);
      if (!match) { allCorrect = false; break; }
    }
    if (!allCorrect) {
      return res.status(400).json({ error: 'One or more answers are incorrect.' });
    }

    // If newPassword provided, actually reset it
    if (newPassword) {
      user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      user.failedAttempts = 0;
      user.lockedUntil = null;
      user.refreshTokenHash = null;
      await user.save();

      await logActivity({
        familyId: user.familyId,
        actor: user,
        type: 'pin_set',
        subjectUserId: user._id,
        message: `${user.name} reset their password via security questions.`,
      });

      const session = await buildSession(user);
      return res.json(session);
    }

    // Just verify — don't reset yet
    res.json({ ok: true, verified: true, message: 'Answers correct. You can now set a new password.' });
  })
);

/** POST /api/auth/provider-reset-password — provider resets a member's password. */
router.post(
  '/provider-reset-password',
  requireAuth,
  pinLimiter,
  ah(async (req, res) => {
    const { userId, newPassword } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    // Only provider or grocery_spender can reset others
    const isPrivileged = ['provider', 'grocery_spender'].includes(req.user.role);
    const isSelf = String(userId) === String(req.user._id);
    if (!isPrivileged && !isSelf) {
      return res.status(403).json({ error: 'You do not have permission to reset this password.' });
    }

    const target = await User.findById(userId).select('+passwordHash');
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (String(target.familyId) !== String(req.user.familyId)) {
      return res.status(403).json({ error: 'That profile is not in your family.' });
    }

    target.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    target.failedAttempts = 0;
    target.lockedUntil = null;
    target.refreshTokenHash = null;
    await target.save();

    await logActivity({
      familyId: target.familyId,
      actor: req.user,
      type: 'pin_set',
      subjectUserId: target._id,
      message: `${req.user.name} reset ${target.name}'s password.`,
    });

    res.json({ ok: true, message: `${target.name}'s password has been reset.` });
  })
);

module.exports = router;
