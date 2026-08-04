#!/usr/bin/env node
/**
 * generate-sri-hashes.mjs
 *
 * Refreshes the vendored filter-list snapshots AND the committed SRI lock they
 * are verified against. This is the ONLY script in the repo that fetches
 * upstream lists — `build:rules` compiles from what this writes.
 *
 * Both artifacts are written in the same pass, from the same bytes, so the
 * snapshot and its hash can never disagree:
 *
 *   scripts/filter-lists/<id>.txt      fully-expanded list text (committed)
 *   scripts/filter-lists.lock.json     sha384 of each snapshot   (committed)
 *
 * The hash covers the FULLY-EXPANDED list text — the same fetchAndExpand()
 * output the build compiles — so !#include sub-files (where uBO lists carry
 * most of their content) are covered, and redirects are required to stay on
 * https. Hashing only the top-level file, as an earlier version of this script
 * did, verified almost nothing.
 *
 * Workflow:
 *   1. npm run refresh:lists
 *   2. Review `git diff scripts/filter-lists/` — this is the one moment
 *      upstream content enters the repo. The lock diff alone tells you
 *      nothing; the text diff tells you what changed.
 *   3. npm run build:rules   (offline — compiles the reviewed snapshots)
 *   4. Commit the snapshots and the lock together.
 *
 * Why snapshots: builds used to verify the lock against a LIVE fetch, so a
 * release raced upstream rotation (measured: 6 of 8 lists rotated within ~48 h
 * of a lock refresh). Any list rotating between tag and build failed SRI and
 * killed the release. Rotation now only matters here, at review time (§4.6).
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { fetchAndExpand, FILTER_LISTS, VENDORED_LISTS_DIR, vendoredListPath } from './build-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = path.join(__dirname, 'filter-lists.lock.json');

async function main() {
  console.log('[lists] Fetching upstream filter lists (fully-expanded text)...\n');

  const hashes = {};
  const snapshots = new Map();
  let failCount = 0;

  for (const list of FILTER_LISTS) {
    try {
      const expanded = await fetchAndExpand(list.url);
      const hash = `sha384-${createHash('sha384').update(expanded, 'utf8').digest('base64')}`;
      hashes[list.id] = {
        url: list.url,
        sha384: hash,
        generatedAt: new Date().toISOString(),
      };
      snapshots.set(list.id, expanded);
      console.log(`✓ ${list.id}: ${(expanded.length / 1024).toFixed(0)} KiB  ${hash.slice(0, 24)}...`);
    } catch (err) {
      console.error(`✗ ${list.id}: ${err.message}`);
      failCount++;
    }
  }

  if (failCount > 0) {
    // Fail closed without touching the existing snapshots or lock: a partial
    // refresh would leave the repo compiling a mix of generations, and
    // silently replacing reviewed content on a flaky network helps no one.
    console.error(`\n[lists] ${failCount} list(s) failed — nothing written`);
    process.exit(1);
  }

  fs.mkdirSync(VENDORED_LISTS_DIR, { recursive: true });
  for (const [id, text] of snapshots) {
    fs.writeFileSync(vendoredListPath(id), text);
  }
  fs.writeFileSync(LOCK_FILE, JSON.stringify(hashes, null, 2) + '\n');

  console.log(`\n[lists] ${snapshots.size} snapshots written to ${VENDORED_LISTS_DIR}`);
  console.log(`[lists] Lock file written to ${LOCK_FILE}`);
  console.log('[lists] Review `git diff scripts/filter-lists/`, then run `npm run build:rules`.');
}

main().catch((err) => {
  console.error('[lists] Fatal error:', err);
  process.exit(1);
});
