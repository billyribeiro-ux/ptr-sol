const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const project = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-provision-'));
process.env.DATA_DIR = dataDir;
process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:3031';
process.env.JWT_SECRET = 'test-provision-secret-with-at-least-32-characters';
const env = { ...process.env, DATA_DIR: dataDir };
const script = path.join(project, 'scripts/provision-accounts.cjs');

function runProvision(options = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: project,
    env: { ...env, ...options },
    encoding: 'utf8',
  });
}

test('provisioning is private, repeatable, and each captured role can authenticate within its scope', async (t) => {
  const first = runProvision();
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(dataDir, 'provisioned-accounts.json');
  const content = fs.readFileSync(file, 'utf8');
  const credentials = JSON.parse(content);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(Object.keys(credentials.accounts).length, 6);
  for (const account of Object.values(credentials.accounts)) {
    assert.ok(account.password.length >= 24);
    assert.equal(first.stdout.includes(account.password), false);
  }
  const second = runProvision();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), content);

  const express = require('express');
  const db = require('../src/db/database');
  const app = express();
  app.use(express.json());
  app.use('/users/v1', require('../src/routes/users'));
  app.use('/stats/v1', require('../src/routes/stats'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(route, body, token) {
    const response = await fetch(base + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  const { accounts, rooms } = credentials;
  for (const [name, integration] of Object.entries(credentials.integrations)) {
    assert.equal(integration.roomUUID, rooms[name].uuid);
    assert.equal(first.stdout.includes(integration.apiSecret), false);
    assert.equal(first.stdout.includes(integration.ssoJWTSecret), false);
    const query = new URLSearchParams({
      apiKey: integration.apiKey,
      apiSecret: integration.apiSecret,
    });
    const result = await (await fetch(`${base}/stats/v1/sessions/list?${query}`)).json();
    assert.deepEqual(
      result.sessions.map((room) => room.uuid),
      [rooms[name].uuid],
    );
    assert.equal(
      JSON.parse(
        db.prepare('SELECT settings FROM sessions WHERE uuid=?').get(rooms[name].uuid).settings,
      ).ssoJWTSecret,
      integration.ssoJWTSecret,
    );
  }
  const login = async (account) =>
    (await post('/users/v1/login', { email: account.email, pw: account.password })).data;
  const business = await login(accounts.businessOwner);
  const enterprise = await login(accounts.enterpriseOwner);
  const delegated = await login(accounts.delegatedAdmin);
  assert.ok(business.success && enterprise.success && delegated.success);
  assert.equal(business.isAdmin, false);
  assert.equal(enterprise.isAdmin, false);
  const businessRooms = (await post('/users/v1/sessions', { cmd: 'list' }, business.token)).data;
  const enterpriseRooms = (await post('/users/v1/sessions', { cmd: 'list' }, enterprise.token))
    .data;
  assert.deepEqual(
    businessRooms.map((room) => room.uuid),
    [rooms.business.uuid],
  );
  assert.deepEqual(
    enterpriseRooms.map((room) => room.uuid),
    [rooms.enterprise.uuid],
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'sessionDetails', sessionID: rooms.business.id },
        enterprise.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'sessionDetails', sessionID: rooms.enterprise.id },
        delegated.token,
      )
    ).data.success,
    true,
  );
  assert.equal(
    (
      await post(
        '/users/v1/sessions',
        { cmd: 'sessionDetails', sessionID: rooms.business.id },
        delegated.token,
      )
    ).status,
    403,
  );
  assert.equal((await post('/users/v1/apikeys', { cmd: 'list' }, delegated.token)).status, 403);

  for (const [key, presenter, nonPresenter] of [
    ['roomAdmin', true, true],
    ['presenter', true, false],
    ['participant', false, false],
  ]) {
    const account = accounts[key];
    const result = await post('/users/v1/users.json', {
      cmd: 'loginChat',
      roomID: rooms.enterprise.id,
      email: account.email,
      pw: account.password,
    });
    assert.equal(result.data.success, true, key);
    assert.equal(result.data.isPresenter, presenter, key);
    assert.equal(Boolean(result.data.nonPresenter), nonPresenter, key);
    assert.equal(result.data.uuid, rooms.enterprise.uuid, key);
    assert.equal(
      (
        await post(
          '/users/v1/sessions',
          { cmd: 'sessionDetails', sessionID: rooms.enterprise.id },
          result.data.token,
        )
      ).status,
      403,
    );
    assert.equal((await login(account)).success, false, key);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_admin=1').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_users').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memberships').get().count, 3);
  const adminFlags = JSON.parse(
    db.prepare('SELECT flags FROM memberships WHERE id=?').get(accounts.roomAdmin.id).flags,
  );
  assert.deepEqual(
    [adminFlags.hasMic, adminFlags.hasCam, adminFlags.hasScreen],
    [false, false, false],
  );
  const key = credentials.integrations.business;
  db.prepare("UPDATE api_keys SET revoked_at=datetime('now') WHERE id=?").run(key.apiKey);
  const revoked = runProvision();
  assert.notEqual(revoked.status, 0);
  assert.match(revoked.stderr, /changed or revoked/);
  assert.ok(db.prepare('SELECT revoked_at FROM api_keys WHERE id=?').get(key.apiKey).revoked_at);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});

test('provisioning refuses to overwrite an existing account or create a credential file on collision', () => {
  const collisionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-provision-collision-'));
  const collisionEnv = { ...env, DATA_DIR: collisionDir };
  const setup =
    "const db=require('./src/db/database'); db.prepare(\"INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)\").run('existing','Existing','business-owner@example.test','unchanged');";
  const created = spawnSync(process.execPath, ['-e', setup], {
    cwd: project,
    env: collisionEnv,
    encoding: 'utf8',
  });
  assert.equal(created.status, 0, created.stderr);
  const result = spawnSync(process.execPath, [script], {
    cwd: project,
    env: collisionEnv,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(collisionDir, 'provisioned-accounts.json')), false);
});
