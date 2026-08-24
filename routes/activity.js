/**
 * Housely — activity / notification feed with visibility filtering.
 *
 * Rules:
 *  - Groceries-related activity: visible to the whole family (shared knowledge).
 *  - Personal-related activity: visible to the person it concerns, the person who
 *    acted, and the provider. The grocery_spender also sees Personal activity that
 *    involves dependent users (their day-to-day management role).
 *  - pin events are treated as personal events about the subject.
 */

const express = require('express');
const { ActivityLog } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

const GROCERIES_TYPES = new Set([
  'groceries_funded',
  'groceries_spent',
  'period_closed',
  'period_opened',
  'checklist_bought',
  'catalog_updated',
]);

/** "Where the money goes" — spending events are shared family knowledge. */
const PUBLIC_SPEND_TYPES = new Set(['personal_spent']);

/** Personal money events — private to the person, the actor, and the parents. */
const PERSONAL_TYPES = new Set([
  'personal_funded',
  'pin_set',
  'pin_reset',
  'goal_contributed',
  'goal_reached',
  'bill_paid',
  'expense_edited',
  'expense_deleted',
  'funding_deleted',
]);

/** GET /api/activity — the visibility-filtered feed. */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const me = req.user;

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const logs = await ActivityLog.find({ familyId: family._id }).sort({ createdAt: -1 }).limit(limit);

    const visible = logs.filter((log) => {
      if (GROCERIES_TYPES.has(log.type) || PUBLIC_SPEND_TYPES.has(log.type)) return true;
      if (PERSONAL_TYPES.has(log.type)) {
        const mine = String(log.subjectUserId || '') === String(me._id);
        const actedByMe = String(log.actorId) === String(me._id);
        if (mine || actedByMe) return true;
        // Only the parents can see other people's personal money events.
        if (['provider', 'grocery_spender'].includes(me.role)) return true;
        return false;
      }
      return false;
    });

    res.json({ activity: visible });
  })
);

module.exports = router;
