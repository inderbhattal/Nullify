/**
 * Bullseye regression suite for the YouTube shield sync module.
 *
 * These are the scenarios from docs/IMPLEMENTATION.md §7 that, taken together,
 * would have prevented every YouTube outage in the project's git history (see
 * commits b327340, 3a35970, f9b4f39).
 *
 * Each test wires a fresh chrome-stub into createYouTubeShieldSync and
 * asserts the observable side effects on stub.scripting.* and stub.calls.
 *
 * Numbering, honestly: these are *proxies* for §7's scenarios, which describe a
 * real browser (`tests/regression/youtube/` does not exist). 1 through 6 line
 * up. Test 7 below does NOT: §7's #7 is "upgrade in place" — install v(N-1),
 * browse YouTube, reload the extension, verify blocking continues with no
 * manual refresh — and nothing in this repository covers it. It is the other
 * half of the case §7.9's extension-life sweep addresses, so it is the obvious
 * gap to close next; it is recorded here rather than invented, because a
 * convincing one needs a real extension reload, not a stub.
 *
 * `shieldNoReinject` (§5.18) changes when open tabs are injected into, so the
 * scenarios that must be flag-independent run under both settings — see
 * `FLAG_MODES`.
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

// The flag settings every scenario that must be flag-independent runs under.
// `undefined` exercises the factory's own default (`() => false`).
const FLAG_MODES = [
  ['flag off', undefined],
  ['flag on', (name) => name === 'shieldNoReinject'],
];

const SHIELD_ON = (name) => name === 'shieldNoReinject';

// `isFeatureEnabled` is injected, not imported: this harness never assigns
// `globalThis.chrome`, so a storage-backed flag read could not see the stub.
//
// `stub` reuses an existing chrome-stub, which is how a *new service worker*
// is simulated: the module's own state is gone (a new factory) but Chrome's
// registration store and `storage.session` are not. Clearing
// `stub.storage.session` on top of that is a new *extension* life.
//
// The three fault hooks make the failures `injectIntoOpenTabs` swallows
// observable. They are mutable through the returned `faults` handle, so a test
// can make a call fail on one sync and succeed on the next.
function setupHarness({
  allowlist = new Set(),
  tabs = [],
  isFeatureEnabled,
  stub: existingStub = null,
  failInject = null,
  failQuery = false,
  failFrames = null,
} = {}) {
  const stub = existingStub || makeChromeStub();
  for (const tab of tabs) stub.tabs._addTab(tab);

  if (!stub._faults) {
    stub._faults = { inject: null, query: false, frames: null };
    // Each wrapper delegates first, so the attempt is recorded in `calls`
    // exactly as a successful one would be, and only then rejects.
    const realExec = stub.scripting.executeScript;
    stub.scripting.executeScript = async (injection) => {
      const out = await realExec.call(stub.scripting, injection);
      if (stub._faults.inject?.(injection)) {
        throw new Error('Cannot access contents of the page');
      }
      return out;
    };
    const realQuery = stub.tabs.query;
    stub.tabs.query = async (filter) => {
      const out = await realQuery.call(stub.tabs, filter);
      if (stub._faults.query) throw new Error('Tabs cannot be queried right now');
      return out;
    };
    const realFrames = stub.webNavigation.getAllFrames;
    stub.webNavigation.getAllFrames = async (arg) => {
      const out = await realFrames.call(stub.webNavigation, arg);
      if (stub._faults.frames?.(arg?.tabId)) throw new Error('No tab with given id');
      return out;
    };
  }
  stub._faults.inject = failInject;
  stub._faults.query = failQuery;
  stub._faults.frames = failFrames;

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

  return { stub, sync, allowlist: allowlistRef, faults: stub._faults };
}

function execScriptCalls(stub) {
  return stub.calls.entries.filter((c) => c.api === 'scripting.executeScript');
}

const injectedTabIds = (stub) =>
  execScriptCalls(stub).map((c) => c.target.tabId).sort((a, b) => a - b);

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

// Scenarios 2, 4 and 5 are about the registration's shape, which no flag may
// touch. Running each under both settings costs nothing and proves it, and is
// what closes the flag-on coverage gap the §5.18 second review found: with the
// flag on, only #1, #3 and #6 were being exercised.
for (const [mode, isFeatureEnabled] of FLAG_MODES) {
  test(`2 (${mode}). allowlist add on open YT tab updates excludeMatches without page reload`, async () => {
    const { stub, sync, allowlist } = setupHarness({
      tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
      isFeatureEnabled,
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

  test(`4 (${mode}). two YT tabs, allowlist toggle on one — both must reflect the new excludeMatches`, async () => {
    const { stub, sync, allowlist } = setupHarness({
      tabs: [
        { id: 1, url: 'https://www.youtube.com/' },
        { id: 2, url: 'https://music.youtube.com/' },
      ],
      isFeatureEnabled,
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

  test(`5 (${mode}). music.youtube.com allowlist isolates: www.youtube.com still receives shield`, async () => {
    const { stub, sync } = setupHarness({
      allowlist: ['music.youtube.com'],
      tabs: [
        { id: 1, url: 'https://www.youtube.com/' },
        { id: 2, url: 'https://music.youtube.com/' },
      ],
      isFeatureEnabled,
    });
    await sync.syncRegistration();

    const registered = await stub.scripting.getRegisteredContentScripts();
    assert.deepEqual(
      registered[0].excludeMatches,
      ['*://music.youtube.com/*'],
      'only music.youtube.com pattern should be excluded'
    );

    // music tab must not be injected; www tab must.
    const targetTabIds = injectedTabIds(stub);
    assert.ok(targetTabIds.includes(1), 'www tab must be injected');
    assert.ok(!targetTabIds.includes(2), 'music tab must not be injected');
  });
}

test('4b (flag on): two YT tabs, allowlist toggle on one — only the tab that changed state is touched', async () => {
  // §7's #4 is about *per-tab* targeting, which the shared-registration case
  // above cannot show: allowlisting "youtube.com" covers both tabs. Toggle the
  // music subdomain only, with the flag on, and watch which tab is injected.
  const { stub, sync, allowlist } = setupHarness({
    tabs: [
      { id: 1, url: 'https://www.youtube.com/' },
      { id: 2, url: 'https://music.youtube.com/' },
    ],
    isFeatureEnabled: SHIELD_ON,
  });
  await sync.syncRegistration();
  assert.deepEqual(injectedTabIds(stub), [1, 2], 'both tabs shielded on the fresh registration');
  stub.calls.clear();

  allowlist.current.add('music.youtube.com');
  await sync.syncRegistration();

  let registered = await stub.scripting.getRegisteredContentScripts();
  assert.deepEqual(registered[0].excludeMatches, ['*://music.youtube.com/*']);
  assert.deepEqual(injectedTabIds(stub), [1],
    'the allowlisted tab must not be injected; the other must still be reachable');

  stub.calls.clear();
  allowlist.current.delete('music.youtube.com');
  await sync.syncRegistration();

  registered = await stub.scripting.getRegisteredContentScripts();
  assert.deepEqual(registered[0].excludeMatches, []);
  assert.deepEqual(injectedTabIds(stub), [1, 2],
    'removing the entry must bring the music tab back without a reload');
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
  // §7.9 — the first sync after the flag comes on still sweeps, and marks the
  // extension life as swept. Nothing had marked it: Rule 2 keeps the flag-off
  // path free of storage writes, so the syncs before this one left no trace,
  // and the conservative answer to "has this life been swept?" is no. One
  // redundant pass per flag flip, in exchange for never skipping a real one.
  assert.deepEqual(injectedTabIds(stub), [1], 'the first flag-on sync sweeps and marks the life');

  stub.calls.clear();
  await sync.syncRegistration();
  assert.equal(execScriptCalls(stub).length, 0, 'flag on at sync time: no re-injection');

  flag.current = false;
  stub.calls.clear();
  await sync.syncRegistration();
  assert.equal(execScriptCalls(stub).length, 1, 'flag off again: re-injection resumes');
});

// ---------------------------------------------------------------------------
// §7.9 — the same-registration branch is the only repair path for a YouTube
// document the persisted registration never actually reached, and with
// `shieldNoReinject` on it was removed outright. `registerContentScripts` and
// `injectIntoOpenTabs` are the only two ways the shield ever enters a page, so
// when both are skipped the tab stays unshielded until the user navigates:
// ads playing with the extension enabled and the popup saying the site is not
// allowlisted. Repair is now bounded, so §5.18's win survives (test 6 and
// "a new worker in the same extension life", below, pin that).
// ---------------------------------------------------------------------------

test('7.9 (flag on): a tab whose injection was swallowed is repaired on the next sync', async () => {
  const { stub, sync, faults } = setupHarness({
    tabs: [
      { id: 1, url: 'https://www.youtube.com/' },
      { id: 2, url: 'https://music.youtube.com/' },
    ],
    isFeatureEnabled: SHIELD_ON,
    // Tab 1 is mid-navigation when the first sync runs — the real shape of
    // bullseye #1, "fresh install with a YouTube tab already open".
    failInject: (injection) => injection.target.tabId === 1,
  });

  await sync.syncRegistration();
  assert.deepEqual(injectedTabIds(stub), [1, 2], 'both were attempted');

  faults.inject = null; // the transient condition clears
  stub.calls.clear();
  await sync.syncRegistration();

  assert.deepEqual(injectedTabIds(stub), [1],
    'the tab the failed injection missed must be repaired, and only that tab');

  stub.calls.clear();
  await sync.syncRegistration();
  assert.equal(execScriptCalls(stub).length, 0,
    'once repaired, §5.18 holds again: no re-injection on a clean wake');
});

test('7.9 (flag on): a failed tabs.query makes the next sync sweep rather than skip', async () => {
  const { stub, sync, faults } = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
    isFeatureEnabled: SHIELD_ON,
    failQuery: true,
  });

  await sync.syncRegistration();
  assert.equal(execScriptCalls(stub).length, 0, 'the query failed, so no tab was reached');

  faults.query = false;
  stub.calls.clear();
  await sync.syncRegistration();

  assert.deepEqual(injectedTabIds(stub), [1],
    'a query failure hides which tabs were missed, so the next sync sweeps');
});

test('7.9 (flag on): a tab whose frame list could not be read is repaired', async () => {
  // A getAllFrames rejection degrades to the tab-URL path, which reaches the
  // top frame only — the sub-frames the registration covers are missed.
  const { stub, sync, faults } = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
    isFeatureEnabled: SHIELD_ON,
    failFrames: (tabId) => tabId === 1,
  });

  await sync.syncRegistration();
  stub.calls.clear();

  faults.frames = null;
  stub.webNavigation._setFrames(1, [
    { frameId: 0, url: 'https://www.youtube.com/' },
    { frameId: 7, url: 'https://www.youtube.com/embed/x' },
  ]);
  await sync.syncRegistration();

  const frameIds = execScriptCalls(stub).map((c) => c.target.frameIds?.[0]).sort();
  assert.deepEqual(frameIds, [0, 7], 'both frames must be reached on the repair pass');
});

test('7.9 (flag on): the first sync of a new extension life sweeps the open tabs', async () => {
  const first = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
    isFeatureEnabled: SHIELD_ON,
  });
  await first.sync.syncRegistration();
  first.stub.calls.clear();

  // The extension is disabled and re-enabled (or updated, or its process
  // killed): Chrome keeps the persisted registration, `storage.session` is
  // cleared, and a tab may have loaded during the gap with no registration in
  // force at all. `sameRegistration` is true, so nothing else would touch it.
  await first.stub.storage.session.clear();
  const next = setupHarness({ stub: first.stub, isFeatureEnabled: SHIELD_ON });

  await next.sync.syncRegistration();

  assert.deepEqual(injectedTabIds(next.stub), [1],
    'a document loaded while no registration was in force must be repaired');
});

test('7.9 (flag on, didn\'t re-break §5.18): a new worker in the same extension life does not sweep', async () => {
  const first = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
    isFeatureEnabled: SHIELD_ON,
  });
  await first.sync.syncRegistration();
  first.stub.calls.clear();

  // Worker killed and woken: the module's state is gone, `storage.session`
  // survives. This is the every-wake case §5.18 exists to remove, and it must
  // stay removed — otherwise the repair has simply undone the fix.
  const next = setupHarness({ stub: first.stub, isFeatureEnabled: SHIELD_ON });
  await next.sync.syncRegistration();

  assert.equal(execScriptCalls(next.stub).length, 0,
    'a persisted registration must not be re-evaluated in every open tab on every wake');
});

test('7.9 (flag on): a repair id for a tab that has closed is dropped, not retried forever', async () => {
  const { stub, sync, faults } = setupHarness({
    tabs: [
      { id: 1, url: 'https://www.youtube.com/' },
      { id: 2, url: 'https://www.youtube.com/watch?v=x' },
    ],
    isFeatureEnabled: SHIELD_ON,
    failInject: (injection) => injection.target.tabId === 2,
  });
  await sync.syncRegistration();

  faults.inject = null;
  stub.tabs._removeTab(2); // the user closes the tab that was missed
  stub.calls.clear();
  await sync.syncRegistration();
  assert.equal(execScriptCalls(stub).length, 0, 'a closed tab cannot be repaired');

  stub.calls.clear();
  await sync.syncRegistration();
  const queries = stub.calls.entries.filter((c) => c.api === 'tabs.query');
  assert.deepEqual(queries, [],
    'the stale id must have been dropped, so a later wake costs not even a tab query');
});

test('6c (flag off): the whole path reads and writes no session storage', async () => {
  // Rule 2: with the flag off the path must be byte-for-byte what shipped, so
  // the extension-life marker must not be written on any sync — not just not
  // read on the second one.
  const { stub, sync } = setupHarness({
    tabs: [{ id: 1, url: 'https://www.youtube.com/' }],
  });
  await sync.syncRegistration();
  await sync.syncRegistration();

  const storageCalls = stub.calls.entries.filter((c) => String(c.api).startsWith('storage.'));
  assert.deepEqual(storageCalls, [], 'flag off must touch no storage at all');
  assert.deepEqual(injectedTabIds(stub), [1, 1],
    'and must still inject on both syncs, as it does today');
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
