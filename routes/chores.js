/**
 * Housely — chore-to-allowance routes (feature #19).
 * Kids complete chores; a parent approves and the reward lands in the
 * kid's personal balance as a funding transaction (paymentMethod 'chore').
 */

const express = require('express');
const { Chore, FundingTransaction, User } = require('../models');
const { requireAuth } = require('../middleware/auth');
const {
  ah,
  getFamily,
  getActivePeriod,
  getPersonalBalance,
  requireObjectId,
  isValidMoney,
  logActivity,
} = require('./helpers');

const router = express.Router();
router.use(requireAuth);

const canManageChores = (role) => role === 'provider' || role === 'grocery_spender';

/** GET /api/chores — list chores, optionally filtered by assignee/status. */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const q = { familyId: family._id };
    if (req.query.assignedTo) q.assignedTo = requireObjectId(req.query.assignedTo, 'assignedTo');
    if (['pending', 'done', 'approved'].includes(req.query.status)) q.status = req.query.status;
    const chores = await Chore.find(q).sort({ createdAt: -1 });
    const users = await User.find({ familyId: family._id }).select('name role avatarColor').lean();
    const nameMap = new Map(users.map((u) => [String(u._id), u]));
    res.json({
      chores: chores.map((c) => ({
        ...c.toObject(),
        assignee: nameMap.get(String(c.assignedTo)) || null,
      })),
    });
  })
);

/** POST /api/chores — create + assign a chore (parents only). */
router.post(
  '/',
  ah(async (req, res) => {
    if (!canManageChores(req.user.role)) {
      return res.status(403).json({ error: 'Only the provider and grocery spender can create chores.' });
    }
    const { title, emoji, reward, assignedTo } = req.body || {};
    const clean = String(title || '').trim();
    if (!clean) return res.status(400).json({ error: 'Chore title is required.' });
    if (!isValidMoney(reward) || reward <= 0) {
      return res.status(400).json({ error: 'A valid reward amount is required.' });
    }
    const targetId = requireObjectId(assignedTo, 'assignedTo');
    const target = await User.findById(targetId);
    if (!target) return res.status(404).json({ error: 'Assignee not found.' });

    const family = await getFamily(req);
    const chore = await Chore.create({
      familyId: family._id,
      title: clean.slice(0, 100),
      emoji: String(emoji || '🧹').slice(0, 8),
      reward,
      assignedTo: targetId,
      createdById: req.user._id,
    });
    res.status(201).json({ chore });
  })
);

/** PATCH /api/chores/:id — mark done (assignee) or reopen. */
router.patch(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const chore = await Chore.findOne({ _id: id, familyId: family._id });
    if (!chore) return res.status(404).json({ error: 'Chore not found.' });

    const { status } = req.body || {};
    if (status === 'done') {
      if (String(chore.assignedTo) !== String(req.user._id) && !canManageChores(req.user.role)) {
        return res.status(403).json({ error: 'Only the assigned person can mark the chore done.' });
      }
      if (chore.status !== 'pending') return res.status(409).json({ error: 'This chore is no longer pending.' });
      chore.status = 'done';
      chore.completedAt = new Date();
    } else if (status === 'pending') {
      if (!canManageChores(req.user.role)) {
        return res.status(403).json({ error: 'Only parents can reopen a chore.' });
      }
      chore.status = 'pending';
      chore.completedAt = null;
      chore.approvedAt = null;
      chore.approvedById = null;
    } else {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    await chore.save();
    res.json({ chore });
  })
);

/**
 * POST /api/chores/:id/approve — parent approves; reward funds the kid's
 * personal balance for the current period.
 */
router.post(
  '/:id/approve',
  ah(async (req, res) => {
    if (!canManageChores(req.user.role)) {
      return res.status(403).json({ error: 'Only the provider and grocery spender can approve chores.' });
    }
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const chore = await Chore.findOne({ _id: id, familyId: family._id });
    if (!chore) return res.status(404).json({ error: 'Chore not found.' });
    if (chore.status !== 'done') return res.status(409).json({ error: 'Only completed chores can be approved.' });

    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });

    chore.status = 'approved';
    chore.approvedAt = new Date();
    chore.approvedById = req.user._id;
    await chore.save();

    // Reward lands in the kid's personal balance as a chore funding entry
    await FundingTransaction.create({
      familyId: family._id,
      periodId: period._id,
      type: 'personal',
      userId: chore.assignedTo,
      fundedById: req.user._id,
      amount: chore.reward,
      paymentMethod: 'e_wallet', // allowance feels like an e-wallet top-up
      note: `Chore reward: ${chore.title}`,
    });
    const balance = await getPersonalBalance(chore.assignedTo, period._id);
    balance.funded += chore.reward;
    balance.fundedBy.push({ userId: req.user._id, amount: chore.reward, at: new Date() });
    await balance.save();

    const target = await User.findById(chore.assignedTo);
    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'chore_approved',
      subjectUserId: chore.assignedTo,
      message: `${req.user.name} approved “${chore.title}” — ${(chore.reward / 100).toFixed(2)} added to ${target ? target.name.split(' ')[0] : 'their'} allowance! 🧹`,
      amount: chore.reward,
      meta: { chore: chore.title },
    });

    res.json({ chore, balance: publicPersonal(balance) });
  })
);

/** DELETE /api/chores/:id — parents or the creator. */
router.delete(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const chore = await Chore.findOne({ _id: id, familyId: family._id });
    if (!chore) return res.status(404).json({ error: 'Chore not found.' });
    const isCreator = String(chore.createdById) === String(req.user._id);
    if (!isCreator && !canManageChores(req.user.role)) {
      return res.status(403).json({ error: 'Only parents or the creator can remove a chore.' });
    }
    await Chore.deleteOne({ _id: chore._id });
    res.json({ ok: true });
  })
);

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
