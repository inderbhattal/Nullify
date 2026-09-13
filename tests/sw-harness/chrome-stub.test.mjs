import assert from 'node:assert/strict';
import test from 'node:test';

import { makeChromeStub } from './chrome-stub.mjs';

test('chrome-stub: storage round-trip + key shapes', async () => {
  const stub = makeChromeStub();
  await stub.storage.local.set({ foo: 1, bar: 'two' });
  assert.deepEqual(await stub.storage.local.get('foo'), { foo: 1 });
  assert.deepEqual(await stub.storage.local.get(['foo', 'bar']), { foo: 1, bar: 'two' });
  assert.deepEqual(await stub.storage.local.get(null), { foo: 1, bar: 'two' });
  assert.deepEqual(await stub.storage.local.get({ foo: 0, missing: 99 }), { foo: 1, missing: 99 });
});

test('chrome-stub: storage areas are independent', async () => {
  const stub = makeChromeStub();
  await stub.storage.local.set({ key: 'local' });
  await stub.storage.session.set({ key: 'session' });
  assert.equal((await stub.storage.local.get('key')).key, 'local');
  assert.equal((await stub.storage.session.get('key')).key, 'session');
});

test('chrome-stub: dnr.updateDynamicRules adds + removes', async () => {
  const stub = makeChromeStub();
  await stub.declarativeNetRequest.updateDynamicRules({
    addRules: [{ id: 1, action: { type: 'block' } }, { id: 2, action: { type: 'block' } }],
  });
  assert.equal((await stub.declarativeNetRequest.getDynamicRules()).length, 2);
  await stub.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] });
  const remaining = await stub.declarativeNetRequest.getDynamicRules();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 2);
});

test('chrome-stub: dnr.updateDynamicRules rejects duplicate ids', async () => {
  const stub = makeChromeStub();
  await stub.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1 }] });
  await assert.rejects(
    () => stub.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 1 }] }),
    /Duplicate rule id 1/,
  );
});

test('chrome-stub: scripting registration lifecycle', async () => {
  const stub = makeChromeStub();
  await stub.scripting.registerContentScripts([
    { id: 'a', matches: ['*://example.com/*'], js: ['x.js'] },
  ]);
  assert.equal((await stub.scripting.getRegisteredContentScripts()).length, 1);

  await stub.scripting.updateContentScripts([{ id: 'a', excludeMatches: ['*://example.com/skip'] }]);
  const [script] = await stub.scripting.getRegisteredContentScripts({ ids: ['a'] });
  assert.deepEqual(script.excludeMatches, ['*://example.com/skip']);

  await stub.scripting.unregisterContentScripts({ ids: ['a'] });
  assert.equal((await stub.scripting.getRegisteredContentScripts()).length, 0);
});

test('chrome-stub: scripting.updateContentScripts rejects unknown id', async () => {
  const stub = makeChromeStub();
  await assert.rejects(
    () => stub.scripting.updateContentScripts([{ id: 'missing' }]),
    /No registration for id missing/,
  );
});

test('chrome-stub: tabs.query filters by url pattern', async () => {
  const stub = makeChromeStub();
  stub.tabs._addTab({ id: 1, url: 'https://www.youtube.com/watch?v=x' });
  stub.tabs._addTab({ id: 2, url: 'https://music.youtube.com/' });
  stub.tabs._addTab({ id: 3, url: 'https://example.com/' });

  const yt = await stub.tabs.query({ url: '*://*.youtube.com/*' });
  assert.deepEqual(yt.map((t) => t.id).sort(), [1, 2]);

  const all = await stub.tabs.query();
  assert.equal(all.length, 3);
});

test('chrome-stub: webNavigation.getAllFrames returns null when unset', async () => {
  const stub = makeChromeStub();
  assert.equal(await stub.webNavigation.getAllFrames({ tabId: 99 }), null);
  stub.webNavigation._setFrames(99, [{ frameId: 0, url: 'https://example.com/' }]);
  const frames = await stub.webNavigation.getAllFrames({ tabId: 99 });
  assert.equal(frames.length, 1);
});

test('chrome-stub: contextMenus emits lastError on duplicate id', () => {
  const stub = makeChromeStub();
  let firstErr;
  stub.contextMenus.create({ id: 'x', title: 't', contexts: ['all'] }, () => { firstErr = stub.runtime.lastError; });
  let secondErr;
  stub.contextMenus.create({ id: 'x', title: 't', contexts: ['all'] }, () => { secondErr = stub.runtime.lastError; });
  assert.equal(firstErr, null);
  assert.match(secondErr?.message || '', /duplicate/i);
});

test('chrome-stub: runtime.sendMessage delivers to listeners', async () => {
  const stub = makeChromeStub();
  let received = null;
  stub.runtime.onMessage.addListener((message, sender, sendResponse) => {
    received = { message, senderId: sender.id };
    sendResponse({ ok: true });
  });
  const response = await stub.runtime.sendMessage({ type: 'PING' });
  assert.deepEqual(received, { message: { type: 'PING' }, senderId: 'nullify-test-id' });
  assert.deepEqual(response, { ok: true });
});

test('chrome-stub: alarms create + clear', async () => {
  const stub = makeChromeStub();
  await stub.alarms.create('tick', { periodInMinutes: 5 });
  assert.deepEqual((await stub.alarms.get('tick')), { name: 'tick', periodInMinutes: 5 });
  assert.equal(await stub.alarms.clear('tick'), true);
  assert.equal(await stub.alarms.get('tick'), null);
});

test('chrome-stub: call log records every API touch', async () => {
  const stub = makeChromeStub();
  await stub.storage.local.set({ a: 1 });
  await stub.storage.local.get('a');
  await stub.declarativeNetRequest.updateDynamicRules({ addRules: [{ id: 7 }] });
  const apis = stub.calls.entries.map((c) => c.api);
  assert.deepEqual(apis, ['storage.set', 'storage.get', 'dnr.updateDynamicRules']);
});

// --- REVIEW-2026-09 §3.1 / §7.7 — read-fault injection, requestMethods ------

test('_failNextRead fires once and clears lastError after the callback', async () => {
  const stub = makeChromeStub();
  await stub.storage.local.set({ allowlist: ['a.example'], other: 1 });

  const fired = stub.storage.local._failNextRead((keys) => keys.includes('allowlist'));
  assert.equal(fired(), false);

  // A non-matching read is untouched and does not consume the fault.
  assert.deepEqual(await stub.storage.local.get('other'), { other: 1 });
  assert.equal(fired(), false);

  // Callback form: Chrome's contract — result undefined, lastError set for
  // the duration of the callback only.
  const seen = await new Promise((resolve) => {
    stub.storage.local.get(['allowlist'], (result) => {
      resolve({ result, lastError: stub.runtime.lastError });
    });
  });
  assert.equal(seen.result, undefined);
  assert.equal(seen.lastError?.message, 'An unexpected error occurred');
  assert.equal(stub.runtime.lastError, null, 'lastError must be cleared once the callback returns');
  assert.equal(fired(), true);

  // One-shot: the same read succeeds afterwards.
  assert.deepEqual(await stub.storage.local.get(['allowlist']), { allowlist: ['a.example'] });

  // Promise form rejects; the string-key form reaches the predicate as an array.
  const firedAgain = stub.storage.local._failNextRead((keys) => keys.length === 1 && keys[0] === 'other');
  await assert.rejects(() => stub.storage.local.get('other'), /An unexpected error occurred/);
  assert.equal(firedAgain(), true);

  // The call log marks the faulted read.
  assert.equal(stub.calls.entries.filter((c) => c.api === 'storage.get' && c.failed).length, 2);
});

test('7.7: the stub rejects a requestMethods value Chrome rejects', async () => {
  const stub = makeChromeStub();
  const rule = (id, condition) => ({
    id, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||x.example^', ...condition },
  });

  for (const [condition, why] of [
    [{ requestMethods: [] }, 'empty list'],
    [{ requestMethods: ['GET'] }, 'uppercase'],
    [{ requestMethods: ['fetch'] }, 'not in the enum'],
    [{ excludedRequestMethods: [42] }, 'non-string'],
  ]) {
    await assert.rejects(
      () => stub.declarativeNetRequest.updateDynamicRules({ addRules: [rule(1, condition)] }),
      /requestMethods|excludedRequestMethods/,
      `expected a rejection for ${why}`,
    );
  }
  assert.equal((await stub.declarativeNetRequest.getDynamicRules()).length, 0,
    'a rejected batch must leave state untouched');

  await stub.declarativeNetRequest.updateDynamicRules({
    addRules: [rule(1, { requestMethods: ['get', 'post'] }), rule(2, { excludedRequestMethods: ['other'] })],
  });
  assert.equal((await stub.declarativeNetRequest.getDynamicRules()).length, 2);
});
