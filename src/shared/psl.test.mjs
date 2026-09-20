import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildTables, renderJs, renderRust } from '../../scripts/generate-psl.mjs';
import { ancestorDomains, isPublicSuffix, lookupDomains } from './psl.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PSL_JS = path.resolve(HERE, 'psl.js');
const PSL_RS = path.resolve(HERE, '../../wasm-core/src/psl_generated.rs');

/**
 * Pull one generated table out of either emitted file. Both sides are written
 * as a single newline-separated string literal with the same delimiters, so
 * one shape of parse serves both — which is the point of the count assertion
 * below: it reads the shipped bytes, not the module's runtime state.
 */
function jsTable(source, name) {
  const match = new RegExp(`const ${name} = \`\\n([\\s\\S]*?)\`;`).exec(source);
  assert.ok(match, `psl.js: could not find the generated table ${name}`);
  return match[1].split('\n').filter(Boolean);
}

function rustTable(source, name) {
  const match = new RegExp(`const ${name}: &str = "\\\\\\n([\\s\\S]*?)\\n";`).exec(source);
  assert.ok(match, `psl_generated.rs: could not find the generated table ${name}`);
  return match[1].split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------
// §5.12 — the two rules a membership-only table cannot express.
// ---------------------------------------------------------------------------

test('5.12: wildcard and exception rules follow the PSL algorithm', () => {
  // `*.ck` — every `<label>.ck` is a public suffix, so nothing under it may
  // be allowlisted or blanket-matched at that level.
  assert.equal(isPublicSuffix('foo.ck'), true);
  assert.equal(isPublicSuffix('anything.ck'), true);
  // `!www.ck` — the one name the list excepts back out again. This is the
  // half a plain membership table gets wrong in the *unsafe* direction if the
  // wildcard is implemented without the exceptions.
  assert.equal(isPublicSuffix('www.ck'), false);
  // The wildcard is exactly one label deep: `foo.ck` is the suffix, so
  // `deep.foo.ck` is an ordinary registrable name below it.
  assert.equal(isPublicSuffix('deep.foo.ck'), false);
  // The base of a wildcard rule is itself a registry boundary (`ck` has no
  // plain rule of its own — the list leans on its implicit `*`).
  assert.equal(isPublicSuffix('ck'), true);

  // The same three rules on a multi-label base (`*.kawasaki.jp`,
  // `!city.kawasaki.jp`).
  assert.equal(isPublicSuffix('kawasaki.jp'), true);
  assert.equal(isPublicSuffix('example.kawasaki.jp'), true);
  assert.equal(isPublicSuffix('city.kawasaki.jp'), false);

  // The walkers inherit all three rules.
  assert.deepEqual([...ancestorDomains('shop.foo.ck')], ['shop.foo.ck']);
  assert.deepEqual([...ancestorDomains('www.ck')], ['www.ck']);
  assert.deepEqual([...lookupDomains('foo.ck')], ['foo.ck']);
});

test('5.12: generated Rust and JS tables have the same entry count', () => {
  const js = fs.readFileSync(PSL_JS, 'utf8');
  const rs = fs.readFileSync(PSL_RS, 'utf8');

  for (const name of ['PUBLIC_SUFFIX_DATA', 'WILDCARD_SUFFIX_DATA', 'SUFFIX_EXCEPTION_DATA']) {
    const jsEntries = jsTable(js, name);
    const rsEntries = rustTable(rs, name);
    assert.equal(
      rsEntries.length,
      jsEntries.length,
      `${name}: Rust has ${rsEntries.length} entries, JS has ${jsEntries.length}`,
    );
    assert.deepEqual(rsEntries, jsEntries, `${name}: the two generated tables differ`);
  }

  // The tables are big enough to be the real list rather than a curated stub,
  // and every entry is an ASCII hostname — the generator punycodes the list's
  // U-label entries, which is the only form `normalizeHostname` can ever
  // produce (`new URL()` emits A-labels).
  const suffixes = jsTable(js, 'PUBLIC_SUFFIX_DATA');
  assert.ok(suffixes.length > 6000, `expected the full ICANN table, got ${suffixes.length}`);
  for (const entry of suffixes) {
    assert.match(entry, /^[a-z0-9][a-z0-9.-]*$/, `non-ASCII or malformed table entry: ${entry}`);
  }
});

test('5.12: the committed tables are exactly what the generator emits', () => {
  // The two files are generated output — `psl_generated.rs` says so and
  // `psl.js` says so — but nothing stopped a hand edit, and a hand edit to one
  // side is precisely how the JS and Rust tables used to drift. Re-rendering
  // from the vendored list and comparing bytes closes that, and proves the
  // generator is idempotent in the same breath: the emit is a pure function of
  // the vendored bytes, so a second run cannot produce a third answer.
  const tables = buildTables();
  assert.equal(renderJs(tables), fs.readFileSync(PSL_JS, 'utf8'), 'src/shared/psl.js is stale or hand-edited — run node scripts/generate-psl.mjs');
  assert.equal(renderRust(tables), fs.readFileSync(PSL_RS, 'utf8'), 'wasm-core/src/psl_generated.rs is stale or hand-edited — run node scripts/generate-psl.mjs');
});
