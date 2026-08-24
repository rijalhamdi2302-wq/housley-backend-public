/**
 * Housely — grocery catalog routes.
 * The family's memory of every item ever bought, with stock status.
 */

const express = require('express');
const { GroceryCatalogItem } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, requireObjectId, logActivity } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

/** GET /api/catalog — every known item (frontend groups by category). */
router.get(
  '/',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const q = { familyId: family._id };
    if (req.query.barcode) q.barcode = String(req.query.barcode).trim();
    const items = await GroceryCatalogItem.find(q).sort({
      category: 1,
      name: 1,
    });
    res.json({ items });
  })
);

/** GET /api/catalog/favorites — most-bought items as quick chips. */
router.get(
  '/favorites',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const items = await GroceryCatalogItem.find({ familyId: family._id })
      .sort({ timesBought: -1 })
      .limit(10);
    res.json({ items });
  })
);

/** POST /api/catalog — manually add an item not yet in the catalog (optionally with barcode). */
router.post(
  '/',
  ah(async (req, res) => {
    const { name, category, barcode } = req.body || {};
    const clean = String(name || '').trim();
    if (!clean) return res.status(400).json({ error: 'Item name is required.' });
    const family = await getFamily(req);
    const cleanBarcode = String(barcode || '').trim().slice(0, 32);
    const existing = await GroceryCatalogItem.findOne({
      familyId: family._id,
      name: { $regex: `^${escapeRegex(clean)}$`, $options: 'i' },
    });
    if (existing) return res.status(409).json({ error: 'That item is already in the catalog.', item: existing });
    if (cleanBarcode) {
      const byBarcode = await GroceryCatalogItem.findOne({ familyId: family._id, barcode: cleanBarcode });
      if (byBarcode) {
        return res.status(409).json({ error: `That barcode already belongs to “${byBarcode.name}”.`, item: byBarcode });
      }
    }
    const item = await GroceryCatalogItem.create({
      familyId: family._id,
      name: clean.slice(0, 120),
      category: String(category || '').trim().slice(0, 60) || 'Other',
      stockStatus: 'in_stock',
      barcode: cleanBarcode,
    });
    res.status(201).json({ item });
  })
);

/** PATCH /api/catalog/:id — update stock status / category. */
router.patch(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const item = await GroceryCatalogItem.findOne({ _id: id, familyId: family._id });
    if (!item) return res.status(404).json({ error: 'Catalog item not found.' });

    const { stockStatus, category, barcode } = req.body || {};
    if (stockStatus !== undefined) {
      if (!['in_stock', 'low', 'out'].includes(stockStatus)) {
        return res.status(400).json({ error: 'Invalid stock status.' });
      }
      item.stockStatus = stockStatus;
    }
    if (typeof category === 'string' && category.trim()) {
      item.category = category.trim().slice(0, 60);
    }
    if (barcode !== undefined) {
      const cleanBarcode = String(barcode || '').trim().slice(0, 32);
      if (cleanBarcode) {
        const byBarcode = await GroceryCatalogItem.findOne({
          familyId: family._id,
          barcode: cleanBarcode,
          _id: { $ne: item._id },
        });
        if (byBarcode) {
          return res.status(409).json({ error: `That barcode already belongs to “${byBarcode.name}”.` });
        }
      }
      item.barcode = cleanBarcode;
    }
    await item.save();
    res.json({ item });
  })
);

/** DELETE /api/catalog/:id */
router.delete(
  '/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const item = await GroceryCatalogItem.findOne({ _id: id, familyId: family._id });
    if (!item) return res.status(404).json({ error: 'Catalog item not found.' });
    await GroceryCatalogItem.deleteOne({ _id: item._id });
    res.json({ ok: true });
  })
);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
