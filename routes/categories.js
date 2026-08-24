/**
 * Housely — expense categories routes.
 * Seeds a sensible default list on first access; fully editable afterwards.
 */

const express = require('express');
const { Category, ExpenseTransaction } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, requireObjectId } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

const DEFAULTS = [
  'Groceries',
  'Meat & Fish',
  'Vegetables & Fruits',
  'Dairy & Eggs',
  'Petrol',
  'Restaurant & Eat Out',
  'Pharmacy & Health',
  'Utility Bills',
  'Transport',
  'Education',
  'Entertainment',
  'Household',
  'Personal Care',
  'Other',
];

/** GET /api/categories — seeds defaults on first call if empty. */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily(req);
    let cats = await Category.find({ familyId: family._id }).sort({ name: 1 });
    if (!cats.length) {
      await Category.insertMany(DEFAULTS.map((name) => ({ familyId: family._id, name })));
      cats = await Category.find({ familyId: family._id }).sort({ name: 1 });
    }
    res.json({ categories: cats });
  })
);

/** POST /api/categories — add a custom category. */
router.post(
  '/',
  ah(async (req, res) => {
    const { name } = req.body || {};
    const clean = String(name || '').trim();
    if (!clean) return res.status(400).json({ error: 'Category name is required.' });
    const family = await getFamily(req);
    const existing = await Category.findOne({
      familyId: family._id,
      name: { $regex: `^${escapeRegex(clean)}$`, $options: 'i' },
    });
    if (existing) return res.status(409).json({ error: 'That category already exists.' });
    const cat = await Category.create({ familyId: family._id, name: clean.slice(0, 60) });
    res.status(201).json({ category: cat });
  })
);

/** DELETE /api/categories/:id — refuses if expenses still use the category. */
router.delete(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const cat = await Category.findOne({ _id: id, familyId: family._id });
    if (!cat) return res.status(404).json({ error: 'Category not found.' });
    const used = await ExpenseTransaction.exists({ familyId: family._id, category: cat.name });
    if (used) {
      return res
        .status(409)
        .json({ error: `"${cat.name}" is used by existing expenses. Rename them first, or keep the category.` });
    }
    await Category.deleteOne({ _id: cat._id });
    res.json({ ok: true });
  })
);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
