const crypto = require('crypto');
const pausedRooms = new Set();
const activeRooms = new Map();
const activeOrders = new Set();
function enterOrder(orderID) {
  if (activeOrders.has(orderID)) return null;
  activeOrders.add(orderID);
  return () => activeOrders.delete(orderID);
}

function enterRoom(roomID) {
  if (pausedRooms.has(roomID)) return null;
  activeRooms.set(roomID, (activeRooms.get(roomID) || 0) + 1);
  return () => {
    const count = activeRooms.get(roomID) - 1;
    if (count) activeRooms.set(roomID, count);
    else activeRooms.delete(roomID);
  };
}
function pauseRoom(roomID) {
  if (pausedRooms.has(roomID) || activeRooms.has(roomID)) return false;
  pausedRooms.add(roomID);
  return true;
}
function resumeRoom(roomID) {
  pausedRooms.delete(roomID);
}

function configured() {
  return (
    process.env.STRIPE_ENABLED === 'true' &&
    /^sk_(test|live)_/.test(process.env.STRIPE_SECRET_KEY || '') &&
    Boolean(process.env.STRIPE_WEBHOOK_SECRET)
  );
}

async function request(path, values, account, options = {}) {
  if (!configured()) throw new Error('Stripe is not configured.');
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) body.set(key, String(value));
  const method = options.method || 'POST';
  const url = `https://api.stripe.com/v1/${path}${method === 'GET' && body.size ? `?${body}` : ''}`;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(account ? { 'stripe-account': account } : {}),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
    },
    ...(method === 'POST' ? { body } : {}),
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error('Stripe request failed.');
  return result;
}

function verifyWebhook(payload, signature) {
  if (!configured() || !Buffer.isBuffer(payload) || typeof signature !== 'string') return false;
  const parts = signature.split(',').map((part) => part.split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  if (!/^\d+$/.test(timestamp || '') || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300)
    return false;
  const expected = crypto
    .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.`)
    .update(payload)
    .digest();
  return parts
    .filter(([key, value]) => key === 'v1' && /^[a-f0-9]{64}$/i.test(value || ''))
    .some(([, value]) => crypto.timingSafeEqual(expected, Buffer.from(value, 'hex')));
}

module.exports = {
  configured,
  request,
  verifyWebhook,
  enterRoom,
  enterOrder,
  pauseRoom,
  resumeRoom,
};
