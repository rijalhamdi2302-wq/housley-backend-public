/**
 * Housely — social routes (features #21 + #22).
 *  - /api/shoutouts — the family "thank you" feed with react buttons (💛 👍 🎉)
 *  - /api/notes     — the shared pin board / family noticeboard
 */

const express = require('express');
const { Shoutout, PinNote, User } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily, requireObjectId, logActivity } = require('./helpers');

const router = express.Router();
router.use(requireAuth);

const REACT_EMOJIS = ['💛', '👍', '🎉', '🔥', '😂'];

// ---------------------------------------------------------------------------
// Shout-outs
// ---------------------------------------------------------------------------
/** GET /api/shoutouts — latest shout-outs with react counts. */
router.get(
  '/shoutouts',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const shoutouts = await Shoutout.find({ familyId: family._id }).sort({ createdAt: -1 }).limit(limit);
    res.json({ shoutouts });
  })
);

/** POST /api/shoutouts — thank someone / the family. */
router.post(
  '/shoutouts',
  ah(async (req, res) => {
    const { text, emoji } = req.body || {};
    const clean = String(text || '').trim();
    if (!clean) return res.status(400).json({ error: 'Say something nice first! 💛' });
    const family = await getFamily(req);
    const shoutout = await Shoutout.create({
      familyId: family._id,
      authorId: req.user._id,
      authorName: req.user.name,
      text: clean.slice(0, 300),
      emoji: String(emoji || '💛').slice(0, 8),
    });
    await logActivity({
      familyId: family._id,
      actor: req.user,
      type: 'shoutout',
      message: `${req.user.name} sent a shout-out: “${clean.slice(0, 80)}”`,
      meta: { shoutout: clean.slice(0, 120) },
    });
    res.status(201).json({ shoutout });
  })
);

/** POST /api/shoutouts/:id/react — toggle a react emoji for the current user. */
router.post(
  '/shoutouts/:id/react',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const { emoji } = req.body || {};
    if (!REACT_EMOJIS.includes(emoji)) {
      return res.status(400).json({ error: 'Unknown react. Choose from 💛 👍 🎉 🔥 😂' });
    }
    const family = await getFamily(req);
    const shoutout = await Shoutout.findOne({ _id: id, familyId: family._id });
    if (!shoutout) return res.status(404).json({ error: 'Shout-out not found.' });

    const react = shoutout.reacts.find((r) => r.emoji === emoji);
    if (react) {
      const idx = react.userIds.findIndex((u) => String(u) === String(req.user._id));
      if (idx >= 0) react.userIds.splice(idx, 1);
      else react.userIds.push(req.user._id);
      if (react.userIds.length === 0) {
        shoutout.reacts = shoutout.reacts.filter((r) => r !== react);
      }
    } else {
      shoutout.reacts.push({ emoji, userIds: [req.user._id] });
    }
    await shoutout.save();
    res.json({ shoutout });
  })
);

/** DELETE /api/shoutouts/:id — author or provider. */
router.delete(
  '/shoutouts/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const shoutout = await Shoutout.findOne({ _id: id, familyId: family._id });
    if (!shoutout) return res.status(404).json({ error: 'Shout-out not found.' });
    if (String(shoutout.authorId) !== String(req.user._id) && req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the author or the provider can remove a shout-out.' });
    }
    await Shoutout.deleteOne({ _id: shoutout._id });
    res.json({ ok: true });
  })
);

// ---------------------------------------------------------------------------
// Pin board / family notes
// ---------------------------------------------------------------------------
/** GET /api/notes — newest first. */
router.get(
  '/notes',
  ah(async (req, res) => {
    const family = await getFamily(req);
    const notes = await PinNote.find({ familyId: family._id }).sort({ createdAt: -1 }).limit(60);
    res.json({ notes });
  })
);

/** POST /api/notes — pin a family note. */
router.post(
  '/notes',
  ah(async (req, res) => {
    const { text, color } = req.body || {};
    const clean = String(text || '').trim();
    if (!clean) return res.status(400).json({ error: 'Note text is required.' });
    const family = await getFamily(req);
    const note = await PinNote.create({
      familyId: family._id,
      authorId: req.user._id,
      authorName: req.user.name,
      text: clean.slice(0, 300),
      color: String(color || '#ffe3e9').slice(0, 9),
    });
    res.status(201).json({ note });
  })
);

/** DELETE /api/notes/:id — author or provider. */
router.delete(
  '/notes/:id',
  ah(async (req, res) => {
    const id = requireObjectId(req.params.id);
    const family = await getFamily(req);
    const note = await PinNote.findOne({ _id: id, familyId: family._id });
    if (!note) return res.status(404).json({ error: 'Note not found.' });
    if (String(note.authorId) !== String(req.user._id) && req.user.role !== 'provider') {
      return res.status(403).json({ error: 'Only the author or the provider can remove a note.' });
    }
    await PinNote.deleteOne({ _id: note._id });
    res.json({ ok: true });
  })
);

module.exports = router;
