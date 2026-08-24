/**
 * Housley (public) — Pro subscription + ToyyibPay payment routes.
 *
 *   GET  /api/pro/status        — the family's Pro state + plan prices
 *   POST /api/pro/checkout      — create a ToyyibPay bill for a plan
 *   POST /api/pro/webhook       — ToyyibPay server callback (hash-verified)
 *   GET  /api/pro/bill-status   — poll a bill after the payer returns
 *   POST /api/pro/dev-complete  — DEV-ONLY payment simulator (ALLOW_DEV_PAYMENT=1)
 *   POST /api/pro/dev-clear     — DEV-ONLY: drop Pro + trial (test the paywall)
 *
 * Security: the webhook is never trusted alone. The MD5 callback hash is
 * checked first, then the payment is re-verified server-to-server with
 * getBillTransactions before Pro is granted. Grants are idempotent — a
 * duplicated callback can never double-extend a subscription.
 */

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { Family, ProOrder, PromoCode } = require('../models');
const { requireAuth } = require('../middleware/auth');
const { ah, getFamily } = require('./helpers');
const pro = require('../lib/pro');
const toyyib = require('../lib/toyyibpay');

const router = express.Router();

const isDevPayment = () => String(process.env.ALLOW_DEV_PAYMENT) === '1';

// --- Promo codes (dynamic — stored in MongoDB, managed by admin) ---

/** Validate a promo code: exists + not expired + not already used + meets target. */
async function validatePromo(code, familyId) {
  if (!code) return { valid: false, error: 'Enter a promo code.' };
  const upper = String(code).trim().toUpperCase();
  const promo = await PromoCode.findOne({ code: upper, active: true });
  if (!promo) return { valid: false, error: 'Invalid promo code.' };
  // Check expiry
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
    return { valid: false, error: 'This promo code has expired.' };
  }
  // Check usage limit
  if (promo.maxUses > 0 && promo.currentUses >= promo.maxUses) {
    return { valid: false, error: 'This promo code has reached its usage limit.' };
  }
  // Check family hasn't used it
  const { PromoCodeUsage } = require('../models');
  const used = await PromoCodeUsage.findOne({ familyId, code: upper });
  if (used) return { valid: false, error: 'This promo code has already been used by your family.' };
  // Check target emails (if set, only those families' members can use it)
  if (promo.targetEmails && promo.targetEmails.length > 0) {
    const { User } = require('../models');
    const familyUsers = await User.find({ familyId }).select('email').lean();
    const familyEmails = familyUsers.map(u => (u.email || '').toLowerCase());
    const hasAccess = familyEmails.some(e => promo.targetEmails.includes(e));
    if (!hasAccess) return { valid: false, error: 'This promo code is not available for your family.' };
  }
  const discountLabel = promo.discountType === 'percent' ? `${promo.discountValue}% off` : `RM ${(promo.discountValue / 100).toFixed(2)} off`;
  return {
    valid: true,
    code: upper,
    discount: promo.discountType === 'percent' ? promo.discountValue : 0,
    label: promo.description || discountLabel,
    type: promo.discountType,
    amountSen: promo.discountType === 'fixed' ? promo.discountValue : 0,
  };
}

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Please try again in a few minutes.' },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120, // ToyyibPay may retry callbacks
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many callbacks.' },
});

/** Unique external reference — what ToyyibPay calls order_id / billExternalReferenceNo. */
function newOrderId() {
  return `HLY${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/** Grant Pro for a paid order. Idempotent: a paid order is never re-granted. */
async function finalizePayment(order, billCode, refno) {
  if (order.status === 'paid') return;
  const { PromoCodeUsage } = require('../models');
  const family = await Family.findById(order.familyId);
  if (!family) return;
  await pro.grantPro(family, order.plan);
  order.status = 'paid';
  if (billCode) order.billCode = billCode;
  order.toyyibRefno = refno || order.toyyibRefno;
  order.paidAt = new Date();
  await order.save();
  // Record promo code usage so it can't be reused by the same family.
  const promoCode = order.raw?.promoCode;
  if (promoCode) {
    await PromoCodeUsage.findOneAndUpdate(
      { familyId: order.familyId, code: promoCode },
      { familyId: order.familyId, code: promoCode, orderId: order.orderId, usedAt: new Date() },
      { upsert: true, new: true }
    ).catch(() => {});
    // Increment the promo's usage counter
    await PromoCode.findOneAndUpdate({ code: promoCode }, { $inc: { currentUses: 1 } }).catch(() => {});
  }
}

/** Map ToyyibPay error messages to user-friendly text. */
function humanizeToyyibError(rawMessage) {
  const msg = String(rawMessage || '').toLowerCase();
  if (msg.includes('key-did-not-exist') || msg.includes('key-did-not-match')) {
    return 'Payment gateway credentials are misconfigured. Please contact support.';
  }
  if (msg.includes('did not return a billcode')) {
    return 'The payment gateway could not create a bill. Please try again later.';
  }
  if (msg.includes('could not reach toyyibpay') || msg.includes('check the server network')) {
    return 'Could not reach the payment gateway. Check your internet connection and try again.';
  }
  if (msg.includes('returned http')) {
    return 'The payment gateway returned an error. Please try again later.';
  }
  // Fallback — still better than a generic 500 message
  return 'Payment service is temporarily unavailable. Please try again later.';
}

/** GET /api/pro/status — the family's Pro state + plans (any logged-in member). */
router.get(
  '/status',
  requireAuth,
  ah(async (req, res) => {
    const family = await getFamily(req);
    res.json(pro.proStatus(family));
  })
);

/** POST /api/pro/validate-promo — check if a promo code is valid for this family. */
router.post(
  '/validate-promo',
  requireAuth,
  ah(async (req, res) => {
    const code = String((req.body || {}).code || '').trim();
    const plan = String((req.body || {}).plan || '');
    if (!code) return res.status(400).json({ error: 'Enter a promo code.' });
    const family = await getFamily(req);
    const result = await validatePromo(code, family._id);
    if (!result.valid) return res.status(400).json({ error: result.error });
    // If a plan is provided, calculate the discounted price
    if (plan && pro.PLANS[plan]) {
      const originalPrice = pro.PLANS[plan].priceSen;
      const discountSen = result.type === 'fixed' ? Math.min(result.amountSen, originalPrice) : Math.round(originalPrice * result.discount / 100);
      const finalPrice = Math.max(0, originalPrice - discountSen);
      return res.json({ valid: true, code: result.code, discount: result.discount, label: result.label, type: result.type, amountSen: result.amountSen, originalPrice, discountSen, finalPrice });
    }
    // No plan — just confirm the code is valid
    res.json({ valid: true, code: result.code, discount: result.discount, label: result.label, type: result.type, amountSen: result.amountSen });
  })
);

/**
 * POST /api/pro/checkout — create a ToyyibPay bill.
 * Body: { plan: 'monthly' | 'yearly' | 'lifetime', promoCode?: string }
 * → { orderId, billCode, paymentUrl, plan, amountSen }
 * The app opens paymentUrl (Capacitor Browser on the phone / new tab on web).
 */
router.post(
  '/checkout',
  requireAuth,
  checkoutLimiter,
  ah(async (req, res) => {
    const plan = String((req.body || {}).plan || '');
    const promoCode = String((req.body || {}).promoCode || '').trim();
    if (!pro.PLANS[plan]) return res.status(400).json({ error: 'Invalid plan selected.' });

    const family = await getFamily(req);
    const p = pro.PLANS[plan];
    let finalAmount = p.priceSen;
    let promoInfo = null;

    // Validate promo code if provided
    if (promoCode) {
      const promo = await validatePromo(promoCode, family._id);
      if (!promo.valid) return res.status(400).json({ error: promo.error });
      const discountSen = promo.type === 'fixed' ? Math.min(promo.amountSen, finalAmount) : Math.round(finalAmount * promo.discount / 100);
      finalAmount = Math.max(0, finalAmount - discountSen);
      promoInfo = { code: promo.code, discount: promo.discount, label: promo.label, type: promo.type, amountSen: promo.amountSen, discountSen };
    }

    // --- 100% discount = free Pro (no ToyyibPay needed) ---
    if (finalAmount === 0) {
      const { PromoCodeUsage, Family } = require('../models');
      const orderId = newOrderId();
      await ProOrder.create({
        orderId,
        familyId: family._id,
        plan,
        amountSen: 0,
        status: 'paid',
        billCode: 'PROMO',
        paidAt: new Date(),
      });
      await PromoCodeUsage.create({ familyId: family._id, code: promoInfo.code, orderId });
      // getFamily returns a lean object — need a Mongoose doc for grantPro's .save()
      const familyDoc = await Family.findById(family._id);
      await pro.grantPro(familyDoc, plan);
      return res.json({ orderId, billCode: 'PROMO', paymentUrl: '/pro?promo=1', plan, amountSen: 0, promo: promoInfo, free: true });
    }

    // --- DEV MODE: ToyyibPay not configured but ALLOW_DEV_PAYMENT=1 -----------
    if (!toyyib.configured() && isDevPayment()) {
      const { PromoCodeUsage } = require('../models');
      const orderId = newOrderId();
      await ProOrder.create({
        orderId,
        familyId: family._id,
        plan,
        amountSen: finalAmount,
        status: 'paid',
        billCode: 'DEVBILL',
        paidAt: new Date(),
      });
      if (promoInfo) await PromoCodeUsage.create({ familyId: family._id, code: promoInfo.code, orderId });
      const { Family: FamModel } = require('../models');
      const famDoc = await FamModel.findById(family._id);
      await pro.grantPro(famDoc, plan);
      return res.json({ orderId, billCode: 'DEVBILL', paymentUrl: '/pro?dev=1', plan, amountSen: finalAmount, promo: promoInfo, dev: true });
    }

    if (!toyyib.configured()) {
      return res.status(503).json({
        error: 'Payments are not set up on the server yet. Please try again soon.',
        code: 'PAYMENTS_NOT_CONFIGURED',
      });
    }

    const orderId = newOrderId();
    const order = await ProOrder.create({
      orderId,
      familyId: family._id,
      plan,
      amountSen: finalAmount,
      status: 'pending',
      raw: promoInfo ? { promoCode: promoInfo.code, discount: promoInfo.discount } : {},
    });
    const callbackUrl =
      process.env.TOYYIBPAY_CALLBACK_URL || `https://${req.get('host')}/api/pro/webhook`;

    const origin = req.get('origin') || req.get('referer') || '';
    const originMatch = origin.match(/https?:\/\/[^/]+/);
    const returnUrl = (originMatch ? `${originMatch[0]}/pro` : '')
      || process.env.TOYYIBPAY_RETURN_URL
      || 'http://localhost:5174/pro';

    let billCode, paymentUrl;
    try {
      ({ billCode, paymentUrl } = await toyyib.createBill({
        orderId,
        name: `Housley Pro (${p.name})`,
        description: `Housley Pro ${p.name} for the whole family`,
        amountSen: finalAmount,
        email: req.user.email || '',
        callbackUrl,
        returnUrl,
      }));
    } catch (e) {
      // Mark the order as failed so it doesn't pile up as a ghost pending order.
      order.status = 'failed';
      await order.save();
      const status = e.status || 502;
      const err = new Error(humanizeToyyibError(e.message));
      err.status = status;
      throw err;
    }
    order.billCode = billCode;
    await order.save();
    res.json({ orderId, billCode, paymentUrl, plan, amountSen: p.priceSen });
  })
);

/** POST /api/pro/webhook — ToyyibPay server callback (form-encoded, NO auth —
 * it is authenticated by the MD5 hash instead). ToyyibPay cannot reach
 * localhost, so this only fires once the backend is on Render.
 */
router.post(
  '/webhook',
  webhookLimiter,
  ah(async (req, res) => {
    const b = req.body || {};
    const status = String(b.status || '');
    const orderId = String(b.order_id || '');
    const refno = String(b.refno || '');
    const billcode = String(b.billcode || '');
    const hash = String(b.hash || '');

    if (!orderId || !refno || !status) return res.status(400).json({ error: 'Missing callback fields.' });
    if (!toyyib.verifyCallbackHash({ hash, status, orderId, refno })) {
      return res.status(400).json({ error: 'Invalid callback signature.' });
    }

    const order = await ProOrder.findOne({ orderId });
    if (!order) return res.status(404).json({ error: 'Unknown order.' });
    order.raw = b;

    if (status === '1') {
      // Success — re-verify server-to-server so a forged callback can't work.
      let verified = false;
      if (toyyib.configured()) {
        try {
          const txn = await toyyib.getBillTransactions(billcode);
          const paid = String(txn?.billpaymentStatus || '') === '1';
          const amt = Math.round(Number(txn?.billpaymentAmount || 0) * 100);
          verified = paid && amt === order.amountSen;
        } catch {
          verified = false;
        }
        if (!verified) {
          order.status = 'failed';
          await order.save();
          return res.status(400).json({ error: 'Payment could not be verified with ToyyibPay.' });
        }
      }
      await finalizePayment(order, billcode, refno);
    } else if (status === '3') {
      order.status = 'failed';
      await order.save();
    }
    // status 2 (pending) — leave as pending; the payer may still complete it.
    res.json({ ok: true });
  })
);

/** GET /api/pro/bill-status?billCode=… — poll a bill after the payer returns.
 * If the order is still pending AND the gateway is reachable, verify the
 * payment server-to-server so Pro activates even when the webhook never
 * fired (e.g. on localhost where ToyyibPay can't reach us).
 */
router.get(
  '/bill-status',
  requireAuth,
  ah(async (req, res) => {
    const billCode = String(req.query.billCode || '');
    if (!billCode) return res.status(400).json({ error: 'billCode is required.' });
    const order = await ProOrder.findOne({ billCode, familyId: req.user.familyId });
    if (!order) return res.status(404).json({ error: 'Bill not found for this family.' });

    // If still pending, try to verify with ToyyibPay right now.
    if (order.status === 'pending' && toyyib.configured()) {
      try {
        const txn = await toyyib.getBillTransactions(billCode);
        if (txn && txn.billpaymentStatus !== undefined && txn.billpaymentStatus !== null) {
          const paid = String(txn.billpaymentStatus) === '1';
          const amt = Math.round(Number(txn.billpaymentAmount || 0) * 100);
          if (paid && amt === order.amountSen) {
            await finalizePayment(order, billCode, txn.billpaymentRefNo || '');
          } else if (String(txn.billpaymentStatus) === '3') {
            // ToyyibPay confirmed the payment failed/cancelled — mark it so it never activates.
            order.status = 'failed';
            await order.save();
          }
        }
        // If txn is null/empty, ToyyibPay has no record yet — keep polling.
      } catch {
        /* gateway unreachable or no data yet — keep polling */
      }
    }

    res.json({ orderId: order.orderId, status: order.status, plan: order.plan, amountSen: order.amountSen, paidAt: order.paidAt });
  })
);

/** POST /api/pro/dev-order — DEV-ONLY: create a pending order (no gateway needed). */
router.post(
  '/dev-order',
  requireAuth,
  ah(async (req, res) => {
    if (!isDevPayment()) return res.status(404).json({ error: 'Not found.' });
    const plan = String((req.body || {}).plan || '');
    if (!pro.PLANS[plan]) return res.status(400).json({ error: 'Pick a plan: monthly, yearly or lifetime.' });
    const order = await ProOrder.create({
      orderId: newOrderId(),
      familyId: req.user.familyId,
      plan,
      amountSen: pro.PLANS[plan].priceSen,
      status: 'pending',
      billCode: 'DEVBILL',
    });
    res.status(201).json({ orderId: order.orderId, plan, amountSen: order.amountSen });
  })
);

/** POST /api/pro/dev-complete — DEV-ONLY payment simulator (ALLOW_DEV_PAYMENT=1). */
router.post(
  '/dev-complete',
  requireAuth,
  ah(async (req, res) => {
    if (!isDevPayment()) return res.status(404).json({ error: 'Not found.' });
    const { orderId } = req.body || {};
    const order = await ProOrder.findOne({ orderId, familyId: req.user.familyId });
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    await finalizePayment(order, order.billCode || 'DEV', `DEV-${Date.now()}`);
    res.json({ ok: true, status: pro.proStatus(await Family.findById(order.familyId)) });
  })
);

/** POST /api/pro/dev-clear — DEV-ONLY: drop Pro + trial so the paywall can be tested. */
router.post(
  '/dev-clear',
  requireAuth,
  ah(async (req, res) => {
    if (!isDevPayment()) return res.status(404).json({ error: 'Not found.' });
    const family = await Family.findById(req.user.familyId);
    family.proTier = 'none';
    family.proExpiresAt = null;
    family.proPurchasedAt = null;
    family.trialEndsAt = new Date(Date.now() - 1000); // expire the trial
    await family.save();
    await ProOrder.updateMany({ familyId: family._id, status: 'pending' }, { status: 'failed' });
    res.json({ ok: true, status: pro.proStatus(family) });
  })
);

module.exports = router;
