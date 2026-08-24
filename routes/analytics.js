/**
 * Housely — analytics routes
 * Aggregations computed from the transaction history on demand (never stored).
 */

const express = require('express');
const { ExpenseTransaction, CategoryBudget, TrackingPeriod } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, getActivePeriod, requireObjectId, isValidMoney } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

function groupBy(list, keyFn) {
  const out = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (!out.has(k)) out.set(k, { key: k, value: 0, items: [] });
    out.get(k).value += item.amount;
    out.get(k).items.push(item);
  }
  return [...out.values()];
}

/** GET /api/analytics/trend?bucket=daily|weekly|monthly|yearly&limit=N — spending & funding trend. */
router.get(
  '/trend',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const bucket = ['daily', 'weekly', 'monthly', 'yearly'].includes(req.query.bucket) ? req.query.bucket : 'monthly';
    const limit = Math.min(24, Math.max(2, parseInt(req.query.limit, 10) || 12));

    const expenses = await ExpenseTransaction.find({ familyId: family._id })
      .select('amount type createdAt')
      .lean();
    const funding = await require('../models').FundingTransaction.find({ familyId: family._id })
      .select('amount createdAt')
      .lean();

    const now = new Date();
    const buckets = [];
    for (let i = limit - 1; i >= 0; i--) {
      let start, end, label;
      if (bucket === 'daily') {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        start = d;
        end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
        label = d.toLocaleDateString('en-MY', { weekday: 'short', day: 'numeric' });
      } else if (bucket === 'weekly') {
        const dayOffset = (now.getDay() + 6) % 7; // Monday = 0
        const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset);
        start = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - 7 * i);
        end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
        label = start.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' });
      } else if (bucket === 'monthly') {
        start = new Date(now.getFullYear(), now.getMonth() - i, 1);
        end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
        // include the year on months outside the current year so labels never repeat
        label =
          start.getFullYear() === now.getFullYear()
            ? start.toLocaleDateString('en-MY', { month: 'short' })
            : start.toLocaleDateString('en-MY', { month: 'short', year: '2-digit' });
      } else {
        start = new Date(now.getFullYear() - i, 0, 1);
        end = new Date(now.getFullYear() - i + 1, 0, 1);
        label = String(start.getFullYear());
      }
      buckets.push({ t0: start.getTime(), t1: end.getTime(), label, expenses: 0, groceries: 0, personal: 0, funding: 0 });
    }

    for (const e of expenses) {
      const t = new Date(e.createdAt).getTime();
      const b = buckets.find((x) => t >= x.t0 && t < x.t1);
      if (!b) continue;
      b.expenses += e.amount;
      if (e.type === 'groceries') b.groceries += e.amount;
      else b.personal += e.amount;
    }
    for (const f of funding) {
      const t = new Date(f.createdAt).getTime();
      const b = buckets.find((x) => t >= x.t0 && t < x.t1);
      if (b) b.funding += f.amount;
    }

    const data = buckets.map((b, i) => {
      const prev = i > 0 ? buckets[i - 1].expenses : null;
      let change = null;
      if (prev !== null && prev > 0) change = Math.round(((b.expenses - prev) / prev) * 1000) / 10;
      return { label: b.label, expenses: b.expenses, groceries: b.groceries, personal: b.personal, funding: b.funding, change };
    });
    res.json({ bucket, data });
  })
);

/** GET /api/analytics/weekday-pattern — spend by day of the week (all history). */
router.get(
  '/weekday-pattern',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const expenses = await ExpenseTransaction.find({ familyId: family._id })
      .select('amount createdAt')
      .lean();
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const sums = new Array(7).fill(0);
    for (const e of expenses) {
      const d = new Date(e.createdAt);
      const idx = (d.getDay() + 6) % 7;
      sums[idx] += e.amount;
    }
    res.json({ data: names.map((name, i) => ({ name, amount: sums[i] })) });
  })
);

/** GET /api/analytics/member-comparison — who spent what this period. */
router.get(
  '/member-comparison',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ data: [] });
    const expenses = await ExpenseTransaction.find({ familyId: family._id, periodId: period._id })
      .select('amount spentById')
      .lean();
    const rows = groupBy(expenses, (e) => String(e.spentById));
    rows.sort((a, b) => b.value - a.value);
    const users = await require('../models').User.find({ familyId: family._id }).select('name').lean();
    const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
    res.json({
      data: rows.map((r) => ({
        userId: r.key,
        name: nameOf.get(r.key) || 'Family',
        amount: r.value,
        trips: r.items.length,
      })),
    });
  })
);

/** GET /api/analytics/top-expenses — the biggest single purchases ever. */
router.get(
  '/top-expenses',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const expenses = await ExpenseTransaction.find({ familyId: family._id })
      .sort({ amount: -1 })
      .limit(6)
      .select('shopName category amount createdAt type spentById')
      .lean();
    const users = await require('../models').User.find({ familyId: family._id }).select('name').lean();
    const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
    res.json({
      data: expenses.map((e) => ({
        _id: e._id,
        shopName: e.shopName,
        category: e.category,
        amount: e.amount,
        type: e.type,
        date: e.createdAt,
        spentByName: nameOf.get(String(e.spentById)) || 'Family',
      })),
    });
  })
);

/** GET /api/analytics/top-shops — favourite shops by total spend (all types). */
router.get(
  '/top-shops',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const expenses = await ExpenseTransaction.find({ familyId: family._id })
      .select('shopName amount')
      .lean();
    const rows = groupBy(expenses, (e) => (e.shopName || '').trim() || 'Unknown');
    rows.sort((a, b) => b.value - a.value);
    res.json({
      data: rows.slice(0, 8).map((r) => ({ name: r.key, amount: r.value, trips: r.items.length })),
    });
  })
);

/** GET /api/analytics/weekly-recap — rolling 7-day spend: total + dominant category. */
router.get(
  '/weekly-recap',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const since = new Date(Date.now() - 7 * 86400000);
    const expenses = await ExpenseTransaction.find({ familyId: family._id, createdAt: { $gte: since } })
      .select('amount category type')
      .lean();
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    let top = null;
    if (expenses.length) {
      const cats = groupBy(expenses.filter((e) => e.category), (e) => e.category);
      cats.sort((a, b) => b.value - a.value);
      top = cats[0];
    }
    res.json({
      total,
      trips: expenses.length,
      topCategory: top ? { name: top.key, amount: top.value } : null,
    });
  })
);

/** GET /api/analytics/groceries/by-store — Groceries spend per shop (active period). */
router.get(
  '/groceries/by-store',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ data: [] });
    const expenses = await ExpenseTransaction.find({
      familyId: family._id,
      type: 'groceries',
      periodId: period._id,
    })
      .select('shopName amount')
      .lean();
    const rows = groupBy(expenses, (e) => (e.shopName || 'Unknown').trim() || 'Unknown');
    rows.sort((a, b) => b.value - a.value);
    res.json({ data: rows.map((r) => ({ name: r.key, amount: r.value })) });
  })
);

/** GET /api/analytics/groceries/by-month — last 6 calendar months + MoM change. */
router.get(
  '/groceries/by-month',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const expenses = await ExpenseTransaction.find({ familyId: family._id, type: 'groceries' })
      .select('amount createdAt')
      .lean();
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleString('en-MY', { month: 'short' }),
      });
    }
    const buckets = new Map(months.map((m) => [m.key, 0]));
    for (const e of expenses) {
      const d = new Date(e.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (buckets.has(key)) buckets.set(key, buckets.get(key) + e.amount);
    }
    const data = months.map((m, i) => {
      const amount = buckets.get(m.key);
      const prev = i > 0 ? buckets.get(months[i - 1].key) : null;
      let change = null;
      if (prev !== null && prev > 0) change = Math.round(((amount - prev) / prev) * 1000) / 10;
      return { key: m.key, label: m.label, amount, change };
    });
    res.json({ data });
  })
);

/** GET /api/analytics/groceries/by-period — last 6 tracking periods side by side. */
router.get(
  '/groceries/by-period',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const periods = await TrackingPeriod.find({ familyId: family._id })
      .sort({ startDate: -1 })
      .limit(6)
      .lean();
    periods.reverse();
    const expenses = await ExpenseTransaction.find({ familyId: family._id, type: 'groceries' })
      .select('amount periodId createdAt')
      .lean();
    const periodIds = new Set(periods.map((p) => String(p._id)));
    const buckets = new Map(periods.map((p) => [String(p._id), 0]));
    for (const e of expenses) {
      const key = String(e.periodId);
      if (periodIds.has(key)) buckets.set(key, buckets.get(key) + e.amount);
    }
    const data = periods.map((p) => ({
      periodId: p._id,
      label: p.startDate.toLocaleDateString('en-MY', { month: 'short', day: 'numeric' }),
      amount: buckets.get(String(p._id)),
      status: p.status,
    }));
    res.json({ data });
  })
);

/** GET /api/analytics/payment-method — cash vs card vs e-wallet (all history). */
router.get(
  '/payment-method',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const expenses = await ExpenseTransaction.find({ familyId: family._id })
      .select('amount paymentMethod')
      .lean();
    const rows = groupBy(expenses, (e) => e.paymentMethod || 'cash');
    rows.sort((a, b) => b.value - a.value);
    const labels = {
      cash: 'Cash',
      online_banking: 'Online banking',
      credit_card: 'Credit card',
      e_wallet: 'E-wallet',
    };
    res.json({
      data: rows.map((r) => ({ name: labels[r.key] || r.key, key: r.key, amount: r.value, trips: r.items.length })),
    });
  })
);

/** GET /api/analytics/streak — days under budget + current streak (#29). */
router.get(
  '/streak',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ days: [], streak: 0, best: 0 });
    const { getGroceryBalance } = require('./helpers');
    const gb = await getGroceryBalance(family._id, period._id);
    const expenses = await ExpenseTransaction.find({ familyId: family._id, periodId: period._id })
      .select('amount createdAt')
      .lean();

    const dayCount = Math.min(60, Math.max(7, Math.ceil((period.endDate - period.startDate) / 86400000)));
    const perDayBudget = gb.budgetAmount > 0 ? gb.budgetAmount / dayCount : null;

    const days = [];
    const dailySpend = new Map();
    for (const e of expenses) {
      const d = new Date(e.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dailySpend.set(key, (dailySpend.get(key) || 0) + e.amount);
    }
    const today = new Date();
    for (let i = dayCount - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const spent = dailySpend.get(key) || 0;
      const under = perDayBudget === null ? spent === 0 || spent <= gb.budgetAmount : spent <= perDayBudget;
      days.push({ key, date: d.toISOString().slice(0, 10), spent, under });
    }

    // current streak: consecutive under-budget days ending today (skip future/empty tail)
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i].date > today.toISOString().slice(0, 10)) continue;
      if (days[i].under) streak += 1;
      else break;
    }
    let best = 0;
    let run = 0;
    for (const d of days) {
      run = d.under ? run + 1 : 0;
      best = Math.max(best, run);
    }
    res.json({ days, streak, best, perDayBudget, budgetAmount: gb.budgetAmount });
  })
);

/** GET /api/analytics/badges — computed achievements from real data (#27). */
router.get(
  '/badges',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const { User, SavingsGoal, GroceryChecklistItem, Shop } = require('../models');
    const expenses = await ExpenseTransaction.find({ familyId: family._id })
      .select('amount shopName createdAt type spentById paymentMethod receiptImage')
      .lean();
    const goals = await SavingsGoal.find({ familyId: family._id }).lean();
    const checklist = await GroceryChecklistItem.find({ familyId: family._id }).lean();
    const users = await User.find({ familyId: family._id }).select('name role').lean();
    const shops = await Shop.find({ familyId: family._id }).select('name usageCount').lean();

    const badges = [];
    const add = (id, emoji, name, desc, earned, meta = {}) =>
      badges.push({ id, emoji, name, desc, earned, ...meta });

    const groceries = expenses.filter((e) => e.type === 'groceries');
    // First trip
    add('first_trip', '🌱', 'First Trip', 'Logged your first groceries trip', groceries.length > 0, { count: groceries.length });
    // 10 trips
    add('ten_trips', '🛒', 'Regular Shopper', '10 groceries trips logged', groceries.length >= 10, { count: groceries.length });
    // Receipt keeper — attached 5 receipt photos
    const withReceipts = expenses.filter((e) => e.receiptImage).length;
    add('receipt_keeper', '🧾', 'Receipt Keeper', 'Attached 5 receipt photos', withReceipts >= 5, { count: withReceipts });
    // Goal crusher
    const reached = goals.filter((g) => g.reached).length;
    add('goal_crusher', '🎯', 'Goal Crusher', 'Reached a savings goal', reached >= 1, { count: reached });
    // Cheapest shop 5 times — compare against average shop spend
    const byShop = groupBy(groceries, (e) => (e.shopName || '').trim().toLowerCase() || 'unknown');
    byShop.sort((a, b) => a.value / a.items.length - b.value / b.items.length);
    const cheapestKey = byShop.length ? byShop[0].key : null;
    const cheapestTrips = cheapestKey ? byShop[0].items.length : 0;
    add('savvy_shopper', '🧠', 'Savvy Shopper', 'Shopped at the cheapest store 5 times', cheapestTrips >= 5, { count: cheapestTrips });
    // Checklist champion — checked off 10 items
    const checked = checklist.filter((c) => c.checked).length;
    add('list_master', '✅', 'List Master', 'Tick off 10 shopping-list items', checked >= 10, { count: checked });
    // Team player — funded someone else
    const { FundingTransaction } = require('../models');
    const fundedOthers = await FundingTransaction.countDocuments({ familyId: family._id, userId: { $ne: null } });
    add('generous', '💝', 'Generous Heart', 'Top up someone’s personal balance', fundedOthers > 0, { count: fundedOthers });
    // All in — every member spent
    const spenderIds = new Set(expenses.map((e) => String(e.spentById)));
    add('all_in', '👨‍👩‍👧‍👦', 'All In', 'Every member logged a spend', spenderIds.size >= users.length, { count: spenderIds.size });

    // House points = sum of earned badge weights
    const points = badges.reduce((s, b) => s + (b.earned ? b.weight || 10 : 0), 0);
    const totalPossible = badges.length * 10;
    res.json({ badges, points, totalPossible });
  })
);

/** GET /api/analytics/personal/:userId/category — self or provider only. */
router.get(
  '/personal/:userId/category',
  ah(async (req, res) => {
    const userId = requireObjectId(req.params.userId, 'userId');
    const isSelf = String(userId) === String(req.user._id);
    const canViewOthers = ['provider', 'grocery_spender'].includes(req.user.role);
    if (!isSelf && !canViewOthers) {
      return res.status(403).json({ error: 'You can only view your own personal analytics.' });
    }
    const family = await getFamily(req);
    const expenses = await ExpenseTransaction.find({ familyId: family._id, type: 'personal', userId })
      .select('amount category')
      .lean();
    const rows = groupBy(expenses, (e) => e.category || 'Other');
    rows.sort((a, b) => b.value - a.value);
    res.json({ data: rows.map((r) => ({ name: r.key, amount: r.value })) });
  })
);

/** GET /api/analytics/family/categories — whole-family spend by category (active period). */
router.get(
  '/family/categories',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ data: [] });
    const expenses = await ExpenseTransaction.find({ familyId: family._id, periodId: period._id })
      .select('amount category')
      .lean();
    const rows = groupBy(expenses, (e) => e.category || 'Other');
    rows.sort((a, b) => b.value - a.value);
    res.json({ data: rows.map((r) => ({ name: r.key, amount: r.value })) });
  })
);

/** GET /api/analytics/petrol — the family's petrol spend (active period). */
router.get(
  '/petrol',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ total: 0, trips: 0, avgPerTrip: 0, byStation: [], recent: [] });
    const expenses = await ExpenseTransaction.find({
      familyId: family._id,
      periodId: period._id,
      category: 'Petrol',
    })
      .select('amount shopName createdAt spentById')
      .sort({ createdAt: -1 })
      .lean();
    const total = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const byStation = groupBy(expenses, (e) => (e.shopName || 'Petrol station').trim() || 'Petrol station');
    byStation.sort((a, b) => b.value - a.value);
    const users = await require('../models').User.find({ familyId: family._id }).select('name').lean();
    const nameMap = new Map(users.map((u) => [String(u._id), u.name]));
    res.json({
      total,
      trips: expenses.length,
      avgPerTrip: expenses.length ? Math.round(total / expenses.length) : 0,
      byStation: byStation.slice(0, 6).map((r) => ({ name: r.key, amount: r.value, trips: r.items.length })),
      recent: expenses.slice(0, 10).map((e) => ({
        _id: e._id,
        shopName: e.shopName,
        amount: e.amount,
        createdAt: e.createdAt,
        spentByName: nameMap.get(String(e.spentById)) || 'Family',
      })),
    });
  })
);

/** GET /api/analytics/family/summary — overview used by the Home screen. */
router.get(
  '/family/summary',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });

    const { getGroceryBalance, getPersonalBalance } = require('./helpers');
    const { User } = require('../models');
    const gb = await getGroceryBalance(family._id, period._id);
    const daysLeft = Math.max(0, Math.ceil((period.endDate.getTime() - Date.now()) / 86400000) + 1);
    const remainingBudget = gb.budgetAmount - gb.spent;
    const remainingBalance = gb.funded - gb.spent;
    const safeToSpend =
      gb.budgetAmount > 0
        ? Math.max(0, Math.floor(remainingBudget / Math.max(1, daysLeft)))
        : Math.max(0, Math.floor(remainingBalance / Math.max(1, daysLeft)));
    const groceries = {
      funded: gb.funded,
      spent: gb.spent,
      budgetAmount: gb.budgetAmount,
      currentBalance: gb.funded - gb.spent,
      safeToSpend,
      daysLeft,
      budgetSet: gb.budgetAmount > 0,
    };
    const users = await User.find({ familyId: family._id }).sort({ sortOrder: 1, name: 1 });
    // Personal balances are private: only the provider and grocery spender see
    // everyone's; everyone else sees just their own.
    const canSeeAllBalances = ['provider', 'grocery_spender'].includes(req.user.role);
    const personal = [];
    for (const u of users) {
      if (!canSeeAllBalances && String(u._id) !== String(req.user._id)) continue;
      const b = await getPersonalBalance(u._id, period._id);
      personal.push({
        // v3 — include avatarPhoto so photos set by any member show everywhere
        user: { _id: u._id, name: u.name, role: u.role, avatarColor: u.avatarColor, avatarPhoto: u.avatarPhoto || null },
        funded: b.funded,
        spent: b.spent,
        currentBalance: b.funded - b.spent,
      });
    }
    const expenses = await ExpenseTransaction.find({ familyId: family._id, periodId: period._id }).lean();
    const totalGroceriesSpent = expenses.filter((e) => e.type === 'groceries').reduce((s, e) => s + e.amount, 0);
    const totalPersonalSpent = expenses.filter((e) => e.type === 'personal').reduce((s, e) => s + e.amount, 0);

    res.json({
      family: { name: family.name, periodType: family.periodType, rolloverPolicy: family.rolloverPolicy, currency: family.currency },
      period: { startDate: period.startDate, endDate: period.endDate, daysLeft: Math.max(0, Math.ceil((period.endDate - Date.now()) / 86400000)) },
      groceries,
      personal,
      totals: { totalGroceriesSpent, totalPersonalSpent, combined: totalGroceriesSpent + totalPersonalSpent },
    });
  })
);

/** GET /api/analytics/category-budgets — per-category budget vs actual spend. */
router.get(
  '/category-budgets',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.json({ budgets: [] });
    const budgets = await CategoryBudget.find({ familyId: family._id, periodId: period._id }).sort({
      category: 1,
    });
    const expenses = await ExpenseTransaction.find({ familyId: family._id, periodId: period._id })
      .select('category amount')
      .lean();
    const spent = new Map();
    for (const e of expenses) spent.set(e.category, (spent.get(e.category) || 0) + e.amount);
    res.json({
      budgets: budgets.map((b) => ({
        _id: b._id,
        category: b.category,
        budgetAmount: b.budgetAmount,
        spent: spent.get(b.category) || 0,
      })),
    });
  })
);

/** PATCH /api/analytics/category-budgets/:category — provider only. */
router.patch(
  '/category-budgets/:category',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can set category budgets.' });
    }
    const category = String(req.params.category || '').trim().slice(0, 60);
    const { budgetAmount } = req.body || {};
    if (!category) return res.status(400).json({ error: 'Category is required.' });
    if (!isValidMoney(budgetAmount)) {
      return res.status(400).json({ error: 'A valid budget amount is required.' });
    }
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });

    const budget = await CategoryBudget.findOneAndUpdate(
      { familyId: family._id, periodId: period._id, category },
      { $set: { budgetAmount } },
      { upsert: true, new: true }
    );
    res.json({ budget });
  })
);

module.exports = router;
