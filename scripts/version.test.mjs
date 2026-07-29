import assert from 'node:assert/strict';
import test from 'node:test';

import { applyVersion } from './version.mjs';

/**
 * npm lockfile v3 records the root package version twice: once at the top
 * level and once at `packages[""].version`. Rewriting only the first leaves
 * the lockfile internally inconsistent, and the next `npm ci` fails with
 * "npm ci can only install packages when your package.json and
 * package-lock.json are in sync" — which breaks both CI workflows.
 *
 * `npm run version:bump` happened to be safe because `npm version` rewrites
 * the lock correctly before this script runs. Calling `version:sync`
 * standalone, as the docs suggest, was the trap.
 */

test('package.json gets its version updated', () => {
  const content = { name: 'nullify', version: '4.1.0' };
  assert.equal(applyVersion(content, '4.2.0'), true);
  assert.equal(content.version, '4.2.0');
});

test('manifest.json gets its version updated', () => {
  const content = { manifest_version: 3, name: 'Nullify', version: '4.1.0' };
  applyVersion(content, '4.2.0');
  assert.equal(content.version, '4.2.0');
});

test('lockfile v3 has BOTH version fields updated', () => {
  const content = {
    name: 'nullify',
    version: '4.1.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'nullify', version: '4.1.0' },
      'node_modules/eslint': { version: '9.15.0' },
    },
  };

  applyVersion(content, '4.2.0');

  assert.equal(content.version, '4.2.0', 'top-level version');
  assert.equal(content.packages[''].version, '4.2.0', 'root package entry');
  assert.equal(
    content.packages['node_modules/eslint'].version,
    '9.15.0',
    'dependency versions must not be touched',
  );
});

test('reports no change when already at the target version', () => {
  const content = {
    version: '4.2.0',
    packages: { '': { version: '4.2.0' } },
  };
  assert.equal(applyVersion(content, '4.2.0'), false, 'nothing to do');
});

test('a stale root package entry is still corrected when the top level matches', () => {
  // The exact state the old script left behind.
  const content = {
    version: '4.2.0',
    packages: { '': { version: '4.1.0' } },
  };

  assert.equal(applyVersion(content, '4.2.0'), true, 'must report a change');
  assert.equal(content.packages[''].version, '4.2.0');
});

test('files without a packages map are handled', () => {
  const content = { version: '4.1.0' };
  applyVersion(content, '4.2.0');
  assert.equal(content.version, '4.2.0');
});
