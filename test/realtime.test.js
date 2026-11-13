const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-realtime-'));
const db = require('../src/db/database');
const auth = require('../src/middleware/auth');
const media = require('../src/services/media');
media.provision = async () => ({ audio_id: 101, video_id: 102, ready: false, streamServer: '' });
auth.authorizeRoom = (d) => {
  const s = db
    .prepare('SELECT * FROM sessions WHERE uuid=?')
    .get(d.roomID === 'internal-id' ? 'room' : d.roomID);
  if (!s || !['owner', 'viewer', 'other'].includes(d.token)) return { error: 'Access denied' };
  return {
    room: s,
    identity: {
      id: d.token,
      uid: d.token,
      nick: d.token,
      email: d.token + '@example.test',
      perms: d.token === 'owner' ? 'a' : 'r',
    },
  };
};
const sockjs = require('sockjs');
let sock;
sockjs.createServer = () => {
  sock = new EventEmitter();
  sock.installHandlers = () => {};
  return sock;
};
const realtime = require('../src/realtime/sockjs');
realtime.attachSockJSServer({});
db.prepare(
  "INSERT INTO users (id,name,email,password_hash) VALUES ('owner','Owner','owner@example.test','x')",
).run();
db.prepare(
  "INSERT INTO sessions (uuid,owner_id,name) VALUES ('room','owner','Room'),('other-room','owner','Other')",
).run();
function client() {
  const c = new EventEmitter();
  c.events = [];
  c.write = (s) => c.events.push(JSON.parse(s));
  c.close = () => c.emit('close');
  sock.emit('connection', c);
  c.send = (type, data) => c.emit('data', JSON.stringify({ type, data }));
  return c;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const take = (c, type) => c.events.filter((e) => e.type === type).map((e) => e.data);
test('authenticated room protocol enforces identity, visibility and moderation', async () => {
  const anon = client(),
    owner = client(),
    viewer = client(),
    other = client();
  anon.send('chat', { roomID: 'room', text: 'anonymous' });
  anon.send('join', { roomID: 'room', uid: 'owner', perms: 'a' });
  owner.send('join', { roomID: 'room', token: 'owner' });
  viewer.send('join', { roomID: 'room', token: 'viewer', uid: 'owner', perms: 'a' });
  other.send('join', { roomID: 'other-room', token: 'other' });
  await flush();
  assert.deepEqual(realtime.getRoomCounts('room'), { current: 2, maximum: 2 });
  assert.equal(take(anon, 'loginFailed').length, 1);
  assert.equal(typeof take(viewer, 'setToken')[0], 'string');
  assert.equal(typeof take(viewer, 'setPorts')[0].pub_idScreen, 'number');
  assert.equal(take(viewer, 'setPorts')[0].audioRoomCreationLock, true);
  assert.equal(take(viewer, 'loggedIn')[0].hasFolder, true);
  assert.equal(take(viewer, 'loggedIn')[0].p, 'r');
  assert.equal(take(viewer, 'getRoomState')[0].chatMode, 'g');
  assert.equal(take(viewer, 'loggedIn')[0].uid, 'viewer');
  viewer.send('closeRoom', null);
  viewer.send('madeUp', { roomID: 'room' });
  viewer.send('chat', { roomID: 'other-room', text: 'hello', nick: 'owner' });
  await flush();
  assert.equal(db.prepare('SELECT is_open FROM sessions WHERE uuid=?').get('room').is_open, 1);
  assert.equal(take(other, 'chat').length, 0);
  assert.equal(take(owner, 'madeUp').length, 0);
  assert.equal(take(owner, 'chat')[0].nick, 'viewer');
  assert.equal(Object.hasOwn(take(owner, 'chat')[0], 'channel'), false);
  owner.send('chat', { text: 'private', onlyP: true });
  owner.send('chatChannel', { channel: 'adminChat', text: 'staff' });
  await flush();
  assert.equal(
    take(viewer, 'chat').some((m) => m.text === 'private'),
    false,
  );
  assert.equal(take(viewer, 'chatChannel').length, 0);
  viewer.send('getChatLog');
  await flush();
  assert.equal(
    take(viewer, 'getChatlog')
      .at(-1)
      .some((m) => m.text === 'private'),
    false,
  );
  owner.send('muteChatUser', 'viewer');
  await flush();
  viewer.send('chat', 'blocked');
  await flush();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text='blocked'").get().n, 0);
  owner.send('unmuteChatUser', 'viewer');
  await flush();
  viewer.send('chat', 'allowed');
  await flush();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text='allowed'").get().n, 1);
  owner.send('sendPoll', { q: 'Choose', choices: ['yes', 'no'], recipients: 'all' });
  await flush();
  assert.equal(take(viewer, 'gotPoll').at(-1).q.q, 'Choose');
  viewer.send('sendPollAnswer', { a: 0 });
  await flush();
  assert.equal(take(owner, 'gotPollAnswer').at(-1).a.a, 0);
  owner.send('makeTempPresenter', { uid: 'viewer', perms: 'p' });
  await flush();
  viewer.send('closeRoom', null);
  viewer.send('chatChannel', { channel: 'adminChat', text: 'forbidden' });
  await flush();
  assert.equal(db.prepare("SELECT is_open FROM sessions WHERE uuid='room'").get().is_open, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE text='forbidden'").get().n, 0);
  [anon, owner, viewer, other].forEach((c) => c.emit('close'));
  const joinAudit = db
    .prepare(
      "SELECT details FROM audit_events WHERE room_id='room' AND actor_id='viewer' AND action='room_join' ORDER BY rowid DESC LIMIT 1",
    )
    .get();
  const leaveAudit = db
    .prepare(
      "SELECT details FROM audit_events WHERE room_id='room' AND actor_id='viewer' AND action='room_logout' ORDER BY rowid DESC LIMIT 1",
    )
    .get();
  assert.equal(JSON.parse(joinAudit.details).outTime, null);
  assert.ok(JSON.parse(leaveAudit.details).outTime);
  assert.equal(typeof JSON.parse(leaveAudit.details).duration, 'number');
  assert.deepEqual(realtime.getRoomCounts('room'), { current: 0, maximum: 2 });
  assert.deepEqual(realtime.resetRoomCapacity('room'), { current: 0, maximum: 0 });
});

test('Janus provisioning and native recording use numeric room IDs', async () => {
  // Restore the real media function after the socket test's deterministic stub.
  delete require.cache[require.resolve('../src/services/media')];
  const gateway = require('../src/services/media');
  process.env.JANUS_URL = 'http://janus.test/janus';
  process.env.JANUS_RECORDINGS_DIR = '/shared/recordings';
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    let data = {};
    if (body.janus === 'create') data = { id: 111 };
    else if (body.janus === 'attach') data = { id: 222 };
    else if (body.janus === 'message')
      return {
        ok: true,
        json: async () => ({ janus: 'success', plugindata: { data: { audiobridge: 'success' } } }),
      };
    return { ok: true, json: async () => ({ janus: 'success', data }) };
  };
  try {
    const state = await gateway.provision('room');
    assert.equal(state.ready, true);
    assert.equal(typeof state.audio_id, 'number');
    assert.equal(typeof state.video_id, 'number');
    await gateway.audioRecording('room', 'test-recording', true);
    await gateway.audioRecording('room', 'test-recording', false);
    const records = calls
      .filter((c) => c.body.body?.request === 'enable_recording')
      .map((c) => c.body.body);
    assert.equal(records.length, 2);
    assert.equal(records[0].room, state.audio_id);
    assert.equal(records[0].record_file, '/shared/recordings/test-recording/audio.wav');
    assert.equal(records[0].record, true);
    assert.equal(records[1].record, false);
    await gateway.destroyRoom('room');
    const destroyed = calls
      .filter((c) => c.body.body?.request === 'destroy')
      .map((c) => c.body.body.room);
    assert.deepEqual(destroyed, [state.audio_id, state.video_id]);
    global.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(gateway.destroyRoom('room'), /unavailable/);
  } finally {
    global.fetch = original;
    delete process.env.JANUS_URL;
    delete process.env.JANUS_RECORDINGS_DIR;
  }
});

test('recording is only ready after processor creates an output file', async () => {
  const config = require('../src/config');
  const oldProvision = media.provision,
    oldAudio = media.audioRecording,
    oldVideo = media.videoRecording,
    oldFetch = global.fetch;
  media.provision = async () => ({
    audio_id: 101,
    video_id: 102,
    ready: true,
    streamServer: '/janus',
  });
  media.audioRecording = async () => {};
  media.videoRecording = async () => {};
  process.env.MEDIA_PROCESSOR_URL = 'http://processor.test';
  process.env.MEDIA_PROCESSOR_TOKEN = 'test-token';
  let finish;
  global.fetch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const owner = client();
  try {
    owner.send('join', { roomID: 'room', token: 'owner' });
    await flush();
    owner.send('startRec', null);
    await flush();
    const rec = db
      .prepare("SELECT * FROM recordings WHERE room_id='room' AND status='recording'")
      .get();
    assert.ok(rec);
    assert.equal(JSON.parse(rec.metadata).initiatorUID, 'owner');
    owner.send('stopRec', null);
    await flush();
    assert.equal(
      db.prepare('SELECT status FROM recordings WHERE id=?').get(rec.id).status,
      'processing',
    );
    const output = path.join(config.RECORDINGS_DIR, rec.id, 'recording.mp4');
    fs.writeFileSync(output, Buffer.alloc(256));
    finish({ ok: true, json: async () => ({ success: true, file: output, durationSec: 12 }) });
    await flush();
    assert.equal(take(owner, 'recStopped').at(-1).uid, 'owner');
    const completed = db
      .prepare('SELECT status,file_path,duration_sec FROM recordings WHERE id=?')
      .get(rec.id);
    assert.equal(completed.status, 'ready');
    assert.equal(completed.file_path, output);
    assert.equal(completed.duration_sec, 12);
  } finally {
    owner.emit('close');
    media.provision = oldProvision;
    media.audioRecording = oldAudio;
    media.videoRecording = oldVideo;
    global.fetch = oldFetch;
    delete process.env.MEDIA_PROCESSOR_URL;
    delete process.env.MEDIA_PROCESSOR_TOKEN;
  }
});

test('recording processor failure never publishes an absent file', async () => {
  const oldProvision = media.provision,
    oldAudio = media.audioRecording,
    oldVideo = media.videoRecording,
    oldFetch = global.fetch;
  media.provision = async () => ({
    audio_id: 101,
    video_id: 102,
    ready: true,
    streamServer: '/janus',
  });
  media.audioRecording = async () => {};
  media.videoRecording = async () => {};
  process.env.MEDIA_PROCESSOR_URL = 'http://processor.test';
  process.env.MEDIA_PROCESSOR_TOKEN = 'test-token';
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ success: true, file: '/tmp/not-owned.mp4', durationSec: 1 }),
  });
  const owner = client();
  try {
    owner.send('join', { roomID: 'other-room', token: 'owner' });
    await flush();
    owner.send('startRec', null);
    await flush();
    const rec = db
      .prepare("SELECT * FROM recordings WHERE room_id='other-room' AND status='recording'")
      .get();
    assert.ok(rec);
    owner.send('stopRec', null);
    await flush();
    assert.equal(
      db.prepare('SELECT status FROM recordings WHERE id=?').get(rec.id).status,
      'failed',
    );
  } finally {
    owner.emit('close');
    media.provision = oldProvision;
    media.audioRecording = oldAudio;
    media.videoRecording = oldVideo;
    global.fetch = oldFetch;
    delete process.env.MEDIA_PROCESSOR_URL;
    delete process.env.MEDIA_PROCESSOR_TOKEN;
  }
});

test('muted memberships and destructive log operations are enforced and audited', async () => {
  const owner = client(),
    viewer = client();
  db.prepare(
    "INSERT INTO memberships (id,room_id,email,name,role,flags) VALUES ('viewer','room','viewer@example.test','Viewer','3','{}')",
  ).run();
  try {
    owner.send('join', { roomID: 'room', token: 'owner' });
    viewer.send('join', { roomID: 'room', token: 'viewer' });
    await flush();
    viewer.send('chat', 'role muted');
    await flush();
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE text='role muted'").get().n, 0);
    db.prepare("UPDATE memberships SET role='r',flags='{\"muted\":true}' WHERE id='viewer'").run();
    viewer.send('chat', 'flag muted');
    await flush();
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE text='flag muted'").get().n, 0);
    owner.send('chat', 'audit one');
    owner.send('alert', 'audit two');
    await flush();
    let m = take(owner, 'chat').find((x) => x.text === 'audit one');
    let a = take(owner, 'alert').find((x) => x.text === 'audit two');
    owner.send('deleteMessage', { id: m.id });
    owner.send('deleteAlert', { id: a.id });
    await flush();
    let rows = db
      .prepare(
        "SELECT action,details FROM audit_events WHERE room_id='room' AND action='log_deleted'",
      )
      .all();
    assert.ok(rows.some((row) => JSON.parse(row.details).content === 'audit one'));
    assert.ok(rows.some((row) => JSON.parse(row.details).content === 'audit two'));
    owner.send('chat', 'archive one');
    owner.send('alert', 'archive two');
    await flush();
    owner.send('clearChatLog', 'main');
    owner.send('clearAlertLog');
    await flush();
    rows = db
      .prepare("SELECT details FROM audit_events WHERE room_id='room' AND action='log_archived'")
      .all();
    assert.ok(rows.some((row) => JSON.parse(row.details).content === 'archive one'));
    assert.ok(rows.some((row) => JSON.parse(row.details).content === 'archive two'));
  } finally {
    owner.emit('close');
    viewer.emit('close');
    db.prepare("DELETE FROM memberships WHERE id='viewer'").run();
  }
});

test('scheduled alert delivers only to explicitly opted-in approved members', async () => {
  const mail = require('../src/services/mail');
  const previous = mail.sendMail,
    previousHost = process.env.SMTP_HOST;
  const sent = [];
  mail.sendMail = async (m) => sent.push(m);
  process.env.SMTP_HOST = 'mailpit';
  db.prepare("UPDATE sessions SET settings=? WHERE uuid='room'").run(
    JSON.stringify({ hasAlertEmails: true }),
  );
  db.prepare(
    "INSERT INTO memberships (id,room_id,email,name,status,flags) VALUES ('mail-yes','room','yes@example.test','Yes','approved','{\"alertEmail\":true}'),('mail-no','room','no@example.test','No','approved','{}'),('mail-pending','room','pending@example.test','Pending','pending','{\"alertEmail\":true}')",
  ).run();
  const owner = client();
  try {
    owner.send('join', { roomID: 'room', token: 'owner' });
    await flush();
    owner.send('alertLater', {
      txt: 'scheduled mail',
      sendAt: new Date(Date.now() + 250).toISOString(),
      sendEmail: true,
    });
    await flush();
    const row = db
      .prepare(
        "SELECT delivery FROM realtime_scheduled WHERE room_id='room' AND text='scheduled mail'",
      )
      .get();
    assert.equal(JSON.parse(row.delivery).sendEmail, true);
    await new Promise((resolve) => setTimeout(resolve, 1400));
    assert.deepEqual(
      sent.map((x) => x.to),
      ['yes@example.test'],
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM alerts WHERE text='scheduled mail'").get().n,
      1,
    );
  } finally {
    owner.emit('close');
    mail.sendMail = previous;
    if (previousHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = previousHost;
    db.prepare("DELETE FROM memberships WHERE id IN ('mail-yes','mail-no','mail-pending')").run();
    db.prepare("UPDATE sessions SET settings='{}' WHERE uuid='room'").run();
  }
});

test('audio reset, remote recording and active screen watcher counts perform room actions', async () => {
  const old = {
    provision: media.provision,
    audioRecording: media.audioRecording,
    videoRecording: media.videoRecording,
    resetAudio: media.resetAudio,
    publisherOwned: media.publisherOwned,
  };
  const calls = [];
  media.provision = async (room, options) => {
    calls.push(['provision', options?.audioEnabled]);
    return {
      audio_id: 101,
      video_id: 102,
      ready: options?.audioEnabled !== false,
      streamServer: '/janus',
    };
  };
  media.resetAudio = async (room, stop) => {
    calls.push(['reset', room, stop]);
    return { audio_id: 303, video_id: 102, ready: !stop, streamServer: '/janus' };
  };
  media.audioRecording = async (r, id, on) => calls.push(['audio', on]);
  media.videoRecording = async (r, dir, on) => calls.push(['video', on]);
  media.publisherOwned = async () => true;
  const owner = client(),
    viewer = client();
  try {
    owner.send('join', { roomID: 'room', token: 'owner' });
    viewer.send('join', { roomID: 'room', token: 'viewer' });
    await flush();
    owner.send('regenAudioRoomId');
    await flush();
    assert.ok(calls.some((call) => call[0] === 'reset' && call[1] === 'room' && call[2] === false));
    assert.equal(take(viewer, 'newAudioRoomIDForAll').at(-1).audioRoomID, 303);
    owner.send('addScreenStream', { pub_id: 123, roomID: 102 });
    await flush();
    viewer.send('incSSStats', 'owner');
    await flush();
    owner.send('getScreenSharingStats');
    await flush();
    assert.equal(take(owner, 'getScreenSharingStats').at(-1).owner.screenWatchers, 1);
    viewer.emit('close');
    owner.send('getScreenSharingStats');
    await flush();
    assert.equal(take(owner, 'getScreenSharingStats').at(-1).owner.screenWatchers, 0);
    owner.send('remoteStartRec', 'owner');
    await flush();
    assert.ok(calls.some((c) => c[0] === 'audio' && c[1] === true));
    const rec = db
      .prepare("SELECT * FROM recordings WHERE room_id='room' AND status='recording'")
      .get();
    assert.ok(rec);
    owner.send('remoteStopRec', 'owner');
    await flush();
    assert.ok(calls.some((c) => c[0] === 'audio' && c[1] === false));
    assert.notEqual(
      db.prepare('SELECT status FROM recordings WHERE id=?').get(rec.id).status,
      'recording',
    );
    owner.send('stopAudioBridge');
    await flush();
    const newcomer = client();
    newcomer.send('join', { roomID: 'room', token: 'viewer' });
    await flush();
    assert.ok(calls.some((call) => call[0] === 'provision' && call[1] === false));
    newcomer.emit('close');
    db.prepare("DELETE FROM realtime_state WHERE room_id='room' AND key='audioStopped'").run();
  } finally {
    owner.emit('close');
    viewer.emit('close');
    Object.assign(media, old);
  }
});

test('removing trials deletes only marked members and disconnects them', async () => {
  const old = media.evictUser;
  let evicted = [];
  media.evictUser = async (r, id) => evicted.push(id);
  db.prepare(
    "INSERT INTO memberships (id,room_id,email,name,flags) VALUES ('viewer','room','trial@example.test','Trial','{\"isFreeTrial\":true}'),('regular','room','regular@example.test','Regular','{}')",
  ).run();
  const owner = client(),
    viewer = client();
  try {
    owner.send('join', { roomID: 'room', token: 'owner' });
    viewer.send('join', { roomID: 'room', token: 'viewer' });
    await flush();
    owner.send('removeFreeTrials');
    await flush();
    assert.equal(db.prepare("SELECT COUNT(*) n FROM memberships WHERE id='viewer'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM memberships WHERE id='regular'").get().n, 1);
    assert.deepEqual(evicted, ['viewer']);
    assert.equal(take(viewer, 'kickUser').at(-1), 'viewer');
  } finally {
    owner.emit('close');
    viewer.emit('close');
    media.evictUser = old;
    db.prepare("DELETE FROM memberships WHERE id='regular'").run();
  }
});

test('canonical room IDs and privacy settings govern socket events', async () => {
  const owner = client(),
    viewer = client(),
    other = client();
  try {
    db.prepare("UPDATE sessions SET settings=? WHERE uuid='room'").run(
      JSON.stringify({
        userPM: false,
        userToPresenterPM: false,
        rosterVisibleToViewers: false,
        rosterCountVisibleToViewers: false,
        allowUsersToChangeUsername: false,
        hasTypingIndicator: false,
        fileAccessCaseByCase: true,
      }),
    );
    owner.send('join', { roomID: 'internal-id', token: 'owner' });
    viewer.send('join', { roomID: 'room', token: 'viewer' });
    other.send('join', { roomID: 'room', token: 'other' });
    await flush();
    assert.equal(take(owner, 'loggedIn').at(-1).roomID, 'room');
    assert.equal(take(viewer, 'loggedIn').at(-1).canPM, false);
    assert.equal(take(viewer, 'loggedIn').at(-1).hasFolder, false);
    assert.equal(take(owner, 'loggedIn').at(-1).hasFolder, true);
    assert.equal(take(viewer, 'loggedIn').at(-1).hideCount, true);
    assert.deepEqual(Object.keys(take(viewer, 'getRoster').at(-1)), ['viewer']);
    viewer.send('privateChat', { ruid: 'owner', txt: 'blocked' });
    viewer.send('changeNick', { newNick: 'spoof' });
    viewer.send('typing', { c: 'main' });
    await flush();
    assert.equal(take(owner, 'privateChat').length, 0);
    assert.equal(take(owner, 'typing').length, 0);
    assert.ok(take(viewer, 'error').length >= 2);
    db.prepare("UPDATE sessions SET settings=? WHERE uuid='room'").run(
      JSON.stringify({
        userToPresenterPM: true,
        rosterVisibleToViewers: true,
        onlyPresentersVisibleToViewers: true,
        allowUsersToChangeUsername: true,
        hasTypingIndicator: true,
      }),
    );
    viewer.send('privateChat', { ruid: 'owner', txt: 'allowed' });
    viewer.send('privateChat', { ruid: 'other', txt: 'blocked again' });
    viewer.send('changeNick', { newNick: 'NewName' });
    viewer.send('refreshMyState');
    await flush();
    assert.equal(take(owner, 'privateChat').at(-1).txt, 'allowed');
    assert.equal(take(other, 'privateChat').length, 0);
    assert.deepEqual(Object.keys(take(viewer, 'getRoster').at(-1)).sort(), ['owner', 'viewer']);
    assert.equal(take(viewer, 'getRoster').at(-1).viewer.nick, 'NewName');
  } finally {
    owner.emit('close');
    viewer.emit('close');
    other.emit('close');
    db.prepare("UPDATE sessions SET settings='{}' WHERE uuid='room'").run();
  }
});

test('documented channel, image, role, file and talking commands use real room state', async () => {
  const owner = client(),
    viewer = client();
  const oldEvict = media.evictUser;
  media.evictUser = async () => {};
  db.prepare(
    "INSERT INTO memberships (id,room_id,email,name,role,flags) VALUES ('viewer','room','viewer@example.test','Viewer','2','{}')",
  ).run();
  db.prepare(
    "INSERT INTO files (id,room_id,uploader_id,uploader_name,original_name,stored_name) VALUES ('f','room','owner','Owner','shared.txt','stored')",
  ).run();
  try {
    owner.send('join', { roomID: 'room', token: 'owner' });
    viewer.send('join', { roomID: 'room', token: 'viewer' });
    await flush();
    owner.send('chatChannel', { channel: 'offTopic', msg: 'channel body' });
    owner.send('imageLink', { txt: 'caption', img: 'https://example.test/picture.png' });
    owner.send('cmd', { cmd: 'fileShared', data: { name: 'shared.txt', sender: 'forged' } });
    await flush();
    assert.equal(take(viewer, 'chatChannel').at(-1).text, 'channel body');
    assert.equal(take(viewer, 'imageLink').at(-1).img, 'https://example.test/picture.png');
    assert.equal(JSON.parse(take(viewer, 'fileShared').at(-1)).sender, 'owner');
    owner.send('updateUser', { uid: 'viewer', type: 'changePerm', val: 'p' });
    await flush();
    assert.equal(take(viewer, 'makeTempPresenter').at(-1), 'p');
    viewer.send('userStartTalking', 'owner');
    await flush();
    assert.equal(take(owner, 'talkingStart').at(-1), 'viewer');
    viewer.send('closeRoom');
    await flush();
    assert.equal(db.prepare("SELECT is_open FROM sessions WHERE uuid='room'").get().is_open, 1);
    owner.send('updateUser', { uid: 'viewer', type: 'changePerm', val: 'r' });
    await flush();
    assert.equal(db.prepare("SELECT role FROM memberships WHERE id='viewer'").get().role, '2');
  } finally {
    owner.emit('close');
    viewer.emit('close');
    db.prepare("DELETE FROM memberships WHERE id='viewer'").run();
    db.prepare("DELETE FROM files WHERE id='f'").run();
    media.evictUser = oldEvict;
  }
});

test('Eastern schedule handles weekdays, weekends, DST, overnight and restart idempotence', async () => {
  const mail = require('../src/services/mail'),
    oldMail = mail.sendMail,
    oldHost = process.env.SMTP_HOST,
    oldTimezone = process.env.ROOM_TIMEZONE;
  const sent = [];
  mail.sendMail = async (m) => sent.push(m);
  process.env.SMTP_HOST = 'mailpit';
  process.env.ROOM_TIMEZONE = 'America/New_York';
  db.prepare(
    "INSERT INTO sessions(uuid,owner_id,name,is_open,settings,created_at) VALUES ('scheduled-room','owner','Scheduled',0,?,'2026-01-01 00:00:00')",
  ).run(
    JSON.stringify({
      autoOpenTime: '7:30',
      autoCloseTime: '18:30',
      ignoreAutoOpenCloseOnWeekend: true,
      sendOpenCloseEmail: 'first@example.test, second@example.test',
    }),
  );
  const get = () =>
    db.prepare("SELECT is_open FROM sessions WHERE uuid='scheduled-room'").get().is_open;
  try {
    db.prepare('INSERT OR REPLACE INTO realtime_schedule_cursor VALUES (1,?)').run(
      Math.floor(Date.parse('2026-11-07T12:30:00Z') / 60000),
    );
    await realtime.runRoomSchedule(new Date('2026-11-07T12:30:00Z'));
    assert.equal(get(), 0);
    assert.equal(sent.length, 0);
    await realtime.runRoomSchedule(new Date('2026-11-09T12:30:00Z'));
    assert.equal(get(), 1);
    assert.deepEqual(
      sent.map((m) => m.to),
      ['first@example.test', 'second@example.test'],
    );
    db.prepare("UPDATE sessions SET is_open=0 WHERE uuid='scheduled-room'").run();
    await realtime.runRoomSchedule(new Date('2026-11-09T12:30:30Z'));
    assert.equal(get(), 0);
    assert.equal(sent.length, 2);
    delete require.cache[require.resolve('../src/realtime/sockjs')];
    const restarted = require('../src/realtime/sockjs');
    await restarted.runRoomSchedule(new Date('2026-11-09T12:30:45Z'));
    assert.equal(get(), 0);
    assert.equal(sent.length, 2);
    db.prepare("UPDATE sessions SET settings=? WHERE uuid='scheduled-room'").run(
      JSON.stringify({ autoOpenTime: '22:00', autoCloseTime: '6:00' }),
    );
    await restarted.runRoomSchedule(new Date('2026-11-10T03:00:00Z'));
    assert.equal(get(), 1);
    await restarted.runRoomSchedule(new Date('2026-11-10T11:00:00Z'));
    assert.equal(get(), 0);
    db.prepare("UPDATE sessions SET settings=? WHERE uuid='scheduled-room'").run(
      JSON.stringify({ autoOpenTime: '7:30' }),
    );
    await restarted.runRoomSchedule(new Date('2026-07-06T11:30:00Z'));
    assert.equal(get(), 1);
    db.prepare("UPDATE sessions SET settings=?,is_open=0 WHERE uuid='scheduled-room'").run(
      JSON.stringify({ autoOpenTime: '1:30' }),
    );
    await restarted.runRoomSchedule(new Date('2026-11-01T05:30:00Z'));
    assert.equal(get(), 1);
    db.prepare("UPDATE sessions SET is_open=0 WHERE uuid='scheduled-room'").run();
    await restarted.runRoomSchedule(new Date('2026-11-01T06:30:00Z'));
    assert.equal(get(), 0);
    db.prepare("UPDATE sessions SET settings=?,is_open=0 WHERE uuid='scheduled-room'").run(
      JSON.stringify({ autoOpenTime: '7:30' }),
    );
    db.prepare('UPDATE realtime_schedule_cursor SET minute=? WHERE id=1').run(
      Math.floor(Date.parse('2026-11-16T12:29:00Z') / 60000),
    );
    await restarted.runRoomSchedule(new Date('2026-11-16T12:32:00Z'));
    assert.equal(get(), 1);
    assert.equal(restarted.normalizedSchedule('24:00'), null);
    assert.equal(restarted.normalizedSchedule('7:5'), null);
    assert.equal(restarted.easternMinute(new Date('2026-07-06T11:30:00Z')).minute, '07:30');
  } finally {
    mail.sendMail = oldMail;
    if (oldHost === undefined) delete process.env.SMTP_HOST;
    else process.env.SMTP_HOST = oldHost;
    if (oldTimezone === undefined) delete process.env.ROOM_TIMEZONE;
    else process.env.ROOM_TIMEZONE = oldTimezone;
    db.prepare("DELETE FROM realtime_schedule_actions WHERE room_id='scheduled-room'").run();
    db.prepare("DELETE FROM realtime_schedule_mail WHERE room_id='scheduled-room'").run();
    db.prepare("DELETE FROM sessions WHERE uuid='scheduled-room'").run();
  }
});

test('socket rejects oversized frames and rate-limits repeated joins and chat', async () => {
  const c = client();
  c.send('join', { roomID: 'room', token: 'owner' });
  await flush();
  for (let i = 0; i < 45; i++) c.send('chat', 'flood ' + i);
  await flush();
  assert.ok(take(c, 'error').some((e) => /Too many messages/.test(e.message)));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE text LIKE 'flood %'").get().n, 40);
  c.emit('data', 'x'.repeat(65537));
  await flush();
  assert.ok(take(c, 'error').some((e) => /limit/.test(e.message)));
  assert.equal(realtime.getRoomCounts('room').current, 0);
  const clients = [];
  for (let i = 0; i < 21; i++) {
    const socket = new EventEmitter();
    socket.remoteAddress = '192.0.2.55';
    socket.events = [];
    socket.write = (raw) => socket.events.push(JSON.parse(raw));
    socket.close = () => socket.emit('close');
    sock.emit('connection', socket);
    socket.emit(
      'data',
      JSON.stringify({ type: 'join', data: { roomID: 'room', token: 'invalid' } }),
    );
    clients.push(socket);
  }
  await flush();
  assert.ok(clients.at(-1).events.some((e) => e.type === 'loginFailed' && /Too many/.test(e.data)));
  clients.forEach((x) => x.emit('close'));
});

test('startup reconciles latest missed room event once without overriding later manual state', async () => {
  const old = process.env.ROOM_TIMEZONE;
  process.env.ROOM_TIMEZONE = 'America/New_York';
  db.prepare('DELETE FROM realtime_schedule_cursor').run();
  db.prepare(
    "INSERT INTO sessions(uuid,owner_id,name,is_open,settings,created_at) VALUES ('bootstrap','owner','Bootstrap',0,?,'2026-01-01 00:00:00')",
  ).run(
    JSON.stringify({
      autoOpenTime: '7:30',
      autoCloseTime: '18:30',
      ignoreAutoOpenCloseOnWeekend: true,
    }),
  );
  try {
    const restarted = require('../src/realtime/sockjs');
    await restarted.runRoomSchedule(new Date('2026-11-09T13:40:00Z'));
    assert.equal(
      db.prepare("SELECT is_open FROM sessions WHERE uuid='bootstrap'").get().is_open,
      1,
    );
    db.prepare("UPDATE sessions SET is_open=0 WHERE uuid='bootstrap'").run();
    db.prepare('DELETE FROM realtime_schedule_cursor').run();
    await restarted.runRoomSchedule(new Date('2026-11-09T14:00:00Z'));
    assert.equal(
      db.prepare("SELECT is_open FROM sessions WHERE uuid='bootstrap'").get().is_open,
      0,
    );
  } finally {
    if (old === undefined) delete process.env.ROOM_TIMEZONE;
    else process.env.ROOM_TIMEZONE = old;
    db.prepare("DELETE FROM realtime_schedule_actions WHERE room_id='bootstrap'").run();
    db.prepare("DELETE FROM sessions WHERE uuid='bootstrap'").run();
  }
});

test('authenticated socket join and departure enqueue one sanitized webhook each', async () => {
  db.prepare("UPDATE sessions SET settings=? WHERE uuid='room'").run(
    JSON.stringify({
      login_webhook_url: 'http://127.0.0.1:1/join',
      logout_webhook_url: 'http://127.0.0.1:1/leave',
    }),
  );
  const owner = client();
  try {
    owner.send('join', { roomID: 'room', token: 'owner', pw: 'must-not-appear' });
    await flush();
    owner.emit('close');
    owner.emit('close');
    const jobs = db
      .prepare(
        "SELECT event_type,visit_id,payload FROM webhook_jobs WHERE room_id='room' ORDER BY rowid",
      )
      .all();
    assert.equal(jobs.length, 2);
    assert.deepEqual(
      jobs.map((j) => j.event_type),
      ['join', 'leave'],
    );
    assert.equal(jobs[0].visit_id, jobs[1].visit_id);
    for (const job of jobs) {
      const payload = JSON.parse(job.payload);
      assert.equal(payload.user.id, 'owner');
      assert.equal(JSON.stringify(payload).includes('must-not-appear'), false);
      assert.equal(JSON.stringify(payload).includes('token'), false);
    }
  } finally {
    db.prepare("DELETE FROM webhook_jobs WHERE room_id='room'").run();
    db.prepare("UPDATE sessions SET settings='{}' WHERE uuid='room'").run();
  }
});

test('default alert flags preserve in-room delivery and only relay to authorized linked rooms', async () => {
  const owner = client();
  try {
    owner.send('join', { roomID: 'room', token: 'owner' });
    await flush();
    owner.send('alert', {
      txt: 'default UI alert',
      sendLinked: true,
      sendTxt: true,
      sendTweet: true,
      sendEmail: true,
    });
    await flush();
    assert.ok(take(owner, 'alert').some((a) => a.text === 'default UI alert'));
    assert.equal(take(owner, 'error').length, 0);
    owner.send('alertLater', {
      txt: 'scheduled default',
      sendAt: new Date(Date.now() + 60000).toISOString(),
      sendLinked: true,
      sendTxt: true,
      sendTweet: true,
    });
    await flush();
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM realtime_scheduled WHERE text='scheduled default'").get()
        .n,
      1,
    );
    db.prepare("UPDATE sessions SET settings=? WHERE uuid='room'").run(
      JSON.stringify({ linkedRoomAlerts: 'other-room' }),
    );
    owner.send('alert', { txt: 'linked alert', sendLinked: true });
    await flush();
    assert.equal(
      db
        .prepare("SELECT COUNT(*) n FROM alerts WHERE room_id='other-room' AND text='linked alert'")
        .get().n,
      1,
    );
    db.prepare("UPDATE sessions SET settings=? WHERE uuid='room'").run(
      JSON.stringify({ linkedRoomAlerts: 'not-owned' }),
    );
    owner.send('alert', { txt: 'invalid link', sendLinked: true });
    await flush();
    assert.ok(take(owner, 'error').some((e) => /linked room/i.test(e.message)));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM alerts WHERE text='invalid link'").get().n, 0);
  } finally {
    owner.emit('close');
    db.prepare("DELETE FROM realtime_scheduled WHERE text='scheduled default'").run();
    db.prepare("UPDATE sessions SET settings='{}' WHERE uuid='room'").run();
  }
});

test('push provider unavailability is disclosed only when enrolled tokens exist', async () => {
  const oldFCM = process.env.FCM_ENABLED;
  process.env.FCM_ENABLED = 'false';
  const owner = client();
  db.prepare(
    "INSERT INTO memberships (id,room_id,email,name,flags) VALUES ('push-user','room','push@example.test','Push','{\"fcmTokens\":[\"device-token\"]}')",
  ).run();
  try {
    owner.send('join', { roomID: 'room', token: 'owner' });
    await flush();
    owner.send('alert', { txt: 'push notice' });
    owner.send('alert', { txt: 'no push', dontPush: true });
    await flush();
    assert.ok(take(owner, 'alert').some((x) => x.text === 'push notice'));
    assert.equal(
      take(owner, 'error').filter((e) => /push delivery failed/i.test(e.message)).length,
      1,
    );
    const row = db
      .prepare(
        "SELECT details FROM audit_events WHERE room_id='room' AND action='alert_delivery_unavailable' ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    assert.equal(JSON.parse(row.details).channel, 'push');
    assert.equal(row.details.includes('device-token'), false);
  } finally {
    owner.emit('close');
    if (oldFCM === undefined) delete process.env.FCM_ENABLED;
    else process.env.FCM_ENABLED = oldFCM;
    db.prepare("DELETE FROM memberships WHERE id='push-user'").run();
  }
});

test('room resource deletion blocks joins, purges jobs and preserves state on Janus failure', async () => {
  const oldDestroy = media.destroyRoom;
  let release;
  media.destroyRoom = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  db.prepare("INSERT INTO sessions(uuid,owner_id,name) VALUES ('cleanup','owner','Cleanup')").run();
  db.prepare("INSERT INTO realtime_media_rooms VALUES ('cleanup',700,701)").run();
  db.prepare(
    "INSERT INTO realtime_scheduled(id,room_id,user_id,name,text,send_at) VALUES ('cleanup-alert','cleanup','owner','Owner','future',?)",
  ).run(Date.now() + 60000);
  db.prepare(
    "INSERT INTO webhook_jobs(id,room_id,visit_id,event_type,url,payload) VALUES ('cleanup-hook','cleanup','v','join','http://127.0.0.1:1','{}')",
  ).run();
  const owner = client(),
    joiner = client();
  try {
    owner.send('join', { roomID: 'cleanup', token: 'owner' });
    await flush();
    const cleaning = realtime.deleteRoomResources('cleanup');
    await flush();
    joiner.send('join', { roomID: 'cleanup', token: 'viewer' });
    await flush();
    assert.ok(take(joiner, 'loginFailed').some((x) => /being deleted/.test(x)));
    release();
    await cleaning;
    assert.equal(realtime.getRoomCounts('cleanup').current, 0);
    for (const table of ['realtime_media_rooms', 'realtime_scheduled', 'webhook_jobs'])
      assert.equal(
        db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE room_id='cleanup'`).get().n,
        0,
      );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM audit_events WHERE room_id='cleanup'").get().n > 0,
      true,
    );
    realtime.cancelRoomDeletion('cleanup');
    db.prepare("INSERT INTO realtime_media_rooms VALUES ('cleanup',700,701)").run();
    media.destroyRoom = async () => {
      throw Error('Janus unavailable');
    };
    await assert.rejects(realtime.deleteRoomResources('cleanup'), /Janus unavailable/);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM realtime_media_rooms WHERE room_id='cleanup'").get().n,
      1,
    );
    joiner.send('join', { roomID: 'cleanup', token: 'viewer' });
    await flush();
    assert.ok(take(joiner, 'loggedIn').length);
  } finally {
    owner.emit('close');
    joiner.emit('close');
    media.destroyRoom = oldDestroy;
    realtime.cancelRoomDeletion('cleanup');
    db.prepare("DELETE FROM realtime_media_rooms WHERE room_id='cleanup'").run();
    db.prepare("DELETE FROM sessions WHERE uuid='cleanup'").run();
  }
});

test('unconfigured external providers fail without fabricating delivery or stream state', async () => {
  const oldOBS = process.env.OBS_INGEST_ENABLED;
  process.env.OBS_INGEST_ENABLED = 'false';
  const owner = client();
  try {
    owner.send('join', { roomID: 'room', token: 'owner' });
    await flush();
    for (const cmd of ['startYTStream', 'startFBStream', 'startOBSStream', 'dialOutPhone'])
      owner.send(cmd, { phone: '5551234567' });
    await flush();
    assert.equal(take(owner, 'error').length, 4);
    assert.ok(take(owner, 'error').some((e) => /Telephone provider/.test(e.message)));
    assert.ok(take(owner, 'error').some((e) => /OBS ingest/.test(e.message)));
    assert.equal(take(owner, 'getRoomState').at(-1).isRecording, false);
    db.prepare("UPDATE sessions SET settings=? WHERE uuid='room'").run(
      JSON.stringify({ hasAlertTxt: true, hasAlertTwitter: true }),
    );
    owner.send('alert', { txt: 'not delivered', sendTxt: true });
    owner.send('alertLater', {
      txt: 'not scheduled',
      sendAt: new Date(Date.now() + 60000).toISOString(),
      sendTweet: true,
    });
    await flush();
    assert.equal(db.prepare("SELECT COUNT(*) n FROM alerts WHERE text='not delivered'").get().n, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM realtime_scheduled WHERE text='not scheduled'").get().n,
      1,
    );
    assert.ok(take(owner, 'error').some((e) => /SMS delivery failed/i.test(e.message)));
  } finally {
    owner.emit('close');
    if (oldOBS === undefined) delete process.env.OBS_INGEST_ENABLED;
    else process.env.OBS_INGEST_ENABLED = oldOBS;
    db.prepare("DELETE FROM realtime_scheduled WHERE text='not scheduled'").run();
    db.prepare("UPDATE sessions SET settings='{}' WHERE uuid='room'").run();
  }
});

test('enabled alert channels invoke configured notification adapters after room persistence', async () => {
  const n = require('../src/services/notifications'),
    oldPush = n.sendPush,
    oldSMS = n.sendSMS,
    seen = [];
  n.sendPush = async (args) => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts WHERE id=?').get(args.alertID).n, 1);
    seen.push(['push', args]);
    return { accepted: 1 };
  };
  n.sendSMS = async (args) => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts WHERE id=?').get(args.alertID).n, 1);
    seen.push(['sms', args]);
    return { accepted: 1 };
  };
  const owner = client();
  try {
    db.prepare("UPDATE sessions SET settings=? WHERE uuid='room'").run(
      JSON.stringify({ hasAlertTxt: true }),
    );
    owner.send('join', { roomID: 'room', token: 'owner' });
    await flush();
    owner.send('alert', { txt: 'channel delivery', sendTxt: true });
    await flush();
    assert.deepEqual(
      seen.map((x) => x[0]),
      ['push', 'sms'],
    );
    assert.equal(seen[0][1].alertID, seen[1][1].alertID);
    assert.equal(seen[0][1].text, 'channel delivery');
    assert.equal(take(owner, 'error').length, 0);
  } finally {
    owner.emit('close');
    n.sendPush = oldPush;
    n.sendSMS = oldSMS;
    db.prepare("UPDATE sessions SET settings='{}' WHERE uuid='room'").run();
  }
});

test('media restart isolates the room, blocks concurrent work and refuses active recordings', async () => {
  const oldProvision = media.provision,
    oldDestroy = media.destroyRoom,
    oldURL = process.env.JANUS_URL;
  let release,
    destroyed = [];
  process.env.JANUS_URL = 'http://janus.test/janus';
  media.destroyRoom = (id) => {
    destroyed.push(id);
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  media.provision = async (id) => ({
    audio_id: 701,
    video_id: 702,
    ready: true,
    videoReady: true,
    streamServer: '/janus',
  });
  const owner = client(),
    other = client(),
    joiner = client();
  try {
    owner.send('join', { roomID: 'room', token: 'owner' });
    other.send('join', { roomID: 'other-room', token: 'other' });
    await flush();
    db.prepare(
      "INSERT INTO recordings(id,room_id,title,status) VALUES('reset-active','room','Test','recording')",
    ).run();
    await assert.rejects(realtime.restartRoomMedia('room'), /active recording/);
    db.prepare("DELETE FROM recordings WHERE id='reset-active'").run();
    const resetting = realtime.restartRoomMedia('room');
    await flush();
    joiner.send('join', { roomID: 'room', token: 'viewer' });
    owner.send('chat', 'during-reset');
    await flush();
    assert.ok(take(joiner, 'loginFailed').length);
    assert.ok(take(owner, 'error').length);
    await assert.rejects(realtime.restartRoomMedia('room'), /maintenance/);
    release();
    assert.deepEqual(await resetting, {
      roomID: 'room',
      audioRoomID: 701,
      videoRoomID: 702,
      restarted: true,
    });
    assert.deepEqual(destroyed, ['room']);
    assert.equal(take(owner, 'restartRoomReload').length, 1);
    assert.equal(take(other, 'restartRoomReload').length, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM messages WHERE text='during-reset'").get().n,
      0,
    );
    media.destroyRoom = async () => {};
    media.provision = async () => ({ ready: false });
    await assert.rejects(realtime.restartRoomMedia('room'), /could not provision/);
    assert.equal(take(owner, 'restartRoomReload').length, 2);
  } finally {
    owner.emit('close');
    other.emit('close');
    joiner.emit('close');
    media.provision = oldProvision;
    media.destroyRoom = oldDestroy;
    if (oldURL === undefined) delete process.env.JANUS_URL;
    else process.env.JANUS_URL = oldURL;
    db.prepare("DELETE FROM recordings WHERE id='reset-active'").run();
  }
});
