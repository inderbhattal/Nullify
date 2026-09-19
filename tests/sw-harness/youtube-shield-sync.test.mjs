/**
 * Bullseye regression suite for the YouTube shield sync module.
 *
 * These are the seven scenarios from docs/IMPLEMENTATION.md §7 that, taken
 * together, would have prevented every YouTube outage in the project's git
 * history (see commits b327340, 3a35970, f9b4f39).
 *
 * Each test wires a fresh chrome-stub into createYouTubeShieldSync and
 * asserts the observable side effects on stub.scripting.* and stub.calls.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makeChromeStub } from './chrome-stub.mjs';
import { createYouTubeShieldSync } from '../../src/background/youtube-shield-sync.js';

const SCRIPT_ID = 'nullify-youtube-shield';
const TARGETS = [
  { hostname: 'youtube.com', pattern: '*://youtube.com/*' },
  { hostname: 'www.youtube.com', pattern: '*://www.youtube.com/*' },
  { hostname: 'm.youtube.com', pattern: '*://m.youtube.com/*' },
  { hostname: 'music.youtube.com', pattern: '*://music.youtube.com/*' },
];

// `isFeatureEnabled` is injected, not imported: this harness never assigns
// `globalThis.chrome`, so a storage-backed flag read could not see the stub.
// Left undefined, the factory's own default (`() => false`) applies — the
// flag-off path is the one every numbered scenario below exercises.
function setupHarness({ allowlist = new Set(), tabs = [], isFeatureEnabled } = {}) {
  const stub = makeChromeStub();
  for (const tab of tabs) stub.tabs._addTab(tab);

  const allowlistRef = { current: new Set(allowlist) };

  const sync = createYouTubeShieldSync({
    chrome: stub,
    isFeatureEnabled,
    isHostnameAllowed: (hostname) => {
      // Match the SW's parent-walk semantics so a "youtube.com" entry covers
      // www/m/music subdomains.
      let h = hostname;
      while (h) {
        if (allowlistRef.current.has(h)) return true;
        const dot = h.indexOf('.');
        if (dot === -1) return false;
        h = h.slice(dot + 1);
      }
      return false;
    },
    runtimeAssetPath: (file) => `dist/${file}`,
    scriptId: SCRIPT_ID,
    targets: TARGETS,
  });

  return { stub, sync, allowlist: allowlistRef };
}

function execScriptCalls(stub) {
  return stub.calls.entries.filter((c) => c.api === 'scripting.executeScript');
}

test('1. cold install on a YT tab registers the shield and injects into the open tab', async () => {
  const { stub, sync } = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
  });
  // No existing frames returned by stub → falls through to the URL-only path.

  await sync.syncRegistration();

  const registered = await stub.scripting.getRegisteredContentScripts();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, SCRIPT_ID);
  assert.deepEqual(registered[0].excludeMatches, []);

  // Injected into the open tab without waiting for navigation.
  const injects = execScriptCalls(stub);
  assert.equal(injects.length, 1);
  assert.deepEqual(injects[0].target, { tabId: 1 });
});

test('2. allowlist add on open YT tab updates excludeMatches without page reload', async () => {
  const { stub, sync, allowlist } = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
  });
  await sync.syncRegistration();
  stub.calls.clear();

  // User toggles allowlist for youtube.com.
  allowlist.current.add('youtube.com');
  await sync.syncRegistration();

  const registered = await stub.scripting.getRegisteredContentScripts();
  assert.deepEqual(
    registered[0].excludeMatches.sort(),
    TARGETS.map((t) => t.pattern).sort()
  );

  // updateContentScripts must have been called (delta path), not full
  // unregister + register.
  const updates = stub.calls.entries.filter((c) => c.api === 'scripting.updateContentScripts');
  const unregs = stub.calls.entries.filter((c) => c.api === 'scripting.unregisterContentScripts');
  assert.equal(updates.length, 1, 'expected exactly one updateContentScripts call');
  assert.equal(unregs.length, 0, 'must not have torn down the registration');
});

test('3. allowlist remove on open allowlisted YT tab re-injects without page reload', async () => {
  const { stub, sync, allowlist } = setupHarness({
    allowlist: ['youtube.com'],
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
  });
  await sync.syncRegistration();
  // After initial sync, all YT patterns are in excludeMatches and tab is
  // not injected into.
  const initialInjects = execScriptCalls(stub).length;
  stub.calls.clear();

  // User removes from allowlist.
  allowlist.current.delete('youtube.com');
  await sync.syncRegistration();

  const registered = await stub.scripting.getRegisteredContentScripts();
  assert.deepEqual(registered[0].excludeMatches, []);

  // The previously-allowlisted tab must now be injected into.
  const injects = execScriptCalls(stub);
  assert.ok(injects.length > 0,
    `expected re-injection into open tab on allowlist removal; got ${injects.length} (initial was ${initialInjects})`);
  assert.deepEqual(injects[0].target, { tabId: 1 });
});

test('4. two YT tabs, allowlist toggle on one — both must reflect the new excludeMatches', async () => {
  const { stub, sync, allowlist } = setupHarness({
    tabs: [
      { id: 1, url: 'https://www.youtube.com/' },
      { id: 2, url: 'https://music.youtube.com/' },
    ],
  });
  await sync.syncRegistration();
  stub.calls.clear();

  allowlist.current.add('youtube.com');
  await sync.syncRegistration();

  // excludeMatches is per-registration, not per-tab — both tabs share state.
  const registered = await stub.scripting.getRegisteredContentScripts();
  assert.deepEqual(
    registered[0].excludeMatches.sort(),
    TARGETS.map((t) => t.pattern).sort()
  );
});

test('5. music.youtube.com allowlist isolates: www.youtube.com still receives shield', async () => {
  const { stub, sync } = setupHarness({
    allowlist: ['music.youtube.com'],
    tabs: [
      { id: 1, url: 'https://www.youtube.com/' },
      { id: 2, url: 'https://music.youtube.com/' },
    ],
  });
  await sync.syncRegistration();

  const registered = await stub.scripting.getRegisteredContentScripts();
  assert.deepEqual(
    registered[0].excludeMatches,
    ['*://music.youtube.com/*'],
    'only music.youtube.com pattern should be excluded'
  );

  // music tab must not be injected; www tab must.
  const injects = execScriptCalls(stub);
  const targetTabIds = injects.map((c) => c.target.tabId);
  assert.ok(targetTabIds.includes(1), 'www tab must be injected');
  assert.ok(!targetTabIds.includes(2), 'music tab must not be injected');
});

test('6. SW restart simulation: with persistAcrossSessions=true, a re-registration with same shape is a no-op (shieldNoReinject on)', async () => {
  const { stub, sync } = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
    isFeatureEnabled: (name) => name === 'shieldNoReinject',
  });
  await sync.syncRegistration();
  // Verify persistAcrossSessions was set so Chrome would keep the registration
  // across SW termination — the whole point of MV3's persist flag.
  const registered = await stub.scripting.getRegisteredContentScripts();
  assert.equal(registered[0].persistAcrossSessions, true);

  stub.calls.clear();
  // Simulate SW restart: same allowlist, same registration shape arrives.
  await sync.syncRegistration();

  // Must NOT churn the registration — same-shape is the short-circuit branch.
  const updates = stub.calls.entries.filter((c) => c.api === 'scripting.updateContentScripts');
  const regs = stub.calls.entries.filter((c) => c.api === 'scripting.registerContentScripts');
  assert.equal(updates.length, 0);
  assert.equal(regs.length, 0);
  // §5.18 — and no injection either. A persisted registration is injected by
  // Chrome into every new document, including one opened while the worker was
  // asleep; re-injecting here evaluates the bundle a second time in every open
  // tab on every wake. Only a *changed* excludeMatches needs live tabs touched
  // (#3, #4), and that is not this branch.
  assert.equal(execScriptCalls(stub).length, 0);
});

test('6b (flag off): same-shape re-sync still injects', async () => {
  // Default dependency (`() => false`): today's soak behaviour, pinned so the
  // flag-off path stays byte-for-byte what shipped.
  const { stub, sync } = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
  });
  await sync.syncRegistration();
  stub.calls.clear();

  await sync.syncRegistration();

  const updates = stub.calls.entries.filter((c) => c.api === 'scripting.updateContentScripts');
  const regs = stub.calls.entries.filter((c) => c.api === 'scripting.registerContentScripts');
  assert.equal(updates.length, 0);
  assert.equal(regs.length, 0);
  const injects = execScriptCalls(stub);
  assert.equal(injects.length, 1);
  assert.deepEqual(injects[0].target, { tabId: 1 });
});

test('5.18 (flag on): an excludeMatches-only update still injects — #3 must not regress', async () => {
  // The flag skips the same-registration branch and nothing else: a host
  // removed from the allowlist needs the live injection, since Chrome only
  // applies the new excludeMatches to future documents.
  const { stub, sync, allowlist } = setupHarness({
    allowlist: ['youtube.com'],
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
    isFeatureEnabled: (name) => name === 'shieldNoReinject',
  });
  await sync.syncRegistration();
  stub.calls.clear();

  allowlist.current.delete('youtube.com');
  await sync.syncRegistration();

  const updates = stub.calls.entries.filter((c) => c.api === 'scripting.updateContentScripts');
  assert.equal(updates.length, 1, 'still the delta path');
  const injects = execScriptCalls(stub);
  assert.equal(injects.length, 1);
  assert.deepEqual(injects[0].target, { tabId: 1 });
});

test('5.18 (flag on): a fresh registration still injects — #1 must not regress', async () => {
  const { stub, sync } = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
    isFeatureEnabled: (name) => name === 'shieldNoReinject',
  });

  await sync.syncRegistration();

  const regs = stub.calls.entries.filter((c) => c.api === 'scripting.registerContentScripts');
  assert.equal(regs.length, 1);
  const injects = execScriptCalls(stub);
  assert.equal(injects.length, 1);
  assert.deepEqual(injects[0].target, { tabId: 1 });
});

test('5.18: the flag is read on every sync, not captured when the module is created', async () => {
  // The SW's flag cache is filled asynchronously after start-up and can change
  // while the worker lives; a value captured at factory time would make the
  // flag inert on the first wake and stale on every later one.
  const flag = { current: false };
  const { stub, sync } = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
    isFeatureEnabled: (name) => name === 'shieldNoReinject' && flag.current,
  });
  await sync.syncRegistration();

  flag.current = true;
  stub.calls.clear();
  await sync.syncRegistration();
  assert.equal(execScriptCalls(stub).length, 0, 'flag on at sync time: no re-injection');

  flag.current = false;
  stub.calls.clear();
  await sync.syncRegistration();
  assert.equal(execScriptCalls(stub).length, 1, 'flag off again: re-injection resumes');
});

test('7. concurrent sync calls are sequenced, not raced', async () => {
  // The historical bug: AbortController-based cancellation made the second of
  // two close-in-time mutations abort the first, sometimes leaving the
  // *intermediate* state as final. The current impl chains via the in-flight
  // promise so the last call to resolve is always the latest state.
  const { stub, sync, allowlist } = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
  });
  await sync.syncRegistration();
  stub.calls.clear();

  // Fire three mutations without awaiting between them.
  allowlist.current.add('youtube.com');
  const p1 = sync.syncRegistration();
  allowlist.current.delete('youtube.com');
  const p2 = sync.syncRegistration();
  allowlist.current.add('music.youtube.com');
  const p3 = sync.syncRegistration();

  await Promise.all([p1, p2, p3]);

  // Final state must reflect the last call.
  const registered = await stub.scripting.getRegisteredContentScripts();
  assert.deepEqual(
    registered[0].excludeMatches,
    ['*://music.youtube.com/*'],
    'final state must match the last submitted allowlist'
  );
});

test('contract: same-registration short-circuit considers persistAcrossSessions', async () => {
  // Direct assertion that the equality check includes persistAcrossSessions —
  // the field that was missing before commit f9b4f39 and caused every refresh
  // to redundantly re-register.
  const { stub, sync } = setupHarness();
  await sync.syncRegistration();
  // Tamper with the stored registration so persistAcrossSessions disagrees.
  const reg = stub.scripting._registered.get(SCRIPT_ID);
  reg.persistAcrossSessions = false;

  stub.calls.clear();
  await sync.syncRegistration();

  // Must NOT take the same-registration short-circuit; must update or
  // re-register so the field is corrected.
  const updates = stub.calls.entries.filter((c) => c.api === 'scripting.updateContentScripts');
  const regs = stub.calls.entries.filter((c) => c.api === 'scripting.registerContentScripts');
  assert.ok(
    updates.length + regs.length > 0,
    'persistAcrossSessions mismatch must trigger a re-register or update'
  );
});

test('contract: registration always uses runAt=document_start, world=MAIN, allFrames=true', async () => {
  const { stub, sync } = setupHarness();
  await sync.syncRegistration();
  const [reg] = await stub.scripting.getRegisteredContentScripts();
  assert.equal(reg.runAt, 'document_start');
  assert.equal(reg.world, 'MAIN');
  assert.equal(reg.allFrames, true);
});
