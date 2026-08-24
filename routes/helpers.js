/**
 * Housely — shared route helpers
 * Period/balance resolution, money validation, activity logging, permission matrix.
 */

const crypto = require('crypto');
const {
  Family,
  User,
  TrackingPeriod,
  GroceryBalance,
  PersonalBalance,
  ActivityLog,
} = require('../models');

// ---------------------------------------------------------------------------
// Money — every money value in the API is an integer number of sen (RM × 100)
// ---------------------------------------------------------------------------
const MAX_SEN = 1_000_000_000_000_00; // RM 1,000,000,000,000 cap sanity

function isValidMoney(v) {
  return Number.isInteger(v) && v >= 0 && v <= MAX_SEN;
}

/** Convert a user-typed RM string/number into an integer sen value, or null. */
function rmToSen(input) {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// ---------------------------------------------------------------------------
// Async handler wrapper (Express 4 doesn't catch rejected promises by default)
// ---------------------------------------------------------------------------
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Family / period / balances
// ---------------------------------------------------------------------------
/**
 * Resolve the caller's family. Public version: every authenticated request
 * belongs to exactly one family (from the JWT), so families never see each
 * other's data. `req` is required — call sites pass it explicitly.
 */
async function getFamily(req) {
  const familyId = req?.tokenFamilyId || req?.user?.familyId;
  if (!familyId) {
    const err = new Error('No family associated with this account.');
    err.status = 400;
    throw err;
  }
  return Family.findById(familyId).lean();
}

async function getActivePeriod(familyId) {
  let period = await TrackingPeriod.findOne({ familyId, status: 'active' });
  if (!period) {
    // Auto-create a monthly tracking period so the app never blocks.
    const now = new Date();
    period = await TrackingPeriod.create({
      familyId,
      startDate: new Date(now.getFullYear(), now.getMonth(), 1),
      endDate: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      status: 'active',
    });
    // Also create missing balances so everything is consistent.
    const { GroceryBalance, PersonalBalance } = require('../models');
    await GroceryBalance.findOneAndUpdate(
      { familyId, periodId: period._id },
      { $setOnInsert: { funded: 0, spent: 0, budgetAmount: 0 } },
      { upsert: true, new: true }
    );
    const users = await require('../models').User.find({ familyId }).select('_id');
    for (const u of users) {
      await PersonalBalance.findOneAndUpdate(
        { userId: u._id, periodId: period._id },
        { $setOnInsert: { funded: 0, spent: 0, fundedBy: [] } },
        { upsert: true, new: true }
      );
    }
  }
  return period;
}

/** Fetch (creating if missing) the grocery balance for a period. */
async function getGroceryBalance(familyId, periodId) {
  return GroceryBalance.findOneAndUpdate(
    { familyId, periodId },
    { $setOnInsert: { funded: 0, spent: 0, budgetAmount: 0 } },
    { upsert: true, new: true }
  );
}

/** Fetch (creating if missing) a personal balance for a user+period. */
async function getPersonalBalance(userId, periodId) {
  return PersonalBalance.findOneAndUpdate(
    { userId, periodId },
    { $setOnInsert: { funded: 0, spent: 0, fundedBy: [] } },
    { upsert: true, new: true }
  );
}

// ---------------------------------------------------------------------------
// Permission matrix — the dual-balance rules, the heart of the app
// ---------------------------------------------------------------------------
const canFundGroceries = (role) => role === 'provider' || role === 'grocery_spender';
const canSpendGroceries = (role) => ['provider', 'grocery_spender', 'member'].includes(role);
const canFundAnyone = (role) => role === 'provider' || role === 'grocery_spender';
const canManageBalances = (role) => role === 'provider' || role === 'grocery_spender';
const canResetPinFor = (actorRole, targetRole) =>
  actorRole === 'provider' || (actorRole === 'grocery_spender' && targetRole === 'dependent');
const canEditRecord = (actorRole, recordOwnerId, actorId) =>
  actorRole === 'provider' || String(recordOwnerId) === String(actorId);

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------
async function logActivity({
  familyId,
  actor,
  type,
  subjectUserId = null,
  message,
  amount = 0,
  meta = {},
}) {
  await ActivityLog.create({
    familyId,
    actorId: actor._id,
    actorName: actor.name,
    type,
    subjectUserId,
    message,
    amount,
    meta,
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
function dayKey(date) {
  // Calendar-day key in Malaysia time (UTC+8) — used for duplicate detection.
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate()
  ).padStart(2, '0')}`;
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function requireObjectId(value, what = 'id') {
  const mongoose = require('mongoose');
  if (!mongoose.Types.ObjectId.isValid(String(value))) {
    const err = new Error(`Invalid ${what}.`);
    err.status = 400;
    throw err;
  }
  return String(value);
}

module.exports = {
  ah,
  isValidMoney,
  rmToSen,
  getFamily,
  getActivePeriod,
  getGroceryBalance,
  getPersonalBalance,
  canFundGroceries,
  canSpendGroceries,
  canFundAnyone,
  canManageBalances,
  canResetPinFor,
  canEditRecord,
  logActivity,
  dayKey,
  sha256,
  randomToken,
  requireObjectId,
};
