const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.JANUS_URL = ''; // Transport authorization is independent of the media provider.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-socket-'));
const db = require('../src/db/database');
const { signToken } = require('../src/middleware/auth');
const { attachSockJSServer } = require('../src/realtime/sockjs');
const server = http.createServer((req, res) => res.end('ok'));
attachSockJSServer(server);
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/talk/websocket`);
    const events = [];
    ws.onmessage = (e) => events.push(JSON.parse(e.data));
    ws.onerror = reject;
    ws.onopen = () =>
      resolve({ ws, events, send: (type, data) => ws.send(JSON.stringify({ type, data })) });
  });
}
const wait = () => new Promise((r) => setTimeout(r, 60));
async function until(check) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw Error('Socket event timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
test('real SockJS transport refuses forged permissions and cross-room broadcasts', async () => {
  db.prepare(
    "INSERT INTO users (id,name,email,password_hash) VALUES ('owner','Owner','owner@example.test','x')",
  ).run();
  db.prepare(
    "INSERT INTO sessions (uuid,owner_id,name) VALUES ('room','owner','Room'),('other','owner','Other')",
  ).run();
  db.prepare("UPDATE sessions SET id='0123456789abcdef01234567' WHERE uuid='room'").run();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const a = await connect(port),
    b = await connect(port),
    c = await connect(port);
  try {
    const owner = db.prepare("SELECT * FROM users WHERE id='owner'").get();
    a.send('join', { roomID: '0123456789abcdef01234567', jwtTokenSite: signToken(owner) });
    b.send('join', {
      roomID: 'room',
      email: 'guest@example.test',
      nick: 'Guest',
      perms: 'a',
      uid: 'owner',
    });
    c.send('join', { roomID: 'other', email: 'else@example.test' });
    await until(() =>
      [a, b, c].every((client) =>
        client.events.some((e) => e.type === 'loggedIn' || e.type === 'loginFailed'),
      ),
    );
    assert.equal(a.events.find((e) => e.type === 'loggedIn')?.data.p, 'a');
    assert.equal(a.events.find((e) => e.type === 'loggedIn')?.data.roomID, 'room');
    const login = b.events.find((e) => e.type === 'loggedIn')?.data;
    assert.equal(login.p, 'r');
    assert.notEqual(login.uid, 'owner');
    a.send('getUserInfo', login.uid);
    await until(() => a.events.some((e) => e.type === 'getUserInfoResp'));
    const info = a.events.find((e) => e.type === 'getUserInfoResp').data;
    assert.ok(info.ip.includes('127.0.0.1'));
    assert.equal(typeof info.browser, 'string');
    const visit = JSON.parse(
      db
        .prepare("SELECT details FROM audit_events WHERE action='room_join' AND actor_id=?")
        .get(login.uid).details,
    );
    assert.equal(visit.ip, info.ip);
    assert.equal(visit.browser, info.browser);
    b.send('closeRoom', {});
    b.send('chat', { roomID: 'other', text: 'confined', nick: 'Owner' });
    b.send('forgedEvent', { roomID: 'room' });
    await until(
      () => a.events.some((e) => e.type === 'chat') && b.events.some((e) => e.type === 'error'),
    );
    assert.equal(db.prepare("SELECT is_open FROM sessions WHERE uuid='room'").get().is_open, 1);
    assert.equal(a.events.find((e) => e.type === 'chat')?.data.nick, 'Guest');
    assert.equal(
      c.events.some((e) => e.type === 'chat'),
      false,
    );
    assert.equal(
      a.events.some((e) => e.type === 'forgedEvent'),
      false,
    );
    a.send('muteChatUser', login.uid);
    await wait();
    b.send('chat', 'blocked');
    await wait();
    assert.equal(
      a.events.some((e) => e.type === 'chat' && e.data.text === 'blocked'),
      false,
    );
    a.send('changeSessionLock', true);
    await wait();
    const newcomer = await connect(port);
    newcomer.send('join', { roomID: 'room', email: 'new@example.test' });
    await until(() => newcomer.events.some((e) => e.type === 'loginFailed'));
    assert.equal(
      newcomer.events.some((e) => e.type === 'loginFailed'),
      true,
    );
    newcomer.ws.close();
    db.prepare('INSERT INTO banned_users (room_id,email) VALUES (?,?)').run(
      'room',
      'guest@example.test',
    );
    b.send('chat', 'after ban');
    await until(() => b.events.some((e) => e.type === 'loginFailed'));
    assert.equal(
      b.events.some((e) => e.type === 'loginFailed'),
      true,
    );
  } finally {
    a.ws.close();
    b.ws.close();
    c.ws.close();
    await new Promise((r) => server.close(r));
  }
});
