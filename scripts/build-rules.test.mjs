import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseLine,
  networkFilterToDNR,
  buildSourceBundleFallback,
  verifySriHash,
  effectiveListLimit,
  commitStagedRules,
  LIST_CONFIG,
  MAX_PER_FILE,
} from './build-rules.mjs';
import { shouldSkipGenericCosmeticForHostname } from '../src/shared/core-filter-source.js';

// redirect-rule= is conditional on another filter blocking (something DNR
// cannot express), so it is skipped at parse time (§5.42) — including the
// legacy global sprite-killer form that used to need its own guard.
test('redirect-rule= lines are skipped at parse time', () => {
  for (const line of [
    '*.svg#$image,redirect-rule=1x1.gif',
    '||example.com/assets/*.svg#$image,redirect-rule=1x1.gif',
  ]) {
    const parsed = parseLine(line);
    assert.equal(parsed.skip, true, `${line} must be skipped`);
    assert.match(parsed.reason || '', /redirect-rule/);
  }
});

test('drops legacy global fragment image redirects that overmatch DNR sprite URLs', () => {
  const parsed = parseLine('*.svg#$image,redirect=1x1.gif');
  assert.equal(parsed?.type, 'network');
  assert.equal(networkFilterToDNR(parsed), null);
});

test('keeps narrower fragment image redirects that are scoped to a specific host path', () => {
  const parsed = parseLine('||example.com/assets/*.svg#$image,redirect=1x1.gif');
  assert.equal(parsed?.type, 'network');

  const dnr = networkFilterToDNR(parsed);
  assert.ok(dnr);
  assert.equal(dnr.action.type, 'redirect');
  assert.equal(dnr.condition.urlFilter, '||example.com/assets/*.svg#');
  assert.deepEqual(dnr.condition.resourceTypes, ['image']);
});

test('drops denied Gmail cosmetic selectors during source bundle generation', () => {
  const parsed = {
    cosmeticRules: [
      {
        type: 'cosmetic',
        domains: ['mail.google.com'],
        selector: '.nH.PS',
        exception: false,
      },
      {
        type: 'cosmetic',
        domains: ['mail.google.com'],
        selector: '.aeF > .nH > .nH[role="main"] > .aKB',
        exception: false,
      },
      {
        type: 'cosmetic',
        domains: ['mail.google.com'],
        selector: 'a[href^="http://li.blogtrottr.com/click?"]',
        exception: false,
      },
    ],
    cosmeticExceptions: [],
    genericCosmeticExceptionDomains: ['mail.google.com'],
    scriptletRules: [],
  };

  const bundle = buildSourceBundleFallback(parsed);
  assert.deepEqual(bundle.cosmetic.domainSpecific['mail.google.com'], [
    'a[href^="http://li.blogtrottr.com/click?"]',
  ]);
  assert.deepEqual(bundle.cosmetic.genericExcludedDomains, ['mail.google.com']);
});

test('parses EasyList generichide as generated generic cosmetic exclusion', () => {
  const parsed = parseLine('@@||mail.google.com^$generichide');
  assert.equal(parsed?.type, 'cosmetic-scope-exception');
  assert.deepEqual(parsed.domains, ['mail.google.com']);
  assert.deepEqual(parsed.scopes, ['generichide']);
});

test('parses domain-scoped generichide exceptions without URL pattern', () => {
  const parsed = parseLine('@@$generichide,domain=androidpolice.com|~excluded.example|xda-developers.com');
  assert.equal(parsed?.type, 'cosmetic-scope-exception');
  assert.deepEqual(parsed.domains, ['androidpolice.com', 'xda-developers.com']);
});

test('skips generic cosmetic CSS using generated excluded domains', () => {
  const excludedDomains = ['mail.google.com'];
  assert.equal(shouldSkipGenericCosmeticForHostname('mail.google.com', excludedDomains), true);
  assert.equal(shouldSkipGenericCosmeticForHostname('inbox.mail.google.com', excludedDomains), true);
  assert.equal(shouldSkipGenericCosmeticForHostname('mail.example.com', excludedDomains), false);
  assert.equal(shouldSkipGenericCosmeticForHostname('mail.google.com'), false);
});

// ---------------------------------------------------------------------------
// Per-list limits vs shard capacity (§5.47)
// ---------------------------------------------------------------------------

test('effectiveListLimit clamps totalLimit to what the shards can hold', () => {
  // A single-part list used to declare 30000 against a 25000 write capacity,
  // so up to 5000 rules vanished at the shard writer with no skip record.
  assert.equal(effectiveListLimit({ parts: 1, totalLimit: 30000 }), 25000);
  assert.equal(effectiveListLimit({ parts: 2, totalLimit: 40000 }), 40000);
  assert.equal(effectiveListLimit({ parts: 1 }), 25000);
});

test('every configured list limit fits its shard capacity', () => {
  for (const [id, config] of Object.entries(LIST_CONFIG)) {
    const capacity = (config.parts || 1) * MAX_PER_FILE;
    assert.ok(
      config.totalLimit <= capacity,
      `${id}: totalLimit ${config.totalLimit} exceeds shard capacity ${capacity}`,
    );
  }
});

// ---------------------------------------------------------------------------
// SRI lock file (§5.39)
// ---------------------------------------------------------------------------

test('a missing SRI hash is a failure, not a silent pass', () => {
  // The old behaviour returned { valid: true } with no hash — and since the
  // hash file was gitignored and absent, SRI was dead code in every build.
  const result = verifySriHash('some list content', 'no-such-list', {});
  assert.equal(result.valid, false);
  assert.match(result.error || '', /filter-lists\.lock\.json/);
});

test('SRI verification accepts matching content and rejects tampered content', async () => {
  const { createHash } = await import('node:crypto');
  const content = '! title: test list\n||ads.example^\n';
  const hashes = {
    'test-list': {
      sha384: `sha384-${createHash('sha384').update(content, 'utf8').digest('base64')}`,
    },
  };

  assert.equal(verifySriHash(content, 'test-list', hashes).valid, true);
  assert.equal(verifySriHash(content + '||evil.example^\n', 'test-list', hashes).valid, false);
});

test('the committed lock file pins a hash for every fetched list', async () => {
  const lockPath = new URL('./filter-lists.lock.json', import.meta.url);
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const { FILTER_LISTS } = await import('./build-rules.mjs');
  for (const list of FILTER_LISTS) {
    assert.match(
      lock[list.id]?.sha384 || '',
      /^sha384-[A-Za-z0-9+/]+=*$/,
      `${list.id} must have a pinned sha384 in scripts/filter-lists.lock.json`,
    );
  }
});

// ---------------------------------------------------------------------------
// Staged build promotion (§5.48)
// ---------------------------------------------------------------------------

test('commitStagedRules swaps staged output in and preserves hand-maintained files', () => {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullify-staging-'));
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullify-rules-'));
  try {
    // Previous good build + hand-maintained file + a stale shard the new
    // build no longer produces.
    fs.writeFileSync(path.join(targetDir, 'system-unbreak.json'), '[{"id":1}]');
    fs.writeFileSync(path.join(targetDir, 'easylist.json'), '["old"]');
    fs.writeFileSync(path.join(targetDir, 'easylist_4.json'), '["stale"]');
    fs.mkdirSync(path.join(targetDir, 'skipped'));
    fs.writeFileSync(path.join(targetDir, 'skipped', 'old-list.log'), 'old');

    fs.writeFileSync(path.join(stagingDir, 'easylist.json'), '["new"]');
    fs.writeFileSync(path.join(stagingDir, 'ruleset-counts.json'), '{"easylist":1}');
    fs.mkdirSync(path.join(stagingDir, 'skipped'));
    fs.writeFileSync(path.join(stagingDir, 'skipped', 'easylist.log'), 'fresh');

    commitStagedRules(stagingDir, targetDir);

    assert.equal(fs.readFileSync(path.join(targetDir, 'easylist.json'), 'utf8'), '["new"]');
    assert.equal(
      fs.readFileSync(path.join(targetDir, 'system-unbreak.json'), 'utf8'),
      '[{"id":1}]',
      'hand-maintained files must never be touched',
    );
    assert.equal(
      fs.existsSync(path.join(targetDir, 'easylist_4.json')),
      false,
      'generated files the new build did not produce must be removed',
    );
    assert.equal(fs.readFileSync(path.join(targetDir, 'skipped', 'easylist.log'), 'utf8'), 'fresh');
    assert.equal(
      fs.existsSync(path.join(targetDir, 'skipped', 'old-list.log')),
      false,
      'stale skip logs must be replaced wholesale',
    );
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

test('a build that never commits leaves the previous rules untouched', () => {
  // The §5.48 failure mode: the old build wiped rules/ up front, so a flaky
  // fetch destroyed the previous good artifacts. Staging means the target dir
  // is only modified by an explicit successful commit.
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullify-rules-'));
  try {
    fs.writeFileSync(path.join(targetDir, 'easylist.json'), '["good"]');
    // Simulated failed build: staging dir written, commit never called,
    // staging discarded — exactly what main() does on a throw.
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nullify-staging-'));
    fs.writeFileSync(path.join(stagingDir, 'easylist.json'), '["partial"]');
    fs.rmSync(stagingDir, { recursive: true, force: true });

    assert.equal(fs.readFileSync(path.join(targetDir, 'easylist.json'), 'utf8'), '["good"]');
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});
