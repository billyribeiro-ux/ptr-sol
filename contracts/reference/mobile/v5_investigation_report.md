# ProTrading Room V5 — Forensic Investigation & Evidence Report

## Executive Summary

Following the discovery of the hidden admin toggle `sess.useV5` in `page.manageSession.html`, an investigation was conducted across DNS certificates, Certificate Transparency (crt.sh) logs, official App Store APIs, decompiled wire protocol modules, and live endpoint probing.

### Key Finding
**"Version 5" (PTR V5)** is the flagship next-generation multi-room client and ecosystem released by **Bellesoft Consulting Corp** (Bundle ID: `com.bellesoft.protradingroomv3`, internal App Version `3.0.0` – `3.0.50`), designed to pair multiple trading rooms into a single unified mobile/tablet interface via Email + PIN code authentication.

On the desktop web, `protradingroom.com` continues to serve its primary web suite as **`v2.18.393`** (AngularJS 1.x + Bootstrap 3 + Angular 7 Detached Chat), where `sess.useV5` in room settings (`page.manageSession.html` line 2298) serves as the backend authorization gate allowing a room to interface with the PTR V5 cluster.

---

## 1. Hard Evidence from Captured Codebase

### 1.1 The `useV5` Room Toggle
Located in `apps/original/public/app/views/page.manageSession.html` (lines 2285–2310):
```html
<p class="form-control-static">
    <label class="col-sm-2 control-label">Use v5? (DON'T!)</label>
    <a href="" onaftersave="saveSessField('useV5')" editable-checkbox="sess.useV5" e-title="Use v5?">
        {{ sess.useV5 && "Yes!" || "No" }}
    </a>
    (DON'T TURN THIS ON, If PTR did not clear you for v5!! it will not work....)
</p>
```
Sibling toggles include `sess.useV3` and an older commented-out `sess.useV4`.

### 1.2 Wire Protocol & API Integration
1. **PIN Code Login**: In `client-src/modules/23_controller_ChatCtrl.js` (line 3198):
   ```javascript
   $http.post(appVars.globals.APIURL + "/users/v1/users.json", {
       cmd: "loginChat",
       roomID: chatModel.roomID,
       email: $scope.email,
       pw: $scope.pw,
       tagline: $scope.tagline || "",
       pin: $scope.login.pinCode || "",
       siteToken: chatModel.jwtTokenSite,
       token: chatModel.jwtToken
   });
   ```
2. **Mobile App Pin Generation & Push Notifications**:
   - `getAppPin`: `POST /users/v1/sessions` with `cmd: "getAppPin"`, returns `{ success: true, pin: "..." }`.
   - `getFCMTokens`: retrieves Firebase Cloud Messaging push tokens.
   - `resetFCMTokens`: resets device tokens.
   - `sendTestAlert`: dispatches instant test push notification to user device.
   - `manageMobileApp`: enables/disables mobile app access per user xref.
3. **Deep Link Pairing URL Scheme**:
   ```
   protradingroom://pair?room={roomID}&pin={pairCode}
   ```

---

## 2. Official App Store Evidence (Apple & Google)

Querying the Apple App Store Search & Lookup APIs (`id1587924329`) yields official metadata for Pro Trading Room V5:

| Property | Value |
|---|---|
| **App Title** | **Pro Trading Room V5** |
| **Developer** | Bellesoft Consulting Corp |
| **Bundle ID** | `com.bellesoft.protradingroomv3` |
| **Current Version** | `3.0.50` (Internal base `3.0.0`) |
| **First Release** | October 19, 2021 |
| **Latest Release** | October 22, 2026 |
| **Category** | Business / Finance |
| **Target OS** | iOS / iPadOS 15.0+, Android 7.0+ |

### Official Release Description:
> *"The ProTradingRoom v5 app lets you easily login to all your ProTradingRoom rooms using just your email and a pincode. You can see all your alerts in one place and receive push notifications from all your rooms. Additionally, you can launch the rooms and participate in them right from your mobile device. You'll be able to watch the screenshare, listen to the audio broadcast, chat, and much more."*

---

## 3. Visual UI Evidence (Captured Screenshots)

Ten high-resolution evidence screenshots of Pro Trading Room V5 have been archived in `capture/v5-evidence/screenshots/`:

1. **`v5_screenshot_01.png` / `v5_screenshot_06.png` (Authentication)**:
   - Header logo: ProTradingRoom
   - Heading: *"Login to your rooms using just your email"*
   - Single email input field
   - Action buttons: `[ I got a pin code already ]` (green) and `[ Email me my pin code ]` (blue)
   - Footer: `App Version: 3.0.0`
2. **`v5_screenshot_02.png` / `v5_screenshot_07.png` (Multi-Room Aggregator - Paired Rooms)**:
   - Header: *"Paired Rooms"* + Sync button
   - Card listing showing real enterprise rooms:
     - **Shadow Trader** (Room ID: `1516` - *ST Time Spreads Advisory*) + `[Launch]` button + `[x] Show Alerts?`
     - **Bear Bull Traders** (Room ID: `1047` - *Bear Bull Traders Trading Room*) + `[Launch]` button + `[x] Show Alerts?`
     - **Hit and Run Candlesticks** (Room ID: `1307` - *Hit and Run Candlesticks*) + `[Launch]` button + `[x] Show Alerts?`
     - **Shadow Trader** (Room ID: `1512` - *ST Weekly Options Advisory*)
   - Bottom Action: `[ Synch all available rooms ]`
   - Bottom Navigation: `Alerts` | `Rooms` | `Accounts / Settings`
3. **`v5_screenshot_03.png` / `v5_screenshot_09.png` (Live Trading Room Interface)**:
   - Header: Speaker broadcast indicator `(Nobody is talking)`
   - Center presentation area: `(Nobody is presenting at the moment)`
   - 6-Tab Bottom Navigation Bar:
     - `Screens` (Screen share view)
     - `Alerts` (Room trade alerts)
     - `Chat` (Live text chat)
     - `Users` (Roster with active count badge)
     - `Files` (Shared documents/downloads)
     - `Notes` (Presenter notes)
4. **`v5_screenshot_04.png`, `05.png`, `08.png`, `10.png` (Aggregated Trade Alerts Stream)**:
   - Full feed of live moderator alerts with user avatars, timestamps, and formatting:
     - Real examples: Rick Saddler, Doug Campbell, ShadowTrader - Peter
     - Inline Imgur chart thumbnails (`https://i.imgur.com/...`)
     - Trade orders: BUY/SELL, Butterfly spreads, Options strikes, price levels
     - Unread notification count badge (e.g., `1000` on Alerts tab icon)
     - Search bar and audio alert toggle in header

---

## 4. Web & Domain Probing Results

| Probe Target | Protocol | Result | Details |
|---|---|---|---|
| `v5.protradingroom.com` | DNS / HTTPS | NXDOMAIN | No dedicated DNS hostname exists for `v5.` |
| `protradingroom.com/v5/` | HTTPS | HTTP 200 (Custom 404) | Express returns `<h3>this is not the page you are looking for...</h3>` |
| `*.protradingroom.com` | crt.sh SSL Logs | Active | Subdomains exist for media/streaming nodes (`m1`..`m28`, `he1`..`he8`, `wh1`..`wh14`, `flash`, `flash2`), but no standalone `v5` web app domain. |
| `protradingroom.com/login` | HTTPS | HTTP 200 (Active) | Serves `v2.18.393` AngularJS bundle. |

---

## 5. Architectural Conclusions

1. **Desktop Web Application**:
   - The desktop trading room and enterprise management portal is unified on **`v2.18.393`**.
   - Rooms with `sess.useV5 = true` utilize the exact same underlying WebRTC (Janus), SockJS (`/talk`), and REST APIs (`/users/v1/*`), but are permitted by the backend to connect through the V5 mobile gateway and FCM alert dispatchers.
2. **V5 Ecosystem**:
   - V5 is a purpose-built mobile/tablet client application designed for iOS, iPadOS, and Android, built around multi-room subscription aggregation, push notifications, and PIN-code authentication.

