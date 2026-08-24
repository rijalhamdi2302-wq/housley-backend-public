/**
 * Housely — funding routes (money in)
 */

const express = require('express');
const {
  User,
  FundingTransaction,
} = require('../models');
const { requireAuth } = require('../middleware/auth');
const {
  ah,
  isValidMoney,
  getFamily,
  getActivePeriod,
  getGroceryBalance,
  getPersonalBalance,
  canFundGroceries,
  canFundAnyone,
  logActivity,
  requireObjectId,
} = require('./helpers');

const router = express.Router();
router.use(requireAuth);

const PAYMENT_METHODS = ['online_banking', 'cash', 'credit_card', 'e_wallet'];

/**
 * Validate an optional proof image for online banking funding.
 * Proof is never required — but if one is provided it must be a small
 * base64 data URL. Images for non-banking methods are never stored.
 */
function validateProofImage(method, proofImage) {
  if (method !== 'online_banking') return null;
  if (proofImage === undefined || proofImage === null || proofImage === '') return null;
  if (
    typeof proofImage !== 'string' ||
    !proofImage.startsWith('data:image/') ||
    proofImage.length > 6 * 1024 * 1024 // ~4.5 MB decoded
  ) {
    const err = new Error('If attaching a proof image it must be a data URL under ~4.5 MB.');
    err.status = 400;
    throw err;
  }
  return proofImage;
}

/** POST /api/funding/groceries — fund the shared Groceries pool. */
router.post(
  '/groceries',
  ah(async (req, res) => {
    const { amount, paymentMethod, proofImage, note } = req.body || {};
    if (!isValidMoney(amount)) return res.status(400).json({ error: 'A valid amount is required.' });
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }
    if (!canFundGroceries(req.user.role)) {
      return res.status(403).json({ error: 'Only the provider and grocery spender can fund Groceries.' });
    }
    const proof = validateProofImage(paymentMethod, proofImage);

    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });

    const tx = await FundingTransaction.create({
      familyId: family._id,
      periodId: period._id,
      type: 'groceries',
      userId: req.user._id,
      fundedById: req.user._id,
      amount,
      paymentMethod,
      proofImage: proof,
      note: String(note || '').slice(0, 500),
    });

    const balance = await getGroceryBalance(family._id, period._id);
    balance.funded += amount;
    await balance.save();

    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'groceries_funded',
      message: `${req.user.name} topped up Groceries with ${(amount / 100).toFixed(2)}.`,
      amount,
    });

    res.status(201).json({ transaction: tx, balance: publicGroceries(balance, period) });
  })
);

/** POST /api/funding/personal — fund a personal balance (self, or anyone for provider/grocery_spender). */
router.post(
  '/personal',
  ah(async (req, res) => {
    const { userId, amount, paymentMethod, proofImage, note } = req.body || {};
    if (!isValidMoney(amount)) return res.status(400).json({ error: 'A valid amount is required.' });
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }

    const targetId = userId ? requireObjectId(userId, 'userId') : req.user._id.toString();
    const target = await User.findById(targetId);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const isSelf = String(target._id) === String(req.user._id);
    if (!isSelf && !canFundAnyone(req.user.role)) {
      return res.status(403).json({ error: 'Only the provider and grocery spender can fund other people.' });
    }
    const proof = validateProofImage(paymentMethod, proofImage);

    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });

    const tx = await FundingTransaction.create({
      familyId: family._id,
      periodId: period._id,
      type: 'personal',
      userId: target._id,
      fundedById: req.user._id,
      amount,
      paymentMethod,
      proofImage: proof,
      note: String(note || '').slice(0, 500),
    });

    const balance = await getPersonalBalance(target._id, period._id);
    balance.funded += amount;
    balance.fundedBy.push({ userId: req.user._id, amount, at: new Date() });
    await balance.save();

    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'personal_funded',
      subjectUserId: target._id,
      message: isSelf
        ? `${req.user.name} funded their own personal balance with ${(amount / 100).toFixed(2)}.`
        : `${req.user.name} funded ${target.name}'s personal balance with ${(amount / 100).toFixed(2)}.`,
      amount,
      meta: { targetName: target.name, targetRole: target.role, self: isSelf },
    });

    res.status(201).json({ transaction: tx, balance: publicPersonal(balance) });
  })
);

/** GET /api/funding/balances/groceries — shared Groceries balance + safe-to-spend. */
router.get(
  '/balances/groceries',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });
    const balance = await getGroceryBalance(family._id, period._id);
    res.json({ balance: publicGroceries(balance, period) });
  })
);

/** GET /api/funding/balances/personal/:userId */
router.get(
  '/balances/personal/:userId',
  ah(async (req, res) => {
    const targetId = requireObjectId(req.params.userId, 'userId');
    const family = await getFamily(req);
    // Ensure the target user belongs to the same family
    const { User } = require('../models');
    const targetUser = await User.findById(targetId).select('familyId').lean();
    if (!targetUser || String(targetUser.familyId) !== String(family._id)) {
      return res.status(404).json({ error: 'User not found in your family.' });
    }
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });
    const balance = await getPersonalBalance(targetId, period._id);
    res.json({ balance: publicPersonal(balance) });
  })
);

/** PATCH /api/funding/groceries/budget — provider sets the Groceries budget target. */
router.patch(
  '/groceries/budget',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can set the Groceries budget.' });
    }
    const { budgetAmount } = req.body || {};
    if (!isValidMoney(budgetAmount)) {
      return res.status(400).json({ error: 'A valid budget amount is required.' });
    }
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });
    const balance = await getGroceryBalance(family._id, period._id);
    balance.budgetAmount = budgetAmount;
    await balance.save();
    res.json({ balance: publicGroceries(balance, period) });
  })
);

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------
function publicGroceries(balance, period) {
  const daysLeft = Math.max(0, Math.ceil((period.endDate.getTime() - Date.now()) / 86400000) + 1);
  const remainingBudget = balance.budgetAmount - balance.spent;
  const remainingBalance = balance.funded - balance.spent;
  const safeToSpend =
    balance.budgetAmount > 0
      ? Math.max(0, Math.floor(remainingBudget / Math.max(1, daysLeft)))
      : Math.max(0, Math.floor(remainingBalance / Math.max(1, daysLeft)));
  return {
    _id: balance._id,
    periodId: balance.periodId,
    funded: balance.funded,
    spent: balance.spent,
    budgetAmount: balance.budgetAmount,
    currentBalance: balance.funded - balance.spent,
    safeToSpend,
    daysLeft,
    budgetSet: balance.budgetAmount > 0,
  };
}

function publicPersonal(balance) {
  return {
    _id: balance._id,
    userId: balance.userId,
    periodId: balance.periodId,
    funded: balance.funded,
    spent: balance.spent,
    currentBalance: balance.funded - balance.spent,
    fundedBy: balance.fundedBy,
  };
}

module.exports = router;
