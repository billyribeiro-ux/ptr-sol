const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config({ quiet: true });

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');
const UPLOAD_DIR = path.resolve(DATA_DIR, 'uploads');
const RECORDINGS_DIR = path.resolve(DATA_DIR, 'recordings');

// A generated secret is durable across restarts, private to this installation,
// and never a value that could be guessed from the source distribution.
fs.mkdirSync(DATA_DIR, { recursive: true });
function installationSecret(name, supplied) {
  if (
    supplied &&
    !['dev-change-me-in-production', 'change-this-to-a-long-random-secret'].includes(supplied)
  ) {
    if (supplied.length < 32) throw new Error(`${name} must contain at least 32 characters.`);
    return supplied;
  }
  const filename = path.join(DATA_DIR, `.${name.toLowerCase()}`);
  try {
    fs.writeFileSync(filename, crypto.randomBytes(48).toString('base64url'), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return fs.readFileSync(filename, 'utf8').trim();
}

const PORT = Number(process.env.PORT) || 3000;

module.exports = {
  PORT,
  HOST: process.env.HOST || '0.0.0.0',
  NODE_ENV: process.env.NODE_ENV || 'development',
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`,
  JWT_SECRET: installationSecret('JWT_SECRET', process.env.JWT_SECRET),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  JANUS_URL: process.env.JANUS_URL || 'http://localhost:8088/janus',
  JANUS_ADMIN_URL: process.env.JANUS_ADMIN_URL || 'http://localhost:7088/admin',
  JANUS_API_SECRET: process.env.JANUS_API_SECRET || '',
  JANUS_ADMIN_SECRET: process.env.JANUS_ADMIN_SECRET || '',
  JANUS_PUBLIC_URL: process.env.JANUS_PUBLIC_URL || '/janus',
  JANUS_RTP_HOST: process.env.JANUS_RTP_HOST || 'janus',
  JANUS_RTP_PORT_MIN: Number(process.env.JANUS_RTP_PORT_MIN) || 5100,
  JANUS_RTP_PORT_MAX: Number(process.env.JANUS_RTP_PORT_MAX) || 5198,
  RECAPTCHA_SECRET: process.env.RECAPTCHA_SECRET || '',
  RECAPTCHA_SITE_KEY: process.env.RECAPTCHA_SITE_KEY || '',
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: Number(process.env.SMTP_PORT) || 1025,
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  MAIL_FROM: process.env.MAIL_FROM || 'ProTradingRoom <noreply@ptr.local>',
  ALLOW_SELF_SERVICE_PLANS: process.env.ALLOW_SELF_SERVICE_PLANS === 'true',
  MAX_UPLOAD_BYTES: Number(process.env.MAX_UPLOAD_BYTES) || 50 * 1024 * 1024,
  ROOT_DIR,
  DATA_DIR,
  UPLOAD_DIR,
  RECORDINGS_DIR,
  PUBLIC_DIR: path.resolve(ROOT_DIR, 'public'),
};
