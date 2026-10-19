import mongoose from 'mongoose';
import { Profile, ConnectRequest, ChatMessage } from './models.js';
import { emitToUser } from './hub.js';
import { notifyNewMessage } from './notify.js';

const httpErr = (status, message) => Object.assign(new Error(message), { status });

// Tiny in-memory caches so a message costs ONE database write instead of ~6 queries.
// Connections can't be undone in this app, so a positive "connected" answer stays valid.
const CONNECTED_TTL = 10 * 60 * 1000, PROFILE_TTL = 5 * 60 * 1000;
const connectedCache = new Map(); // `${me}:${profileId}` -> { userId, exp }
const profileCache = new Map();   // userId -> { id, name, exp }

async function connectedUserId(me, profileId) {
  if (!mongoose.isValidObjectId(profileId)) throw httpErr(404, 'Profile nahi mila.');
  const key = `${me}:${profileId}`;
  const hit = connectedCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.userId;

  const other = await Profile.findById(profileId);
  if (!other) throw httpErr(404, 'Profile nahi mila.');
  const ok = await ConnectRequest.exists({
    status: 'accepted',
    $or: [{ fromUserId: me, toUserId: other.userId }, { fromUserId: other.userId, toUserId: me }],
  });
  if (!ok) throw httpErr(403, 'Message karne ke liye pehle request accept honi chahiye.');
  connectedCache.set(key, { userId: String(other.userId), exp: Date.now() + CONNECTED_TTL });
  return String(other.userId);
}

async function myProfile(me) {
  const hit = profileCache.get(String(me));
  if (hit && hit.exp > Date.now()) return hit;
  const p = await Profile.findOne({ userId: me });
  if (!p) return null;
  const v = { id: p.id, name: p.name, exp: Date.now() + PROFILE_TTL };
  profileCache.set(String(me), v);
  return v;
}

const view = (m, mine) => ({ id: m.id, text: m.text, mine, createdAt: m.createdAt });

// One code path for both Socket.IO ("chat:send") and the REST fallback.
// `cid` is a client-generated id: it makes retries safe (no duplicate messages) and lets the
// sender swap its optimistic bubble for the saved message.
export async function sendChatMessage({ me, profileId, text, cid }) {
  text = String(text || '').trim();
  if (!text || text.length > 1000) throw httpErr(400, 'Message 1 se 1000 characters ka hona chahiye.');
  cid = typeof cid === 'string' && cid.length <= 64 ? cid : undefined;

  const [otherId, mine] = await Promise.all([connectedUserId(me, profileId), myProfile(me)]);

  let m, duplicate = false;
  try {
    m = await ChatMessage.create({ fromUserId: me, toUserId: otherId, text, cid });
  } catch (e) {
    if (e.code !== 11000 || !cid) throw e;
    m = await ChatMessage.findOne({ fromUserId: me, cid }); // retry of a message we already saved
    duplicate = true;
    if (!m) throw e;
  }

  if (!duplicate) {
    // Receiver gets it the moment it is saved; the sender's own tabs get the confirmed copy too.
    if (mine) notifyNewMessage(otherId, mine, view(m, false), me).catch(e => console.error('Notify failed:', e.message));
    emitToUser(me, 'message:sync', { profileId, message: { ...view(m, true), cid } });
  }
  return { ...view(m, true), cid };
}
