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
  assert.ok(
    rules.some((r) => r.action?.type === 'block' && (r.condition?.resourceTypes || []).includes('main_frame')),
    'malware.json has no block rule covering main_frame',
  );
});
