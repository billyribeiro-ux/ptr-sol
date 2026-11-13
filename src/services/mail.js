const crypto = require('crypto');
const db = require('../db/database');
const activeRooms = new Map(),
  pausedRooms = new Set();
function pauseRoom(roomID) {
  if (activeRooms.get(roomID) || pausedRooms.has(roomID)) return false;
  pausedRooms.add(roomID);
  return true;
}
function resumeRoom(roomID) {
  pausedRooms.delete(roomID);
}

// Local delivery is the default. An operator must explicitly configure external
// SMTP before the application can send outside its local test inbox.
async function sendMail({ to, subject, text, html = '', roomID = null }) {
  const host = process.env.SMTP_HOST;
  const local = ['localhost', '127.0.0.1', '::1', 'mailpit'].includes(host);
  if (!host || (!local && process.env.SMTP_EXTERNAL_ENABLED !== 'true'))
    throw new Error('SMTP delivery is not configured.');
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO outbox (id,recipient,subject,text,html,status,room_id) VALUES (?,?,?,?,?,?,?)',
  ).run(id, to, subject, text || '', html, 'queued', roomID);
  try {
    const nodemailer = require('nodemailer');
    const options = {
      host,
      port: Number(process.env.SMTP_PORT || (local ? 1025 : 587)),
      secure: process.env.SMTP_SECURE === 'true',
      requireTLS: !local,
      tls: { rejectUnauthorized: true },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    };
    if (process.env.SMTP_USER)
      options.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' };
    const transport = nodemailer.createTransport(options);
    const result = await transport.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_FROM || 'noreply@localhost',
      to,
      subject,
      text,
      ...(html ? { html } : {}),
    });
    db.prepare(
      "UPDATE outbox SET status='sent',attempts=attempts+1,sent_at=datetime('now'),last_error='' WHERE id=?",
    ).run(id);
    return result;
  } catch (error) {
    // Avoid persisting SMTP credentials, transport details, or message bodies in error text.
    db.prepare(
      "UPDATE outbox SET status='failed',attempts=attempts+1,last_error='SMTP delivery failed' WHERE id=?",
    ).run(id);
    throw error;
  }
}
async function guardedSend(message) {
  const roomID = message.roomID;
  if (!roomID) return sendMail(message);
  if (pausedRooms.has(roomID)) throw Error('Room deletion is in progress.');
  activeRooms.set(roomID, (activeRooms.get(roomID) || 0) + 1);
  try {
    return await sendMail(message);
  } finally {
    const n = (activeRooms.get(roomID) || 1) - 1;
    if (n) activeRooms.set(roomID, n);
    else activeRooms.delete(roomID);
  }
}
module.exports = { sendMail: guardedSend, pauseRoom, resumeRoom };
