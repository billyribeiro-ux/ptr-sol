const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-wordpress-'));
const express = require('express'),
  db = require('../src/db/database');
const app = express();
app.use(express.json());
app.use('/users/v1', require('../src/routes/users'));

test(
  'WordPress renders a one-use link and its PHP signed JWT enters the room',
  { skip: process.env.PTR_TEST_PHP_DOCKER !== '1' },
  async (t) => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const signup = await fetch(base + '/users/v1/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Owner', email: 'owner@example.test', pw: 'password123' }),
    });
    const owner = await signup.json();
    db.prepare('UPDATE sessions SET id=?, settings=? WHERE uuid=?').run(
      'testroom',
      JSON.stringify({
        authMode: 'jwt',
        ssoJWTSecret: 'fixture-room-secret-at-least-32-characters',
        allowedPerms: 'subscriber',
      }),
      owner.roomUUID,
    );
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        `${path.resolve(__dirname, '..')}:/workspace:ro`,
        'php:8.4-cli-bookworm',
        'php',
        '/workspace/test/wordpress-fixture.php',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const signed = new URL(result.stdout.trim());
    const response = await fetch(base + signed.pathname + signed.search, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/session?id=${owner.roomUUID}`);
    assert.ok(response.headers.get('set-cookie').startsWith(`prt_room_${owner.roomUUID}=`));
    const member = db
      .prepare('SELECT role,email FROM memberships WHERE room_id=?')
      .get(owner.roomUUID);
    assert.equal(member.email, 'member@example.test');
    assert.equal(member.role, '2');
  },
);
