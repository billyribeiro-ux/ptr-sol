import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) {
  console.log(
    'Existing .env preserved. Ensure JANUS_API_SECRET, JANUS_ADMIN_SECRET and MEDIA_PROCESSOR_TOKEN are configured.',
  );
} else {
  const secret = () => randomBytes(32).toString('hex');
  writeFileSync(
    '.env',
    `APP_PORT=3031\nPUBLIC_ORIGIN=http://localhost:3031\nJWT_SECRET=${secret()}\nJANUS_API_SECRET=${secret()}\nJANUS_ADMIN_SECRET=${secret()}\nMEDIA_PROCESSOR_TOKEN=${secret()}\nJANUS_PUBLIC_IP=127.0.0.1\nJANUS_UDP_MIN=20100\nJANUS_UDP_MAX=20199\nMAIL_UI_PORT=8026\n`,
    { mode: 0o600 },
  );
  console.log('Created private .env for the local Docker stack.');
}
