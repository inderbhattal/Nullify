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
  } catch (err) {
    return null;
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

function updateHtml(filePath, version) {
  const fullPath = path.join(root, filePath);
  if (!fs.existsSync(fullPath)) return;

  const content = fs.readFileSync(fullPath, 'utf8');
  const updated = content.replace(/<div class="sidebar-version">v[\d.]+<\/div>/, `<div class="sidebar-version">v${version}</div>`);
  if (content === updated) return;

  fs.writeFileSync(fullPath, updated);
  console.log(`✅ Updated ${filePath} to version ${version}`);
}

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
updateHtml('src/options/options.html', version);

console.log('🎉 Version synchronization complete!');
