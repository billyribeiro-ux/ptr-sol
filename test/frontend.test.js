const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
let server, base, dir;
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-frontend-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dir,
      JANUS_URL: 'http://127.0.0.1:1/janus',
      GIPHY_API_KEY: '',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(`server exited ${server.exitCode}`);
    try {
      if ((await fetch(base + '/health')).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
});
after(() => {
  if (server) server.kill();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
async function post(route, body) {
  const r = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
test('entry pages and original frontend assets resolve from nested room routes', async () => {
  for (const route of ['/ptrApp', '/session', '/session/room-123']) {
    const r = await fetch(base + route);
    assert.equal(r.status, 200, route);
    const html = await r.text();
    assert.match(html, /ng-app="app"/);
    assert.match(html, /\/public\/dist\/app\.min\.js/);
    if (route.endsWith('room-123')) assert.match(html, /var __roomID = "room-123"/);
  }
  for (const route of [
    '/',
    '/public/app/views/page.login.html',
    '/public/app/views/files.html',
    '/public/app/views/userInfo.html',
    '/public/app/views/pollPopup.html',
    '/public/contact.html',
    '/public/images/GDPR-Privacy-Policy-Logo.png',
    '/public/html/c.png',
    '/public/detached/index.html',
    '/public/detached/main.c68afeac33037ad8b374.js',
    '/public/app/fonts/glyphicons-halflings-regular.woff2',
  ]) {
    const r = await fetch(base + route);
    assert.equal(r.status, 200, route);
    assert.ok((await r.arrayBuffer()).byteLength > 100, route);
  }
  const bundle = await (await fetch(base + '/public/dist/app.min.js')).text();
  assert.doesNotMatch(bundle, /templateUrl:"(?:app|public\/app)\/views\//);
  assert.match(bundle, /templateUrl:"\/public\/app\/views\/files\.html"/);
});
test('account, session listing, and room login return original-client response fields', async () => {
  const account = {
    name: 'Fixture Owner',
    email: 'fixture@example.test',
    pw: 'correct-horse-battery',
    source: 'webApp',
  };
  const signup = (await post('/users/v1/signup', account)).body;
  assert.equal(signup.success, true);
  assert.equal(signup.name, account.name);
  assert.ok(signup.token);
  assert.ok(signup.roomUUID);
  const login = (await post('/users/v1/login', account)).body;
  assert.equal(login.success, true);
  assert.ok(login.token);
  const sessions = (
    await post('/users/v1/sessions', { cmd: 'list', token: login.token, source: 'webApp' })
  ).body;
  assert.ok(Array.isArray(sessions));
  const room = sessions.find((s) => s.uuid === signup.roomUUID);
  assert.ok(room);
  assert.equal(room.isMainRoom, true);
  const alias = (
    await post('/users/v1/sessions', {
      cmd: 'changeCustomURL',
      sessionID: room.uuid,
      token: login.token,
      cname: 'fixture-room',
    })
  ).body;
  assert.equal(alias.success, true);
  const unique = (
    await post('/users/v1/sessions', {
      cmd: 'uniqueLinkLogin',
      sessionID: room.uuid,
      token: login.token,
    })
  ).body;
  assert.equal(unique.success, true);
  assert.ok(unique.uniqueLinkLogin);
  for (const [route, isRegistration] of [
    [`/u/${room.uuid}`, false],
    [`/r/${room.uuid}`, true],
    ['/room/fixture-room', false],
    [`/room/${unique.uniqueLinkLogin}`, false],
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    const html = await response.text();
    assert.ok(html.includes(`var __roomID = "${room.uuid}";`), route);
    assert.match(
      html,
      isRegistration
        ? /var __isReg = (?:'true'|"true"|true);/
        : /var __isReg = (?:'false'|"false"|false);/,
    );
  }
  assert.equal((await fetch(base + '/room/no-such-room')).status, 404);
  const publicRoom = (
    await post('/users/v1/sessions', { cmd: 'sessionPubData', sessionID: room.uuid })
  ).body;
  assert.equal(publicRoom.uuid, room.uuid);
  assert.equal(publicRoom.name, room.name);
  const chat = (
    await post('/users/v1/users.json', {
      cmd: 'loginChat',
      roomID: room.uuid,
      email: account.email,
      pw: account.pw,
      token: login.token,
      tagline: '',
      pin: '',
      siteToken: '',
    })
  ).body;
  assert.equal(chat.uuid, room.uuid);
  assert.equal(chat.name, room.name);
  assert.ok(chat.token);
  assert.ok(chat._id);
  const bundle = await (await fetch(base + '/public/dist/app.min.js')).text();
  assert.match(bundle, /chatModel\.roomToken=data\.token\|\|null/);
  assert.match(bundle, /jwtToken:service\.roomToken\|\|service\.jwtToken/);
  const failed = (
    await post('/users/v1/login', { email: account.email, pw: 'wrong', source: 'webApp' })
  ).body;
  assert.equal(failed.success, false);
  assert.equal(typeof failed.message, 'string');
});
test('detached chat uses same-origin, opener-validated messages on local ports', async () => {
  const main = await (await fetch(base + '/public/dist/app.min.js')).text();
  const detached = await (
    await fetch(base + '/public/detached/main.c68afeac33037ad8b374.js')
  ).text();
  assert.match(
    main,
    /event\.origin!==window\.location\.origin\|\|event\.source!==service\.detachedChatHandle/,
  );
  assert.match(main, /postMessage\(o,window\.location\.origin\)/);
  assert.match(detached, /e\.origin===window\.location\.origin&&e\.source===window\.opener/);
  assert.doesNotMatch(detached, /postMessage\(\{cmd:"(?:sendMsg|sendAlert)"[^}]*\},"\*"\)/);
});
test('consent choice controls banner and copied tracking accounts are absent', async () => {
  const vm = require('node:vm');
  const html = await (await fetch(base + '/')).text();
  assert.doesNotMatch(html, /googletagmanager|google-analytics|embed\.tawk\.to|w\.sharethis\.com/);
  const script = html.match(
    /<script type="text\/javascript">\s*\(function \(\) \{\s*\/\/ Show banner[\s\S]*?<\/script>/,
  )?.[0];
  assert.ok(script, 'consent script');
  const banner = { style: { display: 'none' } },
    values = new Map();
  const context = {
    document: { getElementById: () => banner },
    localStorage: {
      getItem: (key) => values.get(key),
      setItem: (key, value) => values.set(key, value),
    },
  };
  vm.runInNewContext(script.replace(/^<script[^>]*>|<\/script>$/g, ''), context);
  assert.equal(banner.style.display, 'block');
  context.rejectCookies();
  assert.equal(values.get('gdprConsent'), 'rejected');
  assert.equal(banner.style.display, 'none');
  banner.style.display = 'block';
  context.acceptCookies();
  assert.equal(values.get('gdprConsent'), 'accepted');
  assert.equal(banner.style.display, 'none');
});
test('legacy WebRTC shims do not request media until called', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(root, 'public/ptr-config.js'), 'utf8');
  let requests = 0;
  const stream = {};
  const navigator = {
    userAgent: 'Mozilla/5.0 Chrome/120.0',
    mediaDevices: {
      getUserMedia: async () => {
        requests++;
        return stream;
      },
    },
  };
  const window = { navigator, RTCPeerConnection: function () {} };
  vm.runInNewContext(source, { window, navigator });
  assert.equal(requests, 0);
  assert.equal(typeof window.getUserMedia, 'function');
  const element = {};
  assert.equal(window.attachMediaStream(element, stream), element);
  assert.equal(element.srcObject, stream);
  assert.equal(window.webrtcDetectedBrowser, 'chrome');
  return new Promise((resolve, reject) =>
    window.getUserMedia(
      { audio: true },
      (actual) => {
        try {
          assert.equal(actual, stream);
          assert.equal(requests, 1);
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      reject,
    ),
  );
});
test('core frontend assets and captured API docs return valid content', async () => {
  const assets = [
    ['/public/app/css/bootstrap.min.css', 'css'],
    ['/public/app/css/styles.css', 'css'],
    ['/public/css/compiled/theme.css', 'css'],
    ['/public/css/main.css', 'css'],
    ['/public/vendor/angularjs-color-picker/angularjs-color-picker.min.css', 'css'],
    ['/public/vendor/angular-xeditable/dist/css/xeditable.min.css', 'css'],
    ['/public/vendor/textAngular/src/textAngular.css', 'css'],
    ['/public/images/ptr_logo.png', 'png'],
    ['/public/images/colorPicker.png', 'png'],
    ['/public/images/notalking.png', 'png'],
    ['/public/images/protradingroom_icon.png', 'png'],
    ['/public/images/typing.gif', 'gif'],
    ['/public/images/talking.gif', 'gif'],
    ['/public/app/img/ajax_loader.gif', 'gif'],
    ['/public/app/img/user/01.jpg', 'jpg'],
    ['/public/app/sounds/beep.mp3', 'mp3'],
    ['/public/app/sounds/cash.mp3', 'mp3'],
    ['/public/app/sounds/ding.mp3', 'mp3'],
    ['/public/app/sounds/fileShare.mp3', 'mp3'],
    ['/public/app/sounds/message.mp3', 'mp3'],
    ['/public/app/sounds/newMessage.mp3', 'mp3'],
    ['/public/app/sounds/pling.mp3', 'mp3'],
    ['/public/app/sounds/userJoin.mp3', 'mp3'],
    ['/public/app/sounds/userLeave.mp3', 'mp3'],
    ['/public/app/fonts/glyphicons-halflings-regular.woff2', 'woff2'],
    ['/public/vendor/font-awesome/fonts/fontawesome-webfont.woff2', 'woff2'],
  ];
  for (const [route, kind] of assets) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    const data = Buffer.from(await response.arrayBuffer());
    assert.ok(data.length > 100, route);
    assert.doesNotMatch(
      data.subarray(0, 200).toString('utf8'),
      /this is not the page you are looking for|<!doctype html|<html/i,
      route,
    );
    if (kind === 'png')
      assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', route);
    if (kind === 'gif') assert.match(data.subarray(0, 6).toString(), /^GIF8[79]a$/, route);
    if (kind === 'jpg') assert.equal(data.subarray(0, 3).toString('hex'), 'ffd8ff', route);
    if (kind === 'woff2') assert.equal(data.subarray(0, 4).toString(), 'wOF2', route);
    if (kind === 'mp3')
      assert.ok(
        data.subarray(0, 3).toString() === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0),
        route,
      );
    if (kind === 'css')
      assert.match(response.headers.get('content-type') || '', /text\/css/, route);
  }
  const docsPage = await fetch(
    base + '/public/html/api-docs.html?src=/public/html/API_Documentation.md',
  );
  assert.equal(docsPage.status, 200);
  const docsHTML = await docsPage.text();
  assert.match(docsHTML, /API Documentation/);
  assert.match(docsHTML, /\/public\/vendor\/marked\/15\.0\.12\/marked\.min\.js/);
  assert.match(docsHTML, /DOMPurify\.sanitize\(marked\.parse\(text\)\)/);
  assert.equal((await fetch(base + '/public/vendor/marked/15.0.12/marked.min.js')).status, 200);
  const docs = await fetch(base + '/public/html/API_Documentation.md');
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /Sessions API Documentation/);
});
test('room entry accepts valid example domains and diagnostic output redacts credentials', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(root, 'public/ptr-config.js'), 'utf8');
  const logs = [];
  const navigator = { userAgent: '', mediaDevices: {} };
  const window = { navigator, console: { log: (...args) => logs.push(args) } };
  const context = { window, navigator, console: window.console };
  vm.runInNewContext(source, context);
  window.console.log('login rc={"token":"secret-token","pw":"secret-password"}', {
    jwtTokenSite: 'other-secret',
    roomID: 'room-1',
  });
  assert.doesNotMatch(JSON.stringify(logs), /secret-token|secret-password|other-secret/);
  assert.match(JSON.stringify(logs), /room-1/);
  const app = fs.readFileSync(path.join(root, 'public/dist/app.min.js'), 'utf8');
  assert.doesNotMatch(app, /email\.indexOf\("@example\.com"\)/);
  assert.match(app, /ptrRedactLog\(arguments\[0\]\)/);
  const login = fs.readFileSync(path.join(root, 'public/app/views/page.login.html'), 'utf8');
  assert.match(login, /ng-submit="submitSessionLogin\(\)"/);
  assert.doesNotMatch(login, /onsubmit="return false;"/);
});
test('Angular media services all receive the configured same-origin Janus URL', () => {
  const app = fs.readFileSync(path.join(root, 'public/dist/app.min.js'), 'utf8');
  for (const key of ['janusHOST', 'janusHOSTAudio', 'janusHOSTStream']) {
    assert.ok(
      app.includes(`${key}:PTR_CONFIG.janusURL||"/janus"`),
      `${key} has no configured default`,
    );
  }
  assert.match(app, /service\.server=appVars\.globals\.janusHOSTAudio/);
});
test('demo signup returns the two identifiers used by the original createNew flow', async () => {
  const signup = (
    await post('/users/v1/signup', {
      name: 'Demo Owner',
      email: 'demo-owner@example.test',
      pw: 'demo-password',
      demo: true,
      source: 'webApp',
    })
  ).body;
  assert.equal(signup.success, true);
  assert.ok(signup.token);
  assert.equal(signup.roomUUID, '');
  const room = (
    await post('/users/v1/users.json', {
      cmd: 'newSession',
      email: 'demo-owner@example.test',
      token: signup.token,
      demoRoom: true,
    })
  ).body;
  assert.equal(room.success, true);
  assert.ok(room.uuid);
  assert.ok(room._id);
  assert.notEqual(room.uuid, room._id);
  const detail = (
    await post('/users/v1/sessions', {
      cmd: 'sessionDetails',
      sessionID: room._id,
      token: signup.token,
    })
  ).body;
  assert.equal(detail.success, true);
  assert.equal(detail.session.uuid, room.uuid);
});
test('chat URL wrappers reject dangerous schemes and serialize URL text safely', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(root, 'public/ptr-config.js'), 'utf8');
  const escape = (value) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  function element(tag) {
    return {
      tag,
      attrs: {},
      children: [],
      textContent: '',
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      appendChild(el) {
        this.children.push(el);
      },
      set href(v) {
        this.attrs.href = v;
      },
      set src(v) {
        this.attrs.src = v;
      },
      set target(v) {
        this.attrs.target = v;
      },
      set rel(v) {
        this.attrs.rel = v;
      },
      set className(v) {
        this.attrs.class = v;
      },
      get outerHTML() {
        return (
          '<' +
          tag +
          Object.entries(this.attrs)
            .map(([k, v]) => ' ' + k + '="' + escape(v) + '"')
            .join('') +
          '>' +
          escape(this.textContent) +
          this.children.map((c) => c.outerHTML).join('') +
          '</' +
          tag +
          '>'
        );
      },
    };
  }
  const document = { createElement: element, addEventListener() {} };
  const navigator = { userAgent: '', mediaDevices: {} };
  const window = { navigator };
  const context = { document, navigator, window, URL };
  vm.runInNewContext(source, context);
  assert.equal(context.ptrSafeHttpURL('javascript:alert(1)'), null);
  assert.match(context.ptrLinkHTML('javascript:alert(1)'), /^<span>/);
  const url = 'https://example.test/"onmouseover="alert(1).png';
  for (const html of [context.ptrLinkHTML(url), context.ptrImageHTML(url, true)]) {
    assert.doesNotMatch(html, /\sonmouseover=/i);
    assert.doesNotMatch(html, /onclick=/i);
    assert.match(html, /%22onmouseover=/i);
  }
  const shell = fs.readFileSync(path.join(root, 'public/ptrApp.html'), 'utf8');
  assert.ok(
    shell.indexOf('/public/vendor/dompurify/purify.min.js') >
      shell.indexOf('/public/dist/vendor.min.js'),
  );
});
test('stream presenters can be tracked without adding hidden users to the roster', () => {
  const vm = require('node:vm');
  const app = fs.readFileSync(path.join(root, 'public/dist/app.min.js'), 'utf8');
  const start = app.indexOf('function ptrMediaPresenter(data)');
  const end = app.indexOf('function ptrJoinRoom(', start);
  assert.ok(start >= 0 && end > start);
  const service = { presroster: {}, roster: {}, mediaPresenters: {} };
  const context = { service };
  vm.runInNewContext(app.slice(start, end), context);
  const presenter = context.ptrMediaPresenter({
    uid: 'media-user',
    nick: 'Speaker',
    roomID: 15,
    pub_id: 20,
  });
  assert.equal(presenter.uid, 'media-user');
  assert.equal(presenter.nick, 'Speaker');
  assert.equal(Object.keys(service.presroster).length, 0);
  assert.equal(Object.keys(service.roster).length, 0);
  assert.equal(service.mediaPresenters['media-user'], presenter);
});
test('rich HTML is sanitized before trust and message text is escaped before insertion', () => {
  const vm = require('node:vm');
  const app = fs.readFileSync(path.join(root, 'public/dist/app.min.js'), 'utf8');
  assert.equal((app.match(/\$sce\.trustAsHtml\(DOMPurify\.sanitize\(/g) || []).length, 2);
  assert.doesNotMatch(app, /\$sce\.trustAsHtml\(html_code\)/);
  assert.doesNotMatch(app, /\$\(\$\.parseHTML\(msg\.text\)\)\.text\(\)\.replace\(/);
  assert.doesNotMatch(app, /\+b\.text\+/);
  assert.doesNotMatch(app, /onclick="imageModal/);
  assert.doesNotMatch(app, /<img src="'\+msg\.img/);
  assert.match(app, /ptrImagePreviewHTML\(data\.img,200,!0\)/);
  assert.match(app, /ptrSafeColor\(custObj\.bkgColor\)/);
  const navigator = { userAgent: '', mediaDevices: {} };
  const window = { navigator };
  const context = { window, navigator, URL };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/ptr-config.js'), 'utf8'), context);
  const safe = context.ptrLinkifyText(
    '<img src=x onerror=alert(1)> https://example.test/',
    (value) => '[' + value + ']',
  );
  assert.match(safe, /&lt;img/);
  assert.doesNotMatch(safe, /<img/);
  assert.equal(context.ptrSafeColor('red" onmouseover="alert(1)'), 'inherit');
  assert.equal(context.ptrSafeColor('#ffcc00'), '#ffcc00');
  const view = fs.readFileSync(path.join(root, 'public/app/views/page.manageSession.html'), 'utf8');
  assert.match(
    view,
    /saveSessField\('logout_webhook_url'\)" editable-textarea="sess\.logout_webhook_url"/,
  );
});
test('image and GIF controls use authenticated local endpoints', async () => {
  const app = fs.readFileSync(path.join(root, 'public/dist/app.min.js'), 'utf8');
  assert.equal((app.match(/url:"\/users\/v1\/images\/upload"/g) || []).length, 3);
  assert.doesNotMatch(app, /imgur-apiv3|api\.giphy\.com/);
  for (const file of ['dashboard.html', 'dashboard-alt.html']) {
    const view = fs.readFileSync(path.join(root, 'public/app/views', file), 'utf8');
    assert.match(view, /gifSearchError/);
  }
  const account = {
    name: 'Image Owner',
    email: 'image-owner@example.test',
    pw: 'correct-horse-battery',
    source: 'webApp',
  };
  const signup = (await post('/users/v1/signup', account)).body;
  assert.equal(signup.success, true);
  const login = await fetch(base + '/users/v1/users.json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cmd: 'loginChat',
      roomID: signup.roomUUID,
      email: account.email,
      pw: account.pw,
      siteToken: signup.token,
    }),
  });
  const session = await login.json();
  assert.equal(session.uuid, signup.roomUUID);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const form = new FormData();
  form.append('roomID', signup.roomUUID);
  form.append(
    'file',
    new Blob([fs.readFileSync(path.join(root, 'public/images/1.png'))], { type: 'image/png' }),
    'sample.png',
  );
  const uploaded = await fetch(base + '/users/v1/images/upload', {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
  const result = await uploaded.json();
  assert.equal(uploaded.status, 200, JSON.stringify(result));
  assert.equal(result.success, true);
  assert.ok(result.data.link);
  const image = await fetch(new URL(result.data.link, base), { headers: { cookie } });
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /^image\/png/);
  assert.equal(
    Buffer.from(await image.arrayBuffer())
      .subarray(0, 8)
      .toString('hex'),
    '89504e470d0a1a0a',
  );
  const noAuth = await fetch(new URL(result.data.link, base));
  assert.ok([401, 403].includes(noAuth.status));
  const ownerLogin = await fetch(base + '/users/v1/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(account),
  });
  const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0],
    ownerToken = (await ownerLogin.json()).token;
  const badgeForm = new FormData();
  badgeForm.append('roomID', '');
  badgeForm.append(
    'file',
    new Blob([fs.readFileSync(path.join(root, 'public/images/1.png'))], { type: 'image/png' }),
    'badge.png',
  );
  const badgeUpload = await fetch(base + '/users/v1/images/upload', {
    method: 'POST',
    headers: { cookie: ownerCookie, authorization: 'Bearer ' + ownerToken },
    body: badgeForm,
  });
  const badgeResult = await badgeUpload.json();
  assert.equal(badgeUpload.status, 200, JSON.stringify(badgeResult));
  assert.equal(badgeResult.data.name, 'badge.png');
  assert.equal(
    (await fetch(new URL(badgeResult.data.link, base), { headers: { cookie: ownerCookie } }))
      .status,
    200,
  );
  const gif = await fetch(
    base + '/users/v1/images/giphy?roomID=' + encodeURIComponent(signup.roomUUID) + '&q=market',
    { headers: { cookie } },
  );
  assert.equal(gif.status, 503);
  assert.match((await gif.json()).message, /unavailable|configur/i);
});
test('desktop shell loads required original dependency versions locally', async () => {
  const shell = await (await fetch(base + '/ptrApp')).text();
  for (const route of [
    '/public/vendor/split/1.5.11/split.min.js',
    '/public/vendor/videojs/7.3.0/video-js.min.css',
    '/public/vendor/videojs/7.3.0/video.min.js',
    '/public/vendor/videojs-youtube/2.6.0/Youtube.min.js',
    '/public/vendor/angularjs-toaster/2.2.0/toaster.min.css',
    '/public/vendor/angularjs-toaster/2.2.0/toaster.min.js',
    '/public/vendor/sockjs/1.4.0/sockjs.min.js',
  ]) {
    assert.ok(shell.includes(route), route);
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    const data = Buffer.from(await response.arrayBuffer());
    assert.ok(data.length > 1000, route);
    assert.doesNotMatch(data.subarray(0, 100).toString(), /<!doctype html|<html/i, route);
  }
});
test('poll and modal action links do not navigate away from the active room', () => {
  for (const name of [
    'pollPopup.html',
    'userInfo.html',
    'dashboard.html',
    'dashboard-alt.html',
    'page.manageSession.html',
    'cached/top-navbar.html',
  ]) {
    const markup = fs.readFileSync(path.join(root, 'public/app/views', name), 'utf8');
    assert.doesNotMatch(markup, /href=["']#["']/, name);
  }
  const poll = fs.readFileSync(path.join(root, 'public/app/views/pollPopup.html'), 'utf8');
  for (const audience of ['everyone', 'members', 'trials'])
    assert.ok(poll.includes(`href="" ng-click="sendPoll('${audience}')"`));
});
test('room default theme honors the setting without replacing a saved choice', () => {
  const app = fs.readFileSync(path.join(root, 'public/dist/app.min.js'), 'utf8');
  assert.match(
    app,
    /null!=themeClass&&0!=themeClass\.length\|\|\$scope\.switchTheme\(appVars\.sessData\.darkThemeAsDefault\?"dark":"light"\)/,
  );
});
test('settings audit inventories every captured control without claiming unverified parity', () => {
  const audit = JSON.parse(
    fs.readFileSync(path.join(root, 'contracts/settings-parity.json'), 'utf8'),
  );
  assert.equal(audit.settings.length, 268);
  assert.deepEqual(
    audit.settings.map((x) => x.number),
    Array.from({ length: 268 }, (_, i) => i + 1),
  );
  assert.ok(audit.interpretation.some((x) => /not a 268-setting parity certification/.test(x)));
  assert.equal(
    audit.settings.find((x) => x.number === 15).current_property,
    'sess.logout_webhook_url',
  );
  assert.equal(
    audit.settings.find((x) => x.current_property === 'sess.darkThemeAsDefault').targeted_test
      .status,
    'source_assertion_only; browser behavior not independently exercised',
  );
  assert.ok(
    audit.routes.some((route) => route.state === 'page.manageSession' && route.template_present),
  );
  assert.ok(fs.existsSync(path.join(root, audit.provenance.settings_spec)));
  const view = fs.readFileSync(path.join(root, 'public/app/views/page.manageSession.html'), 'utf8');
  assert.doesNotMatch(view, /editable-textarea="sess\.chatServerURL"/);
  assert.match(view, /managed locally/);
});
test('captured setting fields persist except the enforced local chat endpoint', async () => {
  const audit = JSON.parse(
    fs.readFileSync(path.join(root, 'contracts/settings-parity.json'), 'utf8'),
  );
  const signup = (
    await post('/users/v1/signup', {
      name: 'Settings Owner',
      email: 'all-settings@example.test',
      pw: 'settings-password',
      source: 'webApp',
    })
  ).body;
  assert.equal(signup.success, true);
  const expected = new Map();
  for (const setting of audit.settings) {
    if (!setting.current_property) continue;
    const fieldName = setting.current_property.slice(5);
    let fieldVal =
      setting.input_type === 'editable-checkbox'
        ? true
        : setting.input_type === 'editable-number'
          ? 2
          : 'example';
    if (fieldName === 'isArchivedRoom') fieldVal = false;
    if (fieldName === 'autoOpenTime') fieldVal = '09:30';
    if (fieldName === 'autoCloseTime') fieldVal = '17:00';
    if (fieldName === 'tokenExpiresIn') fieldVal = '12h';
    const response = await post('/users/v1/sessions', {
      cmd: 'saveSessField',
      sessionID: signup.roomUUID,
      token: signup.token,
      fieldName,
      fieldVal,
    });
    assert.equal(response.status, 200, `${fieldName}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.success, true, fieldName);
    expected.set(fieldName, fieldVal);
  }
  const result = (
    await post('/users/v1/sessions', {
      cmd: 'sessionDetails',
      sessionID: signup.roomUUID,
      token: signup.token,
    })
  ).body;
  assert.equal(result.success, true);
  const mismatches = [];
  assert.equal(expected.size, 265);
  for (const [field, value] of expected) {
    const effective = field === 'chatServerURL' ? '/talk' : value;
    if (JSON.stringify(result.session[field]) !== JSON.stringify(effective))
      mismatches.push({ field, expected: effective, actual: result.session[field] });
  }
  assert.deepEqual(mismatches, []);
});
test('OBS uses server-issued ingest details and watches OBS streaming mounts', () => {
  const app = fs.readFileSync(path.join(root, 'public/dist/app.min.js'), 'utf8');
  assert.match(app, /chatModel\.send\("startOBSStream",options\)/);
  assert.match(app, /case"obsIngestReady":service\.obsIngestURL/);
  assert.match(app, /"obs"==data\.mode\?\(user\.isOBSStream=!0/);
  assert.match(
    app,
    /webRTCStreamService\.joinScreen\("screen",user\.streamID,service\.uid,service\.streamServer\)/,
  );
  assert.doesNotMatch(app, /appVars\.pubSessionData\._id\+"-"\+user\.email/);
  const config = fs.readFileSync(path.join(root, 'public/ptr-config.js'), 'utf8');
  assert.match(config, /function ptrShowObsIngest\(raw\)/);
  assert.doesNotMatch(config, /console\.(?:log|info|debug)\([^)]*(?:obsIngest|Stream Key)/i);
});
test('each local Janus session uses the current room token before and after rotation', () => {
  const app = fs.readFileSync(path.join(root, 'public/dist/app.min.js'), 'utf8');
  assert.match(
    app,
    /chatModel\.roomToken=data\.token\|\|null,appVars\.globals\.roomToken=chatModel\.roomToken/,
  );
  assert.match(
    app,
    /case"setToken":\$localstorage\.set\("token",evt\.data\);service\.jwtToken=evt\.data,service\.roomToken=evt\.data,appVars\.globals\.roomToken=evt\.data/,
  );
  assert.equal(
    (
      app.match(/new Janus\(\{server:service\.server,token:appVars\.globals\.roomToken\|\|null/g) ||
      []
    ).length,
    5,
  );
});
test('token rotation updates established Janus sessions as well as future sessions', () => {
  const vm = require('node:vm');
  const app = fs.readFileSync(path.join(root, 'public/dist/app.min.js'), 'utf8');
  const start = app.indexOf('function ptrUpdateJanusToken('),
    end = app.indexOf('function ptrMediaPresenter(', start);
  assert.ok(start >= 0 && end > start);
  const tokens = [];
  const make = () => ({ janus: { setToken: (value) => tokens.push(value) } });
  const context = {
    webRTCService: { sessions: { screen: make() } },
    webRTCAudioService: { session: make() },
    webRTCStreamService: { sessions: { screen: make() } },
    webRTCCamService: { sessions: { cam: make() } },
  };
  vm.runInNewContext(app.slice(start, end), context);
  context.ptrUpdateJanusToken('rotated-room-token');
  assert.deepEqual(tokens, [
    'rotated-room-token',
    'rotated-room-token',
    'rotated-room-token',
    'rotated-room-token',
  ]);
  const janus = fs.readFileSync(path.join(root, 'public/vendor/janus3.js'), 'utf8');
  assert.match(janus, /this\.setToken = function\(value\) \{ token = value \|\| null; \}/);
});
test('OBS dialog sends optional YouTube details only after confirmation', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(root, 'public/ptr-config.js'), 'utf8');
  let dialog, alerted;
  const elements = [];
  const document = {
    addEventListener() {},
    createElement(tag) {
      const item = {
        tag,
        value: '',
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
      };
      elements.push(item);
      return item;
    },
  };
  const navigator = { userAgent: '', mediaDevices: {} };
  const window = { navigator, jQuery: (value) => value };
  const context = {
    document,
    navigator,
    window,
    URL,
    bootbox: {
      confirm: (options) => {
        dialog = options;
      },
      alert: (message) => {
        alerted = message;
      },
    },
  };
  vm.runInNewContext(src, context);
  const sent = [];
  context.ptrRequestObsStart((value) => sent.push(JSON.parse(JSON.stringify(value))));
  dialog.callback(false);
  assert.equal(sent.length, 0);
  dialog.callback(true);
  assert.deepEqual(sent, [{}]);
  context.ptrRequestObsStart((value) => sent.push(JSON.parse(JSON.stringify(value))));
  const inputs = dialog.message.children.filter((item) => item.tag === 'input');
  inputs[0].value = 'private-key';
  inputs[1].value = 'rtmps://a.rtmp.youtube.com/live2';
  dialog.callback(true);
  assert.deepEqual(sent[1], { ytKey: 'private-key', ytURL: 'rtmps://a.rtmp.youtube.com/live2' });
  context.ptrRequestObsStart((value) => sent.push(JSON.parse(JSON.stringify(value))));
  dialog.message.children.filter((item) => item.tag === 'input')[1].value =
    'rtmps://a.rtmp.youtube.com/live2';
  assert.equal(dialog.callback(true), false);
  assert.match(alerted, /stream key/i);
  assert.equal(sent.length, 2);
});
test('name-only roster creates just the nickname without extra participant metadata', () => {
  const vm = require('node:vm'),
    src = fs.readFileSync(path.join(root, 'public/ptr-config.js'), 'utf8');
  const document = {
    addEventListener() {},
    createElement(tag) {
      return {
        tag,
        style: {},
        children: [],
        appendChild(child) {
          this.children.push(child);
        },
      };
    },
  };
  const navigator = { userAgent: '', mediaDevices: {} };
  const window = { navigator };
  const context = { document, navigator, window, URL };
  vm.runInNewContext(src, context);
  const item = context.ptrCreateNameOnlyRosterItem(
    {
      uid: 'abc',
      nick: '<b>Alice</b>',
      email: 'private@example.test',
      tagline: 'Private location',
      badges: ['gold'],
    },
    'uRosterLi_',
  );
  assert.equal(item.id, 'uRosterLi_abc');
  const link = item.children[0].children[0].children[0];
  assert.equal(link.textContent, '<b>Alice</b>');
  assert.equal(item.children.length, 1);
  assert.doesNotMatch(JSON.stringify(item), /private@example\.test|Private location|gold/);
});
test('name-only roster setting reaches the live room session data', async () => {
  const account = {
    name: 'Roster Owner',
    email: 'roster-owner@example.test',
    pw: 'settings-password',
    source: 'webApp',
  };
  const signup = (await post('/users/v1/signup', account)).body;
  assert.equal(signup.success, true);
  const saved = await post('/users/v1/sessions', {
    cmd: 'saveSessField',
    sessionID: signup.roomUUID,
    token: signup.token,
    fieldName: 'showOnlyUsernames',
    fieldVal: true,
  });
  assert.equal(saved.body.success, true);
  const room = (
    await post('/users/v1/users.json', {
      cmd: 'loginChat',
      roomID: signup.roomUUID,
      email: account.email,
      siteToken: signup.token,
    })
  ).body;
  assert.equal(room.showOnlyUsernames, true);
});

test('recovered marketplace entry and captured assets resolve locally', async () => {
  for (const route of ['/mp/', '/mp/room-dashboard/example']) {
    const response = await fetch(base + route);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /main-A7T3JUH5\.js/);
    assert.match(html, /\/mp\/compat\.js/);
  }
  for (const route of [
    '/mp/main-A7T3JUH5.js',
    '/mp/polyfills-FFHMD2TL.js',
    '/mp/scripts-TFNFNT5Q.js',
    '/mp/styles-7QHUN6MP.css',
    '/mp/media/summernote-VA4HKLTE.woff2',
    '/mp/images/ptr_logo.png',
    '/mp/git-version.json',
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.doesNotMatch(response.headers.get('content-type') || '', /text\/html/, route);
    assert.ok((await response.arrayBuffer()).byteLength > 100, route);
  }
});

test('marketplace account bridge clears stale credentials and follows the desktop login', () => {
  const vm = require('node:vm');
  const code = fs.readFileSync(path.join(root, 'public/mp/compat.js'), 'utf8');
  const values = new Map([['PTR_token', 'stale']]);
  const localStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  vm.runInNewContext(code, { localStorage, window: {} });
  assert.equal(values.has('PTR_token'), false);
  values.set('tokenSite', 'account-token');
  vm.runInNewContext(code, { localStorage, window: {} });
  assert.equal(values.get('PTR_token'), 'account-token');
});

test('Janus delivers streamless tracks and retains the legacy stream callback', () => {
  const vm = require('node:vm');
  class FakeMediaStream {
    constructor() {
      this.tracks = [];
    }
    getTracks() {
      return this.tracks;
    }
    addTrack(track) {
      this.tracks.push(track);
    }
  }
  const context = { MediaStream: FakeMediaStream };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/vendor/janus3.js'), 'utf8'), context);
  const config = { pc: {}, remoteStream: null };
  const received = [];
  context.Janus.installRemoteTrackHandlers(config, {
    onremotestream: (stream) => received.push(stream),
  });
  const audio = { id: 'audio', kind: 'audio' },
    video = { id: 'video', kind: 'video' };
  config.pc.ontrack({ track: audio, streams: [] });
  config.pc.ontrack({ track: video, streams: [] });
  config.pc.ontrack({ track: video, streams: [] });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].getTracks(), [audio, video]);
  assert.equal(config.remoteStream.stream, received[0]);
  config.pc.onaddstream({ stream: received[0] });
  assert.equal(received.length, 1);
  const legacy = new FakeMediaStream();
  config.pc.onaddstream({ stream: legacy });
  assert.equal(received[1], legacy);
  config.pc.ontrack({ track: audio, streams: [legacy] });
  assert.equal(received.length, 2);
});

test('Janus requests receive-only audio in modern browser offers', () => {
  const vm = require('node:vm');
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/vendor/janus3.js'), 'utf8'), context);
  const modern = context.Janus.receiveConstraints(true, false, 'chrome', 140);
  assert.equal(modern.offerToReceiveAudio, true);
  assert.equal(modern.offerToReceiveVideo, false);
  assert.equal(modern.mandatory, undefined);
  const legacy = context.Janus.receiveConstraints(true, false, 'chrome', 49);
  assert.equal(legacy.mandatory.OfferToReceiveAudio, true);
  assert.equal(legacy.mandatory.OfferToReceiveVideo, false);
});

test('course checkout uses a linked membership and its server price', async () => {
  const vm = require('node:vm');
  const code = fs.readFileSync(path.join(root, 'public/mp/compat.js'), 'utf8');
  const context = {
    window: {},
    localStorage: { getItem: () => null, removeItem: () => {} },
    bootbox: { alert: (message) => alerts.push(message) },
    fetch: async () => ({
      ok: true,
      json: async () => [
        { _id: 'plan-1', planName: 'Access', amount: 9500, currency: 'usd', isActive: true },
      ],
    }),
  };
  const alerts = [],
    navigations = [];
  vm.runInNewContext(code, context);
  const router = { navigate: (route, options) => navigations.push({ route, options }) };
  await context.window.ptrCourseCheckout(
    { _id: 'course-1', marketplaceID: 'mp-1', membershipIds: ['plan-1'], price: 1 },
    router,
    '/welcome',
  );
  assert.equal(navigations.length, 1);
  assert.equal(navigations[0].options.state.membership.amount, 9500);
  assert.equal(navigations[0].options.state.membership._id, 'plan-1');
  await context.window.ptrCourseCheckout(
    { _id: 'course-2', marketplaceID: 'mp-1', membershipIds: [] },
    router,
    '/welcome',
  );
  assert.equal(navigations.length, 1);
  assert.equal(alerts.length, 1);
});
