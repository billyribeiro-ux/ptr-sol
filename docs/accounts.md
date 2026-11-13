# Accounts and credentials

Run `npm run accounts:provision` after starting Docker. The command creates and verifies the captured account and room roles. Passwords and integration secrets are generated randomly and stored in the Docker data volume at `/app/data/provisioned-accounts.json` with mode 0600.

To keep a private local copy, run the following from the repository root.

```sh
mkdir -p secrets
chmod 700 secrets
docker compose cp app:/app/data/provisioned-accounts.json secrets/accounts.json
chmod 600 secrets/accounts.json
```

The `secrets/` directory is excluded from Git and Docker build contexts. Open `secrets/accounts.json` locally to read the passwords, login URLs, room identifiers, scoped API credentials, and WordPress JWT signing secrets.

| Credential | Login | Access |
| --- | --- | --- |
| Business owner | `/ptrApp#/page/welcome` | Business account and its rooms |
| Enterprise owner | `/ptrApp#/page/welcome` | Enterprise account and its rooms |
| Delegated admin | `/ptrApp#/page/welcome` | Delegated enterprise room administration |
| Room admin | Room URL from the credential file | Room moderation with presentation disabled |
| Presenter | Room URL from the credential file | Room presentation and moderation |
| Participant | Room URL from the credential file | Participant features and granted access |

The captured enterprise portal uses account owners and delegated admins. Provisioning creates two isolated owners for the business and enterprise scenarios. Each owner receives its local plan entitlement. Stripe subscription state is recorded from verified provider events.

Each owner also receives a read-only API key scoped to its room and a room JWT signing secret for the captured WordPress shortcode. The existing room login mode remains username/password until the owner configures JWT SSO. WordPress setup is documented in `integrations/wordpress/README.md`.

Rerunning provisioning preserves existing passwords. It checks account identity and permissions, API key scope, and signing secrets. It stops with an error when an operator has changed or revoked an integration credential, so a provisioning rerun cannot silently restore a revoked key.
