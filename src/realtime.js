import { Server } from 'socket.io';
import mongoose from 'mongoose';
import { Profile, ConnectRequest } from './models.js';

let io;
const online = new Map(); // userId -> number of open sockets (several tabs possible)

export const isOnline = id => (online.get(String(id)) || 0) > 0;
export const emitToUser = (id, event, payload) => io?.to(`u:${id}`).emit(event, payload);

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

export function initRealtime(httpServer, sessionMiddleware) {
  io = new Server(httpServer);
  io.engine.use(sessionMiddleware); // same cookie session as the REST API

  io.use((socket, next) => {
    const uid = socket.request.session?.userId;
    if (!uid) return next(new Error('unauthorized'));
    socket.userId = String(uid);
    next();
  });

  io.on('connection', async socket => {
    const uid = socket.userId;
    socket.join(`u:${uid}`);
    const first = !isOnline(uid);
    online.set(uid, (online.get(uid) || 0) + 1);

    try {
      const mine = await Profile.findOne({ userId: uid });
      socket.profileId = mine?.id;
      if (first && socket.profileId) await broadcastPresence(uid, socket.profileId, true);
    } catch (e) { console.error('Presence error:', e.message); }

    socket.on('presence:get', async (profileId, ack) => {
      if (typeof ack !== 'function') return;
      try { const other = await connectedUserId(uid, profileId); ack(Boolean(other && isOnline(other))); }
      catch { ack(false); }
    });

    socket.on('typing', async profileId => {
      if (!socket.profileId) return;
      try {
        const other = await connectedUserId(uid, profileId);
        if (other) emitToUser(other, 'typing', { profileId: socket.profileId });
      } catch { /* ignore */ }
    });

    socket.on('disconnect', () => {
      const left = (online.get(uid) || 1) - 1;
      if (left > 0) return online.set(uid, left);
      online.delete(uid);
      if (socket.profileId) broadcastPresence(uid, socket.profileId, false).catch(() => {});
    });
  });
}