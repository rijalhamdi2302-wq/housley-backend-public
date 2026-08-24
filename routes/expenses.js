/**
 * Housely — expenses routes (money out) + shop management.
 * Implements: shop find-or-create with learned categories, catalog auto-sync,
 * unusual-spend flagging, duplicate-entry flagging, cheapest-shop suggestion.
 */

const express = require('express');
const {
  User,
  Shop,
  ExpenseTransaction,
  GroceryCatalogItem,
  GroceryChecklistItem,
  SavingsGoal,
} = require('../models');
const { requireAuth } = require('../middleware/auth');
const {
  ah,
  isValidMoney,
  getFamily,
  getActivePeriod,
  getGroceryBalance,
  getPersonalBalance,
  canSpendGroceries,
  logActivity,
  dayKey,
  requireObjectId,
} = require('./helpers');

const router = express.Router();
router.use(requireAuth);

const PAYMENT_METHODS = ['online_banking', 'cash', 'credit_card', 'e_wallet'];
const MAX_LINE_ITEMS = 100;
const MAX_IMAGE_URL = 6 * 1024 * 1024; // ~4.5 MB decoded

/** Validate an optional receipt/proof image: must be a small base64 data URL. */
function validateImage(image) {
  if (image === undefined || image === null || image === '') return null;
  if (typeof image !== 'string' || !image.startsWith('data:image/') || image.length > MAX_IMAGE_URL) {
    const err = new Error('If attaching a receipt image it must be a data URL under ~4.5 MB.');
    err.status = 400;
    throw err;
  }
  return image;
}

/** Clean optional discount/tax values (sen) — must be sane non-negative money. */
function cleanAdjustment(v, label) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) {
    const err = new Error(`${label} must be a valid amount.`);
    err.status = 400;
    throw err;
  }
  return Math.round(n);
}

/** v3 — recognise a petrol station from its name (MY petrol brands). */
const PETROL_KEYWORDS = ['petronas', 'shell', 'caltex', 'petron', 'bdp', 'bhp', 'esso', 'mobil', 'tecoil', 'federal oil', 'pump', 'petrol'];

function isPetrolName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  // short names ("Shell") should still match; but avoid "Shell" matching "Shellfish"
  return PETROL_KEYWORDS.some((k) => n === k || n.startsWith(k + ' ') || n.includes(' ' + k) || n.includes(k + ' petrol'));
}

// ---------------------------------------------------------------------------
// POST /api/expenses/groceries — log a Groceries expense (provider/spender/member)
// ---------------------------------------------------------------------------
router.post(
  '/groceries',
  ah(async (req, res) => {
    const { shopId, shopName, category, amount, paymentMethod, note, receiptImage, lineItems, imported, discount, tax, shopType } = req.body || {};
    if (!isValidMoney(amount)) return res.status(400).json({ error: 'A valid amount is required.' });
    if (!canSpendGroceries(req.user.role)) {
      return res.status(403).json({ error: 'Dependents cannot spend from the Groceries pool.' });
    }
    if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }
    const receipt = validateImage(receiptImage);
    const discountSen = cleanAdjustment(discount, 'Discount');
    const taxSen = cleanAdjustment(tax, 'Tax');
    if (discountSen > amount) {
      return res.status(400).json({ error: 'Discount cannot be bigger than the amount.' });
    }

    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });

    // ---- Resolve shop: reuse by id or alias-match, else create -----------------
    let shop = null;
    if (shopId) {
      shop = await Shop.findOne({ _id: requireObjectId(shopId, 'shopId'), familyId: family._id });
    }
    const cleanShopName = String(shopName || '').trim();
    if (!shop && cleanShopName) {
      shop = await Shop.findOne({
        familyId: family._id,
        $or: [{ name: { $regex: `^${escapeRegex(cleanShopName)}$`, $options: 'i' } }, { aliases: { $regex: `^${escapeRegex(cleanShopName)}$`, $options: 'i' } }],
      });
    }
    if (!shop && cleanShopName) {
      // v3 — recognise petrol stations automatically so petrol spend gets the
      // right category without anyone having to pick it.
      const petrolish = isPetrolName(cleanShopName) || shopType === 'petrol';
      shop = await Shop.create({
        familyId: family._id,
        name: cleanShopName,
        type: petrolish ? 'petrol' : 'other',
        usageCount: 0,
        learnedCategory: petrolish ? 'Petrol' : '',
      });
    }

    // ---- Learned categorization -------------------------------------------------
    let cat = String(category || '').trim();
    // v3 — a petrol station with no explicit category is always Petrol.
    if (shop && shop.type === 'petrol' && !cat) cat = 'Petrol';
    if (shop && cat) shop.learnedCategory = cat;
    if (shop) {
      shop.usageCount += 1;
      await shop.save();
    }

    // ---- Line items → catalog auto-sync ----------------------------------------
    let items = [];
    if (Array.isArray(lineItems) && lineItems.length) {
      items = lineItems
        .slice(0, MAX_LINE_ITEMS)
        .map((li) => ({
          name: String(li.name || '').trim().slice(0, 120),
          quantity: Math.max(0, Number(li.quantity) || 1),
          unitPrice: Math.max(0, Math.round(Number(li.unitPrice) || 0)),
          totalPrice: Math.max(0, Math.round(Number(li.totalPrice) || 0)),
        }))
        .filter((li) => li.name);
      await syncCatalog(family._id, items, cat);
    }

    // ---- Flagging: unusual spend + duplicate --------------------------------------
    const flags = [];
    const prior = await ExpenseTransaction.find({ familyId: family._id, type: 'groceries' }).select('amount createdAt shopName shopId').lean();
    const meaningful = prior.filter((p) => p.amount > 0);
    if (meaningful.length >= 3) {
      const avg = meaningful.reduce((s, p) => s + p.amount, 0) / meaningful.length;
      if (amount > 2.5 * avg) flags.push('unusual');
    }
    const todayKey = dayKey(new Date());
    const dup = prior.find(
      (p) =>
        p.amount === amount &&
        dayKey(new Date(p.createdAt)) === todayKey &&
        ((shop && p.shopId && String(p.shopId) === String(shop._id)) ||
          (cleanShopName && p.shopName.toLowerCase() === cleanShopName.toLowerCase()))
    );
    if (dup) flags.push('duplicate');

    const expense = await ExpenseTransaction.create({
      familyId: family._id,
      periodId: period._id,
      type: 'groceries',
      userId: req.user._id,
      spentById: req.user._id,
      shopId: shop ? shop._id : null,
      shopName: shop ? shop.name : cleanShopName,
      category: cat || (shop && shop.learnedCategory) || 'Other',
      amount,
      paymentMethod: paymentMethod || 'cash',
      note: String(note || '').slice(0, 500),
      receiptImage: receipt,
      lineItems: items,
      discount: discountSen,
      tax: taxSen,
      flags,
      imported: Boolean(imported),
    });

    const balance = await getGroceryBalance(family._id, period._id);
    balance.spent += amount;
    await balance.save();

    // ---- #13 receipt → shopping list auto-match -----------------------------
    // Any unchecked checklist item whose name matches a line item gets ticked
    // off automatically, so the family doesn't double-manage the list.
    let matchedChecklist = 0;
    if (items.length) {
      const checklist = await GroceryChecklistItem.find({
        familyId: family._id,
        checked: false,
      });
      const itemLower = new Set(items.map((i) => i.name.toLowerCase()));
      for (const c of checklist) {
        const name = (c.name || '').toLowerCase().trim();
        if (name && itemLower.has(name)) {
          c.checked = true;
          await c.save();
          matchedChecklist += 1;
        }
      }
    }

    // ---- #6 round-up savings ------------------------------------------------
    // Every expense rounds up to the next ringgit and the spare change goes
    // into the family's automatic round-up goal.
    let roundup = null;
    const spentSen = amount;
    const remainder = spentSen % 100;
    if (remainder > 0) {
      const spare = 100 - remainder;
      let goal = await SavingsGoal.findOne({ familyId: family._id, isRoundup: true });
      if (!goal) {
        goal = await SavingsGoal.create({
          familyId: family._id,
          name: 'Round-up savings',
          targetAmount: 10000000, // effectively unlimited pot
          currentAmount: 0,
          emoji: '💛',
          isRoundup: true,
        });
      }
      goal.currentAmount += spare;
      goal.contributions.push({ userId: req.user._id, amount: spare, at: new Date() });
      await goal.save();
      roundup = { goalId: String(goal._id), amount: spare };
    }

    // ---- #23 per-member trip limit -------------------------------------------
    // Provider-set max a member may spend from Groceries per trip. We warn
    // (never hard-block — the money is already spent at the shop).
    let overLimit = null;
    if (req.user.groceryTripLimit > 0 && amount > req.user.groceryTripLimit) {
      overLimit = {
        limit: req.user.groceryTripLimit,
        spent: amount,
        over: amount - req.user.groceryTripLimit,
      };
    }

    const itemNames = items.map((i) => i.name).slice(0, 5);
    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'groceries_spent',
      message:
        `${req.user.name} spent ${(amount / 100).toFixed(2)} at ${shop ? shop.name : cleanShopName || 'Groceries'}` +
        (itemNames.length ? ` · ${itemNames.join(', ')}` : '') +
        '.',
      amount,
      meta: { shop: shop ? shop.name : cleanShopName, flags, items: itemNames },
    });

    res.status(201).json({
      expense,
      flags,
      balance: publicExpenseBalance(balance),
      roundup,
      overLimit,
      matchedChecklist,
    });
  })
);

// ---------------------------------------------------------------------------
// POST /api/expenses/personal — log a Personal expense (self only)
// ---------------------------------------------------------------------------
router.post(
  '/personal',
  ah(async (req, res) => {
    const { shopName, category, amount, paymentMethod, note, receiptImage, discount, tax } = req.body || {};
    if (!isValidMoney(amount)) return res.status(400).json({ error: 'A valid amount is required.' });
    if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }
    const receipt = validateImage(receiptImage);
    const discountSen = cleanAdjustment(discount, 'Discount');
    const taxSen = cleanAdjustment(tax, 'Tax');
    if (discountSen > amount) {
      return res.status(400).json({ error: 'Discount cannot be bigger than the amount.' });
    }

    const family = await getFamily(req);
    const period = await getActivePeriod(family._id);
    if (!period) return res.status(409).json({ error: 'No active tracking period.' });

    const expense = await ExpenseTransaction.create({
      familyId: family._id,
      periodId: period._id,
      type: 'personal',
      userId: req.user._id,
      spentById: req.user._id,
      shopId: null,
      shopName: String(shopName || '').trim().slice(0, 80),
      category: String(category || '').trim() || 'Other',
      amount,
      paymentMethod: paymentMethod || 'cash',
      note: String(note || '').slice(0, 500),
      receiptImage: receipt,
      lineItems: [],
      discount: discountSen,
      tax: taxSen,
      flags: [],
    });

    const balance = await getPersonalBalance(req.user._id, period._id);
    balance.spent += amount;
    await balance.save();

    const spendShop = String(shopName || '').trim();
    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'personal_spent',
      subjectUserId: req.user._id,
      message:
        `${req.user.name} spent ${(amount / 100).toFixed(2)}` +
        (spendShop ? ` at ${spendShop}` : '') +
        ' from their personal balance.',
      amount,
      meta: { category, shop: spendShop },
    });

    res.status(201).json({ expense, balance: publicPersonal(balance) });
  })
);

// ---------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------
/** GET /api/expenses/shops — all shops for the picker. */
router.get(
  '/shops',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const shops = await Shop.find({ familyId: family._id }).sort({ usageCount: -1, name: 1 });
    res.json({ shops });
  })
);

/** GET /api/expenses/shops/favorites — most-used shops as quick chips. */
router.get(
  '/shops/favorites',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const shops = await Shop.find({ familyId: family._id }).sort({ usageCount: -1 }).limit(8);
    res.json({ shops });
  })
);

/** GET /api/expenses/shops/cheapest — low-balance suggestion: cheapest shop by avg spend. */
router.get(
  '/shops/cheapest',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const expenses = await ExpenseTransaction.find({ familyId: family._id, type: 'groceries' })
      .select('shopName amount')
      .lean();
    const byShop = {};
    for (const e of expenses) {
      const key = (e.shopName || '').trim().toLowerCase();
      if (!key) continue;
      byShop[key] = byShop[key] || { name: e.shopName, total: 0, count: 0 };
      byShop[key].total += e.amount;
      byShop[key].count += 1;
    }
    const entries = Object.values(byShop).filter((s) => s.count >= 1);
    if (!entries.length) return res.json({ suggestion: null });
    entries.sort((a, b) => a.total / a.count - b.total / b.count);
    const best = entries[0];
    res.json({ suggestion: { name: best.name, avgSpend: Math.round(best.total / best.count), trips: best.count } });
  })
);

/** POST /api/expenses/shops — create a shop directly. */
router.post(
  '/shops',
  ah(async (req, res) => {
    const { name, type, category } = req.body || {};
    const clean = String(name || '').trim();
    if (!clean) return res.status(400).json({ error: 'Shop name is required.' });
    const family = await getFamily(req);
    const existing = await Shop.findOne({ familyId: family._id, name: { $regex: `^${escapeRegex(clean)}$`, $options: 'i' } });
    if (existing) return res.status(409).json({ error: 'That shop already exists.', shop: existing });
    const shop = await Shop.create({
      familyId: family._id,
      name: clean,
      type: type || 'other',
      learnedCategory: String(category || '').trim(),
    });
    res.status(201).json({ shop });
  })
);

// ---------------------------------------------------------------------------
// Catalog sync — any Groceries expense with line items updates the Catalog
// ---------------------------------------------------------------------------
async function syncCatalog(familyId, items, fallbackCategory) {
  for (const item of items) {
    const name = item.name;
    const existing = await GroceryCatalogItem.findOne({ familyId, name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } });
    if (existing) {
      existing.timesBought += 1;
      existing.lastBoughtAt = new Date();
      existing.stockStatus = 'in_stock';
      if (fallbackCategory && !existing.category) existing.category = fallbackCategory;
      await existing.save();
    } else {
      await GroceryCatalogItem.create({
        familyId,
        name,
        category: fallbackCategory || 'Other',
        stockStatus: 'in_stock',
        timesBought: 1,
        lastBoughtAt: new Date(),
      });
    }
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function publicExpenseBalance(balance) {
  return {
    _id: balance._id,
    periodId: balance.periodId,
    funded: balance.funded,
    spent: balance.spent,
    budgetAmount: balance.budgetAmount,
    currentBalance: balance.funded - balance.spent,
  };
}

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
