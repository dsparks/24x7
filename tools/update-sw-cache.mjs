#!/usr/bin/env node
/* Rewrites the CACHE name in sw.js to a content hash of every precached shell
 * file (plus sw.js's own logic), so a forgotten manual version bump can never
 * strand installed clients on a stale shell. Run manually or via the pre-commit
 * hook in .githooks/ (enable once with: git config core.hooksPath .githooks).
 *
 * Usage: node tools/update-sw-cache.mjs [--check]
 *   --check  exit 1 if sw.js is out of date instead of rewriting it
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const swPath = join(root, 'sw.js');
const sw = readFileSync(swPath, 'utf8');

const shellMatch = sw.match(/const SHELL = \[([\s\S]*?)\];/);
if (!shellMatch) { console.error('update-sw-cache: could not find SHELL list in sw.js'); process.exit(1); }
const files = [...shellMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]).filter(f => f !== '.');

const hash = createHash('sha256');
for (const f of files.sort()){
  try { hash.update(f).update('\0').update(readFileSync(join(root, f))); }
  catch (err) { console.error(`update-sw-cache: shell file missing: ${f}`); process.exit(1); }
}
// Include sw.js's own logic (minus the CACHE line) so fetch-strategy changes roll too.
hash.update(sw.replace(/const CACHE = '[^']*';/, ''));

const name = `grid-${hash.digest('hex').slice(0, 10)}`;
const updated = sw.replace(/const CACHE = '[^']*';/, `const CACHE = '${name}';`);
if (updated === sw){
  console.log(`sw.js cache name already current (${name})`);
  process.exit(0);
}
if (process.argv.includes('--check')){
  console.error(`sw.js cache name is stale — run: node tools/update-sw-cache.mjs`);
  process.exit(1);
}
writeFileSync(swPath, updated);
console.log(`sw.js cache name -> ${name}`);
