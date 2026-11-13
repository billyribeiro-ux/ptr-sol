#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean);
const errors = [];
const forbidden = /^(?:node_modules|data|secrets|test-results|playwright-report|coverage)\//;
for (const file of tracked) {
  if (forbidden.test(file) || (/^\.env(?:\.|$)/.test(file) && file !== '.env.example')) {
    errors.push(`${file} contains runtime or private data and must be removed from the Git index.`);
  }
}
const sensitivePatterns = [
  [
    'private key',
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{40,}-----END/,
  ],
  ['GitHub access token', /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['Stripe live secret', /\bsk_live_[A-Za-z0-9]{20,}\b/],
  ['RapidAPI credential', /["']x-rapidapi-key["']\s*:\s*["'][A-Za-z0-9_-]{30,}["']/i],
];
for (const file of new Set(files)) {
  const full = path.join(root, file);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  const size = fs.statSync(full).size;
  if (size >= 100 * 1024 * 1024) errors.push(`${file} exceeds GitHub's regular file size limit.`);
  const content = fs.readFileSync(full);
  if (content.includes(0)) continue;
  const text = content.toString('utf8');
  for (const [kind, expression] of sensitivePatterns) {
    if (expression.test(text)) errors.push(`${file} contains a possible ${kind}.`);
  }
}
const metadata = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (metadata.private !== true) errors.push('The application package must remain private.');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Repository checks passed for ${new Set(files).size} indexed and unignored files.`);
}
