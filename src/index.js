import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auth, dashboard } from './routes.js';
import { profile } from './profile.js';
import { connect } from './connect.js';
import { initRealtime } from './realtime.js';

const missing = ['MONGODB_URI', 'SESSION_SECRET', 'OTP_SECRET', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM',
  'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']
  .filter(k => !process.env[k]);
if (missing.length) { console.error('Missing env vars:', missing.join(', '), '\nCopy server/.env.example to server/.env and fill it in.'); process.exit(1); }

const prod = process.env.NODE_ENV === 'production';
const idleMs = Number(process.env.SESSION_IDLE_DAYS || 7) * 864e5;
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

await mongoose.connect(process.env.MONGODB_URI);
const app = express();
if (prod) app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: { directives: {
  ...helmet.contentSecurityPolicy.getDefaultDirectives(),
  'style-src': ["'self'", 'https:', "'unsafe-inline'"], 'font-src': ["'self'", 'https:', 'data:'],
  'img-src': ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
} } }));
app.use(express.json({ limit: '10kb' }));

// Kept in a variable so Socket.IO can reuse the exact same session.
const sessionMiddleware = session({
  name: 'sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,                                   // idle timeout renews on activity
  store: MongoStore.create({ client: mongoose.connection.getClient(), stringify: false, ttl: idleMs / 1000 }),
  cookie: { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: idleMs },
});
app.use(sessionMiddleware);

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in a few minutes.' } });
app.use('/api/auth', (req, res, next) => (req.method === 'POST' ? limiter(req, res, next) : next()));
app.use('/api/auth', auth);
app.use('/api/dashboard', dashboard);
app.use('/api/profile', profile);
app.use('/api/connect', connect);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

if (prod) {
  app.use(express.static(dist));
  // dashboard.html is gated on the server: no valid session, no page.
  app.get('/dashboard.html', (req, res) =>
    req.session?.userId ? res.sendFile(path.join(dist, 'index.html')) : res.redirect('/'));
  app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong on our side.', retryAfter: err.retryAfter });
});

const port = process.env.PORT || 4000;
const server = http.createServer(app);
initRealtime(server, sessionMiddleware);
server.listen(port, () => console.log(`API on http://localhost:${port}${prod ? ' (serving client)' : ''}`));