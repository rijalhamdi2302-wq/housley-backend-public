/**
 * Housley — Express server entry.
 * Mounts every route under /api, applies security middleware and rate limits.
 */

require('dotenv').config();
require('./lib/dns-fix'); // must run before mongoose.connect (see lib/dns-fix.js)

// ── Sentry (must be initialized before any other requires) ───────────────
const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,
    profilesSampleRate: 0.5,
    environment: process.env.NODE_ENV || 'development',
    release: 'housley-backend@1.0.0',
  });
}

// ── PostHog ─────────────────────────────────────────────────────────────
const { PostHog } = require('posthog-node');
const posthog = process.env.POSTHOG_KEY
  ? new PostHog(process.env.POSTHOG_KEY, { host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com' })
  : null;

// ── Express ─────────────────────────────────────────────────────────────
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const { requestGuard, slowRequestLogger } = require('./lib/security');

const PORT = process.env.PORT || 4000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI is missing. Copy backend/.env.example to backend/.env and fill it in.');
  process.exit(1);
}
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('✗ JWT_SECRET is missing or too short (min 16 chars). Fix backend/.env.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);

// --- Security middleware ----------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: false, // Capacitor webview + Vite dev need flexibility
  })
);

// Capacitor Android uses androidScheme "https", so the webview origin is https://localhost
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://localhost:5175,http://127.0.0.1:5173,http://127.0.0.1:5175,https://localhost,capacitor://localhost,http://localhost').split(',').map((s) => s.trim());
app.use(
  cors({
    origin(origin, cb) {
      // Allow no-origin requests (native apps, curl, Capacitor) and listed origins
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: false,
  })
);

// Proof images are base64 data URLs — allow a comfortable body size
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

// Request guard: block suspicious patterns (XSS, SQLi, path traversal)
app.use(requestGuard);

// Slow request logger: warn on requests >2s
app.use(slowRequestLogger);

// Global API rate limit (generous; per-route limits are tighter where it matters).
// 480/min ≈ 8 req/s — a family of 5 never gets close; it still stops scripted
// floods. (Bumped from 240 so the full test suite fits in one window.)
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 480,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
  })
);

// Stricter rate limit for auth routes (login, register, password reset)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  limit: 20,                   // 20 attempts per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/join', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/verify-reset-code', authLimiter);
app.use('/api/auth/reset-password', authLimiter);

// ToyyibPay webhook needs raw body for signature verification
app.use('/api/pro/webhook', express.raw({ type: 'application/json' }));

// --- Routes ------------------------------------------------------------------
const routes = {
  auth: require('./routes/auth'),
  funding: require('./routes/funding'),
  expenses: require('./routes/expenses'),
  checklist: require('./routes/checklist'),
  catalog: require('./routes/catalog'),
  categories: require('./routes/categories'),
  analytics: require('./routes/analytics'),
  activity: require('./routes/activity'),
  periods: require('./routes/periods'),
  export: require('./routes/export'),
  import: require('./routes/import'),
  transactions: require('./routes/transactions'),
  bills: require('./routes/bills'),
  goals: require('./routes/goals'),
  meals: require('./routes/meals'),
  chores: require('./routes/chores'),
  social: require('./routes/social'),
  family: require('./routes/family'),
  ai: require('./routes/ai'),
  pro: require('./routes/pro'),
  features: require('./routes/features'),
  admin: require('./routes/admin'),
};
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // 200MB max
const appRoutes = require('./routes/app');

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'housley-backend' }));

// --- Public download page (serves a nice HTML page for APK download) ---
app.get('/download', async (req, res) => {
  try {
    const { AppRelease } = require('./models');
    const release = await AppRelease.findOne({ isLatest: true }).sort({ createdAt: -1 }).lean();
    const version = release ? release.version : '1.0.0';
    const releaseId = release ? release._id : '';
    const notes = release && release.releaseNotes ? release.releaseNotes : [];
    const releasedAt = release ? new Date(release.createdAt).toLocaleDateString('en-MY', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    const notesHtml = notes.length ? '<ul style="margin:12px 0;padding-left:20px;text-align:left">' + notes.map(n => '<li style="margin:6px 0;color:#555">' + n.replace(/</g,'&lt;') + '</li>').join('') + '</ul>' : '';

    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download Housley</title>
<link rel="icon" type="image/png" href="/api/app/icon">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f7fa;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#fff;border-radius:16px;padding:40px 32px;max-width:420px;width:90%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.logo{width:80px;height:80px;border-radius:20px;margin:0 auto 20px;background:#1a1a2e;display:flex;align-items:center;justify-content:center}
.logo img{width:56px;height:56px;border-radius:14px}
h1{font-size:24px;color:#1a1a2e;margin-bottom:8px}
.sub{color:#666;font-size:14px;margin-bottom:4px}
.badge{display:inline-block;background:#e8f5e9;color:#2e7d32;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin:8px 0}
.notes{text-align:left;margin:16px 0;padding:12px 16px;background:#f9fafb;border-radius:10px;font-size:13px;color:#555}
.btn{display:block;background:linear-gradient(135deg,#1a1a2e,#16213e);color:#fff;padding:16px 24px;border-radius:12px;font-size:16px;font-weight:600;text-decoration:none;margin:20px 0;transition:transform .15s,box-shadow .15s;border:none;cursor:pointer;width:100%}
.btn:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(26,26,46,.3)}
.btn:active{transform:translateY(0)}
.steps{text-align:left;margin-top:24px;font-size:13px;color:#666}
.steps h3{font-size:14px;color:#333;margin-bottom:8px}
.step{display:flex;gap:10px;margin:8px 0;align-items:flex-start}
.step-num{background:#1a1a2e;color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px}
.step p{margin:0;color:#777;line-height:1.4}
.footer{margin-top:20px;font-size:11px;color:#aaa}
</style></head><body>
<div class="card">
  <div class="logo"><img src="https://housley-backend-wlh5.onrender.com/api/app/icon" alt="Housley"></div>
  <h1>Download Housley</h1>
  <p class="sub">Version ${version.replace(/</g,'&lt;')} &bull; Android 8.0+</p>
  ${releasedAt ? '<p class="sub">Released ' + releasedAt + '</p>' : ''}
  <div class="badge">Free Family Finance App</div>
  ${notes.length ? '<div class="notes"><strong>What\'s New:</strong>' + notesHtml + '</div>' : ''}
  <a class="btn" href="/api/app/download/${releaseId}">⬇️ Download APK (${version.replace(/</g,'&lt;')})</a>
  <div class="steps">
    <h3>How to install</h3>
    <div class="step"><span class="step-num">1</span><div><p>Tap <strong>Download</strong> above. Your browser will download the file.</p></div></div>
    <div class="step"><span class="step-num">2</span><div><p>Go to <strong>Settings → Security</strong> → Enable <strong>Install Unknown Apps</strong> for your browser.</p></div></div>
    <div class="step"><span class="step-num">3</span><div><p>Tap the downloaded file → <strong>Install</strong> → Open Housley!</p></div></div>
  </div>
  <div class="footer">© 2026 Housley &bull; Built for families</div>
</div>
</body></html>`);
  } catch {
    res.status(500).send('Something went wrong. Please try again.');
  }
});

// Serve icon for the download page
app.get('/api/app/icon', (req, res) => {
  const iconPath = path.join(__dirname, '..', 'frontend', 'public', 'icon.png');
  res.sendFile(iconPath, (err) => {
    if (err) res.status(404).end();
  });
});

// App release — public (no auth)
app.use('/api/app', appRoutes);

// Admin release management (with file upload — uses admin auth, not user auth)
const { adminReleases } = require('./routes/app');
const jwt = require('jsonwebtoken');
const { AdminUser } = require('./models');
const ADMIN_JWT_SECRET = (process.env.JWT_SECRET || 'insecure') + '_admin_hq';

async function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Admin authentication required.' });
  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    if (payload.type !== 'admin') return res.status(401).json({ error: 'Invalid admin token.' });
    const admin = await AdminUser.findById(payload.sub);
    if (!admin || !admin.active) return res.status(401).json({ error: 'Admin account is inactive.' });
    req.admin = admin;
    req.user = { email: admin.email, name: admin.name };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired admin session.' });
  }
}

app.use('/api/admin/releases', requireAdminAuth, upload.single('apk'), adminReleases);

// ─── Admin Report Issues ──────────────────────────────────────
const { ReportIssue } = (() => {
  try {
    const mongoose = require('mongoose');
    const schema = new mongoose.Schema({
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family' },
      category: { type: String, enum: ['bug', 'feature', 'other'], default: 'bug' },
      message: { type: String, required: true },
      status: { type: String, enum: ['new', 'read', 'resolved'], default: 'new' },
    }, { timestamps: true });
    return { ReportIssue: mongoose.model('ReportIssue', schema) };
  } catch { return { ReportIssue: null }; }
})();

app.get('/api/admin/reports', requireAdminAuth, async (req, res) => {
  if (!ReportIssue) return res.json({ reports: [] });
  try {
    const reports = await ReportIssue.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json({ reports });
  } catch { res.json({ reports: [] }); }
});

app.patch('/api/admin/reports/:id', requireAdminAuth, async (req, res) => {
  if (!ReportIssue) return res.status(404).json({ error: 'Not found' });
  try {
    const { status } = req.body || {};
    const report = await ReportIssue.findByIdAndUpdate(req.params.id, { status }, { new: true });
    res.json({ ok: true, report });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/reports/:id', requireAdminAuth, async (req, res) => {
  if (!ReportIssue) return res.status(404).json({ error: 'Not found' });
  try {
    await ReportIssue.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Active announcements — any authenticated user can fetch
app.get('/api/announcements/active', async (req, res) => {
  try {
    const { Announcement } = require('./models');
    const announcements = await Announcement.find({ active: true }).sort({ createdAt: -1 }).limit(5).lean();
    res.json({ announcements });
  } catch {
    res.json({ announcements: [] });
  }
});

// Backup trigger — protected by secret header
app.post('/api/backup', (req, res) => {
  const secret = req.headers['x-backup-secret'];
  if (!process.env.BACKUP_SECRET || secret !== process.env.BACKUP_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { exec } = require('child_process');
  const date = new Date().toISOString().split('T')[0];

  exec(`node ${path.join(__dirname, 'scripts/backup.js')}`, { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Backup failed:', err.message);
      return res.status(500).json({ error: 'Backup failed' });
    }
    res.json({ ok: true, date, message: 'Backup completed' });
  });
});
app.use('/api/auth', routes.auth);
app.use('/api/funding', routes.funding);
app.use('/api/expenses', routes.expenses);
app.use('/api/checklist', routes.checklist);
app.use('/api/catalog', routes.catalog);
app.use('/api/categories', routes.categories);
app.use('/api/analytics', routes.analytics);
app.use('/api/activity', routes.activity);
app.use('/api/periods', routes.periods);
app.use('/api/export', routes.export);
app.use('/api/import', routes.import);
app.use('/api/transactions', routes.transactions);
app.use('/api/bills', routes.bills);
app.use('/api/goals', routes.goals);
app.use('/api/meals', routes.meals);
app.use('/api/chores', routes.chores);
app.use('/api/social', routes.social);
app.use('/api/family', routes.family);
app.use('/api/ai', routes.ai);
app.use('/api/pro', routes.pro);
app.use('/api', routes.features);
app.use('/api/admin', routes.admin);

// --- Sentry error handler (AFTER all routes) ──────────────────────────────────
if (process.env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

// --- Errors -------------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('💥', err);
  if (res.headersSent) return next(err);
  // If the developer explicitly set a status on the error, surface the real
  // message (e.g. "Payment service temporarily unavailable"). Only hide truly
  // unexpected 500s (where no status was set) behind the generic message.
  const hasExplicitStatus = Boolean(err.status || err.statusCode);
  const msg = hasExplicitStatus
    ? (err.message || 'Something went wrong on the server.')
    : 'Something went wrong on the server.';
  res.status(status).json({ error: msg });
});

// --- Boot ----------------------------------------------------------------------
async function main() {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✓ Connected to MongoDB');
  } catch (err) {
    console.error('✗ Could not connect to MongoDB. Check your connection string and network:', err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`✓ Housley backend running on http://localhost:${PORT}`);
  });
}

// ── Shutdown hooks ──────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  if (posthog) posthog.shutdown();
  process.exit(0);
});
process.on('SIGINT', () => {
  if (posthog) posthog.shutdown();
  process.exit(0);
});

main();

module.exports = app; // for tests
