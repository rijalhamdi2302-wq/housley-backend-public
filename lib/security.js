/**
 * Housley — Security middleware helpers
 * Input validation, sanitization, and additional protections.
 */

/**
 * Validate that a value matches an expected shape.
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateEmail(email) {
  if (!email || typeof email !== 'string') return { valid: false, error: 'Email is required' };
  const clean = email.trim().toLowerCase();
  if (clean.length > 254) return { valid: false, error: 'Email too long' };
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!re.test(clean)) return { valid: false, error: 'Invalid email format' };
  return { valid: true, clean };
}

function validatePin(pin) {
  if (!pin || typeof pin !== 'string') return { valid: false, error: 'PIN is required' };
  if (!/^\d{4}$/.test(pin)) return { valid: false, error: 'PIN must be exactly 4 digits' };
  return { valid: true, clean: pin };
}

function validateName(name) {
  if (!name || typeof name !== 'string') return { valid: false, error: 'Name is required' };
  const clean = name.trim();
  if (clean.length < 1) return { valid: false, error: 'Name cannot be empty' };
  if (clean.length > 50) return { valid: false, error: 'Name too long (max 50 chars)' };
  return { valid: true, clean };
}

function validateAmount(amount) {
  const num = parseFloat(amount);
  if (isNaN(num)) return { valid: false, error: 'Amount must be a number' };
  if (num < 0) return { valid: false, error: 'Amount cannot be negative' };
  if (num > 999999999) return { valid: false, error: 'Amount too large' };
  return { valid: true, clean: Math.round(num * 100) / 100 };
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return { valid: false, error: 'Password is required' };
  if (password.length < 6) return { valid: false, error: 'Password must be at least 6 characters' };
  if (password.length > 128) return { valid: false, error: 'Password too long' };
  return { valid: true, clean: password };
}

function validateObjectId(id) {
  if (!id || typeof id !== 'string') return { valid: false, error: 'ID is required' };
  if (!/^[a-fA-F0-9]{24}$/.test(id)) return { valid: false, error: 'Invalid ID format' };
  return { valid: true, clean: id };
}

/**
 * Sanitize a string: trim, remove null bytes, limit length.
 */
function sanitize(str, maxLength = 500) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/\0/g, '')           // remove null bytes
    .trim()
    .slice(0, maxLength);         // limit length
}

/**
 * Middleware: reject requests with suspicious patterns.
 */
function requestGuard(req, res, next) {
  const suspicious = [
    /(\.\.\/)/,                    // path traversal
    /(\<script)/i,                 // XSS
    /(javascript:)/i,              // XSS
    /(on\w+\s*=)/i,                // event handler injection
    /(union\s+select)/i,           // SQL injection
    /(;\s*drop\s+table)/i,         // SQL injection
  ];

  const check = [
    req.url,
    JSON.stringify(req.query),
    JSON.stringify(req.body),
  ].join(' ');

  for (const pattern of suspicious) {
    if (pattern.test(check)) {
      console.warn(`⚠️ Suspicious request blocked: ${req.method} ${req.url} from ${req.ip}`);
      return res.status(400).json({ error: 'Invalid request' });
    }
  }

  next();
}

/**
 * Middleware: log slow requests (>2 seconds).
 */
function slowRequestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (ms > 2000) {
      console.warn(`🐌 Slow request: ${req.method} ${req.url} took ${ms}ms`);
    }
  });
  next();
}

module.exports = {
  validateEmail,
  validatePin,
  validateName,
  validateAmount,
  validatePassword,
  validateObjectId,
  sanitize,
  requestGuard,
  slowRequestLogger,
};
