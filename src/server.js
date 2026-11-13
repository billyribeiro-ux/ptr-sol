const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const config = require('./config');
const usersRouter = require('./routes/users');
const marketplaceRouter = require('./routes/marketplace');
const { attachSockJSServer } = require('./realtime/sockjs');
const { authenticateRequest, requireRoomAccess, extractToken } = require('./middleware/auth');
const db = require('./db/database');

const scriptJSON = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
const janusSessions = new Map();
function mediaPresenter(principal, roomID) {
  if (requireRoomAccess(principal, roomID, { manage: true })) return true;
  const actor = principal.actor_id || principal.memberId || principal.id;
  const temporary = db
    .prepare('SELECT temp_presenter FROM realtime_moderation WHERE room_id=? AND user_id=?')
    .get(roomID, actor);
  if (temporary?.temp_presenter) return true;
  return !!(principal.is_room_token && ['a', 'o', 'p'].includes(principal.perms));
}
function mediaCapability(principal, roomID, capability) {
  if (requireRoomAccess(principal, roomID, { manage: true })) return true;
  if (!mediaPresenter(principal, roomID)) return false;
  const member = db
    .prepare('SELECT flags FROM memberships WHERE room_id=? AND email=?')
    .get(roomID, principal.email);
  try {
    return JSON.parse(member?.flags || '{}')[capability] !== false;
  } catch {
    return false;
  }
}
const mediaReaper = setInterval(async () => {
  const cleanup = [];
  for (const [id, entry] of janusSessions) {
    const principal = authenticateRequest({
      headers: { authorization: `Bearer ${entry.credential}` },
    });
    const room = principal && entry.roomID && requireRoomAccess(principal, entry.roomID);
    const revokedCapability =
      principal &&
      [...entry.handles.values()].some(
        (handle) =>
          handle.roomID &&
          ((handle.sendingVideo &&
            !mediaCapability(principal, handle.roomID, handle.screen ? 'hasScreen' : 'hasCam')) ||
            (handle.sendingAudio && !mediaCapability(principal, handle.roomID, 'hasMic'))),
      );
    if (
      principal &&
      !revokedCapability &&
      (!entry.roomID || (room && (room.is_open || mediaPresenter(principal, entry.roomID)))) &&
      Date.now() - entry.created < 12 * 3600000
    )
      continue;
    janusSessions.delete(id);
    cleanup.push(
      fetch(`${config.JANUS_URL.replace(/\/$/, '')}/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          janus: 'destroy',
          transaction: `revoke-${id}`,
          apisecret: config.JANUS_API_SECRET || undefined,
        }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {}),
    );
  }
  await Promise.allSettled(cleanup);
}, 5000);
mediaReaper.unref();

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.NODE_ENV === 'production' ? 1 : false);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    const origin = req.headers.origin;
    const sameOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== sameOrigin && origin !== config.PUBLIC_ORIGIN)
      return res.status(403).json({ success: false, message: 'Origin not allowed.' });
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
    }
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-API-Key',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      });
      return res.sendStatus(204);
    }
    next();
  });
  app.use('/ptr_app/mp/v2/stripe/webhook', express.raw({ type: 'application/json', limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 1000 }));
  app.use((req, res, next) => {
    if (req.path.startsWith('/users/v1/') || req.path.startsWith('/stats/v1/')) {
      for (const object of [req.body]) {
        if (!object || typeof object !== 'object') continue;
        for (const key of ['sessionID', 'sessionId', 'roomID', 'uuid', 'sessID']) {
          if (typeof object[key] !== 'string' && typeof object[key] !== 'number') continue;
          const value = String(object[key]);
          const room = db
            .prepare('SELECT uuid FROM sessions WHERE uuid=? OR id=?')
            .get(value, value);
          if (room) object[key] = room.uuid;
        }
      }
    }
    next();
  });

  const limits = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of limits) if (value.reset < now) limits.delete(key);
  }, 60000);
  cleanup.unref();
  app.use('/users/v1', (req, res, next) => {
    const roomCommand =
      req.path === '/users.json' && ['loginChat', 'registerByEmail'].includes(req.body?.cmd)
        ? req.body.cmd
        : null;
    const sensitive =
      !!roomCommand ||
      [
        '/login',
        '/login_tok',
        '/ssoJWT',
        '/signup',
        '/demoSignup',
        '/forgot-password',
        '/user-forgot-password',
        '/change-password',
        '/user-change-password',
        '/p/contact',
      ].includes(req.path);
    if (!sensitive) return next();
    const key = `${req.ip}:${roomCommand || req.path}`,
      now = Date.now();
    let bucket = limits.get(key);
    if (!bucket || bucket.reset < now) {
      bucket = { count: 0, reset: now + 60000 };
      limits.set(key, bucket);
    }
    if (++bucket.count > (req.path === '/login' || roomCommand === 'loginChat' ? 30 : 15)) {
      res.set('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      return res
        .status(429)
        .json({ success: false, message: 'Too many attempts. Please wait a minute.' });
    }
    next();
  });
  app.use('/users/v1', async (req, res, next) => {
    if (
      !config.RECAPTCHA_SECRET ||
      ![
        '/login',
        '/signup',
        '/demoSignup',
        '/forgot-password',
        '/user-forgot-password',
        '/p/contact',
      ].includes(req.path)
    )
      return next();
    try {
      const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        body: new URLSearchParams({
          secret: config.RECAPTCHA_SECRET,
          response: String(req.body?.recaptcha || ''),
          remoteip: req.ip,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!(await response.json()).success)
        return res
          .status(400)
          .json({ success: false, message: 'Please complete the verification challenge.' });
      next();
    } catch {
      res.status(503).json({ success: false, message: 'Verification service is unavailable.' });
    }
  });
  app.get('/public/runtime-config.js', (req, res) => {
    const frontend = {
      janusURL: config.JANUS_PUBLIC_URL,
      chatServerURL: '/talk',
      recaptchaSiteKey: config.RECAPTCHA_SITE_KEY,
      turnServer: process.env.TURN_URL || '',
      turnUser: process.env.TURN_USERNAME || '',
      turnPW: process.env.TURN_PASSWORD || '',
      imgurClientId: process.env.IMGUR_CLIENT_ID || '',
    };
    res
      .set('Cache-Control', 'no-store')
      .type('js')
      .send(`window.PTR_CONFIG=Object.assign(window.PTR_CONFIG||{},${scriptJSON(frontend)});`);
  });
  app.use('/public', express.static(config.PUBLIC_DIR, { index: false }));
  app.use('/app', express.static(path.join(config.PUBLIC_DIR, 'app'), { index: false }));
  app.get(['/', '/index.html'], (req, res) =>
    res.sendFile(path.join(config.PUBLIC_DIR, 'index.html')),
  );
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'favicon.ico')));

  function sendSpa(req, res) {
    let html = fs.readFileSync(path.join(config.PUBLIC_DIR, 'ptrApp.html'), 'utf8');
    const suppliedRoom = req.canonicalRoomID || req.params.id || req.query.id || '';
    const canonical =
      suppliedRoom &&
      db
        .prepare('SELECT uuid FROM sessions WHERE uuid=? OR id=?')
        .get(String(suppliedRoom), String(suppliedRoom));
    const roomID = canonical?.uuid || suppliedRoom;
    html = html
      .replace("var __roomID = '';", `var __roomID = ${scriptJSON(String(roomID))};`)
      .replace('var __al = "";', `var __al = ${scriptJSON(String(req.query.al || ''))};`)
      .replace(
        "var __disableMarketplace = 'true';",
        `var __disableMarketplace = '${process.env.MARKETPLACE_ENABLED === 'false' ? 'true' : 'false'}';`,
      )
      .replace("var __hasPhoneValidation = 'false';", 'var __hasPhoneValidation = false;');
    if (req.path.startsWith('/r/'))
      html = html.replace("var __isReg = 'false';", "var __isReg = 'true';");
    html = html.replace(
      '<head>',
      '<head>\n    <base href="/ptrApp">\n    <script src="/public/runtime-config.js"></script>',
    );
    res.set('Cache-Control', 'no-store').type('html').send(html);
  }
  app.get(
    ['/ptrApp', '/ptrApp.html', '/session', '/session/:id', '/u/:id', '/v/:id', '/r/:id'],
    sendSpa,
  );
  app.get('/room/:alias', (req, res) => {
    const alias = String(req.params.alias);
    const room = db
      .prepare('SELECT uuid,settings FROM sessions WHERE is_archived_room=0')
      .all()
      .find((row) => {
        try {
          const s = JSON.parse(row.settings);
          return (
            (typeof s.customCname === 'string' &&
              s.customCname.toLowerCase() === alias.toLowerCase()) ||
            s.uniqueLinkLogin === alias
          );
        } catch {
          return false;
        }
      });
    if (!room) return res.status(404).send('Room not found');
    req.canonicalRoomID = room.uuid;
    sendSpa(req, res);
  });
  app.get(['/login', '/login.html', '/register', '/register.html', '/signup'], (req, res) =>
    res.redirect(`/ptrApp#/page/${req.path.startsWith('/login') ? 'welcome' : 'register'}`),
  );
  app.get(['/contact', '/contact.html'], (req, res) =>
    res.sendFile(path.join(config.PUBLIC_DIR, 'contact.html')),
  );
  app.use('/mp', express.static(path.join(config.PUBLIC_DIR, 'mp'), { index: false }));
  app.get(['/mp', '/mp/', '/mp/{*route}'], (req, res) =>
    res.sendFile(path.join(config.PUBLIC_DIR, 'mp/index.html')),
  );
  // Original clearToken/restartRoom clients call this without a room ID.
  // Clear only room cookies; explicit account logout revokes its token by POST.
  app.get('/logout', (req, res) => {
    for (const cookie of String(req.headers.cookie || '').split(';')) {
      const name = cookie.trim().split('=')[0];
      if (/^prt_room_[a-zA-Z0-9_-]+$/.test(name))
        res.clearCookie(name, { httpOnly: true, sameSite: 'lax', secure: req.secure });
    }
    res.set('Cache-Control', 'no-store').json({ success: true });
  });
  app.get(['/public/detached/', '/public/detached/.html'], (req, res) =>
    res.sendFile(path.join(config.PUBLIC_DIR, 'detached/index.html')),
  );
  if (process.env.ENABLE_LOCAL_QA === '1')
    app.get('/__qa/media', (req, res) =>
      res.sendFile(path.join(config.ROOT_DIR, 'qa/browser-media.html')),
    );
  if (process.env.ENABLE_LOCAL_QA === '1')
    app.get('/__qa/obs', (req, res) =>
      res.sendFile(path.join(config.ROOT_DIR, 'qa/browser-obs.html')),
    );

  // Janus is private to the Docker network. Client sessions must authenticate
  // through this proxy and can only use handles created by their own identity.
  app.all(/^\/janus(\/.*)?$/, async (req, res) => {
    const suffix = req.params[0] || '',
      parts = suffix.split('/').filter(Boolean);
    const own = parts[0] && janusSessions.get(parts[0]);
    if (own?.roomID) req.authRoomId = own.roomID;
    let credential = extractToken(req);
    let principal = authenticateRequest(req);
    if (!principal) {
      for (const cookie of String(req.headers.cookie || '').split(';')) {
        const match = cookie.trim().match(/^prt_room_([^=]+)=(.*)$/);
        if (!match) continue;
        const r = {
          ...req,
          headers: { ...req.headers, authorization: `Bearer ${decodeURIComponent(match[2])}` },
        };
        principal = authenticateRequest(r);
        if (principal) {
          credential = decodeURIComponent(match[2]);
          break;
        }
      }
    }
    if (!principal)
      return res
        .status(401)
        .json({ janus: 'error', error: { code: 403, reason: 'Authentication required' } });
    if (principal.is_api_key)
      return res.status(403).json({
        janus: 'error',
        error: { code: 403, reason: 'Use a room sign-in token for media' },
      });
    const actor = principal.actor_id || principal.memberId || principal.id;
    if (parts.length && (!own || own.actor !== actor))
      return res
        .status(403)
        .json({ janus: 'error', error: { code: 403, reason: 'Session access denied' } });
    let body = req.body || {};
    const allowed = [
      'create',
      'attach',
      'message',
      'trickle',
      'keepalive',
      'detach',
      'destroy',
      'hangup',
      'claim',
    ];
    if (req.method !== 'GET' && req.method !== 'HEAD' && !allowed.includes(body.janus))
      return res
        .status(400)
        .json({ janus: 'error', error: { code: 450, reason: 'Unsupported Janus command' } });
    if (
      body.janus === 'attach' &&
      !['janus.plugin.audiobridge', 'janus.plugin.videoroom', 'janus.plugin.streaming'].includes(
        body.plugin,
      )
    )
      return res
        .status(403)
        .json({ janus: 'error', error: { code: 403, reason: 'Plugin access denied' } });
    if (body.janus === 'message') {
      const action = body.body?.request;
      if (
        [
          'create',
          'destroy',
          'rtp_forward',
          'stop_rtp_forward',
          'enable_recording',
          'edit',
          'kick',
          'moderate',
          'list',
          'allowed',
        ].includes(action)
      )
        return res.status(403).json({
          janus: 'error',
          error: { code: 403, reason: 'Media rooms are managed by the server' },
        });
      const handle = own?.handles.get(parts[1]);
      if (!handle)
        return res
          .status(403)
          .json({ janus: 'error', error: { code: 403, reason: 'Handle access denied' } });
      if (handle.plugin === 'janus.plugin.streaming') {
        const mountID = body.body?.id ?? handle.mountID;
        if (!Number.isSafeInteger(Number(mountID)))
          return res
            .status(403)
            .json({ janus: 'error', error: { code: 403, reason: 'Stream access denied' } });
        const mount = db
          .prepare(
            "SELECT room_id FROM realtime_obs_mounts WHERE mount_id=? AND status='streaming'",
          )
          .get(Number(mountID));
        if (!mount || !requireRoomAccess(principal, mount.room_id))
          return res
            .status(403)
            .json({ janus: 'error', error: { code: 403, reason: 'Stream access denied' } });
        handle.mountID = Number(mountID);
        handle.roomID = mount.room_id;
        own.roomID = mount.room_id;
      }
      const numericRoom = Number(body.body?.room);
      if (numericRoom && handle.plugin !== 'janus.plugin.streaming') {
        const column = handle.plugin === 'janus.plugin.audiobridge' ? 'audio_id' : 'video_id';
        const mapped = db
          .prepare(`SELECT room_id FROM realtime_media_rooms WHERE ${column}=?`)
          .get(numericRoom);
        const room = mapped && requireRoomAccess(principal, mapped.room_id);
        if (!room)
          return res
            .status(403)
            .json({ janus: 'error', error: { code: 403, reason: 'Room access denied' } });
        handle.roomID = room.uuid;
        own.roomID = room.uuid;
        handle.presenter = mediaPresenter(principal, room.uuid);
      }
      if (!handle.roomID || !requireRoomAccess(principal, handle.roomID))
        return res
          .status(403)
          .json({ janus: 'error', error: { code: 403, reason: 'Room access denied' } });
      handle.presenter = mediaPresenter(principal, handle.roomID);
      const liveRoom = db.prepare('SELECT is_open FROM sessions WHERE uuid=?').get(handle.roomID);
      if (!liveRoom?.is_open && !handle.presenter)
        return res
          .status(403)
          .json({ janus: 'error', error: { code: 403, reason: 'Room is closed' } });
      // VideoRoom permits a passive publisher join to discover existing feeds;
      // publishing actual media is authorized when the SDP/configuration arrives.
      const isPublishing =
        handle.plugin === 'janus.plugin.videoroom' &&
        (action === 'publish' ||
          body.jsep?.type === 'offer' ||
          (action === 'configure' && body.body?.video === true));
      if (
        isPublishing &&
        !mediaCapability(principal, handle.roomID, handle.screen ? 'hasScreen' : 'hasCam')
      )
        return res
          .status(403)
          .json({ janus: 'error', error: { code: 403, reason: 'Publishing permission required' } });
      body = { ...body, body: { ...body.body } };
      if (action === 'join' && body.body.ptype === 'publisher') {
        const isScreen = String(body.body.display || '').startsWith('screen-');
        handle.screen = isScreen;
        body.body.display = isScreen ? `screen-${actor}-p` : `webcam-${actor}`;
      }
      if (
        handle.plugin === 'janus.plugin.audiobridge' &&
        !mediaCapability(principal, handle.roomID, 'hasMic')
      )
        body.body.muted = true;
      if (isPublishing) handle.sendingVideo = true;
      if (handle.plugin === 'janus.plugin.audiobridge' && typeof body.body.muted === 'boolean')
        handle.sendingAudio = !body.body.muted;
    }
    try {
      const target = new URL(config.JANUS_URL.replace(/\/$/, '') + suffix);
      if (req.method === 'GET' || req.method === 'HEAD') {
        for (const [key, value] of new URL(req.originalUrl, 'http://local').searchParams)
          if (key !== 'apisecret' && key !== 'token') target.searchParams.set(key, value);
        if (config.JANUS_API_SECRET) target.searchParams.set('apisecret', config.JANUS_API_SECRET);
      }
      const init = {
        method: req.method,
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(65000),
      };
      if (!['GET', 'HEAD'].includes(req.method)) {
        const { token: roomCredential, ...upstreamBody } = body;
        init.body = JSON.stringify({
          ...upstreamBody,
          apisecret: config.JANUS_API_SECRET || undefined,
        });
      }
      const upstream = await fetch(target, init);
      const response = await upstream.text();
      try {
        const value = JSON.parse(response);
        if (body.janus === 'create' && value.data?.id)
          janusSessions.set(String(value.data.id), {
            actor,
            credential,
            created: Date.now(),
            handles: new Map(),
          });
        if (body.janus === 'attach' && value.data?.id)
          own.handles.set(String(value.data.id), { plugin: body.plugin });
        if (body.janus === 'detach' && parts[1]) own.handles.delete(parts[1]);
        if (body.janus === 'destroy' && parts[0]) janusSessions.delete(parts[0]);
      } catch {}
      res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') || 'application/json')
        .send(response);
    } catch {
      res
        .status(502)
        .json({ janus: 'error', error: { code: 502, reason: 'Media gateway unavailable' } });
    }
  });
  app.use('/users/v1', usersRouter);
  app.use('/stats/v1', require('./routes/stats'));
  app.use('/ptr_app/courses/v2', require('./routes/courses'));
  app.use('/', marketplaceRouter);
  app.get('/health', (req, res) =>
    res.json({ ok: true, service: 'prt-backend', uptime: process.uptime() }),
  );
  app.get('/ready', async (req, res) => {
    try {
      const response = await fetch(config.JANUS_URL.replace(/\/$/, '') + '/info', {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error();
      res.json({ ok: true, database: true, media: true });
    } catch {
      res.status(503).json({ ok: false, database: true, media: false });
    }
  });
  app.use((req, res) => res.status(404).json({ success: false, message: 'Endpoint not found.' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.name === 'MulterError' ? 400 : 500);
    if (status === 500) console.error('Request failed:', err.message);
    res.status(status).json({
      success: false,
      message: status === 500 ? 'Unable to complete request.' : err.message,
    });
  });
  return app;
}
function startServer({ port = config.PORT, host = config.HOST } = {}) {
  const app = createApp(),
    server = http.createServer(app);
  require('./services/phone').attachTelephonyServer(server);
  attachSockJSServer(server, '/talk');
  server.listen(port, host, () =>
    console.log(`PRT server listening on http://${host}:${server.address().port}`),
  );
  return server;
}
if (require.main === module) {
  const server = startServer();
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => server.close(() => process.exit(0)));
}
module.exports = { createApp, startServer, scriptJSON };
