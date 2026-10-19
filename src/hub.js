// Shared Socket.IO handle. Lives in its own file so notify.js / chat.js / realtime.js
// can all use it without importing each other in a circle.
let io;
const online = new Map(); // userId -> number of open sockets (several tabs possible)

export const setIo = instance => { io = instance; };
export const isOnline = id => (online.get(String(id)) || 0) > 0;
export const emitToUser = (id, event, payload) => io?.to(`u:${id}`).emit(event, payload);

// Returns true when this is the user's first open socket.
export function markConnected(id) {
  const first = !isOnline(id);
  online.set(String(id), (online.get(String(id)) || 0) + 1);
  return first;
}
// Returns true when that was the user's last open socket.
export function markDisconnected(id) {
  const left = (online.get(String(id)) || 1) - 1;
  if (left > 0) { online.set(String(id), left); return false; }
  online.delete(String(id));
  return true;
}
