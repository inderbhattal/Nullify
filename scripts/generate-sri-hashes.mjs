#!/usr/bin/env node
/**
 * generate-sri-hashes.mjs
 *
 * Generates Subresource Integrity (SRI) hashes for remote filter lists.
 * These hashes are used by build-rules.mjs to verify fetched content hasn't been tampered with.
 *
 * Usage:
 *   node scripts/generate-sri-hashes.mjs
 *
 * Output: rules/filter-list-hashes.json
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.resolve(__dirname, '../rules');
const HASHES_FILE = path.join(RULES_DIR, 'filter-list-hashes.json');

const FILTER_LISTS = [
  { id: 'easylist', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'easyprivacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { id: 'annoyances', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances.txt' },
  { id: 'malware', url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt' },
  { id: 'ubo-filters', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt' },
  { id: 'ubo-unbreak', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/unbreak.txt' },
  { id: 'anti-adblock', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt' },
  { id: 'ubo-cookie-annoyances', url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/annoyances-cookies.txt' },
];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'adblock-sri-generator/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function computeSha384(url) {
  const buffer = await fetchText(url);
  const hash = createHash('sha384').update(buffer).digest('base64');
  return `sha384-${hash}`;
}

async function main() {
  console.log('[SRI] Generating Subresource Integrity hashes for filter lists...\n');

  const hashes = {};
  let successCount = 0;
  let failCount = 0;

  for (const list of FILTER_LISTS) {
    try {
      const hash = await computeSha384(list.url);
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

  // Ensure rules directory exists
  if (!fs.existsSync(RULES_DIR)) {
    fs.mkdirSync(RULES_DIR, { recursive: true });
  }

  // Write hashes to file
  fs.writeFileSync(HASHES_FILE, JSON.stringify(hashes, null, 2));
  console.log(`\n[SRI] Hashes written to ${HASHES_FILE}`);
  console.log(`[SRI] Complete: ${successCount} succeeded, ${failCount} failed`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[SRI] Fatal error:', err);
  process.exit(1);
});
