#!/usr/bin/env node
/**
 * generate-sri-hashes.mjs
 *
 * Regenerates the committed filter-list lock file used by build-rules.mjs for
 * Subresource Integrity verification.
 *
 * The hash covers the FULLY-EXPANDED list text — the same
 * fetchAndExpand() output the build compiles — so !#include sub-files (where
 * uBO lists carry most of their content) are covered, and redirects are
 * required to stay on https. Hashing only the top-level file, as an earlier
 * version of this script did, verified almost nothing.
 *
 * Workflow:
 *   1. node scripts/generate-sri-hashes.mjs
 *   2. Review the diff of scripts/filter-lists.lock.json
 *   3. Commit it — a non-sample build FAILS on any list with no pinned hash
 *      or a mismatching hash (upstream lists update frequently, so regenerate
 *      the lock as the first step of a rules refresh).
 *
 * Output: scripts/filter-lists.lock.json
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { fetchAndExpand, FILTER_LISTS } from './build-rules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = path.join(__dirname, 'filter-lists.lock.json');

async function main() {
  console.log('[SRI] Generating Subresource Integrity hashes for filter lists (fully-expanded text)...\n');

  const hashes = {};
  let successCount = 0;
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
      console.log(`✓ ${list.id}: ${hash.slice(0, 24)}...`);
      successCount++;
    } catch (err) {
      console.error(`✗ ${list.id}: ${err.message}`);
      failCount++;
    }
  }

  if (failCount > 0) {
    // Fail closed without touching the existing lock: a partial lock would
    // make the next build fail on the missing entries anyway, but silently
    // replacing reviewed hashes on a flaky network helps no one.
    console.error(`\n[SRI] ${failCount} list(s) failed — lock file NOT updated`);
    process.exit(1);
  }

  fs.writeFileSync(LOCK_FILE, JSON.stringify(hashes, null, 2) + '\n');
  console.log(`\n[SRI] Lock file written to ${LOCK_FILE}`);
  console.log(`[SRI] Complete: ${successCount} hashed. Review and commit the lock file.`);
}

main().catch((err) => {
  console.error('[SRI] Fatal error:', err);
  process.exit(1);
});
