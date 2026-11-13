// Inventory the original client's literal command and event names for review.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const source = readFileSync(new URL('../contracts/reference/app.min.js', import.meta.url), 'utf8');
const collect = (pattern) => [...new Set([...source.matchAll(pattern)].map((m) => m[1]))].sort();
const contract = {
  outboundSocketCommands: collect(/\.send\("([^"\\]+)"\s*,/g),
  switchCases: collect(/case"([^"\\]+)"\s*:/g),
  restPaths: collect(/"(\/users\/v1\/[^"\\]+)"/g),
  note: 'Literal inventory: switch cases and send calls include non-protocol uses. Verify each in context.',
};
mkdirSync(new URL('../contracts/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../contracts/client-inventory.json', import.meta.url),
  JSON.stringify(contract, null, 2) + '\n',
);
