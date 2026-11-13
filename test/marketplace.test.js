const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-marketplace-'));
const express = require('express'),
  db = require('../src/db/database');
const mail = require('../src/services/mail');
const sent = [];
mail.sendMail = async (message) => {
  sent.push(message);
  return { success: true };
};
const stripe = require('../src/services/stripe');
const app = express();
app.use('/ptr_app/mp/v2/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/users/v1', require('../src/routes/users'));
app.use('/ptr_app/courses/v2', require('../src/routes/courses'));
app.use(require('../src/routes/marketplace'));

test('marketplace listings and plans are persistent, room scoped, and public only when published', async (t) => {
  process.env.SMTP_HOST = 'localhost';
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(method, url, body, token) {
    const response = await fetch(base + url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const owner = (
    await request('POST', '/users/v1/signup', {
      name: 'Owner',
      email: 'owner@example.test',
      pw: 'password123',
    })
  ).body;
  const other = (
    await request('POST', '/users/v1/signup', {
      name: 'Other',
      email: 'other@example.test',
      pw: 'password123',
    })
  ).body;
  const room = db.prepare('SELECT id FROM sessions WHERE uuid=?').get(owner.roomUUID);
  const root = '/ptr_app/mp/v2';
  assert.equal((await request('GET', `${root}/marketplaces/${room.id}`)).status, 403);
  const created = await request(
    'POST',
    root + '/',
    { sessionID: room.id, title: 'Trading room', published: true },
    owner.token,
  );
  assert.equal(created.status, 200);
  assert.equal(created.body.published, false);
  assert.equal(created.body.sessionID, room.id);
  const id = created.body._id;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aE0AAAAASUVORK5CYII=',
    'base64',
  );
  const form = new FormData();
  form.append('logo', new Blob([png], { type: 'image/png' }), 'logo.png');
  const uploaded = await fetch(base + `${root}/${id}/logo`, {
    method: 'POST',
    headers: { authorization: `Bearer ${owner.token}` },
    body: form,
  });
  assert.equal(uploaded.status, 200);
  const logo = (await uploaded.json()).logoURL;
  assert.equal((await fetch(base + logo)).status, 403);
  assert.equal(
    (await fetch(base + logo, { headers: { authorization: `Bearer ${owner.token}` } })).status,
    200,
  );
  assert.equal((await request('GET', `${root}/public/marketplace/${id}`)).status, 404);
  assert.equal(
    (await request('PUT', `${root}/${id}/field`, { field: 'title', value: 'Stolen' }, other.token))
      .status,
    403,
  );
  const membership = await request(
    'POST',
    `${root}/${id}/memberships`,
    { name: 'Monthly', price: 20 },
    owner.token,
  );
  assert.equal(membership.status, 200);
  assert.equal(membership.body.name, 'Monthly');
  assert.equal(
    (
      await request(
        'PUT',
        `${root}/${id}/memberships/${membership.body._id}`,
        { price: 25 },
        owner.token,
      )
    ).body.price,
    25,
  );
  assert.equal(
    (await request('GET', `${root}/${id}/memberships`, null, owner.token)).body.length,
    1,
  );
  assert.equal(
    (
      await request(
        'PUT',
        `${root}/${id}/field`,
        { field: 'logoURL', value: 'javascript:alert(1)' },
        owner.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (await request('PUT', `${root}/${id}/published`, { published: true }, owner.token)).body
      .published,
    true,
  );
  assert.equal((await fetch(base + logo)).status, 200);
  assert.equal(
    (await request('GET', `${root}/public/marketplace/${id}`)).body.memberships[0].price,
    25,
  );
  assert.equal((await request('GET', `${root}/search?q=Trading`)).body.marketplaces.length, 1);
  const free = (
    await request(
      'POST',
      `${root}/${id}/memberships`,
      { planName: 'Free', isFree: true, amount: 0, currency: 'usd', isActive: true },
      owner.token,
    )
  ).body;
  assert.equal(
    (
      await request('POST', `${root}/${id}/memberships/${free._id}/free-access`, {
        customerEmail: 'free@example.test',
        customerName: 'Free Member',
      })
    ).status,
    200,
  );
  assert.equal(sent.at(-1).to, 'free@example.test');
  assert.equal(
    (await request('GET', `${root}/sessions/${room.id}/marketplace-users`, null, owner.token)).body
      .users[0].email,
    'free@example.test',
  );
  assert.equal(
    (await request('DELETE', `${root}/${id}/memberships/${membership.body._id}`, null, owner.token))
      .status,
    200,
  );
  assert.equal(
    (await request('GET', `${root}/${id}/memberships`, null, owner.token)).body.length,
    1,
  );
});

test('published paid course lessons and video require a linked active membership', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`,
    market = '/ptr_app/mp/v2',
    courses = '/ptr_app/courses/v2';
  async function request(method, url, body, token, cookie) {
    const response = await fetch(base + url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const owner = (
    await request('POST', '/users/v1/signup', {
      name: 'Course owner',
      email: 'courses@example.test',
      pw: 'password123',
    })
  ).body;
  const room = db.prepare('SELECT * FROM sessions WHERE uuid=?').get(owner.roomUUID);
  const listing = (
    await request(
      'POST',
      market + '/',
      { sessionID: room.id, title: 'Course marketplace' },
      owner.token,
    )
  ).body;
  const membership = (
    await request(
      'POST',
      `${market}/${listing._id}/memberships`,
      { planName: 'Course', amount: 1200, currency: 'usd' },
      owner.token,
    )
  ).body;
  const form = new FormData();
  form.append(
    'videos',
    new Blob([Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])], {
      type: 'video/mp4',
    }),
    'lesson.mp4',
  );
  const upload = await fetch(base + `${market}/${listing._id}/videos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${owner.token}` },
    body: form,
  });
  assert.equal(upload.status, 200);
  const video = (await upload.json()).videos[0];
  assert.equal((await fetch(base + video)).status, 403);
  const created = await request(
    'POST',
    `${courses}/marketplace/${listing._id}`,
    {
      name: 'Advanced course',
      currency: 'usd',
      membershipIds: [membership._id],
      sections: [
        {
          title: 'Part one',
          units: [{ title: 'Lesson', notes: 'Private notes', videoURL: video }],
        },
      ],
    },
    owner.token,
  );
  assert.equal(created.status, 200);
  const id = created.body._id;
  assert.equal((await request('GET', `${courses}/${id}/public`)).status, 404);
  assert.equal(
    (await request('PUT', `${courses}/${id}/publish`, { isPublished: true }, owner.token)).status,
    200,
  );
  const preview = await request('GET', `${courses}/${id}/public`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.sections[0].units[0].notes, undefined);
  assert.equal((await request('GET', `${courses}/${id}/access`)).body.hasAccess, false);
  assert.equal((await fetch(base + video)).status, 403);
  assert.equal((await request('PUT', `${courses}/${id}`, { price: 0 }, owner.token)).status, 200);
  const zeroPricePreview = await request('GET', `${courses}/${id}/public`);
  assert.equal(zeroPricePreview.body.sections[0].units[0].notes, undefined);
  assert.equal((await request('GET', `${courses}/${id}/access`)).body.hasAccess, false);
  assert.equal((await fetch(base + video)).status, 403);
  const memberID = crypto.randomUUID();
  db.prepare('INSERT INTO memberships(id,room_id,email,name,role,status) VALUES(?,?,?,?,?,?)').run(
    memberID,
    room.uuid,
    'course-buyer@example.test',
    'Buyer',
    '2',
    'approved',
  );
  db.prepare(
    "INSERT INTO marketplace_orders(id,room_id,marketplace_id,plan_id,account_id,email,name,amount,currency,status,member_id) VALUES(?,?,?,?,?,?,?,?,?,'active',?)",
  ).run(
    crypto.randomUUID(),
    room.uuid,
    listing._id,
    membership._id,
    'acct_fixture',
    'course-buyer@example.test',
    'Buyer',
    1200,
    'usd',
    memberID,
  );
  const auth = require('../src/middleware/auth'),
    token = auth.signRoomToken({ id: memberID, memberId: memberID, version: 0 }, room),
    cookie = `prt_room_${room.uuid}=${token}`;
  assert.equal(
    (await request('GET', `${courses}/${id}/access`, null, null, cookie)).body.hasAccess,
    true,
  );
  assert.equal(
    (await request('GET', `${courses}/${id}`, null, null, cookie)).body.sections[0].units[0].notes,
    'Private notes',
  );
  assert.equal((await fetch(base + video, { headers: { cookie } })).status, 200);
  db.prepare("UPDATE marketplace_orders SET status='cancelled' WHERE member_id=?").run(memberID);
  assert.equal((await fetch(base + video, { headers: { cookie } })).status, 403);
});

test('Stripe Connect checkout uses stored prices and signed idempotent paid webhooks', async (t) => {
  sent.length = 0;
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture';
  process.env.SMTP_HOST = 'localhost';
  process.env.PUBLIC_ORIGIN = 'http://localhost:3000';
  const calls = [];
  let refundAvailable = false;
  const original = stripe.request;
  stripe.request = async (path, values, account) => {
    calls.push({ path, values, account });
    if (path === 'accounts') return { id: 'acct_fixture' };
    if (path === 'account_links') return { url: 'https://connect.stripe.com/setup' };
    if (path === 'checkout/sessions')
      return {
        id:
          calls.filter((item) => item.path === 'checkout/sessions').length === 1
            ? 'cs_fixture'
            : 'cs_subfixture',
        url: 'https://checkout.stripe.com/pay/fixture',
      };
    if (path === 'balance_transactions/txn_one')
      return { id: 'txn_one', amount: 1200, fee: 60, net: 1140, currency: 'usd' };
    if (path === 'balance_transactions/txn_sub')
      return { id: 'txn_sub', amount: 2400, fee: 100, net: 2300, currency: 'usd' };
    if (path === 'balance_transactions/txn_refund' && refundAvailable)
      return { id: 'txn_refund', amount: -2400, fee: 0, net: -2400, currency: 'usd' };
    if (path === 'charges/ch_fixture/refunds')
      return {
        has_more: false,
        data: [{ id: 're_fixture', amount: 2400, balance_transaction: 'txn_refund' }],
      };
    throw new Error('Unexpected provider call');
  };
  t.after(() => {
    stripe.request = original;
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`,
    root = '/ptr_app/mp/v2';
  async function request(method, url, body, token, headers = {}) {
    const response = await fetch(base + url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const owner = (
    await request('POST', '/users/v1/signup', {
      name: 'Stripe Owner',
      email: 'stripe-owner@example.test',
      pw: 'password123',
    })
  ).body;
  const room = db.prepare('SELECT id FROM sessions WHERE uuid=?').get(owner.roomUUID);
  assert.equal(
    (
      await request(
        'POST',
        `${root}/sessions/${room.id}/stripe/account-link`,
        { returnUrl: 'http://localhost:3000/mp/', refreshUrl: 'http://localhost:3000/mp/' },
        owner.token,
      )
    ).status,
    200,
  );
  const listing = (
    await request('POST', root + '/', { sessionID: room.id, title: 'Paid room' }, owner.token)
  ).body;
  const membership = (
    await request(
      'POST',
      `${root}/${listing._id}/memberships`,
      { planName: 'One-time', amount: 1200, currency: 'usd', isActive: true },
      owner.token,
    )
  ).body;
  await request('PUT', `${root}/${listing._id}/published`, { published: true }, owner.token);
  const checkout = await request(
    'POST',
    `${root}/${listing._id}/memberships/${membership._id}/checkout`,
    {
      customerEmail: 'buyer@example.test',
      customerName: 'Buyer',
      successUrl: 'http://localhost:3000/mp/success',
      cancelUrl: 'http://localhost:3000/mp/cancel',
      amount: 1,
    },
  );
  assert.equal(checkout.status, 200);
  assert.equal(checkout.body.url, 'https://checkout.stripe.com/pay/fixture');
  const call = calls.find((item) => item.path === 'checkout/sessions');
  assert.equal(call.values['line_items[0][price_data][unit_amount]'], 1200);
  assert.equal(call.account, 'acct_fixture');
  const order = db.prepare('SELECT * FROM marketplace_orders WHERE session_id=?').get('cs_fixture');
  const event = {
    id: 'evt_fixture',
    type: 'checkout.session.completed',
    account: 'acct_fixture',
    data: {
      object: {
        id: 'cs_fixture',
        payment_intent: 'pi_one',
        payment_status: 'paid',
        amount_total: 1200,
        currency: 'usd',
        metadata: { orderID: order.id },
      },
    },
  };
  const payload = JSON.stringify(event),
    timestamp = Math.floor(Date.now() / 1000),
    signature = crypto
      .createHmac('sha256', 'whsec_fixture')
      .update(`${timestamp}.${payload}`)
      .digest('hex');
  assert.equal(
    (
      await request('POST', root + '/stripe/webhook', payload, null, {
        'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)}`,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('POST', root + '/stripe/webhook', payload, null, {
        'stripe-signature': `t=${timestamp},v1=${signature}`,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('POST', root + '/stripe/webhook', payload, null, {
        'stripe-signature': `t=${timestamp},v1=${signature}`,
      })
    ).status,
    200,
  );
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes(`/u/${owner.roomUUID}`));
  assert.equal(
    db.prepare('SELECT status FROM marketplace_orders WHERE id=?').get(order.id).status,
    'paid',
  );
  assert.equal(
    db
      .prepare('SELECT role FROM memberships WHERE room_id=? AND email=?')
      .get(owner.roomUUID, 'buyer@example.test').role,
    '2',
  );
  const recurring = (
    await request(
      'POST',
      `${root}/${listing._id}/memberships`,
      {
        planName: 'Monthly',
        amount: 2400,
        currency: 'usd',
        isActive: true,
        recurring: true,
        recurringPeriod: 'monthly',
        recurringIntervalCount: 1,
        trialPeriodDays: 7,
      },
      owner.token,
    )
  ).body;
  assert.equal(
    (
      await request('POST', `${root}/${listing._id}/memberships/${recurring._id}/checkout`, {
        customerEmail: 'subscriber@example.test',
        customerName: 'Subscriber',
        successUrl: 'http://localhost:3000/mp/success',
        cancelUrl: 'http://localhost:3000/mp/cancel',
      })
    ).status,
    200,
  );
  const subscriptionCall = calls.filter((item) => item.path === 'checkout/sessions')[1];
  assert.equal(subscriptionCall.values.mode, 'subscription');
  assert.equal(subscriptionCall.values['subscription_data[trial_period_days]'], 7);
  assert.equal(subscriptionCall.values['line_items[0][price_data][recurring][interval]'], 'month');
  const subOrder = db
    .prepare('SELECT * FROM marketplace_orders WHERE session_id=?')
    .get('cs_subfixture');
  async function webhook(item) {
    const raw = JSON.stringify(item),
      time = Math.floor(Date.now() / 1000),
      sig = crypto.createHmac('sha256', 'whsec_fixture').update(`${time}.${raw}`).digest('hex');
    return request('POST', root + '/stripe/webhook', raw, null, {
      'stripe-signature': `t=${time},v1=${sig}`,
    });
  }
  assert.equal(
    (
      await webhook({
        id: 'evt_trial',
        created: 100,
        type: 'checkout.session.completed',
        account: 'acct_fixture',
        data: {
          object: {
            id: 'cs_subfixture',
            payment_status: 'no_payment_required',
            amount_total: 0,
            currency: 'usd',
            subscription: 'sub_fixture',
            metadata: { orderID: subOrder.id },
          },
        },
      })
    ).status,
    200,
  );
  let subscriber = db
    .prepare('SELECT * FROM memberships WHERE room_id=? AND email=?')
    .get(owner.roomUUID, 'subscriber@example.test');
  assert.equal(subscriber.status, 'approved');
  assert.equal(
    (
      await webhook({
        id: 'evt_invoice',
        created: 101,
        type: 'invoice.paid',
        account: 'acct_fixture',
        data: {
          object: {
            id: 'in_fixture',
            subscription: 'sub_fixture',
            payment_intent: 'pi_fixture',
            amount_paid: 2400,
            currency: 'usd',
            billing_reason: 'subscription_cycle',
          },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await webhook({
        id: 'evt_cancel',
        created: 102,
        type: 'customer.subscription.deleted',
        account: 'acct_fixture',
        data: { object: { id: 'sub_fixture', status: 'canceled' } },
      })
    ).status,
    200,
  );
  subscriber = db.prepare('SELECT * FROM memberships WHERE id=?').get(subscriber.id);
  assert.equal(subscriber.status, 'suspended');
  assert.equal(
    (
      await webhook({
        id: 'evt_old',
        created: 101,
        type: 'customer.subscription.updated',
        account: 'acct_fixture',
        data: { object: { id: 'sub_fixture', status: 'active' } },
      })
    ).status,
    200,
  );
  assert.equal(
    db.prepare('SELECT status FROM memberships WHERE id=?').get(subscriber.id).status,
    'suspended',
  );
  assert.equal(
    (
      await webhook({
        id: 'evt_reactivate',
        created: 103,
        type: 'customer.subscription.updated',
        account: 'acct_fixture',
        data: { object: { id: 'sub_fixture', status: 'active' } },
      })
    ).status,
    200,
  );
  assert.equal(
    db.prepare('SELECT status FROM memberships WHERE id=?').get(subscriber.id).status,
    'approved',
  );
  const refundEvent = {
    id: 'evt_refund',
    created: 104,
    type: 'charge.refunded',
    account: 'acct_fixture',
    data: {
      object: {
        id: 'ch_fixture',
        payment_intent: 'pi_fixture',
        amount: 2400,
        amount_refunded: 2400,
        refunds: { has_more: true, data: [] },
      },
    },
  };
  assert.equal((await webhook(refundEvent)).status, 503);
  refundAvailable = true;
  assert.equal((await webhook(refundEvent)).status, 200);
  assert.equal(
    db.prepare('SELECT status FROM memberships WHERE id=?').get(subscriber.id).status,
    'approved',
  );
  assert.equal(
    (
      await webhook({
        id: 'evt_cancel_final',
        created: 105,
        type: 'customer.subscription.deleted',
        account: 'acct_fixture',
        data: { object: { id: 'sub_fixture', status: 'canceled' } },
      })
    ).status,
    200,
  );
  assert.equal(
    db.prepare('SELECT status FROM memberships WHERE id=?').get(subscriber.id).status,
    'suspended',
  );
  const grant = await request(
    'POST',
    `${root}/sessions/${room.id}/users/${subscriber.id}/grant-temporary-access`,
    { daysToGrant: 3, reason: 'Review' },
    owner.token,
  );
  assert.equal(grant.status, 200);
  subscriber = db.prepare('SELECT * FROM memberships WHERE id=?').get(subscriber.id);
  const auth = require('../src/middleware/auth');
  assert.equal(
    !!auth.authorizeRoom({
      roomID: owner.roomUUID,
      email: 'subscriber@example.test',
      token: auth.signRoomToken(
        { id: subscriber.id, memberId: subscriber.id, version: subscriber.token_version },
        db.prepare('SELECT * FROM sessions WHERE uuid=?').get(owner.roomUUID),
      ),
    }).identity,
    true,
  );
  assert.equal(
    (
      await request(
        'POST',
        `${root}/sessions/${room.id}/users/${subscriber.id}/revoke-temporary-access`,
        {},
        owner.token,
      )
    ).status,
    200,
  );
  const payments = await request('GET', `${root}/sessions/${room.id}/payments`, null, owner.token);
  assert.equal(payments.status, 200);
  assert.equal(payments.body.total, 2);
  assert.ok(payments.body.payments.some((item) => item.paymentStatus === 'refunded'));
  const report = await request(
    'GET',
    `${root}/sessions/${room.id}/revenue-report`,
    null,
    owner.token,
  );
  assert.equal(report.body.summary.totalRevenue, 1200);
  assert.equal(report.body.summary.totalNetRevenue, null);
  assert.equal(
    (
      await webhook({
        id: 'evt_balance_pending',
        created: 106,
        type: 'charge.succeeded',
        account: 'acct_fixture',
        data: { object: { payment_intent: 'pi_one' } },
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await webhook({
        id: 'evt_balance_one',
        created: 107,
        type: 'charge.succeeded',
        account: 'acct_fixture',
        data: { object: { payment_intent: 'pi_one', balance_transaction: 'txn_one' } },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await webhook({
        id: 'evt_balance_sub',
        created: 108,
        type: 'charge.updated',
        account: 'acct_fixture',
        data: { object: { payment_intent: 'pi_fixture', balance_transaction: 'txn_sub' } },
      })
    ).status,
    200,
  );
  const netReport = await request(
    'GET',
    `${root}/sessions/${room.id}/revenue-report`,
    null,
    owner.token,
  );
  assert.equal(netReport.body.summary.totalNetRevenue, 1040);
  assert.equal(
    calls.find((item) => item.path === 'balance_transactions/txn_one').account,
    'acct_fixture',
  );
});
