import crypto from 'node:crypto';

// Short-lived token so the browser can open the WebSocket DIRECTLY on the API host.
// (Vercel/Netlify rewrites cannot proxy WebSockets, and the session cookie belongs to the
// frontend domain, so it is not sent cross-site.) The token is fetched through the normal
// cookie-authenticated REST API, kept only in memory on the client, and valid for 10 minutes
// - it is only checked at the socket handshake.
const TTL_MS = 10 * 60 * 1000;
const sign = body => crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`socket:${body}`).digest('base64url');

export function signSocketToken(userId) {
  const body = `${userId}.${Date.now() + TTL_MS}`;
  return `${body}.${sign(body)}`;
}

export function verifySocketToken(token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const [userId, exp, sig] = token.split('.');
  if (!userId || !exp || !sig || Number(exp) < Date.now()) return null;
  const good = sign(`${userId}.${exp}`);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return userId;
}
