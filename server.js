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
