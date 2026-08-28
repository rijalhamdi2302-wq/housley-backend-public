/**
 * Housley (public) — Pro subscription logic (3-tier system).
 *
 * Three access levels:
 *   Level 1 "Spark"  — 25% of premium features
 *   Level 2 "Pro"    — 50% of premium features
 *   Level 3 "Vault"  — 100% of premium features
 *
 * Five durations per level: monthly, quarterly (3mo), semi-annual (6mo), yearly, lifetime.
 *
 * Pro is per-family and verified server-side; this context just mirrors
 * GET /api/pro/status and refreshes whenever the session changes.
 */

const { Family } = require('../models');

const TRIAL_DAYS = 7;

/**
 * The plans a family can buy. Prices are in SEN (RM × 100).
 * plan IDs: spark_monthly, spark_quarterly, spark_semiannual, spark_yearly, spark_lifetime,
 *           pro_monthly, pro_quarterly, pro_semiannual, pro_yearly, pro_lifetime,
 *           vault_monthly, vault_quarterly, vault_semiannual, vault_yearly, vault_lifetime
 */
const PLANS = {
  // ── Level 1: Spark (25% features) ──────────────────────────────────────
  spark_monthly:     { id: 'spark_monthly',     name: 'Spark Monthly',     tier: 'spark', priceSen: 490,  label: 'RM 4.90 / month',   perDay: '~RM 0.16/day', days: 30 },
  spark_quarterly:   { id: 'spark_quarterly',   name: 'Spark 3 Months',    tier: 'spark', priceSen: 1290, label: 'RM 12.90 / 3 mo',   perDay: '~RM 0.14/day', days: 90 },
  spark_semiannual:  { id: 'spark_semiannual',  name: 'Spark 6 Months',    tier: 'spark', priceSen: 2290, label: 'RM 22.90 / 6 mo',   perDay: '~RM 0.13/day', days: 180 },
  spark_yearly:      { id: 'spark_yearly',      name: 'Spark Yearly',      tier: 'spark', priceSen: 3990, label: 'RM 39.90 / year',   perDay: '~RM 0.11/day', days: 365, popular: false },
  spark_lifetime:    { id: 'spark_lifetime',    name: 'Spark Lifetime',    tier: 'spark', priceSen: 6990, label: 'RM 69.90 once',     perDay: 'one-time', days: Infinity },

  // ── Level 2: Pro (50% features) ────────────────────────────────────────
  pro_monthly:       { id: 'pro_monthly',       name: 'Pro Monthly',       tier: 'pro',   priceSen: 990,  label: 'RM 9.90 / month',   perDay: '~RM 0.33/day', days: 30 },
  pro_quarterly:     { id: 'pro_quarterly',     name: 'Pro 3 Months',      tier: 'pro',   priceSen: 2490, label: 'RM 24.90 / 3 mo',   perDay: '~RM 0.28/day', days: 90 },
  pro_semiannual:    { id: 'pro_semiannual',    name: 'Pro 6 Months',      tier: 'pro',   priceSen: 4490, label: 'RM 44.90 / 6 mo',   perDay: '~RM 0.25/day', days: 180 },
  pro_yearly:        { id: 'pro_yearly',        name: 'Pro Yearly',        tier: 'pro',   priceSen: 7990, label: 'RM 79.90 / year',   perDay: '~RM 0.22/day', days: 365, popular: true },
  pro_lifetime:      { id: 'pro_lifetime',      name: 'Pro Lifetime',      tier: 'pro',   priceSen: 14990, label: 'RM 149.90 once',   perDay: 'one-time', days: Infinity },

  // ── Level 3: Vault (100% features) ─────────────────────────────────────
  vault_monthly:     { id: 'vault_monthly',     name: 'Vault Monthly',     tier: 'vault', priceSen: 1490, label: 'RM 14.90 / month',  perDay: '~RM 0.50/day', days: 30 },
  vault_quarterly:   { id: 'vault_quarterly',   name: 'Vault 3 Months',    tier: 'vault', priceSen: 3990, label: 'RM 39.90 / 3 mo',   perDay: '~RM 0.44/day', days: 90 },
  vault_semiannual:  { id: 'vault_semiannual',  name: 'Vault 6 Months',    tier: 'vault', priceSen: 6990, label: 'RM 69.90 / 6 mo',   perDay: '~RM 0.39/day', days: 180 },
  vault_yearly:      { id: 'vault_yearly',      name: 'Vault Yearly',      tier: 'vault', priceSen: 11900, label: 'RM 119 / year',    perDay: '~RM 0.33/day', days: 365 },
  vault_lifetime:    { id: 'vault_lifetime',    name: 'Vault Lifetime',    tier: 'vault', priceSen: 29900, label: 'RM 299 once',      perDay: 'one-time', days: Infinity },
};

/**
 * Tier hierarchy — higher tier always counts as having lower tiers too.
 * spark < pro < vault
 */
const TIER_RANK = { none: 0, trial: 0, spark: 1, pro: 2, vault: 3 };

/**
 * Normalize a raw proTier (e.g. 'vault_lifetime', 'pro_yearly', 'spark_monthly')
 * into the base tier key ('vault', 'pro', 'spark', 'lifetime', 'none').
 * Also handles plain 'lifetime' from legacy data.
 */
function normalizeTier(raw) {
  if (!raw || raw === 'none') return 'none';
  if (raw === 'lifetime') return 'lifetime';
  // Extract prefix before the underscore: 'vault_lifetime' → 'vault'
  const prefix = raw.split('_')[0];
  if (TIER_RANK[prefix] !== undefined) return prefix;
  return raw;
}

/** Check if a normalized tier is a lifetime plan. */
function isLifetimeTier(raw) {
  return raw === 'lifetime' || (raw && raw.includes('_lifetime'));
}

/**
 * Check if the family's current tier meets or exceeds the required tier.
 * @param {string} familyTier - current tier ('none', 'trial', 'spark', 'pro', 'vault')
 * @param {string} requiredTier - minimum tier needed ('spark', 'pro', 'vault')
 */
function hasAccess(familyTier, requiredTier) {
  const normalized = normalizeTier(familyTier);
  return (TIER_RANK[normalized] || 0) >= (TIER_RANK[requiredTier] || 0);
}

/** Is this family currently enjoying any paid tier (paid OR trial)? */
function isPro(family) {
  if (!family) return false;
  const raw = family.proTier;
  if (!raw || raw === 'none') {
    // Check trial
    if (family.trialEndsAt && new Date(family.trialEndsAt).getTime() > Date.now()) return true;
    return false;
  }
  if (isLifetimeTier(raw)) return true;
  // Not lifetime — check expiry
  if (family.proExpiresAt && new Date(family.proExpiresAt).getTime() > Date.now()) return true;
  if (family.trialEndsAt && new Date(family.trialEndsAt).getTime() > Date.now()) return true;
  return false;
}

/**
 * Check if family has access to a specific tier level.
 * During trial, they get full 'vault' access.
 * @param {object} family
 * @param {string} requiredTier - 'spark', 'pro', or 'vault'
 */
function hasTierAccess(family, requiredTier) {
  if (!family) return false;
  // Trial gives full vault access
  if (family.trialEndsAt && new Date(family.trialEndsAt).getTime() > Date.now()) return true;
  // Lifetime of any tier
  if (isLifetimeTier(family.proTier)) {
    const normalized = normalizeTier(family.proTier);
    return (TIER_RANK[normalized] || 0) >= (TIER_RANK[requiredTier] || 0);
  }
  // Check tier hierarchy
  return hasAccess(family.proTier, requiredTier);
}

/** Human-friendly status object for the app + the paywall. */
function proStatus(family) {
  const now = Date.now();
  const trial = family.trialEndsAt ? new Date(family.trialEndsAt).getTime() : 0;
  const exp = family.proExpiresAt ? new Date(family.proExpiresAt).getTime() : 0;
  const raw = family.proTier || 'none';
  let tier = 'none';
  if (isLifetimeTier(raw)) tier = 'lifetime';
  else if (raw !== 'none' && exp > now) tier = normalizeTier(raw);
  else if (trial > now) tier = 'trial';
  const active = tier !== 'none';

  // Group plans by tier level for display
  const tiers = {
    spark: Object.values(PLANS).filter(p => p.tier === 'spark').map(formatPlan),
    pro: Object.values(PLANS).filter(p => p.tier === 'pro').map(formatPlan),
    vault: Object.values(PLANS).filter(p => p.tier === 'vault').map(formatPlan),
  };

  // Determine the effective tier rank for display (lifetime vault = vault)
  const displayTier = tier === 'lifetime' ? 'vault' : tier;

  return {
    active,
    tier,
    tierName: tier === 'trial' ? 'Vault Trial' : tier === 'lifetime' ? 'Vault Lifetime' : tier !== 'none' ? `${displayTier.charAt(0).toUpperCase() + displayTier.slice(1)}` : 'Free',
    expiresAt: isLifetimeTier(raw) ? null : exp > now ? family.proExpiresAt : null,
    trialEndsAt: trial > now ? family.trialEndsAt : null,
    purchasedAt: family.proPurchasedAt || null,
    tiers,
    plans: Object.values(PLANS).map(formatPlan),
  };
}

function formatPlan(p) {
  return {
    id: p.id,
    name: p.name,
    tier: p.tier,
    priceSen: p.priceSen,
    label: p.label,
    perDay: p.perDay,
    popular: Boolean(p.popular),
  };
}

/**
 * Apply a Pro grant. Renewals EXTEND from the current expiry (if still valid).
 */
async function grantPro(family, planId) {
  const plan = PLANS[planId];
  if (!plan) {
    const err = new Error('Unknown plan.');
    err.status = 400;
    throw err;
  }
  if (plan.days === Infinity) {
    family.proTier = 'lifetime';
    family.proExpiresAt = null;
  } else {
    const stillActive = family.proTier !== 'none' && family.proExpiresAt && new Date(family.proExpiresAt).getTime() > Date.now();
    const base = stillActive ? new Date(family.proExpiresAt) : new Date();
    family.proTier = plan.id;
    family.proExpiresAt = new Date(base.getTime() + plan.days * 86400000);
  }
  family.proPurchasedAt = new Date();
  await family.save();
  return proStatus(family);
}

/**
 * Express middleware — place AFTER requireAuth. Rejects families below the
 * required tier with 402 + code PRO_REQUIRED.
 * @param {string} requiredTier - minimum tier: 'spark', 'pro', or 'vault' (default 'spark')
 */
function requirePro(requiredTier = 'spark') {
  return (req, res, next) =>
    Family.findById(req.user?.familyId || req.tokenFamilyId)
      .then((family) => {
        if (!family) return res.status(401).json({ error: 'Family not found. Please sign in again.' });
        if (!hasTierAccess(family, requiredTier)) {
          return res.status(402).json({
            error: `This is a ${requiredTier.charAt(0).toUpperCase() + requiredTier.slice(1)} feature. Upgrade to unlock it for the whole family.`,
            code: 'PRO_REQUIRED',
            requiredTier,
          });
        }
        req.family = family;
        next();
      })
      .catch(next);
}

module.exports = { TRIAL_DAYS, PLANS, TIER_RANK, normalizeTier, isLifetimeTier, isPro, hasTierAccess, hasAccess, proStatus, grantPro, requirePro };
