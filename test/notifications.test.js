const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-notifications-'));
const db = require('../src/db/database');
const notifications = require('../src/services/notifications');
const jwt = require('jsonwebtoken');

test('configured SMS and FCM adapters use fixed provider APIs, respect recipients, and never invent delivery', async () => {
  db.prepare(
    "INSERT INTO users(id,name,email,password_hash) VALUES('owner','Owner','owner@notify.test','x')",
  ).run();
  const settings = {
    hasAlertTxt: true,
    twillioApiSID: 'AC' + 'a'.repeat(32),
    twillioApiToken: 'private-test-secret',
    twilioPhone: '+12025550100',
    textList: '+12025550101\n2025550102',
  };
  db.prepare("INSERT INTO sessions(uuid,owner_id,name,settings) VALUES('one','owner','One',?)").run(
    JSON.stringify(settings),
  );
  db.prepare(
    "INSERT INTO memberships(id,room_id,name,email,flags) VALUES('viewer','one','Viewer','viewer@notify.test',?)",
  ).run(JSON.stringify({ fcmTokens: ['test-fcm-token'] }));
  const nativeFetch = global.fetch,
    calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('oauth2'))
      return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }));
    if (String(url).includes('twilio'))
      return new Response(JSON.stringify({ sid: 'SM' + 'a'.repeat(32), status: 'queued' }));
    return new Response(JSON.stringify({ name: 'projects/test-project/messages/message-1' }));
  };
  try {
    delete process.env.TWILIO_SMS_ENABLED;
    delete process.env.FCM_ENABLED;
    await assert.rejects(
      notifications.sendSMS({ roomID: 'one', text: 'Local unit test' }),
      /not configured/,
    );
    await assert.rejects(
      notifications.sendPush({ roomID: 'one', text: 'Local unit test' }),
      /not configured/,
    );
    assert.equal(calls.length, 0);
    process.env.TWILIO_SMS_ENABLED = 'true';
    const sms = await notifications.sendSMS({
      roomID: 'one',
      text: 'Local unit test',
      alertID: 'sms-one',
    });
    assert.equal(sms.accepted, 2);
    assert.ok(
      calls.every(
        (c) =>
          c.url ===
          `https://api.twilio.com/2010-04-01/Accounts/${settings.twillioApiSID}/Messages.json`,
      ),
    );
    assert.equal(new URLSearchParams(calls[1].init.body).get('To'), '+12025550102');
    assert.equal(
      (await notifications.sendSMS({ roomID: 'one', text: 'Local unit test', alertID: 'sms-one' }))
        .skipped,
      2,
    );
    assert.equal(calls.length, 2);
    const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: 'test-project',
      client_email: 'sender@test-project.iam.gserviceaccount.com',
      private_key: key.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    });
    process.env.FCM_ENABLED = 'true';
    assert.equal(
      (
        await notifications.sendPush({
          roomID: 'one',
          text: 'Local unit test',
          alertID: 'push-one',
        })
      ).accepted,
      1,
    );
    const oauth = calls.find((c) => c.url === 'https://oauth2.googleapis.com/token');
    const assertion = new URLSearchParams(oauth.init.body).get('assertion');
    assert.equal(
      jwt.verify(assertion, key.publicKey, {
        algorithms: ['RS256'],
        audience: 'https://oauth2.googleapis.com/token',
      }).scope,
      'https://www.googleapis.com/auth/firebase.messaging',
    );
    const push = calls.find(
      (c) => c.url === 'https://fcm.googleapis.com/v1/projects/test-project/messages:send',
    );
    assert.equal(JSON.parse(push.init.body).message.token, 'test-fcm-token');
    db.prepare("UPDATE memberships SET flags=? WHERE id='viewer'").run(
      JSON.stringify({ fcmTokens: ['test-fcm-token'], alerterAppFCMUserOff: true }),
    );
    const count = calls.length;
    assert.equal((await notifications.sendPush({ roomID: 'one', text: 'Paused' })).recipients, 0);
    assert.equal(calls.length, count);
    global.fetch = async () => new Response(JSON.stringify({ code: 123 }), { status: 400 });
    await assert.rejects(
      notifications.sendSMS({ roomID: 'one', text: 'Failure test', alertID: 'sms-fail' }),
      /2 failed/,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM notification_deliveries WHERE alert_id='sms-fail' AND status='failed'",
        )
        .get().n,
      2,
    );
    global.fetch = async () => {
      throw Error('sensitive transport details');
    };
    await assert.rejects(
      notifications.sendSMS({ roomID: 'one', text: 'Timeout test', alertID: 'sms-timeout' }),
      /unknown outcome/,
    );
    const stored = JSON.stringify(db.prepare('SELECT * FROM notification_deliveries').all());
    assert.ok(!stored.includes('private-test-secret'));
    assert.ok(!stored.includes('test-fcm-token'));
    assert.ok(!stored.includes('+12025550101'));
    assert.equal(notifications.pauseRoom('one'), true);
    assert.equal(notifications.pauseRoom('one'), false);
    await assert.rejects(notifications.sendSMS({ roomID: 'one', text: 'Paused room' }), /deletion/);
    notifications.resumeRoom('one');
    const pending = [];
    global.fetch = () => new Promise((resolve) => pending.push(resolve));
    const inFlight = notifications.sendSMS({
      roomID: 'one',
      text: 'Drain check',
      alertID: 'drain',
    });
    assert.equal(notifications.pauseRoom('one'), false);
    for (const resolve of pending)
      resolve(new Response(JSON.stringify({ sid: 'SM' + 'a'.repeat(32), status: 'queued' })));
    assert.equal((await inFlight).accepted, 2);
    assert.equal(notifications.pauseRoom('one'), true);
    notifications.resumeRoom('one');
  } finally {
    global.fetch = nativeFetch;
    delete process.env.TWILIO_SMS_ENABLED;
    delete process.env.FCM_ENABLED;
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  }
});

test('social alerts post only with explicit configuration and never repeat uncertain requests', async () => {
  db.prepare(
    "INSERT INTO users(id,name,email,password_hash) VALUES('social-owner','Owner','social@notify.test','x')",
  ).run();
  db.prepare(
    "INSERT INTO sessions(uuid,owner_id,name,settings) VALUES('social-room','social-owner','Social','{}')",
  ).run();
  const originalFetch = global.fetch,
    priorEnabled = process.env.X_POSTING_ENABLED,
    priorToken = process.env.X_USER_ACCESS_TOKEN,
    priorRoom = process.env.X_POSTING_ROOM_ID;
  let calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { id: '123456' } }), { status: 201 });
  };
  try {
    delete process.env.X_POSTING_ENABLED;
    process.env.X_USER_ACCESS_TOKEN = 'fake-private-token';
    process.env.X_POSTING_ROOM_ID = 'social-room';
    await assert.rejects(
      notifications.sendSocial({ roomID: 'social-room', text: 'Alert', alertID: 'disabled' }),
      /not configured/,
    );
    assert.equal(calls.length, 0);
    process.env.X_POSTING_ENABLED = 'true';
    assert.equal(
      (
        await notifications.sendSocial({
          roomID: 'social-room',
          text: 'Alert',
          alertID: 'social-1',
        })
      ).accepted,
      1,
    );
    assert.equal(calls[0].url, 'https://api.x.com/2/tweets');
    assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Alert' });
    assert.equal(
      (
        await notifications.sendSocial({
          roomID: 'social-room',
          text: 'Alert',
          alertID: 'social-1',
        })
      ).skipped,
      1,
    );
    assert.equal(calls.length, 1);
    db.prepare("UPDATE sessions SET settings=? WHERE uuid='social-room'").run(
      JSON.stringify({ xuserAccessToken: 'room-token', xuserAccessTokenSecret: 'room-secret' }),
    );
    process.env.X_CONSUMER_KEY = 'app-key';
    process.env.X_CONSUMER_SECRET = 'app-secret';
    await notifications.sendSocial({
      roomID: 'social-room',
      text: 'Signed alert',
      alertID: 'oauth',
    });
    const auth = calls[1].init.headers.authorization;
    assert.match(auth, /^OAuth /);
    const fields = Object.fromEntries(
      [...auth.matchAll(/(oauth_[a-z_]+)="([^"]*)"/g)].map((m) => [
        decodeURIComponent(m[1]),
        decodeURIComponent(m[2]),
      ]),
    );
    const encode = (v) =>
      encodeURIComponent(v).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
      );
    const signature = fields.oauth_signature;
    delete fields.oauth_signature;
    const params = Object.entries(fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => encode(k) + '=' + encode(v))
      .join('&');
    const expected = crypto
      .createHmac('sha1', 'app-secret&room-secret')
      .update('POST&' + encode('https://api.x.com/2/tweets') + '&' + encode(params))
      .digest('base64');
    assert.equal(signature, expected);
    assert.equal(fields.oauth_token, 'room-token');
    global.fetch = async () => {
      throw Error('secret transport error');
    };
    await assert.rejects(
      notifications.sendSocial({ roomID: 'social-room', text: 'Alert', alertID: 'ambiguous' }),
      /unknown/,
    );
    await assert.rejects(
      notifications.sendSocial({ roomID: 'social-room', text: 'Alert', alertID: 'ambiguous' }),
      /already attempted/,
    );
    assert.ok(
      !JSON.stringify(
        db.prepare("SELECT * FROM notification_deliveries WHERE channel='social'").all(),
      ).includes('fake-private-token'),
    );
    assert.equal(notifications.pauseRoom('social-room'), true);
    await assert.rejects(
      notifications.sendSocial({ roomID: 'social-room', text: 'Alert' }),
      /deletion/,
    );
    notifications.resumeRoom('social-room');
  } finally {
    global.fetch = originalFetch;
    if (priorEnabled === undefined) delete process.env.X_POSTING_ENABLED;
    else process.env.X_POSTING_ENABLED = priorEnabled;
    if (priorToken === undefined) delete process.env.X_USER_ACCESS_TOKEN;
    else process.env.X_USER_ACCESS_TOKEN = priorToken;
    if (priorRoom === undefined) delete process.env.X_POSTING_ROOM_ID;
    else process.env.X_POSTING_ROOM_ID = priorRoom;
    delete process.env.X_CONSUMER_KEY;
    delete process.env.X_CONSUMER_SECRET;
  }
});
