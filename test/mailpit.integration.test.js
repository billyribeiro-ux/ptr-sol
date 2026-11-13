const { test } = require('node:test');
const assert = require('node:assert/strict');

test(
  'local Mailpit reset, invite, and contact delivery',
  { skip: process.env.PTR_MAILPIT_INTEGRATION !== '1' },
  async () => {
    const app = 'http://127.0.0.1:3031',
      inbox = 'http://127.0.0.1:8026';
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const owner = `owner-${suffix}@example.test`,
      guest = `guest-${suffix}@example.test`,
      registrant = `registration-${suffix}@example.test`,
      batch = `batch-${suffix}@example.test`;
    async function post(path, body, token) {
      const response = await fetch(app + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    }
    async function findMessage(email, subject) {
      const list = await (await fetch(inbox + '/api/v1/messages?limit=100')).json();
      const message = list.messages.find(
        (m) => m.Subject === subject && m.To.some((t) => t.Address === email),
      );
      assert.ok(message, `Missing ${subject} to ${email}`);
      return (await (await fetch(inbox + '/api/v1/message/' + message.ID)).json()).Text;
    }
    const signup = await post('/users/v1/signup', {
      name: 'Mail Test',
      email: owner,
      pw: 'testpassword123',
    });
    assert.equal(signup.data.success, true);
    assert.equal((await post('/users/v1/forgot-password', { email: owner })).data.success, true);
    const body = await findMessage(owner, 'Password reset');
    const token = body.match(/change-password\/([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(token);
    assert.equal(
      (await post('/users/v1/change-password', { userUUID: token, passNew: 'changedpassword123' }))
        .data.success,
      true,
    );
    assert.equal(
      (await post('/users/v1/change-password', { userUUID: token, passNew: 'changedpassword123' }))
        .data.success,
      false,
    );
    const login = await post('/users/v1/login', { email: owner, pw: 'changedpassword123' });
    assert.equal(login.data.success, true);
    const invite = await post(
      '/users/v1/sessions',
      {
        cmd: 'inviteUsers',
        sessionID: signup.data.roomUUID,
        persons: [{ name: 'Guest', email: guest }],
      },
      login.data.token,
    );
    assert.equal(invite.data.success, true);
    await findMessage(guest, "Invitation to Mail Test's Room");
    const users = await post(
      '/users/v1/sessions',
      { cmd: 'userList', sessionID: signup.data.roomUUID },
      login.data.token,
    );
    const guestId = users.data.xrefs.find((x) => x.email === guest)?._id;
    assert.ok(guestId);
    const welcome = await post(
      '/ptr_app/mp/v2/resend-welcome-email',
      { sessionId: signup.data.roomUUID, xrefId: guestId },
      login.data.token,
    );
    assert.equal(welcome.data.success, true);
    await findMessage(guest, 'Your room login');
    await post(
      '/users/v1/sessions',
      {
        cmd: 'saveSessField',
        sessionID: signup.data.roomUUID,
        fieldName: 'authMode',
        fieldVal: 'registrationA',
      },
      login.data.token,
    );
    const registration = await post('/users/v1/users.json', {
      cmd: 'registerByEmail',
      roomID: signup.data.roomUUID,
      name: 'Registrant',
      email: registrant,
    });
    assert.equal(registration.data.success, true);
    const registrationMail = await findMessage(registrant, "Registration for Mail Test's Room");
    const registrationToken = registrationMail.match(/user-change-password\/([A-Za-z0-9_-]+)/)?.[1];
    assert.ok(registrationToken);
    assert.equal(
      (
        await post('/users/v1/user-change-password', {
          userUUID: registrationToken,
          passNew: 'participantpassword123',
        })
      ).data.success,
      true,
    );
    const batchInvite = await post(
      '/users/v1/sessions',
      { cmd: 'inviteBatchUsers', sessionID: signup.data.roomUUID, batchEmailsList: [batch] },
      login.data.token,
    );
    assert.equal(batchInvite.data.success, true);
    await findMessage(batch, "Invitation to Mail Test's Room");
    const reminders = await post(
      '/users/v1/sessions',
      { cmd: 'emailReminders', sessionID: signup.data.roomUUID, webinarDate: '7pm ET' },
      login.data.token,
    );
    assert.equal(reminders.data.success, true);
    assert.ok(reminders.data.sent >= 3);
    await findMessage(registrant, "Reminder: Mail Test's Room");

    assert.equal(
      (
        await post('/users/v1/p/contact', {
          fname: 'Test Person',
          email: owner,
          msg: 'Local test message',
        })
      ).data.success,
      true,
    );
    await findMessage('contact@example.test', 'Contact request');
  },
);
