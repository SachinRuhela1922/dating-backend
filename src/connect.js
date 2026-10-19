import { Router } from 'express';
import mongoose from 'mongoose';
import { Profile, ConnectRequest, ChatMessage } from './models.js';
import { requireAuth } from './routes.js';
import { cardProfile } from './profile.js';
import { sendChatMessage } from './chat.js';
import { emitToUser } from './hub.js';

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const h = fn => (req, res, next) => fn(req, res, next).catch(next);
const same = (a, b) => String(a) === String(b);
const pair = (a, b) => ({ $or: [{ fromUserId: a, toUserId: b }, { fromUserId: b, toUserId: a }] });

async function connectedProfile(me, profileId) {
  if (!mongoose.isValidObjectId(profileId)) throw httpErr(404, 'Profile nahi mila.');
  const other = await Profile.findById(profileId);
  if (!other) throw httpErr(404, 'Profile nahi mila.');
  if (!(await ConnectRequest.exists({ status: 'accepted', ...pair(me, other.userId) })))
    throw httpErr(403, 'Message karne ke liye pehle request accept honi chahiye.');
  return other;
}

const markRead = (me, otherUserId) =>
  ChatMessage.updateMany({ fromUserId: otherUserId, toUserId: me, readAt: null }, { readAt: new Date() });

export const connect = Router();
connect.use(requireAuth);

// Requests other people sent to me.
connect.get('/requests', h(async (req, res) => {
  const reqs = await ConnectRequest.find({ toUserId: req.user._id, status: 'pending' }).sort({ createdAt: -1 });
  const profiles = await Profile.find({ userId: { $in: reqs.map(r => r.fromUserId) } });
  const byUser = new Map(profiles.map(p => [String(p.userId), p]));
  res.json({
    requests: reqs.filter(r => byUser.has(String(r.fromUserId))).map(r => ({
      id: r.id, note: r.note, createdAt: r.createdAt, profile: cardProfile(byUser.get(String(r.fromUserId))),
    })),
  });
}));

const respond = status => h(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw httpErr(404, 'Request nahi mili.');
  const r = await ConnectRequest.findOneAndUpdate(
    { _id: req.params.id, toUserId: req.user._id, status: 'pending' }, { status }, { new: true });
  if (!r) throw httpErr(404, 'Request nahi mili ya pehle hi respond ho chuki hai.');
  const [p, mine] = await Promise.all([Profile.findOne({ userId: r.fromUserId }), Profile.findOne({ userId: req.user._id })]);
  // Live updates: my other tabs/badges drop the request; the sender sees the new connection instantly.
  emitToUser(req.user._id, 'request:removed', { id: r.id });
  if (status === 'accepted' && mine) emitToUser(r.fromUserId, 'request:accepted', { profileId: mine.id, profile: cardProfile(mine) });
  res.json({ ok: true, profileId: p?.id, profile: p ? cardProfile(p) : undefined });
});
connect.post('/requests/:id/accept', respond('accepted'));
connect.post('/requests/:id/decline', respond('declined'));

// Total unread messages (for the badge).
connect.get('/unread', h(async (req, res) => {
  res.json({ count: await ChatMessage.countDocuments({ toUserId: req.user._id, readAt: null }) });
}));

// Accepted connections = the Messages list, with unread count per chat.
// 1 query for links, 1 for profiles, 1 grouped query for unread, and the last messages in parallel.
connect.get('/matches', h(async (req, res) => {
  const me = req.user._id;
  const links = await ConnectRequest.find({ status: 'accepted', $or: [{ fromUserId: me }, { toUserId: me }] });
  const otherIds = [...new Set(links.map(l => String(same(l.fromUserId, me) ? l.toUserId : l.fromUserId)))];
  const [profiles, unreadRows, lasts] = await Promise.all([
    Profile.find({ userId: { $in: otherIds } }),
    ChatMessage.aggregate([
      { $match: { toUserId: me, readAt: null } },
      { $group: { _id: '$fromUserId', n: { $sum: 1 } } },
    ]),
    Promise.all(otherIds.map(id => ChatMessage.findOne(pair(me, id)).sort({ createdAt: -1 }))),
  ]);
  const byUser = new Map(profiles.map(p => [String(p.userId), p]));
  const unreadBy = new Map(unreadRows.map(u => [String(u._id), u.n]));
  const matches = [];
  otherIds.forEach((id, i) => {
    const p = byUser.get(id);
    if (!p) return;
    const last = lasts[i];
    matches.push({
      profile: cardProfile(p), unread: unreadBy.get(id) || 0,
      lastMessage: last ? { text: last.text, mine: same(last.fromUserId, me), createdAt: last.createdAt } : null,
    });
  });
  matches.sort((a, b) => new Date(b.lastMessage?.createdAt || 0) - new Date(a.lastMessage?.createdAt || 0));
  res.json({ matches });
}));

// Open a chat (also marks their messages as read).
connect.get('/chat/:profileId', h(async (req, res) => {
  const me = req.user._id;
  const other = await connectedProfile(me, req.params.profileId);
  const [msgs] = await Promise.all([
    ChatMessage.find(pair(me, other.userId)).sort({ createdAt: -1 }).limit(100),
    markRead(me, other.userId),
  ]);
  res.json({
    profile: cardProfile(other),
    messages: msgs.reverse().map(m => ({ id: m.id, text: m.text, mine: same(m.fromUserId, me), createdAt: m.createdAt, cid: same(m.fromUserId, me) ? m.cid : undefined })),
  });
}));

connect.post('/chat/:profileId/read', h(async (req, res) => {
  const other = await connectedProfile(req.user._id, req.params.profileId);
  await markRead(req.user._id, other.userId);
  res.json({ ok: true });
}));

// REST fallback for sending (the app normally sends over the socket). Same logic, same live events.
connect.post('/chat/:profileId', h(async (req, res) => {
  const message = await sendChatMessage({ me: req.user._id, profileId: req.params.profileId, text: req.body?.text, cid: req.body?.cid });
  res.status(201).json({ message });
}));
