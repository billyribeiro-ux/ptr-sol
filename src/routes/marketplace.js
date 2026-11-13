const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { UPLOAD_DIR } = require('../config');
const { mimeFor } = require('./images');
const { sendMail } = require('../services/mail');
const { validRoomURL } = require('../services/room-validation');
const {
  authenticateRequest,
  requireRoomAccess,
  createPasswordReset,
} = require('../middleware/auth');
const stripe = require('../services/stripe');
const router = express.Router();
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5, fields: 4 },
});
const videoUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024, files: 5, fields: 4 },
});
router.get('/ptr_app/api/v2/sessionReport', (req, res) => {
  if (!authenticateRequest(req))
    return res.status(401).json({ message: 'Authentication required.' });
  return res.status(503).json({ message: 'The legacy session report provider is unavailable.' });
});
const listingFields = [
  'title',
  'tagline',
  'description',
  'logoURL',
  'images',
  'tags',
  'published',
  'locked',
  'featured',
  'hidden',
  'videos',
];
const parse = (value) => {
  try {
    const result = JSON.parse(value || '{}');
    return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  } catch {
    return {};
  }
};
function listing(row) {
  const room = db.prepare('SELECT id,uuid FROM sessions WHERE uuid=?').get(row.session_id);
  const data = parse(row.data);
  return {
    published: false,
    locked: false,
    featured: false,
    hidden: false,
    tagline: '',
    description: '',
    images: [],
    tags: [],
    ...data,
    _id: row.id,
    sessionID: room?.id || row.session_id,
    title: row.title,
    logoURL: row.logo_url || '',
    created: row.created_at,
    memberships: db
      .prepare('SELECT * FROM marketplace_plans WHERE marketplace_id=? ORDER BY created_at,id')
      .all(row.id)
      .map(plan),
  };
}
function plan(row) {
  return { ...parse(row.data), _id: row.id };
}
function listingAccess(req, id, manage = true) {
  const row = db.prepare('SELECT * FROM marketplaces WHERE id=?').get(id);
  const user = authenticateRequest(req);
  return row && user && requireRoomAccess(user, row.session_id, { manage }) ? row : null;
}
function cleanListing(body) {
  const result = {};
  for (const key of listingFields) if (Object.hasOwn(body, key)) result[key] = body[key];
  if ('logoURL' in result && !validRoomURL(result.logoURL)) throw new Error('Invalid logo URL.');
  if (
    'title' in result &&
    (typeof result.title !== 'string' || !result.title.trim() || result.title.length > 200)
  )
    throw new Error('Enter a valid title.');
  for (const key of ['published', 'locked', 'featured', 'hidden'])
    if (key in result && typeof result[key] !== 'boolean')
      throw new Error('Invalid listing setting.');
  for (const key of ['images', 'tags', 'videos'])
    if (key in result && (!Array.isArray(result[key]) || result[key].length > 100))
      throw new Error('Invalid listing collection.');
  return result;
}
function saveListing(row, body) {
  const changes = cleanListing(body),
    data = { ...parse(row.data), ...changes };
  db.prepare('UPDATE marketplaces SET title=?,logo_url=?,data=? WHERE id=?').run(
    changes.title ?? row.title,
    changes.logoURL ?? row.logo_url,
    JSON.stringify(data),
    row.id,
  );
  return listing(db.prepare('SELECT * FROM marketplaces WHERE id=?').get(row.id));
}
function publicListings(req) {
  const q = String(req.query.search || req.query.q || '')
    .toLowerCase()
    .slice(0, 200);
  const rows = db
    .prepare('SELECT * FROM marketplaces ORDER BY created_at DESC')
    .all()
    .map(listing)
    .filter(
      (item) =>
        item.published &&
        !item.hidden &&
        (!q || `${item.title} ${item.tagline} ${item.description}`.toLowerCase().includes(q)),
    );
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1),
    limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
  return {
    marketplaces: rows.slice((page - 1) * limit, page * limit),
    total: rows.length,
    page,
    limit,
  };
}
function siteURL(value) {
  try {
    const origin = new URL(process.env.PUBLIC_ORIGIN || 'http://localhost:3000');
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.origin === origin.origin
      ? url.href.replace(/%7BCHECKOUT_SESSION_ID%7D/gi, '{CHECKOUT_SESSION_ID}')
      : null;
  } catch {
    return null;
  }
}
function stripeURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function reconcileMarketplaceMember(order) {
  if (!order.member_id) return;
  const member = db
    .prepare('SELECT * FROM memberships WHERE id=? AND room_id=?')
    .get(order.member_id, order.room_id);
  if (!member) return;
  const flags = parse(member.flags);
  if (flags.authProvider !== 'marketplace' || flags.marketplaceFree) return;
  const active = db
    .prepare(
      "SELECT 1 FROM marketplace_orders WHERE member_id=? AND status IN ('paid','active','trialing','past_due') LIMIT 1",
    )
    .get(member.id);
  if (active && flags.stripeSuspended) {
    delete flags.stripeSuspended;
    db.prepare("UPDATE memberships SET status='approved',flags=? WHERE id=?").run(
      JSON.stringify(flags),
      member.id,
    );
  } else if (!active && member.status === 'approved') {
    flags.stripeSuspended = true;
    db.prepare(
      "UPDATE memberships SET status='suspended',flags=?,token_version=token_version+1 WHERE id=?",
    ).run(JSON.stringify(flags), member.id);
  }
}
router.post('/ptr_app/mp/v2/stripe/webhook', async (req, res) => {
  if (!stripe.verifyWebhook(req.body, req.get('stripe-signature')))
    return res.status(400).json({ message: 'Invalid webhook signature.' });
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ message: 'Invalid webhook payload.' });
  }
  if (!event?.id || typeof event.id !== 'string')
    return res.status(400).json({ message: 'Invalid webhook event.' });
  if (
    typeof event.livemode === 'boolean' &&
    event.livemode !== String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_')
  )
    return res
      .status(400)
      .json({ message: 'Webhook mode does not match the Stripe configuration.' });
  if (db.prepare('SELECT 1 FROM stripe_events WHERE event_id=?').get(event.id))
    return res.json({ received: true });
  const session = event.data?.object;
  if (
    [
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
      'charge.refunded',
      'charge.succeeded',
      'charge.updated',
    ].includes(event.type)
  ) {
    const subscription = event.type.startsWith('customer.subscription.')
      ? session?.id
      : session?.subscription || session?.parent?.subscription_details?.subscription;
    const order = subscription
      ? db
          .prepare('SELECT * FROM marketplace_orders WHERE subscription_id=? AND account_id=?')
          .get(subscription, event.account || '')
      : event.type.startsWith('charge.')
        ? db
            .prepare(
              'SELECT o.* FROM marketplace_orders o LEFT JOIN marketplace_payments p ON p.order_id=o.id WHERE (o.payment_intent_id=? OR p.payment_intent_id=?) AND o.account_id=? LIMIT 1',
            )
            .get(session?.payment_intent || '', session?.payment_intent || '', event.account || '')
        : null;
    if (!order) return res.status(400).json({ message: 'Payment event does not match an order.' });
    const release = stripe.enterRoom(order.room_id),
      releaseOrder = release && stripe.enterOrder(order.id);
    if (!releaseOrder) {
      if (release) release();
      return res.status(409).json({ message: 'Payment or room deletion is in progress.' });
    }
    try {
      const timestamp = Number(event.created);
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
        return res.status(400).json({ message: 'Payment event is missing its timestamp.' });
      let balance = null;
      if (['charge.succeeded', 'charge.updated'].includes(event.type)) {
        const transactionID = session.balance_transaction;
        if (!/^txn_[A-Za-z0-9]+$/.test(transactionID || ''))
          return res.status(503).json({ message: 'Stripe balance details are pending.' });
        const payment = db
          .prepare('SELECT * FROM marketplace_payments WHERE order_id=? AND payment_intent_id=?')
          .get(order.id, session.payment_intent || '');
        if (!payment)
          return res.status(503).json({ message: 'The payment ledger is not ready yet.' });
        try {
          balance = await stripe.request(
            `balance_transactions/${encodeURIComponent(transactionID)}`,
            {},
            order.account_id,
            { method: 'GET' },
          );
        } catch {
          return res.status(503).json({ message: 'Stripe balance details are unavailable.' });
        }
        if (
          balance.id !== transactionID ||
          balance.currency !== payment.currency ||
          balance.amount !== payment.amount ||
          !Number.isSafeInteger(balance.net) ||
          !Number.isSafeInteger(balance.fee) ||
          balance.net !== balance.amount - balance.fee
        )
          return res
            .status(502)
            .json({ message: 'Stripe balance details do not match the payment.' });
      }
      let refundNet = null,
        refundPending = false;
      if (event.type === 'charge.refunded' && Number(session.amount_refunded) > 0) {
        let refunds = session.refunds;
        if (refunds?.has_more && /^ch_[A-Za-z0-9]+$/.test(session.id || '')) {
          try {
            const items = [];
            let cursor = null,
              more = true;
            while (more && items.length < 1000) {
              const page = await stripe.request(
                `charges/${encodeURIComponent(session.id)}/refunds`,
                { limit: 100, ...(cursor ? { starting_after: cursor } : {}) },
                order.account_id,
                { method: 'GET' },
              );
              if (!Array.isArray(page.data) || (!page.data.length && page.has_more))
                throw new Error('Invalid refund page.');
              items.push(...page.data);
              more = !!page.has_more;
              cursor = page.data.at(-1)?.id;
              if (more && !/^re_[A-Za-z0-9]+$/.test(cursor || ''))
                throw new Error('Invalid refund cursor.');
            }
            refunds = { data: items, has_more: more };
          } catch {
            refundPending = true;
          }
        }
        if (
          !Array.isArray(refunds?.data) ||
          refunds.has_more ||
          refunds.data.reduce((sum, item) => sum + Number(item.amount || 0), 0) !==
            Number(session.amount_refunded)
        )
          refundPending = true;
        else {
          refundNet = 0;
          for (const refund of refunds.data) {
            const transactionID = refund.balance_transaction;
            if (!/^txn_[A-Za-z0-9]+$/.test(transactionID || '')) {
              refundPending = true;
              break;
            }
            try {
              const item = await stripe.request(
                `balance_transactions/${encodeURIComponent(transactionID)}`,
                {},
                order.account_id,
                { method: 'GET' },
              );
              if (
                item.id !== transactionID ||
                item.currency !== order.currency ||
                item.amount !== -Number(refund.amount) ||
                !Number.isSafeInteger(item.net) ||
                !Number.isSafeInteger(item.fee) ||
                item.net !== item.amount - item.fee
              )
                throw new Error('Invalid refund balance.');
              refundNet += item.net;
            } catch {
              refundPending = true;
              break;
            }
          }
        }
      }
      let status = order.status;
      if (event.type === 'customer.subscription.deleted') status = 'cancelled';
      else if (event.type === 'customer.subscription.updated') {
        const allowed = [
          'active',
          'trialing',
          'past_due',
          'unpaid',
          'canceled',
          'incomplete',
          'incomplete_expired',
          'paused',
        ];
        if (!allowed.includes(session.status))
          return res.status(400).json({ message: 'Unsupported subscription status.' });
        status = session.status === 'canceled' ? 'cancelled' : session.status;
      } else if (event.type === 'invoice.paid' && order.status !== 'cancelled') status = 'active';
      else if (event.type === 'invoice.payment_failed' && order.status !== 'cancelled')
        status = 'past_due';
      const fullyRefunded =
        event.type === 'charge.refunded' &&
        Number(session.amount_refunded) >= Number(session.amount) &&
        Number(session.amount) > 0;
      if (fullyRefunded && !order.recurring) status = 'refunded';
      db.exec('BEGIN IMMEDIATE');
      try {
        const terminal = ['cancelled', 'refunded', 'unpaid', 'incomplete_expired'].includes(status);
        const previouslyTerminal = [
          'cancelled',
          'refunded',
          'unpaid',
          'incomplete_expired',
        ].includes(order.status);
        const affectsEntitlement =
          !event.type.startsWith('charge.') || (fullyRefunded && !order.recurring);
        if (
          affectsEntitlement &&
          (timestamp > order.last_event_at ||
            (timestamp === order.last_event_at && terminal && !previouslyTerminal))
        ) {
          db.prepare(
            'UPDATE marketplace_orders SET status=?,last_event_at=?,payment_intent_id=COALESCE(?,payment_intent_id) WHERE id=?',
          ).run(
            status,
            timestamp,
            typeof session.payment_intent === 'string' ? session.payment_intent : null,
            order.id,
          );
          reconcileMarketplaceMember(order);
        }
        if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
          const invoiceID = session.id,
            amount = Number(
              event.type === 'invoice.paid' ? session.amount_paid : session.amount_due,
            );
          if (
            !/^in_[A-Za-z0-9]+$/.test(invoiceID || '') ||
            !Number.isSafeInteger(amount) ||
            amount < 0 ||
            session.currency !== order.currency
          )
            throw new Error('Invalid invoice.');
          db.prepare(
            `INSERT INTO marketplace_payments(id,order_id,room_id,payment_intent_id,amount,currency,status,type,stripe_created_at)
            VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payment_intent_id=COALESCE(excluded.payment_intent_id,marketplace_payments.payment_intent_id),amount=CASE WHEN marketplace_payments.status='succeeded' AND excluded.status='failed' THEN marketplace_payments.amount ELSE excluded.amount END,status=CASE WHEN marketplace_payments.status IN ('succeeded','refunded') AND excluded.status='failed' THEN marketplace_payments.status ELSE excluded.status END`,
          ).run(
            invoiceID,
            order.id,
            order.room_id,
            typeof session.payment_intent === 'string' ? session.payment_intent : null,
            amount,
            order.currency,
            event.type === 'invoice.paid' ? 'succeeded' : 'failed',
            session.billing_reason === 'subscription_create'
              ? 'subscription'
              : 'subscription_renewal',
            timestamp,
          );
        }
        if (event.type === 'charge.refunded') {
          const refunded = Number(session.amount_refunded);
          if (!Number.isSafeInteger(refunded) || refunded < 0) throw new Error('Invalid refund.');
          db.prepare(
            "UPDATE marketplace_payments SET refunded_amount=MAX(refunded_amount,?),refund_net=CASE WHEN ?>=refunded_amount THEN ? ELSE refund_net END,status=CASE WHEN ?>=amount THEN 'refunded' ELSE status END WHERE order_id=? AND payment_intent_id=?",
          ).run(
            refunded,
            refunded,
            refundPending ? null : refundNet,
            refunded,
            order.id,
            session.payment_intent,
          );
        }
        if (balance)
          db.prepare(
            'UPDATE marketplace_payments SET net_amount=?,fee_amount=?,balance_transaction_id=? WHERE order_id=? AND payment_intent_id=?',
          ).run(balance.net, balance.fee, balance.id, order.id, session.payment_intent);
        if (!refundPending)
          db.prepare('INSERT OR IGNORE INTO stripe_events(event_id) VALUES(?)').run(event.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return refundPending
        ? res.status(503).json({ message: 'Stripe refund balance details are pending.' })
        : res.json({ received: true });
    } finally {
      releaseOrder();
      release();
    }
  }
  if (event.type === 'checkout.session.expired') {
    db.prepare(
      "UPDATE marketplace_orders SET status='expired' WHERE id=? AND session_id=? AND account_id=? AND status='pending'",
    ).run(session?.metadata?.orderID || '', session?.id || '', event.account || '');
    db.prepare('INSERT OR IGNORE INTO stripe_events(event_id) VALUES(?)').run(event.id);
    return res.json({ received: true });
  }
  if (
    !['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(
      event.type,
    ) ||
    !['paid', 'no_payment_required'].includes(session?.payment_status)
  ) {
    db.prepare('INSERT OR IGNORE INTO stripe_events(event_id) VALUES(?)').run(event.id);
    return res.json({ received: true });
  }
  const order = db
    .prepare('SELECT * FROM marketplace_orders WHERE id=?')
    .get(session.metadata?.orderID || '');
  const trial =
    order &&
    order.recurring &&
    order.trial_days > 0 &&
    session?.payment_status === 'no_payment_required' &&
    session.amount_total === 0;
  if (
    !order ||
    order.session_id !== session.id ||
    order.account_id !== event.account ||
    (!trial && (session.amount_total !== order.amount || session.payment_status !== 'paid')) ||
    session.currency !== order.currency ||
    (order.recurring && !/^sub_[A-Za-z0-9]+$/.test(session.subscription || ''))
  )
    return res.status(400).json({ message: 'Payment does not match an order.' });
  const release = stripe.enterRoom(order.room_id);
  if (!release) return res.status(409).json({ message: 'Room deletion is in progress.' });
  const releaseOrder = stripe.enterOrder(order.id);
  if (!releaseOrder) {
    release();
    return res.status(409).json({ message: 'This payment is already being processed.' });
  }
  try {
    if (['paid', 'active', 'trialing'].includes(order.status)) {
      db.prepare('INSERT OR IGNORE INTO stripe_events(event_id) VALUES(?)').run(event.id);
      return res.json({ received: true });
    }
    const banned = db
      .prepare('SELECT 1 FROM banned_users WHERE room_id=? AND email=?')
      .get(order.room_id, order.email);
    if (banned)
      return res
        .status(409)
        .json({ message: 'This buyer cannot access the room; the order requires review.' });
    let member = db
        .prepare('SELECT * FROM memberships WHERE room_id=? AND email=?')
        .get(order.room_id, order.email),
      created = false;
    if (member && member.status !== 'approved' && !parse(member.flags).stripeSuspended)
      return res
        .status(409)
        .json({ message: 'This buyer is not approved; the order requires review.' });
    if (!member) {
      const id = uuidv4();
      db.prepare(
        'INSERT INTO memberships(id,room_id,email,name,role,status,flags) VALUES(?,?,?,?,?,?,?)',
      ).run(
        id,
        order.room_id,
        order.email,
        order.name,
        '2',
        'approved',
        JSON.stringify({ authProvider: 'marketplace' }),
      );
      member = db.prepare('SELECT * FROM memberships WHERE id=?').get(id);
      created = true;
    }
    if (created || !member.password_hash) {
      const reset = createPasswordReset({ membershipId: member.id });
      try {
        await sendMail({
          roomID: order.room_id,
          to: order.email,
          subject: 'Your room access',
          text: `Set your password: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/ptrApp#/page/user-change-password/${reset}\nRoom: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/u/${order.room_id}`,
        });
      } catch {
        return res
          .status(503)
          .json({ message: 'Payment received; access email delivery will be retried.' });
      }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'UPDATE marketplace_orders SET status=?,subscription_id=?,payment_intent_id=?,member_id=?,last_event_at=? WHERE id=?',
      ).run(
        order.recurring ? (trial ? 'trialing' : 'active') : 'paid',
        order.recurring ? session.subscription : null,
        typeof session.payment_intent === 'string' ? session.payment_intent : null,
        member.id,
        Number(event.created) || 0,
        order.id,
      );
      if (!order.recurring)
        db.prepare(
          'INSERT OR IGNORE INTO marketplace_payments(id,order_id,room_id,payment_intent_id,amount,currency,status,type,stripe_created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(
          session.id,
          order.id,
          order.room_id,
          typeof session.payment_intent === 'string' ? session.payment_intent : null,
          order.amount,
          order.currency,
          'succeeded',
          'one_time',
          Number(event.created) || Math.floor(Date.now() / 1000),
        );
      reconcileMarketplaceMember({ ...order, member_id: member.id });
      db.prepare('INSERT OR IGNORE INTO stripe_events(event_id) VALUES(?)').run(event.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return res.json({ received: true });
  } finally {
    releaseOrder();
    release();
  }
});
router.post('/ptr_app/mp/v2/:id/memberships/:planID/checkout', async (req, res) => {
  if (!stripe.configured() || !process.env.SMTP_HOST)
    return res.status(503).json({ message: 'Checkout and email delivery are not configured.' });
  const row = db.prepare('SELECT * FROM marketplaces WHERE id=?').get(req.params.id),
    view = row && listing(row);
  const record =
    row &&
    db
      .prepare('SELECT * FROM marketplace_plans WHERE id=? AND marketplace_id=?')
      .get(req.params.planID, row.id);
  if (!view?.published || view.hidden || view.locked || !record)
    return res.status(404).json({ message: 'Membership is not available.' });
  const selected = plan(record),
    amount = Number(selected.amount),
    currency = String(selected.currency || '').toLowerCase();
  if (
    selected.isActive === false ||
    selected.isFree ||
    !Number.isSafeInteger(amount) ||
    amount < 50 ||
    amount > 99999999 ||
    !/^(usd|eur|gbp)$/.test(currency)
  )
    return res.status(400).json({ message: 'This membership does not have a supported price.' });
  const recurring = selected.recurring === true,
    trialDays = Number(selected.trialPeriodDays || 0),
    intervalCount = Number(selected.recurringIntervalCount || 1);
  const interval = {
    daily: 'day',
    weekly: 'week',
    monthly: 'month',
    yearly: 'year',
    day: 'day',
    week: 'week',
    month: 'month',
    year: 'year',
  }[selected.recurringPeriod || 'monthly'];
  if (
    !Number.isSafeInteger(trialDays) ||
    trialDays < 0 ||
    trialDays > 730 ||
    (!recurring && trialDays) ||
    (recurring &&
      (!interval ||
        !Number.isSafeInteger(intervalCount) ||
        intervalCount < 1 ||
        intervalCount > 12))
  )
    return res.status(400).json({ message: 'This membership has an invalid billing schedule.' });
  const account = db.prepare('SELECT * FROM stripe_accounts WHERE room_id=?').get(row.session_id);
  if (!account)
    return res.status(503).json({ message: 'The room owner has not configured Stripe Connect.' });
  const email = String(req.body?.customerEmail || '')
      .trim()
      .toLowerCase(),
    name = String(req.body?.customerName || '')
      .trim()
      .slice(0, 120);
  const success = siteURL(req.body?.successUrl),
    cancel = siteURL(req.body?.cancelUrl);
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    name.length < 2 ||
    !success ||
    !cancel
  )
    return res.status(400).json({ message: 'Enter a valid name, email and return URLs.' });
  if (
    db.prepare('SELECT 1 FROM banned_users WHERE room_id=? AND email=?').get(row.session_id, email)
  )
    return res.status(403).json({ message: 'This participant cannot access the room.' });
  const existing = db
    .prepare('SELECT status,flags FROM memberships WHERE room_id=? AND email=?')
    .get(row.session_id, email);
  if (existing && existing.status !== 'approved' && !parse(existing.flags).stripeSuspended)
    return res.status(403).json({ message: 'This participant is not approved for room access.' });
  const release = stripe.enterRoom(row.session_id);
  if (!release) return res.status(409).json({ message: 'Room deletion is in progress.' });
  try {
    const id = uuidv4();
    db.prepare(
      'INSERT INTO marketplace_orders(id,room_id,marketplace_id,plan_id,account_id,email,name,amount,currency,recurring,trial_days,plan_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      row.session_id,
      row.id,
      record.id,
      account.account_id,
      email,
      name,
      amount,
      currency,
      Number(recurring),
      trialDays,
      String(selected.planName || row.title).slice(0, 200),
    );
    try {
      const fields = {
        mode: recurring ? 'subscription' : 'payment',
        success_url: success,
        cancel_url: cancel,
        customer_email: email,
        'metadata[orderID]': id,
        'line_items[0][price_data][currency]': currency,
        'line_items[0][price_data][unit_amount]': amount,
        'line_items[0][price_data][product_data][name]': String(
          selected.planName || row.title,
        ).slice(0, 200),
        'line_items[0][quantity]': 1,
      };
      if (recurring) {
        fields['line_items[0][price_data][recurring][interval]'] = interval;
        fields['line_items[0][price_data][recurring][interval_count]'] = intervalCount;
        if (trialDays) fields['subscription_data[trial_period_days]'] = trialDays;
      }
      const result = await stripe.request('checkout/sessions', fields, account.account_id, {
        idempotencyKey: `ptr-order-${id}`,
      });
      const url = stripeURL(result.url);
      if (!url || !/^cs_[A-Za-z0-9_]+$/.test(result.id || ''))
        throw new Error('Invalid Stripe checkout response.');
      db.prepare('UPDATE marketplace_orders SET session_id=? WHERE id=?').run(result.id, id);
      return res.json({ url });
    } catch {
      db.prepare("UPDATE marketplace_orders SET status='unknown' WHERE id=?").run(id);
      return res
        .status(502)
        .json({ message: 'Stripe checkout could not be started; its status requires review.' });
    }
  } finally {
    release();
  }
});
router.post('/ptr_app/mp/v2/:id/memberships/:planID/free-access', async (req, res) => {
  if (!process.env.SMTP_HOST)
    return res.status(503).json({ message: 'Email delivery is not configured.' });
  const row = db.prepare('SELECT * FROM marketplaces WHERE id=?').get(req.params.id),
    view = row && listing(row);
  const record =
    row &&
    db
      .prepare('SELECT * FROM marketplace_plans WHERE id=? AND marketplace_id=?')
      .get(req.params.planID, row.id);
  if (!view?.published || view.hidden || view.locked || !record)
    return res.status(404).json({ message: 'Membership is not available.' });
  const selected = plan(record);
  if (selected.isActive === false || (!selected.isFree && Number(selected.amount) !== 0))
    return res.status(400).json({ message: 'This is not an active free membership.' });
  const email = String(req.body?.customerEmail || '')
      .trim()
      .toLowerCase(),
    name = String(req.body?.customerName || '')
      .trim()
      .slice(0, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || name.length < 2)
    return res.status(400).json({ message: 'Enter a valid name and email.' });
  if (
    db.prepare('SELECT 1 FROM banned_users WHERE room_id=? AND email=?').get(row.session_id, email)
  )
    return res.status(403).json({ message: 'This participant cannot access the room.' });
  const release = stripe.enterRoom(row.session_id);
  if (!release) return res.status(409).json({ message: 'Room deletion is in progress.' });
  try {
    let member = db
      .prepare('SELECT * FROM memberships WHERE room_id=? AND email=?')
      .get(row.session_id, email);
    if (member && member.status !== 'approved' && !parse(member.flags).stripeSuspended)
      return res.status(403).json({ message: 'This participant is not approved for room access.' });
    if (!member) {
      const id = uuidv4();
      db.prepare(
        'INSERT INTO memberships(id,room_id,email,name,role,status,flags) VALUES(?,?,?,?,?,?,?)',
      ).run(
        id,
        row.session_id,
        email,
        name,
        '2',
        'approved',
        JSON.stringify({ authProvider: 'marketplace', marketplaceFree: true }),
      );
      member = db.prepare('SELECT * FROM memberships WHERE id=?').get(id);
    } else if (parse(member.flags).authProvider === 'marketplace') {
      const flags = { ...parse(member.flags), marketplaceFree: true };
      delete flags.stripeSuspended;
      db.prepare("UPDATE memberships SET flags=?,status='approved' WHERE id=?").run(
        JSON.stringify(flags),
        member.id,
      );
    }
    const reset = createPasswordReset({ membershipId: member.id });
    try {
      await sendMail({
        roomID: row.session_id,
        to: email,
        subject: 'Your room access',
        text: `Set your password: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/ptrApp#/page/user-change-password/${reset}\nRoom: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/u/${row.session_id}`,
      });
    } catch {
      return res.status(503).json({ message: 'Access email delivery failed. Please try again.' });
    }
    if (
      !db
        .prepare(
          "SELECT 1 FROM marketplace_orders WHERE member_id=? AND plan_id=? AND status='free'",
        )
        .get(member.id, record.id)
    )
      db.prepare(
        "INSERT INTO marketplace_orders(id,room_id,marketplace_id,plan_id,account_id,email,name,amount,currency,status,member_id,plan_name) VALUES(?,?,?,?,?,?,?,?,?,'free',?,?)",
      ).run(
        uuidv4(),
        row.session_id,
        row.id,
        record.id,
        '',
        email,
        name,
        0,
        String(selected.currency || 'usd').toLowerCase(),
        member.id,
        String(selected.planName || row.title).slice(0, 200),
      );
    return res.json({ success: true });
  } finally {
    release();
  }
});
router.get('/ptr_app/mp/v2/sessions/:id/stripe/account', async (req, res) => {
  const user = authenticateRequest(req),
    room = user && requireRoomAccess(user, req.params.id, { manage: true });
  if (!room) return res.status(403).json({ message: 'Room access denied.' });
  if (!stripe.configured()) return res.status(503).json({ message: 'Stripe is not configured.' });
  const account = db.prepare('SELECT * FROM stripe_accounts WHERE room_id=?').get(room.uuid);
  if (!account) return res.json({ connected: false });
  try {
    const result = await stripe.request(
      `accounts/${encodeURIComponent(account.account_id)}`,
      {},
      null,
      { method: 'GET' },
    );
    return res.json({
      connected: true,
      accountId: account.account_id,
      chargesEnabled: !!result.charges_enabled,
      payoutsEnabled: !!result.payouts_enabled,
      detailsSubmitted: !!result.details_submitted,
    });
  } catch {
    return res.status(502).json({ message: 'Stripe account status is unavailable.' });
  }
});
router.post('/ptr_app/mp/v2/sessions/:id/stripe/account-link', async (req, res) => {
  const user = authenticateRequest(req),
    room = user && requireRoomAccess(user, req.params.id, { manage: true });
  if (!room) return res.status(403).json({ message: 'Room access denied.' });
  if (!stripe.configured()) return res.status(503).json({ message: 'Stripe is not configured.' });
  const returnURL = siteURL(req.body?.returnUrl),
    refreshURL = siteURL(req.body?.refreshUrl);
  if (!returnURL || !refreshURL)
    return res.status(400).json({ message: 'Return URLs must belong to this application.' });
  const release = stripe.enterRoom(room.uuid);
  if (!release) return res.status(409).json({ message: 'Room deletion is in progress.' });
  try {
    let account = db.prepare('SELECT * FROM stripe_accounts WHERE room_id=?').get(room.uuid);
    if (!account) {
      const created = await stripe.request('accounts', { type: 'express' }, null, {
        idempotencyKey: `ptr-account-${room.uuid}`,
      });
      if (!/^acct_[A-Za-z0-9]+$/.test(created.id || '')) throw new Error('Invalid Stripe account.');
      db.prepare('INSERT OR IGNORE INTO stripe_accounts(room_id,account_id) VALUES(?,?)').run(
        room.uuid,
        created.id,
      );
      account = db.prepare('SELECT * FROM stripe_accounts WHERE room_id=?').get(room.uuid);
    }
    const link = await stripe.request('account_links', {
      account: account.account_id,
      return_url: returnURL,
      refresh_url: refreshURL,
      type: 'account_onboarding',
    });
    const url = stripeURL(link.url);
    if (!url) throw new Error('Invalid Stripe URL.');
    return res.json({ url });
  } catch {
    return res.status(502).json({ message: 'Stripe onboarding is unavailable.' });
  } finally {
    release();
  }
});
router.post('/ptr_app/mp/v2/sessions/:id/stripe/dashboard-link', async (req, res) => {
  const user = authenticateRequest(req),
    room = user && requireRoomAccess(user, req.params.id, { manage: true });
  if (!room) return res.status(403).json({ message: 'Room access denied.' });
  if (!stripe.configured()) return res.status(503).json({ message: 'Stripe is not configured.' });
  const account = db.prepare('SELECT * FROM stripe_accounts WHERE room_id=?').get(room.uuid);
  if (!account) return res.status(404).json({ message: 'Stripe account is not connected.' });
  try {
    const link = await stripe.request(
      `accounts/${encodeURIComponent(account.account_id)}/login_links`,
      {},
    );
    const url = stripeURL(link.url);
    if (!url) throw new Error('Invalid Stripe URL.');
    return res.json({ url });
  } catch {
    return res.status(502).json({ message: 'Stripe dashboard is unavailable.' });
  }
});
function roomPayments(roomID, query) {
  const filters = ['p.room_id=?'],
    args = [roomID];
  for (const [field, column, allowed] of [
    ['status', 'p.status', ['succeeded', 'failed', 'pending', 'canceled', 'refunded']],
    ['type', 'p.type', ['one_time', 'subscription', 'subscription_renewal']],
  ]) {
    if (query[field]) {
      if (!allowed.includes(query[field])) throw new Error('Invalid payment filter.');
      filters.push(`${column}=?`);
      args.push(query[field]);
    }
  }
  for (const [field, operator] of [
    ['start_date', '>='],
    ['end_date', '<='],
  ]) {
    if (query[field]) {
      const value = Date.parse(String(query[field]));
      if (!Number.isFinite(value)) throw new Error('Invalid payment date.');
      filters.push(`p.stripe_created_at ${operator} ?`);
      args.push(Math.floor(value / 1000));
    }
  }
  return db
    .prepare(
      `SELECT p.*,o.email,o.name,o.plan_name,o.plan_id FROM marketplace_payments p JOIN marketplace_orders o ON o.id=p.order_id WHERE ${filters.join(' AND ')} ORDER BY p.stripe_created_at DESC`,
    )
    .all(...args);
}
router.get('/ptr_app/mp/v2/sessions/:id/payments', (req, res) => {
  const user = authenticateRequest(req),
    room = user && requireRoomAccess(user, req.params.id, { manage: true });
  if (!room) return res.status(403).json({ message: 'Room access denied.' });
  try {
    const rows = roomPayments(room.uuid, req.query),
      limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25)),
      skip = Math.max(0, Number.parseInt(req.query.skip, 10) || 0);
    const payments = rows.slice(skip, skip + limit).map((row) => ({
      _id: row.id,
      stripeCreatedAt: new Date(row.stripe_created_at * 1000).toISOString(),
      paymentStatus: row.status,
      paymentType: row.type,
      customerEmail: row.email,
      membershipName: row.plan_name,
      amount: row.amount,
      currency: row.currency,
    }));
    return res.json({ payments, total: rows.length });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
router.get('/ptr_app/mp/v2/sessions/:id/revenue-report', (req, res) => {
  const user = authenticateRequest(req),
    room = user && requireRoomAccess(user, req.params.id, { manage: true });
  if (!room) return res.status(403).json({ message: 'Room access denied.' });
  try {
    const rows = roomPayments(room.uuid, req.query).filter((row) =>
        ['succeeded', 'refunded'].includes(row.status),
      ),
      currencies = [...new Set(rows.map((row) => row.currency))];
    if (currencies.length > 1)
      return res.status(409).json({ message: 'Revenue cannot be combined across currencies.' });
    const totalRevenue = rows.reduce(
        (sum, row) => sum + Math.max(0, row.amount - row.refunded_amount),
        0,
      ),
      totalPayments = rows.length;
    const net = (group) =>
      group.every(
        (row) => row.net_amount !== null && (!row.refunded_amount || row.refund_net !== null),
      )
        ? group.reduce((sum, row) => sum + row.net_amount + (row.refund_net || 0), 0)
        : null;
    const revenueByType = [...new Set(rows.map((row) => row.type))].map((type) => {
      const group = rows.filter((row) => row.type === type),
        totalAmount = group.reduce(
          (sum, row) => sum + Math.max(0, row.amount - row.refunded_amount),
          0,
        );
      return {
        _id: { paymentType: type },
        paymentCount: group.length,
        totalAmount,
        totalNetRevenue: net(group),
        avgAmount: totalAmount / group.length,
      };
    });
    const totalNetRevenue = net(rows);
    return res.json({
      summary: {
        totalRevenue,
        totalNetRevenue,
        totalPayments,
        averageAmount: totalPayments ? totalRevenue / totalPayments : 0,
        currency: currencies[0] || 'usd',
      },
      revenueByType,
      netRevenueAvailable: totalNetRevenue !== null,
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
router.get('/ptr_app/mp/v2/sessions/:id/marketplace-users', (req, res) => {
  const user = authenticateRequest(req),
    room = user && requireRoomAccess(user, req.params.id, { manage: true });
  if (!room) return res.status(403).json({ message: 'Room access denied.' });
  const rows = db
    .prepare(
      `SELECT m.id,m.name,m.email,m.created_at,o.plan_id,o.status,(SELECT MAX(a.created_at) FROM audit_events a WHERE a.room_id=m.room_id AND a.actor_id=m.id AND a.action='room_join') AS last_login FROM memberships m JOIN marketplace_orders o ON o.id=(SELECT o2.id FROM marketplace_orders o2 WHERE o2.member_id=m.id ORDER BY o2.created_at DESC,o2.id DESC LIMIT 1) WHERE m.room_id=? ORDER BY m.created_at DESC`,
    )
    .all(room.uuid);
  const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  return res.json({
    users: rows.slice(0, limit).map((row) => ({
      _id: row.id,
      userName: row.name,
      email: row.email,
      stripeMembershipId: row.plan_id,
      stripeSubscriptionStatus: row.status,
      created: row.created_at,
      lastLogin: row.last_login,
    })),
    total: rows.length,
  });
});
router.post('/ptr_app/mp/v2/sessions/:id/users/:userID/grant-temporary-access', (req, res) => {
  const user = authenticateRequest(req),
    room = user && requireRoomAccess(user, req.params.id, { manage: true });
  if (!room) return res.status(403).json({ message: 'Room access denied.' });
  const member = db
    .prepare('SELECT * FROM memberships WHERE id=? AND room_id=?')
    .get(req.params.userID, room.uuid);
  if (!member) return res.status(404).json({ message: 'Participant not found.' });
  const flags = parse(member.flags),
    days = Number(req.body?.daysToGrant),
    reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(days) || days < 1 || days > 365 || reason.length > 500)
    return res
      .status(400)
      .json({ message: 'Enter between 1 and 365 days and a reason of at most 500 characters.' });
  if (
    String(member.role) === '4' ||
    db
      .prepare('SELECT 1 FROM banned_users WHERE room_id=? AND email=?')
      .get(room.uuid, member.email)
  )
    return res
      .status(403)
      .json({ message: 'A banned participant cannot be granted temporary access.' });
  if (member.status === 'suspended' && !flags.stripeSuspended)
    return res.status(409).json({ message: 'This participant was suspended by a room manager.' });
  if (
    !['approved', 'active', 'accepted'].includes(member.status) &&
    !(member.status === 'suspended' && flags.stripeSuspended)
  )
    return res
      .status(409)
      .json({ message: 'This participant is not eligible for temporary access.' });
  flags.temporaryAccess = {
    expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
    reason,
    grantedBy: user.actor_id || user.id,
  };
  db.prepare('UPDATE memberships SET flags=? WHERE id=?').run(JSON.stringify(flags), member.id);
  return res.json({ success: true, temporaryAccess: flags.temporaryAccess });
});
router.post('/ptr_app/mp/v2/sessions/:id/users/:userID/revoke-temporary-access', (req, res) => {
  const user = authenticateRequest(req),
    room = user && requireRoomAccess(user, req.params.id, { manage: true });
  if (!room) return res.status(403).json({ message: 'Room access denied.' });
  const member = db
    .prepare('SELECT * FROM memberships WHERE id=? AND room_id=?')
    .get(req.params.userID, room.uuid);
  if (!member) return res.status(404).json({ message: 'Participant not found.' });
  const flags = parse(member.flags);
  delete flags.temporaryAccess;
  db.prepare('UPDATE memberships SET flags=?,token_version=token_version+1 WHERE id=?').run(
    JSON.stringify(flags),
    member.id,
  );
  return res.json({ success: true });
});
router.get('/ptr_app/mp/v2/list', (req, res) => res.json(publicListings(req)));
router.get('/ptr_app/mp/v2/search', (req, res) => res.json(publicListings(req)));
router.get('/ptr_app/mp/v2/assets/:file', (req, res) => {
  const id = String(req.params.file).replace(/\.(png|jpg|gif|webp|mp4|webm)$/i, '');
  const asset = db
    .prepare(
      'SELECT f.*,m.data,m.id AS listing_id FROM marketplace_assets a JOIN files f ON f.id=a.file_id JOIN marketplaces m ON m.id=a.marketplace_id WHERE f.id=?',
    )
    .get(id);
  if (!asset) return res.status(404).send('Image not found');
  const data = parse(asset.data);
  if (asset.category === 'marketplace_video') {
    const owner = listingAccess(req, asset.listing_id),
      url = `/ptr_app/mp/v2/assets/${req.params.file}`;
    const allowed =
      owner ||
      db
        .prepare('SELECT * FROM marketplace_courses WHERE marketplace_id=?')
        .all(asset.listing_id)
        .some((row) => {
          const course = parse(row.data);
          return (
            (course.sections || []).some((section) =>
              (section.units || []).some((unit) => unit.videoURL === url),
            ) && require('./courses').canView(req, row, course)
          );
        });
    if (!allowed) return res.status(403).send('Course access denied');
  } else if ((!data.published || data.hidden) && !listingAccess(req, asset.listing_id))
    return res.status(403).send('Marketplace access denied');
  const file = path.join(UPLOAD_DIR, path.basename(asset.stored_name));
  if (!fs.existsSync(file)) return res.status(404).send('Image not found');
  res.set({
    'Content-Type': asset.mime_type,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': 'inline',
  });
  return res.sendFile(file);
});
function acceptImages(req, res, next) {
  const row = listingAccess(req, req.params.id);
  if (!row) return res.status(403).json({ message: 'Marketplace access denied.' });
  req.marketplaceRow = row;
  return next();
}
function persistImages(req, res, files, isLogo) {
  if (!files.length) return res.status(400).json({ message: 'An image is required.' });
  const extensions = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  const detected = files.map((file) => mimeFor(file.buffer));
  if (
    detected.some(
      (type, index) =>
        !type ||
        type !== (files[index].mimetype === 'image/jpg' ? 'image/jpeg' : files[index].mimetype),
    )
  )
    return res.status(400).json({ message: 'Unsupported, invalid, or mismatched image format.' });
  const created = [];
  try {
    const user = authenticateRequest(req),
      row = req.marketplaceRow;
    db.exec('BEGIN IMMEDIATE');
    for (const [index, file] of files.entries()) {
      const id = uuidv4(),
        stored = crypto.randomBytes(24).toString('hex'),
        filename = path.join(UPLOAD_DIR, stored);
      fs.writeFileSync(filename, file.buffer, { flag: 'wx', mode: 0o600 });
      created.push(filename);
      db.prepare(
        'INSERT INTO files (id,room_id,uploader_id,uploader_name,original_name,stored_name,mime_type,size_bytes,visibility,category) VALUES (?,?,?,?,?,?,?,?,1,?)',
      ).run(
        id,
        row.session_id,
        user.actor_id || user.id,
        user.name || '',
        path.basename(file.originalname).slice(0, 200),
        stored,
        detected[index],
        file.size,
        'marketplace',
      );
      db.prepare('INSERT INTO marketplace_assets(file_id,marketplace_id) VALUES(?,?)').run(
        id,
        row.id,
      );
      file.publicURL = `/ptr_app/mp/v2/assets/${id}.${extensions[detected[index]]}`;
    }
    const urls = files.map((file) => file.publicURL),
      changes = isLogo
        ? { logoURL: urls[0] }
        : { images: [...(parse(row.data).images || []), ...urls] };
    saveListing(row, changes);
    db.exec('COMMIT');
    return res.json(isLogo ? { logoURL: urls[0] } : { images: urls });
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {}
    for (const file of created)
      try {
        fs.unlinkSync(file);
      } catch {}
    return res.status(500).json({ message: 'Image upload failed.' });
  }
}
router.post('/ptr_app/mp/v2/:id/logo', acceptImages, (req, res) =>
  imageUpload.single('logo')(req, res, (error) =>
    error
      ? res.status(400).json({ message: 'Invalid image upload.' })
      : persistImages(req, res, req.file ? [req.file] : [], true),
  ),
);
router.post('/ptr_app/mp/v2/:id/images', acceptImages, (req, res) =>
  imageUpload.array('images', 5)(req, res, (error) =>
    error
      ? res.status(400).json({ message: 'Invalid image upload.' })
      : persistImages(req, res, req.files || [], false),
  ),
);
router.delete('/ptr_app/mp/v2/:id/images/:index', acceptImages, (req, res) => {
  const row = req.marketplaceRow,
    images = parse(row.data).images || [],
    index = Number(req.params.index);
  if (!Number.isInteger(index) || index < -1 || index >= images.length)
    return res.status(400).json({ message: 'Invalid image index.' });
  const removed = index === -1 ? images : [images[index]],
    remaining = index === -1 ? [] : images.filter((_, position) => position !== index);
  try {
    db.exec('BEGIN IMMEDIATE');
    saveListing(row, { images: remaining });
    const listingJSON = JSON.stringify({ ...parse(row.data), images: remaining }),
      courses = db
        .prepare('SELECT data FROM marketplace_courses WHERE marketplace_id=?')
        .all(row.id);
    for (const url of removed) {
      if (
        typeof url !== 'string' ||
        listingJSON.includes(url) ||
        courses.some((course) => course.data.includes(url))
      )
        continue;
      const match = url.match(/^\/ptr_app\/mp\/v2\/assets\/([a-f0-9-]+)\.(?:png|jpg|gif|webp)$/i);
      if (match)
        db.prepare('DELETE FROM marketplace_assets WHERE file_id=? AND marketplace_id=?').run(
          match[1],
          row.id,
        );
    }
    db.exec('COMMIT');
    return res.json({ message: 'Images removed.' });
  } catch {
    try {
      db.exec('ROLLBACK');
    } catch {}
    return res.status(500).json({ message: 'Images could not be removed.' });
  }
});
router.post('/ptr_app/mp/v2/:id/videos', acceptImages, (req, res) =>
  videoUpload.array('videos', 5)(req, res, (error) => {
    const files = req.files || [],
      dispose = () => {
        for (const file of files)
          try {
            fs.unlinkSync(file.path);
          } catch {}
      };
    if (error) {
      dispose();
      return res.status(400).json({ message: 'Invalid video upload.' });
    }
    if (!files.length) return res.status(400).json({ message: 'A video is required.' });
    const types = [];
    try {
      for (const file of files) {
        const fd = fs.openSync(file.path, 'r'),
          header = Buffer.alloc(16);
        let count;
        try {
          count = fs.readSync(fd, header, 0, header.length, 0);
        } finally {
          fs.closeSync(fd);
        }
        const mp4 = count >= 12 && header.toString('ascii', 4, 8) === 'ftyp',
          webm = count >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
        const type = mp4 ? 'video/mp4' : webm ? 'video/webm' : null;
        if (!type || type !== file.mimetype) throw new Error('Invalid video format.');
        types.push(type);
      }
    } catch {
      dispose();
      return res.status(400).json({ message: 'Only valid MP4 or WebM videos are supported.' });
    }
    try {
      const user = authenticateRequest(req),
        row = req.marketplaceRow,
        urls = [];
      db.exec('BEGIN IMMEDIATE');
      for (const [index, file] of files.entries()) {
        const id = uuidv4(),
          extension = types[index] === 'video/mp4' ? 'mp4' : 'webm';
        db.prepare(
          'INSERT INTO files (id,room_id,uploader_id,uploader_name,original_name,stored_name,mime_type,size_bytes,visibility,category) VALUES (?,?,?,?,?,?,?,?,1,?)',
        ).run(
          id,
          row.session_id,
          user.actor_id || user.id,
          user.name || '',
          path.basename(file.originalname).slice(0, 200),
          file.filename,
          types[index],
          file.size,
          'marketplace_video',
        );
        db.prepare('INSERT INTO marketplace_assets(file_id,marketplace_id) VALUES(?,?)').run(
          id,
          row.id,
        );
        urls.push(`/ptr_app/mp/v2/assets/${id}.${extension}`);
      }
      db.exec('COMMIT');
      return res.json({ videos: urls });
    } catch {
      try {
        db.exec('ROLLBACK');
      } catch {}
      dispose();
      return res.status(500).json({ message: 'Video upload failed.' });
    }
  }),
);
router.get('/ptr_app/mp/v2/public/marketplace/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM marketplaces WHERE id=?').get(req.params.id);
  const data = row && listing(row);
  if (!data || !data.published || data.hidden)
    return res.status(404).json({ message: 'Marketplace not found.' });
  return res.json(data);
});
router.get('/ptr_app/mp/v2/public/marketplace/:id/memberships', (req, res) => {
  const row = db.prepare('SELECT * FROM marketplaces WHERE id=?').get(req.params.id),
    data = row && listing(row);
  if (!data || !data.published || data.hidden)
    return res.status(404).json({ message: 'Marketplace not found.' });
  return res.json(data.memberships);
});
router.get('/ptr_app/mp/v2/marketplaces/:sessID', (req, res) => {
  const user = authenticateRequest(req),
    room = user && requireRoomAccess(user, req.params.sessID, { manage: true });
  if (!room) return res.status(403).json({ message: 'Room access denied.' });
  return res.json(
    db.prepare('SELECT * FROM marketplaces WHERE session_id=?').all(room.uuid).map(listing),
  );
});
router.post('/ptr_app/mp/v2/', (req, res) => {
  const user = authenticateRequest(req),
    b = req.body || {},
    requested = b.sessionID;
  const room = user && requested && requireRoomAccess(user, requested, { manage: true });
  if (!room) return res.status(403).json({ success: false, message: 'Room access denied.' });
  if (!validRoomURL(b.logoURL))
    return res
      .status(400)
      .json({ success: false, message: 'Enter an HTTP(S) URL or a same-origin relative path.' });
  let data;
  try {
    data = cleanListing(b);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
  data.published = false;
  const id = uuidv4(),
    roomId = room.uuid;
  db.prepare(
    'INSERT INTO marketplaces (id,session_id,owner_id,title,logo_url,data) VALUES (?,?,?,?,?,?)',
  ).run(
    id,
    roomId,
    user.id,
    data.title || 'Trading Room',
    data.logoURL || '',
    JSON.stringify(data),
  );
  return res.json(listing(db.prepare('SELECT * FROM marketplaces WHERE id=?').get(id)));
});
router.get('/ptr_app/mp/v2/:id/memberships', (req, res) => {
  const row = listingAccess(req, req.params.id);
  if (!row) return res.status(403).json({ message: 'Marketplace access denied.' });
  return res.json(listing(row).memberships);
});
router.get('/ptr_app/mp/v2/:id/memberships/:planID', (req, res) => {
  const row = listingAccess(req, req.params.id),
    membership =
      row &&
      db
        .prepare('SELECT * FROM marketplace_plans WHERE id=? AND marketplace_id=?')
        .get(req.params.planID, row.id);
  if (!membership) return res.status(404).json({ message: 'Membership not found.' });
  return res.json(plan(membership));
});
router.post('/ptr_app/mp/v2/:id/memberships', (req, res) => {
  const row = listingAccess(req, req.params.id);
  if (!row) return res.status(403).json({ message: 'Marketplace access denied.' });
  const data = { ...(req.body || {}) };
  delete data._id;
  delete data.id;
  const id = uuidv4();
  db.prepare('INSERT INTO marketplace_plans (id,marketplace_id,data) VALUES (?,?,?)').run(
    id,
    row.id,
    JSON.stringify(data),
  );
  return res.json(plan(db.prepare('SELECT * FROM marketplace_plans WHERE id=?').get(id)));
});
router.put('/ptr_app/mp/v2/:id/memberships/:planID', (req, res) => {
  const row = listingAccess(req, req.params.id),
    existing =
      row &&
      db
        .prepare('SELECT * FROM marketplace_plans WHERE id=? AND marketplace_id=?')
        .get(req.params.planID, row.id);
  if (!existing) return res.status(404).json({ message: 'Membership not found.' });
  const data = { ...parse(existing.data), ...(req.body || {}) };
  delete data._id;
  delete data.id;
  db.prepare('UPDATE marketplace_plans SET data=? WHERE id=?').run(
    JSON.stringify(data),
    existing.id,
  );
  return res.json(plan(db.prepare('SELECT * FROM marketplace_plans WHERE id=?').get(existing.id)));
});
router.delete('/ptr_app/mp/v2/:id/memberships/:planID', (req, res) => {
  const row = listingAccess(req, req.params.id);
  if (!row) return res.status(403).json({ message: 'Marketplace access denied.' });
  const result = db
    .prepare('DELETE FROM marketplace_plans WHERE id=? AND marketplace_id=?')
    .run(req.params.planID, row.id);
  return result.changes
    ? res.json({ success: true })
    : res.status(404).json({ message: 'Membership not found.' });
});
router.put('/ptr_app/mp/v2/:id/reorder', (req, res) => {
  const row = listingAccess(req, req.params.id),
    orders = req.body?.orders;
  if (!row) return res.status(403).json({ message: 'Marketplace access denied.' });
  if (!Array.isArray(orders)) return res.status(400).json({ message: 'Invalid membership order.' });
  const plans = db.prepare('SELECT * FROM marketplace_plans WHERE marketplace_id=?').all(row.id);
  const updates = [],
    seen = new Set();
  for (const [index, entry] of orders.entries()) {
    const id = typeof entry === 'string' ? entry : entry?._id || entry?.id;
    const current = plans.find((p) => p.id === id);
    if (!current || seen.has(id))
      return res.status(400).json({ message: 'Unknown or duplicate membership in order.' });
    seen.add(id);
    updates.push({
      id,
      data: JSON.stringify({
        ...parse(current.data),
        order: typeof entry === 'object' && Number.isFinite(entry.order) ? entry.order : index,
      }),
    });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of updates)
      db.prepare('UPDATE marketplace_plans SET data=? WHERE id=?').run(item.data, item.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return res.json({ success: true });
});
router.put('/ptr_app/mp/v2/:id/published', (req, res) => {
  const row = listingAccess(req, req.params.id);
  if (!row) return res.status(403).json({ message: 'Marketplace access denied.' });
  try {
    return res.json(saveListing(row, { published: req.body?.published }));
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
router.put('/ptr_app/mp/v2/:id/field', (req, res) => {
  const row = listingAccess(req, req.params.id),
    field = req.body?.field;
  if (!row) return res.status(403).json({ message: 'Marketplace access denied.' });
  if (!listingFields.includes(field))
    return res.status(400).json({ message: 'Unsupported listing field.' });
  try {
    return res.json(saveListing(row, { [field]: req.body.value }));
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
router.get('/ptr_app/mp/v2/:id', (req, res) => {
  const row = listingAccess(req, req.params.id);
  if (!row) return res.status(403).json({ message: 'Marketplace access denied.' });
  return res.json(listing(row));
});
router.put('/ptr_app/mp/v2/:id', (req, res) => {
  const row = listingAccess(req, req.params.id);
  if (!row) return res.status(403).json({ message: 'Marketplace access denied.' });
  try {
    return res.json(saveListing(row, req.body || {}));
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
});
router.post('/ptr_app/mp/v2/resend-welcome-email', async (req, res) => {
  const user = authenticateRequest(req),
    b = req.body || {};
  const room = user && requireRoomAccess(user, b.sessionId, { manage: true });
  if (!room) return res.status(403).json({ success: false, message: 'Room access denied.' });
  const member = db
    .prepare('SELECT * FROM memberships WHERE id=? AND room_id=?')
    .get(b.xrefId, room.uuid);
  if (!member) return res.status(404).json({ success: false, message: 'Participant not found.' });
  if (!process.env.SMTP_HOST)
    return res.status(503).json({ success: false, message: 'Email delivery is unavailable.' });
  const password = crypto.randomBytes(12).toString('hex');
  try {
    await sendMail({
      roomID: room.uuid,
      to: member.email,
      subject: 'Your room login',
      text: `Room: ${process.env.PUBLIC_ORIGIN || 'http://localhost:3000'}/ptrApp#/page/login/${room.uuid}\nEmail: ${member.email}\nPassword: ${password}`,
    });
  } catch {
    return res.status(503).json({ success: false, message: 'Email delivery failed.' });
  }
  db.prepare('UPDATE memberships SET password_hash=?,token_version=token_version+1 WHERE id=?').run(
    bcrypt.hashSync(password, 10),
    member.id,
  );
  return res.json({ success: true });
});
module.exports = router;
