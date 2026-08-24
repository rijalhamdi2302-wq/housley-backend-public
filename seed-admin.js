/**
 * Housley — Seed the first admin account.
 * Usage: node seed-admin.js
 * 
 * This creates a superadmin account for the HQ dashboard.
 * Run this ONCE when setting up the admin panel for the first time.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
require('./lib/dns-fix');

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { AdminUser } = require('./models');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI not found in .env');
  process.exit(1);
}

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'hrijal752@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'HamdiSPM9@';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Super Admin';

async function main() {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log('✓ Connected to MongoDB');

  const existing = await AdminUser.findOne({ email: ADMIN_EMAIL.toLowerCase() });
  if (existing) {
    console.log(`⚠ Admin "${ADMIN_EMAIL}" already exists (role: ${existing.role}). Skipping.`);
    await mongoose.disconnect();
    return;
  }

  const admin = await AdminUser.create({
    email: ADMIN_EMAIL.toLowerCase(),
    passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
    name: ADMIN_NAME,
    role: 'superadmin',
    active: true,
  });

  console.log(`✓ Admin created successfully!`);
  console.log(`  Email: ${admin.email}`);
  console.log(`  Name:  ${admin.name}`);
  console.log(`  Role:  ${admin.role}`);
  console.log(`  ID:    ${admin._id}`);

  await mongoose.disconnect();
  console.log('✓ Done. You can now log in at the admin dashboard.');
}

main().catch(err => { console.error('✗ Error:', err.message); process.exit(1); });
