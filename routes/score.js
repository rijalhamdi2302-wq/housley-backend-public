/**
 * Housley — Spending Score engine (Task C from v6.md).
 *
 * Computes a 0-100 spending score per member and per family based on 6 weighted factors:
 *   Budget Adherence          30%   (% of categories within budget)
 *   Spending Consistency      20%   (lower period-to-period variance = higher score)
 *   Savings Contribution Rate 20%   (% of funds that went to savings goals/round-ups)
 *   Essential-to-Discretionary 15%  (needs vs wants vs historical baseline)
 *   Overspend Recovery        10%   (how fast over-budget categories get corrected)
 *   Tracking Consistency      5%    (logging regularity + categorization completeness)
 *
 * Gates:
 *   Free    → score number + band + one-line status only
 *   Sparq+  → score breakdown (6 factors), full history chart, category health
 *   Prava+  → family benchmarking, recovery plan, personalized advice
 *   Veylt   → spending DNA, AI coach context, what-if simulation data
 */

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { Family, User, ExpenseTransaction, FundingTransaction, TrackingPeriod, CategoryBudget, SavingsGoal, GroceryBalance, PersonalBalance } = require('../models');
const { ah, getFamily } = require('./helpers');
const pro = require('../lib/pro');

const router = express.Router();

/* ─── Score bands ─── */
const BANDS = [
  { min: 0,  max: 40,  label: 'Needs Attention', color: '#ef4444' },
  { min: 41, max: 60,  label: 'Fair',            color: '#f97316' },
  { min: 61, max: 75,  label: 'Good',            color: '#84cc16' },
  { min: 76, max: 90,  label: 'Great',           color: '#22c55e' },
  { min: 91, max: 100, label: 'Excellent',        color: '#eab308' },
];

function getBand(score) {
  return BANDS.find(b => score >= b.min && score <= b.max) || BANDS[0];
}

/* ─── Helper: get active period for a family ─── */
async function getActivePeriod(familyId) {
  return TrackingPeriod.findOne({ familyId, status: 'active' }).sort({ startDate: -1 }).lean();
}

/* ─── Helper: get previous closed period ─── */
async function getPreviousPeriod(familyId) {
  return TrackingPeriod.findOne({ familyId, status: 'closed' }).sort({ endDate: -1 }).lean();
}

/* ─── Factor 1: Budget Adherence (30%) ─── */
async function calcBudgetAdherence(familyId, periodId) {
  const budgets = await CategoryBudget.find({ familyId, periodId }).lean();
  if (!budgets.length) return { score: 50, detail: 'No budgets set yet', tip: 'Set category budgets to improve tracking.' };

  const expenses = await ExpenseTransaction.find({ familyId, periodId }).lean();
  const categorySpend = {};
  for (const e of expenses) {
    const cat = e.category || 'Other';
    categorySpend[cat] = (categorySpend[cat] || 0) + e.amount;
  }

  let withinBudget = 0;
  let total = 0;
  for (const b of budgets) {
    total++;
    const spent = categorySpend[b.category] || 0;
    if (spent <= b.budgetAmount) withinBudget++;
  }

  const pct = total > 0 ? withinBudget / total : 0.5;
  const score = Math.round(pct * 100);
  return {
    score,
    detail: `${withinBudget}/${total} categories within budget`,
    tip: total > withinBudget ? 'Try setting realistic budgets for overspent categories.' : 'Great job staying within budget!',
  };
}

/* ─── Factor 2: Spending Consistency (20%) ─── */
async function calcSpendingConsistency(familyId, currentPeriodId) {
  const recent = await TrackingPeriod.find({ familyId }).sort({ endDate: -1 }).limit(6).lean();
  if (recent.length < 2) return { score: 50, detail: 'Need at least 2 periods', tip: 'Keep tracking for better insights.' };

  const totals = [];
  for (const p of recent) {
    const exp = await ExpenseTransaction.aggregate([
      { $match: { familyId: familyId, periodId: p._id } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    totals.push(exp[0]?.total || 0);
  }

  if (totals.length < 2) return { score: 50, detail: 'Insufficient data', tip: 'Keep tracking consistently.' };

  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  const variance = totals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / totals.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0; // coefficient of variation

  // Lower CV = more consistent = higher score
  const score = Math.max(0, Math.min(100, Math.round(100 - cv * 200)));
  return {
    score,
    detail: `Spending variance: ${(cv * 100).toFixed(0)}%`,
    tip: cv > 0.3 ? 'Try to keep spending more consistent across periods.' : 'Your spending is nicely consistent.',
  };
}

/* ─── Factor 3: Savings Contribution Rate (20%) ─── */
async function calcSavingsRate(familyId, periodId) {
  const fund = await GroceryBalance.findOne({ familyId, periodId }).lean();
  const goals = await SavingsGoal.find({ familyId, reached: false }).lean();

  const totalFunded = fund?.funded || 0;
  if (totalFunded === 0) return { score: 30, detail: 'No funds added yet', tip: 'Fund your account to start tracking savings.' };

  let totalSaved = 0;
  for (const g of goals) {
    for (const c of (g.contributions || [])) {
      // Count contributions made during this period
      if (c.at && fund) {
        const periodStart = new Date(fund.periodId?.startDate || Date.now());
        if (new Date(c.at) >= periodStart) totalSaved += c.amount;
      }
    }
  }

  const rate = totalFunded > 0 ? totalSaved / totalFunded : 0;
  const score = Math.round(Math.min(1, rate * 5) * 100); // 20% savings = 100 score
  return {
    score,
    detail: `${(rate * 100).toFixed(1)}% of funds went to savings`,
    tip: rate < 0.1 ? 'Try setting aside even a small amount each period.' : 'Great savings habit!',
  };
}

/* ─── Factor 4: Essential-to-Discretionary Ratio (15%) ─── */
async function calcEssentialRatio(familyId, periodId) {
  const expenses = await ExpenseTransaction.find({ familyId, periodId }).lean();
  if (!expenses.length) return { score: 50, detail: 'No expenses logged', tip: 'Log expenses to see your spending patterns.' };

  const essential = ['Groceries', 'Utilities', 'Petrol', 'Medical', 'Education', 'Insurance', 'Rent'];
  let essentialTotal = 0;
  let discretionaryTotal = 0;

  for (const e of expenses) {
    const cat = (e.category || 'Other').toLowerCase();
    if (essential.some(es => cat.includes(es.toLowerCase()))) {
      essentialTotal += e.amount;
    } else {
      discretionaryTotal += e.amount;
    }
  }

  const total = essentialTotal + discretionaryTotal;
  const ratio = total > 0 ? essentialTotal / total : 0.5;
  // Ideal: 60-80% essential
  const score = ratio >= 0.6 && ratio <= 0.8 ? 90
    : ratio >= 0.5 && ratio <= 0.9 ? 70
    : ratio >= 0.4 ? 50 : 30;

  return {
    score,
    detail: `${(ratio * 100).toFixed(0)}% essential spending`,
    tip: ratio < 0.5 ? 'Discretionary spending is high — consider cutting non-essentials.' : 'Good balance between needs and wants.',
  };
}

/* ─── Factor 5: Overspend Recovery (10%) ─── */
async function calcOverspendRecovery(familyId, currentPeriodId) {
  const prevPeriod = await getPreviousPeriod(familyId);
  if (!prevPeriod) return { score: 60, detail: 'No previous period', tip: 'Keep tracking to measure recovery.' };

  const budgets = await CategoryBudget.find({ familyId, periodId: prevPeriod._id }).lean();
  if (!budgets.length) return { score: 50, detail: 'No previous budgets', tip: 'Set budgets to track overspend recovery.' };

  const prevExpenses = await ExpenseTransaction.find({ familyId, periodId: prevPeriod._id }).lean();
  const currExpenses = await ExpenseTransaction.find({ familyId, periodId: currentPeriodId }).lean();

  const prevSpend = {};
  const currSpend = {};
  for (const e of prevExpenses) prevSpend[e.category || 'Other'] = (prevSpend[e.category || 'Other'] || 0) + e.amount;
  for (const e of currExpenses) currSpend[e.category || 'Other'] = (currSpend[e.category || 'Other'] || 0) + e.amount;

  let recovered = 0;
  let wasOver = 0;
  for (const b of budgets) {
    if ((prevSpend[b.category] || 0) > b.budgetAmount) {
      wasOver++;
      if ((currSpend[b.category] || 0) <= b.budgetAmount) recovered++;
    }
  }

  const rate = wasOver > 0 ? recovered / wasOver : 1;
  const score = Math.round(rate * 100);
  return {
    score,
    detail: `${recovered}/${wasOver} over-budget categories recovered`,
    tip: wasOver === 0 ? 'No overspending last period — keep it up!' : recovered === wasOver ? 'All overspends corrected!' : 'Focus on categories that were over budget.',
  };
}

/* ─── Factor 6: Tracking Consistency (5%) ─── */
async function calcTrackingConsistency(familyId, periodId) {
  const period = await TrackingPeriod.findById(periodId).lean();
  if (!period) return { score: 50, detail: 'No active period', tip: 'Start a tracking period.' };

  const daysSinceStart = Math.max(1, Math.floor((Date.now() - new Date(period.startDate).getTime()) / 86400000));
  const expenses = await ExpenseTransaction.find({ familyId, periodId }).lean();

  // How many unique days have expenses logged
  const uniqueDays = new Set(expenses.map(e => new Date(e.createdAt).toDateString())).size;
  const dayRatio = Math.min(1, uniqueDays / Math.max(1, daysSinceStart));

  // How many expenses have a category set
  const categorized = expenses.filter(e => e.category && e.category !== 'Other').length;
  const catRatio = expenses.length > 0 ? categorized / expenses.length : 0;

  const score = Math.round(dayRatio * 60 + catRatio * 40);
  return {
    score,
    detail: `Logged on ${uniqueDays}/${daysSinceStart} days`,
    tip: dayRatio < 0.5 ? 'Try to log expenses daily for better insights.' : 'Excellent tracking habit!',
  };
}

/* ─── Compute full score ─── */
async function computeScore(familyId, userId, periodId) {
  const [budget, consistency, savings, essential, recovery, tracking] = await Promise.all([
    calcBudgetAdherence(familyId, periodId),
    calcSpendingConsistency(familyId, periodId),
    calcSavingsRate(familyId, periodId),
    calcEssentialRatio(familyId, periodId),
    calcOverspendRecovery(familyId, periodId),
    calcTrackingConsistency(familyId, periodId),
  ]);

  const factors = [
    { name: 'Budget Adherence', weight: 30, ...budget },
    { name: 'Spending Consistency', weight: 20, ...consistency },
    { name: 'Savings Contribution', weight: 20, ...savings },
    { name: 'Essential vs Discretionary', weight: 15, ...essential },
    { name: 'Overspend Recovery', weight: 10, ...recovery },
    { name: 'Tracking Consistency', weight: 5, ...tracking },
  ];

  const totalScore = Math.round(
    factors.reduce((sum, f) => sum + f.score * (f.weight / 100), 0)
  );

  return {
    score: Math.max(0, Math.min(100, totalScore)),
    band: getBand(totalScore),
    factors,
  };
}

/* ─── GET /api/score/current — current spending score ─── */
router.get(
  '/current',
  requireAuth,
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ score: null, note: 'No tracking period yet.' });

    const result = await computeScore(family._id, req.user._id, period._id);

    // Get delta vs last period
    const prevPeriod = await getPreviousPeriod(family._id);
    let delta = 0;
    if (prevPeriod) {
      const prevResult = await computeScore(family._id, req.user._id, prevPeriod._id);
      delta = result.score - prevResult.score;
    }

    // Determine what to show based on tier
    const tier = pro.normalizeTier(family.proTier || 'none');
    const tierRank = pro.TIER_RANK[tier] || 0;

    res.json({
      score: result.score,
      band: result.band,
      delta,
      periodId: period._id,
      // Free: always show score + band + status
      // Sparq+: show breakdown
      factors: tierRank >= 1 ? result.factors : undefined,
      // Prava+: show benchmarking and recovery data
      // Veylt: show DNA and what-if data
    });
  })
);

/* ─── GET /api/score/history — score history (last 6 periods) ─── */
router.get(
  '/history',
  requireAuth,
  ah(async (req, res) => {
    const family = await getFamily(req);
    const tier = pro.normalizeTier(family.proTier || 'none');
    const tierRank = pro.TIER_RANK[tier] || 0;

    // Free: capped at 3 periods; Sparq+: full 6
    const maxPeriods = tierRank >= 1 ? 6 : 3;

    const periods = await TrackingPeriod.find({ familyId: family._id })
      .sort({ endDate: -1 })
      .limit(maxPeriods)
      .lean();

    const history = [];
    for (const p of periods) {
      const result = await computeScore(family._id, req.user._id, p._id);
      history.push({
        periodId: p._id,
        startDate: p.startDate,
        endDate: p.endDate,
        score: result.score,
        band: result.band,
      });
    }

    res.json({ history, maxPeriods });
  })
);

/* ─── GET /api/score/category-health — traffic-light per category (Sparq+) ─── */
router.get(
  '/category-health',
  requireAuth,
  ah(async (req, res) => {
    const family = await getFamily(req);
    const tier = pro.normalizeTier(family.proTier || 'none');
    if ((pro.TIER_RANK[tier] || 0) < 1) {
      return res.status(402).json({ error: 'Sparq feature. Upgrade to unlock.', code: 'PRO_REQUIRED' });
    }

    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ categories: [] });

    const budgets = await CategoryBudget.find({ familyId: family._id, periodId: period._id }).lean();
    const expenses = await ExpenseTransaction.find({ familyId: family._id, periodId: period._id }).lean();

    const categorySpend = {};
    for (const e of expenses) {
      const cat = e.category || 'Other';
      categorySpend[cat] = (categorySpend[cat] || 0) + e.amount;
    }

    const categories = budgets.map(b => {
      const spent = categorySpend[b.category] || 0;
      const pct = b.budgetAmount > 0 ? (spent / b.budgetAmount) * 100 : 0;
      return {
        category: b.category,
        spent,
        budget: b.budgetAmount,
        pct: Math.round(pct),
        status: pct <= 75 ? 'green' : pct <= 95 ? 'yellow' : 'red',
      };
    });

    res.json({ categories });
  })
);

/* ─── GET /api/score/anomalies — detect spending outliers (Prava+) ─── */
router.get(
  '/anomalies',
  requireAuth,
  ah(async (req, res) => {
    const family = await getFamily(req);
    const tier = pro.normalizeTier(family.proTier || 'none');
    if ((pro.TIER_RANK[tier] || 0) < 2) {
      return res.status(402).json({ error: 'Prava feature. Upgrade to unlock.', code: 'PRO_REQUIRED' });
    }

    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ anomalies: [] });

    // Get last 6 periods for baseline
    const periods = await TrackingPeriod.find({ familyId: family._id }).sort({ endDate: -1 }).limit(6).lean();
    const anomalies = [];

    for (const p of periods) {
      const expenses = await ExpenseTransaction.find({ familyId: family._id, periodId: p._id }).lean();
      const catTotals = {};
      for (const e of expenses) {
        const cat = e.category || 'Other';
        catTotals[cat] = (catTotals[cat] || 0) + e.amount;
      }
      // Compare current period to historical average
      if (p._id.toString() === period._id.toString()) {
        for (const [cat, total] of Object.entries(catTotals)) {
          const historical = periods.filter(pp => pp._id.toString() !== period._id.toString());
          if (historical.length < 2) continue;
          const histTotals = [];
          for (const hp of historical) {
            const he = await ExpenseTransaction.find({ familyId: family._id, periodId: hp._id, category: cat }).lean();
            histTotals.push(he.reduce((s, e) => s + e.amount, 0));
          }
          const mean = histTotals.reduce((a, b) => a + b, 0) / histTotals.length;
          const stdDev = Math.sqrt(histTotals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / histTotals.length);
          if (stdDev > 0 && total > mean + 2 * stdDev) {
            anomalies.push({ category: cat, amount: total, avg: Math.round(mean), threshold: Math.round(mean + 2 * stdDev), type: 'overspend' });
          }
        }
      }
    }
    res.json({ anomalies });
  })
);

/* ─── GET /api/score/advice — personalized tips (Prava+) ─── */
router.get(
  '/advice',
  requireAuth,
  ah(async (req, res) => {
    const family = await getFamily(req);
    const tier = pro.normalizeTier(family.proTier || 'none');
    if ((pro.TIER_RANK[tier] || 0) < 2) {
      return res.status(402).json({ error: 'Prava feature. Upgrade to unlock.', code: 'PRO_REQUIRED' });
    }

    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ tips: [] });

    const expenses = await ExpenseTransaction.find({ familyId: family._id, periodId: period._id }).lean();
    const budgets = await CategoryBudget.find({ familyId: family._id, periodId: period._id }).lean();
    const tips = [];

    // Find top spending categories
    const catSpend = {};
    for (const e of expenses) catSpend[e.category || 'Other'] = (catSpend[e.category || 'Other'] || 0) + e.amount;
    const sorted = Object.entries(catSpend).sort((a, b) => b[1] - a[1]);

    if (sorted.length > 0) {
      const [topCat, topAmt] = sorted[0];
      tips.push({ title: `Top spender: ${topCat}`, description: `You spent RM ${(topAmt / 100).toFixed(2)} on ${topCat} this period. Consider setting a budget for it.`, type: 'insight' });
    }

    // Check for categories over budget
    for (const b of budgets) {
      const spent = catSpend[b.category] || 0;
      if (spent > b.budgetAmount) {
        const over = ((spent - b.budgetAmount) / 100).toFixed(2);
        tips.push({ title: `${b.category} over budget`, description: `You exceeded your ${b.category} budget by RM ${over}. Try reducing spending in this category.`, type: 'warning' });
      }
    }

    // Check payment method diversity
    const methods = new Set(expenses.map(e => e.paymentMethod));
    if (methods.size === 1) {
      tips.push({ title: 'Payment diversity', description: `All expenses paid via ${expenses[0]?.paymentMethod || 'unknown'}. Consider using different methods for better tracking.`, type: 'tip' });
    }

    res.json({ tips });
  })
);

/* ─── POST /api/score/whatif — project score changes (Veylt) ─── */
router.post(
  '/whatif',
  requireAuth,
  ah(async (req, res) => {
    const family = await getFamily(req);
    const tier = pro.normalizeTier(family.proTier || 'none');
    if ((pro.TIER_RANK[tier] || 0) < 3) {
      return res.status(402).json({ error: 'Veylt feature. Upgrade to unlock.', code: 'PRO_REQUIRED' });
    }

    const { adjustments } = req.body || {}; // { category: senDelta }
    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ projectedScore: 0 });

    const result = await computeScore(family._id, req.user._id, period._id);
    let projectedScore = result.score;

    // Simple projection: reduce overspend factor if budget adjustments are made
    if (adjustments && typeof adjustments === 'object') {
      const budgets = await CategoryBudget.find({ familyId: family._id, periodId: period._id }).lean();
      for (const b of budgets) {
        if (adjustments[b.category] !== undefined) {
          const reduction = adjustments[b.category];
          if (reduction < 0) projectedScore += Math.min(5, Math.abs(reduction) / 1000);
          else projectedScore -= Math.min(3, reduction / 1000);
        }
      }
    }

    res.json({ projectedScore: Math.max(0, Math.min(100, Math.round(projectedScore))), currentScore: result.score });
  })
);

module.exports = router;
