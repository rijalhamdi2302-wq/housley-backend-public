/**
 * Housley — Admin HQ routes
 * Manages users, families, payments, and system-wide operations.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { AdminUser, Family, User, ProOrder, ExpenseTransaction, FundingTransaction, ActivityLog, SecurityQuestion, PromoCode, PromoCodeUsage } = require('../models');
const { ah, logActivity } = require('./helpers');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'insecure_dev_secret_change_me';
const ADMIN_JWT_SECRET = (process.env.ADMIN_JWT_SECRET || JWT_SECRET) + '_admin_hq';
const BCRYPT_ROUNDS = 12;

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin attempts. Please try again later.' },
});

// ─── Admin auth middleware ────────────────────────────────────────────────────

async function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Admin authentication required.' });
  try {
    const payload = jwt.verify(token, ADMIN_JWT_SECRET);
    if (payload.type !== 'admin') return res.status(401).json({ error: 'Invalid admin token.' });
    const admin = await AdminUser.findById(payload.sub);
    if (!admin || !admin.active) return res.status(401).json({ error: 'Admin account is inactive.' });
    req.admin = admin;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired admin session.' });
  }
}

function requireSuperAdmin(req, res, next) {
  if (req.admin.role !== 'superadmin') {
    return res.status(403).json({ error: 'Super admin access required.' });
  }
  next();
}

// ─── POST /api/admin/login ───────────────────────────────────────────────────

router.post('/login', adminLimiter, ah(async (req, res) => {
  const { email, password } = req.body || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(password || '');

  if (!cleanEmail || !cleanPassword) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const admin = await AdminUser.findOne({ email: cleanEmail }).select('+passwordHash');
  if (!admin) return res.status(401).json({ error: 'Invalid admin credentials.' });
  if (!admin.active) return res.status(403).json({ error: 'This admin account has been deactivated.' });

  const ok = await bcrypt.compare(cleanPassword, admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid admin credentials.' });

  admin.lastLogin = new Date();
  await admin.save();

  const token = jwt.sign(
    { sub: admin._id.toString(), type: 'admin', role: admin.role },
    ADMIN_JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({
    token,
    admin: { _id: admin._id, name: admin.name, email: admin.email, role: admin.role },
  });
}));

// ─── GET /api/admin/me — verify token ────────────────────────────────────────

router.get('/me', requireAdmin, ah(async (req, res) => {
  res.json({ admin: { _id: req.admin._id, name: req.admin.name, email: req.admin.email, role: req.admin.role } });
}));

// ─── GET /api/admin/dashboard — overview stats ───────────────────────────────

router.get('/dashboard', requireAdmin, ah(async (req, res) => {
  const [
    totalFamilies,
    totalUsers,
    proFamilies,
    totalOrders,
    recentOrders,
    families,
    recentUsers,
    totalExpenses,
    totalFunding,
    activeOrders,
  ] = await Promise.all([
    Family.countDocuments(),
    User.countDocuments(),
    Family.countDocuments({ proTier: { $ne: 'none' } }),
    ProOrder.countDocuments(),
    ProOrder.find({ status: 'paid' }).sort({ paidAt: -1 }).limit(10).lean(),
    Family.find().sort({ createdAt: -1 }).limit(10).lean(),
    User.find().sort({ createdAt: -1 }).limit(10).populate('familyId', 'name').lean(),
    ExpenseTransaction.countDocuments(),
    FundingTransaction.countDocuments(),
    ProOrder.countDocuments({ status: 'pending' }),
  ]);

  // Revenue from paid orders
  const revenueAgg = await ProOrder.aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: null, totalSen: { $sum: '$amountSen' }, count: { $sum: 1 } } },
  ]);
  const revenue = revenueAgg.length > 0 ? revenueAgg[0] : { totalSen: 0, count: 0 };

  // Pro tier breakdown
  const tierBreakdown = await Family.aggregate([
    { $group: { _id: '$proTier', count: { $sum: 1 } } },
  ]);

  // Daily new families (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const dailyFamilies = await Family.aggregate([
    { $match: { createdAt: { $gte: thirtyDaysAgo } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  // Daily new users (last 30 days)
  const dailyUsers = await User.aggregate([
    { $match: { createdAt: { $gte: thirtyDaysAgo } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  res.json({
    totalFamilies,
    totalUsers,
    proFamilies,
    freeFamilies: totalFamilies - proFamilies,
    totalOrders,
    activeOrders,
    totalExpenses,
    totalFunding,
    revenue: {
      totalSen: revenue.totalSen,
      totalRM: (revenue.totalSen / 100).toFixed(2),
      orderCount: revenue.count,
    },
    tierBreakdown: tierBreakdown.reduce((acc, t) => { acc[t._id] = t.count; return acc; }, {}),
    recentOrders,
    recentFamilies: families,
    recentUsers,
    dailyFamilies,
    dailyUsers,
  });
}));

// ─── USERS MANAGEMENT ────────────────────────────────────────────────────────

// GET /api/admin/users — list all users with search & pagination
router.get('/users', requireAdmin, ah(async (req, res) => {
  const { search, familyId, role, page = 1, limit = 50 } = req.query;
  const query = {};

  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ name: re }, { email: re }];
  }
  if (familyId) query.familyId = familyId;
  if (role) query.role = role;

  const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
  const [users, total] = await Promise.all([
    User.find(query).populate('familyId', 'name proTier').sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    User.countDocuments(query),
  ]);

  res.json({
    users: users.map(u => ({
      _id: u._id,
      name: u.name,
      email: u.email,
      role: u.role,
      familyId: u.familyId?._id,
      familyName: u.familyId?.name || 'Deleted',
      proTier: u.familyId?.proTier || 'none',
      hasPin: Boolean(u.pinHash),
      biometricEnabled: u.biometricEnabled,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
    })),
    total,
    page: parseInt(page),
    totalPages: Math.ceil(total / parseInt(limit)),
  });
}));

// GET /api/admin/users/:id — single user detail
router.get('/users/:id', requireAdmin, ah(async (req, res) => {
  const user = await User.findById(req.params.id).populate('familyId', 'name proTier proExpiresAt').select('+pinHash +passwordHash').lean();
  if (!user) return res.status(404).json({ error: 'User not found.' });

  // Count their transactions
  const [expenseCount, fundingCount, activityCount] = await Promise.all([
    ExpenseTransaction.countDocuments({ $or: [{ userId: user._id }, { spentById: user._id }] }),
    FundingTransaction.countDocuments({ $or: [{ userId: user._id }, { fundedById: user._id }] }),
    ActivityLog.countDocuments({ $or: [{ actorId: user._id }, { subjectUserId: user._id }] }),
  ]);

  res.json({
    user: {
      ...user,
      passwordHash: undefined,
      pinHash: user.pinHash ? '(set)' : null,
      familyName: user.familyId?.name || 'Deleted',
      proTier: user.familyId?.proTier || 'none',
      proExpiresAt: user.familyId?.proExpiresAt,
    },
    stats: { expenseCount, fundingCount, activityCount },
  });
}));

// PATCH /api/admin/users/:id — edit user (name, role, email)
router.patch('/users/:id', requireAdmin, ah(async (req, res) => {
  const { name, role, email } = req.body || {};
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  if (name) user.name = String(name).trim().slice(0, 60);
  if (role && ['provider', 'grocery_spender', 'member', 'dependent'].includes(role)) user.role = role;
  if (email) {
    const cleanEmail = String(email).trim().toLowerCase();
    const existing = await User.findOne({ email: cleanEmail, _id: { $ne: user._id } });
    if (existing) return res.status(409).json({ error: 'Email already in use.' });
    user.email = cleanEmail;
  }

  await user.save();
  res.json({ user: user.toSafeJSON() });
}));

// DELETE /api/admin/users/:id — delete a user
router.delete('/users/:id', requireAdmin, requireSuperAdmin, ah(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  await User.deleteOne({ _id: user._id });
  await SecurityQuestion.deleteOne({ userId: user._id });
  // Clear their transactions' references
  await ExpenseTransaction.updateMany({ spentById: user._id }, { $set: { spentById: null } });
  await FundingTransaction.updateMany({ fundedById: user._id }, { $set: { fundedById: null } });

  res.json({ ok: true, message: `User ${user.name} deleted.` });
}));

// ─── FAMILIES MANAGEMENT ─────────────────────────────────────────────────────

// GET /api/admin/families — list all families
router.get('/families', requireAdmin, ah(async (req, res) => {
  const { search, proTier, page = 1, limit = 50 } = req.query;
  const query = {};

  if (search) {
    const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.name = re;
  }
  if (proTier && proTier !== 'all') query.proTier = proTier;

  const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
  const [families, total] = await Promise.all([
    Family.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    Family.countDocuments(query),
  ]);

  // Enrich with member count and revenue
  const enriched = await Promise.all(families.map(async (f) => {
    const memberCount = await User.countDocuments({ familyId: f._id });
    const orderCount = await ProOrder.countDocuments({ familyId: f._id, status: 'paid' });
    const totalSpent = await ProOrder.aggregate([
      { $match: { familyId: f._id, status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amountSen' } } },
    ]);
    return {
      ...f,
      memberCount,
      orderCount,
      totalSpentRM: totalSpent.length > 0 ? (totalSpent[0].total / 100).toFixed(2) : '0.00',
    };
  }));

  res.json({ families: enriched, total, page: parseInt(page), totalPages: Math.ceil(total / parseInt(limit)) });
}));

// GET /api/admin/families/:id — single family detail
router.get('/families/:id', requireAdmin, ah(async (req, res) => {
  const family = await Family.findById(req.params.id).lean();
  if (!family) return res.status(404).json({ error: 'Family not found.' });

  const members = await User.find({ familyId: family._id }).sort({ sortOrder: 1 }).lean();
  const orders = await ProOrder.find({ familyId: family._id }).sort({ createdAt: -1 }).limit(20).lean();
  const recentActivity = await ActivityLog.find({ familyId: family._id }).sort({ createdAt: -1 }).limit(30).lean();

  const totalSpent = await ProOrder.aggregate([
    { $match: { familyId: family._id, status: 'paid' } },
    { $group: { _id: null, total: { $sum: '$amountSen' } } },
  ]);

  const expenseCount = await ExpenseTransaction.countDocuments({ familyId: family._id });
  const fundingCount = await FundingTransaction.countDocuments({ familyId: family._id });

  res.json({
    family,
    members: members.map(m => ({ ...m, pinHash: undefined, passwordHash: undefined })),
    orders,
    recentActivity,
    revenue: totalSpent.length > 0 ? (totalSpent[0].total / 100).toFixed(2) : '0.00',
    stats: { expenseCount, fundingCount, memberCount: members.length },
  });
}));

// PATCH /api/admin/families/:id — edit family (name, proTier, proExpiresAt)
router.patch('/families/:id', requireAdmin, ah(async (req, res) => {
  const { name, proTier, proExpiresAt, aiEnabled } = req.body || {};
  const family = await Family.findById(req.params.id);
  if (!family) return res.status(404).json({ error: 'Family not found.' });

  if (name) family.name = String(name).trim().slice(0, 60);
  if (proTier && ['none', 'monthly', 'yearly', 'lifetime'].includes(proTier)) family.proTier = proTier;
  if (proExpiresAt !== undefined) family.proExpiresAt = proExpiresAt ? new Date(proExpiresAt) : null;
  if (aiEnabled !== undefined) family.aiEnabled = Boolean(aiEnabled);

  await family.save();
  res.json({ family });
}));

// DELETE /api/admin/families/:id — delete entire family (superadmin only)
router.delete('/families/:id', requireAdmin, requireSuperAdmin, ah(async (req, res) => {
  const family = await Family.findById(req.params.id);
  if (!family) return res.status(404).json({ error: 'Family not found.' });

  const familyId = family._id;
  const M = require('../models');

  // Delete all related data
  await Promise.all([
    User.deleteMany({ familyId }),
    SecurityQuestion.deleteMany({ userId: { $in: (await User.find({ familyId }).select('_id')).map(u => u._id) } }),
    M.ExpenseTransaction.deleteMany({ familyId }),
    M.FundingTransaction.deleteMany({ familyId }),
    M.Shop.deleteMany({ familyId }),
    M.ActivityLog.deleteMany({ familyId }),
    M.GroceryChecklistItem.deleteMany({ familyId }),
    M.GroceryCatalogItem.deleteMany({ familyId }),
    M.Category.deleteMany({ familyId }),
    M.CategoryBudget.deleteMany({ familyId }),
    M.TrackingPeriod.deleteMany({ familyId }),
    M.GroceryBalance.deleteMany({ familyId }),
    M.PersonalBalance.deleteMany({ familyId }),
    M.RecurringBill.deleteMany({ familyId }),
    M.SavingsGoal.deleteMany({ familyId }),
    M.Shoutout.deleteMany({ familyId }),
    M.PinNote.deleteMany({ familyId }),
    M.Chore.deleteMany({ familyId }),
    M.MealPlan.deleteMany({ familyId }),
    M.ProOrder.deleteMany({ familyId }),
    M.Investment.deleteMany({ familyId }),
    M.Debt.deleteMany({ familyId }),
    M.Subscription.deleteMany({ familyId }),
    M.CalendarEvent.deleteMany({ familyId }),
    M.ChatMessage.deleteMany({ familyId }),
    M.SpendingChallenge.deleteMany({ familyId }),
    M.EducationLesson.deleteMany({ familyId }),
    M.BackupLog.deleteMany({ familyId }),
    M.NotificationPref.deleteMany({ userId: { $in: (await User.find({ familyId }).select('_id')).map(u => u._id) } }),
    M.PromoCodeUsage.deleteMany({ familyId }),
    Family.deleteOne({ _id: familyId }),
  ]);

  res.json({ ok: true, message: `Family "${family.name}" and all its data deleted.` });
}));

// ─── PAYMENTS / PRO ORDERS ───────────────────────────────────────────────────

// GET /api/admin/orders — list all pro orders
router.get('/orders', requireAdmin, ah(async (req, res) => {
  const { status, plan, page = 1, limit = 50 } = req.query;
  const query = {};
  if (status) query.status = status;
  if (plan) query.plan = plan;

  const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
  const [orders, total] = await Promise.all([
    ProOrder.find(query)
      .populate('familyId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),
    ProOrder.countDocuments(query),
  ]);

  const revenueAgg = await ProOrder.aggregate([
    { $match: { status: 'paid', ...query } },
    { $group: { _id: null, total: { $sum: '$amountSen' } } },
  ]);

  res.json({
    orders: orders.map(o => ({
      ...o,
      familyName: o.familyId?.name || 'Deleted',
      amountRM: (o.amountSen / 100).toFixed(2),
    })),
    total,
    page: parseInt(page),
    totalPages: Math.ceil(total / parseInt(limit)),
    totalRevenueRM: revenueAgg.length > 0 ? (revenueAgg[0].total / 100).toFixed(2) : '0.00',
  });
}));

// GET /api/admin/orders/:id — single order detail
router.get('/orders/:id', requireAdmin, ah(async (req, res) => {
  const order = await ProOrder.findById(req.params.id).populate('familyId', 'name proTier proExpiresAt').lean();
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order: { ...order, amountRM: (order.amountSen / 100).toFixed(2) } });
}));

// ─── ACTIVITY LOG ────────────────────────────────────────────────────────────

router.get('/activity', requireAdmin, ah(async (req, res) => {
  const { familyId, type, page = 1, limit = 50 } = req.query;
  const query = {};
  if (familyId) query.familyId = familyId;
  if (type) query.type = type;

  const skip = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
  const [logs, total] = await Promise.all([
    ActivityLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
    ActivityLog.countDocuments(query),
  ]);

  res.json({
    logs,
    total,
    page: parseInt(page),
    totalPages: Math.ceil(total / parseInt(limit)),
  });
}));

// ─── PROMO CODES ─────────────────────────────────────────────────────────────

// GET /api/admin/promos — list all promo codes (admin management)
router.get('/promos', requireAdmin, ah(async (req, res) => {
  const promos = await PromoCode.find().sort({ createdAt: -1 }).lean();
  res.json({ promos });
}));

// GET /api/admin/promos/usage — list promo code usage history
router.get('/promos/usage', requireAdmin, ah(async (req, res) => {
  const usage = await PromoCodeUsage.find().populate('familyId', 'name').sort({ usedAt: -1 }).lean();
  res.json({ usage: usage.map(p => ({ ...p, familyName: p.familyId?.name || 'Deleted' })) });
}));

// POST /api/admin/promos — create a new promo code
router.post('/promos', requireAdmin, ah(async (req, res) => {
  const { code, description, discountType, discountValue, expiresAt, targetEmails, maxUses } = req.body || {};
  if (!code || !discountValue) return res.status(400).json({ error: 'Code and discount value are required.' });
  const upperCode = String(code).trim().toUpperCase();
  if (upperCode.length < 2 || upperCode.length > 20) return res.status(400).json({ error: 'Code must be 2-20 characters.' });
  if (!['percent', 'fixed'].includes(discountType)) return res.status(400).json({ error: 'discountType must be percent or fixed.' });
  if (discountType === 'percent' && (discountValue < 1 || discountValue > 100)) return res.status(400).json({ error: 'Percent discount must be 1-100.' });
  const existing = await PromoCode.findOne({ code: upperCode });
  if (existing) return res.status(409).json({ error: 'A promo code with this name already exists.' });
  const promo = await PromoCode.create({
    code: upperCode,
    description: String(description || '').trim(),
    discountType: discountType || 'percent',
    discountValue: Number(discountValue),
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    targetEmails: Array.isArray(targetEmails) ? targetEmails.map(e => String(e).trim().toLowerCase()).filter(Boolean) : [],
    maxUses: Number(maxUses) || 0,
  });
  res.status(201).json({ promo });
}));

// PATCH /api/admin/promos/:id — update a promo code
router.patch('/promos/:id', requireAdmin, ah(async (req, res) => {
  const promo = await PromoCode.findById(req.params.id);
  if (!promo) return res.status(404).json({ error: 'Promo code not found.' });
  const { code, description, discountType, discountValue, expiresAt, targetEmails, maxUses, active } = req.body || {};
  if (code) {
    const upperCode = String(code).trim().toUpperCase();
    if (upperCode.length < 2 || upperCode.length > 20) return res.status(400).json({ error: 'Code must be 2-20 characters.' });
    const existing = await PromoCode.findOne({ code: upperCode, _id: { $ne: promo._id } });
    if (existing) return res.status(409).json({ error: 'A promo code with this name already exists.' });
    promo.code = upperCode;
  }
  if (description !== undefined) promo.description = String(description).trim();
  if (discountType) promo.discountType = discountType;
  if (discountValue !== undefined) promo.discountValue = Number(discountValue);
  if (expiresAt !== undefined) promo.expiresAt = expiresAt ? new Date(expiresAt) : null;
  if (targetEmails !== undefined) promo.targetEmails = Array.isArray(targetEmails) ? targetEmails.map(e => String(e).trim().toLowerCase()).filter(Boolean) : [];
  if (maxUses !== undefined) promo.maxUses = Number(maxUses);
  if (active !== undefined) promo.active = Boolean(active);
  await promo.save();
  res.json({ promo });
}));

// DELETE /api/admin/promos/:id — delete a promo code
router.delete('/promos/:id', requireAdmin, ah(async (req, res) => {
  const promo = await PromoCode.findByIdAndDelete(req.params.id);
  if (!promo) return res.status(404).json({ error: 'Promo code not found.' });
  res.json({ ok: true, message: `Promo code "${promo.code}" deleted.` });
}));

// ─── USER PASSWORD RESET (admin) ─────────────────────────────────────────────

// PATCH /api/admin/users/:id/password — admin change a user's password
router.patch('/users/:id/password', requireAdmin, ah(async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const user = await User.findById(req.params.id).select('+passwordHash');
  if (!user) return res.status(404).json({ error: 'User not found.' });
  user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await user.save();
  res.json({ ok: true, message: `Password updated for "${user.name}".` });
}));

// ─── SYSTEM ──────────────────────────────────────────────────────────────────

// GET /api/admin/system — system health check
router.get('/system', requireAdmin, ah(async (req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  const collections = mongoose.connection.db ? Object.keys(await mongoose.connection.db.listCollections().toArray()) : [];
  res.json({
    status: dbState === 1 ? 'healthy' : 'disconnected',
    mongodb: dbState === 1 ? 'connected' : 'disconnected',
    collections,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
}));

// POST /api/admin/create-admin — create a new admin (superadmin only)
router.post('/create-admin', requireAdmin, requireSuperAdmin, ah(async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email, password, and name are required.' });
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });

  const cleanEmail = String(email).trim().toLowerCase();
  const existing = await AdminUser.findOne({ email: cleanEmail });
  if (existing) return res.status(409).json({ error: 'An admin with this email already exists.' });

  const admin = await AdminUser.create({
    email: cleanEmail,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    name: String(name).trim(),
    role: ['superadmin', 'admin', 'viewer'].includes(role) ? role : 'admin',
  });

  res.status(201).json({ admin: { _id: admin._id, name: admin.name, email: admin.email, role: admin.role } });
}));

// ─── RESET DATA ──────────────────────────────────────────────────────────────

// POST /api/admin/factory-reset/:familyId — force reset a family
router.post('/factory-reset/:familyId', requireAdmin, requireSuperAdmin, ah(async (req, res) => {
  const family = await Family.findById(req.params.familyId);
  if (!family) return res.status(404).json({ error: 'Family not found.' });

  const models = require('../models');
  const wipe = [
    models.FundingTransaction, models.ExpenseTransaction, models.Shop, models.ActivityLog,
    models.GroceryChecklistItem, models.GroceryCatalogItem, models.CategoryBudget,
    models.RecurringBill, models.SavingsGoal, models.Shoutout, models.PinNote,
    models.Chore, models.MealPlan, models.TrackingPeriod, models.GroceryBalance,
    models.PersonalBalance, models.Investment, models.Debt, models.Subscription,
    models.CalendarEvent, models.ChatMessage, models.SpendingChallenge, models.EducationLesson,
    models.BackupLog, models.Category, models.ProOrder, models.PromoCodeUsage,
  ];
  for (const M of wipe) await M.deleteMany({ familyId: family._id });

  await User.updateMany({ familyId: family._id }, {
    $set: { pinHash: null, refreshTokenHash: null, biometricEnabled: false, avatarPhoto: null, failedAttempts: 0, lockedUntil: null },
  });

  family.proTier = 'none';
  family.proExpiresAt = null;
  family.proPurchasedAt = null;
  family.trialEndsAt = null;
  await family.save();

  res.json({ ok: true, message: `Family "${family.name}" has been factory-reset.` });
}));

// ─── Announcement CRUD ─────────────────────────────────────────────────────

router.get('/announcements', ah(async (req, res) => {
  const { Announcement } = require('../models');
  const list = await Announcement.find().sort({ createdAt: -1 }).lean();
  res.json({ announcements: list });
}));

router.post('/announcements', ah(async (req, res) => {
  const { Announcement } = require('../models');
  const { title, message, type, linkUrl } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required.' });
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required.' });
  const ann = await Announcement.create({
    title: title.trim(),
    message: message.trim(),
    type: type || 'info',
    linkUrl: linkUrl || null,
  });
  res.json({ announcement: ann });
}));

router.delete('/announcements/:id', ah(async (req, res) => {
  const { Announcement } = require('../models');
  await Announcement.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
}));

// ─── Change user password ────────────────────────────────────────────────────

router.patch('/users/:id/password', ah(async (req, res) => {
  const { User } = require('../models');
  const bcrypt = require('bcryptjs');
  const { password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  const user = await User.findById(req.params.id).select('+passwordHash');
  if (!user) return res.status(404).json({ error: 'User not found.' });
  user.passwordHash = await bcrypt.hash(password, 12);
  await user.save();
  res.json({ ok: true, message: 'Password updated.' });
}));

module.exports = router;
