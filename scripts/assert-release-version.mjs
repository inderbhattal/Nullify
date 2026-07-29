#!/usr/bin/env node
/**
 * scripts/assert-release-version.mjs
 *
 * Fail the release if the pushed tag does not match the version recorded in
 * the files that ship.
 *
 * Nothing tied the two together before: the release workflow is triggered by
 * any `v*` tag and packages whatever `manifest.json` happens to say, so a
 * `v4.2.0` tag would happily publish a ZIP whose manifest reads 4.1.0. Chrome
 * shows the manifest version, so the mismatch surfaces to users and not to us.
 *
 * Usage:
 *   node scripts/assert-release-version.mjs v4.2.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * Compare a release tag against the versions in the shipped files.
 *
 * @param {string} tag e.g. "v4.2.0" (a leading "v" is optional)
 * @param {(file: string) => string} readFile
 * @returns {string[]} human-readable problems; empty means the release is consistent
 */
export function findVersionMismatches(tag, readFile) {
  const expected = String(tag || '').replace(/^v/, '').trim();
  if (!expected) return ['no tag supplied'];
  if (!/^\d+\.\d+\.\d+$/.test(expected)) {
    return [`tag "${tag}" is not a semver release tag (expected vMAJOR.MINOR.PATCH)`];
  }

  const problems = [];
  const parse = (file) => {
    try {
      return JSON.parse(readFile(file));
    } catch (err) {
      problems.push(`${file} could not be read: ${err.message}`);
      return null;
    }
  };

  for (const file of ['manifest.json', 'package.json']) {
    const content = parse(file);
    if (content && content.version !== expected) {
      problems.push(`${file} is ${content.version} but the tag is v${expected}`);
    }
  }

  // Lockfile v3 records the version twice; both must agree or `npm ci` fails.
  const lock = parse('package-lock.json');
  if (lock) {
    if (lock.version !== expected) {
      problems.push(`package-lock.json is ${lock.version} but the tag is v${expected}`);
    }
    const rootPackage = lock.packages?.[''];
    if (rootPackage && rootPackage.version !== expected) {
      problems.push(
        `package-lock.json packages[""] is ${rootPackage.version} but the tag is v${expected}`,
      );
    }
  }

  return problems;
}

const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const tag = process.argv[2];
  const problems = findVersionMismatches(tag, (file) =>
    fs.readFileSync(path.join(root, file), 'utf8'));

  if (problems.length > 0) {
    console.error(`❌ Release version check failed for tag ${tag}:`);
    for (const problem of problems) console.error(`   - ${problem}`);
    console.error('\nRun `npm run version:bump <patch|minor|major>` before tagging.');
    process.exit(1);
  }

  console.log(`✅ Tag ${tag} matches manifest.json, package.json and package-lock.json`);
}
