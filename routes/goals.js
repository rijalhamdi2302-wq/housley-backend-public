/**
 * Housely — savings goals routes.
 * Standalone aspirational tracker, deliberately NOT wired into the real
 * Groceries/Personal balances — the family updates it manually.
 *
 * Features: shared goals with per-member contributions + leaderboard (#24),
 * birthday/event funds with a date and monthly target (#25), and the
 * automatic round-up goal that spare change from expenses flows into (#6).
 */

const express = require('express');
const { SavingsGoal, User } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, requireObjectId, isValidMoney, logActivity } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

/** GET /api/goals — goals with leaderboard + event info enriched. */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const goals = await SavingsGoal.find({ familyId: family._id }).sort({ createdAt: -1 });
    const users = await User.find({ familyId: family._id }).select('name role').lean();
    const nameMap = new Map(users.map((u) => [String(u._id), u.name]));

    const enriched = goals.map((g) => {
      const obj = g.toObject();
      // Leaderboard: who saved the most toward this goal
      const byUser = new Map();
      for (const c of g.contributions || []) {
        const key = String(c.userId);
        byUser.set(key, (byUser.get(key) || 0) + c.amount);
      }
      obj.leaderboard = [...byUser.entries()]
        .map(([userId, amount]) => ({ userId, name: nameMap.get(userId) || 'Family', amount }))
        .sort((a, b) => b.amount - a.amount);
      // Event fund helper numbers
      if (obj.type === 'event' && obj.eventDate) {
        const now = new Date();
        const target = new Date(obj.eventDate);
        const msLeft = target.getTime() - now.getTime();
        obj.daysLeft = msLeft > 0 ? Math.ceil(msLeft / 86400000) : 0;
        const monthsLeft = Math.max(1, Math.ceil(obj.daysLeft / 30));
        const remaining = Math.max(0, obj.targetAmount - obj.currentAmount);
        obj.monthlyTarget = Math.ceil(remaining / monthsLeft);
        obj.overdue = msLeft <= 0 && !obj.reached;
      }
      return obj;
    });
    res.json({ goals: enriched });
  })
);

/** POST /api/goals — add a goal (optionally an event fund with a date). */
router.post(
  '/',
  ah(async (req, res) => {
    const { name, targetAmount, emoji, type, eventDate } = req.body || {};
    const clean = String(name || '').trim();
    if (!clean) return res.status(400).json({ error: 'Goal name is required.' });
    if (!isValidMoney(targetAmount) || targetAmount <= 0) {
      return res.status(400).json({ error: 'A valid target amount is required.' });
    }
    const goalType = type === 'event' ? 'event' : 'normal';
    let parsedDate = null;
    if (goalType === 'event') {
      parsedDate = eventDate ? new Date(eventDate) : null;
      if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: 'Event funds need a valid date.' });
      }
    }
    const family = await getFamily(req);
    const goal = await SavingsGoal.create({
      familyId: family._id,
      name: clean.slice(0, 80),
      targetAmount,
      emoji: String(emoji || '🎯').slice(0, 8),
      type: goalType,
      eventDate: parsedDate,
    });
    res.status(201).json({ goal });
  })
);

/** PATCH /api/goals/:id/contribute — add money toward the goal (records who). */
router.patch(
  '/:id/contribute',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const { amount } = req.body || {};
    if (!isValidMoney(amount) || amount <= 0) {
      return res.status(400).json({ error: 'A valid contribution amount is required.' });
    }
    const family = await getFamily(req);
    const goal = await SavingsGoal.findOne({ _id: id, familyId: family._id });
    if (!goal) return res.status(404).json({ error: 'Goal not found.' });

    goal.currentAmount += amount;
    goal.contributions.push({ userId: req.user._id, amount, at: new Date() });
    if (goal.currentAmount >= goal.targetAmount && !goal.reached) {
      goal.currentAmount = goal.targetAmount;
      goal.reached = true;
      goal.reachedAt = new Date();
      await goal.save();
      await logActivity({
        familyId: family._id,
        actor: req.user,
        type: 'goal_reached',
        message: `🎉 ${req.user.name} reached the savings goal "${goal.name}"!`,
        amount: goal.targetAmount,
        meta: { goal: goal.name },
      });
      return res.json({ goal, reachedNow: true });
    }
    await goal.save();
    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'goal_contributed',
      message: `${req.user.name} added ${(amount / 100).toFixed(2)} to "${goal.name}".`,
      amount,
      meta: { goal: goal.name },
    });
    res.json({ goal, reachedNow: false });
  })
);

/** DELETE /api/goals/:id */
router.delete(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const goal = await SavingsGoal.findOne({ _id: id, familyId: family._id });
    if (!goal) return res.status(404).json({ error: 'Goal not found.' });
    await SavingsGoal.deleteOne({ _id: goal._id });
    res.json({ ok: true });
  })
);

module.exports = router;
