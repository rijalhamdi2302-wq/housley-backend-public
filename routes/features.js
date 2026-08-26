/**
 * Housley (public) — Additional feature routes.
 *   Investments, Debts, Subscriptions, Calendar, Chat, Challenges,
 *   Education, Backup, Notifications, Voice, and extra analytics.
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily } = require('./helpers');
const {
  Family, User, ExpenseTransaction, GroceryBalance, PersonalBalance,
  TrackingPeriod, Investment, Debt, Subscription, CalendarEvent,
  ChatMessage, SpendingChallenge, EducationLesson, BackupLog,
  NotificationPref, RecurringBill, Shop, CategoryBudget, SavingsGoal,
} = require('../models');

// ── Investments ──────────────────────────────────────────────────────────────
router.get('/investments', requireAuth, ah(async (req, res) => {
  const items = await Investment.find({ familyId: req.user.familyId }).sort({ createdAt: -1 });
  res.json({ items });
}));

router.post('/investments', requireAuth, ah(async (req, res) => {
  const { name, type, currentValue, totalInvested, note } = req.body || {};
  if (!name || currentValue == null || totalInvested == null) return res.status(400).json({ error: 'name, currentValue, totalInvested required.' });
  const item = await Investment.create({
    familyId: req.user.familyId, userId: req.user._id,
    name, type: type || 'other', currentValue: Number(currentValue),
    totalInvested: Number(totalInvested), returns: Number(currentValue) - Number(totalInvested),
    note: note || '',
  });
  res.status(201).json({ item });
}));

router.patch('/investments/:id', requireAuth, ah(async (req, res) => {
  const item = await Investment.findOne({ _id: req.params.id, familyId: req.user.familyId });
  if (!item) return res.status(404).json({ error: 'Not found.' });
  const { name, type, currentValue, totalInvested, note } = req.body || {};
  if (name !== undefined) item.name = name;
  if (type !== undefined) item.type = type;
  if (currentValue !== undefined) { item.currentValue = Number(currentValue); item.returns = item.currentValue - item.totalInvested; }
  if (totalInvested !== undefined) { item.totalInvested = Number(totalInvested); item.returns = item.currentValue - item.totalInvested; }
  if (note !== undefined) item.note = note;
  await item.save();
  res.json({ item });
}));

router.delete('/investments/:id', requireAuth, ah(async (req, res) => {
  await Investment.findOneAndDelete({ _id: req.params.id, familyId: req.user.familyId });
  res.json({ ok: true });
}));

// ── Debts ────────────────────────────────────────────────────────────────────
router.get('/debts', requireAuth, ah(async (req, res) => {
  const items = await Debt.find({ familyId: req.user.familyId, settled: false }).sort({ createdAt: -1 });
  res.json({ items });
}));

router.get('/debts/history', requireAuth, ah(async (req, res) => {
  const items = await Debt.find({ familyId: req.user.familyId }).sort({ createdAt: -1 }).limit(50);
  res.json({ items });
}));

router.post('/debts', requireAuth, ah(async (req, res) => {
  const { direction, personName, amount, note, dueDate } = req.body || {};
  if (!direction || !personName || !amount) return res.status(400).json({ error: 'direction, personName, amount required.' });
  const item = await Debt.create({
    familyId: req.user.familyId, createdById: req.user._id,
    direction, personName, amount: Number(amount), note: note || '',
    dueDate: dueDate ? new Date(dueDate) : null,
  });
  res.status(201).json({ item });
}));

router.patch('/debts/:id', requireAuth, ah(async (req, res) => {
  const item = await Debt.findOne({ _id: req.params.id, familyId: req.user.familyId });
  if (!item) return res.status(404).json({ error: 'Not found.' });
  const { repaidAmount, settled, note } = req.body || {};
  if (repaidAmount !== undefined) item.repaidAmount = Number(repaidAmount);
  if (settled !== undefined) { item.settled = settled; if (settled) item.settledAt = new Date(); }
  if (note !== undefined) item.note = note;
  await item.save();
  res.json({ item });
}));

router.delete('/debts/:id', requireAuth, ah(async (req, res) => {
  await Debt.findOneAndDelete({ _id: req.params.id, familyId: req.user.familyId });
  res.json({ ok: true });
}));

// ── Subscriptions ────────────────────────────────────────────────────────────
router.get('/subscriptions', requireAuth, ah(async (req, res) => {
  const items = await Subscription.find({ familyId: req.user.familyId }).sort({ createdAt: -1 });
  res.json({ items });
}));

router.post('/subscriptions', requireAuth, ah(async (req, res) => {
  const { name, amount, cycle, category, nextBillingDate, note } = req.body || {};
  if (!name || !amount) return res.status(400).json({ error: 'name and amount required.' });
  const item = await Subscription.create({
    familyId: req.user.familyId, userId: req.user._id,
    name, amount: Number(amount), cycle: cycle || 'monthly',
    category: category || 'Entertainment', nextBillingDate: nextBillingDate ? new Date(nextBillingDate) : null,
    note: note || '',
  });
  res.status(201).json({ item });
}));

router.patch('/subscriptions/:id', requireAuth, ah(async (req, res) => {
  const item = await Subscription.findOne({ _id: req.params.id, familyId: req.user.familyId });
  if (!item) return res.status(404).json({ error: 'Not found.' });
  const { name, amount, cycle, category, nextBillingDate, active, note } = req.body || {};
  if (name !== undefined) item.name = name;
  if (amount !== undefined) item.amount = Number(amount);
  if (cycle !== undefined) item.cycle = cycle;
  if (category !== undefined) item.category = category;
  if (nextBillingDate !== undefined) item.nextBillingDate = nextBillingDate ? new Date(nextBillingDate) : null;
  if (active !== undefined) item.active = active;
  if (note !== undefined) item.note = note;
  await item.save();
  res.json({ item });
}));

router.delete('/subscriptions/:id', requireAuth, ah(async (req, res) => {
  await Subscription.findOneAndDelete({ _id: req.params.id, familyId: req.user.familyId });
  res.json({ ok: true });
}));

// Monthly cost summary for subscriptions
router.get('/subscriptions/summary', requireAuth, ah(async (req, res) => {
  const items = await Subscription.find({ familyId: req.user.familyId, active: true });
  let monthlyTotal = 0;
  for (const s of items) {
    if (s.cycle === 'monthly') monthlyTotal += s.amount;
    else if (s.cycle === 'yearly') monthlyTotal += Math.round(s.amount / 12);
    else if (s.cycle === 'weekly') monthlyTotal += Math.round(s.amount * 4.33);
  }
  res.json({ monthlyTotal, count: items.length, items });
}));

// ── Calendar ─────────────────────────────────────────────────────────────────
router.get('/calendar', requireAuth, ah(async (req, res) => {
  const { from, to } = req.query || {};
  const q = { familyId: req.user.familyId };
  if (from) q.date = { $gte: new Date(from) };
  if (to) q.date = { ...q.date, $lte: new Date(to) };
  const events = await CalendarEvent.find(q).sort({ date: 1 });
  res.json({ events });
}));

router.post('/calendar', requireAuth, ah(async (req, res) => {
  const { title, date, type, amount, recurring, note } = req.body || {};
  if (!title || !date) return res.status(400).json({ error: 'title and date required.' });
  const event = await CalendarEvent.create({
    familyId: req.user.familyId, createdById: req.user._id,
    title, date: new Date(date), type: type || 'reminder',
    amount: amount ? Number(amount) : 0, recurring: !!recurring, note: note || '',
  });
  res.status(201).json({ event });
}));

router.patch('/calendar/:id', requireAuth, ah(async (req, res) => {
  const event = await CalendarEvent.findOne({ _id: req.params.id, familyId: req.user.familyId });
  if (!event) return res.status(404).json({ error: 'Not found.' });
  const { title, date, type, amount, recurring, note } = req.body || {};
  if (title !== undefined) event.title = title;
  if (date !== undefined) event.date = new Date(date);
  if (type !== undefined) event.type = type;
  if (amount !== undefined) event.amount = Number(amount);
  if (recurring !== undefined) event.recurring = recurring;
  if (note !== undefined) event.note = note;
  await event.save();
  res.json({ event });
}));

router.delete('/calendar/:id', requireAuth, ah(async (req, res) => {
  await CalendarEvent.findOneAndDelete({ _id: req.params.id, familyId: req.user.familyId });
  res.json({ ok: true });
}));

// ── Family Chat ──────────────────────────────────────────────────────────────
router.get('/chat', requireAuth, ah(async (req, res) => {
  const before = req.query.before;
  const q = { familyId: req.user.familyId };
  if (before) q.createdAt = { $lt: new Date(before) };
  const messages = await ChatMessage.find(q).sort({ createdAt: -1 }).limit(50);
  res.json({ messages: messages.reverse() });
}));

router.post('/chat', requireAuth, ah(async (req, res) => {
  const { text, replyTo } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
  const msg = await ChatMessage.create({
    familyId: req.user.familyId, authorId: req.user._id,
    authorName: req.user.name, text: text.trim(),
    replyTo: replyTo || null,
  });
  res.status(201).json({ message: msg });
}));

router.post('/chat/:id/react', requireAuth, ah(async (req, res) => {
  const msg = await ChatMessage.findOne({ _id: req.params.id, familyId: req.user.familyId });
  if (!msg) return res.status(404).json({ error: 'Not found.' });
  const { emoji } = req.body || {};
  if (!emoji) return res.status(400).json({ error: 'emoji required.' });
  const existing = msg.reactions.find((r) => r.emoji === emoji);
  if (existing) {
    if (existing.userIds.includes(req.user._id)) {
      existing.userIds = existing.userIds.filter((u) => !u.equals(req.user._id));
      if (existing.userIds.length === 0) msg.reactions = msg.reactions.filter((r) => r.emoji !== emoji);
    } else {
      existing.userIds.push(req.user._id);
    }
  } else {
    msg.reactions.push({ emoji, userIds: [req.user._id] });
  }
  await msg.save();
  res.json({ message: msg });
}));

router.delete('/chat/:id', requireAuth, ah(async (req, res) => {
  await ChatMessage.findOneAndDelete({ _id: req.params.id, familyId: req.user.familyId, authorId: req.user._id });
  res.json({ ok: true });
}));

// ── Spending Challenges ──────────────────────────────────────────────────────
router.get('/challenges', requireAuth, ah(async (req, res) => {
  const items = await SpendingChallenge.find({ familyId: req.user.familyId }).sort({ startDate: -1 });
  res.json({ items });
}));

router.post('/challenges', requireAuth, ah(async (req, res) => {
  const { title, description, emoji, startDate, endDate, targetSpend, category, participants } = req.body || {};
  if (!title || !startDate || !endDate) return res.status(400).json({ error: 'title, startDate, endDate required.' });
  const item = await SpendingChallenge.create({
    familyId: req.user.familyId, createdById: req.user._id,
    title, description: description || '', emoji: emoji || '🏆',
    startDate: new Date(startDate), endDate: new Date(endDate),
    targetSpend: targetSpend ? Number(targetSpend) : 0,
    category: category || '', participants: participants || [],
  });
  res.status(201).json({ item });
}));

router.delete('/challenges/:id', requireAuth, ah(async (req, res) => {
  await SpendingChallenge.findOneAndDelete({ _id: req.params.id, familyId: req.user.familyId });
  res.json({ ok: true });
}));

// ── Education ────────────────────────────────────────────────────────────────
router.get('/education', requireAuth, ah(async (req, res) => {
  const lessons = await EducationLesson.find({ familyId: req.user.familyId }).sort({ createdAt: -1 });
  res.json({ lessons });
}));

router.post('/education', requireAuth, ah(async (req, res) => {
  const { title, content, emoji, category } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'title and content required.' });
  const lesson = await EducationLesson.create({
    familyId: req.user.familyId, title, content,
    emoji: emoji || '📚', category: category || 'other',
  });
  res.status(201).json({ lesson });
}));

router.patch('/education/:id/complete', requireAuth, ah(async (req, res) => {
  const lesson = await EducationLesson.findOne({ _id: req.params.id, familyId: req.user.familyId });
  if (!lesson) return res.status(404).json({ error: 'Not found.' });
  if (!lesson.completedBy.some((u) => u.equals(req.user._id))) {
    lesson.completedBy.push(req.user._id);
    await lesson.save();
  }
  res.json({ lesson });
}));

// ── Backup / Export ──────────────────────────────────────────────────────────
router.get('/backup', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  const period = await TrackingPeriod.findOne({ familyId: family._id, status: 'active' });
  const expenses = period ? await ExpenseTransaction.find({ familyId: family._id, periodId: period._id }) : [];
  const goals = await SavingsGoal.find({ familyId: family._id });
  const bills = await RecurringBill.find({ familyId: family._id });
  const investments = await Investment.find({ familyId: family._id });
  const debts = await Debt.find({ familyId: family._id });
  const subs = await Subscription.find({ familyId: family._id });
  const calendar = await CalendarEvent.find({ familyId: family._id });
  const chat = await ChatMessage.find({ familyId: family._id }).limit(200);
  const members = await User.find({ familyId: family._id });

  await BackupLog.create({ familyId: family._id, createdById: req.user._id, type: 'full', format: 'json' });

  res.json({
    family: { name: family.name, currency: family.currency },
    members: members.map((m) => ({ name: m.name, role: m.role })),
    expenses, goals, bills, investments, debts, subscriptions: subs,
    calendar, chat,
    exportedAt: new Date(),
  });
}));

// ── Notifications Preferences ────────────────────────────────────────────────
router.get('/notifications/prefs', requireAuth, ah(async (req, res) => {
  let prefs = await NotificationPref.findOne({ userId: req.user._id });
  if (!prefs) prefs = await NotificationPref.create({ userId: req.user._id });
  res.json({ prefs });
}));

router.patch('/notifications/prefs', requireAuth, ah(async (req, res) => {
  let prefs = await NotificationPref.findOne({ userId: req.user._id });
  if (!prefs) prefs = await NotificationPref.create({ userId: req.user._id });
  const { billReminders, budgetAlerts, streakNotifications, challengeUpdates, chatMessages } = req.body || {};
  if (billReminders !== undefined) prefs.billReminders = billReminders;
  if (budgetAlerts !== undefined) prefs.budgetAlerts = budgetAlerts;
  if (streakNotifications !== undefined) prefs.streakNotifications = streakNotifications;
  if (challengeUpdates !== undefined) prefs.challengeUpdates = challengeUpdates;
  if (chatMessages !== undefined) prefs.chatMessages = chatMessages;
  await prefs.save();
  res.json({ prefs });
}));

// ── Extra Analytics: Spend Velocity ──────────────────────────────────────────
router.get('/analytics/spend-velocity', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  const periods = await TrackingPeriod.find({ familyId: family._id, status: 'closed' }).sort({ createdAt: -1 }).limit(3);
  const now = new Date();
  const currentPeriod = await TrackingPeriod.findOne({ familyId: family._id, status: 'active' });

  let currentSpent = 0, prevSpent = 0, currentDays = 0, prevDays = 0;

  if (currentPeriod) {
    const curExpenses = await ExpenseTransaction.find({ familyId: family._id, periodId: currentPeriod._id });
    currentSpent = curExpenses.reduce((s, e) => s + e.amount, 0);
    currentDays = Math.max(1, Math.floor((now - currentPeriod.startDate) / 86400000));
  }
  if (periods[0]) {
    const prevExpenses = await ExpenseTransaction.find({ familyId: family._id, periodId: periods[0]._id });
    prevSpent = prevExpenses.reduce((s, e) => s + e.amount, 0);
    prevDays = Math.max(1, Math.floor((periods[0].endDate - periods[0].startDate) / 86400000));
  }

  const currentDaily = currentDays > 0 ? currentSpent / currentDays : 0;
  const prevDaily = prevDays > 0 ? prevSpent / prevDays : 0;
  const velocity = prevDaily > 0 ? ((currentDaily - prevDaily) / prevDaily) * 100 : 0;

  res.json({
    currentDaily: Math.round(currentDaily),
    previousDaily: Math.round(prevDaily),
    velocity: Math.round(velocity * 10) / 10, // percentage change
    trend: velocity > 5 ? 'up' : velocity < -5 ? 'down' : 'stable',
  });
}));

// ── Extra Analytics: Emergency Fund Calculator ───────────────────────────────
router.get('/analytics/emergency-fund', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  const periods = await TrackingPeriod.find({ familyId: family._id, status: 'closed' }).sort({ createdAt: -1 }).limit(6);
  let totalSpent = 0;
  for (const p of periods) {
    const expenses = await ExpenseTransaction.find({ familyId: family._id, periodId: p._id });
    totalSpent += expenses.reduce((s, e) => s + e.amount, 0);
  }
  const avgMonthly = periods.length > 0 ? totalSpent / periods.length : 0;

  // Total savings across goals
  const goals = await SavingsGoal.find({ familyId: family._id, reached: false });
  const totalSaved = goals.reduce((s, g) => s + g.currentAmount, 0);

  const monthsOfExpenses = avgMonthly > 0 ? (totalSaved / avgMonthly) : 0;

  res.json({
    totalSaved,
    avgMonthlyExpense: Math.round(avgMonthly),
    monthsOfExpenses: Math.round(monthsOfExpenses * 10) / 10,
    recommendation: monthsOfExpenses >= 6 ? 'You have a solid emergency fund! 🎉' :
      monthsOfExpenses >= 3 ? 'Good progress! Aim for 6 months of expenses.' :
      'Build your emergency fund to 3-6 months of expenses. 💪',
  });
}));

// ── Extra Analytics: Petrol Efficiency ───────────────────────────────────────
router.get('/analytics/petrol-efficiency', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  const petrolExpenses = await ExpenseTransaction.find({
    familyId: family._id,
    category: { $regex: /petrol|fuel|gas/i },
  }).sort({ createdAt: -1 });

  const totalSpent = petrolExpenses.reduce((s, e) => s + e.amount, 0);
  const count = petrolExpenses.length;
  const avgPerTrip = count > 0 ? Math.round(totalSpent / count) : 0;

  // Get station breakdown
  const byStation = {};
  for (const e of petrolExpenses) {
    const station = e.shopName || 'Unknown';
    if (!byStation[station]) byStation[station] = { total: 0, count: 0 };
    byStation[station].total += e.amount;
    byStation[station].count += 1;
  }

  res.json({ totalSpent, count, avgPerTrip, byStation });
}));

// ── Extra Analytics: Meal Cost Per Serving ───────────────────────────────────
router.get('/analytics/meal-cost', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  const meals = await ExpenseTransaction.find({
    familyId: family._id,
    category: { $regex: /meal|food|grocery/i },
  }).sort({ createdAt: -1 }).limit(20);

  const avgCost = meals.length > 0 ? Math.round(meals.reduce((s, e) => s + e.amount, 0) / meals.length) : 0;

  res.json({ avgMealCost: avgCost, sampleSize: meals.length });
}));

// ── Extra Analytics: Shopping Price Comparison ───────────────────────────────
router.get('/analytics/price-comparison', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  const shops = await Shop.find({ familyId: family._id, type: 'groceries' });
  const comparison = [];

  for (const shop of shops) {
    const expenses = await ExpenseTransaction.find({ familyId: family._id, shopId: shop._id }).limit(20);
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    const avg = expenses.length > 0 ? Math.round(total / expenses.length) : 0;
    comparison.push({ name: shop.name, totalSpent: total, avgPerTrip: avg, tripCount: expenses.length });
  }

  comparison.sort((a, b) => a.avgPerTrip - b.avgPerTrip);
  res.json({ comparison });
}));

// ── Auto-detect recurring expenses ───────────────────────────────────────────
router.get('/analytics/recurring-detect', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  const expenses = await ExpenseTransaction.find({ familyId: family._id }).sort({ createdAt: -1 }).limit(200);

  // Group by shopName + amount to find patterns
  const patterns = {};
  for (const e of expenses) {
    const key = `${(e.shopName || '').toLowerCase()}_${e.amount}`;
    if (!patterns[key]) patterns[key] = { shop: e.shopName, amount: e.amount, count: 0, dates: [] };
    patterns[key].count += 1;
    patterns[key].dates.push(e.createdAt);
  }

  // Items that appear 2+ times are likely recurring
  const recurring = Object.values(patterns)
    .filter((p) => p.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  res.json({ recurring });
}));

// ── Round-up savings ─────────────────────────────────────────────────────────
router.post('/analytics/roundup', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  let roundupGoal = await SavingsGoal.findOne({ familyId: family._id, isRoundup: true });
  if (!roundupGoal) {
    roundupGoal = await SavingsGoal.create({
      familyId: family._id, name: 'Spare Change Savings', targetAmount: 500000,
      emoji: '🪙', isRoundup: true,
    });
  }

  const expenses = await ExpenseTransaction.find({ familyId: family._id }).sort({ createdAt: -1 }).limit(10);
  let totalRoundup = 0;
  for (const e of expenses) {
    const rounded = Math.ceil(e.amount / 100) * 100;
    totalRoundup += rounded - e.amount;
  }

  if (totalRoundup > 0) {
    roundupGoal.currentAmount += totalRoundup;
    if (roundupGoal.currentAmount >= roundupGoal.targetAmount) {
      roundupGoal.reached = true;
      roundupGoal.reachedAt = new Date();
    }
    await roundupGoal.save();
  }

  res.json({ added: totalRoundup, goal: roundupGoal });
}));

// ── Category Suggestions (learn from history) ───────────────────────────────
router.get('/analytics/category-suggest', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  const expenses = await ExpenseTransaction.find({ familyId: family._id }).limit(300);
  const shopCategories = {};
  for (const e of expenses) {
    if (e.shopName && e.category) {
      const shop = e.shopName.toLowerCase();
      if (!shopCategories[shop]) shopCategories[shop] = {};
      if (!shopCategories[shop][e.category]) shopCategories[shop][e.category] = 0;
      shopCategories[shop][e.category]++;
    }
  }
  // For each shop, pick the most common category
  const suggestions = {};
  for (const [shop, cats] of Object.entries(shopCategories)) {
    const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) suggestions[shop] = sorted[0][0];
  }
  res.json({ suggestions });
}));

// ── Tax Report (Malaysian tax categories) ───────────────────────────────────
router.get('/analytics/tax-report', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  const expenses = await ExpenseTransaction.find({ familyId: family._id });
  const categories = {};
  for (const e of expenses) {
    const cat = e.category || 'Other';
    if (!categories[cat]) categories[cat] = { total: 0, count: 0 };
    categories[cat].total += e.amount;
    categories[cat].count += 1;
  }
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  res.json({ categories, total, period: 'all' });
}));

// ── Budget Alerts ────────────────────────────────────────────────────────────
router.get('/analytics/budget-alerts', requireAuth, ah(async (req, res) => {
  const family = await getFamily(req);
  const period = await TrackingPeriod.findOne({ familyId: family._id, status: 'active' });
  if (!period) return res.json({ alerts: [] });

  const budgets = await CategoryBudget.find({ familyId: family._id, periodId: period._id });
  const expenses = await ExpenseTransaction.find({ familyId: family._id, periodId: period._id });

  const spentByCategory = {};
  for (const e of expenses) {
    const cat = e.category || 'Other';
    spentByCategory[cat] = (spentByCategory[cat] || 0) + e.amount;
  }

  const alerts = [];
  for (const b of budgets) {
    const spent = spentByCategory[b.category] || 0;
    const pct = b.budgetAmount > 0 ? (spent / b.budgetAmount) * 100 : 0;
    if (pct >= 80) {
      alerts.push({
        category: b.category,
        spent, budget: b.budgetAmount,
        percentage: Math.round(pct),
        level: pct >= 100 ? 'over' : 'warning',
      });
    }
  }

  // Also check grocery balance
  const gbal = await GroceryBalance.findOne({ familyId: family._id, periodId: period._id });
  if (gbal && gbal.budgetAmount > 0) {
    const pct = (gbal.spent / gbal.budgetAmount) * 100;
    if (pct >= 80) {
      alerts.push({
        category: 'Groceries (Total)',
        spent: gbal.spent, budget: gbal.budgetAmount,
        percentage: Math.round(pct),
        level: pct >= 100 ? 'over' : 'warning',
      });
    }
  }

  res.json({ alerts });
}));

// ─── Report Issues (v4 #31) ─────────────────────────────────────────────
const reportSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  familyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Family', required: true },
  category: { type: String, enum: ['bug', 'feature', 'other'], default: 'bug' },
  message: { type: String, required: true, maxlength: 2000 },
  status: { type: String, enum: ['new', 'read', 'resolved'], default: 'new' },
}, { timestamps: true });
const ReportIssue = mongoose.model('ReportIssue', reportSchema);

router.post('/report-issue', requireAuth, ah(async (req, res) => {
  const { category, message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Please describe the issue.' });
  const report = await ReportIssue.create({
    userId: req.user._id,
    familyId: req.user.familyId,
    category: category || 'bug',
    message: message.trim().slice(0, 2000),
  });
  res.json({ ok: true, id: report._id });
}));

module.exports = router;
