/**
 * Housley (public) — DEV-ONLY seed script.
 *
 * Creates two demo families:
 *   1) Pro demo  — has 7-day trial (all features unlocked)
 *   2) Free demo — no trial, no paid subscription (paywall active)
 *
 *   npm run seed          → creates both accounts (skips if they exist)
 *   npm run seed -- --wipe → wipe the whole DB first (destructive, dev only)
 *
 * Demo logins:
 *   Pro:  demo@housley.app / demo1234
 *   Free: demo-free@housley.app / demo1234
 */

require('dotenv').config();
require('./lib/dns-fix'); // must run before mongoose.connect (see lib/dns-fix.js)
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Family, User, TrackingPeriod, GroceryBalance, PersonalBalance, Category } = require('./models');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI missing in backend/.env');
  process.exit(1);
}

const DEFAULT_CATEGORIES = [
  'Groceries', 'Meat & Fish', 'Vegetables & Fruits', 'Dairy & Eggs', 'Petrol',
  'Restaurant & Eat Out', 'Pharmacy & Health', 'Utility Bills', 'Transport',
  'Education', 'Entertainment', 'Household', 'Personal Care', 'Other',
];

const DEMO_EMAIL = 'demo@housley.app';
const DEMO_PASSWORD = 'demo1234';
const FREE_EMAIL = 'demo-free@housley.app';
const FREE_PASSWORD = 'demo1234';

/** Generic placeholder members for Pro demo (no real family data — dev only). */
const MEMBERS = [
  { name: 'Demo Dad', role: 'provider', color: '#4e9de6' },
  { name: 'Demo Mom', role: 'grocery_spender', color: '#f39ac2' },
  { name: 'Demo Kid', role: 'member', color: '#7c5cd6' },
  { name: 'Demo Baby', role: 'dependent', color: '#f7b32b' },
];

/** Generic placeholder members for Free demo. */
const FREE_MEMBERS = [
  { name: 'Free Dad', role: 'provider', color: '#6fcf97' },
  { name: 'Free Mom', role: 'grocery_spender', color: '#f2994a' },
  { name: 'Free Kid', role: 'member', color: '#5bc0de' },
];

/** Reset all PINs in a family so every member starts fresh. */
async function clearFamilyPins(familyId, label) {
  await User.updateMany(
    { familyId },
    { $set: { pinHash: null, failedAttempts: 0, lockedUntil: null } }
  );
  console.log(`🔑 ${label} — all PINs cleared so every member can create a fresh one.`);
}

async function main() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  console.log('✓ Connected to MongoDB');

  if (process.argv.includes('--wipe')) {
    const cols = await mongoose.connection.db.collections();
    for (const col of cols) await col.drop();
    console.log('⚠ Wiped all existing collections.');
  }

  const existingAccount = await User.findOne({ email: DEMO_EMAIL });
  if (existingAccount) {
    // Accounts already exist — just clear any PINs that were set during testing
    // so every profile shows "Create your PIN" instead of "Enter your PIN".
    await clearFamilyPins(existingAccount.familyId, 'Pro demo');
    console.log('ℹ Pro demo accounts already exist — PINs cleared. Log in with demo@housley.app / demo1234');
  } else {
    const family = await Family.create({
      name: 'Demo Family',
      periodType: 'monthly',
      rolloverPolicy: 'carry_forward',
      currency: 'RM',
      // Give the demo account an active Pro trial so every feature is previewable.
      trialEndsAt: new Date(Date.now() + 7 * 86400000),
    });

    const users = [];
    for (const [i, m] of MEMBERS.entries()) {
      const isDemo = m.role === 'provider';
      const u = await User.create({
        familyId: family._id,
        name: m.name,
        role: m.role,
        sortOrder: i + 1,
        avatarColor: m.color,
        ...(isDemo ? { email: DEMO_EMAIL, passwordHash: await bcrypt.hash(DEMO_PASSWORD, 12) } : {}),
      });
      users.push(u);
      console.log(`  ✓ ${m.name} (${m.role})${isDemo ? ' — demo account' : ''}`);
    }

    const now = new Date();
    const period = await TrackingPeriod.create({
      familyId: family._id,
      startDate: new Date(now.getFullYear(), now.getMonth(), 1),
      endDate: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      status: 'active',
    });

    await GroceryBalance.create({ familyId: family._id, periodId: period._id, funded: 0, spent: 0, budgetAmount: 0 });
    for (const u of users) {
      await PersonalBalance.create({ userId: u._id, periodId: period._id, funded: 0, spent: 0, fundedBy: [] });
    }

    await Category.insertMany(DEFAULT_CATEGORIES.map((name) => ({ familyId: family._id, name })));

    console.log('✓ Seeded Pro demo family + demo account.');
    console.log('  Log in with:  demo@housley.app / demo1234');
  }

  // --- Free demo (no Pro trial) ---
  const freeExisting = await User.findOne({ email: FREE_EMAIL });
  if (freeExisting) {
    // Accounts already exist — just clear any PINs that were set during testing.
    await clearFamilyPins(freeExisting.familyId, 'Free demo');
    console.log('ℹ Free demo accounts already exist — PINs cleared. Log in with demo-free@housley.app / demo1234');
  } else {
    const freeFamily = await Family.create({
      name: 'Free Demo Family',
      periodType: 'monthly',
      rolloverPolicy: 'carry_forward',
      currency: 'RM',
      // NO trialEndsAt, NO proTier — this family is permanently Free
    });

    const freeUsers = [];
    for (const [i, m] of FREE_MEMBERS.entries()) {
      const isDemo = m.role === 'provider';
      const u = await User.create({
        familyId: freeFamily._id,
        name: m.name,
        role: m.role,
        sortOrder: i + 1,
        avatarColor: m.color,
        ...(isDemo ? { email: FREE_EMAIL, passwordHash: await bcrypt.hash(FREE_PASSWORD, 12) } : {}),
      });
      freeUsers.push(u);
      console.log(`  ✓ ${m.name} (${m.role})${isDemo ? ' — free demo account' : ''}`);
    }

    const fp = await TrackingPeriod.create({
      familyId: freeFamily._id,
      startDate: new Date(now.getFullYear(), now.getMonth(), 1),
      endDate: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999),
      status: 'active',
    });
    await GroceryBalance.create({ familyId: freeFamily._id, periodId: fp._id, funded: 0, spent: 0, budgetAmount: 0 });
    for (const u of freeUsers) {
      await PersonalBalance.create({ userId: u._id, periodId: fp._id, funded: 0, spent: 0, fundedBy: [] });
    }
    await Category.insertMany(DEFAULT_CATEGORIES.map((name) => ({ familyId: freeFamily._id, name })));
    console.log('✓ Seeded Free demo family + account.');
    console.log('  Log in with:  demo-free@housley.app / demo1234');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('✗ Seed failed:', err);
  process.exit(1);
});
