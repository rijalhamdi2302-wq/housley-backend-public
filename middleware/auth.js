/**
 * Housely — auth middleware
 * Verifies the Bearer JWT on every protected route and exposes req.user.
 * Also carries small helpers for role-based permission checks.
 */

const jwt = require('jsonwebtoken');
const { User } = require('../models');

const JWT_SECRET = process.env.JWT_SECRET || 'insecure_dev_secret_change_me';
const TOKEN_TTL = '7d';

function signToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      familyId: user.familyId ? user.familyId.toString() : undefined,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

/** Express middleware: requires a valid Bearer token. */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Account no longer exists.' });
    }
    // Attach the safe user plus family id from token (payload wins so a stale
    // DB family change doesn't matter mid-session).
    req.user = user;
    req.tokenFamilyId = payload.familyId || user.familyId;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid session token.' });
  }
}

/** Require the requester to have one of the given roles. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

/**
 * Validate a 4-digit numeric PIN string.
 * @returns {string|null} normalized pin or null if invalid
 */
function normalizePin(pin) {
  if (typeof pin !== 'string') return null;
  const trimmed = pin.trim();
  if (!/^\d{4}$/.test(trimmed)) return null;
  return trimmed;
}

module.exports = { requireAuth, requireRole, signToken, normalizePin, JWT_SECRET };
