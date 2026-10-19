import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { Profile, ConnectRequest } from './models.js';
import { setIo, isOnline, emitToUser, markConnected, markDisconnected } from './hub.js';
import { sendChatMessage } from './chat.js';
import { verifySocketToken } from './socketToken.js';

export { isOnline, emitToUser }; // kept so older imports keep working

async function friendIds(userId) {
  const links = await ConnectRequest.find({ status: 'accepted', $or: [{ fromUserId: userId }, { toUserId: userId }] });
  return links.map(l => (String(l.fromUserId) === String(userId) ? String(l.toUserId) : String(l.fromUserId)));
}

async function broadcastPresence(userId, profileId, isOn) {
  for (const f of await friendIds(userId)) emitToUser(f, 'presence', { profileId, online: isOn });
}

// userId of the other person, only if our request was accepted.
async function connectedUserId(me, profileId) {
  if (!mongoose.isValidObjectId(profileId)) return null;
  const other = await Profile.findById(profileId);
  if (!other) return null;
  const ok = await ConnectRequest.exists({
    status: 'accepted',
    $or: [{ fromUserId: me, toUserId: other.userId }, { fromUserId: other.userId, toUserId: me }],
  });
  return ok ? other.userId : null;
}

// Browsers must be allowed to open the socket straight on the API host (different origin).
const allowedOrigins = () =>
  [process.env.APP_URL, ...(process.env.CORS_ORIGINS || '').split(',')]
    .map(o => (o || '').trim().replace(/\/$/, '')).filter(Boolean);

export function initRealtime(httpServer, sessionMiddleware) {
  const io = new Server(httpServer, {
    cors: { origin: (origin, cb) => cb(null, !origin || allowedOrigins().includes(origin)), methods: ['GET', 'POST'] },
    pingInterval: 10_000,   // dead connections (phone sleep, network switch) are noticed in ~15s, not ~45s
    pingTimeout: 8_000,
    maxHttpBufferSize: 16 * 1024,
  });
  setIo(io);
  io.engine.use(sessionMiddleware); // same-origin setups (dev proxy / single-origin prod) can still use the cookie

  io.use((socket, next) => {
    const uid = verifySocketToken(socket.handshake.auth?.token) || socket.request.session?.userId;
    if (!uid) return next(new Error('unauthorized'));
    socket.data.userId = String(uid);
    next();
  });

  io.on('connection', async socket => {
    const uid = socket.data.userId;
    socket.join(`u:${uid}`);
    const first = markConnected(uid);

    try {
      const mine = await Profile.findOne({ userId: uid });
      socket.data.profileId = mine?.id;
      if (first && mine) await broadcastPresence(uid, mine.id, true);
    } catch (e) { console.error('Presence error:', e.message); }

    // Client uses this to check a connection is really alive after the app was in the background.
    socket.on('ping:check', ack => { if (typeof ack === 'function') ack(); });

    socket.on('presence:get', async (profileId, ack) => {
      if (typeof ack !== 'function') return;
      try { const other = await connectedUserId(uid, profileId); ack(Boolean(other && isOnline(other))); }
      catch { ack(false); }
    });

    socket.on('typing', async profileId => {
      if (!socket.data.profileId) return;
      try {
        const other = await connectedUserId(uid, profileId);
        if (other) emitToUser(other, 'typing', { profileId: socket.data.profileId });
      } catch { /* ignore */ }
    });

    // Send a chat message over the socket: no HTTP round trip, no session/user lookup per message.
    const sentAt = [];
    socket.on('chat:send', async (payload, ack) => {
      if (typeof ack !== 'function') return;
      const now = Date.now();
      while (sentAt.length && now - sentAt[0] > 10_000) sentAt.shift();
      if (sentAt.length >= 20) return ack({ ok: false, error: 'Thoda dheere, bahut zyada messages.' });
      sentAt.push(now);
      try {
        const { profileId, text, cid } = payload || {};
        ack({ ok: true, message: await sendChatMessage({ me: uid, profileId, text, cid }) });
      } catch (e) {
        if (!e.status) console.error('chat:send failed:', e.message);
        ack({ ok: false, error: e.status ? e.message : 'Message nahi ja paya.' });
      }
    });

    socket.on('disconnect', () => {
      if (markDisconnected(uid) && socket.data.profileId) broadcastPresence(uid, socket.data.profileId, false).catch(() => {});
    });
  });
}
