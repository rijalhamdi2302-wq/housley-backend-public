/**
 * Housely — Excel import routes.
 * POST /api/import/excel — upload an .xlsx of past expenses. Available to the
 * provider, grocery_spender and member (the same roles that can spend from
 * Groceries). Groceries rows go to the shared pool; "personal" rows go to the
 * importing member's own personal balance. Duplicate groceries rows (same
 * shop + amount + day) are skipped and reported, never double-booked.
 */

const express = require('express');
const ExcelJS = require('exceljs');
const rateLimit = require('express-rate-limit');
const { ExpenseTransaction, Shop, Category } = require('../models');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requirePro } = require('../lib/pro');
const {
  ah,
  getFamily,
  getActivePeriod,
  getGroceryBalance,
  getPersonalBalance,
  logActivity,
  dayKey,
} = require('./helpers');

const router = express.Router();
router.use(requireAuth);
// Excel import is a Pro feature (batch-importing years of history is a power tool).
router.use(requirePro('spark'));

// Batch imports are heavy — keep the door open for real imports, closed for abuse.
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many imports. Please wait a few minutes.' },
  })
);

const MAX_ROWS = 500;

/** Flexible header aliases → canonical column names. */
const HEADER_ALIASES = {
  date: ['date', 'tarikh', 'tanggal', 'day', 'when'],
  shop: ['shop', 'store', 'merchant', 'place', 'description', 'kedai', 'shopname', 'where', 'outlet'],
  amount: ['amount', 'total', 'price', 'cost', 'rm', 'jumlah', 'harga', 'value', 'spent', 'expense'],
  category: ['category', 'kategori', 'cat', 'type category'],
  payment: ['payment', 'paymentmethod', 'payment method', 'method', 'bayaran', 'cara'],
  type: ['type', 'jenis', 'kind', 'balance', 'account'],
  note: ['note', 'notes', 'keterangan', 'remarks', 'comment'],
};

function normalizeKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Resolve a row header word to a canonical column. */
function resolveHeader(word) {
  const key = normalizeKey(word);
  if (!key) return null;
  for (const [canon, aliases] of Object.entries(HEADER_ALIASES)) {
    if (key === canon || aliases.includes(key)) return canon;
  }
  return null;
}

/** Parse an Excel cell into a Date (handles serial numbers + strings). */
function parseDateCell(cell) {
  if (cell === null || cell === undefined || cell === '') return null;
  if (typeof cell === 'number') {
    // Excel serial date: days since 1899-12-30
    const d = new Date(Math.round((cell - 25569) * 86400000));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(cell).trim();
  if (!s) return null;
  // Malaysia writes day-first (12/08/2026 = 12 August) — parse d/m/y explicitly
  // before letting the JS engine guess (which would read 12/08 as Dec 8).
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d2 = new Date(y, Number(m[2]) - 1, Number(m[1]));
    if (!Number.isNaN(d2.getTime()) && d2.getDate() === Number(m[1])) return d2;
  }
  const d = new Date(s); // ISO strings like 2026-08-12 fall through here
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse an amount cell (RM numeric or string) into integer sen. */
function parseAmountCell(cell) {
  if (cell === null || cell === undefined || cell === '') return null;
  let n;
  if (typeof cell === 'number') {
    n = cell;
  } else {
    const cleaned = String(cell).replace(/[RM,rm\s]/g, '');
    n = Number(cleaned);
  }
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/** POST /api/import/excel — body: { data: "<base64 xlsx>" } */
router.post(
  '/excel',
  requireRole('provider', 'grocery_spender', 'member'),
  ah(async (req, res) => {
    const { data } = req.body || {};
    if (typeof data !== 'string' || !data.length) {
      return res.status(400).json({ error: 'Missing Excel file data (base64).' });
    }

    let workbook;
    try {
      workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(data, 'base64'));
    } catch {
      return res.status(400).json({ error: 'That file is not a valid .xlsx workbook.' });
    }

    const sheet = workbook.worksheets[0];
    if (!sheet || !sheet.rowCount) return res.status(400).json({ error: 'The workbook has no data.' });

    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });

    // ---- Header row: first row whose cells resolve to known columns --------------
    let headerMap = null;
    let headerRowIdx = 1;
    for (let r = 1; r <= Math.min(5, sheet.rowCount); r++) {
      const row = sheet.getRow(r);
      const map = {};
      let hits = 0;
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const canon = resolveHeader(cell.text);
        if (canon && !(canon in map)) {
          map[canon] = col;
          hits += 1;
        }
      });
      if (hits >= 2) {
        headerMap = map;
        headerRowIdx = r;
        break;
      }
    }
    if (!headerMap || !(headerMap.date || headerMap.amount)) {
      return res.status(400).json({
        error: 'Could not find a header row. Make sure columns include Date and Amount.',
      });
    }

    // ---- Load existing shops + categories for matching ---------------------------
    // (full docs, not lean — shops found here get usageCount/save() bumped)
    const shops = await Shop.find({ familyId: family._id });
    const categoryNames = (await Category.find({ familyId: family._id }).select('name').lean()).map((c) => c.name);

    const findOrCreateShop = async (name) => {
      const clean = String(name || '').trim();
      if (!clean) return null;
      const existing = shops.find(
        (s) =>
          s.name.toLowerCase() === clean.toLowerCase() ||
          (s.aliases || []).some((a) => a.toLowerCase() === clean.toLowerCase())
      );
      if (existing) return existing;
      const shop = await Shop.create({
        familyId: family._id,
        name: clean,
        type: 'other',
        usageCount: 0,
        learnedCategory: '',
      });
      shops.push(shop);
      return shop;
    };

    const resolveCategory = (raw, type) => {
      const cat = String(raw || '').trim();
      if (cat) {
        const match = categoryNames.find((c) => c.toLowerCase() === cat.toLowerCase());
        if (match) return match;
      }
      return type === 'groceries' ? 'Groceries' : 'Other';
    };

    // ---- Process rows --------------------------------------------------------------
    let imported = 0;
    let duplicates = 0;
    const errors = [];
    const existingGroceries = await ExpenseTransaction.find({ familyId: family._id, type: 'groceries' })
      .select('shopName amount createdAt')
      .lean();

    const logRow = (idx, msg) => {
      if (errors.length < 25) errors.push({ row: idx, message: msg });
    };

    for (let r = headerRowIdx + 1; r <= sheet.rowCount && imported + duplicates + errors.length < MAX_ROWS; r++) {
      const row = sheet.getRow(r);
      // Columns not present in the header simply read as undefined
      const cell = (canon) => {
        const col = headerMap[canon];
        if (!col) return undefined;
        try {
          return row.getCell(col)?.value;
        } catch {
          return undefined;
        }
      };
      const date = parseDateCell(cell('date'));
      if (!date) continue; // skip empty trailing rows
      // Rows before the current period would be booked to the wrong period's
      // balances — surface them instead of silently misattributing money.
      if (date.getTime() < period.startDate.getTime()) {
        logRow(r, `Date (${date.toLocaleDateString('en-MY')}) is before the current period (${period.startDate.toLocaleDateString('en-MY')}).`);
        continue;
      }
      const amount = parseAmountCell(cell('amount'));
      if (amount === null) {
        logRow(r, `Bad or missing amount ("${String(cell('amount') ?? '')}").`);
        continue;
      }

      const rawType = String(cell('type') || '').toLowerCase();
      const type = /personal|peribadi|self|myself/.test(rawType) ? 'personal' : 'groceries';
      if (type === 'groceries' && !['provider', 'grocery_spender', 'member'].includes(req.user.role)) {
        logRow(r, 'You cannot import Groceries rows.');
        continue;
      }

      const shopName = String(cell('shop') || '').trim();
      const paymentRaw = String(cell('payment') || '').trim().toLowerCase();
      const payment = ['online_banking', 'cash', 'credit_card', 'e_wallet'].includes(paymentRaw)
        ? paymentRaw
        : /bank|online/.test(paymentRaw)
          ? 'online_banking'
          : /card/.test(paymentRaw)
            ? 'credit_card'
            : /wallet|tng|touch/.test(paymentRaw)
              ? 'e_wallet'
              : 'cash';
      const category = resolveCategory(cell('category'), type);
      const note = String(cell('note') || '').trim().slice(0, 500);

      if (type === 'groceries') {
        if (!shopName) {
          logRow(r, 'Groceries row needs a shop name.');
          continue;
        }
        // Duplicate guard: same shop + amount + calendar day already exists
        const dupKey = dayKey(date);
        const dup = existingGroceries.find(
          (p) =>
            p.amount === amount &&
            dayKey(new Date(p.createdAt)) === dupKey &&
            p.shopName.toLowerCase() === shopName.toLowerCase()
        );
        if (dup) {
          duplicates += 1;
          continue;
        }
        const shop = await findOrCreateShop(shopName);
        if (shop) shop.usageCount += 1;
        if (shop && category) shop.learnedCategory = category;
        await shop?.save();

        const expense = await ExpenseTransaction.create({
          familyId: family._id,
          periodId: period._id,
          type: 'groceries',
          userId: req.user._id,
          spentById: req.user._id,
          shopId: shop ? shop._id : null,
          shopName: shop ? shop.name : shopName,
          category,
          amount,
          paymentMethod: payment,
          note: note || 'Imported from Excel',
          lineItems: [],
          flags: [],
          imported: true,
          createdAt: date,
        });
        existingGroceries.push(expense);
        const balance = await getGroceryBalance(family._id, period._id);
        balance.spent += amount;
        await balance.save();
        await logActivity({
          familyId: family._id,
          actor: req.user,
          type: 'groceries_spent',
          message: `${req.user.name} spent ${(amount / 100).toFixed(2)} at ${shop ? shop.name : shopName} (imported).`,
          amount,
          meta: { shop: shop ? shop.name : shopName, flags: [], imported: true },
        });
      } else {
        const expense = await ExpenseTransaction.create({
          familyId: family._id,
          periodId: period._id,
          type: 'personal',
          userId: req.user._id,
          spentById: req.user._id,
          shopId: null,
          shopName: shopName.slice(0, 80),
          category,
          amount,
          paymentMethod: payment,
          note: note || 'Imported from Excel',
          lineItems: [],
          flags: [],
          imported: true,
          createdAt: date,
        });
        const balance = await getPersonalBalance(req.user._id, period._id);
        balance.spent += amount;
        await balance.save();
        await logActivity({
          familyId: family._id,
          actor: req.user,
          type: 'personal_spent',
          subjectUserId: req.user._id,
          message: `${req.user.name} spent ${(amount / 100).toFixed(2)}${shopName ? ` at ${shopName}` : ''} from their personal balance (imported).`,
          amount,
          meta: { category, shop: shopName, imported: true },
        });
      }
      imported += 1;
    }

    res.status(201).json({
      imported,
      duplicates,
      errors,
      totalRows: sheet.rowCount - headerRowIdx,
      tip: errors.length === 0 ? undefined : `${errors.length} row(s) skipped — see the errors list.`,
    });
  })
);

module.exports = router;
