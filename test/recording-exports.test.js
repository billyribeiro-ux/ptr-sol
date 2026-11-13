const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-exports-'));
process.env.DATA_DIR = tmp;
const { exportRecording, pauseRoom, resumeRoom } = require('../src/services/recording-exports');
const root = path.join(tmp, 'recordings');
fs.mkdirSync(root);
const content = Buffer.from('representative processed recording');
fs.writeFileSync(path.join(root, 'clip.mp4'), content);
const rec = {
  id: 'rec-123',
  room_id: 'room-123',
  status: 'ready',
  file_path: 'clip.mp4',
  mime_type: 'video/mp4',
  title: 'Test recording',
};
const cfg = {
  recordingsDir: root,
  enabled: true,
  s3Region: 'us-east-1',
  now: () => new Date('2025-03-01T12:00:00Z'),
};
const settings = {
  saveRecsToS3: true,
  s3KeyID: 'AKIDEXAMPLE',
  s3KeySecret: 'secret-key-example',
  s3Bucket: 'example-bucket',
  s3BucketFolderPath: 'reports/daily',
};
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
async function body(request) {
  const chunks = [];
  for await (const c of request.body) chunks.push(c);
  return Buffer.concat(chunks);
}
test('disabled by default and explicit opt-in requires an exact boolean room setting', async () => {
  let calls = 0;
  const opts = {
    enabled: false,
    recordingsDir: root,
    fetch: async () => {
      calls++;
      throw Error('unexpected');
    },
  };
  assert.deepEqual(await exportRecording({ ...rec, file_path: 'missing' }, settings, opts), {
    enabled: false,
    results: [{ provider: 's3', status: 'disabled' }],
  });
  assert.deepEqual(
    await exportRecording(rec, { ...settings, saveRecsToS3: 'false' }, { ...opts, enabled: true }),
    { enabled: true, results: [] },
  );
  assert.equal(calls, 0);
});
test('S3 uses signed HTTPS PUT and a safe object key without exposing credentials', async () => {
  let sent;
  const out = await exportRecording(rec, settings, {
    ...cfg,
    fetch: async (url, request) => {
      sent = { url, request, content: await body(request) };
      return { ok: true, status: 200 };
    },
  });
  assert.equal(out.results[0].status, 'complete');
  assert.equal(out.results[0].remote.key, 'reports/daily/rec-123.mp4');
  assert.equal(
    sent.url,
    'https://s3.us-east-1.amazonaws.com/example-bucket/reports/daily/rec-123.mp4',
  );
  assert.equal(sent.request.method, 'PUT');
  assert.deepEqual(sent.content, content);
  assert.equal(
    sent.request.headers['x-amz-content-sha256'],
    crypto.createHash('sha256').update(content).digest('hex'),
  );
  assert.match(
    sent.request.headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20250301\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
  assert.doesNotMatch(JSON.stringify(out), /secret-key-example|AKIDEXAMPLE/);
});
test('Vimeo creates a private tus upload and assigns the configured folder', async () => {
  const calls = [];
  const out = await exportRecording(
    rec,
    { saveRecsToVimeo: true, vimeoToken: 'private-token', vimeoFolderPath: '1234' },
    {
      ...cfg,
      fetch: async (url, request) => {
        calls.push({ url, request });
        if (calls.length === 1)
          return {
            ok: true,
            json: async () => ({
              uri: '/videos/987',
              upload: { approach: 'tus', upload_link: 'https://uploads.vimeo.com/files/opaque' },
            }),
          };
        if (calls.length === 2) {
          assert.deepEqual(await body(request), content);
          return { ok: true, headers: new Headers({ 'upload-offset': String(content.length) }) };
        }
        if (calls.length === 3)
          return {
            ok: true,
            headers: new Headers({
              'upload-offset': String(content.length),
              'upload-length': String(content.length),
            }),
          };
        return { ok: true };
      },
    },
  );
  assert.equal(out.results[0].status, 'complete');
  assert.equal(calls[0].url, 'https://api.vimeo.com/me/videos');
  assert.equal(JSON.parse(calls[0].request.body).upload.size, String(content.length));
  assert.equal(JSON.parse(calls[0].request.body).privacy.view, 'nobody');
  assert.equal(calls[1].request.method, 'PATCH');
  assert.equal(calls[1].request.headers['tus-resumable'], '1.0.0');
  assert.equal(calls[2].request.method, 'HEAD');
  assert.equal(calls[3].url, 'https://api.vimeo.com/me/projects/1234/videos/987');
  assert.doesNotMatch(JSON.stringify(out), /private-token|opaque/);
});
test('provider failure and malicious upload URLs preserve the local file', async () => {
  let calls = 0;
  const a = await exportRecording(rec, settings, {
    ...cfg,
    fetch: async () => {
      throw Error('credential-bearing raw transport error');
    },
  });
  assert.equal(a.results[0].status, 'failed');
  assert.equal(a.results[0].error, 'Provider request failed');
  const b = await exportRecording(
    rec,
    { saveRecsToVimeo: true, vimeoToken: 'secret' },
    {
      ...cfg,
      fetch: async () => {
        calls++;
        return {
          ok: true,
          json: async () => ({
            uri: '/videos/2',
            upload: { approach: 'tus', upload_link: 'https://127.0.0.1/secret' },
          }),
        };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(b.results[0].status, 'failed');
  assert.equal(b.results[0].error, 'Invalid Vimeo upload URL');
  assert.deepEqual(fs.readFileSync(path.join(root, 'clip.mp4')), content);
  await assert.rejects(
    exportRecording({ ...rec, file_path: '../escape.mp4' }, settings, {
      ...cfg,
      fetch: async () => {
        throw Error('unexpected');
      },
    }),
    /Invalid recording path/,
  );
});

test('room deletion can pause only idle exports and blocks new operations', async () => {
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const request = exportRecording(rec, settings, {
    ...cfg,
    fetch: async (url, request) => {
      await body(request);
      started();
      await new Promise((resolve) => {
        release = resolve;
      });
      return { ok: true, status: 200 };
    },
  });
  await ready;
  assert.equal(pauseRoom('room-123'), false);
  release();
  await request;
  assert.equal(pauseRoom('room-123'), true);
  assert.equal(pauseRoom('room-123'), false);
  await assert.rejects(
    exportRecording(rec, settings, {
      ...cfg,
      fetch: async () => {
        throw Error('must not run');
      },
    }),
    /Room export is unavailable/,
  );
  resumeRoom('room-123');
  assert.equal(pauseRoom('room-123'), true);
  resumeRoom('room-123');
});

test('canonicalizes recording root aliases and rejects symlink escapes', async () => {
  const alias = path.join(tmp, 'recordings-alias'),
    external = path.join(tmp, 'external.mp4');
  fs.symlinkSync(root, alias, 'dir');
  fs.writeFileSync(external, content);
  const out = await exportRecording({ ...rec, file_path: path.join(alias, 'clip.mp4') }, settings, {
    ...cfg,
    recordingsDir: alias,
    fetch: async (url, request) => {
      await body(request);
      return { ok: true, status: 200 };
    },
  });
  assert.equal(out.results[0].status, 'complete');
  fs.symlinkSync(external, path.join(root, 'escape.mp4'));
  await assert.rejects(
    exportRecording({ ...rec, file_path: 'escape.mp4' }, settings, cfg),
    /Invalid recording path/,
  );
});
