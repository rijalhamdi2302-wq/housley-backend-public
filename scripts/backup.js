#!/usr/bin/env node
/**
 * Housley — MongoDB Backup Script
 *
 * Runs daily via cron (or manually: node scripts/backup.js)
 * Keeps last 7 backups, stores in ../backups/
 *
 * Usage:
 *   node scripts/backup.js           # local backup
 *   curl -X POST -H "x-backup-secret: YOUR_SECRET" https://your-app.onrender.com/api/backup
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const MONGO_URI = process.env.MONGODB_URI;
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const KEEP_BACKUPS = 7;

if (!MONGO_URI) {
  console.error('❌ MONGODB_URI is not set. Cannot backup.');
  process.exit(1);
}

// Create backup directory
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const date = new Date().toISOString().split('T')[0];
const backupPath = path.join(BACKUP_DIR, `backup-${date}`);

console.log(`📦 Starting backup: ${date}`);

exec(
  `mongodump --uri="${MONGO_URI}" --out="${backupPath}" --gzip`,
  (error, stdout, stderr) => {
    if (error) {
      console.error('❌ Backup failed:', error.message);
      process.exit(1);
    }

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    console.log(`✅ Backup complete: ${backupPath}`);

    // Cleanup old backups (keep last N)
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup-'))
      .sort()
      .reverse();

    while (backups.length > KEEP_BACKUPS) {
      const old = backups.pop();
      const oldPath = path.join(BACKUP_DIR, old);
      fs.rmSync(oldPath, { recursive: true, force: true });
      console.log(`🗑️  Removed old backup: ${old}`);
    }

    console.log(`📦 Active backups: ${backups.length + 1}`);
  }
);
