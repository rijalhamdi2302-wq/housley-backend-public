/**
 * Housely — meal planner routes (feature #15).
 * Plan dinners (or any meal) for the week; Housely turns the week's
 * ingredients into a shopping list and estimates the budget from the
 * family's own price history (ExpenseTransaction line items) + catalog.
 */

const express = require('express');
const { MealPlan, GroceryChecklistItem, ExpenseTransaction } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, requireObjectId } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

/** Day-key helper: midnight UTC of the calendar day (dates are stored as dates at 00:00). */
function dayRange(date) {
  const d = new Date(date);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}

/** GET /api/meals?from=YYYY-MM-DD&to=YYYY-MM-DD — meals in a range. */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const q = { familyId: family._id };
    if (req.query.from) {
      const from = new Date(req.query.from);
      const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 6 * 86400000);
      q.date = { $gte: dayRange(from).start, $lte: dayRange(to).end };
    }
    const meals = await MealPlan.find(q).sort({ date: 1, meal: 1, createdAt: 1 });
    res.json({ meals });
  })
);

/** POST /api/meals — create a meal plan for a day. */
router.post(
  '/',
  ah(async (req, res) => {
    const { date, meal, title, emoji, ingredients, note } = req.body || {};
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'A valid date is required.' });
    const clean = String(title || '').trim();
    if (!clean) return res.status(400).json({ error: 'Give the meal a name.' });
    const family = await getFamily(req);
    const plan = await MealPlan.create({
      familyId: family._id,
      date: dayRange(d).start,
      meal: ['dinner', 'lunch', 'breakfast'].includes(meal) ? meal : 'dinner',
      title: clean.slice(0, 80),
      emoji: String(emoji || '🍲').slice(0, 8),
      ingredients: (Array.isArray(ingredients) ? ingredients : [])
        .map((i) => String(i || '').trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 30),
      note: String(note || '').trim().slice(0, 200),
      createdById: req.user._id,
    });
    res.status(201).json({ meal: plan });
  })
);

/** PATCH /api/meals/:id — edit a meal plan. */
router.patch(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const plan = await MealPlan.findOne({ _id: id, familyId: family._id });
    if (!plan) return res.status(404).json({ error: 'Meal plan not found.' });
    const { title, emoji, ingredients, note, meal, date } = req.body || {};
    if (typeof title === 'string' && title.trim()) plan.title = title.trim().slice(0, 80);
    if (typeof emoji === 'string') plan.emoji = emoji.slice(0, 8);
    if (typeof note === 'string') plan.note = note.trim().slice(0, 200);
    if (['dinner', 'lunch', 'breakfast'].includes(meal)) plan.meal = meal;
    if (date && !Number.isNaN(new Date(date).getTime())) plan.date = dayRange(new Date(date)).start;
    if (Array.isArray(ingredients)) {
      plan.ingredients = ingredients.map((i) => String(i || '').trim().slice(0, 80)).filter(Boolean).slice(0, 30);
    }
    await plan.save();
    res.json({ meal: plan });
  })
);

/** DELETE /api/meals/:id */
router.delete(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const plan = await MealPlan.findOne({ _id: id, familyId: family._id });
    if (!plan) return res.status(404).json({ error: 'Meal plan not found.' });
    await MealPlan.deleteOne({ _id: plan._id });
    res.json({ ok: true });
  })
);

/**
 * POST /api/meals/generate-list — turn the meals in a date range into
 * shopping-list items + a budget estimate.
 * Budget estimate: average unit price per ingredient from the family's own
 * receipt line-item history, falling back to a small default (RM 5).
 */
router.post(
  '/generate-list',
  ah(async (req, res) => {
    const { from, to } = req.body || {};
    if (!from) return res.status(400).json({ error: 'A start date (from) is required.' });
    const start = dayRange(new Date(from)).start;
    const end = dayRange(to ? new Date(to) : new Date(new Date(from).getTime() + 6 * 86400000)).end;
    const family = await getFamily(req);

    const meals = await MealPlan.find({ familyId: family._id, date: { $gte: start, $lte: end } }).lean();

    // Collect unique ingredients
    const ingredientMap = new Map(); // lowercased name -> { name, quantity }
    for (const m of meals) {
      for (const raw of m.ingredients || []) {
        // Allow "2x Milk" or "Milk x2" style quantities
        const match = raw.match(/^(\d+)\s*[xX×]\s*(.+)$/) || raw.match(/^(.+?)\s*[xX×]\s*(\d+)$/);
        let name = raw.trim();
        let qty = 1;
        if (match) {
          const [a, b] = [match[1].trim(), match[2].trim()];
          const num = Number(a);
          name = Number.isFinite(num) ? b : a;
          qty = Number.isFinite(num) ? num : Number(match[2]);
        }
        const key = name.toLowerCase();
        const existing = ingredientMap.get(key);
        if (existing) {
          existing.quantity = Math.max(existing.quantity, qty || 1);
        } else {
          ingredientMap.set(key, { name, quantity: qty || 1 });
        }
      }
    }

    // Price history: average totalPrice per item name from receipt line items
    const lineItems = await ExpenseTransaction.aggregate([
      { $match: { familyId: family._id, 'lineItems.0': { $exists: true } } },
      { $unwind: '$lineItems' },
      {
        $group: {
          _id: { $toLower: '$lineItems.name' },
          name: { $first: '$lineItems.name' },
          avg: { $avg: '$lineItems.totalPrice' },
        },
      },
    ]);
    const priceMap = new Map(lineItems.map((l) => [l._id, l.avg]));

    const items = [...ingredientMap.values()].map((ing) => ({
      name: ing.name,
      quantity: String(ing.quantity),
      avgPrice: priceMap.get(ing.name.toLowerCase()) || 0,
    }));

    const estimatedSen = items.reduce((s, i) => s + Math.round((i.avgPrice || 500) * i.quantity), 0);
    const withHistory = items.filter((i) => i.avgPrice > 0).length;

    res.json({
      meals: meals.length,
      items,
      estimatedSen,
      withHistory,
      tip: withHistory < items.length ? `${items.length - withHistory} item(s) have no price history — using a RM 5 estimate.` : undefined,
    });
  })
);

/** POST /api/meals/add-to-list — add the generated ingredients to the shopping list. */
router.post(
  '/add-to-list',
  ah(async (req, res) => {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Provide at least one ingredient.' });
    }
    const family = await getFamily(req);
    let added = 0;
    for (const it of items.slice(0, 40)) {
      const name = String(it?.name || '').trim();
      if (!name) continue;
      const exists = await GroceryChecklistItem.findOne({
        familyId: family._id,
        name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
      });
      if (exists) continue;
      await GroceryChecklistItem.create({
        familyId: family._id,
        name: name.slice(0, 120),
        quantity: String(it.quantity || '1').slice(0, 40),
        createdById: req.user._id,
      });
      added += 1;
    }
    res.status(201).json({ added });
  })
);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
