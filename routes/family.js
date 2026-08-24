/**
 * Housely — family settings routes (feature #37).
 * Provider can change the family name, the tracking period type
 * (monthly / weekly / annually) and the rollover policy from Settings —
 * no reseeding needed. Changing the period type opens a fresh tracking
 * period sized for the new type and rolls current balances into it.
 */

const express = require('express');
const crypto = require('crypto');
const { Family, User, TrackingPeriod, PersonalBalance } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, getActivePeriod, getGroceryBalance, getPersonalBalance, requireObjectId, logActivity } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

// 6-letter join codes — no confusing letters (O/I/1/0).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INVITE_MAX_USES = 5;

function generateInviteCode() {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

/** GET /api/family/invite — provider sees the current invite code (if any). */
router.get(
  '/invite',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const live =
      family.inviteCode &&
      family.inviteCodeExpiresAt &&
      new Date(family.inviteCodeExpiresAt).getTime() > Date.now() &&
      family.inviteUsesLeft > 0;
    res.json({
      inviteCode: live ? family.inviteCode : null,
      expiresAt: live ? family.inviteCodeExpiresAt : null,
      usesLeft: live ? family.inviteUsesLeft : 0,
    });
  })
);

/** POST /api/family/invite — provider generates a fresh invite code. */
router.post(
  '/invite',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can create invite codes.' });
    }
    const family = await Family.findById(req.user.familyId);
    family.inviteCode = generateInviteCode();
    family.inviteCodeExpiresAt = new Date(Date.now() + INVITE_TTL_MS);
    family.inviteUsesLeft = INVITE_MAX_USES;
    await family.save();
    res.json({
      inviteCode: family.inviteCode,
      expiresAt: family.inviteCodeExpiresAt,
      usesLeft: family.inviteUsesLeft,
    });
  })
);

/**
 * POST /api/family/members — provider adds a family profile (spouse/kids).
 * The new member has no email account — they set their own PIN on first unlock.
 * Body: { name, role }  role: grocery_spender | member | dependent
 */
router.post(
  '/members',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can add family members.' });
    }
    const name = String((req.body || {}).name || '').trim();
    const role = String((req.body || {}).role || '').trim();
    if (!name) return res.status(400).json({ error: 'Enter the member’s name.' });
    if (!['grocery_spender', 'member', 'dependent'].includes(role)) {
      return res.status(400).json({ error: 'Role must be grocery_spender, member or dependent.' });
    }
    const count = await User.countDocuments({ familyId: req.user.familyId });
    if (count >= 10) return res.status(400).json({ error: 'A family can have up to 10 profiles.' });

    const AVATAR_COLORS = ['#ff6f91', '#4e9de6', '#7c5cd6', '#f7b32b', '#6fcf97', '#f39ac2', '#5bc0de', '#f2994a'];
    const user = await User.create({
      familyId: req.user.familyId,
      name: name.slice(0, 60),
      role,
      sortOrder: 99,
      avatarColor: AVATAR_COLORS[count % AVATAR_COLORS.length],
    });

    const period = await getActivePeriod(req.user.familyId);
    if (period) await getPersonalBalance(user._id, period._id);

    await logActivity({
      familyId: req.user.familyId,
      actor: req.user,
      type: 'pin_set',
      subjectUserId: user._id,
      message: `${req.user.name} added ${user.name} to the family.`,
    });
    res.status(201).json({ user: user.toSafeJSON() });
  })
);

/** DELETE /api/family/members/:userId — provider removes a member (never themselves). */
router.delete(
  '/members/:userId',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can remove family members.' });
    }
    const target = await User.findById(requireObjectId(req.params.userId, 'userId'));
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (String(target.familyId) !== String(req.user.familyId)) {
      return res.status(403).json({ error: 'That profile is not in your family.' });
    }
    if (String(target._id) === String(req.user._id)) {
      return res.status(400).json({ error: 'You cannot remove your own profile.' });
    }
    if (target.role === 'provider') {
      return res.status(400).json({ error: 'A family must keep its provider.' });
    }
    await User.deleteOne({ _id: target._id });
    await PersonalBalance.deleteMany({ userId: target._id });
    res.json({ ok: true });
  })
);

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
  end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);
  return { startDate: start, endDate: end };
}

/**
 * POST /api/family/delete-data — provider deletes ALL expense + funding
 * records inside a date range (v3 family request: "delete certain time like
 * month or week of data"). After deletion the active period's balances are
 * recomputed from the records that remain, so nothing drifts.
 *
 * Body: { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
 */
router.post(
  '/delete-data',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can delete family records.' });
    }
    const { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'Pick a date range to delete.' });
    const fromD = new Date(from);
    const toD = new Date(new Date(to).getTime() + 86399999); // inclusive end of day
    if (Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime()) || toD < fromD) {
      return res.status(400).json({ error: 'Invalid date range.' });
    }
    const { ExpenseTransaction, FundingTransaction, User, GroceryBalance, PersonalBalance } = require('../models');
    const family = await getFamily(req);
    const range = { createdAt: { $gte: fromD, $lte: toD } };

    const delExpenses = await ExpenseTransaction.deleteMany({ familyId: family._id, ...range });
    const delFunding = await FundingTransaction.deleteMany({ familyId: family._id, ...range });

    // ---- Recompute the active period's balances from what remains ----------------
    const period = await getActivePeriod(family._id);
    let gb = null;
    let personalRecount = 0;
    if (period) {
      const remainingExpenses = await ExpenseTransaction.find({ familyId: family._id, periodId: period._id }).lean();
      const remainingFunding = await FundingTransaction.find({ familyId: family._id, periodId: period._id }).lean();
      const gSpent = remainingExpenses.filter((e) => e.type === 'groceries').reduce((s, e) => s + e.amount, 0);
      const gFunded = remainingFunding.filter((f) => f.type === 'groceries').reduce((s, f) => s + f.amount, 0);
      gb = await getGroceryBalance(family._id, period._id);
      if (gb) {
        gb.spent = gSpent;
        gb.funded = gFunded;
        await gb.save();
      }
      const users = await User.find({ familyId: family._id }).select('_id');
      for (const u of users) {
        const pb = await getPersonalBalance(u._id, period._id);
        if (!pb) continue;
        const spent = remainingExpenses.filter((e) => e.type === 'personal' && String(e.userId) === String(u._id)).reduce((s, e) => s + e.amount, 0);
        const funded = remainingFunding.filter((f) => f.type === 'personal' && String(f.userId) === String(u._id)).reduce((s, f) => s + f.amount, 0);
        pb.spent = spent;
        pb.funded = funded;
        pb.fundedBy = remainingFunding
          .filter((f) => f.type === 'personal' && String(f.userId) === String(u._id))
          .map((f) => ({ userId: f.fundedById, amount: f.amount, at: f.createdAt }));
        await pb.save();
        personalRecount += 1;
      }
    }

    res.json({
      ok: true,
      deleted: { expenses: delExpenses.deletedCount, funding: delFunding.deletedCount },
      balancesRebuilt: personalRecount > 0 || Boolean(gb),
    });
  })
);

/**
 * PATCH /api/family/limits/:userId — provider sets a member's per-trip
 * Groceries spending limit (feature #23). 0 clears it (unlimited).
 */
router.patch(
  '/limits/:userId',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can set spending limits.' });
    }
    const { User } = require('../models');
    const target = await User.findById(requireObjectId(req.params.userId, 'userId'));
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (String(target.familyId) !== String(req.user.familyId)) {
      return res.status(403).json({ error: 'That profile is not in your family.' });
    }
    const { groceryTripLimit } = req.body || {};
    if (!Number.isInteger(groceryTripLimit) || groceryTripLimit < 0 || groceryTripLimit > 1_000_000_00) {
      return res.status(400).json({ error: 'Limit must be a whole number of sen (0 = unlimited).' });
    }
    target.groceryTripLimit = groceryTripLimit;
    await target.save();
    res.json({ user: target.toSafeJSON(), groceryTripLimit: target.groceryTripLimit });
  })
);

/** GET /api/family — current family settings. */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily(req);
    res.json({
      family: {
        name: family.name,
        periodType: family.periodType,
        rolloverPolicy: family.rolloverPolicy,
        currency: family.currency,
        aiEnabled: family.aiEnabled !== false,
      },
    });
  })
);

/** PATCH /api/family — update name / periodType / rolloverPolicy (provider only). */
router.patch(
  '/',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the provider can change family settings.' });
    }
    const family = await Family.findById(req.user.familyId);
    const { name, periodType, rolloverPolicy, aiEnabled } = req.body || {};

    if (name !== undefined) {
      const clean = String(name || '').trim();
      if (!clean) return res.status(400).json({ error: 'Family name cannot be empty.' });
      family.name = clean.slice(0, 60);
    }
    if (periodType !== undefined) {
      if (!['monthly', 'weekly', 'annually'].includes(periodType)) {
        return res.status(400).json({ error: 'Period type must be monthly, weekly or annually.' });
      }
      if (periodType !== family.periodType) {
        // Close the current period and open a fresh one sized for the new type.
        const active = await getActivePeriod(family._id);
        if (active) {
          active.status = 'closed';
          active.closedAt = new Date();
          await active.save();

          const dates = nextPeriodDates(periodType, new Date());
          const next = await TrackingPeriod.create({
            familyId: family._id,
            startDate: dates.startDate,
            endDate: dates.endDate,
            status: 'active',
          });

          // Roll balances forward into the fresh period
          const gb = await getGroceryBalance(family._id, active._id);
          const leftover = Math.max(0, (gb ? gb.funded : 0) - (gb ? gb.spent : 0));
          const newGb = await getGroceryBalance(family._id, next._id);
          newGb.funded = family.rolloverPolicy === 'carry_forward' ? leftover : 0;
          newGb.spent = 0;
          if (gb && gb.budgetAmount > 0) newGb.budgetAmount = gb.budgetAmount;
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
          family._periodRebuilt = { closed: active._id, opened: next._id };
        }
        family.periodType = periodType;
      }
    }
    if (rolloverPolicy !== undefined) {
      if (!['carry_forward', 'reset'].includes(rolloverPolicy)) {
        return res.status(400).json({ error: 'Rollover policy must be carry_forward or reset.' });
      }
      family.rolloverPolicy = rolloverPolicy;
    }
    if (aiEnabled !== undefined) {
      family.aiEnabled = Boolean(aiEnabled);
    }

    await family.save();
    res.json({
      family: {
        name: family.name,
        periodType: family.periodType,
        rolloverPolicy: family.rolloverPolicy,
        currency: family.currency,
        aiEnabled: family.aiEnabled !== false,
      },
      periodRebuilt: family._periodRebuilt || null,
    });
  })
);

/**
 * POST /api/family/transfer-creator — transfer provider role to another member.
 * Only the current provider can do this. The target must be in the same family.
 * Body: { userId: string }
 */
router.post(
  '/transfer-creator',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the family creator can transfer ownership.' });
    }
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const target = await User.findById(requireObjectId(userId, 'userId'));
    if (!target) return res.status(404).json({ error: 'User not found.' });
    if (String(target.familyId) !== String(req.user.familyId)) {
      return res.status(403).json({ error: 'That profile is not in your family.' });
    }
    if (String(target._id) === String(req.user._id)) {
      return res.status(400).json({ error: 'You are already the family creator.' });
    }

    // Downgrade current provider to member
    req.user.role = 'member';
    await req.user.save();

    // Upgrade target to provider
    target.role = 'provider';
    await target.save();

    await logActivity({
      familyId: req.user.familyId,
      actor: req.user,
      type: 'pin_set',
      subjectUserId: target._id,
      message: `${req.user.name} transferred family ownership to ${target.name}.`,
    });

    res.json({ ok: true, message: `Family ownership transferred to ${target.name}.`, user: target.toSafeJSON() });
  })
);

/**
 * POST /api/family/reset-all-pins — provider clears all family PINs so
 * every member can set up their own fresh PIN.
 */
router.post(
  '/reset-all-pins',
  ah(async (req, res) => {
    if (req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the family creator can reset all PINs.' });
    }

    const result = await User.updateMany(
      { familyId: req.user.familyId },
      { $set: { pinHash: null, failedAttempts: 0, lockedUntil: null } }
    );

    await logActivity({
      familyId: req.user.familyId,
      actor: req.user,
      type: 'pin_set',
      message: `${req.user.name} reset all family PINs. Every member needs to create a new PIN.`,
    });

    res.json({ ok: true, message: `All ${result.modifiedCount} PINs have been cleared. Every member will need to create a new PIN.`, resetCount: result.modifiedCount });
  })
);

module.exports = router;
