# ProTradingRoom (PRT) — Decoded End-to-End Architecture & Protocol Spec

> **Status:** Contract notes decoded from the original public assets. The original private server implementation was not captured. Current implementation and executed checks are recorded in [the audit](audit.md) and [verification manifest](../contracts/verification.json).

The local reference uses Node.js 24, Express, SQLite, SockJS, Janus, FFmpeg, MediaMTX, and Mailpit under Docker Compose. It serves both the captured AngularJS desktop and the recovered Angular marketplace. The table below distinguishes original observations from local choices.

---

## 1. Stack Overview

| Layer | Technology | Notes |
| --- | --- | --- |
| **Original Reverse Proxy** | `nginx` | Observed on the original deployment; local Compose exposes Express on localhost |
| **App Server** | **Node.js + Express** | Confirmed via `X-Powered-By: Express` |
| **Real-time Chat / Control** | **SockJS** (`sockjs-client` 1.4.0 ↔ `sockjs` node) | JSON `cmd`-dispatched pub/sub per room (`roomID`) |
| **WebRTC Media** | **Janus WebRTC Gateway** (`janus3.js`) | `janus.plugin.audiobridge`, `janus.plugin.videoroom`, `janus.plugin.streaming` |
| **Frontend** | **AngularJS 1.x** (`ui-router`) | `public/ptrApp.html`, `public/dist/app.min.js`, `public/dist/vendor.min.js` |
| **Local Database** | **SQLite** (reconstruction choice) | Stores accounts, rooms, memberships, marketplace, billing ledger, logs and file metadata; the original database is unknown |

---

## 2. Downloaded Frontend Assets (`public/`)

- `public/index.html` — Marketing landing page (`/`)
- `public/ptrApp.html` — AngularJS SPA shell (`/ptrApp`)
- `public/dist/app.min.js` — Main AngularJS application (18 controllers, 16 services, 14 directives, ~35 states)
- `public/dist/vendor.min.js` — AngularJS + vendor libraries
- `public/vendor/janus3.js` — Janus WebRTC client
- `public/app/css/bootstrap.min.css`, `public/app/css/styles.css` — Stylesheets
- `public/app/views/*.html` — All AngularJS HTML view templates (`page.welcome.html`, `chat.html`, `dashboard.html`, `roomControl.html`, `users.html`, `mailbox.html`, `files.html`, `pollPopup.html`, `disclosure.html`, `page.manageSession.html`, `page.recordings.html`, `page.stats.html`, etc.)

---

## 3. REST API Contract (`/users/v1/*` & App Routes)

### Authentication & Account Management
- `POST /users/v1/login`
  - **Request:** `{ email, pw, recaptcha, source: "webApp" }`
  - **Response:** `{ success: true, token, name, ... }` or `{ success: false, message, failedLoginCount }`
- `POST /users/v1/login_tok`
  - **Request:** `{ email, token, source: "webApp" }`
  - **Response:** `{ success: true, ... }` or `{ success: false, message: "Failed to authenticate token." }`
- `POST /users/v1/signup`
  - **Request:** `{ name, email, pw, recaptcha, source: "webApp", demo: true }`
  - **Response:** `{ success: true, demo, roomUUID, token, ... }` or `{ success: false, message }`
- `POST /users/v1/demoSignup` — Demo/trial registration
- `POST /users/v1/forgot-password` & `POST /users/v1/user-forgot-password` — Password reset email trigger
- `POST /users/v1/change-password` & `POST /users/v1/user-change-password` — Password update

### Sessions, Rooms, Users, & Admin
- `POST /users/v1/sessions` — Returns array of room/session objects (`isMainRoom`, `isArchivedRoom`, `uuid`, etc.) for `LoginCtrl.$scope.sortSessions(sessions)`
- `POST /users/v1/users.json` — Command-dispatched endpoint (`cmd` in body):
  - `cmd: "loginChat"` — `{ roomID, email, pw, tagline, pin, siteToken, token }`
  - `cmd: "logout"` — `{ email, token }`
  - `cmd: "newSession"` — `{ email, token, demoRoom: true }` → `{ uuid, ... }`
  - `cmd: "registerByEmail"` — `{ roomID, name, email, recaptcha }`
  - `cmd: "inviteParticipants"` — `{ roomID, participants }` (JSON array)
  - `cmd: "getAttachments"` — `{ roomID }` → list of shared files
  - `cmd: "listBadges"` — `{ token, source: "webApp", ... }`
  - `cmd: "setPresenterSetting"` / `cmd: "clearPresenterSetting"`
  - `cmd: "resetMediaServerSSH"` / `cmd: "resetSingleMediaServerSSH"`
- `POST /users/v1/adminusers` — Admin user CRUD/listing
- `POST /users/v1/apikeys` — API key management
- `POST /users/v1/recordings` & `/users/v1/archives/` — Room recordings & archives
- `POST /users/v1/upload` & `GET /users/v1/serveFile` — File sharing upload/download
- `GET /users/v1/ssoJWT?sessID=` — SSO JWT handoff
- `GET /marketplaces/:sessID` — Marketplace / room subscription metadata
- `POST /ptr_app/mp/v2/resend-welcome-email` — Resend welcome email

---

## 4. SockJS Real-Time Protocol (`new SockJS(url)`)

### Outbound Client Commands (`service.send(cmd, payload)`)
- **Chat & Alerts:** `chat`, `chatChannel`, `privateChat`, `deleteMessage`, `alert`, `alertLater`, `alertLink`, `deleteAlert`, `deleteScheduledAlert`, `clearAlertLog`, `clearChatLog`, `getChatLog`, `getScheduledAlerts`, `getAlertLog`, `typing`, `notyping`, `resetTypingIndicator`, `doUpV`, `ups`, `imageLink`
- **Room Control & Moderation:** `openRoom`, `closeRoom`, `closeRoomAndRevoke`, `restartRoom`, `restartRoomSoft`, `changeSessionLock`, `setChatMode`, `setBKGImg`, `setBKGImgHREF`, `changeNick`, `updateUser`, `kickUser`, `kickUserReload`, `kickAndBanUser`, `unbanUser`, `muteUser`, `muteChatUser`, `muteChatUser24`, `unmuteChatUser`, `muteCamUser`, `muteScreenUser`, `makeTempPresenter`, `removeFreeTrials`, `refreshMyState`, `continueLoginAfterOpen`
- **Polls & User Info:** `sendPoll`, `sendPollAnswer`, `pollDone`, `getUserInfo`
- **Media / Recording / Streaming:** `addScreenStream`, `removeScreenStream`, `addWebcamStream`, `removeWebcamStream`, `getScreenPresenters`, `getWebcamPresenters`, `setScreenShareRes`, `restartScreen`, `restartUserAudio`, `getAudioRoomState`, `regenAudioRoomId`, `stopAudioBridge`, `startRec`, `stopRec`, `stopOtherAndStartRec`, `remoteStartRec`, `remoteStopRec`, `startYTStream`, `stopYTStream`, `startFBStream`, `stopFBStream`, `startOBSStream`, `stopOBSStream`, `playYTForAll`, `stopYTForAll`, `playSoundFile`, `stopSoundFile`, `doSoundCloudEmbed`, `stopSoundCloudEmbed`, `sharedVideoPlayerCmd`, `userStopTalking`
- **Presenter Settings & Stats:** `loadPresenterSettings`, `getMyRepeater`, `getOpenPort`, `getScreenSharingStats`, `incSSStats`, `decSSStats`, `getRLog`, `getRLogResp`, `dialOutPhone`, `hangUpDialOutPhone`, `resetAudioForServer`

### Inbound Server Events (`switch (data.cmd)`)
- `loggedIn`, `loggedInServer`, `loginFailed`, `setToken`, `clearToken`, `cleanSiteTok`, `upgradeNeeded`, `banned`, `bannedcookie`, `kicked`, `kickUser`, `kickUserReload`, `reopenRoom`, `restartRoom`, `restartRoomReload`, `restartRoomSoft`, `updateSession`
- `getRoster`, `userJoin`, `userLeft`, `userChange`, `updateUser`, `getUserInfoResp`, `makeTempPresenter`, `makeTempPresenterOn`, `makeTempPresenterOff`, `remTempPres`
- `chat`, `chatChannel`, `privateChat`, `getChatlog`, `getChatlogChannels`, `getChatlogSmall`, `deleteMessage`, `deleteMessageChannel`, `clearChatLog`, `clearChannelLog`, `typing`, `nottyping`, `typingPM`, `nottypingPM`, `typingreset`, `updateMsgUpV`, `imageLink`, `fileShared`, `files`
- `alert`, `alertLink`, `alerts`, `alertschat`, `alertsonly`, `sendAlert`, `showAlert`, `getAlertlog`, `clearAlertLog`, `deleteAlert`, `getScheduledAlerts`
- `gotPoll`, `gotPollAnswer`, `pollDone`
- `addScreenStream`, `addScreenStreamHLS`, `removeScreenStream`, `addWebcamStream`, `addWebcamStreamError`, `removeWebcamStream`, `getscreenSharingUsers`, `getwebcamSharingUsers`, `getAudioRoomState`, `newAudioRoomIDForAll`, `newAudioRoomIDForAllStop`, `audioRoomRestartStart`, `talkingStart`, `talkingEnd`, `talkingChanged`, `presenterTalking`, `presenterNotTalking`, `muteUser`, `muteChat`, `muteChat24`, `unmuteChat`, `muteCamUser`, `muteScreenUser`, `stopAllWebcamsAndStartThis`, `stopAudioFWD`, `stopScreenFWD`, `restartScreen`, `restartUserAudio`
- `remoteStartRec`, `remoteStopRec`, `startRecNow`, `recStopped`
- `playYTForAll`, `stopYTForAll`, `ytStreamerStopped`, `playSoundFile`, `stopSoundFile`, `doSoundCloudEmbed`, `stopSoundCloudEmbed`, `sharedVideoPlayerCmd`, `setBKGImg`, `setBKGImgHREF`
- `loadPresenterSettings`, `getRoomState`, `getMyRepeater`, `getOpenPortResponse`, `setPorts`, `mediaRepeaterBackUp`, `mediaRepeaterDown`, `removeMediaServer`, `getScreenSharingStats`, `enableScreenSharingStats`, `disableScreenSharingStats`, `getRLog`, `getRLogResp`

---

## 5. Implementation and migration

The reference implements the captured desktop and marketplace contracts with scoped authentication, account and room administration, membership access, courses, Stripe lifecycle handling, email, realtime room control, WebRTC recording, RTMP and OBS. External adapters require issuer credentials and explicit configuration; local provider tests use mocks or loopback sinks.

Use [the migration handoff](migration.md) for state ownership and compatibility boundaries. [REST status](../contracts/parity.json), [realtime status](../contracts/realtime-parity.json), and [the audit](audit.md) document tested behavior and evidence limits. A handler or persisted setting alone does not certify identical original behavior.
