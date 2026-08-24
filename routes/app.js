/**
 * Housley — App release routes.
 *   GET  /api/app/latest          — public: latest release info (for website + app)
 *   GET  /api/app/version         — public: alias for /latest
 *   GET  /api/admin/releases      — admin: list all releases
 *   POST /api/admin/releases      — admin: publish a new release (multipart upload)
 *   DELETE /api/admin/releases/:id — admin: delete a non-latest release
 */

const express = require('express');
const { AppRelease, Announcement } = require('../models');
const { requireAuth } = require('../middleware/auth');
const r2 = require('../lib/r2');

const router = express.Router();

// --- Public: latest release ---
router.get('/latest', async (req, res) => {
  try {
    const release = await AppRelease.findOne({ isLatest: true }).sort({ createdAt: -1 }).lean();
    if (!release) return res.json({ version: '1.0.0', versionCode: 1, apkUrl: null, releaseNotes: [], isMandatory: false });
    // Build a proxy download URL so users don't need R2 public access
    const downloadUrl = release._id
      ? `${req.protocol}://${req.get('host')}/api/app/download/${release._id}`
      : release.apkUrl;
    res.json({
      version: release.version,
      versionCode: release.versionCode,
      apkUrl: downloadUrl,
      releaseNotes: release.releaseNotes,
      isMandatory: release.isMandatory,
      releasedAt: release.createdAt,
      releaseId: release._id,
    });
  } catch (err) {
    res.json({ version: '1.0.0', versionCode: 1, apkUrl: null, releaseNotes: [], isMandatory: false });
  }
});

// Alias
router.get('/version', (req, res) => {
  req.url = '/latest';
  router.handle(req, res);
});

// --- Public: proxy download APK (stream from R2) ---
router.get('/download/:releaseId', async (req, res) => {
  try {
    const release = await AppRelease.findById(req.params.releaseId).lean();
    if (!release || !release.apkKey) {
      return res.status(404).json({ error: 'Release not found.' });
    }
    if (!r2.configured()) {
      return res.status(503).json({ error: 'Download storage not configured.' });
    }
    const { stream, contentType, contentLength } = await r2.streamFile(release.apkKey);
    const fileName = `Housley-v${release.version}.apk`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    stream.pipe(res);
  } catch (err) {
    console.error('Download proxy error:', err);
    res.status(500).json({ error: 'Download failed.' });
  }
});

module.exports = router;

// --- Admin routes (mounted separately at /api/admin/releases) ---
const adminRouter = express.Router();
// Auth handled by requireAdminAuth in server.js — no need for requireAuth here

// List all releases
adminRouter.get('/', async (req, res) => {
  const releases = await AppRelease.find().sort({ createdAt: -1 }).lean();
  res.json({ releases });
});

// Publish new release (with APK upload)
adminRouter.post('/', async (req, res) => {
  try {
    // Parse multipart form data
    const { version, versionCode, releaseNotes, isMandatory } = req.body || {};

    if (!version || !versionCode) {
      return res.status(400).json({ error: 'Version and version code are required.' });
    }

    const vCode = parseInt(versionCode, 10);
    if (!Number.isFinite(vCode) || vCode < 1) {
      return res.status(400).json({ error: 'Version code must be a positive number.' });
    }

    // Check versionCode is higher than current
    const latest = await AppRelease.findOne({ isLatest: true }).sort({ versionCode: -1 }).lean();
    if (latest && vCode <= latest.versionCode) {
      return res.status(400).json({ error: `Version code must be higher than current (${latest.versionCode}).` });
    }

    // APK file should be in req.file (multer) or req.body.apkUrl
    let apkUrl = null;
    let apkKey = null;
    let apkSize = 0;

    if (req.file) {
      // Upload to R2
      if (!r2.configured()) {
        return res.status(503).json({ error: 'Cloudflare R2 is not configured. APK cannot be uploaded.' });
      }
      const key = r2.apkKey(version);
      apkUrl = await r2.uploadFile({ key, body: req.file.buffer, contentType: req.file.mimetype || 'application/vnd.android.package-archive' });
      apkKey = key;
      apkSize = req.file.size;
    } else if (req.body.apkUrl) {
      // Direct URL (for testing or pre-hosted APKs)
      apkUrl = req.body.apkUrl;
    } else {
      return res.status(400).json({ error: 'APK file is required.' });
    }

    // Unmark old latest
    if (latest) {
      await AppRelease.updateOne({ _id: latest._id }, { isLatest: false });
    }

    // Parse release notes
    let notes = [];
    if (releaseNotes) {
      try { notes = JSON.parse(releaseNotes); } catch { notes = String(releaseNotes).split('\n').filter(Boolean); }
    }

    // Create release
    const release = await AppRelease.create({
      version,
      versionCode: vCode,
      apkUrl,
      apkKey,
      apkSize,
      releaseNotes: notes,
      isMandatory: Boolean(isMandatory),
      isLatest: true,
      publishedBy: req.user?.email || 'admin',
    });

    // Auto-create announcement
    const notesList = notes.length ? '\n' + notes.map(n => `- ${n}`).join('\n') : '';
    try {
      await Announcement.create({
        title: `Housley ${version} is available!`,
        message: `A new version of Housley is now available.${notesList}`,
        type: 'update',
        linkUrl: apkUrl || null,
        active: true,
      });
    } catch (annErr) {
      console.error('Failed to create auto-announcement:', annErr.message);
    }

    res.json({ release: release.toObject() });
  } catch (err) {
    console.error('Release publish error:', err);
    res.status(500).json({ error: err.message || 'Failed to publish release.' });
  }
});

// Delete a non-latest release
adminRouter.delete('/:id', async (req, res) => {
  const release = await AppRelease.findById(req.params.id);
  if (!release) return res.status(404).json({ error: 'Release not found.' });
  if (release.isLatest) return res.status(400).json({ error: 'Cannot delete the current latest release.' });

  // Delete from R2
  if (release.apkKey && r2.configured()) {
    await r2.deleteFile(release.apkKey).catch(() => {});
  }
  await release.deleteOne();
  res.json({ ok: true });
});

module.exports.adminReleases = adminRouter;
