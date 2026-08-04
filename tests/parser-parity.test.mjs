import assert from 'node:assert/strict';
import test from 'node:test';

import { FILTER_VECTORS } from './fixtures/filter-vectors.mjs';
import { parseLine as buildParseLine } from '../scripts/build-rules.mjs';
import { parseLine as runtimeParseLine } from '../src/shared/filter-parser.js';

/**
 * Cross-engine parity gate.
 *
 * The build script and the service worker parse the same filter syntax with
 * separate implementations. When they disagree, a rule means one thing when
 * the ruleset is compiled and another when it is applied at runtime — and
 * nothing surfaces the difference. This suite asserts both engines classify
 * every vector identically, so drift fails a test instead of shipping.
 *
 * The Rust core (wasm-core/src/lib.rs) is the third implementation, and it IS
 * covered — by tests/wasm-parity.test.mjs, which loads the shipped
 * `nullify_core_bg.wasm` and runs these same vectors through it. (The older
 * note here said Rust "cannot be driven from Node"; it can, via
 * `mod.default({module_or_path: bytes})`, and believing otherwise is what let
 * the §5.14 divergences sit undetected.) Keep the two files in step: a vector
 * added below is automatically asserted against all three engines.
 */

/** Reduce the build parser's output to the canonical vector shape. */
function canonicalizeBuild(parsed) {
  if (!parsed) return { kind: 'skip' };
  if (parsed.skip) return { kind: 'skip' };

  switch (parsed.type) {
    case 'cosmetic':
      return {
        kind: 'cosmetic',
        domains: parsed.domains ?? [],
        excludedDomains: parsed.excludedDomains ?? [],
        selector: parsed.selector,
        exception: parsed.exception === true,
      };
    case 'scriptlet':
      return {
        kind: 'scriptlet',
        domains: parsed.domains ?? [],
        excludedDomains: parsed.excludedDomains ?? [],
        name: parsed.name,
        args: parsed.args ?? [],
      };
    case 'scriptlet-exception':
      return {
        kind: 'scriptlet-exception',
        domains: parsed.domains ?? [],
        excludedDomains: parsed.excludedDomains ?? [],
        name: parsed.name,
      };
    case 'network':
      return { kind: 'network' };
    default:
      return { kind: parsed.type };
  }
}

/**
 * Reduce the runtime parser's output to the canonical shape.
 *
 * It returns null both for lines it skips and for network rules, which it
 * deliberately ignores — so null is reported as `null` and the caller decides
 * whether that is expected for the vector.
 */
function canonicalizeRuntime(parsed) {
  if (!parsed) return null;
  return canonicalizeBuild(parsed);
}

/** Kinds the runtime parser is responsible for; it ignores everything else. */
const RUNTIME_KINDS = new Set(['cosmetic', 'scriptlet', 'scriptlet-exception']);

test('build engine classifies every vector as specified', () => {
  for (const { line, expect } of FILTER_VECTORS) {
    const actual = canonicalizeBuild(buildParseLine(line));
    assert.deepEqual(actual, expect, `build engine: ${JSON.stringify(line)}`);
  }
});

test('runtime engine classifies every cosmetic/scriptlet vector as specified', () => {
  for (const { line, expect } of FILTER_VECTORS) {
    if (!RUNTIME_KINDS.has(expect.kind)) continue;
    const actual = canonicalizeRuntime(runtimeParseLine(line));
    assert.deepEqual(actual, expect, `runtime engine: ${JSON.stringify(line)}`);
  }
});

test('runtime engine ignores network rules rather than misclassifying them', () => {
  for (const { line, expect } of FILTER_VECTORS) {
    if (expect.kind !== 'network' && expect.kind !== 'skip') continue;
    assert.equal(
      runtimeParseLine(line),
      null,
      `runtime engine must ignore ${JSON.stringify(line)}`,
    );
  }
});

test('both engines agree on every line either of them claims', () => {
  // The parity assertion proper: for anything the runtime parser handles, the
  // two implementations must produce the same answer, whatever that answer is.
  for (const { line } of FILTER_VECTORS) {
    const runtime = canonicalizeRuntime(runtimeParseLine(line));
    if (runtime === null) continue;

    const build = canonicalizeBuild(buildParseLine(line));
    assert.deepEqual(build, runtime, `engines disagree on ${JSON.stringify(line)}`);
  }
});
