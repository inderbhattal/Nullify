import assert from 'node:assert/strict';
import test from 'node:test';

import { findVersionMismatches } from './assert-release-version.mjs';

/** Fake repo files at a given version, with optional per-file overrides. */
function repoAt(version, overrides = {}) {
  const files = {
    'manifest.json': { version },
    'package.json': { version },
    'package-lock.json': { version, packages: { '': { version } } },
    ...overrides,
  };
  return (file) => JSON.stringify(files[file]);
}

test('a consistent release passes', () => {
  assert.deepEqual(findVersionMismatches('v4.2.0', repoAt('4.2.0')), []);
});

test('the leading v is optional', () => {
  assert.deepEqual(findVersionMismatches('4.2.0', repoAt('4.2.0')), []);
});

test('a manifest left behind is caught — the exact shape of the bug', () => {
  // Tag says 4.2.0, files were never bumped. Chrome shows the manifest
  // version, so this reaches users rather than us.
  const problems = findVersionMismatches('v4.2.0', repoAt('4.1.0'));

  assert.ok(problems.length > 0);
  assert.ok(
    problems.some((p) => p.includes('manifest.json')),
    `expected a manifest complaint, got: ${problems.join('; ')}`,
  );
});

test('a stale lockfile root entry is caught on its own', () => {
  const problems = findVersionMismatches('v4.2.0', repoAt('4.2.0', {
    'package-lock.json': { version: '4.2.0', packages: { '': { version: '4.1.0' } } },
  }));

  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('packages'));
});

test('every mismatching file is reported, not just the first', () => {
  const problems = findVersionMismatches('v4.2.0', repoAt('4.2.0', {
    'manifest.json': { version: '4.1.0' },
    'package.json': { version: '4.0.0' },
  }));

  assert.equal(problems.length, 2);
});

test('a non-semver tag is rejected rather than silently passing', () => {
  for (const tag of ['v4.2', 'nightly', 'v4.2.0-rc1', '']) {
    assert.ok(
      findVersionMismatches(tag, repoAt('4.2.0')).length > 0,
      `${JSON.stringify(tag)} must be rejected`,
    );
  }
});

test('an unreadable file is reported instead of throwing', () => {
  const problems = findVersionMismatches('v4.2.0', (file) => {
    if (file === 'manifest.json') return '{ not json';
    return JSON.stringify({ version: '4.2.0', packages: { '': { version: '4.2.0' } } });
  });

  assert.ok(problems.some((p) => p.includes('manifest.json')));
});
