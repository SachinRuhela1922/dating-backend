import nodemailer from 'nodemailer';

let transport;
const get = () => (transport ??= nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}));

export async function sendOtpMail(to, code, purpose) {
  const what = purpose === 'signup' ? 'verify your email' : 'reset your password';
  await get().sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: `${code} is your Kindred verification code`,
    text: `Use this code to ${what}: ${code}\n\nIt expires in 10 minutes. If you didn't request it, you can ignore this email.`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:420px">
      <p>Use this code to ${what}:</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:16px 0">${code}</p>
      <p style="color:#666">It expires in 10 minutes. If you didn't request it, you can ignore this email.</p></div>`,
  });
}

// Plain-text notification (new request / new message). Never put user-written text in `subject`.
export async function sendNotifyMail(to, subject, text) {
  await get().sendMail({ from: process.env.MAIL_FROM, to, subject, text });
}