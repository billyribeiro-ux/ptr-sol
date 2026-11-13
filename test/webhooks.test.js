const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-hooks-'));
const db = require('../src/db/database');
const service = require('../src/services/webhooks');
test('webhook rejects unsafe destinations and URL credentials', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:7f00:1',
  ])
    assert.equal(service.publicAddress(ip), false, ip);
  assert.equal(service.publicAddress('8.8.8.8'), true);
  assert.throws(() => service.parsedURL('http://user:pass@example.test/'));
  assert.throws(() => service.parsedURL('file:///etc/passwd'));
});
test('local allowlisted webhook delivers, retries, persists and blocks SSRF', async () => {
  let received = [],
    calls = 0;
  const server = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (x) => chunks.push(x));
    req.on('end', () => {
      calls++;
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/retry' && calls === 2) {
        res.statusCode = 503;
        res.end('retry');
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/after' });
        res.end();
      } else if (req.url === '/large') {
        res.end('x'.repeat(17000));
      } else res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port,
    endpoint = `http://127.0.0.1:${port}`;
  process.env.LOCAL_WEBHOOK_ALLOWLIST = `127.0.0.1:${port}`;
  db.prepare(
    "INSERT INTO users(id,name,email,password_hash) VALUES ('owner','Owner','owner@example.test','x')",
  ).run();
  db.prepare(
    "INSERT INTO sessions(uuid,owner_id,name,settings) VALUES ('room','owner','Room',?)",
  ).run(JSON.stringify({ login_webhook_url: endpoint + '/ok', webhookSecret: 'hook-secret' }));
  const room = db.prepare("SELECT * FROM sessions WHERE uuid='room'").get();
  const originalLookup = dns.lookup;
  const user = { uid: 'u1', nick: 'Viewer', email: 'u@example.test' };
  try {
    const id = service.enqueueVisitEvent({
      room,
      visitId: 'visit-one',
      eventType: 'join',
      user,
      inTime: '2026-11-09T12:00:00.000Z',
    });
    assert.ok(id);
    assert.equal(
      service.enqueueVisitEvent({
        room,
        visitId: 'visit-one',
        eventType: 'join',
        user,
        inTime: '2026-11-09T12:00:00.000Z',
      }),
      null,
    );
    await service.dispatchPending();
    const p = JSON.parse(received[0].body);
    assert.equal(p.event, 'room.join');
    assert.equal(p.visitId, 'visit-one');
    assert.equal(p.room.uuid, 'room');
    assert.equal(p.user.id, 'u1');
    assert.equal(p.password, undefined);
    assert.equal(
      received[0].headers['x-ptr-signature'],
      'sha256=' + crypto.createHmac('sha256', 'hook-secret').update(received[0].body).digest('hex'),
    );
    assert.equal(
      db.prepare('SELECT status FROM webhook_jobs WHERE id=?').get(id).status,
      'delivered',
    );
    const retryRoom = {
      ...room,
      settings: JSON.stringify({ logout_webhook_url: endpoint + '/retry' }),
    };
    const retry = service.enqueueVisitEvent({
      room: retryRoom,
      visitId: 'visit-one',
      eventType: 'leave',
      user,
      inTime: '2026-11-09T12:00:00.000Z',
      outTime: '2026-11-09T12:03:00.000Z',
      duration: 180,
    });
    await service.dispatchPending();
    assert.equal(
      db.prepare('SELECT status FROM webhook_jobs WHERE id=?').get(retry).status,
      'pending',
    );
    delete require.cache[require.resolve('../src/services/webhooks')];
    const restarted = require('../src/services/webhooks');
    await restarted.dispatchPending(Date.now() + 10000);
    assert.equal(
      db.prepare('SELECT status FROM webhook_jobs WHERE id=?').get(retry).status,
      'delivered',
    );
    assert.equal(JSON.parse(received.at(-1).body).durationSeconds, 180);
    const redirectRoom = {
      ...room,
      settings: JSON.stringify({ login_webhook_url: endpoint + '/redirect' }),
    };
    const redirect = restarted.enqueueVisitEvent({
      room: redirectRoom,
      visitId: 'redirect',
      eventType: 'join',
      user,
      inTime: '2026-11-09T12:00:00.000Z',
    });
    await restarted.dispatchPending();
    assert.equal(
      db.prepare('SELECT status FROM webhook_jobs WHERE id=?').get(redirect).status,
      'pending',
    );
    assert.equal(
      received.some((x) => x.url === '/after'),
      false,
    );
    const largeRoom = {
      ...room,
      settings: JSON.stringify({ login_webhook_url: endpoint + '/large' }),
    };
    const large = restarted.enqueueVisitEvent({
      room: largeRoom,
      visitId: 'large',
      eventType: 'join',
      user,
      inTime: '2026-11-09T12:00:00.000Z',
    });
    await restarted.dispatchPending();
    assert.equal(
      db.prepare('SELECT status FROM webhook_jobs WHERE id=?').get(large).status,
      'pending',
    );
    delete process.env.LOCAL_WEBHOOK_ALLOWLIST;
    dns.lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    const dnsRoom = {
      ...room,
      settings: JSON.stringify({
        login_webhook_url: `http://rebind.example.test:${port}/blocked-dns`,
      }),
    };
    const dnsBlocked = restarted.enqueueVisitEvent({
      room: dnsRoom,
      visitId: 'dns-blocked',
      eventType: 'join',
      user,
      inTime: '2026-11-09T12:00:00.000Z',
    });
    await restarted.dispatchPending();
    assert.equal(
      db.prepare('SELECT status FROM webhook_jobs WHERE id=?').get(dnsBlocked).status,
      'failed',
    );
    assert.equal(
      received.some((x) => x.url === '/blocked-dns'),
      false,
    );
    process.env.LOCAL_WEBHOOK_ALLOWLIST = `local-hook.test:${port}`;
    const pinnedRoom = {
      ...room,
      settings: JSON.stringify({ login_webhook_url: `http://local-hook.test:${port}/pinned` }),
    };
    const pinned = restarted.enqueueVisitEvent({
      room: pinnedRoom,
      visitId: 'pinned',
      eventType: 'join',
      user,
      inTime: '2026-11-09T12:00:00.000Z',
    });
    await restarted.dispatchPending();
    assert.equal(
      db.prepare('SELECT status FROM webhook_jobs WHERE id=?').get(pinned).status,
      'delivered',
    );
    assert.equal(received.at(-1).url, '/pinned');
    delete process.env.LOCAL_WEBHOOK_ALLOWLIST;
    const blockedRoom = {
      ...room,
      settings: JSON.stringify({ login_webhook_url: endpoint + '/blocked' }),
    };
    const blocked = restarted.enqueueVisitEvent({
      room: blockedRoom,
      visitId: 'blocked',
      eventType: 'join',
      user,
      inTime: '2026-11-09T12:00:00.000Z',
    });
    const before = calls;
    await restarted.dispatchPending();
    assert.equal(
      db.prepare('SELECT status FROM webhook_jobs WHERE id=?').get(blocked).status,
      'failed',
    );
    assert.equal(calls, before);
  } finally {
    dns.lookup = originalLookup;
    delete process.env.LOCAL_WEBHOOK_ALLOWLIST;
    await new Promise((r) => server.close(r));
  }
});
