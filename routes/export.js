/**
 * Housley — Excel export routes (ExcelJS, real .xlsx files).
 *  - /api/export/period  → multi-sheet workbook for the current period
 *  - /api/export/range   → single combined sheet for a custom date range
 */

const express = require('express');
const ExcelJS = require('exceljs');
const {
  ExpenseTransaction,
  FundingTransaction,
  User,
} = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, getActivePeriod, getGroceryBalance, getPersonalBalance } = require('./helpers');
const { requirePro } = require('../lib/pro');

const router = express.Router();
router.use(requireAuth);
// Excel export is a Pro feature (free tier keeps the on-screen views).
router.use(requirePro('pro'));

const RM = (sen) => (Number(sen || 0) / 100).toFixed(2);

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6F91' } };
  row.alignment = { vertical: 'middle' };
}

function sendWorkbook(res, workbook, filename) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return workbook.xlsx.write(res).then(() => res.end());
}

/** GET /api/export/period — current period, multi-sheet workbook. */
router.get(
  '/period',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });

    const gb = await getGroceryBalance(family._id, period._id);
    const users = await User.find({ familyId: family._id }).sort({ name: 1 });
    const groceriesTx = await ExpenseTransaction.find({
      familyId: family._id,
      type: 'groceries',
      periodId: period._id,
    }).sort({ createdAt: -1 });
    const personalTx = await ExpenseTransaction.find({
      familyId: family._id,
      type: 'personal',
      periodId: period._id,
    }).sort({ createdAt: -1 });
    const funding = await FundingTransaction.find({
      familyId: family._id,
      periodId: period._id,
    }).sort({ createdAt: -1 });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Housley';
    wb.created = new Date();

    // ---- Overview sheet ----------------------------------------------------
    const ov = wb.addWorksheet('Overview');
    ov.columns = [
      { header: 'Metric', key: 'metric', width: 34 },
      { header: 'Value (RM)', key: 'value', width: 18 },
    ];
    ov.addRow({ metric: 'Family', value: family.name });
    ov.addRow({ metric: 'Period', value: `${period.startDate.toLocaleDateString('en-MY')} → ${period.endDate.toLocaleDateString('en-MY')}` });
    ov.addRow({ metric: 'Period type', value: family.periodType });
    ov.addRow({ metric: 'Rollover policy', value: family.rolloverPolicy });
    ov.addRow({});
    ov.addRow({ metric: 'Groceries — funded', value: RM(gb.funded) });
    ov.addRow({ metric: 'Groceries — spent', value: RM(gb.spent) });
    ov.addRow({ metric: 'Groceries — remaining', value: RM(Math.max(0, gb.funded - gb.spent)) });
    ov.addRow({ metric: 'Groceries — budget target', value: RM(gb.budgetAmount) });
    ov.addRow({});
    ov.addRow({ metric: 'Member', value: 'Personal funded' });
    for (const u of users) {
      const pb = await getPersonalBalance(u._id, period._id);
      ov.addRow({ metric: u.name, value: RM(pb.funded) });
    }
    ov.getRow(1).font = { bold: true, size: 14 };
    ov.getRow(6).font = { bold: true };
    ov.getRow(11).font = { bold: true };

    // ---- Groceries sheet ----------------------------------------------------
    const gs = wb.addWorksheet('Groceries Transactions');
    gs.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Who', key: 'who', width: 22 },
      { header: 'Shop', key: 'shop', width: 24 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Amount (RM)', key: 'amount', width: 14 },
      { header: 'Payment', key: 'payment', width: 16 },
      { header: 'Note', key: 'note', width: 30 },
    ];
    styleHeader(gs.getRow(1));
    const gName = new Map(users.map((u) => [String(u._id), u.name]));
    for (const t of groceriesTx) {
      gs.addRow({
        date: t.createdAt.toLocaleDateString('en-MY'),
        who: gName.get(String(t.spentById)) || '',
        shop: t.shopName,
        category: t.category,
        amount: RM(t.amount),
        payment: t.paymentMethod,
        note: t.note,
      });
    }
    gs.addRow({});
    gs.addRow({ shop: 'TOTAL', amount: RM(groceriesTx.reduce((s, t) => s + t.amount, 0)) }).font = { bold: true };

    // ---- Personal sheet ------------------------------------------------------
    const ps = wb.addWorksheet('Personal Transactions');
    ps.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Who', key: 'who', width: 22 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Amount (RM)', key: 'amount', width: 14 },
      { header: 'Payment', key: 'payment', width: 16 },
      { header: 'Note', key: 'note', width: 30 },
    ];
    styleHeader(ps.getRow(1));
    for (const t of personalTx) {
      ps.addRow({
        date: t.createdAt.toLocaleDateString('en-MY'),
        who: gName.get(String(t.spentById)) || '',
        category: t.category,
        amount: RM(t.amount),
        payment: t.paymentMethod,
        note: t.note,
      });
    }
    ps.addRow({});
    ps.addRow({ who: 'TOTAL', amount: RM(personalTx.reduce((s, t) => s + t.amount, 0)) }).font = { bold: true };

    // ---- Funding sheet ---------------------------------------------------------
    const fs = wb.addWorksheet('Funding');
    fs.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Who funded', key: 'who', width: 22 },
      { header: 'Target', key: 'target', width: 22 },
      { header: 'Amount (RM)', key: 'amount', width: 14 },
      { header: 'Method', key: 'method', width: 16 },
      { header: 'Note', key: 'note', width: 30 },
    ];
    styleHeader(fs.getRow(1));
    for (const t of funding) {
      fs.addRow({
        date: t.createdAt.toLocaleDateString('en-MY'),
        who: gName.get(String(t.fundedById)) || '',
        target: t.type === 'groceries' ? 'Groceries' : gName.get(String(t.userId)) || '',
        amount: RM(t.amount),
        method: t.paymentMethod,
        note: t.note,
      });
    }
    fs.addRow({});
    fs.addRow({ who: 'TOTAL', amount: RM(funding.reduce((s, t) => s + t.amount, 0)) }).font = { bold: true };

    const filename = `housely-period-${period.startDate.toISOString().slice(0, 10)}.xlsx`;
    return sendWorkbook(res, wb, filename);
  })
);

/** GET /api/export/range?startDate&endDate — single combined transaction sheet. */
router.get(
  '/range',
  ah(async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required.' });
    }
    const family = await getFamily(req);
    const from = new Date(startDate);
    const to = new Date(new Date(endDate).getTime() + 86399999);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
      return res.status(400).json({ error: 'Invalid date range.' });
    }

    const expenses = await ExpenseTransaction.find({
      familyId: family._id,
      createdAt: { $gte: from, $lte: to },
    }).sort({ createdAt: 1 });
    const users = await User.find({ familyId: family._id }).select('name');
    const nameMap = new Map(users.map((u) => [String(u._id), u.name]));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Housley';
    const ws = wb.addWorksheet('Transactions');
    ws.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Who', key: 'who', width: 22 },
      { header: 'Shop', key: 'shop', width: 24 },
      { header: 'Category', key: 'category', width: 20 },
      { header: 'Amount (RM)', key: 'amount', width: 14 },
      { header: 'Payment', key: 'payment', width: 16 },
      { header: 'Note', key: 'note', width: 30 },
    ];
    styleHeader(ws.getRow(1));
    for (const t of expenses) {
      ws.addRow({
        date: t.createdAt.toLocaleDateString('en-MY'),
        type: t.type === 'groceries' ? 'Groceries' : 'Personal',
        who: nameMap.get(String(t.spentById)) || '',
        shop: t.shopName,
        category: t.category,
        amount: RM(t.amount),
        payment: t.paymentMethod,
        note: t.note,
      });
    }
    ws.addRow({});
    ws.addRow({ type: 'TOTAL', amount: RM(expenses.reduce((s, t) => s + t.amount, 0)) }).font = { bold: true };

    const filename = `housely-range-${startDate}-to-${endDate}.xlsx`;
    return sendWorkbook(res, wb, filename);
  })
);

module.exports = router;
