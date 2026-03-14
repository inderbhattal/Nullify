#!/usr/bin/env node
/**
 * scripts/version.mjs
 *
 * Syncs the version from the latest git tag (vX.Y.Z) to:
 *  - manifest.json
 *  - package.json
 *  - package-lock.json
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function getLatestTag() {
  try {
    // Get the latest tag name that matches v*
    const tag = execSync('git describe --tags --abbrev=0 --match "v*"').toString().trim();
    // Remove the leading 'v'
    return tag.replace(/^v/, '');
  } catch (err) {
    console.error('❌ Error: Could not find any git tags matching v*.');
    process.exit(1);
  }
}

function updateJson(filePath, version) {
  const fullPath = path.join(root, filePath);
  if (!fs.existsSync(fullPath)) return;

  const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  if (content.version === version) {
    console.log(`ℹ️  ${filePath} is already at version ${version}`);
    return;
  }

  content.version = version;
  fs.writeFileSync(fullPath, JSON.stringify(content, null, 2) + '\n');
  console.log(`✅ Updated ${filePath} to version ${version}`);
}

const version = getLatestTag();
console.log(`🏷️  Latest git tag: v${version}`);

updateJson('package.json', version);
updateJson('manifest.json', version);
updateJson('package-lock.json', version);

console.log('🎉 Version synchronization complete!');
