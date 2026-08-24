/**
 * Housley — Resend email service
 * Sends transactional emails (password reset codes, welcome emails).
 *
 * Environment variables:
 *   RESEND_API_KEY  — Resend API key (re_xxxx)
 *   RESEND_FROM     — sender email (must be from verified domain, e.g. "noreply@housley.app")
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'noreply@housley.app';
const RESEND_BASE = 'https://api.resend.com';

/** Check if Resend is configured. */
function isConfigured() {
  return Boolean(RESEND_API_KEY);
}

/**
 * Send a transactional email via Resend.
 * @param {object} opts
 * @param {string} opts.to — recipient email
 * @param {string} opts.subject — email subject
 * @param {string} opts.html — HTML body
 */
async function sendEmail({ to, subject, html }) {
  if (!isConfigured()) {
    console.log(`📧 [DEV] Email to ${to}: ${subject}`);
    return { ok: true, dev: true };
  }

  try {
    const resp = await fetch(`${RESEND_BASE}/emails`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject,
        html,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('📧 Resend error:', resp.status, data);
      return { ok: false, error: data.message || `HTTP ${resp.status}` };
    }

    console.log(`📧 Email sent to ${to}: ${subject} (id: ${data.id})`);
    return { ok: true, id: data.id };
  } catch (err) {
    console.error('📧 Resend failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Send a password reset email with a 6-digit code.
 * @param {string} to — recipient email
 * @param {string} code — 6-digit numeric code
 * @param {string} familyName — the family name for personalization
 */
async function sendPasswordReset(to, code, familyName) {
  if (!isConfigured()) {
    console.log(`📧 [DEV] Password reset code for ${to}: ${code}`);
    return { ok: true, dev: true };
  }

  return sendEmail({
    to,
    subject: 'Housley — Reset your password',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin:0;padding:0;background:#fdf6f0;font-family:Arial,sans-serif;">
        <div style="max-width:400px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
          <div style="background:linear-gradient(135deg,#ff9a9e,#fad0c4);padding:24px;text-align:center;">
            <div style="font-size:32px;">🏡</div>
            <h1 style="color:#fff;margin:8px 0 0;font-size:20px;">Housley</h1>
          </div>
          <div style="padding:24px;text-align:center;">
            <h2 style="color:#333;font-size:18px;margin-bottom:8px;">Password Reset</h2>
            <p style="color:#666;font-size:14px;margin-bottom:20px;">Hi! We received a request to reset the password for <b>${familyName}</b>.</p>
            <div style="background:#f8f4ef;border-radius:12px;padding:16px;margin-bottom:20px;">
              <div style="color:#999;font-size:12px;text-transform:uppercase;letter-spacing:1;margin-bottom:4px;">Your 6-digit code</div>
              <div style="font-size:32px;font-weight:800;color:#ff6f91;letter-spacing:6px;font-family:'Courier New',monospace;">${code}</div>
            </div>
            <p style="color:#999;font-size:12px;">This code expires in <b>15 minutes</b>. If you didn't request this, ignore this email.</p>
          </div>
          <div style="background:#f8f4ef;padding:12px;text-align:center;">
            <p style="color:#bbb;font-size:11px;margin:0;">Housley — Family Money Management 🏡</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
}

/**
 * Send a welcome email to a new user.
 * @param {string} to — recipient email
 * @param {string} name — user's name
 * @param {string} familyName — the family name
 */
async function sendWelcome(to, name, familyName) {
  if (!isConfigured()) {
    console.log(`📧 [DEV] Welcome email for ${to} → family "${familyName}"`);
    return { ok: true, dev: true };
  }

  return sendEmail({
    to,
    subject: `Welcome to Housley, ${name}! 🏡`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin:0;padding:0;background:#fdf6f0;font-family:Arial,sans-serif;">
        <div style="max-width:400px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
          <div style="background:linear-gradient(135deg,#ff9a9e,#fad0c4);padding:24px;text-align:center;">
            <div style="font-size:32px;">🏡</div>
            <h1 style="color:#fff;margin:8px 0 0;font-size:20px;">Housley</h1>
          </div>
          <div style="padding:24px;text-align:center;">
            <h2 style="color:#333;font-size:18px;margin-bottom:8px;">Welcome, ${name}!</h2>
            <p style="color:#666;font-size:14px;margin-bottom:20px;">You've joined <b>${familyName}</b> on Housley. Start tracking your family's finances together! 🎉</p>
            <p style="color:#999;font-size:12px;">Download the app and log in with your email to get started.</p>
          </div>
          <div style="background:#f8f4ef;padding:12px;text-align:center;">
            <p style="color:#bbb;font-size:11px;margin:0;">Housley — Family Money Management 🏡</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
}

/**
 * Send an email verification code (register or join).
 * @param {string} to — recipient email
 * @param {string} code — 6-digit numeric code
 * @param {string} purpose — 'register' or 'join'
 */
async function sendVerificationCode(to, code, purpose) {
  const actionLabel = purpose === 'join' ? 'join a family' : 'create your account';

  if (!isConfigured()) {
    console.log(`📧 [DEV] Email verification code for ${to} (${purpose}): ${code}`);
    return { ok: true, dev: true };
  }

  return sendEmail({
    to,
    subject: 'Housley — Verify your email',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin:0;padding:0;background:#fdf6f0;font-family:Arial,sans-serif;">
        <div style="max-width:400px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
          <div style="background:linear-gradient(135deg,#ff9a9e,#fad0c4);padding:24px;text-align:center;">
            <div style="font-size:32px;">🏡</div>
            <h1 style="color:#fff;margin:8px 0 0;font-size:20px;">Housley</h1>
          </div>
          <div style="padding:24px;text-align:center;">
            <h2 style="color:#333;font-size:18px;margin-bottom:8px;">Verify Your Email</h2>
            <p style="color:#666;font-size:14px;margin-bottom:20px;">Use the code below to ${actionLabel}.</p>
            <div style="background:#f8f4ef;border-radius:12px;padding:16px;margin-bottom:20px;">
              <div style="color:#999;font-size:12px;text-transform:uppercase;letter-spacing:1;margin-bottom:4px;">Your 6-digit code</div>
              <div style="font-size:32px;font-weight:800;color:#ff6f91;letter-spacing:6px;font-family:'Courier New',monospace;">${code}</div>
            </div>
            <p style="color:#999;font-size:12px;">This code expires in <b>15 minutes</b>. If you didn't request this, ignore this email.</p>
          </div>
          <div style="background:#f8f4ef;padding:12px;text-align:center;">
            <p style="color:#bbb;font-size:11px;margin:0;">Housley — Family Money Management 🏡</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
}

module.exports = { isConfigured, sendEmail, sendPasswordReset, sendWelcome, sendVerificationCode };
