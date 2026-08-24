/**
 * Housely — grocery checklist routes.
 * The GET response also carries a "suggested" section: catalog items that are
 * currently low or out of stock, so the family never forgets to restock.
 */

const express = require('express');
const { GroceryChecklistItem, GroceryCatalogItem, Shop } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, requireObjectId, logActivity } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

/** GET /api/checklist — manual items + suggested-from-catalog section. */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const items = await GroceryChecklistItem.find({ familyId: family._id }).sort({ createdAt: -1 });
    const suggested = await GroceryCatalogItem.find({
      familyId: family._id,
      stockStatus: { $in: ['low', 'out'] },
    }).sort({ timesBought: -1 });
    res.json({ items, suggested });
  })
);

/** POST /api/checklist — add an item. */
router.post(
  '/',
  ah(async (req, res) => {
    const { name, quantity, shopId } = req.body || {};
    const clean = String(name || '').trim();
    if (!clean) return res.status(400).json({ error: 'Item name is required.' });
    const family = await getFamily(req);
    const item = await GroceryChecklistItem.create({
      familyId: family._id,
      name: clean.slice(0, 120),
      quantity: String(quantity || '').trim().slice(0, 40) || '1',
      shopId: shopId ? requireObjectId(shopId, 'shopId') : null,
      createdById: req.user._id,
    });
    res.status(201).json({ item });
  })
);

/** PATCH /api/checklist/:id — toggle checked / edit fields. */
router.patch(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const item = await GroceryChecklistItem.findOne({ _id: id, familyId: family._id });
    if (!item) return res.status(404).json({ error: 'Checklist item not found.' });

    const { checked, name, quantity, shopId } = req.body || {};
    if (typeof checked === 'boolean') item.checked = checked;
    if (typeof name === 'string' && name.trim()) item.name = name.trim().slice(0, 120);
    if (typeof quantity === 'string') item.quantity = quantity.trim().slice(0, 40) || '1';
    if (shopId !== undefined) item.shopId = shopId ? requireObjectId(shopId, 'shopId') : null;
    await item.save();
    res.json({ item });
  })
);

/** POST /api/checklist/:id/bought — "bought it" from the suggested section:
 *  removes the checklist item and resets the linked catalog status. */
router.post(
  '/:id/bought',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const item = await GroceryChecklistItem.findOne({ _id: id, familyId: family._id });
    if (!item) return res.status(404).json({ error: 'Checklist item not found.' });

    await GroceryChecklistItem.deleteOne({ _id: item._id });
    const catalog = await GroceryCatalogItem.findOne({
      familyId: family._id,
      name: { $regex: `^${escapeRegex(item.name)}$`, $options: 'i' },
    });
    if (catalog) {
      catalog.stockStatus = 'in_stock';
      catalog.timesBought += 1;
      catalog.lastBoughtAt = new Date();
      await catalog.save();
    }
    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'checklist_bought',
      message: `${req.user.name} bought "${item.name}" from the checklist.`,
      meta: { item: item.name },
    });
    res.json({ ok: true });
  })
);

/** DELETE /api/checklist/:id */
router.delete(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const item = await GroceryChecklistItem.findOne({ _id: id, familyId: family._id });
    if (!item) return res.status(404).json({ error: 'Checklist item not found.' });
    await GroceryChecklistItem.deleteOne({ _id: item._id });
    res.json({ ok: true });
  })
);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
