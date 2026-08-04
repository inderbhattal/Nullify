import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FILTER_VECTORS } from './fixtures/filter-vectors.mjs';
import {
  parseLine as buildParseLine,
  networkFilterToDNR,
} from '../scripts/build-rules.mjs';
import { parseLine as runtimeParseLine } from '../src/shared/filter-parser.js';

/**
 * The fourth parity leg: the shipped WASM artifact, driven from Node.
 *
 * tests/parser-parity.test.mjs covers the two JS engines and carries the
 * caveat "the Rust core cannot be driven from Node, so it is not covered
 * here". That caveat was the reason a whole class of divergences (§5.14) could
 * only be found by hand: `example.com##+js(foo) extra` was a cosmetic selector
 * in JS and a live scriptlet in Rust, and nothing in CI could tell.
 *
 * It is not true. `wasm-bindgen`'s `--target web` glue takes the module bytes
 * directly — `mod.default({module_or_path: bytes})` — so the real, shipped
 * `nullify_core_bg.wasm` runs here against the same shared vectors. Structural
 * consequence: any future JS↔Rust drift on a vectored shape fails a test
 * instead of shipping.
 *
 * The artifact is a build product (src/shared/wasm/ is gitignored; `npm run
 * build:wasm` produces it). A missing artifact SKIPS this file rather than
 * failing it, so a fresh clone that has not built yet still gets a green
 * `npm test` — but a *present* artifact is always checked, so the leg cannot
 * be silently lost.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WASM_DIR = path.join(ROOT, 'src', 'shared', 'wasm');
const GLUE_PATH = path.join(WASM_DIR, 'nullify_core.js');
const BYTES_PATH = path.join(WASM_DIR, 'nullify_core_bg.wasm');

let wasm = null;
let skip = false;

if (!fs.existsSync(GLUE_PATH) || !fs.existsSync(BYTES_PATH)) {
  skip = 'WASM artifact not built (run `npm run build:wasm`)';
} else {
  const mod = await import(pathToFileURL(GLUE_PATH).href);
  await mod.default({ module_or_path: fs.readFileSync(BYTES_PATH) });
  wasm = mod;
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/**
 * Reduce either JS parser's output to the shared vector shape.
 *
 * Deliberately duplicated from parser-parity.test.mjs rather than imported:
 * importing one test file from another re-registers its tests under the
 * importer, so the suite would run twice and a failure would be reported
 * against the wrong file.
 */
function canonicalize(parsed) {
  if (!parsed || parsed.skip) return { kind: 'skip' };

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

// ---------------------------------------------------------------------------
// Projection: one canonical rule -> the bundle parse_filter_source builds
// ---------------------------------------------------------------------------

const emptyBundle = () => ({
  generic: [],
  domainSpecific: {},
  exceptions: {},
  scriptlets: [],
});

/**
 * Project a canonical rule into the bundle a one-line source produces.
 *
 * This encodes the ingestion rules `parse_filter_source_internal` implements —
 * they are the specification, not an implementation detail of one engine:
 *
 *  - domain keys are LOWERCASED (§5.14b), because the lookup walk lowercases
 *    the hostname it searches for; a key of `EXAMPLE.com` is a rule that can
 *    never match anything. Selector text is data and keeps its case.
 *  - a `~domain` exclusion becomes an exception on that domain, because the
 *    ancestor walk reaches the excluded subdomain through its parent and the
 *    exception is what cancels it there.
 *  - a domain-less rule is generic; a domain-less *exception* has nothing to
 *    apply to and is dropped.
 *  - kinds Rust's source parser does not model — `network`, `skip`, and
 *    `cosmetic-scope-exception` — contribute nothing. The last is deliberate:
 *    `@@…$ghide` is collected by the SW from `parseFilterList` alongside the
 *    WASM bundle (service-worker.js `fetchAndStoreRemoteFilterSources`), not
 *    from `parse_filter_source`.
 */
function projectToBundle(rule) {
  const bundle = emptyBundle();
  const lc = (d) => String(d).trim().toLowerCase();
  const addTo = (map, domain, selector) => {
    const key = lc(domain);
    if (!key) return;
    if (!map[key]) map[key] = [];
    if (!map[key].includes(selector)) map[key].push(selector);
  };

  if (rule.kind === 'cosmetic') {
    const selector = rule.selector;
    if (rule.domains.length === 0) {
      if (rule.exception) return bundle; // nothing to except
      bundle.generic.push(selector);
      for (const d of rule.excludedDomains) addTo(bundle.exceptions, d, selector);
      return bundle;
    }
    for (const d of rule.domains) {
      addTo(rule.exception ? bundle.exceptions : bundle.domainSpecific, d, selector);
    }
    if (!rule.exception) {
      for (const d of rule.excludedDomains) addTo(bundle.exceptions, d, selector);
    }
    return bundle;
  }

  if (rule.kind === 'scriptlet') {
    bundle.scriptlets.push({
      name: rule.name,
      domains: rule.domains,
      excludedDomains: rule.excludedDomains,
      args: rule.args,
    });
  }

  // scriptlet-exception, network, skip, cosmetic-scope-exception: nothing.
  return bundle;
}

/** Flatten a real WASM bundle into the same comparable shape. */
function normalizeWasmBundle(raw) {
  const bundle = emptyBundle();
  bundle.generic = raw?.cosmetic?.generic ?? [];
  bundle.domainSpecific = raw?.cosmetic?.domainSpecific ?? {};
  bundle.exceptions = raw?.cosmetic?.exceptions ?? {};
  bundle.scriptlets = (raw?.scriptlets ?? []).map((rule) => ({
    name: rule.name,
    domains: rule.domains ?? [],
    excludedDomains: rule.excludedDomains ?? [],
    args: rule.args ?? [],
  }));
  return bundle;
}

const wasmBundleFor = (line) => normalizeWasmBundle(wasm.parse_filter_source(line));

// ---------------------------------------------------------------------------
// The parity assertions
// ---------------------------------------------------------------------------

test('the shipped WASM artifact loads and exposes the parser entry points', { skip }, () => {
  assert.equal(typeof wasm.parse_filter_source, 'function');
  assert.equal(typeof wasm.compile_user_filters, 'function');
});

test('WASM classifies every shared vector as specified', { skip }, () => {
  for (const { line, expect } of FILTER_VECTORS) {
    assert.deepEqual(
      wasmBundleFor(line),
      projectToBundle(expect),
      `WASM engine: ${JSON.stringify(line)}`,
    );
  }
});

test('WASM agrees with the build engine on every shared vector', { skip }, () => {
  for (const { line } of FILTER_VECTORS) {
    assert.deepEqual(
      wasmBundleFor(line),
      projectToBundle(canonicalize(buildParseLine(line))),
      `WASM vs build engine: ${JSON.stringify(line)}`,
    );
  }
});

test('WASM agrees with the runtime engine on every shared vector', { skip }, () => {
  for (const { line } of FILTER_VECTORS) {
    assert.deepEqual(
      wasmBundleFor(line),
      projectToBundle(canonicalize(runtimeParseLine(line))),
      `WASM vs runtime engine: ${JSON.stringify(line)}`,
    );
  }
});

// §5.14a — the divergence that motivated this leg, asserted head-on rather
// than only through the vector table.
test('WASM treats a trailing-text +js line as cosmetic, not as a scriptlet', { skip }, () => {
  const bundle = wasmBundleFor('example.com##+js(foo) extra');
  assert.deepEqual(bundle.scriptlets, [], 'must not execute a scriptlet');
  assert.deepEqual(bundle.domainSpecific, { 'example.com': ['+js(foo) extra'] });

  // …and the inert selector never becomes CSS (§5.13: one bad selector in a
  // 100-selector join takes the other 99 down with it).
  const css = wasm.build_css_from_selectors('+js(foo) extra\n.real-ad', '', 100);
  assert.ok(css.includes('.real-ad'), css);
  assert.ok(!css.includes('+js('), css);
});

// §5.13 — the CSS-safety gate, driven through the shipped artifact.
//
// Both CSS joiners are checked: `sanitize_and_compact_selectors` (which the
// index compiler feeds) and `build_css_from_selectors` (which the service
// worker's fallback page-bundle path feeds). They join up to 150 selectors
// into one declaration, so an invalid entry does not fail alone — it takes the
// whole chunk's legitimate rules down with it.
test('WASM refuses prefix pseudo-elements and leading combinators as CSS', { skip }, () => {
  const bad = ['div::before2', 'div::first-line-x', '> .ad', '+js()', ', .ad'];
  const good = ['div::before', 'p::first-line', '.a > .b', '.keep-me'];
  const input = [...bad, ...good].join('\n');

  for (const [label, css] of [
    ['sanitize_and_compact_selectors', wasm.sanitize_and_compact_selectors(input, 100)],
    ['build_css_from_selectors', wasm.build_css_from_selectors(input, '', 100)],
  ]) {
    for (const selector of good) {
      assert.ok(css.includes(selector), `${label}: ${selector} must survive: ${css}`);
    }
    for (const selector of bad) {
      assert.ok(!css.includes(selector), `${label}: ${selector} must be dropped: ${css}`);
    }
  }
});

// §5.14c — a `;` inside a procedural operator's argument is data, not a CSS
// declaration separator, so the rule must survive ingestion and plan as
// procedural rather than being dropped by the WASM path alone.
test('WASM keeps semicolons inside procedural operator arguments', { skip }, () => {
  const bundle = wasmBundleFor('example.com#?#div:has-text(/ad;box/)');
  assert.deepEqual(bundle.domainSpecific, {
    'example.com': ['div:has-text(/ad;box/)'],
  });

  const planned = JSON.parse(
    wasm.plan_selector_rules_json(JSON.stringify(['div:has-text(/ad;box/)'])),
  );
  assert.equal(planned.proceduralRules.length, 1);
  assert.equal(planned.proceduralRules[0].plan[1].op, 'has-text');
  assert.equal(planned.proceduralRules[0].plan[1].arg, '/ad;box/');
});

// A lone `#@#+js(name)` line yields an empty bundle, so the vector table
// cannot tell a working exception from a dropped one. Pair each exception
// with the scriptlet it names and assert the suppression actually happens.
test('WASM applies scriptlet exceptions to the scriptlets they name', { skip }, () => {
  for (const { line, expect } of FILTER_VECTORS) {
    if (expect.kind !== 'scriptlet-exception') continue;

    const source = `##+js(${expect.name})\n##+js(zzz-unrelated)\n${line}`;
    const bundle = wasmBundleFor(source);

    const target = bundle.scriptlets.find((r) => r.name === expect.name);
    const unrelated = bundle.scriptlets.find((r) => r.name === 'zzz-unrelated');
    assert.ok(unrelated, `an unrelated scriptlet must survive: ${line}`);
    assert.deepEqual(unrelated.excludedDomains, []);

    if (expect.domains.length === 0) {
      assert.equal(target, undefined, `domain-less exception must kill: ${line}`);
    } else {
      assert.ok(target, `a scoped exception must not kill outright: ${line}`);
      assert.deepEqual(target.excludedDomains, expect.domains, line);
    }
  }
});

// ---------------------------------------------------------------------------
// §4.2 — cross-seam DNR priority bands
// ---------------------------------------------------------------------------

// Dynamic (user) rules and static (list) rules compete on ONE numeric scale,
// with ties broken by DNR action precedence (allow > block > redirect), not by
// which ruleset a rule came from. Both compilers previously asserted only the
// *relative* order of their own bands, which is why the runtime compiler could
// keep the old 1/2/3/4 numbering while the build compiler moved to six bands
// and nothing noticed: a user's `||x^$important` (3) tied a list's plain
// `@@||x^` (ALLOW 3) and lost on action precedence — §4.10's defect, alive
// again across the seam.
//
// This is the assertion neither compiler could make alone: the real static
// compiler and the real shipped WASM compiler, compared band for band.
test('user-filter bands equal the static compiler bands, number for number', { skip }, () => {
  const staticPriority = (line) => networkFilterToDNR(buildParseLine(line))?.priority;
  const userPriority = (line) => {
    const compiled = wasm.compile_user_filters(line, 1);
    assert.ok(compiled?.dnrRules?.length, `no rule emitted for ${line}`);
    return compiled.dnrRules[0].priority;
  };

  const pattern = '||ads.example.com^';
  for (const line of [
    pattern,
    `@@${pattern}`,
    `${pattern}$important`,
    `@@${pattern}$important`,
  ]) {
    assert.equal(
      userPriority(line),
      staticPriority(line),
      `user and static compilers must agree on ${line}`,
    );
  }

  // The absolute bands, so a matched-but-wrong renumbering on both sides at
  // once still fails. Mirrors DNR_PRIORITY in scripts/build-rules.mjs and the
  // Rust test `user_filter_priority_bands_match_the_static_scale_exactly`.
  assert.equal(userPriority(pattern), 1, 'BLOCK');
  assert.equal(userPriority(`@@${pattern}`), 3, 'ALLOW');
  assert.equal(userPriority(`${pattern}$important`), 4, 'IMPORTANT_BLOCK');
  assert.equal(userPriority(`@@${pattern}$important`), 6, 'IMPORTANT_ALLOW');

  // The two inversions the old numbering produced, stated as the comparisons
  // the browser actually performs against static rules.
  assert.ok(
    userPriority(`${pattern}$important`) > staticPriority(`@@${pattern}`),
    'a user $important block must beat a list exception',
  );
  assert.ok(
    userPriority(`@@${pattern}$important`) >
      staticPriority('||x^$important,redirect=noop.js'),
    'a user $important exception must beat a list $important redirect',
  );

  // The allowlist band still sits far above every static band.
  const allowlist = wasm.build_allowlist_rules(['example.com'], 1);
  assert.equal(allowlist[0].priority, 500);
  for (const line of [`@@${pattern}$important`, '||x^$important,redirect=noop.js']) {
    assert.ok(allowlist[0].priority > staticPriority(line), line);
  }
});
