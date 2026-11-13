#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = process.cwd();
const artifacts = path.join(root, 'test-results');
const publishRequest = path.join(artifacts, 'obs-publish.json');
const image = 'mcr.microsoft.com/playwright:v1.65.0-noble';
let publisher;
let watcher;

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`Docker command failed with exit code ${result.status}`);
}

function startPublisher() {
  if (publisher || !fs.existsSync(publishRequest)) return;
  const request = JSON.parse(fs.readFileSync(publishRequest, 'utf8'));
  const supplied = new URL(request.url);
  if (
    supplied.protocol !== 'rtmp:' ||
    !['localhost', '127.0.0.1'].includes(supplied.hostname) ||
    !/^\/live\/[A-Za-z0-9_-]{40,80}$/.test(supplied.pathname) ||
    supplied.search ||
    supplied.hash
  ) {
    throw new Error('The browser supplied an invalid local OBS test address.');
  }
  const target = 'rtmp://rtmp:1935' + supplied.pathname;
  publisher = spawn(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'media-processor',
      'ffmpeg',
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-re',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '120',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '10',
      '-c:a',
      'aac',
      '-f',
      'flv',
      target,
    ],
    { cwd: root, stdio: 'ignore' },
  );
  publisher.on('error', () => {
    process.exitCode = 1;
  });
}

try {
  if (!fs.existsSync(path.join(root, '.env'))) {
    const setup = spawnSync(process.execPath, ['scripts/setup-local.mjs'], { stdio: 'inherit' });
    if (setup.status !== 0) throw new Error('Local environment setup failed.');
  }
  fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  fs.rmSync(publishRequest, { force: true });
  docker(['compose', 'up', '--build', '-d'], { env: { ...process.env, ENABLE_LOCAL_QA: '1' } });
  docker(['compose', 'exec', '-T', 'app', 'node', 'scripts/provision-accounts.cjs']);
  const container = spawnSync('docker', ['compose', 'ps', '-q', 'app'], {
    encoding: 'utf8',
  }).stdout.trim();
  if (!container) throw new Error('The application container is unavailable.');
  watcher = setInterval(() => {
    try {
      startPublisher();
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      clearInterval(watcher);
    }
  }, 100);
  const mounts = [
    [path.join(root, 'node_modules'), '/work/node_modules', 'ro'],
    [path.join(root, 'test/browser'), '/work/test/browser', 'ro'],
    [path.join(root, 'playwright.config.js'), '/work/playwright.config.js', 'ro'],
    [path.join(root, 'package.json'), '/work/package.json', 'ro'],
    [artifacts, '/work/test-results', 'rw'],
  ].flatMap(([source, target, mode]) => ['-v', `${source}:${target}:${mode}`]);
  const browser = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      `container:${container}`,
      '--shm-size=1g',
      ...mounts,
      '-v',
      'ptr-parity_app-data:/app/data:ro',
      '-w',
      '/work',
      image,
      'node',
      'node_modules/@playwright/test/cli.js',
      'test',
      ...process.argv.slice(2),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  const exitCode = await new Promise((resolve, reject) => {
    browser.once('error', reject);
    browser.once('exit', resolve);
  });
  process.exitCode = exitCode || process.exitCode || 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(watcher);
  if (publisher && publisher.exitCode === null) publisher.kill('SIGTERM');
  fs.rmSync(publishRequest, { force: true });
  try {
    docker(['compose', 'up', '-d', 'app'], { env: { ...process.env, ENABLE_LOCAL_QA: '0' } });
  } catch {
    process.exitCode = 1;
  }
}
