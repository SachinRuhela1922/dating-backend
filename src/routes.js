import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { User, Otp } from './models.js';
import { sendOtpMail } from './mail.js';

const COOLDOWN = 60, TTL_MS = 10 * 60 * 1000, MAX_ATTEMPTS = 5;
const MAX_AGE_MS = Number(process.env.SESSION_MAX_DAYS || 30) * 864e5;
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 12);

const httpErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const h = fn => (req, res, next) => fn(req, res, next).catch(next);
const normEmail = v => {
  const e = String(v || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 254) throw httpErr(400, 'Enter a valid email address.');
  return e;
};
const checkPassword = p => {
  if (typeof p !== 'string' || p.length < 8) throw httpErr(400, 'Password must be at least 8 characters.');
  if (p.length > 72) throw httpErr(400, 'Password must be 72 characters or fewer.');
  return p;
};
const hashCode = (email, code) => crypto.createHmac('sha256', process.env.OTP_SECRET).update(`${email}:${code}`).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const publicUser = u => ({ id: u.id, email: u.email, emailVerified: u.emailVerified, createdAt: u.createdAt });

async function issueOtp(email, purpose, extra = {}) {
  const existing = await Otp.findOne({ email, purpose });
  const wait = existing ? Math.ceil(COOLDOWN - (Date.now() - existing.lastSentAt) / 1000) : 0;
  if (wait > 0) throw httpErr(429, `Please wait ${wait}s before requesting another code.`, { retryAfter: wait });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await Otp.findOneAndUpdate({ email, purpose },
    { codeHash: hashCode(email, code), attempts: 0, lastSentAt: new Date(), expiresAt: new Date(Date.now() + TTL_MS), ...extra },
    { upsert: true });
  try { await sendOtpMail(email, code, purpose); }
  catch (e) { console.error('Email send failed:', e.message); await Otp.deleteOne({ email, purpose }); throw httpErr(502, 'We couldn’t send the email. Try again shortly.'); }
}

async function checkOtp(email, purpose, code) {
  const d = await Otp.findOne({ email, purpose });
  if (!d) throw httpErr(400, 'No active code for this email. Request a new one.');
  if (d.expiresAt < new Date()) { await d.deleteOne(); throw httpErr(410, 'This code has expired. Request a new one.'); }
  if (d.attempts >= MAX_ATTEMPTS) { await d.deleteOne(); throw httpErr(429, 'Too many incorrect attempts. Request a new code.'); }
  if (!/^\d{6}$/.test(String(code || '')) || !safeEq(d.codeHash, hashCode(email, String(code)))) {
    d.attempts += 1; await d.save();
    throw httpErr(400, 'Incorrect code. Check the email and try again.');
  }
  return d;
}

// Regenerate the session ID on login (prevents session fixation).
const startSession = (req, user) => new Promise((resolve, reject) =>
  req.session.regenerate(err => {
    if (err) return reject(err);
    req.session.userId = user.id;
    req.session.createdAt = Date.now();
    req.session.save(e => (e ? reject(e) : resolve()));
  }));

export const requireAuth = h(async (req, res, next) => {
  const s = req.session;
  if (!s?.userId) throw httpErr(401, 'Please sign in to continue.');
  if (Date.now() - (s.createdAt || 0) > MAX_AGE_MS) {
    await new Promise(r => s.destroy(r)); res.clearCookie('sid');
    throw httpErr(401, 'Your session has expired. Please sign in again.');
  }
  const user = await User.findById(s.userId);
  if (!user || !user.emailVerified) { await new Promise(r => s.destroy(r)); res.clearCookie('sid'); throw httpErr(401, 'Please sign in to continue.'); }
  req.user = user; next();
});

export const auth = Router();

auth.post('/signup', h(async (req, res) => {
  const email = normEmail(req.body.email), pw = checkPassword(req.body.password);
  if (await User.exists({ email })) throw httpErr(409, 'An account with this email already exists. Sign in instead.');
  await issueOtp(email, 'signup', { passwordHash: await bcrypt.hash(pw, 12) });
  res.json({ ok: true, cooldown: COOLDOWN });
}));

auth.post('/verify-signup', h(async (req, res) => {
  const email = normEmail(req.body.email);
  const d = await checkOtp(email, 'signup', req.body.code);
  let user;
  try { user = await User.create({ email, passwordHash: d.passwordHash, emailVerified: true }); }
  catch (e) { if (e.code === 11000) throw httpErr(409, 'An account with this email already exists. Sign in instead.'); throw e; }
  await d.deleteOne();
  await startSession(req, user);
  res.json({ user: publicUser(user) });
}));

auth.post('/resend', h(async (req, res) => {
  const email = normEmail(req.body.email), purpose = req.body.purpose;
  if (purpose === 'signup') {
    if (!(await Otp.exists({ email, purpose }))) throw httpErr(400, 'Start sign up again to get a code.');
    await issueOtp(email, 'signup');
  } else if (purpose === 'reset') {
    if (await User.exists({ email })) await issueOtp(email, 'reset'); // same response either way
  } else throw httpErr(400, 'Invalid request.');
  res.json({ ok: true, cooldown: COOLDOWN });
}));

auth.post('/login', h(async (req, res) => {
  const email = normEmail(req.body.email);
  const user = await User.findOne({ email });
  const ok = await bcrypt.compare(String(req.body.password || ''), user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) throw httpErr(401, 'Incorrect email or password.');
  if (!user.emailVerified) throw httpErr(403, 'Verify your email before signing in.');
  await startSession(req, user);
  res.json({ user: publicUser(user) });
}));

auth.post('/forgot-password', h(async (req, res) => {
  const email = normEmail(req.body.email);
  if (await User.exists({ email })) await issueOtp(email, 'reset');
  res.json({ ok: true, cooldown: COOLDOWN }); // never reveals whether the account exists
}));

auth.post('/reset-password', h(async (req, res) => {
  const email = normEmail(req.body.email), pw = checkPassword(req.body.password);
  const d = await checkOtp(email, 'reset', req.body.code);
  const user = await User.findOne({ email });
  if (!user) throw httpErr(400, 'No active code for this email. Request a new one.');
  user.passwordHash = await bcrypt.hash(pw, 12); await user.save(); await d.deleteOne();
  // Invalidate every existing session for this user.
  await mongoose.connection.collection('sessions').deleteMany({ 'session.userId': user.id });
  res.json({ ok: true });
}));

auth.post('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); });
});

auth.get('/me', requireAuth, (req, res) =>
  res.json({ user: publicUser(req.user), sessionExpiresAt: req.session.cookie.expires }));

export const dashboard = Router();
dashboard.use(requireAuth);
dashboard.get('/summary', (req, res) =>
  res.json({ user: publicUser(req.user), sessionExpiresAt: req.session.cookie.expires }));
