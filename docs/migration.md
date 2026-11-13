# Migration handoff

Keep this checkout runnable as the reference while replacing the stack. The captured clients and contract files describe the external interface; the tests document the reconstructed behavior and its authorization boundaries. The original private backend was not recovered.

| Boundary | Reference |
| --- | --- |
| HTTP routes, envelopes and commands | `contracts/client-inventory.json`, `contracts/parity.json`, `src/routes/` |
| Room events and authoritative socket identity | `contracts/realtime-parity.json`, `src/realtime/sockjs.js` |
| Account ownership, delegated access and room roles | `src/middleware/auth.js`, `scripts/provision-accounts.cjs`, `test/provision.test.js` |
| Persisted schema and additive upgrades | `src/db/database.js`; service-owned realtime tables in `src/services/` |
| Public and internal room identifiers | `src/services/room-ids.js`, serializers, REST and stats tests |
| Marketplace, course entitlement and billing lifecycle | `src/routes/marketplace.js`, `src/routes/courses.js`, `src/services/stripe.js`, marketplace tests |
| Media, recording and stream control | `src/services/media.js`, recording and relay services, `docker/` |
| Original asset provenance and unavailable assets | `contracts/marketplace-capture.json`, `contracts/assets-parity.json`, `contracts/reference/` |

The application state lives in the Compose `app-data` volume: `prt.sqlite`, uploads, recording sources and processed media, and the private provisioned credential file. Mailpit uses a separate `mail-data` volume. Preserve `.env` and the private credential copy separately from Git. Stop application writers before taking a consistent volume backup, or use SQLite's backup facilities for the database and coordinate file copies. Do not use `docker compose down -v` when retaining state.

Preserve both the 24-hex internal room ID and public numeric room UUID. Keep ownership and delegation separate from global administration. Room membership, bans, expiry, API endpoint restrictions, paid course access, single-use password resets, and billing webhook signature/idempotency checks must remain authoritative on the server.

The media services can remain under Docker while the application stack changes. Their internal credentials and APIs must stay private. The WordPress integration is installed separately from the app image. External provider credentials belong to their issuer accounts and are configured per deployment.

Run the API/security/provider tests and isolated browser suite against each migration step. Update the executed verification manifest after running checks. Preserve the distinctions between captured facts, reconstructed provider contracts, mocked delivery, and actual browser/media evidence; see [the audit](audit.md) for outstanding verification limits.
