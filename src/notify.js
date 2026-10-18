import { User } from './models.js';
import { sendNotifyMail } from './mail.js';
import { emitToUser, isOnline } from './realtime.js';

const appUrl = () => process.env.APP_URL || 'http://localhost:5173';

// Live event for open tabs; email only if the person is offline.
export async function notifyNewRequest(toUserId, fromProfile) {
  emitToUser(toUserId, 'request', { profileId: fromProfile.id });
  if (isOnline(toUserId)) return;
  const to = await User.findById(toUserId);
  if (!to) return;
  await sendNotifyMail(to.email, 'Kindred par aapke liye nayi request',
    `${fromProfile.name} ne aapko request bheji hai.\n\nDekhne ke liye: ${appUrl()}/requests`);
}

// Email only for the FIRST unread message from that person (no spam), and only if offline.
export async function notifyNewMessage(toUserId, fromProfile, message, firstUnread) {
  emitToUser(toUserId, 'message', {
    fromProfileId: fromProfile.id,
    message: { id: message.id, text: message.text, mine: false, createdAt: message.createdAt },
  });
  if (!firstUnread || isOnline(toUserId)) return;
  const to = await User.findById(toUserId);
  if (!to) return;
  await sendNotifyMail(to.email, 'Kindred par aapke liye naya message',
    `${fromProfile.name} ne aapko message bheja hai.\n\nPadhne ke liye: ${appUrl()}/messages`);
}