/**
 * Housley (public) — ToyyibPay payment gateway client.
 *
 * Docs: https://toyyibpay.com/apireference/
 * Sandbox: register at https://dev.toyyibpay.com and swap the base URL.
 *
 * Security notes (see Note/10-toyyibpay-guide.md):
 *  - The server NEVER trusts the callback alone. The MD5 hash is verified
 *    first, then the payment is re-checked server-to-server with
 *    getBillTransactions before Pro is granted.
 *  - No card data ever touches this server — ToyyibPay handles PCI.
 */

const crypto = require('crypto');

const BASE = (process.env.TOYYIBPAY_BASE_URL || 'https://dev.toyyibpay.com/index.php/api').replace(/\/+$/, '');
const SECRET = process.env.TOYYIBPAY_USER_SECRET_KEY || '';
const CATEGORY = process.env.TOYYIBPAY_CATEGORY_CODE || '';

/** The gateway is ready when both the secret key and a category are set. */
const configured = () => Boolean(SECRET && CATEGORY);

/** Host part of the base URL — used to build the payer-facing payment page. */
const host = () => BASE.replace(/\/index\.php\/api\/?$/, '');

/** POST form-encoded to a ToyyibPay API endpoint and return parsed JSON. */
async function apiPost(endpoint, params) {
  const body = new URLSearchParams(params);
  let res;
  try {
    res = await fetch(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (e) {
    const err = new Error('Could not reach ToyyibPay. Check the server network.');
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`ToyyibPay ${endpoint} returned HTTP ${res.status}.`);
    err.status = 502;
    throw err;
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // ToyyibPay sometimes answers with plain text (e.g. "KEY-DID-NOT-MATCH").
    const err = new Error(`ToyyibPay said: ${String(text).trim().slice(0, 160) || `(empty reply from ${endpoint})`}`);
    err.status = 502;
    throw err;
  }
}

/**
 * Create a fixed-amount bill.
 * amountSen is the price in SEN (RM 4.90 → 490).
 * Returns { billCode, paymentUrl }.
 */
async function createBill({ orderId, name, description, amountSen, email, callbackUrl, returnUrl }) {
  if (!configured()) {
    const err = new Error('ToyyibPay is not configured on the server yet.');
    err.status = 503;
    throw err;
  }
  const data = await apiPost('createBill', {
    userSecretKey: SECRET,
    categoryCode: CATEGORY,
    billName: String(name).replace(/[^a-zA-Z0-9 _]/g, '').slice(0, 30),
    billDescription: String(description).replace(/[^a-zA-Z0-9 _]/g, '').slice(0, 100),
    billPriceSetting: 1, // fixed amount
    billPayorInfo: 0, // no payer form needed
    billAmount: String(Math.round(amountSen)),
    billReturnUrl: returnUrl || process.env.TOYYIBPAY_RETURN_URL || 'http://localhost:5174/pro',
    billCallbackUrl: callbackUrl,
    billExternalReferenceNo: orderId,
    billTo: 'Housley Family',
    billEmail: String(email || ''),
    billPhone: '',
    billSplitPayment: 0,
    billPaymentChannel: 2, // FPX + Credit Card
    billChargeToCustomer: 1,
    billExpiryDays: 7,
  });
  const billCode = Array.isArray(data) ? data[0]?.BillCode : null;
  if (!billCode) {
    const err = new Error('ToyyibPay did not return a BillCode.');
    err.status = 502;
    throw err;
  }
  return { billCode, paymentUrl: `${host()}/${billCode}` };
}

/** Fetch the payment state of a bill, server-to-server. */
async function getBillTransactions(billCode) {
  if (!configured()) return null;
  const data = await apiPost('getBillTransactions', {
    userSecretKey: SECRET,
    billCode,
  });
  return Array.isArray(data) && data.length ? data[0] : null;
}

/**
 * Verify the callback hash ToyyibPay sends:
 *   MD5(userSecretKey + status + order_id + refno + "ok")
 * Must match BEFORE anything is processed.
 */
function verifyCallbackHash({ hash, status, orderId, refno }) {
  if (!SECRET || !hash || !status || !orderId || !refno) return false;
  const expected = crypto
    .createHash('md5')
    .update(`${SECRET}${String(status)}${String(orderId)}${String(refno)}ok`)
    .digest('hex');
  return expected === String(hash).toLowerCase();
}

module.exports = { configured, createBill, getBillTransactions, verifyCallbackHash, host, BASE };
