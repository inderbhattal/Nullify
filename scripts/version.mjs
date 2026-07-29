#!/usr/bin/env node
/**
 * scripts/version.mjs
 *
 * Syncs the version to:
 *  - manifest.json
 *  - package.json
 *  - package-lock.json
 *
 * Usage:
 *   node scripts/version.mjs            # Sync from latest git tag
 *   node scripts/version.mjs 1.0.2     # Sync to specific version
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function getLatestTag() {
  try {
    const tag = execSync('git describe --tags --abbrev=0 --match "v*"').toString().trim();
    return tag.replace(/^v/, '');
  } catch {
    return null;
  }
}

/**
 * Set the version on a parsed package/manifest/lockfile object, in place.
 *
 * npm lockfile v3 records the root package version twice — at the top level
 * and again at `packages[""].version`. Updating only the first leaves the
 * lockfile internally inconsistent, and the next `npm ci` fails with
 * "package.json and package-lock.json are in sync"-style errors, breaking
 * both workflows. Dependency entries under `packages` are left alone.
 *
 * @returns {boolean} whether anything changed
 */
export function applyVersion(content, version) {
  let changed = false;

  if (content.version !== version) {
    content.version = version;
    changed = true;
  }

  const rootPackage = content.packages?.[''];
  if (rootPackage && rootPackage.version !== version) {
    rootPackage.version = version;
    changed = true;
  }

  return changed;
}

function updateJson(filePath, version) {
  const fullPath = path.join(root, filePath);
  if (!fs.existsSync(fullPath)) return;

  const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  if (!applyVersion(content, version)) {
    console.log(`ℹ️  ${filePath} is already at version ${version}`);
    return;
  }

  fs.writeFileSync(fullPath, JSON.stringify(content, null, 2) + '\n');
  console.log(`✅ Updated ${filePath} to version ${version}`);
}

function main() {
  // Use version from command line if provided, else fall back to git tag
  let version = process.argv[2];

  if (!version) {
    version = getLatestTag();
    if (version) {
      console.log(`🏷️  Latest git tag: v${version}`);
    }
  }

  if (!version) {
    console.error('❌ Error: No version provided and no git tags found.');
    process.exit(1);
  }

  if (process.argv[2]) {
    console.log(`🚀 Syncing to provided version: ${version}`);
  }

  updateJson('package.json', version);
  updateJson('manifest.json', version);
  updateJson('package-lock.json', version);

  console.log('🎉 Version synchronization complete!');
}

// Only run when invoked directly — importing this module (for tests) must not
// rewrite the repository's version files.
const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) main();
