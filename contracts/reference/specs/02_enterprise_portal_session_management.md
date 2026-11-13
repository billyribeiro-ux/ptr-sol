# ProTradingRoom (PTR) Enterprise Portal, Session Management, Auth & Auxiliaries Specification

**Forensic Research Specification**
**Source Directory:** `/Users/billyribeiro/ptr-harvester/capture/assets/`
**Target Environment:** ProTradingRoom v3 AngularJS 1.x / Naut Enterprise Architecture

---

## Table of Contents
1. [Architectural Framework & Routing Configuration](#1-architectural-framework--routing-configuration)
2. [Vestigial Naut Theme Verification (Mailbox Subsystem)](#2-vestigial-naut-theme-verification-mailbox-subsystem)
3. [Public Landing, Legal & Documentation Interfaces](#3-public-landing-legal--documentation-interfaces)
4. [Authentication Architecture & Password Lifecycle Flows](#4-authentication-architecture--password-lifecycle-flows)
5. [Enterprise Welcome Portal (`page.welcome.html`) Complete Specification](#5-enterprise-welcome-portal-pagewelcomehtml-complete-specification)
6. [Master Session Management (`page.manageSession.html`) Complete Specification](#6-master-session-management-pagemanagesessionhtml-complete-specification)
7. [Complete 268-Setting Directory (Tab 6: Settings)](#7-complete-268-setting-directory-tab-6-settings)
8. [Session Management Modals & Auxiliaries](#8-session-management-modals--auxiliaries)
9. [Analytics, Usage Statistics & Mock Charts](#9-analytics-usage-statistics--mock-charts)
10. [Recordings Portal (`page.recordings.html`)](#10-recordings-portal-pagerecordingshtml)
11. [User Avatar Selection Engine (`page.avatars.html`)](#11-user-avatar-selection-engine-pageavatarshtml)
12. [Global Footers & Kicked Screen](#12-global-footers--kicked-screen)

---
# ProTradingRoom (PTR) Enterprise Portal, Session Management, Auth & Auxiliaries Specification

> **Forensic Specification Document**  
> **Target Source Assets:** `/Users/billyribeiro/ptr-harvester/capture/assets/`  
> **Application Core:** AngularJS 1.4.x, UI-Router, Bootstrap 3.x, Naut Theme, Flot Charts, WebRTC (Janus Gateway / MediaMTX)  
> **Researcher Role:** Forensic Researcher 2  

---
## Table of Contents
1. [Architectural Framework & UI Routing](#1-architectural-framework--ui-routing)
2. [Vestigial Naut Theme Verification (Mailbox Subsystem)](#2-vestigial-naut-theme-verification-mailbox-subsystem)
3. [Public Landing, Legal & Documentation Interfaces](#3-public-landing-legal--documentation-interfaces)
4. [Authentication Architecture & Password Lifecycle Flows](#4-authentication-architecture--password-lifecycle-flows)
5. [Enterprise Welcome Portal (`page.welcome.html`) Complete Specification](#5-enterprise-welcome-portal-pagewelcomehtml-complete-specification)
6. [Master Session Management (`page.manageSession.html`) Complete Specification](#6-master-session-management-pagemanagesessionhtml-complete-specification)
7. [Complete 268-Setting Directory (Tab 6: Settings)](#7-complete-268-setting-directory-tab-6-settings)
8. [Session Management Modals & Auxiliaries](#8-session-management-modals--auxiliaries)
9. [Analytics, Usage Statistics & Mock Charts (`page.stats.html` & `page.mockstats.html`)](#9-analytics-usage-statistics--mock-charts)
10. [Recordings Portal (`page.recordings.html`)](#10-recordings-portal-pagerecordingshtml)
11. [User Avatar Selection Engine (`page.avatars.html`)](#11-user-avatar-selection-engine-pageavatarshtml)
12. [Global Footers & Disconnection Screens (`page.footer.html`, `kicked.html`)](#12-global-footers--disconnection-screens)

---

## 1. Architectural Framework & UI Routing

The ProTradingRoom web application employs a hybrid UI architecture combining a public static marketing shell with an AngularJS 1.x / UI-Router single-page application (SPA) themed upon the Naut Admin template.

### 1.1 State Provider Route Manifest (`routesConfig`)
Every route in the administrative, enterprise portal, session management, and room join subsystems is registered under `angular.module('app').config(routesConfig)`:

| State Name | URL Route | Template Path | Controller | Assets / Resolves | Query / Default Params |
|---|---|---|---|---|---|
| `page` (abstract root) | `/page` | `app/views/page.html` | `LoginCtrl` | `icons`, `animate` | `params: {autoLogin: true}` |
| `page.welcome` | `/welcome` | `app/views/page.welcome.html` | Inherited (`LoginCtrl`) | - | `params: {autoLogin: true}` |
| `page.manageSession` | `/manageSession/:sessionID` | `app/views/page.manageSession.html` | Inherited (`LoginCtrl`) | - | `params: {autoLogin: true}` |
| `page.stats` | `/stats/:sessionID` | `app/views/page.stats.html` | Inherited (`LoginCtrl`) | - | `params: {autoLogin: true}` |
| `page.mockstats` | `/mstats/:sessionID` | `app/views/page.mockstats.html` | `FlotChartController` | - | - |
| `page.recordings` | `/recs` | `app/views/page.recordings.html` | Inherited (`LoginCtrl`) | - | `params: {isRec: true}` |
| `page.avatarSelect` | `/avatars` | `app/views/page.avatars.html` | `AvatarsCtrl` | - | - |
| `page.login` | `/login/:sessionID` | `app/views/page.login.html` | `LoginCtrl` | - | - |
| `page.register` | `/register` | `app/views/page.register.html` | Inherited (`LoginCtrl`) | - | - |
| `page.forgot-password` | `/forgot-password` | `app/views/page.forgot-password.html` | Inherited (`LoginCtrl`) | - | - |
| `page.user-forgot-password`| `/user-forgot-password`| `app/views/page.user-forgot-password.html`| Inherited (`LoginCtrl`) | - | - |
| `page.change-password` | `/change-password/:uid`| `app/views/page.change-password.html` | Inherited (`LoginCtrl`) | - | - |
| `page.user-change-password`| `/user-change-password/:uid`| `app/views/page.user-change-password.html`| Inherited (`LoginCtrl`) | - | - |
| `page.setting-demo` | `/setting-demo` | `app/views/page.setting-demo.html` | Inherited (`LoginCtrl`) | - | `params: {secret: '1PTRdem04cc0unt9'}` |
| `kicked` | `/kicked` | `app/views/kicked.html` | `KickedCtrl` | - | `params: {msg: ''}` |
| Fallback Redirect | - | - | - | - | `$urlRouterProvider.otherwise('/page/welcome')` |

### 1.2 Master Layout Shell: `page.html`
All `/page/*` views execute inside `page.html`. It establishes:
- **Outer Container**: `<div class="ng-fadeOutZoom ng-fluid">`
- **Navigation Bar**: `<nav role="navigation" class="navbar topnavbar" style="background-color: black;">`
- **Brand Logo**: `<img ng-hide="hideLogo || !sess.logoURL" ng-src="{{sess.logoURL}}" height="35px" class="brand-logo" style="max-width: 200px; height: auto; max-height: 40px;"/>`
- **Right-Aligned Header Controls (when `login.isLoggedIn`)**:
  - Account Settings Link: `<a href="" ui-sref="page.welcome" style="color: #FFFFFF" class="icon fa fa-cog" tooltip-placement="bottom" tooltip="Account Settings">&nbsp; Account</a>`
  - Logout Link: `<a href="" ng-click="doLogout()" style="color: #FFFFFF" class="icon fa fa-2x fa-power-off" tooltip-placement="bottom" tooltip="Logout"></a>`
- **Sub-View Injection Container**: `<div ui-view="" autoscroll="false" class="ng-fluid"></div>`

## 2. Vestigial Naut Theme Verification (Mailbox Subsystem)

A rigorous forensic audit of `/Users/billyribeiro/ptr-harvester/capture/assets/` was conducted to determine whether `mailbox.html`, `mailbox.compose.html`, `mailbox.folder.html`, and `mailbox.view-mail.html` form an active PTR messaging system or are vestigial leftovers from the underlying commercial template.

### 2.1 Evidence of Vestigial Status
1. **Routes Registered But Unlinked**: In `routesConfig` (`app.min.js`), the following states are registered:
   - `app-fh.mailbox` (`url: '/mailbox'`, `templateUrl: 'app/views/mailbox.html'`, resolve: `moment`)
   - `app-fh.mailbox.folder` (`url: '/folder'`, abstract)
   - `app-fh.mailbox.folder.list` (`url: '/:folder'`, `templateUrl: 'app/views/mailbox.folder.html'`)
   - `app-fh.mailbox.folder.list.view` (`url: '/:id'`, `templateUrl: 'app/views/mailbox.view-mail.html'`, resolve: `textAngular`)
   - `app-fh.mailbox.compose` (`url: '/compose'`, `templateUrl: 'app/views/mailbox.compose.html'`, resolve: `textAngular`)
2. **Zero Inbound UI Links**: Grepping the entire captured codebase across all views, directives, controllers, and templates yields **zero** instances of `ui-sref="app-fh.mailbox"` or `#/mailbox` anywhere in the PTR user interface. The word `mailbox` only appears in chat emoji pickers (`:mailbox:`, `:mailbox_closed:`).
3. **Hardcoded Mock/Demo Data**: The controllers `MailboxController` and `MailboxFolderController` in `app.min.js` populate emails using canned arrays:
   - Sender names: `['Floyd Kennedy', 'Brent Woods', 'June Simpson', 'Wanda Ward', 'Travis Hunt']`
   - Sample subjects: `['Nam sodales sollicitudin adipiscing. ', 'Cras fermentum posuere quam, sed iaculis justo rutrum at. ', 'Vivamus tempus vehicula facilisis. ']`
   - Hardcoded sender: `Sass Rose <mail@example.com>` with avatar `app/img/user/01.jpg`
4. **Conclusion**: The entire `mailbox.*` subsystem represents unmodified stock templates from the Naut AngularJS admin template, retained during initial project scaffolding but never integrated into the ProTradingRoom enterprise platform. It should NOT be ported to the new stack.
## 3. Public Landing, Legal & Documentation Interfaces

### 3.1 Public Marketing & Contact Shells (`index.html`, `contact.html`)
- **Landing Page (`index.html`)**:
  - Title: `ProTradingRoom - Trading Room Software for professional traders`
  - Stylesheets: `/public/css/compiled/theme.css`, `/public/css/vendor/animate.css`, FontAwesome 4.0.3, `/public/css/main.css?v1.0`
  - Features highlighted: Ultra-low latency HTML5 WebRTC audio/video/screen broadcasting, multi-device responsiveness, interactive chat & alert moderation, customizable branding, subscription integration.
  - Marketplace grid container: `.marketplace-container` (50px padding, `#f8f9fa` background), `.marketplace-card`
- **Contact Page (`contact.html`)**:
  - Contact form fields: Full Name, Email, Phone Number, Message textarea
  - reCAPTCHA v2 validation
  - Social sharing widget: ShareThis integration (`33a7c385-d09c-4f65-9259-5edf1f7d97b3`)

### 3.2 Legal Disclosures & Compliance (`ppolicy.html`, `tos.html`)
- **Privacy Policy (`ppolicy.html` - 81.8 KB)**:
  - Full GDPR and CCPA compliant privacy disclosure.
  - Specifies personal data collected (nicknames, email, IP addresses, browser agent, audio/video stream session logs, payment metadata via Stripe).
  - Third-party processor disclosures: AWS (media & recording storage), Twilio (SMS alerts), Google Firebase Cloud Messaging (FCM mobile push), Imgur (chat image uploads), Stripe (subscription billing).
- **Terms of Service (`tos.html` - 236.6 KB)**:
  - Comprehensive SaaS licensing terms for trading room operators and attendees.
  - Strict liability limitations regarding financial advice (trading rooms are communication channels, not registered investment advisors).
  - Recording ownership, content moderation rights, anti-harassment, and acceptable use policies.

### 3.3 Developer API Documentation Portal (`api-docs.html`, `API_Documentation.md`)
- **Host File (`public/html/api-docs.html`)**:
  - Standalone HTML page with GitHub Markdown stylesheet styling (`max-width: 980px`, border `#d0d7de`, card container).
  - Top bar navigation: `<div class="topbar"><a href="/ptrApp#/page/welcome">← Back to PTR</a></div>`
  - Markdown renderer: Loaded via CDN `https://cdn.jsdelivr.net/npm/marked/marked.min.js`.
  - Dynamic query parameter: Reads `?src=` from URL, defaulting to `API_Documentation.md`.
- **API Specification (`public/html/API_Documentation.md`)**:
  - **Base URL**: `https://ptrv3.protradingroom.com/stats/v1`
  - **Authentication**: Query parameters `?apiKey=YOUR_KEY&apiSecret=YOUR_SECRET` on every request.
  - **Rate Limiting**: 1 request per second per command (returns HTTP 429 upon excess).
  - **Exhaustive Endpoints Catalog**:
    1. `POST /sessions/delUsers` — Removes attendees from session & unsubscribes them from FCM push alerts. Body: `{"delUsers": ["email1@domain.com"]}`.
    2. `POST /sessions/addUsers` — Adds attendees or freshens activity timestamps. Body: `{"users": [{"email": "...", "name": "..."}]}`.
    3. `GET /sessions/list` — Lists all trading room sessions owned by the API user credentials.
    4. `GET /sessions/userstats` — Retrieves user login/logout session attendance statistics with date range (`fromDate`, `toDate`) and mobile filter (`isMobile`).
    5. `GET /sessions/users` — Retrieves all users cross-referenced to a session with roles and activity dates.
    6. `GET /sessions/chatlogs` — Retrieves chat log history by session, channel (`main`, `offtopic`), and date range.
    7. `GET /sessions/alertlogs` — Retrieves structured trade alert history.
    8. `GET /sessions/deletedlogs` — Audit log of deleted/edited messages (`logType: chat|alerts`, `eventType: D|E`).
    9. `GET /sessions/archivedlogs` — Cold-storage archived chat and alert records.
    10. `GET /sessions/recordings` — Lists recording video files from the preceding 3 weeks (returns duration, MKV/MP4 URLs, media server host).
    11. `GET /sessions/cloneSession` — Programmatically clones an existing room with all settings and presenter cross-references.

## 4. Authentication Architecture & Password Lifecycle Flows

The platform implements two fundamentally distinct login subsystems with separate credential databases, session contexts, and user models:
1. **Room Attendee / Presenter Session Login (`page.login.html`)** — Ephemeral or attendee access to a specific trading room.
2. **Account Owner / Portal Administrator Login (`page.welcome.html`)** — Root management access to create rooms, manage API keys, configure badges, and add extra admin users.

### 4.1 Room Attendee Login View (`page.login.html`)
- **Outer Layout Grid**: Full-screen responsive view (`overflow: auto;`). Split into two main columns:
  - **Left Column** (`class="col-xs-6 col-md-8 fadeInLeft"`): Rich HTML room description and welcome banner, bound via `<div ta-bind ng-model="sess.description" style="height: 100%; overflow-x: hidden"></div>`.
  - **Right Column** (`class="col-xs-6 col-md-3 fadeInRight"`, `style="border-left: solid 1px #fafafa; height: 100%"`):
    - **Unsupported Browser Warning Container** (`ng-show="!browserOK && !browserOKDismissed"`):
      - Heading: `<h2 style="color: red" class="animated flash centered">{{unuportedBrowserMsg}}</h2>`
      - Subheading: `<h4>You seem to be using a browser that might NOT work properly with this room</h4>`
      - Graphic: `<img src="/public/images/supported_browsers.jpeg" style="width: 50%; text-align: center" />`
      - Browser recommendations: Current Google Chrome, Firefox (v52+), Opera.
      - Override button: `<button ng-click="browserOKDismissed=true;" ng-hide="strictBrowserMode" class="btn btn-danger mb">Let me try anyhow (NOT RECOMENDED)</button>`.
    - **Attendee / Presenter Form Container** (`ng-show="browserOK || browserOKDismissed"`):
      - Form element: `<form role="form" onsubmit="return false;" ng-submit="submitSessionLogin()" class="p span6">`
      - Header instructions:
        - If registration mode (`isReg`): `<h2 class="text-warning" style="text-decoration: underline; text-align: center">Registration Form</h2>`
        - If standard room: `"Enter your name and click Enter below"`
        - If webinar: `"Fill in your name / email / Webinar password then click Login"`
      - **Form Inputs**:
        1. Nick / Name: `<input id="loginNickTxt" type="text" placeholder="Your Nick/Name" autocomplete="off" ng-model="nick" class="form-control" />` (Feedback icon: `fa fa-user`). Validation blocks characters: `@`, `*`, `!`, `%`, `^`, `&`, `(`, `)` and email/URL strings.
        2. Email: `<input id="exampleInputEmail1" type="email" placeholder="Your Email" name="username" ng-model="email" class="form-control" />` (Feedback icon: `fa fa-envelope`). Displayed if `(authToSession || isWebinarRoom || isReg)`.
        3. Phone Validation: `<input type="tel" class="form-control" id="phoneTxt" name="phoneTxt" placeholder="Phone Number" />`. Rendered if `hasPhoneValidation` is enabled; verified with `window.iti` (intl-tel-input).
        4. Password: `<input id="exampleInputPassword1" type="password" name="password" autocomplete="on" placeholder="Password" ng-model="pw" class="form-control" />` (Feedback icon: `fa fa-lock`). Note: `(PW ONLY REQUIRED IF YOU HAVE ONE)` if `!isWebinarRoom`.
        5. SSO Logout Switch: Displays `Email: {{email}}` with link `<a href="" ng-click="clearToken()">Not you? log out</a>` (hidden if `authToSession || isReg || simpleLF`).
        6. Gravatar Setup Link: `<img gravatar-src="email" gravatar-size="40" class="thumb40" />` linking to Gravatar.
        7. Tagline: `<input id="tagLineTxt" type="text" placeholder="Tagline (i.e. John from Chicago)" autocomplete="on" ng-model="tagline" maxlength="30" class="form-control" />` (Feedback icon: `fa fa-info-circle`). Blocks URLs and emails.
        8. Options Checkboxes:
           - Remember Me: `<input type="checkbox" value="remember-me" checked="checked" /> Remember me`
           - Non-Presenter Admin: `<input type="checkbox" value="nonPresenter" ng-model="nonPresenter" /> Non Presenter Admin`
        9. Action Buttons:
           - Regular Entry: `<button type="submit" ng-hide="isReg" ng-disabled="loggingIn" class="btn btn-block btn-info mb">Enter</button>`
           - Registration: `<button type="submit" ng-show="isReg && !regDone" ng-disabled="loggingIn" class="btn btn-block btn-warning mb">Register</button>`
        10. GDPR Privacy Policy Disclaimer: `<img src="/public/images/gdpr.png" style="max-height: 35px; width: auto" /> By Clicking Enter you are agreeing with our <a href="/public/html/ppolicy.html" target="_blank"> Privacy Policy</a>`.
        11. Webinar Password Reset Link: `<a class="text-muted" ng-click="doForgotPassword()">Change your password?</a>` (rendered if `isWebinarRoom`).
        12. Branding & Version: `Powered by: ProTradingRoom.com`, `Version: {{_ver}}`.
        13. Loading Spinner: `<div ng-show="loggingIn"><img src="app/img/ajax_loader.gif" /> {{isReg ? 'Registering':'Logging In'}}, please wait...</div>`.
        14. Audio Connection Diagnostic Box (`#testVideoDiv`): Plays test tone via `<audio id="testVideo" autoplay controls></audio>` with `doSystemCheckDone()`.
        15. Presenter Bypass Switch: `"Are you a presenter? Click here instead..."` (`ng-click="simpleLF=0;"`).

### 4.2 Account Owner / Portal Admin Registration (`page.register.html`)
- **Container**: `<div class="container container-sm animated fadeInDown">`
- **Branding**: Dark logo `<img src="/public/images/protradingroom_icon_dark.png" />` + ProTradingRoom.com title.
- **Form Submission**: `ng-submit="submitSignup()"` posting to `POST /users/v1/signup`:
  - Full Name: `<input ng-model="signup.name" type="text" placeholder="Your full name" class="form-control" />`
  - Email: `<input ng-model="signup.email" type="email" placeholder="Your email" class="form-control" />` (icon `fa fa-envelope`)
  - Password: `<input id="signupInputPassword1" ng-model="signup.pass" type="password" placeholder="Your password" class="form-control" />` (icon `fa fa-lock`)
  - Confirm Password: `<input id="signupInputRePassword1" ng-model="signup.pass2" type="password" placeholder="Type your password again" class="form-control" />` (icon `fa fa-lock`)
  - Forgot Password Link: `<a ui-sref="page.forgot-password">Forgot your password?</a>`
  - reCAPTCHA v2: `<div class="g-recaptcha" data-sitekey="6LcDyB4TAAAAAEajRvbeLyW2Lj_2TmXV5YSjAixx"></div>`
  - Terms of Service: `<input type="checkbox" ng-model="signup.agreeTOSChk" /> I agree with the terms`
  - Submit Button: `<button type="submit" class="btn btn-block btn-primary">Create account</button>`
  - Existing User Redirect: `<a ui-sref="page.welcome">Login here</a>`
  - Footer Inclusion: `<div ng-include="'app/views/page.footer.html'"></div>`

### 4.3 Demo Account Provisioning (`page.setting-demo.html`)
- **Access Control**: Protected by route parameter secret check: `params: {secret: '1PTRdem04cc0unt9'}`. Unauthorized access redirects to `page.welcome`.
- **Form Submission**: `ng-submit="submitDemoSignup()"` posting to `POST /users/v1/demoSignup`:
  - Name: `demoSignup.name`
  - Email: `demoSignup.email`
  - Password: `demoSignup.pass` & `demoSignup.pass2`
  - Initial Room Name: `<input ng-model="demoSignup.roomName" type="text" placeholder="Room name" class="form-control" />`
  - Target Cluster ID: `<input ng-model="demoSignup.clusterID" type="text" placeholder="ClusterID" class="form-control" />`
  - Google reCAPTCHA v2 (`data-sitekey="6LcDyB4TAAAAAEajRvbeLyW2Lj_2TmXV5YSjAixx"`)
  - Agree TOS Checkbox: `demoSignup.agreeTOSChk`
  - Submit Button: `<button type="submit" class="btn btn-block btn-primary">Create demo account</button>`

### 4.4 Dual-Track Password Recovery Architecture
ProTradingRoom maintains completely separate recovery pathways for account administrators vs room users:

#### Track A: Account Owner Password Lifecycle
1. **Request Reset (`page.forgot-password.html`)**:
   - Submits `submitForgotPassword()` to `POST /users/v1/forgot-password`
   - Payload: `{email: registeredUser.email, recaptcha: $('#g-recaptcha-response').val(), source: 'webApp'}`
   - Status display: `forgotPasswordStatus.msg` (success hides form).
2. **Execute Change (`page.change-password.html`)**:
   - Submits `submitChangePassword()` to `POST /users/v1/change-password`
   - Payload: `{userUUID: uid, passNew: registeredUser.passNew, recaptcha: ..., source: 'webApp'}`
   - Validates minimum 4 characters and `passNew === passNew2`.

#### Track B: Room Attendee / Webinar Password Lifecycle
1. **Request Reset (`page.user-forgot-password.html`)**:
   - Submits `submitUserForgotPassword()` to `POST /users/v1/user-forgot-password`
   - Payload: `{email: registeredXrefUser.email, recaptcha: ..., source: 'webApp'}`
   - Status display: `userForgotPasswordStatus.msg`.
2. **Execute Change (`page.user-change-password.html`)**:
   - Submits `submitUserChangePassword()` to `POST /users/v1/user-change-password`
   - Payload: `{userUUID: uid, passNew: registeredXrefUser.passNew, recaptcha: ..., source: 'webApp'}`
   - Updates cross-referenced user password for that specific room instance.
## 5. Enterprise Welcome Portal (`page.welcome.html`) Complete Specification

`page.welcome.html` (94.2 KB, 1,426 lines) serves as the primary multi-tenant enterprise portal for room owners and administrators. It manages authentication, session inventory, custom badge typography and graphics, secondary admin delegation, and granular API keys.

### 5.1 Portal Architecture & Authentication State Split
- **Outer Wrap**: `<div ui-view="" autoscroll="false" class="ng-fadeOutZoom ng-fluid ng-scope" style="background-color: 0A0A0A" ng-init="showNewRoom=0;">`
- **Sub-Container**: `<div class="container container-sm animated fadeInDown ng-scope">`
- **State 1: Unauthenticated Owner Login Panel (`ng-hide="login.isLoggedIn"`)**:
  - Card Header: `<p class="pv text-bold">Login to your ProTradingRoom.com account</p>`
  - Form: `<form role="form" class="ng-pristine ng-valid" ng-submit="submitLogin()">`
  - Email Field: `<input id="exampleInputEmail1" type="email" placeholder="Your email" autocomplete="off" class="form-control" ng-model="signup.email" autocorrect="off" />` (Feedback icon: `fa fa-envelope`)
  - Password Field: `<input id="exampleInputPassword1" type="password" placeholder="Your password" class="form-control" ng-model="signup.pass" />` (Feedback icon: `fa fa-lock`)
  - Forgot Password Link: `<a ui-sref="page.forgot-password" class="text-muted">Forgot your password?</a>`
  - Google reCAPTCHA v2: `<div class="g-recaptcha" data-sitekey="6LcDyB4TAAAAAEajRvbeLyW2Lj_2TmXV5YSjAixx"></div>` (Always visible; gated on backend login route)
  - Submit Button: `<button type="submit" class="btn btn-block btn-info mb">Login</button>`
  - Progress Indicator: `<div ng-show="loggingIn" style="padding: 25px; text-align: center;"><img src="app/img/ajax_loader.gif" /><label>&nbsp;&nbsp;Logging In, please wait...</label></div>`
- **State 2: Authenticated Enterprise Dashboard (`ng-show="login.isLoggedIn"`)**:
  - Activates when authenticated token (`tokenSite`) exists in localStorage.
  - Houses 4 core administrative subsystems: Room Roster, Custom Badges, Extra Admins, API Keys.

### 5.2 Room / Session Inventory Manager
- **Header & Secret Easter Egg**: `<h4>Total <span ng-click="showNewRoom=showNewRoom+1;">Sessions</span>: {{login.sessions.length}}</h4>`
  - Clicking the word **'Sessions'** increments `$scope.showNewRoom`.
  - At `showNewRoom >= 1`: Reveals raw MongoDB `_id` and `ownerdID` beneath each session row.
  - At `showNewRoom >= 5`: Displays the hidden creation button `<a type="button" ng-click="createNew()" class="btn btn btn-warning mb btn-block">New Room</a>`.
- **Filter Toolbar**:
  - Search Filter: `<input type="text" ng-model="sessSearch" placeholder="search" class="form-control" />` (contained in `col-md-4 panel pane-default`).
  - Archived Toggle: `<button class="btn btn-sm btn-default" ng-click="toggleArchivedRooms()">Show/Hide Archived</button>`.
- **Sessions Data Table (`.table .table-striped .table-bordered .table-hover`)**:

| Column Name | Sorting Handler | Class / Elements | Rendering / Data Binding |
|---|---|---|---|
| **Session ID** | `ng-click="sortByUUID()"` | `icon fa fa-sort-alpha-asc` | `<strong>{{s.uuid}}</strong>` + hidden `( {{s._id}} - ownerID: {{s.ownerdID}} )` |
| **Name** | `ng-click="sortByName()"` | `text-center`, `icon fa fa-sort-alpha-asc` | `{{s.name || s.uuid}}` |
| **State** | - | `text-center` | `<div ng-hide="s.isArchivedRoom" class="label label-orange">{{s.currentState || 'open'}}</div>`<br>`<div ng-show="s.isArchivedRoom" class="label label-warning">archived</div>` |
| **Users** | - | `text-center`, `text-muted` | `{{s.current_capacity}} / {{s.recordedMaxCapacity }}` (Live vs High-Water Mark) |
| **Actions** | - | - | 1. **Launch**: `<a ng-href="/session?id={{s.uuid}}&jwtSite={{tokSite}}" target="_blank" class="btn btn-sm btn-info"><i class="icon fa fa-external-link"></i> Launch</a>`<br>2. **Manage**: `<a href="#/page/manageSession/{{s._id}}" class="btn btn-sm btn-inverse"><i class="icon fa fa-cogs"></i> Manage</a>`<br>3. **Marketplace**: `<a ng-hide="disableMarketplace" ng-click="manageMarketplaceSession(s._id, s)" class="btn btn-sm btn-default"><i class="icon fa fa-credit-card"></i> Marketplace</a>` |

### 5.3 Enterprise Custom Badges Subsystem
The custom badges manager empowers room owners to create stylized graphic pills or text tags attached to user nicknames across chat, roster, and alert headers.

#### Add / Edit Badge Form (`showAddBadge=true`)
- **Card Structure**: `<div class="panel panel-default col-md-6" ng-show="showAddBadge">`
- **Header**: `<h3 class="panel-title" ng-show="badges.mode=='add'">New Badge</h3><h3 class="panel-title" ng-show="badges.mode=='edit';">Edit Badge</h3>`
- **Live Preview Container**:
  - Image Badge: `<img class="user-badge-img" ng-show="badges.hasOwnProperty('imgURL') && badges.imgURL" ng-src="{{badges.imgURL}}" alt="{{b.imgURL}}" />`
  - Text Badge: `<span ng-hide="badges.hasOwnProperty('imgURL') && badges.imgURL" class="label" style="background-color: {{badges.bkcolor}}; color: {{badges.color}}">{{badges.text}}</span>`
- **Form Inputs**:
  1. Background Color: `<input type="color" ng-model="badges.bkcolor" />` + `<button class="btn btn-tiny btn-default" ng-click="badges.bkcolor='rgba(1,0,0,0)';">Transparent</button>`
  2. Text Color: `<input type="color" ng-model="badges.color" />`
  3. Badge Text: `<input class="input-emoji-txt" id="badgeInputTxt" type="text" ng-model="badges.text" value="TEST" />`
  4. Emoji Trigger Button: `<button id="emoji-picker" class="btn btn-default btn-sm"><i class="fa fa-smile-o fa-1x"></i></button>`
  5. Badge Name: `<input class="input-name-txt" id="badgeNameTxt" type="text" ng-model="badges.name" placeholder="Badge Name" />`
  6. WordPress Role Auto-Mapping: `<textarea class="input-text" id="badgeRolesTxt" ng-model="badges.roles" cols="70" rows="2"></textarea>` (Comma-separated WP membership slugs)
- **Action Controls**:
  - Add: `<button ng-show="badges.mode=='add'" type="button" ng-click="addBadge(false)" class="btn btn-warning pull-right">Add {{badges.text}}</button>`
  - Save Edit: `<button ng-show="badges.mode=='edit'" type="button" ng-click="addBadge(true); showAddBadge=false;" class="btn btn-primary pull-right">Save Edit for {{badges.text}}</button>`
  - Close: `<button type="button" ng-click="badges.badgeID=''; badges.mode='add'; showAddBadge=false;" class="btn btn-default pull-right">Close</button>`
- **Integrated Emoji Picker Popover** (`.intercom-composer-popover`):
  - Search Input: `<input class="intercom-composer-popover-input" placeholder="Search" />`
  - 9 Complete Symbol Groups: Frequently used, People, Nature, Food, Activity, Travel, Objects, Symbols, Flags.

#### Badges List & Inventory (`col-md-9`)
- **Controls Toolbar**:
  - Add New Badge: `<a type="button" ng-click="showAddBadge=!showAddBadge" class="btn btn-warning mb">Add New Badge</a>`
  - Upload Graphic Badge: `<a type="button" ngf-select="ngf-select" ngf-change="onImageSelect($files, '')" class="btn btn-info mb"><i class="fa fa-cloud-upload"></i> Upload Image Badge</a>`
  - Export CSV: `<a type="button" ng-show="badgesList" class="btn btn-default mb" ng-click="exportBadges()">Export Badges</a>` (Exports `_id, userID, text, imgURL, color, bkcolor, type, name, uploadTime, onlyP, roles`)
- **Badges Inventory Table**:
  - Double-click header toggles `$scope.showBadgeID`.
  - Badge Render Cell: Displays text pill or `.user-badge-img` image, badge name `[b.name]`, and optional ID `({{b._id}})`.
  - Actions Cell:
    1. Edit: `<a href="" ng-click="editBadge(b._id,b.text,b.bkcolor,b.color,b.roles,b.name,b.imgURL)">Edit</a>`
    2. Delete: `<a href="" ng-click="deleteBadge(b._id,b.text,b.imgURL)">Delete</a>`
    3. Dark Theme Alias: `<a href="" ng-click="addBadgeDarkTheme(b._id,b.text,b.imgURL,b.darkTheme)">Dark Theme</a>` — Links another badge ID rendered automatically when the user or room activates Dark Theme mode.

### 5.4 Delegated Admin Users Subsystem (`listAdminUsers`)
Provides enterprise owners the ability to delegate room administration to staff without disclosing root account credentials.

- **Toolbar & Toggle**: `<button ng-show="!showAddAdminUser" class="btn btn-success mb" ng-click="showAddAdminUser=!showAddAdminUser">Add Admin User</button>`
- **Add Admin User Form (`showAddAdminUser=true`)**:
  - Container: `<div class="panel panel-default" ng-show="showAddAdminUser">`
  - Name Field: `<input type="text" class="form-control" ng-model="adminUser.name" placeholder="Enter name" required />`
  - Email Field: `<input type="email" class="form-control" ng-model="adminUser.email" placeholder="Enter email" required />`
  - Password Field: `<input type="password" class="form-control" ng-model="adminUser.password" placeholder="Enter password" required />`
  - Submit Button: `<button type="submit" class="btn btn-primary">Add Admin User</button>` (Calls `addAdminUser()` -> `POST /users/v1/adminusers` with `cmd: 'add'`)
  - Cancel Button: `ng-click="showAddAdminUser=false; adminUser={name:'',email:'',password:'',perms:{}}"`
- **Admin Users Table**:
  - Columns: Name (`au.name`), Email (`au.email`), Added Date (`au.created | date:'short'`), Actions.
  - Action: `<a href="" ng-click="removeAdminUser(au._id, au.name)"><i class="fa fa-remove text-danger"></i> Remove</a>` (Calls `removeAdminUser()` -> `POST /users/v1/adminusers` with `cmd: 'remove'`).
  - Empty State: `<td colspan="4" class="text-center text-muted">No admin users added yet</td>`.

### 5.5 API Keys Manager & Granular Scoping Engine
Enables programmatic integration with LMS platforms, membership systems, and third-party bots.

- **Toolbar Controls**:
  - New API Key: `<button type="button" class="btn btn-success mb" ng-click="createApiKey()">New Api key</button>` (Calls `createApiKey()` -> `POST /users/v1/apikeys` with `cmd: 'create'`)
  - Documentation Link: `<a class="btn btn-primary mb" href="/public/html/api-docs.html?src=/public/html/API_Documentation.md" target="_blank">API Docs</a>`
- **API Keys Table**:
  - Columns: `_id`, `secret`, Actions.
  - Restricted Key Indicator: `<i class="fa fa-lock text-warning" title="Restricted" ng-show="(k.restrictToSessions && k.restrictToSessions.length) || (k.restrictToEndpoints && k.restrictToEndpoints.length)"></i>` displayed next to `_id`.
  - Actions:
    1. Regenerate Secret: `<a href="" ng-click="rotateApiKey(k._id)">regen secret</a>` (`bootbox.confirm` -> `POST /users/v1/apikeys` with `cmd: 'rotate'`)
    2. Granular Restrictions: `<a href="" ng-click="manageApiKeyRestrictions(k)">restrictions</a>`
    3. Delete Key: `<a href="" ng-click="deleteApiKey(k._id)">delete</a>` (`bootbox.confirm` -> `POST /users/v1/apikeys` with `cmd: 'delete'`)
- **Modal: Granular API Key Restrictions (`manageApiKeyRestrictions`)**:
  - Initiated as a large `bootbox.dialog` titled *'Manage API Key Restrictions'*.
  - Sub-List 1: **Restrict to Sessions** (Multi-select checklist of user rooms: `s.name (s.uuid)`). Unchecked means unrestricted access to all rooms.
  - Sub-List 2: **Restrict to Endpoints** (Multi-select checklist loaded dynamically via `listAllApiEndpoints`). Unchecked means access to all API endpoints.
  - Dialog Buttons: `Clear All` (`btn-warning`), `Cancel`, `Save` (`btn-success`).
  - Persistence Handlers: Dispatches `POST /users/v1/apikeys` with `cmd: 'restrictApiSessions'` and `cmd: 'restrictApiEndpoints'`.
## 6. Master Session Management (`page.manageSession.html`) Complete Specification

`page.manageSession.html` (216.6 KB, 2,718 lines) is the central administrative console for an individual ProTradingRoom session. It provides comprehensive control over attendees, real-time presenters, text lists, branding, single sign-on, usage audits, and room behavioral configuration.

### 6.1 Top Header & Quick Action Bar
- **Container Header**: `<div class="panel-heading">` with dark styling.
- **Title & Room Identifiers**:
  - Room UUID & ID: `<span ng-dblclick="canCloneDblClick()">Manage Room id: {{sess.uuid}}&nbsp;&nbsp;( {{sess._id}} )</span>` (Double-clicking triggers `$scope.canCloneClicks` easter egg enabling room cloning).
  - User Counters: `<span class="text-muted"> Current <i class="icon fa fa-user"></i>: {{sess.current_capacity}} / Max <i class="icon fa fa-user"></i> {{sess.recordedMaxCapacity }} </span>`.
  - Reset Counts Button: `<button class="btn btn-link btn-warning" ng-click="resetMaxCount()"><i class="icon fa fa-refresh"></i> Reset Counts</button>` (Calls `resetMaxCounts` on backend).
- **Quick Action Buttons**:
  1. **Launch**: `<a ng-href="/session?id={{sess.uuid}}&jwtSite={{tokSite}}" target="_blank" class="btn btn-sm pull-right btn-info mr"><i class="icon fa fa-external-link"></i>&nbsp;Launch</a>`
  2. **Clone Room**: `<a href="" ng-show="sess.canClone || sess.isClonedRoom || canCloneClicks" ng-click="cloneRoom(sess._id)" class="btn btn-sm pull-right btn-warning mr"><i class="icon fa fa-copy"></i>&nbsp;Clone Room</a>`
  3. **Delete Room**: `<a href="" ng-show="sess.isClonedRoom" ng-click="deleteRoom(sess._id)" class="btn btn-sm pull-right btn-danger mr"><i class="icon fa fa-trash"></i>&nbsp;Delete Room</a>`
  4. **Marketplace**: `<a href="" ng-hide="disableMarketplace" ng-click="manageMarketplaceSession(sess._id, sess)" class="btn btn-sm pull-right btn-default mr"><i class="fa fa-credit-card"></i>&nbsp;Marketplace</a>`

### 6.2 Top-Level Form & Entry Link Generator
- **Room Title**: `<a href="" editable-text="sess.name" onaftersave="saveSessField('name')">{{ sess.name || 'empty' }}</a>`
- **Webinar Scheduled Date** (`ng-show="sess.roomType=='webinar'"`):
  - Editable Combodate: `<a href="" onaftersave="saveSessField('webinarDate')" editable-combodate="sess.webinarDate" e-max-year="{{thisYear+2}}" e-data-format="DD-MM-YYYY h:mm a" data-format="DD-MM-YYYY +-HH:mm" e-min-year="{{thisYear}}">{{ (sess.webinarDate | date:'MM/dd/yyyy @ hh:mm a') || 'empty' }}</a>`
  - Notice: `(NOTE: use your local time. It will be converted to the user's local time)`
- **Authorization Mode Dropdown**: `<a href="" onaftersave="saveSessField('authMode')" editable-select="sess.authMode" e-ng-options="s.value as s.text for s in sessAuthTypes">{{ showAuthMode() }}</a>`
  - All 7 Select Options (`$scope.sessAuthTypes`):
    1. `jwt`: `SSO (JWT) - Single Sign On using Wordpress/PHP/Other JWT method`
    2. `open`: `Open - Anyone with the room link can join with their email & name`
    3. `registrationA`: `WEBINAR STYLE - Users get sent a unique link to join automatically after they register`
    4. `registrationM`: `Registraion with MANUAL approval. You approve each registration before users get a unique link`
    5. `webinarRoom`: `Unique link & password (optional)`
    6. `unamePW`: `Unique email/pw for each user`
    7. `closed`: `Closed - Nobody can use this room while in closed mode`
- **Conditional Link Generators & Email Broadcaster**:
  - **Webinar Registration Link** (`ng-show="sess.authMode=='registrationA' || sess.authMode=='registrationM'"`):
    - Link input: `<input type="text" class="form-control col-md-6" id="webinarRegLinkTxt" readonly="readonly" value="https://{{hostname}}/r/{{sess._id}}">` + Copy button (`copyLinkToClipboard('webinarRegLinkTxt')`).
    - Event Time string: `<input type="text" ng-model="webinarTimeTxt" placeholder="at 7pm EST">`.
    - Email Reminder Preview & Trigger: Shows preformatted text with placeholders `__name__` and `{{webinarTimeTxt}}`, triggered via `<button class="btn btn-default" ng-click="sendWeminarEmailReminder(webinarTimeTxt)">Send Emails Now</button>`.
  - **Direct Access Links** (`ng-show="sess.authMode=='webinarRoom' || sess.authMode=='open' || sess.authMode=='unamePW' || sess.allowPWLoginWithSSO"`):
    - Standard Room Link: `https://{{hostname}}/u/{{sess._id}}` + Copy.
    - Vanity / Custom Link: `https://{{hostname}}/room/{{sess.customCname ? sess.customCname : '[yournamehere]'}}` + Edit button (`setCustomRoomURL()`) + Copy button (`copyLinkToClipboard('customLinkTxt')`).
    - Unique Link: `https://{{hostname}}/room/{{sess.uniqueLinkLogin ? sess.uniqueLinkLogin : '[youruniquelinkhere]'}}` + Generate button (`setUniqueRoomURL()`) + Copy button (`copyLinkToClipboard('uniqueLinkTxt')`).
    - App Pair Link (`ng-show="sess.hasAppPairLink"`): `https://{{hostname}}/room/` + Copy button (`copyLinkToClipboard('appPairLink')`).

### 6.3 Tab 1: Users (Attendee & Presenter Administration)
The Users tab (`<tab heading="Users">`) manages user cross-references (`xrefs`), granular permissions, push notification tokens, and moderation.

#### Toolbar & Search
- **Top Action Buttons**:
  - Add User / Invite: `<button class="btn btn-md btn-info mt" ng-click="doInvite()"><i class="fa fa-user-plus"></i> Add User / Invite</button>`
  - Export CSV: `<button class="btn btn-md btn-info mt" ng-click="exportListToCSV()"><i class="fa fa-floppy-o"></i> Export</button>`
  - Load / Reload: `<button class="btn btn-md btn-primary mt" ng-click="loadUsers()"><i class="fa fa-refresh"></i> Load / Reload Users</button>`
- **Dropdown Menu: User List Actions**:
  - Batch User Invite (`sess.authMode === 'unamePW'`): `doBatchInvite()`
  - Show Free Trials: `loadUsersFT()`
  - Show BANNED: `loadBannedUsers()` (`fa fa-ban`)
  - Show Chat Muted: `loadMutedUsers()` (`fa fa-comment-o`)
  - Show Mobile: `loadMobileUsers()` (`fa fa-mobile`)
  - Show Non-Mobile: `loadNonMobileUsers()` (`fa fa-mobile`)
  - Show Presenters: `loadPresentersUsers()` (`fa fa-microphone`)
  - Marketplace Users: `loadMarketplaceUsers()` (`fa fa-credit-card`)
  - Divider
  - Remove Non-Presenters: `clearUserList()` (`fa fa-trash-o`)
  - Remove Free Trials: `removeUsersFT()` (`fa fa-trash-o`)
  - Remove All User Badges: `removeBadgesForUsers()` (`fa fa-trash-o`)
- **Search & Multi-Room Application**:
  - Search input: `<input type="search" ng-enter="loadUsers(uSearch)" class="form-control" ng-model="uSearch">` + `<button class="btn btn-sm btn-primary" ng-click="loadUsers(uSearch)">Search / Load Users</button>`.
  - Select All / Unselect All checkbox: `getCheckedAllUserIds()`
  - Multi-Room Batch Scope: `<input ng-change="toggleApplyToAllRooms()" type="checkbox" ng-model="applyToAllRooms"> <span>Apply to all rooms?</span>`
- **Batch Action Triggers**:
  - **Actions With Selected**: `updateManyUsers(roleCode)` (10: Remove All, 2: UNBAN, 1: Make Presenter, 5: Make Admin Non-Presenter, 2: Make Participant, 6: Make Trial, 3: MUTE, 4: BAN, Add Badge, Remove Badge).
  - **Actions With the Email List**: `actionsWithEmailList()` prompts for comma-delimited emails, then runs `updateManyFromEmailList(roleCode)`.

#### Users Table Architecture
- Headers: `#`, `Name / Email`, `Last Login/Notes`, `Role / Status`, `Actions`.
- **User State Icons & Indicators in Row**:
  - File Access Override: `<i class="fa fa-folder-o fa-2x" ng-show="sess.fileAccessCaseByCase && user.hasFileAccess"></i>`
  - Mobile App Permission: `<i class="fa fa-mobile fa-2x" ng-show="sess.ptrMobileAppCaseByCaseEnabled && user.hasMobileApp"></i>`
  - FCM Push Registered: `<i class="fa fa-mobile" ng-show="!sess.ptrMobileAppCaseByCaseEnabled && user.alerterAppTokens.length > 0"></i>`
  - FCM Push Disabled by User: `<i class="fa fa-mobile" style="color: red;" ng-show="!sess.ptrMobileAppCaseByCaseEnabled && user.alerterAppFCMUserOff"></i>`
  - Real-time Mic Permission: `<i class="fa fa-microphone" ng-show="user.hasMic"></i>`
  - Real-time WebCam Permission: `<i class="fa fa-video-camera" ng-show="user.hasCam"></i>`
  - Real-time Screenshare Permission: `<i class="fa fa-desktop" ng-show="user.hasScreen"></i>`
  - Real-time Admin Chat Permission: `<i class="fa fa-comment-o" ng-show="user.hasAdminChat"></i>`
  - Notes Edit Permission: `<i class="fa fa-pencil-square-o" ng-show="user.canEditNotes"></i>`
  - Denied Archives Access: `<i class="fa fa-hdd-o" style="color: red;" ng-show="user.denyArchivesAccess" title="Denied Archives Access"></i>`
  - Gravatar Avatar: `<img gravatar-src-once="user.email" class="thumb24" />`
  - Discord Username: `<div ng-show="user.discordUserId" style="color: red;">Discord Username: {{user.discordUsername}}</div>`
  - Stripe Marketplace Pill Box: Subscription status pill, Last Paid At date, Next Billing End date, Last Payment Failure pill, Last Paid Amount, and Details link (`openStripeDetails(user)`).
  - Attached Badges: Renders text pills or graphic images from `$scope.badgesList`.
  - Trial Flag: `<span class="badge badge-danger-chat"> TRIAL </span>`
  - Mobile Pair PIN: `<i class="fa fa-mobile"></i> {{user.mobilePairCode}}`
  - Phone: `<i class="fa fa-phone"></i> {{user.phone}}`
  - Password Set: `<i class="fa fa-lock"></i> PW set`
  - Hidden Flags: `User Count Hidden`, `User Personal Info Hidden`
  - Last Login & Notes: `{{user.lastLogin | date:'MM/dd/yyyy @ h:mma'}}`, `*** INACTIVE USER ***`, `User PMs disabled`, Admin Note box.
- **Role / Status Cell**:
  - Pending Approval Button: `<button class="btn btn-small btn-warning" ng-click="approveUser(...) ng-show="user.inviteStatus=='pending'"> APPROVE</button>`
  - Display Roles: Participant (`role==2`), Owner (`role==0`), Presenter (`role==1 && !user.nonPresenter`), Admin (`role==1 && user.nonPresenter`), CHAT MUTED (`role==3`), BANNED (`role==4`).
- **Multi-Level Actions Dropdown** (`dropdown-menu-right`):
  1. **Permissions Submenu**: Make Presenter (1), Make Admin (5), Make Participant (2), Make Trial (6), MUTE Participant (3), BAN (4), Unban (2), Freshen Login Date (9).
  2. **Granular Perms Submenu**: Adjust Mic/Cam/Screen/Chat/Notes (`setPermissions(user)` -> triggers `#permissionsModal`), Show/Hide User Count (8/7), Deny/Allow Archives Access (13/14), Hide/Show Personal User Data (10/11), Disallow/Allow User-to-User PM (`setUserRestrictPM`).
  3. **App & Notifications Submenu**: Get App PIN (`getAppPin`), Show App Tokens (`showAlerterAppTokens`), Get FCM Tokens (`getFCMTokens`), PAUSE / RESUME / Remove Mobile Notifs (`pauseUserNotifs`), Send Test Mobile Notif (`sendTestFCM`), Reset Mobile Notifs (`resetFCMForuser`), Enable / Disable Mobile App (`manageMobileApp`).
  4. **Badges Submenu**: Manage Badges (`manageBadges(badgesList, user.badges, user._id, user.userName, user.email)`).
  5. **Direct Commands**: Set Note (`setNoteUser`), Edit Username (`editUsername`), Remove User (`deleteParticipant`), Set/Change Password (`setUserPW`), Resend Welcome Email (`sendWelcomeEmail`), Pause/Pending Approval (`approveUser`), Enable/Disable Files (`manageFileAccess`).

### 6.4 Tab 2: Text List (SMS Broadcasting)
- **Condition**: Rendered only when `sess.twillioApiToken` is configured (`ng-show="sess.twillioApiToken"`).
- **Controls**: `<button class="btn btn-info pull-right" ng-click="saveTextList()"><i class="fa fa-save"></i> Save List</button>`
- **Editor**: Full-height textarea `<textarea id="textListTxt" style="width: 100%; height:100%" rows="40"></textarea>` populated via `loadTextList()`.

### 6.5 Tab 3: Branding (Logo / Landing Page)
- **Logo Preview & Upload**: Displays current logo inside dark container `<div style="background-color: #000; padding: 15px;"><img ng-src="{{sess.logoURL}}" class="navLogo" /></div>`.
  - Buttons: Upload/Change (`openFileChooser('logos')` -> opens `#filesModal`), Reset (`resetLogo()`).
- **Login Landing Page WYSIWYG Editor**:
  - Header: `Login Landing Page Editor` + Save Button `<button class="btn btn-info pull-right" ng-click="htmlDescChanged()"><i class="fa fa-save"></i> Save Editor Changes</button>`.
  - Editor Directive: `<div text-angular="" ng-model="sess.description" name="wysiswyg-editor" class="btn-group-small"></div>`.

### 6.6 Tab 4: SSO Setup (WordPress / JWT)
- **Condition**: Rendered when `sess.authMode=='sso'`.
- **Settings**:
  - SSO Host: `<a href="" editable-text="sess.ssoHost" onaftersave="saveSessField('ssoHost')">{{ sess.ssoHost || 'empty' }}</a>`.

### 6.7 Tab 5: User Stats (Attendance & Login Audit)
- **Date Range Filters**:
  - Start Date: `editable-date="statsDate"` (`MM-dd-yyyy`)
  - End Date: `editable-date="statsDateEnd"` (`MM-dd-yyyy`)
- **Action Controls**:
  - Load Stats: `<button class="btn btn-md btn-info" ng-click="loadStats(statsDate,statsDateEnd,uSearchStat,filterFT,remDupes,showMobileStat)"><i class="fa fa-user-plus"></i> Load Stats</button>`
  - Export CSV: `<button class="btn btn-md btn-info" ng-click="exportStatsToCSV(statsDate)"><i class="fa fa-floppy-o"></i> Export</button>`
  - Monthly Report Toggle / Clear: `loadMontlyStats(...)`
  - Download Monthly Report: `downloadMontlyStats(statXrefsMontly)`
- **Audit Filters**:
  - Search Filter: `<input type="search" class="form-control" ng-model="uSearchStat">`
  - Show Online Users Only: `ng-model="filterOnline"`
  - Show Free Trials Only: `ng-model="filterFT"`
  - Show Mobile Only: `ng-model="showMobileStat"`
  - Remove Duplicates: `ng-model="remDupes"` (Sorts by email and deduplicates sequential hits)
- **Monthly Report Summary Table**: Displays total logins grouped by month (`montlyStat.month`, `montlyStat.totalLogins`).
- **Granular User Attendance Table**:
  - Headers: `#`, `Nick`, `Email / IP`, `Time Stamps (Reverse sort)`, `Duration (Hours)`.
  - User Info: Gravatar, username, Free Trial badge, email, phone, IP lookup link (`http://ip-api.com/#{{userStat.ip}}`), device icon (`fa-mobile` vs `fa-desktop`), browser string.
  - Session Timestamps: In Time (`userStat.inTime | date:'MM/dd/yyyy @ h:mma'`), Out Time (`userStat.outTime`).
  - Session Duration: Calculated as `{{userStat.duration / 3600 | number: 2}}` hours.
## 7. Complete 268-Setting Directory (Tab 6: Settings)

Tab 6 of `page.manageSession.html` constitutes the master control plane of the ProTradingRoom engine. Every single field utilizes AngularJS X-Editable (`editable-text`, `editable-textarea`, `editable-checkbox`, `editable-select`, `editable-number`, or `editable-time`) binding directly to properties of `sess.*` and triggering `onaftersave="saveSessField('<field>')"` via `POST /users/v1/sessions`.

### 7.1 Tab Toolbar & Serialization Utilities
- **Export Settings**: `<button class="btn btn-md btn-info" ng-click="exportSettingsToJSON()"><i class="fa fa-floppy-o"></i> Export Settings</button>` (Exports entire room configuration as JSON blob via `FileSaver.saveAs`).
- **Load Settings From Room**: `<button class="btn btn-md btn-info" ng-click="loadSettingsFromRoom()"><i class="fa fa-plus"></i> Load Settings From Room</button>` (Clones configuration from a target session ID).

### 7.2 Exhaustive Categorized Settings Directory
Below is the complete, unabridged inventory of all 268 configurable parameters:

| # | Setting Label | Property Name (`sess.*`) | Input Type | Scope / Visibility | Notes & Functional Description |
|---|---|---|---|---|---|
| 1 | **(Toolbar Action / Unlabeled)** | - | `-` | Global | - |
| 2 | **JWT Secret Key:** | `sess.ssoJWTSecret` | `editable-textarea` | `sess.authMode=='jwt'` | - |
| 3 | **Wordpress shortcode:** | - | `-` | Global | - |
| 4 | **Token Expiration** | `sess.tokenExpiresIn` | `editable-textarea` | Global | - |
| 5 | **Room Password:** | `sess.webinarPW` | `editable-textarea` | Global | - |
| 6 | **Temp Room Password:** | `sess.webinarPW2` | `editable-textarea` | Global | - |
| 7 | **Temp Room Password 2:** | `sess.webinarPW3` | `editable-textarea` | Global | - |
| 8 | **Delete Alert Password** | `sess.deleteAlertPW` | `editable-textarea` | Global | - |
| 9 | **All Rooms Welcome Mat Password** | `sess.allRoomsWelcomeMatPW` | `editable-textarea` | Global | - |
| 10 | **Password to Manage User's Notes** | `sess.needPasswordForUserNotes` | `editable-textarea` | Global | - |
| 11 | **Nickname filter for members:** | `sess.nickFilter` | `editable-textarea` | Global | - |
| 12 | **Custom Favicon** | `sess.customFaviconURL` | `editable-textarea` | Global | - |
| 13 | **Overwrite Cash Register Sound** | `sess.overwriteCashRegisterSound` | `editable-text` | Global | - |
| 14 | **Login Webhook URL** | `sess.login_webhook_url` | `editable-textarea` | Global | - |
| 15 | **Logout Webhook URL** | `sess.login_webhook_url` | `editable-textarea` | Global | - |
| 16 | **Custom URL** | `sess.customRoomURL` | `editable-textarea` | Global | - |
| 17 | **Membership filter:** | `sess.allowedMemberships` | `editable-textarea` | Global | - |
| 18 | **Product filter:** | `sess.allowedProducts` | `editable-textarea` | Global | - |
| 19 | **Permissions filter:** | `sess.allowedPerms` | `editable-textarea` | Global | - |
| 20 | **Secret Token:** | `sess.secTok` | `editable-textarea` | Global | - |
| 21 | **Custom Room Drive URL** | `sess.custRoomDriveURL` | `editable-textarea` | Global | - |
| 22 | **Custom Logout URL** | `sess.custLogoutURL` | `editable-textarea` | Global | - |
| 23 | **Show Roster ?** | `sess.rosterVisibleToViewers` | `editable-checkbox` | Global | - |
| 24 | **Hide Welcome To Message?** | `sess.hideWelcomeTo` | `editable-checkbox` | Global | - |
| 25 | **Open link on login?** | `sess.openLoginLink` | `editable-textarea` | Global | - |
| 26 | **Custom login error URL redirect** | `sess.loginErrorURL` | `editable-textarea` | Global | - |
| 27 | **Custom login error message** | `sess.loginErrorMsg` | `editable-textarea` | Global | - |
| 28 | **Show only Presenters in the roster?** | `sess.onlyPresentersVisibleToViewers` | `editable-checkbox` | Global | - |
| 29 | **Show Roster Count?** | `sess.rosterCountVisibleToViewers` | `editable-checkbox` | Global | - |
| 30 | **Simulated Count?** | `sess.simUserCount` | `editable-number` | Global | - |
| 31 | **User PMs?** | `sess.userPM` | `editable-checkbox` | Global | - |
| 32 | **Enable Private Message History?** | `sess.enablePrivateMessageHistory` | `editable-checkbox` | Global | - |
| 33 | **Sound alert when a new message is posted?** | `sess.dingOnNewMessage` | `editable-checkbox` | Global | - |
| 34 | **Sound when the user joins/leaves?** | `sess.beepOnUserJoin` | `editable-checkbox` | Global | - |
| 35 | **Popup alert when the user joins/leaves?** | `sess.userJoinAndLeavePopup` | `editable-checkbox` | Global | - |
| 36 | **Hide User Avatars?** | `sess.hideAvatars` | `editable-checkbox` | Global | - |
| 37 | **Hide Mobile App Info?** | `sess.hideAppInfo` | `editable-checkbox` | Global | - |
| 38 | **Always Show User Roster?** | `sess.alwaysShowRoster` | `editable-checkbox` | Global | - |
| 39 | **Show Only Usernames in Roster?** | `sess.showOnlyUsernames` | `editable-checkbox` | Global | - |
| 40 | **Allow Users to Change their Usernames?** | `sess.allowUsersToChangeUsername` | `editable-checkbox` | Global | - |
| 41 | **Disable Editing Username** | `sess.disableEditingUsername` | `editable-checkbox` | Global | - |
| 42 | **Username Instructions** | `sess.usernameInstructions` | `editable-textarea` | Global | - |
| 43 | **Forgot room password?** | `sess.forgotRoomPassword` | `editable-checkbox` | Global | - |
| 44 | **Tawk Presenter Support?** | `sess.tawkPresenterSupport` | `editable-checkbox` | Global | - |
| 45 | **User PM presenters?** | `sess.userToPresenterPM` | `editable-checkbox` | Global | - |
| 46 | **Chat Message Sound For Emails:** | `sess.playChatMessageSoundFor` | `editable-textarea` | Global | - |
| 47 | **Alerts/Chat on bottom?** | `sess.alertsChatOnBottom` | `editable-checkbox` | Global | - |
| 48 | **Q&A on Alerts?** | `sess.hasQAOnAlerts` | `editable-checkbox` | Global | - |
| 49 | **Alerts over screenshare?** | `sess.alertsOverlayOnScreenshare` | `editable-checkbox` | Global | - |
| 50 | **Copy Trades?** | `sess.copyTrades` | `editable-checkbox` | Global | - |
| 51 | **Disable Copy?** | `sess.disableCopy` | `editable-checkbox` | Global | - |
| 52 | **Claim Nickname?** | `sess.claimNickName` | `editable-checkbox` | Global | - |
| 53 | **Show typing indicator ?** | `sess.hasTypingIndicator` | `editable-checkbox` | Global | - |
| 54 | **Presenter chat messages on the right?** | `sess.presenterMsgsOnTheRight` | `editable-checkbox` | Global | - |
| 55 | **Alt Chat Render?** | `sess.altChatRender` | `editable-checkbox` | Global | - |
| 56 | **Alt Room Render?** | `sess.altRoomRender` | `editable-checkbox` | Global | - |
| 57 | **Pair Link For App?** | `sess.hasAppPairLink` | `editable-checkbox` | Global | - |
| 58 | **Pair Secret Key** | `sess.pairSecretKey` | `editable-textarea` | Global | - |
| 59 | **Pair OK Redirect** | `sess.pairOKRedirect` | `editable-textarea` | Global | - |
| 60 | **Pair ERROR Redirect** | `sess.pairErrorRedirect` | `editable-textarea` | Global | - |
| 61 | **Hide Alerts/Chat Section?** | `sess.hideChatAlerts` | `editable-checkbox` | Global | - |
| 62 | **Enable Swing Trade Alerts Tab?** | `sess.hasSwingTradeAlerts` | `editable-checkbox` | Global | - |
| 63 | **Enable Day Trade Alerts Tab?** | `sess.hasDayTradeAlerts` | `editable-checkbox` | Global | - |
| 64 | **User Public Reply?** | `sess.usersPublicReply` | `editable-checkbox` | Global | - |
| 65 | **Chat Disabled For Trials?** | `sess.chatDisabledForTrials` | `editable-checkbox` | Global | - |
| 66 | **Disable PM For Trials?** | `sess.disablePMForTrials` | `editable-checkbox` | Global | - |
| 67 | **Users Can Delete Own Messages?** | `sess.usersCanDeleteOwnMsgs` | `editable-checkbox` | Global | - |
| 68 | **Smaller image previews?** | `sess.smallerImagePreview` | `editable-checkbox` | Global | - |
| 69 | **Hide Notes Section?** | `sess.hideNotes` | `editable-checkbox` | Global | - |
| 70 | **Hide Files Section?** | `sess.hideFiles` | `editable-checkbox` | Global | - |
| 71 | **Set Dark Theme As Default?** | `sess.darkThemeAsDefault` | `editable-checkbox` | Global | - |
| 72 | **Preserve Webinar Mode chat?** | `sess.saveWebinarModeChat` | `editable-checkbox` | Global | - |
| 73 | **Show Archives?** | `sess.showArchivesToUsers` | `editable-checkbox` | Global | - |
| 74 | **Show Archives to specific Presenters** | `sess.showArchivesToSpecificPresenters` | `editable-textarea` | Global | - |
| 75 | **Prevent sporadic reconnects?** | `sess.disalowSporadicMultiLogins` | `editable-checkbox` | Global | - |
| 76 | **Disalow Multi-logins?** | `sess.disalowMultiLogins` | `editable-checkbox` | Global | - |
| 77 | **Send report email?** | `sess.sendReportEmails` | `editable-checkbox` | Global | - |
| 78 | **Ban IP list** | `sess.banIPList` | `editable-textarea` | Global | - |
| 79 | **Report emails** | `sess.reportEmail` | `editable-textarea` | Global | - |
| 80 | **Custom JWT Error Message** | `sess.customJWTErrorMessage` | `editable-textarea` | Global | - |
| 81 | **Open/Close Room emails** | `sess.sendOpenCloseEmail` | `editable-textarea` | Global | - |
| 82 | **Auto Open Room Time** | `sess.autoOpenTime` | `editable-textarea` | Global | - |
| 83 | **Auto Close Room Time** | `sess.autoCloseTime` | `editable-textarea` | Global | - |
| 84 | **Ignore Auto Open & Close On Weekend** | `sess.ignoreAutoOpenCloseOnWeekend` | `editable-checkbox` | Global | - |
| 85 | **Alerts Sound Off?** | `sess.alertSoundOff` | `editable-checkbox` | Global | - |
| 86 | **Sticky Non-Trade Alerts?** | `sess.styckyNonTradeAlert` | `editable-checkbox` | Global | - |
| 87 | **Shared Files Access Case/Case?** | `sess.fileAccessCaseByCase` | `editable-checkbox` | Global | - |
| 88 | **Chat Only Room?** | `sess.isChatOnlyRoom` | `editable-checkbox` | Global | - |
| 89 | **Auto Clear Chat?** | `sess.chatAutoClear` | `editable-checkbox` | Global | - |
| 90 | **Auto Clear Alerts?** | `sess.alertsAutoClear` | `editable-checkbox` | Global | - |
| 91 | **Overwrite Clear Hour:** | `sess.chatAutoClearSpecialHour` | `editable-textarea` | Global | - |
| 92 | **Auto Clear Chat Weekend?** | `sess.chatAutoClearWeekend` | `editable-checkbox` | Global | - |
| 93 | **Archive Alerts?** | `sess.archiveAlertsLog` | `editable-checkbox` | Global | - |
| 94 | **Archive Chatlog?** | `sess.archiveChatLog` | `editable-checkbox` | Global | - |
| 95 | **Hide Chatlog from Archive?** | `sess.hideChatLog` | `editable-checkbox` | Global | - |
| 96 | **Enable alert scheduler?** | `sess.hasAlertScheduler` | `editable-checkbox` | Global | - |
| 97 | **Enable VideoPlayer?** | `sess.enableVideoPlayer` | `editable-checkbox` | Global | - |
| 98 | **User Chat Screenshots?** | `sess.userUploads` | `editable-checkbox` | Global | - |
| 99 | **Enable Discord?** | `sess.enableDiscord` | `editable-checkbox` | Global | - |
| 100 | **Disable Emojis?** | `sess.disableEmojis` | `editable-checkbox` | Global | - |
| 101 | **Enable Rich Text Editor?** | `sess.enableRTE` | `editable-checkbox` | Global | - |
| 102 | **Enable Reactions?** | `sess.enableReactions` | `editable-checkbox` | Global | - |
| 103 | **Enable QA Reactions?** | `sess.enableQAReactions` | `editable-checkbox` | Global | - |
| 104 | **Enable Edit Messages?** | `sess.enableEditMessage` | `editable-checkbox` | Global | - |
| 105 | **Enable Edit Alerts?** | `sess.enableEditAlerts` | `editable-checkbox` | Global | - |
| 106 | **Alert Labels** | `sess.alertLabels` | `editable-textarea` | Global | - |
| 107 | **Advanced Search Alerts?** | `sess.advancedSearchAlerts` | `editable-checkbox` | Global | - |
| 108 | **Enable Delete Log?** | `sess.enableDeleteLog` | `editable-checkbox` | Global | - |
| 109 | **User Badges?** | `sess.enableBadges` | `editable-checkbox` | Global | - |
| 110 | **Token Badges?** | `sess.enableTokenBadges` | `editable-checkbox` | Global | - |
| 111 | **Remove token from url** | `sess.remToken` | `editable-checkbox` | Global | - |
| 112 | **Show Badges only to Presenters?** | `sess.showBadgesToPresentersOnly` | `editable-checkbox` | Global | - |
| 113 | **Don't follow Presenters?** | `sess.dontFollowPresenters` | `editable-checkbox` | Global | - |
| 114 | **Disable Stars ?** | `sess.disableStarYears` | `editable-checkbox` | Global | - |
| 115 | **Phone Number Required?** | `sess.hasRequiredPhoneInLogin` | `editable-checkbox` | Global | - |
| 116 | **Show password field?** | `sess.showPasswordField` | `editable-checkbox` | Global | - |
| 117 | **Is Main Room?** | `sess.isMainRoom` | `editable-checkbox` | Global | - |
| 118 | **Is Archived Room?** | `sess.isArchivedRoom` | `editable-checkbox` | Global | - |
| 119 | **Is New Room?** | `sess.isNewIndicatorOn` | `editable-checkbox` | Global | - |
| 120 | **BZ News (DO NOT USE UNLESS YOU HAVE API)** | `sess.hasBenzingaNews` | `editable-checkbox` | Global | - |
| 121 | **Custom Benzinga logo url** | `sess.altBenzingaLogoURL` | `editable-textarea` | Global | - |
| 122 | **Custom Benzinga link url** | `sess.altBenzingaLinkURL` | `editable-textarea` | Global | - |
| 123 | **Imgur ClientID:** | `sess.imgurClientID` | `editable-text` | Global | - |
| 124 | **Imgur api key:** | `sess.imgurApiKey` | `editable-text` | Global | - |
| 125 | **Imgur rapid key:** | `sess.imgurRapidKey` | `editable-textarea` | Global | - |
| 126 | **X User Access Token:** | `sess.xuserAccessToken` | `editable-textarea` | Global | - |
| 127 | **X User Access Token Secret:** | `sess.xuserAccessTokenSecret` | `editable-textarea` | Global | - |
| 128 | **Subscription Plans:** | `sess.subscriptionPlans` | `editable-textarea` | Global | - |
| 129 | **Stripe Email:** | `sess.stripeEmail` | `editable-textarea` | Global | - |
| 130 | **Live User stats?** | `sess.enableLiveStats` | `editable-checkbox` | Global | - |
| 131 | **UserXrefStats?** | `sess.collectsUserStats` | `editable-checkbox` | Global | - |
| 132 | **API secret** | `sess.apiSecret` | `editable-textarea` | Global | - |
| 133 | **(Toolbar Action / Unlabeled)** | - | `-` | Global | - |
| 134 | **Slack post URL secret** | `sess.slackPostURL` | `editable-textarea` | Global | - |
| 135 | **Disable PUSH Alerts?** | `sess.diasableFCMAlerts` | `editable-checkbox` | Global | - |
| 136 | **Moderator Message:** | `sess.modMessage` | `editable-textarea` | Global | - |
| 137 | **Positions Iframe Url** | `sess.positionsIframeUrl` | `editable-textarea` | Global | - |
| 138 | **Enable positions iframe?** | `sess.positionsIframe` | `editable-checkbox` | Global | - |
| 139 | **Enable Tip Me Button?** | `sess.tipMeBtnEnabled` | `editable-checkbox` | Global | - |
| 140 | **Tip Me Button Text** | `sess.tipMeBtnTxt` | `editable-textarea` | Global | - |
| 141 | **Tip Me Button Url** | `sess.tipMeBtnUrl` | `editable-textarea` | Global | - |
| 142 | **Sales Banner** | `sess.salesBanner` | `editable-textarea` | Global | - |
| 143 | **Admin panel access list:** | `sess.modAdminLoginList` | `editable-textarea` | Global | - |
| 144 | **Alerts only Room?** | `sess.isAlertOnly` | `editable-checkbox` | Global | - |
| 145 | **Custom Alert POST** | `sess.customClientAlertPostURL` | `editable-textarea` | Global | - |
| 146 | **Custom Alert secret** | `sess.customClientAlertPostSecret` | `editable-textarea` | Global | - |
| 147 | **Strict Browser?** | `sess.strictBrowserMode` | `editable-checkbox` | Global | - |
| 148 | **Disable Chat Flood?** | `sess.chatFloodDisabled` | `editable-checkbox` | Global | - |
| 149 | **Huge Priv Msg Alert?** | `sess.privMessageHugePopup` | `editable-checkbox` | Global | - |
| 150 | **OffTopic Channels/Tabs** | `sess.hasChannelTabs` | `editable-checkbox` | Global | - |
| 151 | **Auto switch to OffTopic Channels/Tabs?** | `sess.autoSwitchToOfftopics` | `editable-checkbox` | Global | - |
| 152 | **Admin Channels/Tabs** | `sess.hasAdminOnlyChannel` | `editable-checkbox` | Global | - |
| 153 | **Extra Admin Channels** | `sess.extraAdminChannels` | `editable-textarea` | Global | - |
| 154 | **Extra Regular Channels** | `sess.extraRegChannels` | `editable-textarea` | Global | - |
| 155 | **Rename "Main Chat"** | `sess.altGenChannelName` | `editable-textarea` | Global | - |
| 156 | **Rename "Off-Topic"** | `sess.altOffTopicChannelName` | `editable-textarea` | Global | - |
| 157 | **Chat Tabs With Badges:** | `sess.chatTabsWithBadges` | `editable-textarea` | Global | - |
| 158 | **Chat Profanity filter?** | `sess.hasProfanityFilter` | `editable-checkbox` | Global | - |
| 159 | **Ignore List** | `sess.ingnoreBadWordsList` | `editable-text` | Global | - |
| 160 | **Extra Bad list** | `sess.additionalBadWordsList` | `editable-text` | Global | - |
| 161 | **Clear Chat Time:** | `sess.chatAutoClearTime` | `editable-time` | Global | - |
| 162 | **Simplified Note Editor?** | `sess.simplifiedEditor` | `editable-checkbox` | Global | - |
| 163 | **Disable Audio Meter?** | `sess.audioMeterDisabled` | `editable-checkbox` | Global | - |
| 164 | **Hide WebCam in the room?** | `sess.hideWebcamForRoom` | `editable-checkbox` | Global | - |
| 165 | **Record alerts and chat?** | `sess.recordChat` | `editable-checkbox` | Global | - |
| 166 | **Auto record presenters?** | `sess.autoRecord` | `editable-checkbox` | Global | - |
| 167 | **Blinking [REC]?** | `sess.blinkingRec` | `editable-checkbox` | Global | - |
| 168 | **Hide Recordings?** | `sess.hideRecs` | `editable-checkbox` | Global | - |
| 169 | **Recording Reminder If Speaking?** | `sess.recordingReminder` | `editable-checkbox` | Global | - |
| 170 | **Show Recordings tab in the room?** | `sess.recsInRoom` | `editable-checkbox` | Global | - |
| 171 | **Disable download button for Recordings for users?** | `sess.downloadRecordingsDisabled` | `editable-checkbox` | Global | - |
| 172 | **Disable Closed Captioning?** | `sess.hasSpeechRecognitionDisabled` | `editable-checkbox` | Global | - |
| 173 | **Hide recordings info for users?** | `sess.dontShowRecInfoToUsers` | `editable-checkbox` | Global | - |
| 174 | **Minutes of recording inactivity?** | `sess.runawayRecMinutes` | `editable-number` | Global | - |
| 175 | **Auto stop recording if inactive?** | `sess.runawayRecAutoKill` | `editable-checkbox` | Global | - |
| 176 | **Slack url to post** | `sess.runawayRecPostURL` | `editable-textarea` | Global | - |
| 177 | **Sticky give Mic/Cam?** | `sess.stickyGiveMicAndCam` | `editable-checkbox` | Global | - |
| 178 | **Overlay userID on screenshare?** | `sess.overlayUserIdOnScreenshare` | `editable-checkbox` | Global | - |
| 179 | **Auto give Mic/Screen to Users?** | `sess.regUserCanPresent` | `editable-checkbox` | Global | - |
| 180 | **Don't stop on mute?** | `sess.dontStopRecOnMicMute` | `editable-checkbox` | Global | - |
| 181 | **Individual Volume Controls?** | `sess.individualVolumeControls` | `editable-checkbox` | Global | - |
| 182 | **NEW recording procedure?** | `sess.remote_recording` | `editable-checkbox` | Global | - |
| 183 | **Save Recs to AWS S3** | `sess.saveRecsToS3` | `editable-checkbox` | Global | - |
| 184 | **S3 Key ID/Name** | `sess.s3KeyID` | `editable-text` | Global | - |
| 185 | **S3 Key Secret** | `sess.s3KeySecret` | `editable-text` | Global | - |
| 186 | **S3 Bucket** | `sess.s3Bucket` | `editable-text` | Global | - |
| 187 | **S3 Bucket subfolder/path** | `sess.s3BucketFolderPath` | `editable-text` | Global | - |
| 188 | **Save Recs to Vimeo** | `sess.saveRecsToVimeo` | `editable-checkbox` | Global | - |
| 189 | **Vimeo ClientID** | `sess.vimeoClientID` | `editable-text` | Global | - |
| 190 | **Vimeo Secret** | `sess.vimeoClientSecret` | `editable-text` | Global | - |
| 191 | **Vimeo Token** | `sess.vimeoToken` | `editable-text` | Global | - |
| 192 | **Vimeo Folder ID (optional)** | `sess.vimeoFolderPath` | `editable-text` | Global | - |
| 193 | **Broadcast using OBS?** | `sess.obsBroadcastRoom` | `editable-checkbox` | Global | - |
| 194 | **OBS Stream Key** | `sess.obsStreamKey` | `editable-text` | Global | - |
| 195 | **OBS Stream Satus WebHook URL** | `sess.obsStreamSatusWebHookURL` | `editable-text` | Global | - |
| 196 | **Restream URL** | `sess.restreamToURL` | `editable-text` | Global | - |
| 197 | **Restream Key** | `sess.restreamToURLKey` | `editable-text` | Global | - |
| 198 | **Custom Rec Params** | `sess.x264_encArgs` | `editable-text` | Global | - |
| 199 | **Twillio SID** | `sess.twillioApiSID` | `editable-text` | Global | - |
| 200 | **Twillio Token** | `sess.twillioApiToken` | `editable-text` | Global | - |
| 201 | **Twillio Phone** | `sess.twilioPhone` | `editable-text` | Global | - |
| 202 | **Protexting Token** | `sess.protextingSecretTok` | `editable-text` | Global | - |
| 203 | **Protexting GroupID** | `sess.protextingGroupIDs` | `editable-text` | Global | - |
| 204 | **Use h264 codec?** | `sess.h264Enabled` | `editable-checkbox` | Global | - |
| 205 | **Use VP9 codec?** | `sess.vp9Enabled` | `editable-checkbox` | Global | - |
| 206 | **Use HQ Video?** | `sess.hqVideo` | `editable-checkbox` | Global | - |
| 207 | **Custom Player URL** | `sess.customPlayerURL` | `editable-text` | Global | - |
| 208 | **Iframe Cookie Fix?** | `sess.iframeSSOTFix` | `editable-checkbox` | Global | - |
| 209 | **Autoreset sess at 12am?** | `sess.autoResetSession` | `editable-checkbox` | Global | - |
| 210 | **Don't Soft reset at 12am?** | `sess.doNotAutoSoftReset` | `editable-checkbox` | Global | - |
| 211 | **New FCM Method?** | `sess.sendFcmAlertsNew` | `editable-checkbox` | Global | - |
| 212 | **PTR app exp days** | `sess.ptrMobileAppExpirePairCodeDays` | `editable-number` | Global | - |
| 213 | **Push expire days** | `sess.mobileAppExpireNotificationsDays` | `editable-number` | Global | - |
| 214 | **Custom Legal Disclosure** | `sess.customEnterDisclosure` | `editable-textarea` | Global | - |
| 215 | **Custom User Info Page** | `sess.customUserInfoURL` | `editable-text` | Global | - |
| 216 | **Scheudle ID (GCal)** | `sess.stAppScheduleID` | `editable-text` | Global | - |
| 217 | **Invalid Tokens** | `sess.invalidTokens` | `editable-textarea` | Global | - |
| 218 | **Use v3? (DON'T!)** | `sess.useV3` | `editable-checkbox` | Global | - |
| 219 | **Use v5? (DON'T!)** | `sess.useV5` | `editable-checkbox` | Global | - |
| 220 | **Use v4? (DON'T!)** | `sess.useV4` | `editable-checkbox` | Global | - |
| 221 | **ClusterID** | `sess.clusterID` | `editable-text` | Global | - |
| 222 | **Super ClusterID** | `sess.superClusterID` | `editable-text` | Global | - |
| 223 | **Use FFmpeg for Recording (BETA)** | `sess.useFFmpegRecording` | `editable-checkbox` | Global | - |
| 224 | **Use Less busy server algo vs round robin** | `sess.useLessBusyVsRoundRobin` | `editable-checkbox` | Global | - |
| 225 | **Use MediaMTX?** | `sess.useMediaMTX` | `editable-checkbox` | Global | - |
| 226 | **MediaMTX ClusterID** | `sess.mediaMTXClusterID` | `editable-text` | Global | - |
| 227 | **Backup MediaMTX ClustterID** | `sess.backupMediaMTXClustterID` | `editable-text` | Global | - |
| 228 | **Master AUDIO Media Server** | `sess.media_server_audio` | `editable-text` | Global | - |
| 229 | **ScreenShare MAX BitRate** | `sess.media_max_bitrate` | `editable-text` | Global | - |
| 230 | **ScreenShare KeyFrame Rate  (i.e. 5, 10, 15)** | `sess.media_fir_rate` | `editable-text` | Global | - |
| 231 | **Enable Media repeating** | `sess.relay_to_repeaters` | `editable-checkbox` | Global | - |
| 232 | **Enable FB Live/YouTube Live** | `sess.hasYTStreaming` | `editable-checkbox` | Global | - |
| 233 | **Start Repeat Users  (300, 500, etc)** | `sess.relay_user_max` | `editable-text` | Global | - |
| 234 | **Repeater List** | `sess.media_relays` | `editable-textarea` | `showAdServer` | - |
| 235 | **Lock Session?** | `sess.isLocked` | `editable-checkbox` | Global | - |
| 236 | **Talk URL** | `sess.chatServerURL` | `editable-textarea` | Global | - |
| 237 | **Force JPG Screens** | `sess.force_jpeg_screenshare` | `editable-checkbox` | Global | - |
| 238 | **Force MP3 Audio** | `sess.force_mp3_audio` | `editable-checkbox` | Global | - |
| 239 | **Node Repeater List** | `sess.node_media_relays` | `editable-textarea` | Global | - |
| 240 | **Node Websocket Repeater List** | `sess.node_ws_media_relays` | `editable-textarea` | Global | - |
| 241 | **Alt VendorJS** | `sess.altCodeVendorJS` | `editable-textarea` | Global | - |
| 242 | **Alt AppJS** | `sess.altCodeAppJS` | `editable-textarea` | Global | - |
| 243 | **Alt JanusJS** | `sess.customJanus` | `editable-textarea` | Global | - |
| 244 | **Alt Room.js** | `sess.alt_roomjs` | `editable-textarea` | Global | - |
| 245 | **Alert filter list for mods:** | `sess.modAlertFilterList` | `editable-textarea` | Global | - |
| 246 | **Custom CSS** | `sess.customCSS` | `editable-textarea` | Global | - |
| 247 | **Dark Theme Style** | `sess.darkThemeStyle` | `editable-textarea` | Global | - |
| 248 | **Hide Logo** | `sess.hideLogo` | `editable-checkbox` | Global | - |
| 249 | **Hide Powered By** | `sess.hidePoweredBy` | `editable-checkbox` | Global | - |
| 250 | **Linked Rooms for alerts** | `sess.linkedRoomAlerts` | `editable-textarea` | Global | - |
| 251 | **Linked Rooms for Swing Alerts** | `sess.linkedRoomSwingAlerts` | `editable-textarea` | Global | - |
| 252 | **SessionID to load swing alerts from** | `sess.linkedRoomSwingAlertsOther` | `editable-textarea` | Global | - |
| 253 | **Linked Rooms for Day Trade Alerts** | `sess.linkedRoomDayTradeAlerts` | `editable-textarea` | Global | - |
| 254 | **SessionID to load day trade alerts from** | `sess.linkedRoomDayTradeAlertsOther` | `editable-textarea` | Global | - |
| 255 | **Other Room API Secret:** | `sess.linkedStreamsAPIKey` | `editable-textarea` | Global | - |
| 256 | **Push our stream to this Session:** | `sess.linkedStreamsToSession` | `editable-textarea` | Global | - |
| 257 | **Enable PTR app?** | `sess.ptrMobileAppEnabled` | `editable-checkbox` | Global | - |
| 258 | **App for Free trials?** | `sess.freeTrialsGetApp` | `editable-checkbox` | Global | - |
| 259 | **Custom App?** | `sess.customMobileAppEnabled` | `editable-checkbox` | Global | - |
| 260 | **Custom app String** | `sess.customMobileAppV3Name` | `editable-textarea` | Global | - |
| 261 | **Custom iOS App URL** | `sess.customMobileAppIOSUrl` | `editable-textarea` | Global | - |
| 262 | **Custom Android App URL** | `sess.customMobileAppAndroidUrl` | `editable-textarea` | Global | - |
| 263 | **Custom App launch Word** | `sess.customMobileAppLaunchWord` | `editable-textarea` | Global | - |
| 264 | **Hide Mobile Credentials?** | `sess.hideMobileCredentials` | `editable-checkbox` | Global | - |
| 265 | **App for Some Members?** | `sess.ptrMobileAppCaseByCaseEnabled` | `editable-checkbox` | Global | - |
| 266 | **NQ News URL** | `sess.nqNewsFeedURL` | `editable-textarea` | Global | - |
| 267 | **Random UDP port fix?** | `sess.generateRandomUDPPort` | `editable-checkbox` | Global | - |
| 268 | **Streaming Threads?** | `sess.streamingThreads` | `editable-checkbox` | Global | - |## 8. Session Management Modals & Auxiliaries

Several core administrative actions in `page.manageSession.html` and the room runtime invoke specialized modals for granular permission delegation, user invitation, file asset management, legal compliance, session health recovery, attendee inspection, and interactive polling.

### 8.1 Granular Permissions Modal (`#permissionsModal`)
- **Host File**: Embedded directly at the bottom of `page.manageSession.html` (lines 2685-2715).
- **Trigger**: `setPermissions(user)` from the Users table dropdown (`data-toggle="modal" data-target="#permissionsModal"`).
- **Title**: `Adjust Mic/Cam/Screen permissions for user: <i>{{userPermissions.userName}}</i>`
- **Checkboxes & Handlers**:
  1. Microphone: `<input ng-change="toggleHasMic()" ng-model="userPermissions.hasMic" type="checkbox"> Microphone`
  2. Screenshare: `<input ng-change="toggleHasScreen()" ng-model="userPermissions.hasScreen" type="checkbox"> Screenshare`
  3. WebCam: `<input ng-change="toggleHasCam()" ng-model="userPermissions.hasCam" type="checkbox"> WebCam`
  4. Admin Chat: `<input ng-change="toggleHasAdminChat()" ng-model="userPermissions.hasAdminChat" type="checkbox"> AdminChat`
  5. Notes Edit: `<input ng-change="toggleCanEditNotes()" ng-model="userPermissions.canEditNotes" type="checkbox"> CanEditNotes`
- **Footer Actions**: Close (`data-dismiss="modal"`), Save Changes (`ng-click="saveUserPermissions()" class="btn btn-success"`).
  - Persistence: Dispatches `POST /users/v1/sessions` with `cmd: 'updateUserXref'`, `permsChange: true`, and all 5 permission booleans.

### 8.2 Participant Invitation Modal (`inviteModal.html`)
- **Host File**: `/public/app/views/cached/inviteModal.html` (89 lines).
- **Trigger**: `doInvite()` in `LoginCtrl` via `$modal.open`.
- **Header**: `<h4 class="modal-title">Invite Participants</h4>`
- **Form Inputs**:
  - Name: `<input ng-model="invite.name" class="form-control" placeholder="Name" type="text" />`
  - Email: `<input ng-model="invite.email" class="form-control" placeholder="Email" type="email" />`
  - Password: `<input ng-model="invite.pw" class="form-control" placeholder="Password (optional)" type="text" />`
  - Role Dropdown: `<select ng-model="invite.role"><option value="2" selected>Participant</option><option value="1">* Presenter *</option></select>`
  - Email Notification Checkbox: `<input type="checkbox" ng-model="invite.sendEmail" />` (`"If checked, the system will email the user this credentials"`).
- **Staging List**: Displays staged attendees in `<ul class="list-group"><li ng-repeat="person in invite.persons">` with remove link `<a ng-click="removePerson($index)"><i class="fa fa-minus-circle"></i></a>`.
- **Footer Controls**: Cancel (`closeInvite()`), Add (`sendInvites()` -> `POST /users/v1/sessions` with `cmd: 'inviteUsers'`).

### 8.3 Room Files Drive Modal (`files.html`)
- **Host File**: `/public/app/views/files.html` (221 lines).
- **Trigger**: Invoked when opening Room Drive, changing logos (`openFileChooser('logos')`), or setting room backgrounds.
- **Header**: `<h4 id="myModalLabel" class="modal-title">Room Files</h4>`
- **Toolbar Controls**:
  - Search input: `ng-model="search"`
  - Refresh: `<button ng-click="getFiles()" class="btn btn-default icon fa fa-refresh"></button>`
  - Upload New Asset: `<button type="button" ngf-select="ngf-select" ngf-change="onFileSelect($files)" class="btn btn-info"><i class="fa fa-cloud-upload"></i> Upload New</button>`
  - Background Links: `Set Background image external link` (`setBkgURL()`) & `Clear Background image` (`clearBkgURL()`).
- **Tab Navigation**:
  - `Files` (`activeTab=='files'`): Documents, PDFs, spreadsheets.
  - `Images` (`activeTab=='images'`): Graphical media (`image/*`). Displays thumbnail preview `<img ng-src="{{file.vidPath}}" class="navLogo" />`.
  - `Sounds` (`activeTab=='sounds'`): Audio effects and tracks (`audio/*`). Displays `Play For All` button (`playForAll(file.vidPath)`).
- **Actions Dropdown per File**:
  - Set as Logo (`setAsLogo(file.vidPath)`)
  - Set as Background (`setAsBkg(file.vidPath)`)
  - Play For All / Stop Play For All (`stopForAll(file.vidPath)`)
  - Delete (`deleteFile(...)`)
  - Delete Selected (`deleteChecked()`)

### 8.4 Legal Disclosure & Compliance Modal (`disclosure.html`)
- **Host File**: `/public/app/views/disclosure.html` (29 lines).
- **Trigger**: `doDisclosure()` in `LoginCtrl` when `sess.customEnterDisclosure` is populated.
- **Header**: `<h4 class="modal-title">Room Disclosure &amp; Compliance</h4>`
- **Content**: Readonly scrollable textarea displaying `{{disclosureText}}`.
- **Acknowledgement**: Input field `<input type="text" placeholder="Your Initials..." ng-model="userInitials">`.
- **Footer**: Disagree (`closeModal()`) vs I Agree (`agree()`). Mandatory agreement required to proceed into room.

### 8.5 Session Control Modal (`roomControl.html`)
- **Host File**: `/public/app/views/roomControl.html` (140 lines).
- **Tabs**:
  1. **Reset Audio**: Reset Audio Bridge (`resetAudioRoom()`), Stop Audio Bridge (`stopAudioRoom()`), Restart Single Audio Server (`restartSingleAudioServer(server)`).
  2. **Hard Reset/Reload**: Hard Reset/Force Reload (`resetRoom()`), Restart Single Server SSH (`restartSingleServerSSH(server)`). Kicks everyone to login screen and resets media bridge.
  3. **Soft Reset**: Soft Reset Session (`resetRoomSoft()`). Reloads DB settings, gently reconnecting attendees without kicking.
  4. **Lock Room**: Lock/Unlock Room (`doSessionLock()`). When locked, all non-admin attendees are booted and blocked from entering.
  5. **Close Room**: Rich text / free-form editor for closed room message (`closedMsg`), Close Session (`closeRoom(closedMsg)`), Open Session (`openRoom()`), Close Session & Revoke Access (`closeRoom(closedMsg, true)`).
  6. **A/V Device Selection**: Direct hardware input selectors for microphone (`#audio-device`) and webcam (`#video-device`) with `setNewDevices()`.

### 8.6 Attendee Detail & Moderation Card (`userInfo.html`)
- **Host File**: `/public/app/views/userInfo.html` (141 lines).
- **Trigger**: Clicking attendee in user roster or via random user selector.
- **User Card Elements**:
  - Gravatar avatar, Nickname, Change Nick button (`editUserNick`), @Mention User (`doMention`), Private Chat (`doPrivateChat`), Ignore / Mute (`doUser2UserChatMute`), Tagline.
  - Presenter Inspection Data: Temporary presenter toggles (`makeTempPresenter('p'|'r')`), Email, Phone, Mobile PIN, Logged In timestamp, IP lookup link (`ip-api.com`), Browser agent, Connected Stream Server, App version, Debug log export (`getDebugLog()`).
- **Moderation Footer Actions**:
  - Force Reload: `kickUserReload()` (`fa fa-refresh`)
  - Restart Audio: `restartUserAudio()` (`fa fa-volume-up`)
  - Kick: `kickUser()` (`fa fa-user-times`)
  - Kick & Ban: `kickAndBanUser()` (`btn-danger`)
  - Kick Duplicates: `kickDuplicates()`
  - Mute Chat Dropdown: Mute Indefinitely, Mute for 24 Hours, Mute for 12 Hours (`muteChatUserHours`), Unmute Chat (`unmuteChatUser`).
  - Presenter Controls (`user.perms=='a'`): Remote Stop/Start Recording (`remoteStopRec`, `remoteStartRec`), Mute Audio (`muteUser`), Mute Camera (`muteCamUser`), Kill Screens (`muteScreenUser`), Restart Screens (`restartScreenUser`).

### 8.7 Interactive Polling Modal (`pollPopup.html`)
- **Host File**: `/public/app/views/pollPopup.html` (141 lines).
- **Modes**:
  1. **Setup Mode (`mode=='setup'`)**:
     - Tab 1: Create New Poll — Main question input (`pollQuestion`), choice input (`pollChoice` with `addChoice()`), choices list with delete, Anonymous Poll checkbox (`anonymousPoll`).
     - Send Poll Dropdown: Everyone, Members only, Trials only (`sendPoll('everyone'|'members'|'trials')`).
     - Save To Canned Button: `savePollToStorage()`.
     - Tab 2: Pre-Canned Polls — Stored poll templates with Load (`loadSavedPoll`) and Delete (`deleteSavedPoll`).
  2. **Answer Mode (`mode=='answer'`)**:
     - Rendered to attendees: Displays `{{pollQuestion}}` and clickable choice buttons (`sendAnswer($index)`).
  3. **Results Mode (`mode=='results'`)**:
     - Real-time Flot Pie Chart (`<flot dataset="pieData" options="chartPieFlotChart"></flot>`).
     - Total response counter (`total`).
     - Non-anonymous voter list: `<textarea id="responsesTxt"></textarea>`.
     - Download Results (`savePollResults()`) & Broadcast Results to Chat (`postResults()`).

## 9. Analytics, Usage Statistics & Mock Charts

### 9.1 Production Analytics Console (`page.stats.html`)
- **Layout**: Dark background (`#0A0A0A`), responsive container.
- **Historical Panel**: `<div class="panel-heading"><div class="panel-title">Historical</div></div>`
- **Timeframe Aggregations**: `<select><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>`.
- **Interactive Flot Graph**: `<flot dataset="userStatsData" options="userStatsDataOptions"></flot>` (Renders concurrent active users over chosen time window).
- **Raw JSON Download**: `<a ng-href="/users/v1/sessions/stats/{{sessionID}}/{{tok}}" class="btn btn-oval btn-info" download="{{sessionID}}.json">Download</a>`.
- **Controller Binding**: Invokes `getStatsForSession()` posting `cmd: 'statsForSession'` to `POST /users/v1/sessions`.

### 9.2 Vestigial Mock Charts View (`page.mockstats.html`)
- **Controller**: `FlotChartController`
- **Nature**: Demonstration page from Naut template with static JSON feeds:
  - Monthly Averages: `<flot src="'server/chart/barstacked.json'" options="chartBarStackedFlotChart"></flot>`
  - Monthly User Distribution: `<flot src="'server/chart/pie.json'" options="chartPieFlotChart"></flot>`
  - Daily Activity Lines: `<flot src="'server/chart/area.json'"></flot>` with hardcoded switches for *John Carter*, *Henry*, and *Bruce*.
  - Daily Averages Spline: `<flot src="'server/chart/spline.json'"></flot>`.
  - Real-time Flot Canvas: Simulated real-time sine-wave line chart.
- **Forensic Assessment**: Purely demonstrative mockup; superseded in production by `page.stats.html` and Tab 5 of `manageSession`.

## 10. Recordings Portal (`page.recordings.html`)

- **Access Route**: `/recs` (`page.recordings`, `params: {isRec: true}`).
- **Layout**: Centered card layout (`container container-sm`, `style="width: 70%;"`).
- **Brand**: `<img src="/public/app/img/protradingroom_icon.png" alt="Image" class="pull-left">`
- **Heading**: `<h3>Recordings</h3>`
- **Panel Structure**: `<div class="panel panel-default"><div class="panel-heading">Recordings:</div><div class="panel-body">`
- **Recordings List Group**:
  - Empty State: `<li ng-hide="recs.length>0">No Recordings...</li>`
  - Recording Item: `<li class="list-group-item" ng-repeat="rec in recs">`
    - Metadata: `<h4> <i class="fa fa-file-video-o"></i> {{::rec.created | date:'MM/dd/yyyy @ h:mma' }} <i class="fa fa-clock-o"></i> {{(rec.length/60000) | number:2}} Minutes</h4>`
    - HTML5 Video Player: `<video ng-src="{{rec.vidPath}}" controls type="{{rec.contentType}}" width="640"></video>`
    - Action Buttons:
      1. Download: `<a ng-href="{{::rec.vidPath}}" target="_blank" download="{{rec.name}}" class="btn btn-default"><i class="fa fa-cloud-download"></i> Download</a>`
      2. Share: `<a href="" class="btn btn-default"><i class="fa fa-share"></i> Share</a>`
- **Controller Logic (`getRecordings`)**:
  - Extracts session token from `$localstorage.get('token')` or `$localstorage.get('tokenSite')`.
  - Dispatches `POST /users/v1/recordings` with `{token: tok, source: 'webApp'}`.
  - Binds response payload to `$scope.recs`.

## 11. User Avatar Selection Engine (`page.avatars.html`)

- **Access Route**: `/avatars` (`page.avatarSelect`).
- **Controller**: `AvatarsCtrl`
- **Layout Grid**: Full-height table container (`.container-fh .l-table-fixed .l-cell`) with centered card: `Choose The Avatar you want to use`.
- **Avatar Matrix**: Rendered via `<div ng-repeat="avatar in avatars" class="col-md-1"><a href="" ng-click="selectAvatar(avatar)" class="avatarChooser"><img ng-src="{{::avatar}}" alt="Image" class="thumb80" /></a></div>`.
- **Catalog of 9 Stock Avatars**:
  1. `app/img/user/01.jpg`
  2. `app/img/user/02.jpg`
  3. `app/img/user/03.jpg`
  4. `app/img/user/04.jpg`
  5. `app/img/user/05.jpg`
  6. `app/img/user/06.jpg`
  7. `app/img/user/07.jpg`
  8. `app/img/user/08.jpg`
  9. `app/img/user/user.png`
- **Selection Handler (`selectAvatar`)**:
  - Stores selection in `$cookies.avatar = avt` and `chatModel.avatar = avt`.
  - Transitions state via `$state.go('page.login')`.

## 12. Global Footers & Disconnection Screens

### 12.1 Shared Footer (`page.footer.html`)
- Embedded across all `/page/*` templates via `<div ng-include="'app/views/page.footer.html'"></div>`.
- HTML Content:
  ```html
  <hr/>
  <span class="mr-sm">&copy;</span>
  <span ng-bind="app.year" class="mr-sm"></span>
  <span ng-bind="app.name"></span>
  <br/>{{app.description}}
  ```
- Interpolates root scope settings (`app.year = new Date().getFullYear()`, `app.name = 'ProTradingRoom'`).

### 12.2 Kicked / Disconnected View (`kicked.html`)
- **Route**: `/kicked` (`kicked`, controller: `KickedCtrl`, `params: {msg: ''}`).
- **Layout**: Centered disconnection card.
- **Message Display**: Renders specific disconnection reasons passed via `$stateParams.msg`:
  - Moderator Kick: *"You have been kicked by the room moderator."*
  - Ban: *"Your account has been banned from this session."*
  - Duplicate Session / Concurrent Login: *"You have logged in from another device or tab."*
  - Locked Session: *"This session has been locked by the host."*
- **Recovery Action**: Return to room login or main portal.
