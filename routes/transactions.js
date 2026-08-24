/**
 * Housely — transaction history routes.
 * Search/filter expenses and funding; inline edit & delete that correctly
 * adjusts the affected balance. Edit/delete restricted to creator or provider.
 */

const express = require('express');
const { ExpenseTransaction, FundingTransaction, User } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { isPro } = require('../lib/pro');
const {
  ah,
  getFamily,
  getActivePeriod,
  getGroceryBalance,
  getPersonalBalance,
  canEditRecord,
  logActivity,
  requireObjectId,
  isValidMoney,
  dayKey,
} = require('./helpers');

const router = express.Router();
router.use(requireAuth);

/** GET /api/transactions/expenses — searchable/filterable expense list. */
router.get(
  '/expenses',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const q = {
      familyId: family._id,
    };
    // Free tier: history is kept for the last 90 days (Pro = unlimited).
    const historyLimited = !isPro(family);
    if (historyLimited && !(req.query.from)) {
      q.createdAt = { ...(q.createdAt || {}), $gte: new Date(Date.now() - 90 * 86400000) };
    }
    if (req.query.type === 'groceries' || req.query.type === 'personal') q.type = req.query.type;
    if (req.query.cat) q.category = String(req.query.cat).trim().slice(0, 60); // v3 — e.g. ?cat=Petrol
    if (req.query.from) q.createdAt = { ...(q.createdAt || {}), $gte: new Date(req.query.from) };
    if (req.query.to) q.createdAt = { ...(q.createdAt || {}), $lte: new Date(new Date(req.query.to).getTime() + 86399999) };
    const search = String(req.query.search || '').trim();
    if (search) {
      q.$or = [
        { shopName: { $regex: escapeRegex(search), $options: 'i' } },
        { category: { $regex: escapeRegex(search), $options: 'i' } },
        { note: { $regex: escapeRegex(search), $options: 'i' } },
        { 'lineItems.name': { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const expenses = await ExpenseTransaction.find(q).sort({ createdAt: -1 }).limit(limit);
    const users = await User.find({ familyId: family._id }).select('name avatarColor');
    const nameMap = new Map(users.map((u) => [String(u._id), u.name]));
    res.json({
      expenses: expenses.map((e) => ({
        ...e.toObject(),
        spentByName: nameMap.get(String(e.spentById)) || 'Family member',
      })),
      historyLimited,
    });
  })
);

/** PATCH /api/transactions/expenses/:id — edit amount (adjusts balance by delta). */
router.patch(
  '/expenses/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const expense = await ExpenseTransaction.findOne({ _id: id, familyId: family._id });
    if (!expense) return res.status(404).json({ error: 'Expense not found.' });
    if (!canEditRecord(req.user.role, expense.spentById, req.user._id)) {
      return res.status(403).json({ error: 'Only the person who logged this, or the provider, can edit it.' });
    }

    const { amount, category, shopName, note, paymentMethod } = req.body || {};
    if (amount !== undefined) {
      if (!isValidMoney(amount)) return res.status(400).json({ error: 'A valid amount is required.' });
      const delta = amount - expense.amount;
      await adjustBalance(family._id, expense, delta);
      expense.amount = amount;
    }
    if (typeof category === 'string') expense.category = category.trim().slice(0, 60) || expense.category;
    if (typeof shopName === 'string') expense.shopName = shopName.trim().slice(0, 80);
    if (typeof note === 'string') expense.note = note.trim().slice(0, 500);
    if (paymentMethod !== undefined) expense.paymentMethod = paymentMethod;
    await expense.save();

    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'expense_edited',
      subjectUserId: expense.userId,
      message: `${req.user.name} edited a ${expense.type} expense (now ${(expense.amount / 100).toFixed(2)}).`,
      amount: expense.amount,
      meta: { expenseId: String(expense._id) },
    });
    res.json({ expense });
  })
);

/** DELETE /api/transactions/expenses/:id — removes the expense and restores the balance. */
router.delete(
  '/expenses/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const expense = await ExpenseTransaction.findOne({ _id: id, familyId: family._id });
    if (!expense) return res.status(404).json({ error: 'Expense not found.' });
    if (!canEditRecord(req.user.role, expense.spentById, req.user._id)) {
      return res.status(403).json({ error: 'Only the person who logged this, or the provider, can delete it.' });
    }
    await adjustBalance(family._id, expense, -expense.amount);
    await ExpenseTransaction.deleteOne({ _id: expense._id });

    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'expense_deleted',
      subjectUserId: expense.userId,
      message: `${req.user.name} deleted a ${expense.type} expense of ${(expense.amount / 100).toFixed(2)}.`,
      amount: expense.amount,
      meta: { expenseId: String(expense._id) },
    });
    res.json({ ok: true });
  })
);

/** GET /api/transactions/funding — searchable/filterable funding list. */
router.get(
  '/funding',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const q = { familyId: family._id };
    // Free tier: history is kept for the last 90 days (Pro = unlimited).
    const historyLimited = !isPro(family);
    if (historyLimited && !(req.query.from)) {
      q.createdAt = { ...(q.createdAt || {}), $gte: new Date(Date.now() - 90 * 86400000) };
    }
    if (req.query.type === 'groceries' || req.query.type === 'personal') q.type = req.query.type;
    if (req.query.from) q.createdAt = { ...(q.createdAt || {}), $gte: new Date(req.query.from) };
    if (req.query.to) q.createdAt = { ...(q.createdAt || {}), $lte: new Date(new Date(req.query.to).getTime() + 86399999) };
    // Funding records are private money-in details: only the parents see
    // everyone's; everyone else sees their own.
    if (!['provider', 'grocery_spender'].includes(req.user.role)) {
      q.$or = [{ fundedById: req.user._id }, { userId: req.user._id }];
    }
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const funding = await FundingTransaction.find(q).sort({ createdAt: -1 }).limit(limit);
    const users = await User.find({ familyId: family._id }).select('name avatarColor');
    const nameMap = new Map(users.map((u) => [String(u._id), u.name]));
    res.json({
      funding: funding.map((f) => ({
        ...f.toObject(),
        fundedByName: nameMap.get(String(f.fundedById)) || 'Family member',
        targetName: nameMap.get(String(f.userId)) || 'Family member',
      })),
      historyLimited,
    });
  })
);

/** DELETE /api/transactions/funding/:id — removes the funding and reduces the balance. */
router.delete(
  '/funding/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const tx = await FundingTransaction.findOne({ _id: id, familyId: family._id });
    if (!tx) return res.status(404).json({ error: 'Funding record not found.' });
    if (!canEditRecord(req.user.role, tx.fundedById, req.user._id)) {
      return res.status(403).json({ error: 'Only the person who logged this, or the provider, can delete it.' });
    }
    const period = await getActivePeriod(family._id);
    if (period && String(period._id) === String(tx.periodId)) {
      if (tx.type === 'groceries') {
        const gb = await getGroceryBalance(family._id, period._id);
        gb.funded = Math.max(0, gb.funded - tx.amount);
        await gb.save();
      } else {
        const pb = await getPersonalBalance(tx.userId, period._id);
        pb.funded = Math.max(0, pb.funded - tx.amount);
        pb.fundedBy = pb.fundedBy.filter((f) => String(f.userId) !== String(tx.fundedById) || f.amount !== tx.amount);
        await pb.save();
      }
    }
    await FundingTransaction.deleteOne({ _id: tx._id });

    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'funding_deleted',
      subjectUserId: tx.type === 'personal' ? tx.userId : null,
      message: `${req.user.name} deleted a ${tx.type} funding record of ${(tx.amount / 100).toFixed(2)}.`,
      amount: tx.amount,
    });
    res.json({ ok: true });
  })
);

async function adjustBalance(familyId, expense, delta) {
  if (!delta) return;
  const period = await getActivePeriod(familyId);
  if (!period || String(period._id) !== String(expense.periodId)) return; // old periods aren't adjusted
  if (expense.type === 'groceries') {
    const gb = await getGroceryBalance(familyId, period._id);
    gb.spent = Math.max(0, gb.spent + delta);
    await gb.save();
  } else {
    const pb = await getPersonalBalance(expense.userId, period._id);
    pb.spent = Math.max(0, pb.spent + delta);
    await pb.save();
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
