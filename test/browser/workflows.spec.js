const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const credentials = JSON.parse(
  fs.readFileSync(
    process.env.ACCOUNT_CREDENTIALS_FILE || '/app/data/provisioned-accounts.json',
    'utf8',
  ),
);

async function restrictNetwork(context) {
  await context.route('**/*', (route) => {
    const hostname = new URL(route.request().url()).hostname;
    return ['localhost', '127.0.0.1'].includes(hostname) ? route.continue() : route.abort();
  });
}

for (const [role, roomName] of [
  ['businessOwner', 'Business Owner Room'],
  ['enterpriseOwner', 'Enterprise Room'],
  ['delegatedAdmin', 'Enterprise Room'],
]) {
  test(`${role} signs in through the original owner portal`, async ({ page, context }) => {
    await restrictNetwork(context);
    const account = credentials.accounts[role];
    await page.goto('/ptrApp#/page/welcome');
    await page.getByPlaceholder('Your email', { exact: true }).fill(account.email);
    await page.getByPlaceholder('Your password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await expect(page.getByRole('cell', { name: roomName, exact: true })).toBeVisible();
    const otherRoom = role === 'businessOwner' ? 'Enterprise Room' : 'Business Owner Room';
    await expect(page.getByRole('cell', { name: otherRoom, exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Manage/ }).first()).toBeVisible();
  });
}

for (const role of ['roomAdmin', 'presenter', 'participant']) {
  test(`${role} enters its room through the original login form`, async ({ page, context }) => {
    await restrictNetwork(context);
    const account = credentials.accounts[role];
    await page.goto(`/u/${credentials.rooms.enterprise.id}`);
    await page.getByPlaceholder('Your Nick/Name').fill(account.name);
    await page.getByPlaceholder('Your Email', { exact: true }).fill(account.email);
    await page.getByPlaceholder('Password', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect(page.getByPlaceholder(/Type your message here/)).toBeVisible();
    if (role === 'participant') {
      await expect(page.getByRole('link', { name: /Post Alert/ })).toHaveCount(0);
    } else {
      await expect(page.getByRole('link', { name: /Post Alert/ })).toBeVisible();
    }
  });
}

test('owner opens the recovered marketplace through its normal portal action', async ({
  page,
  context,
}) => {
  await restrictNetwork(context);
  const account = credentials.accounts.businessOwner;
  await page.goto('/ptrApp#/page/welcome');
  await page.getByPlaceholder('Your email', { exact: true }).fill(account.email);
  await page.getByPlaceholder('Your password', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Business Owner Room', exact: true })).toBeVisible();
  const popupPromise = page.waitForEvent('popup');
  await page.getByText('Marketplace', { exact: true }).click();
  const marketplace = await popupPromise;
  await expect(marketplace).toHaveURL(/\/mp\/room-dashboard\//);
  await expect(marketplace.getByText('Membership Plans', { exact: true })).toBeVisible();
  await expect(marketplace.getByText('Business Owner Room', { exact: true }).first()).toBeVisible();
});

async function observeConnections(page) {
  await page.addInitScript(() => {
    window.__qaPeers = [];
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeerConnection {
      constructor(...args) {
        super(...args);
        window.__qaPeers.push(this);
      }
    };
  });
}

async function expectMediaPass(page) {
  await expect(page.locator('#result')).toHaveText(/^(PASS|FAIL)/, { timeout: 100_000 });
  const result = await page.locator('#result').textContent();
  if (result.startsWith('PASS')) return;
  const log = await page.locator('#log').textContent();
  const peers = await page.evaluate(async () =>
    Promise.all(
      window.__qaPeers.map(async (pc) => {
        const reports = [...(await pc.getStats()).values()].filter((r) => r.type === 'inbound-rtp');
        return {
          connection: pc.connectionState,
          ice: pc.iceConnectionState,
          transceivers: pc.getTransceivers().map((t) => ({
            direction: t.direction,
            currentDirection: t.currentDirection,
            track: t.receiver.track.kind,
            state: t.receiver.track.readyState,
          })),
          inbound: reports.map((r) => ({
            kind: r.kind,
            packets: r.packetsReceived,
            frames: r.framesDecoded,
          })),
        };
      }),
    ),
  );
  throw new Error(`${result}\n${log}\n${JSON.stringify(peers, null, 2)}`);
}

test('synthetic Janus media and processed recording play in the browser', async ({
  page,
  context,
}) => {
  await restrictNetwork(context);
  await observeConnections(page);
  await page.goto('/__qa/media');
  await page.getByRole('button', { name: 'Run verification' }).click();
  await expectMediaPass(page);
});

test('OBS media plays through the authorized Janus streaming mount and stops', async ({
  page,
  context,
}) => {
  await restrictNetwork(context);
  await observeConnections(page);
  await page.goto('/__qa/obs');
  await page.getByRole('button', { name: 'Prepare OBS verification' }).click();
  await expect(page.getByLabel('Temporary local OBS publish URL')).toHaveValue(/^rtmp:/);
  const url = await page.getByLabel('Temporary local OBS publish URL').inputValue();
  fs.writeFileSync(path.resolve('test-results/obs-publish.json'), JSON.stringify({ url }), {
    mode: 0o600,
  });
  await expectMediaPass(page);
});

test('a buyer selects a published free membership and receives room access', async ({
  page,
  context,
}) => {
  await restrictNetwork(context);
  const suffix = require('node:crypto').randomUUID().slice(0, 10);
  const owner = await (
    await context.request.post('/users/v1/signup', {
      data: {
        name: 'Marketplace QA',
        email: `market-owner-${suffix}@example.test`,
        pw: `Test-${suffix}-password`,
      },
    })
  ).json();
  expect(owner.success).toBe(true);
  const headers = { authorization: `Bearer ${owner.token}` };
  const listing = await (
    await context.request.post('/ptr_app/mp/v2/', {
      headers,
      data: { sessionID: owner.roomUUID, title: `Browser free room ${suffix}` },
    })
  ).json();
  const planName = `Free browser membership ${suffix}`;
  const planResponse = await context.request.post(`/ptr_app/mp/v2/${listing._id}/memberships`, {
    headers,
    data: { planName, isFree: true, amount: 0, currency: 'usd', isActive: true },
  });
  expect(planResponse.ok()).toBe(true);
  expect(
    (
      await context.request.put(`/ptr_app/mp/v2/${listing._id}/published`, {
        headers,
        data: { published: true },
      })
    ).ok(),
  ).toBe(true);
  await context.clearCookies();
  await page.goto(`/mp/marketplace/${listing._id}`);
  await page.getByText(planName, { exact: true }).click();
  await page.getByRole('button', { name: 'Subscribe', exact: true }).click();
  await expect(page).toHaveURL(/\/mp\/subscription/);
  await page.getByLabel('Full name').fill('Browser Free Buyer');
  await page.getByLabel('Email address').fill(`market-buyer-${suffix}@example.test`);
  await page.locator('#termsCheck').check();
  await page.getByRole('button', { name: 'Get access', exact: true }).click();
  await expect(
    page.getByText('Access granted! Check your email for details.', { exact: true }),
  ).toBeVisible();
  const inbox = await (
    await context.request.get('http://mailpit:8025/api/v1/messages?limit=100')
  ).json();
  const message = inbox.messages.find((item) =>
    item.To.some((to) => to.Address === `market-buyer-${suffix}@example.test`),
  );
  expect(message).toBeTruthy();
  const mail = await (
    await context.request.get(`http://mailpit:8025/api/v1/message/${message.ID}`)
  ).json();
  const reset = mail.Text.match(/user-change-password\/([A-Za-z0-9_-]+)/)?.[1];
  expect(reset).toBeTruthy();
  expect(mail.Text).toContain(`/u/${owner.roomUUID}`);
  await page.goto(`/ptrApp#/page/user-change-password/${reset}`);
  const password = `Buyer-${suffix}-password`;
  await page.getByPlaceholder('Your new password', { exact: true }).fill(password);
  await page.getByPlaceholder('Type your new password again', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Change Password', exact: true }).click();
  await expect(page.getByText('Password updated.', { exact: true })).toBeVisible();
  await page.goto(`/u/${owner.roomUUID}`);
  await page.getByPlaceholder('Your Nick/Name').fill('Browser Free Buyer');
  await page
    .getByPlaceholder('Your Email', { exact: true })
    .fill(`market-buyer-${suffix}@example.test`);
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await expect(page.getByPlaceholder(/Type your message here/)).toBeVisible();
});
