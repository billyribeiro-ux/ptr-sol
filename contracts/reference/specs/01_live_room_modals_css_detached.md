# Technical Forensic Report 1: Live Room, Modals, CSS & Detached Window DOM Specification

## 1. Shell & Live Room Split.js DOM Architecture

### 1.1 Shell (`app.html`)
- `<header class={app.theme.topbar}>` -> `cached/top-navbar.html`
- `<aside class={app.theme.sidebar}>` -> `cached/sidebar.html`
- `<section><div class="app app-fh">` -> `dashboard.html` or `dashboard-alt.html`

### 1.2 `dashboard.html` (Side-by-Side Default Layout)
- Outer container: `<div class="container-fh">`
  - Closed room splash (`isSesisonClosed`): `<div class="l-table-fixed">` with countdown `#clockdiv` & closed HTML message
  - Open room (`!isSesisonClosed`): `<div class="l-table-fixed dark app-display-flex">`
    - Floating draggable webcam PIP: `<div id="webcamCamDiv" draggable="true">` -> `<video id="webcamCam" class="loadingBkg" autoplay playsinline muted>`
    - **Left Split Column** `<div id="chatAlertsDiv" class="l-cell split">` (default `20%` width, horizontal Split.js with `#presentationContainer` `80%`, persisted in `localStorage['split-room-sizes']`):
      - **Top Vertical Split Sub-Pane** `<div id="alertsContainer">` (default `30%` height, persisted in `localStorage['split-chat-alerts-sizes']`):
        - Header `div.p.chatHeader.dark`: `<i class="fa fa-bell-o"></i> Alerts`, right icons: `fa-question-circle` (`? Poll`), `fa-plus-circle` (`+ Post Alert`), `icon-cog` (`#alertCogBtn`), `fa-arrows-alt` (expand), `fa-times` (restore)
        - Collapsible `#alertsToolbarDiv.input-group.chatToolbar`: search input `alertSearch`, `fa-times`, `fa-save`, `fa-trash-o`, `fa-volume-up`/`fa-volume-off`
        - Scroll list: `#alertsPanel > #alertsPanel2 > ul#alertContent.chat`
      - **Bottom Vertical Split Sub-Pane** `<div id="chatContainer">` (default `70%` height):
        - Header `div.chatHeader.dark`:
          - `div.chat-top`: `<i class="fa fa-comment"></i> Chat`, `.chatChannelTabs` (`main`, `offTopic`, `adminChat`, extra channels with `.badge-warning` / `.badge-danger-chat`), right icons (`fa-comments-o`, `#chatCogBtn.icon-cog`, `fa-arrows-alt`, `fa-times`)
          - Collapsible `#chatToolbarDiv`: search `chatSearch2`, `fa-volume-up`/`fa-volume-off`, `fa-save`, `fa-trash-o`, `fa-filter` (`?` questions, `@` mentions), `fa-font` (Compact/Regular, XXLarge..Small), `fa-columns`, color picker button (`colorPicker.png`), detach chat button (`icon-paper-stack`), Presenter Chat Mode dropdown (`fa-users` Group `g`, `fa-microphone` Webinar `p`, `fa-lock` Disabled `d`), checkboxes (Always scroll, DND `fa-moon-o`, Mod Only, Message sound)
          - Private chat sub-header `.private-chat-header` (`#FFCC00` background) with peer selector & clear buttons
        - Inline color picker row (`showColorPicker`)
        - Scroll list: `#chatPanel > #chatPanel2 > ul#chatContent.chat`
        - Webinar mode notice (`chatMode == 'p'`) & typing indicator (`.typing-indicator`)
        - Composer `div.p.bt`: `textarea#chatTxt.form-control`, `#emojiToglerBtn` (`fa-smile-o` + 9-group Intercom emoji popover), Image/GIF/YouTube upload button (`fa-image` -> `#imageModal`)
    - **Right Split Column** `<div id="presentationContainer" class="split">` (`80%` width, `#000` background):
      - Floating top-right `#zoomFloaterDiv` (`#zoomOutBtn` `fa-search-minus`, `#zoomInBtn` `fa-search-plus`, `#zoomResetBtn` `fa-repeat`, pan/zoom `fa-search`, screenshot `fa-camera`, expand `fa-arrows-alt`, restore `fa-times`)
      - Video stage: `videoMode == 'videos'` (shared video/YouTube player) vs `videoMode == 'screen'` (`video#webcamScreen.webcamScreenVideo`, background image `bkgImageURL`, nobody-presenting state, `audio#audioPlayer`)

### 1.3 `dashboard-alt.html` (Presentation Top, Alerts & Chat Side-by-Side Bottom)
- Adds `.roomArea` (`flex-direction: column !important`), renders `#presentationContainer` FIRST (`50%` height) and `#chatAlertsDiv` SECOND (`50%` height, persisted in `split-room-sizes-alt`), with `#alertsContainer` (`30%` width) and `#chatContainer` (`70%` width, persisted in `split-chat-alerts-sizes-alt`) split horizontally.

## 2. Top Navbar & Left Sidebar
- **Top Navbar (`cached/top-navbar.html`)**:
  - Left: `.fa.fa-bars` sidebar switcher, `.fa.fa-mobile` mobile app modal, `.fa.fa-user` + `#rosterLen` connected user count (`userCount + simUserCount`), `#cssLogo.brand-logo` (`logoURL` / ProTradingRoom brand).
  - Right: Benzinga logo link (optional), `#cssIsTalkingIndicator` (`fa-microphone` + active talker names + `talking.gif` / `notalking.png` or `( nobody is speaking )`), `[ REC ]` (`#cssRecLabel`) + `#cssRecIcon` (`fa-dot-circle-o`), `#cssMicIcon` (`fa-microphone`), `#cssScreenShareIcon` (`fa-desktop` + bitrate/source dropdown: LOW 128k, SD 256k, HD 512k, 1Mbps, WebCam HD/HHD, STOP, WebRTC Reset), `#cssCamIcon` (`fa-video-camera`), `fa-file-video-o` (Play Videos for all), `#cssSoundCloudIcon` (`fa-soundcloud` + `playing.gif` + track/playlist controls), `fa-folder-open-o` (Room Drive `files.html`), `fa-newspaper-o` (News feed), `fa-volume-up`/`fa-volume-off` (Volume dial + Mute + Reconnect + SoundCloud volume slider), Presenter switcher `.btn-inverse.btn-sm` (`fa-lock`, `fa-desktop`, `thumb24` avatar, presenter name + caret), `fa-cog` (Session Control `roomControl.html`), `fa-refresh` (Reload), `fa-power-off` (Leave Session), Multi-room dropdown switcher (`currRoomName`).
- **Left Sidebar (`cached/sidebar.html`)**:
  - Close panel (`fa-arrow-left`), Streaming (`fa-youtube-square`), SlowLink throttle, Archives submenu (`fa-hdd-o` -> Recordings, User Stats, Alert Logs, Chat Logs), Bandwidth savers (Disable Video / Disable Webcam), Page Settings (`icon-cog` -> Side vs Bottom layout, Compact vs Regular chat, Light vs Dark theme), Page Layouts (`icon-layout` -> All In One, Presentation Only, Alerts & Chat, Chat Only, Alerts Only), Screen Stats, Manage Muted Users (`User2UserMute.html`), Get Random User, Total Users (`#rosterLenSide` badge `#2095f2`), Search Users input + toolbar (`fa-times`, `fa-bell-o`/`fa-bell-slash-o`, `fa-sort-alpha-asc`, presenter `fa-cog` for Filter/Remove Trials, Mobile count, Reset Typing, Unban User, Large Font), **Moderators** (`#presoRosterUL`, `#f0f0f0`) and **Users** (`#userRosterUL`) lists with avatars, custom badges, and star ranks.

## 3. Modals
- Inline: `Create Alert` (Text / Link / Image+GIF+Video tabs + Scheduled Alerts + Legal Disclosure + Non-trade alert), `Zoom Message`, `Muted Chat Users`, `Adjust Colors`, `Mobile App Launch`, `Scheduled Alerts`.
- External: `Multiple Choice Poll` (`pollPopup.html`: Create, Pre-Canned, Vote, Live Pie Chart Results), `Room Files` (`files.html`: Files/Images/Sounds, upload, set as logo/background, play sound for all), `User Info` (`userInfo.html`: Mention, PM, User2User Mute, Temp Presenter, Kick/Ban/Mute Chat/Remote Media), `Invite Participants` (`inviteModal.html` + PSTN phone dial-out), `Room Disclosure` (`disclosure.html` with initials), `Session Control` (`roomControl.html`: Reset Audio, Hard/Soft Reset, Lock Room, Close Room with message, A/V Devices).

## 4. Detached Pop-Out Window (`/public/detached/index.html`)
- Vertical `30% / 70%` split (`Alerts` top, `Chat` bottom with channel tabs, search, compact/regular mode, light/dark theme, post alert modal).
- Syncs with parent window via `window.postMessage` (`boot` -> `session`, `alertLog`, `chatLog`, `channelLog`, 15s `ping`, bidirectional `sendMsg`, `sendAlert`, `clearChatLog`, `clearAlertLog`, `closeDet`).

## 5. Exact Fonts, Icons & CSS Tokens
- **Font Libraries**: Google Fonts `Roboto` (`100,300,400,400i,500,700,700i`), `"Helvetica Neue", Helvetica, Arial, sans-serif`, `Lato` (detached window).
- **Icon Webfonts**: Font Awesome 4 (`fa fa-*`), Feather Webfont (`icon-*`), Bootstrap Glyphicons (`glyphicon-*`).
- **Key Colors**: Topbar/Primary `#080808`, Noir `#212121`, Chat/Alert dark header `#484848` (text `#888888`), Gutter `#222`, Info `#2095f2`, Warning `#fe9700`, Private Chat header `#FFCC00`, Danger `#f34235`, Success `#4caf50`, Question `#2095f2`, Mention `rgba(4, 141, 4, 0.9)` on `rgba(255, 0, 0, 0.06)`.

