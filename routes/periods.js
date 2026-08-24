/**
 * Housely — tracking period routes.
 * Closing a period is provider-only and rolls every balance into a fresh period
 * according to the family's rollover policy.
 */

const express = require('express');
const {
  TrackingPeriod,
  GroceryBalance,
  PersonalBalance,
  CategoryBudget,
  Category,
} = require('../models');
const { requireAuth } = require('../middleware/auth');
const {
  ah,
  getFamily,
  getGroceryBalance,
  getPersonalBalance,
  logActivity,
} = require('./helpers');

const router = express.Router();
router.use(requireAuth);

function nextPeriodDates(periodType, startDate) {
  const start = new Date(startDate);
  let end;
  if (periodType === 'weekly') {
    end = new Date(start.getTime() + 6 * 86400000);
    end.setHours(23, 59, 59, 999);
    return { startDate: start, endDate: end };
  }
  if (periodType === 'annually') {
    end = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate() - 1, 23, 59, 59, 999);
    return { startDate: start, endDate: end };
  }
  // monthly — same day-of-month next month
  end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
  const startOfNext = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  const nextStart = startOfNext.getTime() > end.getTime() ? end : startOfNext;
  return { startDate: start, endDate: end };
}

/** GET /api/periods/status — active period + days remaining. */
router.get(
  '/status',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await TrackingPeriod.findOne({ familyId: family._id, status: 'active' });
    if (!period) return res.json({ period: null });
    const daysLeft = Math.max(0, Math.ceil((period.endDate.getTime() - Date.now()) / 86400000) + 1);
    res.json({
      period: {
        _id: period._id,
        startDate: period.startDate,
        endDate: period.endDate,
        daysLeft,
        periodType: family.periodType,
        rolloverPolicy: family.rolloverPolicy,
      },
    });
  })
);

/** POST /api/periods/close-and-start-new — provider only, applies rollover. */
router.post(
  '/close-and-start-new',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can close a tracking period.' });
    }
    const family = await getFamily(req);
    const active = await TrackingPeriod.findOne({ familyId: family._id, status: 'active' });
    if (!active) return res.status(409).json({ error: 'No active tracking period to close.' });

    active.status = 'closed';
    active.closedAt = new Date();
    await active.save();

    // Create the new period
    const dates = nextPeriodDates(family.periodType, new Date());
    const next = await TrackingPeriod.create({
      familyId: family._id,
      startDate: dates.startDate,
      endDate: dates.endDate,
      status: 'active',
    });

    // Roll over balances
    const gb = await GroceryBalance.findOne({ familyId: family._id, periodId: active._id });
    const leftover = Math.max(0, (gb ? gb.funded : 0) - (gb ? gb.spent : 0));
    const newGb = await getGroceryBalance(family._id, next._id);
    newGb.funded = family.rolloverPolicy === 'carry_forward' ? leftover : 0;
    newGb.spent = 0;
    if (gb && gb.budgetAmount > 0) newGb.budgetAmount = gb.budgetAmount; // budget target carries
    await newGb.save();

    const personalBalances = await PersonalBalance.find({ periodId: active._id });
    for (const pb of personalBalances) {
      const pLeftover = Math.max(0, pb.funded - pb.spent);
      const npb = await getPersonalBalance(pb.userId, next._id);
      npb.funded = family.rolloverPolicy === 'carry_forward' ? pLeftover : 0;
      npb.spent = 0;
      npb.fundedBy = [];
      await npb.save();
    }

    // Carry category budgets forward
    const budgets = await CategoryBudget.find({ familyId: family._id, periodId: active._id });
    for (const b of budgets) {
      await CategoryBudget.updateOne(
        { familyId: family._id, periodId: next._id, category: b.category },
        { $setOnInsert: { budgetAmount: b.budgetAmount } },
        { upsert: true }
      );
    }

    // #30 confetti rain on monthly review — did the family stay under budget?
    const underBudget = gb && gb.budgetAmount > 0 ? gb.spent <= gb.budgetAmount : null;

    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'period_closed',
      message: `${req.user.name} closed the ${family.periodType} tracking period.`,
      meta: { rolloverPolicy: family.rolloverPolicy },
    });
    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'period_opened',
      message: `A new ${family.periodType} period has started (${family.rolloverPolicy === 'carry_forward' ? 'balance carried forward' : 'balance reset to zero'}).`,
    });
    if (underBudget) {
      await logActivity({
        familyId: family._id,
        actor: req.user,
        type: 'period_under_budget',
        message: `🏆 The family closed the period under budget — ${(gb.budgetAmount / 100).toFixed(2)} budget, ${(gb.spent / 100).toFixed(2)} spent. Confetti time!`,
        amount: Math.max(0, gb.budgetAmount - gb.spent),
      });
    }

    res.json({ closed: active, opened: next, rolloverPolicy: family.rolloverPolicy, underBudget });
  })
);

module.exports = router;
