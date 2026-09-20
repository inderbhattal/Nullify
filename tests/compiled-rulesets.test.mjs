import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_PER_FILE } from '../scripts/build-rules.mjs';

/**
 * Opens every compiled ruleset the manifest ships and checks the shapes Chrome
 * would otherwise reject *silently*: a static ruleset that fails to load is
 * dropped at extension load with a console line nobody reads, and the user
 * simply gets no blocking from that list (§5.16, second half).
 *
 * rules/*.json (all but system-unbreak.json) are gitignored build products,
 * so on a clone that has not run `npm run build:rules` this file SKIPS, the
 * way wasm-parity does for a missing artifact. In CI the release job compiles
 * the rules and runs this file right after (build.yml). To point it at another
 * directory — the red-first run against a deliberately corrupted copy — set
 * RULES_DIR=/path/to/dir.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES_DIR = process.env.RULES_DIR
  ? path.resolve(process.env.RULES_DIR)
  : path.join(ROOT, 'rules');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const resources = manifest.declarative_net_request?.rule_resources ?? [];

const skip = fs.existsSync(path.join(RULES_DIR, 'easylist.json'))
  ? false
  : `compiled rulesets not built in ${RULES_DIR} (run \`npm run build:rules\`)`;

// chrome.declarativeNetRequest enums. Anything outside these makes Chrome
// reject the whole ruleset, not the one rule.
const RESOURCE_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other',
]);
const REQUEST_METHODS = new Set([
  'connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other',
]);
const ACTION_TYPES = new Set([
  'block', 'redirect', 'allow', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests',
]);
const DOMAIN_LIST_KEYS = [
  'initiatorDomains', 'excludedInitiatorDomains',
  'requestDomains', 'excludedRequestDomains',
  'domains', 'excludedDomains', // pre-Chrome-101 spellings, still accepted
];

const isAscii = (s) => /^[\x00-\x7F]*$/.test(s);

function rulesetPath(entry) {
  // manifest paths are repo-relative (`rules/easylist.json`); RULES_DIR
  // stands in for the `rules/` directory.
  return path.join(RULES_DIR, path.basename(entry.path));
}

function loadRules(entry) {
  const file = rulesetPath(entry);
  assert.ok(fs.existsSync(file), `${entry.id}: ${entry.path} is missing`);
  let rules;
  try {
    rules = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    assert.fail(`${entry.id}: ${entry.path} is not valid JSON: ${err.message}`);
  }
  assert.ok(Array.isArray(rules), `${entry.id}: ${entry.path} must parse to an array`);
  return rules;
}

function checkRule(listId, rule) {
  const where = `${listId} rule #${rule?.id}`;
  assert.ok(rule && typeof rule === 'object', `${listId}: every rule must be an object`);
  assert.ok(Number.isInteger(rule.id) && rule.id >= 1, `${where}: id must be an integer >= 1`);
  if (rule.priority !== undefined) {
    assert.ok(Number.isInteger(rule.priority) && rule.priority >= 1,
      `${where}: priority must be an integer >= 1, got ${rule.priority}`);
  }

  const cond = rule.condition;
  assert.ok(cond && typeof cond === 'object', `${where}: missing condition`);
  const action = rule.action;
  assert.ok(action && ACTION_TYPES.has(action.type), `${where}: bad action.type ${action?.type}`);

  if (cond.regexFilter !== undefined) {
    assert.equal(typeof cond.regexFilter, 'string', `${where}: regexFilter must be a string`);
    assert.ok(isAscii(cond.regexFilter), `${where}: regexFilter must be ASCII: ${cond.regexFilter}`);
    assert.doesNotThrow(() => new RegExp(cond.regexFilter),
      `${where}: regexFilter does not compile: ${cond.regexFilter}`);
  }
  if (cond.urlFilter !== undefined) {
    assert.equal(typeof cond.urlFilter, 'string', `${where}: urlFilter must be a string`);
    assert.ok(cond.urlFilter.length > 0, `${where}: urlFilter must be non-empty`);
    assert.ok(isAscii(cond.urlFilter), `${where}: urlFilter must be ASCII: ${cond.urlFilter}`);
  }

  for (const key of DOMAIN_LIST_KEYS) {
    if (cond[key] === undefined) continue;
    assert.ok(Array.isArray(cond[key]) && cond[key].length > 0,
      `${where}: ${key} must be a non-empty array`);
    for (const d of cond[key]) {
      assert.ok(typeof d === 'string' && d.length > 0, `${where}: ${key} entry must be a non-empty string`);
      assert.ok(isAscii(d) && d === d.toLowerCase(), `${where}: ${key} entry must be lowercase ASCII: ${d}`);
    }
  }

  for (const key of ['requestMethods', 'excludedRequestMethods']) {
    if (cond[key] === undefined) continue;
    assert.ok(Array.isArray(cond[key]) && cond[key].length > 0, `${where}: ${key} must be a non-empty array`);
    for (const m of cond[key]) {
      assert.ok(REQUEST_METHODS.has(m), `${where}: ${key} has unknown method ${m}`);
    }
  }

  for (const key of ['resourceTypes', 'excludedResourceTypes']) {
    if (cond[key] === undefined) continue;
    assert.ok(Array.isArray(cond[key]) && cond[key].length > 0, `${where}: ${key} must be a non-empty array`);
    for (const t of cond[key]) {
      assert.ok(RESOURCE_TYPES.has(t), `${where}: ${key} has unknown resource type ${t}`);
    }
  }

  if (action.type === 'allowAllRequests') {
    // Chrome rejects the ruleset if allowAllRequests names any other type.
    const types = cond.resourceTypes;
    assert.ok(Array.isArray(types) && types.length > 0,
      `${where}: allowAllRequests must declare resourceTypes`);
    for (const t of types) {
      assert.ok(t === 'main_frame' || t === 'sub_frame',
        `${where}: allowAllRequests may only carry main_frame/sub_frame, got ${t}`);
    }
  }
}

test('manifest declares at least one static ruleset', () => {
  assert.ok(resources.length > 0, 'manifest.json has no rule_resources');
});

for (const entry of resources) {
  test(`compiled ruleset ${entry.id} (${entry.path}) is a valid DNR ruleset`, { skip }, () => {
    const rules = loadRules(entry);
    assert.ok(rules.length <= MAX_PER_FILE,
      `${entry.id}: ${rules.length} rules exceeds MAX_PER_FILE (${MAX_PER_FILE})`);

    const ids = new Set();
    for (const rule of rules) {
      checkRule(entry.id, rule);
      assert.ok(!ids.has(rule.id), `${entry.id}: duplicate rule id ${rule.id}`);
      ids.add(rule.id);
    }
  });
}

test('malware.json blocks navigations (has a main_frame block)', { skip }, () => {
  // A security list that cannot block a navigation is not doing its job —
  // the malware ruleset once shipped 5,888 rules that only matched
  // subresources. build-rules refuses to emit that; this checks what shipped.
  const entry = resources.find((r) => r.id === 'malware');
  assert.ok(entry, 'manifest must declare the malware ruleset');
  const rules = loadRules(entry);
  if (rules.length === 0) {
    // `npm run build:sample-rules` emits an empty malware shard (and a
    // one-rule easylist); a full build never does. Only the sample shape is
    // excused — an empty malware shard next to a real easylist is the dead
    // list this test exists to catch.
    const easylist = resources.find((r) => r.id === 'easylist');
    const sampleBuild = easylist && loadRules(easylist).length < 10;
    assert.ok(sampleBuild, 'malware.json is empty in a non-sample build');
    return;
  }
  assert.ok(
    rules.some((r) => r.action?.type === 'block' && (r.condition?.resourceTypes || []).includes('main_frame')),
    'malware.json has no block rule covering main_frame',
  );
});

// ---------------------------------------------------------------------------
// §5.17 — the two README figures that describe build products. Neither can be
// checked on a clone, which is why both had rotted: "~65K+" was measured
// against the manifest-enabled subset while claiming to describe the build,
// and "42+ selectors" predates compiling generic selectors from the lists at
// all.
//
// Both are stated as floors ("N+") and checked from BOTH sides: the floor has
// to be true, and it has to still be informative. A floor of 65,000 against a
// build of 136,168 is technically true and tells the reader nothing, which is
// exactly how the old figure survived so long.
// ---------------------------------------------------------------------------

const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const CLAIM_CEILING = 2; // a floor more than 2x below the truth has stopped informing
const parseCount = (text) => Number(text.replace(/,/g, ''));

/**
 * `npm run build:sample-rules` writes a one-rule easylist and an empty malware
 * shard into the same directory. The README figures describe a full build, so
 * they cannot be checked against a sample one.
 */
function isSampleBuild() {
  const easylist = resources.find((r) => r.id === 'easylist');
  return !!easylist && loadRules(easylist).length < 10;
}

function assertWithinClaim(label, floor, actual) {
  assert.ok(
    actual >= floor,
    `README claims ${label} of ${floor.toLocaleString()}+, but the build has ${actual.toLocaleString()} — `
    + 'either the build lost rules or the claim was never true');
  assert.ok(
    actual < floor * CLAIM_CEILING,
    `README claims ${label} of ${floor.toLocaleString()}+ but the build has ${actual.toLocaleString()}, `
    + `more than ${CLAIM_CEILING}x the claim — the figure is stale enough to mislead; raise it`);
}

test('5.17: the README compiled-rule figures are measured over the declared rulesets', { skip }, () => {
  if (isSampleBuild()) return;

  let total = 0;
  let manifestEnabled = 0;
  const perFile = {};
  for (const entry of resources) {
    const count = loadRules(entry).length;
    perFile[entry.id] = count;
    total += count;
    if (entry.enabled === true) manifestEnabled += count;
  }

  const claim = /([\d,]+)\+ rules across all (\d+) declared rulesets; ([\d,]+)\+ in the (\d+) the manifest enables/
    .exec(README);
  assert.ok(claim, 'README must state the compiled rule total and the manifest-enabled subtotal');

  // The two counts in the sentence come from the manifest, so this row cannot
  // drift from the "Static rulesets" row above it.
  assert.equal(Number(claim[2]), resources.length, 'README declared-ruleset count');
  assert.equal(
    Number(claim[4]), resources.filter((r) => r.enabled === true).length,
    'README manifest-enabled ruleset count');

  assertWithinClaim('a compiled rule total', parseCount(claim[1]), total);
  assertWithinClaim('a manifest-enabled rule subtotal', parseCount(claim[3]), manifestEnabled);

  // `rules/ruleset-counts.json` is what the service worker loads into
  // RULESET_RULE_COUNTS to decide which shards fit the static budget, so a
  // drift here is a wrong budget decision, not just a wrong number.
  const countsFile = path.join(RULES_DIR, 'ruleset-counts.json');
  assert.ok(fs.existsSync(countsFile), 'ruleset-counts.json is missing from the build');
  const counts = JSON.parse(fs.readFileSync(countsFile, 'utf8'));
  for (const [id, count] of Object.entries(perFile)) {
    assert.equal(counts[id], count, `ruleset-counts.json says ${id} has ${counts[id]} rules, but it has ${count}`);
  }
});

test('5.17: the README generic-selector figure matches the compiled cosmetic rules', { skip }, () => {
  if (isSampleBuild()) return;

  const cosmeticFile = path.join(RULES_DIR, 'cosmetic-rules.json');
  assert.ok(fs.existsSync(cosmeticFile), 'cosmetic-rules.json is missing from the build');
  const cosmetic = JSON.parse(fs.readFileSync(cosmeticFile, 'utf8'));
  assert.ok(Array.isArray(cosmetic.generic), 'cosmetic-rules.json has no generic selector array');

  // Generic selectors only. `genericExcludedDomains` is a list of DOMAINS on
  // which generic hiding is switched off, not selectors removed from the set,
  // so subtracting it would not be a selector count at all.
  const claim = /([\d,]+)\+ generic selectors compiled from the lists/.exec(README);
  assert.ok(claim, 'README must state the bundled generic-selector count');
  assertWithinClaim('a generic-selector count', parseCount(claim[1]), cosmetic.generic.length);
});
