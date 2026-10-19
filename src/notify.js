import { User, ChatMessage } from './models.js';
import { sendNotifyMail } from './mail.js';
import { emitToUser, isOnline } from './hub.js';

const appUrl = () => process.env.APP_URL || 'http://localhost:5173';

// Live event for open tabs; email only if the person is offline.
// `request` is the same shape GET /api/connect/requests returns, so the UI can add it without refetching.
export async function notifyNewRequest(toUserId, fromProfile, request) {
  emitToUser(toUserId, 'request', { profileId: fromProfile.id, request });
  if (isOnline(toUserId)) return;
  const to = await User.findById(toUserId);
  if (!to) return;
  await sendNotifyMail(to.email, 'Kindred par aapke liye nayi request',
    `${fromProfile.name} ne aapko request bheji hai.\n\nDekhne ke liye: ${appUrl()}/requests`);
}

// `message` is the already-built { id, text, mine:false, createdAt }.
// Email only for the FIRST unread message from that person (no spam), and only if offline.
// The unread count is only queried in that offline case, so the live path stays query-free.
export async function notifyNewMessage(toUserId, fromProfile, message, fromUserId) {
  emitToUser(toUserId, 'message', { fromProfileId: fromProfile.id, message });
  if (isOnline(toUserId)) return;
  const unread = await ChatMessage.countDocuments({ fromUserId, toUserId, readAt: null });
  if (unread > 1) return; // this message is the only unread one => first unread
  const to = await User.findById(toUserId);
  if (!to) return;
  await sendNotifyMail(to.email, 'Kindred par aapke liye naya message',
    `${fromProfile.name} ne aapko message bheja hai.\n\nPadhne ke liye: ${appUrl()}/messages`);
}
