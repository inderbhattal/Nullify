/**
 * Regression tests for REVIEW-2026-08 — the DNR priority scale and rule shape
 * (test-gap items 6 and 7).
 *
 * Dynamic and static rules compete on ONE numeric scale, with ties broken by
 * action precedence rather than by ruleset, so every producer has to agree on
 * the numbers. Nothing compared them before: each compiler asserted only the
 * relative order of its own bands.
 *
 *  §4.1 — the JS allowlist builder (the one that runs when WASM is down) emitted
 *         an `allowAllRequests` rule with no `resourceTypes`, which Chrome
 *         rejects outright: storage said "allowlisted", DNR kept blocking.
 *  §4.2 — the JS user-filter fallback compiler's bands must equal the static
 *         `DNR_PRIORITY` table in scripts/build-rules.mjs.
 *  §4.5 — `system-unbreak` carries hand-maintained blocks at 1100, so a user
 *         allowlist entry at 500 could not unbreak a DataDome-protected site.
 *  §5.31 — the SW's own privacy/header rules sat inside the static band range,
 *         where any ordinary list exception outranked them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { loadServiceWorker } from './sw-loader.mjs';

const BUILD_RULES_PATH = new URL('../../scripts/build-rules.mjs', import.meta.url);
const SYSTEM_UNBREAK_PATH = new URL('../../rules/system-unbreak.json', import.meta.url);

/**
 * The static band table. Prefer a real export (a parallel track may add one);
 * fall back to reading the literal out of the build script so this test cannot
 * drift into asserting against its own copy of the numbers.
 */
async function staticDnrPriority() {
  const mod = await import('../../scripts/build-rules.mjs');
  if (mod.DNR_PRIORITY) return mod.DNR_PRIORITY;

  const source = await readFile(BUILD_RULES_PATH, 'utf8');
  const match = /const DNR_PRIORITY = \{([^}]*)\}/.exec(source);
  assert.ok(match, 'scripts/build-rules.mjs must define DNR_PRIORITY');
  const table = {};
  for (const [, key, value] of match[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) {
    table[key] = Number(value);
  }
  return table;
}

test('4.2: the JS user-filter fallback emits the static bands, number for number', async () => {
  const { hooks } = await loadServiceWorker({ awaitReady: true });
  const DNR_PRIORITY = await staticDnrPriority();

  const block = hooks.parseSimpleNetworkRule('||ads.example^', 900_000);
  const allow = hooks.parseSimpleNetworkRule('@@||ads.example^', 900_001);

  assert.equal(block.action.type, 'block');
  assert.equal(allow.action.type, 'allow');
  assert.equal(block.priority, DNR_PRIORITY.BLOCK,
    'a user block must sit in the same band as a list block');
  assert.equal(allow.priority, DNR_PRIORITY.ALLOW,
    'a user exception must sit in the same band as a list exception (was 2 vs 3)');

  // And the exported table the SW compiles from agrees with the static one.
  assert.equal(hooks.DNR_USER_FILTER_PRIORITY.BLOCK, DNR_PRIORITY.BLOCK);
  assert.equal(hooks.DNR_USER_FILTER_PRIORITY.ALLOW, DNR_PRIORITY.ALLOW);

  hooks.cancelPendingStatsPersistForTest();
});

test('4.1: the JS allowlist builder emits a rule Chrome accepts', async () => {
  // WASM is permanently unavailable in the harness, so this IS the fallback
  // builder — and the stub now enforces Chrome's allowAllRequests constraint.
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    seed: { allowlist: ['example.com'] },
  });

  const rules = [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= hooks.DNR_ALLOWLIST_START);

  assert.equal(rules.length, 1);
  assert.equal(rules[0].action.type, 'allowAllRequests');
  assert.deepEqual(rules[0].condition.resourceTypes, ['main_frame', 'sub_frame'],
    'allowAllRequests is rejected by Chrome without main_frame/sub_frame resourceTypes');

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5: the allowlist outranks every shipped static rule', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    seed: { allowlist: ['datadome-protected.example'] },
  });

  const allowRule = [...chrome.declarativeNetRequest._dynamic.values()]
    .find((r) => r.id >= hooks.DNR_ALLOWLIST_START);

  assert.equal(hooks.DNR_ALLOWLIST_PRIORITY, 100_000);
  assert.equal(allowRule.priority, hooks.DNR_ALLOWLIST_PRIORITY);

  // The hand-maintained blocks that used to win against it.
  const systemUnbreak = JSON.parse(await readFile(SYSTEM_UNBREAK_PATH, 'utf8'));
  const highestShipped = Math.max(...systemUnbreak.map((r) => r.priority));
  assert.ok(
    hooks.DNR_ALLOWLIST_PRIORITY > highestShipped,
    `the allowlist (${hooks.DNR_ALLOWLIST_PRIORITY}) must outrank every shipped rule (max ${highestShipped})`,
  );

  hooks.cancelPendingStatsPersistForTest();
});

test('4.5: the band is stamped on rules from either builder, not trusted from one', async () => {
  // wasm-core's `build_allowlist_rules` carries its own priority literal, so
  // the effective band would otherwise depend on WASM health: the same user
  // action outranks system-unbreak with WASM down and loses to it with WASM up.
  const { hooks } = await loadServiceWorker({ awaitReady: true });

  const fromWasm = [{
    id: hooks.DNR_ALLOWLIST_START,
    priority: 500, // what wasm-core emits today
    condition: { urlFilter: '||wasm.example^', resourceTypes: ['main_frame', 'sub_frame'] },
    action: { type: 'allowAllRequests' },
  }];

  hooks.applyAllowlistPriorityBand(fromWasm);
  assert.equal(fromWasm[0].priority, hooks.DNR_ALLOWLIST_PRIORITY,
    'the SW must stamp its own band rather than inherit the compiler\'s literal');

  hooks.cancelPendingStatsPersistForTest();
});

test('5.31: privacy rules sit above the static bands but below the allowlist', async () => {
  const { chrome, hooks } = await loadServiceWorker({
    awaitReady: true,
    seed: {
      settings: {
        enabled: true,
        showBadge: true,
        stripTrackingHeaders: true,
        upgradeInsecureRequests: true,
        cacheProtection: true,
        referrerControl: true,
        stealthPersona: 'windows',
      },
    },
  });

  const DNR_PRIORITY = await staticDnrPriority();
  const highestStaticBand = Math.max(...Object.values(DNR_PRIORITY));

  // Referer strip, Set-Cookie strip, upgradeScheme, persona UA spoof, ETag
  // strip and Referrer-Policy — everything applyPrivacySettings writes.
  const privacyRules = [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= 800_000 && r.id < hooks.DNR_USER_RULES_START);

  assert.ok(privacyRules.length >= 5, `expected the privacy rule set, got ${privacyRules.length}`);
  for (const rule of privacyRules) {
    assert.equal(rule.priority, hooks.DNR_PRIVACY_PRIORITY,
      `privacy rule ${rule.id} must be in the privacy band`);
    assert.ok(rule.priority > highestStaticBand,
      'a filter-list exception must not be able to disable privacy hardening');
    assert.ok(rule.priority < hooks.DNR_ALLOWLIST_PRIORITY,
      'the user allowlist is still the one thing that outranks privacy hardening');
  }

  hooks.cancelPendingStatsPersistForTest();
});

test('7.7: the stub rejects the DNR shapes Chrome rejects', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });
  const dnr = chrome.declarativeNetRequest;

  await assert.rejects(
    dnr.updateDynamicRules({
      addRules: [{ id: 700_001, priority: 1, condition: { urlFilter: '||x.example^' }, action: { type: 'allowAllRequests' } }],
    }),
    /resourceTypes/,
    'allowAllRequests without resourceTypes must be rejected',
  );

  await assert.rejects(
    dnr.updateDynamicRules({
      addRules: [{
        id: 700_002,
        priority: 1,
        condition: { urlFilter: '||x.example^', resourceTypes: ['main_frame', 'script'] },
        action: { type: 'allowAllRequests' },
      }],
    }),
    /main_frame/,
    'allowAllRequests may only cover main_frame/sub_frame',
  );

  for (const domains of [['foo.com', ''], ['Example.COM'], []]) {
    await assert.rejects(
      dnr.updateDynamicRules({
        addRules: [{
          id: 700_003,
          priority: 1,
          condition: { urlFilter: '/ad', initiatorDomains: domains },
          action: { type: 'block' },
        }],
      }),
      `initiatorDomains ${JSON.stringify(domains)} must be rejected`,
    );
  }

  hooks.cancelPendingStatsPersistForTest();
});

test('7.1: the message bus serializes both directions', async () => {
  const { chrome, hooks } = await loadServiceWorker({ awaitReady: true });

  // A live object handed to sendMessage must not reach the handler by
  // reference: mutating it afterwards cannot change what was delivered.
  const payload = { domain: 'serialize.example' };
  const message = { type: 'ALLOW_SITE', payload };
  const pending = chrome.runtime.sendMessage(message);
  payload.domain = 'mutated.example';
  const res = await pending;
  assert.deepEqual(res.allowlist, ['serialize.example'],
    'the handler must see the message as it was at send time');

  // Non-JSON values are rejected the way Chrome rejects them, rather than
  // being quietly passed through as live references.
  const cyclic = { type: 'GET_SETTINGS', payload: {} };
  cyclic.payload.self = cyclic;
  await assert.rejects(() => chrome.runtime.sendMessage(cyclic), /not serializable/);

  hooks.cancelPendingStatsPersistForTest();
});
