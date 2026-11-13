# Repository audit and verification

The audit covered maintained application source, captured frontend bundles and templates, HTTP and SockJS contracts, database ownership and access checks, dependency vulnerabilities, Docker configuration, file handling, authentication, media control, and the available original-session UI. The original production account was inspected read-only. Original private server code was not available.

## Completed implementation

| Area | Result and evidence |
| --- | --- |
| Accounts and authorization | Password checks, typed signed JWTs, issuer/audience checks, rotation, owner/delegate separation, room role checks, bans, expiry and scoped API keys. Security, REST, SSO, provision and socket tests. |
| Requested credentials | Six randomly generated local role credentials, two isolated owner accounts, local plan entitlements, read-only room API keys and JWT signing secrets. Repeatable provisioning preserves existing passwords and detects revoked credentials. All six normal browser login journeys passed. |
| Account portal and room administration | Room/settings persistence, account-wide badges, member management, invites, archives, stats and protected uploads/downloads. REST, badge, image and stats tests. |
| Marketplace and courses | Recovered original public marketplace client, same-origin API/token integration, listing and membership-plan management, publishing, search, media uploads, free access, course sections/units and protected paid lesson delivery. Marketplace API tests and browser owner/buyer workflows. |
| Billing | Configurable Stripe Connect and Checkout, stored authoritative prices, signed/idempotent webhooks, membership activation/revocation, subscription/refund lifecycle and connected-account fee/net reporting. Mocked provider tests; no real transactions. |
| WordPress | Reconstructed shortcode with a user-bound one-use ticket and short-lived signed room JWT. Actual PHP Docker fixture and application HTTP handoff passed. |
| Realtime | Authoritative socket identity, scoped live role checks, chat, alerts, polls, moderation, schedules, linked-room alerts, attendance and persistent state. Realtime/socket/webhook tests. |
| Direct media and recording | Janus audio/video with current browser track handling, native WAV/MJR capture, FFmpeg conversion and protected playable download. Isolated Chromium published and received synthetic media and downloaded its processed recording. |
| OBS and external streaming adapters | Authenticated OBS ingestion through MediaMTX/FFmpeg to Janus; isolated browser received audio/video and verified stop. Egress and simultaneous OBS/RTMP were verified using local sinks. No external broadcast. |
| Phone and social adapters | Signed Twilio WebSocket/PCMU bridge, bounded calls, hangup and deletion guards; configurable X posting with captured OAuth fields. Actual local Janus exchanged non-silent PCMU packets in both directions; provider call/post HTTP was mocked. |
| Room media reset | Room-scoped Janus restart stops relays/calls, refuses active recording and leaves other rooms running. Two-room local media verification and unit coverage. |
| Email and optional providers | Durable outbox and single-use reset links; actual local SMTP/Mailpit reset, invite, registration, welcome, reminder and contact delivery. SMS, FCM, S3/Vimeo and social tests use mocked providers. |
| Security and repository hygiene | Private media administration, generated installation secrets, tenant isolation, HTML/URL filtering, bounded frames/uploads, SSRF controls, provider opt-in, runtime/private-file exclusions and secret checks. Dependency audit reported zero vulnerabilities. |

## Executed checks

The final Node.js 24 app image passed 89 tests with zero failures and two opt-in tests skipped. The host regression run enabled the actual PHP Docker fixture and passed 90 tests with zero failures and one Mailpit test skipped. The separate Mailpit integration passed. The isolated Docker browser suite passed all ten workflows: six role logins, owner marketplace entry, free buyer signup through delivered credentials and room entry, direct media/recording, and OBS playback/stop.

Earlier original-interface browser checks exercised room title persistence, chat, alerts, polls and inline image upload. These are distinct from a full screenshot or every-setting comparison. Detailed commands, final runtime checks and image/source hashes are recorded in [the verification manifest](../contracts/verification.json).

The repository separates maintained code, captured clients, provenance/contracts, integrations, tests, scripts and operator documentation. Git excludes `.env`, generated credentials, database/media volumes, dependencies and browser artifacts. The account file is private and has mode 0600. CI runs source checks, tests, an image build and isolated browser workflows. See [the migration handoff](migration.md).

## Remaining evidence and deployment limits

Identical original end-to-end parity is **not certified**. The implemented workflows are documented above, with these remaining limits:

- Real Stripe onboarding/payments/webhooks, PSTN calls, SMS/push delivery, X posts, external video streams and S3/Vimeo exports require credentials from their issuing accounts and live deployment verification. Local installation/account/API/SSO secrets have been generated; provider-issued credentials cannot be created offline.
- The original opaque legacy SSO token format, external SSH/cluster/repeater protocol, FCM custom mobile payload and webhook body were not captured. JWT SSO and local room media reset work; reconstructed provider adapters and webhook payloads are identified in their contracts.
- Native V5/mobile/Alerter source, binaries and complete pairing wire protocols are absent. Store metadata/screenshots do not establish native application parity. See [mobile evidence](../contracts/mobile-parity.json).
- All 268 captured controls are inventoried, but static references and generic persistence do not demonstrate every runtime effect. No full pixel-by-pixel or every-setting browser certification was performed. See [settings evidence](../contracts/settings-parity.json).
- Missing media were requested from the original hosts; recorded responses were empty or invalid media. They remain documented unavailable assets rather than fabricated replacements. See [asset probes](../contracts/assets-parity.json).
- Recording exports the primary video stream with mixed AudioBridge audio; it does not composite the entire application layout. Remote use still needs deployment-specific TLS, ICE/TURN, public media addresses and real-device verification.

Command-specific limitations remain in [REST status](../contracts/parity.json) and [realtime status](../contracts/realtime-parity.json). Passing local tests demonstrates the recorded implementation, not access to or proof of the original private backend.
