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
import {
  PROC_OPS,
  NATIVE_FUNCTIONAL_PSEUDO_CLASSES,
  isProceduralSelector,
} from '../src/shared/proc-ops.js';

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

  // The allowlist band still sits far above every static band — and above the
  // hand-maintained system-unbreak blocks at 1100, which used to beat it (§4.5).
  // Pinned against the worker's own constant rather than a literal: the two are
  // separate declarations in separate languages, and a drift between them is
  // silent, so read the value the worker actually ships.
  const swSource = fs.readFileSync(
    new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  const bandMatch = /const DNR_ALLOWLIST_PRIORITY\s*=\s*([\d_]+)/.exec(swSource);
  assert.ok(bandMatch, 'service-worker.js must declare DNR_ALLOWLIST_PRIORITY');
  const expectedBand = Number(bandMatch[1].replace(/_/g, ''));

  const allowlist = wasm.build_allowlist_rules(['example.com'], 1);
  assert.equal(allowlist[0].priority, expectedBand);
  for (const line of [`@@${pattern}$important`, '||x^$important,redirect=noop.js']) {
    assert.ok(allowlist[0].priority > staticPriority(line), line);
  }
});

// ---------------------------------------------------------------------------
// §3.2 — unknown functional pseudo-classes never reach a CSS joiner
// ---------------------------------------------------------------------------

// The functional pseudo-classes a browser knows (`NATIVE_FUNCTIONAL_PSEUDO_
// CLASSES` in src/shared/proc-ops.js, mirrored by the Rust constant of the
// same name). Anything else after a single colon and before a `(` invalidates
// the selector, and — because both joiners comma-join up to 150 selectors
// into one declaration — the whole chunk.

/**
 * Every single-colon functional pseudo-class name in a CSS text, lowercased.
 * Quoted strings are blanked first (`[href*=":ad("]` is data), and `::part(`
 * is a pseudo-element, not a pseudo-class.
 */
function functionalPseudoClassesIn(css) {
  const unquoted = css.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const names = [];
  for (const m of unquoted.matchAll(/(?<!:):([a-z_-][a-z0-9_-]*)\(/gi)) {
    names.push(m[1].toLowerCase());
  }
  return names;
}

const bothJoiners = (input) => [
  ['sanitize_and_compact_selectors', wasm.sanitize_and_compact_selectors(input, 100)],
  ['build_css_from_selectors', wasm.build_css_from_selectors(input, '', 100)],
];

test('3.2: build_css_from_selectors never joins an unknown functional pseudo-class', { skip }, () => {
  // The review's five-line input, verbatim.
  const input = '.good-one\ndiv:others(.x)\n.good-two\n.a >>> .b\n.good-three';
  for (const [label, css] of bothJoiners(input)) {
    for (const good of ['.good-one', '.good-two', '.good-three']) {
      assert.ok(css.includes(good), `${label}: ${good} must survive: ${css}`);
    }
    assert.ok(!css.includes('div:others('), `${label}: :others() must be dropped: ${css}`);
    assert.ok(!css.includes(':others('), `${label}: ${css}`);
  }

  // Unknown names fail alone, at any nesting depth; the bracketed look-alike
  // is data and survives.
  for (const bad of ['div:bogus(1)', 'div:not(:bogus(1))', 'div:remove-attr(x)',
    'html.show-intro-popup:remove-class(show-intro-popup)']) {
    for (const [label, css] of bothJoiners(`${bad}\n.keep-me`)) {
      assert.ok(!css.includes(bad), `${label}: ${bad} must be dropped: ${css}`);
      assert.ok(css.includes('.keep-me'), `${label}: neighbour must survive: ${css}`);
    }
  }
  for (const [label, css] of bothJoiners('[data-x=":bogus("]')) {
    assert.ok(css.includes('[data-x=":bogus("]'), `${label}: ${css}`);
  }

  // Pseudo-element names are ASCII case-insensitive too: `::BEFORE` is valid
  // CSS and survives; `::Before2` is as non-existent as `::before2`.
  for (const [label, css] of bothJoiners('div::BEFORE\nx::Part(label)\ndiv::Before2')) {
    assert.ok(css.includes('div::BEFORE'), `${label}: ${css}`);
    assert.ok(css.includes('x::Part(label)'), `${label}: ${css}`);
    assert.ok(!css.includes('Before2'), `${label}: ${css}`);
  }
});

test('3.2: build_page_bundle plans :others()/:remove-attr()/:remove-class() as procedural', { skip }, () => {
  const selectors = [
    'div:others(.x)',
    'div:remove-attr(data-x)',
    'html.show-intro-popup:remove-class(show-intro-popup)',
    'div:shadow(.x)',
    'div:matches-media((min-width: 800px))',
    'div:matches-prop(x)',
    'div:-abp-has(.x)',
    'div:-abp-contains(ad)',
    'div:-abp-properties(width: 300px)',
  ];
  const bundle = wasm.build_page_bundle([], selectors, [], 100);
  assert.equal(bundle.cssText, '', 'none of these is CSS');
  assert.equal(bundle.rules.domainSpecific.length, selectors.length);
  for (const [i, selector] of selectors.entries()) {
    const rule = bundle.rules.domainSpecific[i];
    assert.equal(rule.selector, selector);
    const op = rule.plan.find((step) => step.type === 'op');
    assert.ok(op, `${selector} must plan an op step: ${JSON.stringify(rule.plan)}`);
    assert.equal(op.op, /:(-?[a-z-]+)\(/.exec(selector)[1], selector);
  }

  // Same classification from the batch planner the content script uses.
  const planned = JSON.parse(wasm.plan_selector_rules_json(JSON.stringify(selectors)));
  assert.deepEqual(planned.cssSelectors, []);
  assert.equal(planned.proceduralRules.length, selectors.length);
});

test('3.2 (didn\'t re-break): native functional pseudo-classes survive the gate', { skip }, () => {
  const good = [
    'div:has(.x)',
    'div:not(.x)',
    ':is(.a, .b)',
    ':where(.a)',
    'li:nth-child(2n+1)',
    'li:nth-last-child(1)',
    'p:nth-of-type(2)',
    'p:nth-last-of-type(2)',
    'td:nth-col(2)',
    ':lang(en)',
    ':dir(rtl)',
    ':host(.x)',
    ':host-context(.dark)',
    'x:state(open)',
    'li:nth-child(2n+1 of :not([hidden]))',
    'div:HAS(.x)',
    'div:Not(:Is(.x))',
    'a:hover:not(.x)',
    'div::before',
    'x::part(label)',
  ];
  for (const [label, css] of bothJoiners(good.join('\n'))) {
    for (const selector of good) {
      assert.ok(css.includes(selector), `${label}: ${selector} must survive: ${css}`);
    }
    for (const name of functionalPseudoClassesIn(css)) {
      assert.ok(NATIVE_FUNCTIONAL_PSEUDO_CLASSES.has(name), `${label}: ${name}`);
    }
  }

  // …and every shared vector that carries one is emitted, not dropped.
  const nativeRe = /:(?:has|not|is|where|nth-[a-z-]+|lang)\(/i;
  const vectored = FILTER_VECTORS
    .filter(({ expect }) => expect.kind === 'cosmetic' && !expect.exception)
    .map(({ expect }) => expect.selector)
    .filter((selector) => nativeRe.test(selector));
  assert.ok(vectored.length >= 6, 'the vector table must carry native pseudo-class selectors');
  const css = wasm.build_css_from_selectors(vectored.join('\n'), '', 100);
  for (const selector of vectored) {
    assert.ok(css.includes(selector), `${selector} must survive: ${css}`);
  }
});

// Corpus-wide: for every vendored list, every selector that the source parser
// hands to the CSS joiner must, once joined, carry only native functional
// pseudo-classes. This is the assertion the review's 289-domain scan made by
// hand.
test('3.2: no selector reaching the CSS joiner in the vendored corpus carries a functional pseudo-class outside the native set', { skip }, () => {
  const listDir = path.join(ROOT, 'scripts', 'filter-lists');
  const lists = fs.readdirSync(listDir).filter((f) => f.endsWith('.txt')).sort();
  assert.ok(lists.length > 0, 'vendored filter lists must be present');

  let seen = 0;
  const offenders = new Map(); // name -> first selector
  for (const file of lists) {
    const bundle = wasm.parse_filter_source(fs.readFileSync(path.join(listDir, file), 'utf8'));
    const selectors = [
      ...(bundle?.cosmetic?.generic ?? []),
      ...Object.values(bundle?.cosmetic?.domainSpecific ?? {}).flat(),
    ];
    seen += selectors.length;
    const css = wasm.build_css_from_selectors(selectors.join('\n'), '', 100);
    for (const rule of css.split('\n')) {
      for (const name of functionalPseudoClassesIn(rule)) {
        if (!NATIVE_FUNCTIONAL_PSEUDO_CLASSES.has(name) && !offenders.has(name)) {
          const sample = rule.split(',').find((s) => s.toLowerCase().includes(`:${name}(`));
          offenders.set(name, `${file}: ${sample}`);
        }
      }
    }
  }
  assert.ok(seen > 10_000, `the corpus must yield real selectors, saw ${seen}`);
  assert.deepEqual(
    [...offenders.entries()],
    [],
    'non-native functional pseudo-classes reached a CSS declaration',
  );
});

// The seam: the Rust core's operator list versus the shared JS one (C1a),
// which the content engine and the SW both import. A name in one and not the
// other is a selector that one engine plans as procedural and the other ships
// as (dead) CSS — §5.20's defect, and §3.2's. Element by element: both lists
// are longest-first within a shared prefix for their linear scanners, so the
// order is part of the contract too.
test('PROC_OPS: the engine, the SW and the Rust core list the same operator names', { skip }, () => {
  const rust = JSON.parse(wasm.proc_op_names());
  assert.ok(rust.length > 0);
  assert.deepEqual(rust, [...PROC_OPS]);
  assert.equal(new Set(rust).size, rust.length, 'no duplicate operator names');
  for (const name of rust) {
    assert.ok(!NATIVE_FUNCTIONAL_PSEUDO_CLASSES.has(name), `${name} is native CSS, not an operator`);
  }
});

// `DIV:Has-Text(x)` is one rule to the SW's case-insensitive regex; it must be
// the same rule to the Rust planner, or which engine handled the page decides
// whether the rule fires.
test('3.2: the operator matcher is case-insensitive in both engines', { skip }, () => {
  const selector = 'DIV:Has-Text(x)';

  // Rust: detected, planned, and planned under the canonical operator name.
  const bundle = wasm.build_page_bundle([], [selector], [], 100);
  assert.equal(bundle.cssText, '', 'must not be emitted as CSS');
  assert.equal(bundle.rules.domainSpecific.length, 1);
  assert.deepEqual(
    bundle.rules.domainSpecific[0].plan.map(({ type, selector: s, op, arg }) => ({ type, s, op, arg })),
    [
      { type: 'css', s: 'DIV', op: undefined, arg: undefined },
      { type: 'op', s: undefined, op: 'has-text', arg: 'x' },
    ],
  );
  const planned = JSON.parse(wasm.plan_selector_rules_json(JSON.stringify([selector])));
  assert.equal(planned.proceduralRules.length, 1);
  assert.deepEqual(planned.cssSelectors, []);

  // JS: the shared detector the SW and the content engine both import.
  assert.ok(isProceduralSelector(selector), `JS must detect ${selector}`);
  assert.ok(isProceduralSelector('div:others(.x)'), 'JS must detect the new operators');
  assert.ok(!isProceduralSelector('div:has(.x)'), 'a native pseudo-class is not an operator');
  assert.ok(!isProceduralSelector('div:HAS(.x)'), 'in any case');
});
