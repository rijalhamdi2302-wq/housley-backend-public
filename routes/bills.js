/**
 * Housely — recurring bills routes.
 * A bill is "due soon" when today is within 3 days of its due day-of-month and
 * it hasn't been marked paid this month.
 */

const express = require('express');
const { RecurringBill } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, requireObjectId, isValidMoney, logActivity } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

function dueInfo(bill, now = new Date()) {
  const today = now.getDate();
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dueDay = Math.min(bill.dueDayOfMonth, daysInMonth);

  let dueDate = new Date(year, month, dueDay);
  let thisMonthPaid =
    bill.lastPaidAt &&
    bill.lastPaidAt.getFullYear() === year &&
    bill.lastPaidAt.getMonth() === month;

  let daysUntilDue = Math.round((dueDate.getTime() - new Date(year, month, today).getTime()) / 86400000);
  if (daysUntilDue < 0) {
    // due date already passed this month → next month's occurrence
    const nextMonth = new Date(year, month + 1, 1);
    const nextDays = new Date(year, month + 2, 0).getDate();
    dueDate = new Date(year, month + 1, Math.min(bill.dueDayOfMonth, nextDays));
    daysUntilDue = Math.round((dueDate.getTime() - new Date(year, month, today).getTime()) / 86400000);
    thisMonthPaid = false;
  }
  return { dueDate, daysUntilDue, dueSoon: daysUntilDue <= 3 && !thisMonthPaid, thisMonthPaid };
}

/** GET /api/bills — with computed daysUntilDue and dueSoon. */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const bills = await RecurringBill.find({ familyId: family._id }).sort({ dueDayOfMonth: 1 });
    res.json({
      bills: bills.map((b) => ({
        ...b.toObject(),
        ...dueInfo(b),
      })),
    });
  })
);

/** POST /api/bills — add a bill. */
router.post(
  '/',
  ah(async (req, res) => {
    const { name, expectedAmount, dueDayOfMonth, category } = req.body || {};
    const clean = String(name || '').trim();
    if (!clean) return res.status(400).json({ error: 'Bill name is required.' });
    if (!isValidMoney(expectedAmount)) {
      return res.status(400).json({ error: 'A valid expected amount is required.' });
    }
    const day = Number(dueDayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return res.status(400).json({ error: 'Due day must be between 1 and 31.' });
    }
    const family = await getFamily(req);
    const bill = await RecurringBill.create({
      familyId: family._id,
      name: clean.slice(0, 80),
      expectedAmount,
      dueDayOfMonth: day,
      category: String(category || '').trim().slice(0, 60) || 'Utility Bills',
    });
    res.status(201).json({ bill: { ...bill.toObject(), ...dueInfo(bill) } });
  })
);

/** PATCH /api/bills/:id/mark-paid — mark paid for this cycle. */
router.patch(
  '/:id/mark-paid',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const bill = await RecurringBill.findOne({ _id: id, familyId: family._id });
    if (!bill) return res.status(404).json({ error: 'Bill not found.' });
    bill.lastPaidAt = new Date();
    await bill.save();

    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'bill_paid',
      message: `${req.user.name} marked "${bill.name}" as paid.`,
      amount: bill.expectedAmount,
      meta: { bill: bill.name },
    });
    res.json({ bill: { ...bill.toObject(), ...dueInfo(bill) } });
  })
);

/** DELETE /api/bills/:id */
router.delete(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const bill = await RecurringBill.findOne({ _id: id, familyId: family._id });
    if (!bill) return res.status(404).json({ error: 'Bill not found.' });
    await RecurringBill.deleteOne({ _id: bill._id });
    res.json({ ok: true });
  })
);

module.exports = router;
