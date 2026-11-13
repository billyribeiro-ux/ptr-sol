#!/usr/bin/env node
// Dependency-free, lossless source/asset export. Node.js 24+.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const format = 'ptr-app-snapshot-v1';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const generated = new Set([
  '.git',
  'node_modules',
  '.runtime',
  'test-results',
  'playwright-report',
  'coverage',
  '__pycache__',
  '.DS_Store',
  '.agents',
  '.codex',
  '.aws',
]);
const privateName = (name) =>
  name === 'secrets' || name === 'data' || (name.startsWith('.env') && name !== '.env.example');

function usage() {
  console.log(`Usage:
  node scripts/app-json.mjs export OUTPUT.json [--include-private] [--reference DIRECTORY]
  node scripts/app-json.mjs verify INPUT.json
  node scripts/app-json.mjs restore INPUT.json EMPTY_DIRECTORY

Exports this checkout, including source, binary assets, Docker configuration,
tests, specs and contracts. Dependencies are restored using package-lock.json.
--reference also includes an original capture directory under _original_capture/.
--include-private includes host .env, secrets/ and data/ (sensitive).
Git history, dependencies, caches and generated test artifacts are excluded.
Docker volumes are NOT included. This cannot recover an original private backend.`);
}

async function exportApp(output, options) {
  const outputPath = path.resolve(output);
  const files = [];
  const excluded = new Set();
  async function walk(directory, prefix = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix + entry.name;
      if (absolute === outputPath) continue;
      if (
        generated.has(entry.name) ||
        /\.(?:log|pyc)$/.test(entry.name) ||
        (!options.private && privateName(entry.name))
      ) {
        excluded.add(relative);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative + '/');
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(absolute);
        const text = bytes.toString('utf8');
        const encoding =
          Buffer.from(text, 'utf8').equals(bytes) && !bytes.includes(0) ? 'utf8' : 'base64';
        const stat = await fs.stat(absolute);
        files.push({
          path: relative,
          encoding,
          size: bytes.length,
          sha256: hash(bytes),
          mode: stat.mode & 0o777,
          content: encoding === 'utf8' ? text : bytes.toString('base64'),
        });
      } else {
        throw new Error(`Cannot safely export special file or symlink: ${relative}`);
      }
    }
  }
  await walk(root);
  if (options.reference) {
    const reference = await fs.realpath(options.reference);
    if (reference === root || reference.startsWith(root + path.sep)) {
      throw new Error('--reference must be outside this checkout');
    }
    if (files.some((file) => file.path.startsWith('_original_capture/'))) {
      throw new Error('Reserved path _original_capture/ already exists in checkout');
    }
    await walk(reference, '_original_capture/');
  }
  const snapshot = {
    format,
    createdAt: new Date().toISOString(),
    includesPrivateFiles: options.private,
    dockerVolumesIncluded: false,
    excluded: [...excluded].sort(),
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
    files,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  // Exclusive creation prevents accidentally replacing another export.
  await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(
    `Exported ${files.length} files (${snapshot.totalBytes} source bytes) to ${outputPath}`,
  );
  console.log(`JSON SHA-256: ${hash(await fs.readFile(outputPath))}`);
  console.log('Docker database, uploads and recordings in named volumes are not included.');
}

async function readSnapshot(input) {
  const snapshot = JSON.parse(await fs.readFile(input, 'utf8'));
  if (snapshot.format !== format || !Array.isArray(snapshot.files)) {
    throw new Error('Unsupported snapshot format');
  }
  if (snapshot.fileCount !== snapshot.files.length) throw new Error('File count mismatch');
  const names = new Set();
  let totalBytes = 0;
  for (const file of snapshot.files) {
    if (
      typeof file.path !== 'string' ||
      !file.path ||
      file.path.includes('\\') ||
      file.path.includes('\0') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      /^[A-Za-z]:/.test(file.path) ||
      names.has(file.path)
    ) {
      throw new Error(`Unsafe or duplicate snapshot path: ${file.path}`);
    }
    names.add(file.path);
    if (!['utf8', 'base64'].includes(file.encoding) || typeof file.content !== 'string') {
      throw new Error(`Invalid encoding: ${file.path}`);
    }
    const bytes = Buffer.from(file.content, file.encoding);
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) {
      throw new Error(`Integrity check failed: ${file.path}`);
    }
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      throw new Error(`Invalid permissions: ${file.path}`);
    }
    totalBytes += bytes.length;
  }
  if (totalBytes !== snapshot.totalBytes) throw new Error('Total byte count mismatch');
  // Reject file/directory collisions before creating any output.
  for (const name of names) {
    const parts = name.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (names.has(parts.join('/'))) throw new Error(`Conflicting paths: ${name}`);
    }
  }
  return snapshot;
}

async function restoreApp(input, destination) {
  const snapshot = await readSnapshot(input);
  const target = path.resolve(destination);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.readdir(target)).length) {
      throw new Error('Restore destination must be an empty directory, not a symlink');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const file of snapshot.files) {
    const output = path.join(target, ...file.path.split('/'));
    await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fs.writeFile(output, Buffer.from(file.content, file.encoding), {
      flag: 'wx',
      mode: file.mode,
    });
    await fs.chmod(output, file.mode);
  }
  console.log(`Restored and verified ${snapshot.files.length} files to ${target}`);
  console.log('Start: npm ci && npm run setup && npm run docker:up && npm run accounts:provision');
}

try {
  const [command, input, ...args] = process.argv.slice(2);
  if (!command || command === '--help') usage();
  else if (command === 'export' && input) {
    const options = { private: false, reference: null };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--include-private') options.private = true;
      else if (args[i] === '--reference' && args[i + 1]) options.reference = args[++i];
      else throw new Error(`Unknown or incomplete option: ${args[i]}`);
    }
    await exportApp(input, options);
  } else if (command === 'verify' && input && !args.length) {
    const snapshot = await readSnapshot(input);
    console.log(`Verified all ${snapshot.files.length} files and SHA-256 checksums`);
  } else if (command === 'restore' && input && args.length === 1) {
    await restoreApp(input, args[0]);
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
