# Technical Forensic Report 4: Routes, Settings, Theme Constants & WebRTC Media Services

## 1. Routes & Ingress (`43_config_routesConfig.js`)
- Live Room:
  - `/app/dashboard` (`dashboard.html`, `alertsChatOnBottom: false`)
  - `/app/dashboard-alt` (`dashboard-alt.html`, `alertsChatOnBottom: true`)
  - `/app/dashboard/closed` (`closed.html`)
  - `/dock/dashboard` (`app-dock.html` + `dashboard.html`)
  - `/public/detached/index.html` (Detached Alerts + Chat pop-out window)
  - Direct Room Ingress URLs: `/r/:roomID` (registration/webinar), `/u/:roomID`, `/room/:cname`, `/session?id=:sessionID` -> resolves room session, supports `?sl=1` silent SSO JWT auto-login, `?ft=1` free trial, `?jwtAdmin=...` presenter auto-login, or renders `page.login.html` (`/page/login/:sessionID`).
- Portal, Enterprise & Auth:
  - `/page/welcome` (`page.welcome.html` — Account Owner Login when logged out; Enterprise Portal with Sessions, Badges, Extra Admin Users, and API Keys when logged in)
  - `/page/manageSession/:sessionID` (`page.manageSession.html` — Master 6-tab Room Management Console + 268 X-Editable settings)
  - `/page/stats/:sessionID` (`page.stats.html` — Flot attendance charts + JSON export)
  - `/page/recs` (`page.recordings.html` — Session video recordings player & downloads)
  - `/page/avatars` (`page.avatars.html` — 9-avatar picker `01.jpg`..`08.jpg`, `user.png`)
  - `/page/register`, `/page/setting-demo`, `/page/forgot-password`, `/page/change-password/:uid`, `/page/user-forgot-password`, `/page/user-change-password/:uid`
  - `/kicked` (`kicked.html`)
  - `/public/html/api-docs.html` (renders `API_Documentation.md`)
- Excluded (100% vestigial Naut template demos with zero inbound links): `mailbox*.html`, `page.mockstats.html`.

## 2. Theme & Global Constants
- `COLORS`: `primary: "#080808"`, `success: "#4caf50"`, `info: "#2095f2"`, `warning: "#fe9700"`, `danger: "#f34235"`, `inverse: "#363f45"`, `amber: "#FFC107"`, `pink: "#e91e63"`, `purple: "#6639b6"`, `orange: "#fe5621"`, `noir: "#212121"`, `white: "#fff"`, `gray-darker: "#2b3d51"`, `gray-dark: "#515d6e"`, `gray: "#A0AAB2"`, `gray-light: "#e6e9ee"`, `gray-lighter: "#f4f5f5"`.
- 8 Predefined Themes: `primary`, `purple`, `success`, `warning`, `info`, `danger`, `pink`, `amber`.
- 4 Locales (`en`, `es`, `pt`, `zh-cn`) loaded from `/public/app/langs/{locale}.json`.

## 3. Multi-Presenter WebRTC Media & Audio Architecture
- **Screen Sharing (`getDisplayMedia` + WebRTC / MediaStream broadcast)**:
  - Bitrate presets: LOW (`128 kbps`), SD (`256 kbps`), HD (`512 kbps`), 1Mbps (`1024 kbps`), WebCam HD/HHD (OBS virtual cam).
  - Multi-presenter publishing (`screenPresenters` array), manual presenter lock (`screenLockedOnPres` with `fa-lock`), auto-switch to active talking presenter when unlocked, double-click fullscreen, pan/zoom (`#zoomFloaterDiv`), frame screenshot capture (`captureVideoImage`).
- **Voice Audio (`getUserMedia` + Web Audio API active-talker meter)**:
  - Mute-by-default on join (`micMuted = true`), presenter toggle mute/unmute, active talkers indicator (`#cssIsTalkingIndicator` with `talking.gif` / `notalking.png` or `( nobody is speaking )`), participant master volume knob (`0–100`) + local mute + autoplay unlock prompt.
- **Webcam PIP**: Draggable floating `#webcamCamDiv` (`#webcamCam`), double-click to reset position.
- **Session Recording**: `[ REC ]` indicator + red `fa-dot-circle-o`, records live room stream (`MediaRecorder` WebM/MP4 saved to room recordings `/users/v1/recordings` & `/stats/v1/sessions/recordings`!) with start/stop confirmation.
- **Shared Media**: Play Videos/YouTube for everyone (`videoMode == 'videos'`), SoundCloud track/playlist sync (`wireUpSoundCloud`), Room Drive sound playback (`playSoundFile`), and PSTN Dial-Out simulation/hook (`dialOutPhone`).

