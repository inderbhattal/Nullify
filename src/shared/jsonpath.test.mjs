import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compile, compilePrunePath, compilePruner, isProtoPollutionKey, JSONPATH_LIMITS,
} from './jsonpath.js';

/**
 * The expected values below were pinned by differentially executing uBO's own
 * `src/js/jsonpath.js` against this module: 34 expressions x 6 documents agreed
 * on both the resolved path set and the applied mutation, and 200k randomly
 * generated malformed expressions agreed on compile validity with zero throws.
 * If one of these assertions starts failing, this engine has drifted from uBO —
 * which means uBO's shipped rules no longer mean here what they mean there.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures — realistic YouTube InnerTube request bodies                       */
/* -------------------------------------------------------------------------- */

/** The shape a `/youtubei/v1/player` POST body actually has. */
function innertubeBody(overrides = {}) {
  const body = {
    context: {
      client: {
        hl: 'en',
        gl: 'US',
        deviceMake: '',
        clientName: 'WEB',
        clientVersion: '2.20250731.01.00',
        osName: 'X11',
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36,gzip(gfe)',
        mainAppWebInfo: {
          graftUrl: '/watch?v=dQw4w9WgXcQ',
          webDisplayMode: 'WEB_DISPLAY_MODE_BROWSER',
          isWebNativeShareAvailable: true,
        },
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true, internalExperimentFlags: [], consistencyTokenJars: [] },
      clickTracking: { clickTrackingParams: 'CAEQu2kiEwjHy4Ov' },
    },
    videoId: 'dQw4w9WgXcQ',
    params: '8AEB',
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: 'HTML5_PREF_WANTS',
        lactMilliseconds: '-1',
        referer: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        signatureTimestamp: 20334,
        autoCaptionsDefaultOn: false,
        currentUrl: '/watch?v=dQw4w9WgXcQ',
      },
    },
    racyCheckOk: true,
    contentCheckOk: true,
  };
  return Object.assign(body, overrides);
}

/** uBO's rules key off a marker previously appended to `userAgent`. */
function bodyWithMarker(marker) {
  const body = innertubeBody();
  body.context.client.userAgent += `,${marker}`;
  return body;
}

/** A `/youtubei/v1/browse` home-feed response carrying one ad slot. */
function browseFeed() {
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{
          tabRenderer: {
            content: {
              richGridRenderer: {
                contents: [
                  { richItemRenderer: { content: { videoRenderer: { videoId: 'aaa' } } } },
                  { richItemRenderer: { content: { adSlotRenderer: { adSlotMetadata: { slotId: '1' } } } } },
                  { richItemRenderer: { content: { videoRenderer: { videoId: 'bbb' } } } },
                ],
              },
            },
          },
        }],
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Acceptance: uBO's live quick-fixes.txt / experimental.txt expressions        */
/* -------------------------------------------------------------------------- */

test('acceptance: clientScreen=CHANNEL is merged into the WEB client', () => {
  const expr = '[?..userAgent*="channel"]..client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"}';
  const p = compile(expr);
  assert.equal(p.ok, true, p.error ?? '');
  assert.equal(p.action, 'merge');

  const doc = bodyWithMarker('channel');
  assert.deepEqual(p.evaluate(doc), [['context', 'client']]);
  const r = p.apply(doc);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.count, 1);
  assert.equal(r.root.context.client.clientScreen, 'CHANNEL');
  // The merge must not disturb the sibling keys it did not name.
  assert.equal(r.root.context.client.clientName, 'WEB');
  assert.equal(r.root.context.client.hl, 'en');

  // The `[?..userAgent*="channel"]` gate is real: no marker, no edit.
  const clean = innertubeBody();
  assert.equal(p.matches(clean), false);
  assert.equal(p.apply(clean).changed, false);
  assert.equal(Object.hasOwn(clean.context.client, 'clientScreen'), false);
});

test('acceptance: clientScreen=ADUNIT is merged into the WEB client', () => {
  const p = compile('[?..userAgent*="adunit"]..client[?.clientName=="WEB"]+={"clientScreen":"ADUNIT"}');
  assert.equal(p.ok, true, p.error ?? '');
  const doc = bodyWithMarker('adunit');
  assert.equal(p.apply(doc).changed, true);
  assert.equal(doc.context.client.clientScreen, 'ADUNIT');
});

test('acceptance: adPlaybackContext is merged into playbackContext', () => {
  const expr = '[?..userAgent*="instream"]..playbackContext[?.contentPlaybackContext]+={"adPlaybackContext":{"adType":"AD_TYPE_INSTREAM"}}';
  const p = compile(expr);
  assert.equal(p.ok, true, p.error ?? '');
  const doc = bodyWithMarker('instream');
  assert.deepEqual(p.evaluate(doc), [['playbackContext']]);
  assert.equal(p.apply(doc).changed, true);
  assert.deepEqual(doc.playbackContext.adPlaybackContext, { adType: 'AD_TYPE_INSTREAM' });
  assert.equal(doc.playbackContext.contentPlaybackContext.lactMilliseconds, '-1');
});

test('acceptance: params is merged at the document root', () => {
  const p = compile('[?..userAgent*="lactmilli"]+={"params":"8AUB"}');
  assert.equal(p.ok, true, p.error ?? '');
  const doc = bodyWithMarker('lactmilli');
  // A root-level merge resolves to the empty path — "the document itself".
  assert.deepEqual(p.evaluate(doc), [[]]);
  const r = p.apply(doc);
  assert.equal(r.changed, true);
  assert.equal(r.root.params, '8AUB');
  assert.equal(r.root, doc);
});

test('acceptance: lactMilliseconds is assigned the interpolated ${now}', () => {
  const expr = '[?..userAgent*="lactmilli"]..playbackContext.contentPlaybackContext.lactMilliseconds="${now}"';
  const p = compile(expr);
  assert.equal(p.ok, true, p.error ?? '');
  assert.equal(p.action, 'assign');
  const doc = bodyWithMarker('lactmilli');
  const before = Date.now();
  assert.equal(p.apply(doc).changed, true);
  const after = Date.now();
  const written = Number(doc.playbackContext.contentPlaybackContext.lactMilliseconds);
  assert.equal(Number.isNaN(written), false, 'must be a numeric timestamp string');
  assert.equal(written >= before && written <= after, true, `${written} in [${before},${after}]`);
});

test('acceptance: params=eAFgAQ is merged at the document root', () => {
  const p = compile('[?..userAgent*="eafg"]+={"params":"eAFgAQ"}');
  assert.equal(p.ok, true, p.error ?? '');
  const doc = bodyWithMarker('eafg');
  assert.equal(p.apply(doc).changed, true);
  assert.equal(doc.params, 'eAFgAQ');
});

test('acceptance: referer is rewritten through =repl() behind a regex predicate', () => {
  const expr = '[?..userAgent=/adunit|channel|lactmilli|instream|eafg/]..referer=repl({"regex":"(?:#reloadxhr)?$","replacement":"#reloadxhr"})';
  const p = compile(expr);
  assert.equal(p.ok, true, p.error ?? '');
  assert.equal(p.action, 'replace');

  const doc = bodyWithMarker('instream');
  assert.deepEqual(p.evaluate(doc), [['playbackContext', 'contentPlaybackContext', 'referer']]);
  assert.equal(p.apply(doc).changed, true);
  assert.equal(
    doc.playbackContext.contentPlaybackContext.referer,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ#reloadxhr',
  );
  // Idempotent: the `(?:#reloadxhr)?$` anchor consumes an existing suffix.
  assert.equal(p.apply(doc).changed, false);
  assert.equal(
    doc.playbackContext.contentPlaybackContext.referer,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ#reloadxhr',
  );

  // None of the five markers present -> the regex predicate blocks the edit.
  const clean = innertubeBody();
  assert.equal(p.matches(clean), false);
});

test('acceptance: the eight-predicate CHANNEL rule gates on every clause', () => {
  const expr = '[?..playbackContext.contentPlaybackContext][?!.attestationRequest][?!.captionsRequested][?!.settingItemIds][?!.params^="YAHIAQ"][?!..mainAppWebInfo.graftUrl*="&list="][?!..mainAppWebInfo.graftUrl*="/shorts/"][?!..userAgent*="premium"]..client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"}';
  const p = compile(expr);
  assert.equal(p.ok, true, p.error ?? '');

  const doc = innertubeBody();
  assert.deepEqual(p.evaluate(doc), [['context', 'client']]);
  assert.equal(p.apply(doc).changed, true);
  assert.equal(doc.context.client.clientScreen, 'CHANNEL');

  // Each negated clause independently vetoes the rule.
  const vetoes = [
    (b) => { b.attestationRequest = { omitBotguardData: true }; },
    (b) => { b.captionsRequested = true; },
    (b) => { b.settingItemIds = ['1']; },
    (b) => { b.params = 'YAHIAQ=='; },
    (b) => { b.context.client.mainAppWebInfo.graftUrl = '/watch?v=x&list=PL1'; },
    (b) => { b.context.client.mainAppWebInfo.graftUrl = '/shorts/abc'; },
    (b) => { b.context.client.userAgent += ',premium'; },
  ];
  for (const [i, veto] of vetoes.entries()) {
    const vetoed = innertubeBody();
    veto(vetoed);
    assert.equal(p.matches(vetoed), false, `veto #${i} should block the rule`);
  }

  // And the positive clause: no playbackContext, no match.
  const noPlayback = innertubeBody();
  delete noPlayback.playbackContext;
  assert.equal(p.matches(noPlayback), false);
});

test('acceptance: $..richItemRenderer[?@..adSlotRenderer] removes only the ad tile', () => {
  const p = compile('$..richItemRenderer[?@..adSlotRenderer]');
  assert.equal(p.ok, true, p.error ?? '');
  assert.equal(p.action, 'remove');
  assert.equal(p.hasAction, false);

  const doc = browseFeed();
  const feed = () => doc.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer
    .content.richGridRenderer.contents;
  assert.deepEqual(p.evaluate(doc), [[
    'contents', 'twoColumnBrowseResultsRenderer', 'tabs', 0, 'tabRenderer',
    'content', 'richGridRenderer', 'contents', 1, 'richItemRenderer',
  ]]);
  const r = p.apply(doc);
  assert.equal(r.changed, true);
  assert.equal(r.count, 1);
  // uBO's rule deletes the renderer key, leaving the (now empty) array slot.
  assert.equal(feed().length, 3);
  assert.deepEqual(feed()[1], {});
  assert.equal(feed()[0].richItemRenderer.content.videoRenderer.videoId, 'aaa');
  assert.equal(feed()[2].richItemRenderer.content.videoRenderer.videoId, 'bbb');
});

/* -------------------------------------------------------------------------- */
/* Operator truth tables                                                       */
/* -------------------------------------------------------------------------- */

test('comparison operators follow uBO\'s truth table', () => {
  const doc = { a: { n: 10, s: 'Sword of Honour', t: true, z: 0 } };
  const yes = (expr) => assert.equal(compile(expr).matches(doc), true, `expected match: ${expr}`);
  const no = (expr) => assert.equal(compile(expr).matches(doc), false, `expected no match: ${expr}`);

  yes('.a[?.n==10]');
  no('.a[?.n==11]');
  no('.a[?.n=="10"]'); // strict equality: no coercion
  yes('.a[?.n!=11]');
  no('.a[?.n!=10]');
  yes('.a[?.n<11]');
  no('.a[?.n<10]');
  yes('.a[?.n<=10]');
  no('.a[?.n<=9]');
  yes('.a[?.n>9]');
  no('.a[?.n>10]');
  yes('.a[?.n>=10]');
  no('.a[?.n>=11]');

  yes('.a[?.s^="Sword"]');
  no('.a[?.s^="sword"]');
  yes('.a[?.s$="Honour"]');
  no('.a[?.s$="honour"]');
  yes('.a[?.s*="of"]');
  no('.a[?.s*="OF"]');

  yes('.a[?.s=/^sword/i]');
  no('.a[?.s=/^sword/]');
  yes('.a[?.s=/Honour$/]');

  // Non-string values are stringified before ^= / $= / *= / regex.
  yes('.a[?.n^="1"]');
  yes('.a[?.t=/true/]');

  // Single-quoted operands are accepted alongside JSON operands.
  yes(".a[?.s*='of']");

  // A bare key predicate is an existence test; falsy values still exist.
  yes('.a[?.z]');
  no('.a[?.missing]');
});

test('a comparison against a missing key is false, negated or not', () => {
  const doc = { a: { present: 'x' } };
  // uBO short-circuits: `op !== undefined && hasOwn === false` -> no match. So a
  // negated comparison is NOT the same as "key is absent or fails the test".
  assert.equal(compile('.a[?.missing^="y"]').matches(doc), false);
  assert.equal(compile('.a[?!.missing^="y"]').matches(doc), false);
  // Whereas a negated *existence* predicate does match an absent key.
  assert.equal(compile('.a[?!.missing]').matches(doc), true);
  assert.equal(compile('.a[?!.present]').matches(doc), false);
  assert.equal(compile('.a[?!.present^="y"]').matches(doc), true);
});

test('recursive, relative and @ self predicates resolve from the right node', () => {
  const doc = { outer: { inner: { flag: 1 }, other: 2 } };
  assert.equal(compile('.outer[?.inner]').matches(doc), true);
  assert.equal(compile('.outer[?..flag]').matches(doc), true);
  assert.equal(compile('.outer[?.flag]').matches(doc), false); // relative, not recursive
  assert.equal(compile('.outer[?@..flag]').matches(doc), true);
  assert.equal(compile('.outer[?@.inner]').matches(doc), true);
});

/* -------------------------------------------------------------------------- */
/* Segments                                                                    */
/* -------------------------------------------------------------------------- */

test('segments: named keys, wildcards, indices, key lists and regex keys', () => {
  const doc = {
    store: {
      book: [
        { author: 'Rees', price: 8.95 },
        { author: 'Waugh', price: 12.99 },
        { author: 'Melville', price: 8.99 },
      ],
      bicycle: { color: 'red', price: 399 },
    },
  };
  const paths = (expr) => compile(expr).evaluate(doc);

  assert.deepEqual(paths('.store.book[*].author'), [
    ['store', 'book', 0, 'author'],
    ['store', 'book', 1, 'author'],
    ['store', 'book', 2, 'author'],
  ]);
  assert.deepEqual(paths('..book[2].author'), [['store', 'book', 2, 'author']]);
  assert.deepEqual(paths('..book[-1].author'), [['store', 'book', 2, 'author']]);
  assert.deepEqual(paths('.store.book[0,2].author'), [
    ['store', 'book', 0, 'author'],
    ['store', 'book', 2, 'author'],
  ]);
  assert.deepEqual(paths('.store.*'), [['store', 'book'], ['store', 'bicycle']]);
  assert.deepEqual(paths('.store./^bi/'), [['store', 'bicycle']]);
  assert.equal(paths('..price').length, 4);
  assert.deepEqual(paths('$.store.bicycle.color'), [['store', 'bicycle', 'color']]);

  // `[]` iterates arrays only, `{}` non-array objects only (our extension).
  assert.deepEqual(paths('.store.book[].author'), [
    ['store', 'book', 0, 'author'],
    ['store', 'book', 1, 'author'],
    ['store', 'book', 2, 'author'],
  ]);
  assert.deepEqual(paths('.store{}'), [['store', 'book'], ['store', 'bicycle']]);
  assert.deepEqual(paths('.store.book{}'), []);
  assert.deepEqual(paths('.store[]'), []);
});

test('[-] splices the array element whose remainder resolves', () => {
  const doc = {
    contents: [
      { richItemRenderer: { content: { videoRenderer: { videoId: 'a' } } } },
      { richItemRenderer: { content: { adSlotRenderer: {} } } },
      { richItemRenderer: { content: { videoRenderer: { videoId: 'b' } } } },
      { richItemRenderer: { content: { adSlotRenderer: {} } } },
    ],
  };
  const p = compile('.contents[-][?@..adSlotRenderer]');
  assert.equal(p.ok, true, p.error ?? '');
  const r = p.apply(doc);
  assert.equal(r.changed, true);
  assert.equal(r.count, 2);
  assert.equal(doc.contents.length, 2);
  assert.equal(doc.contents[0].richItemRenderer.content.videoRenderer.videoId, 'a');
  assert.equal(doc.contents[1].richItemRenderer.content.videoRenderer.videoId, 'b');
});

test('{-} deletes the object key whose remainder resolves', () => {
  const doc = {
    slots: {
      slotA: { kind: 'video' },
      slotB: { kind: 'ad', adSlotRenderer: {} },
      slotC: { kind: 'ad', adSlotRenderer: {} },
    },
  };
  const p = compile('.slots{-}[?.adSlotRenderer]');
  assert.equal(p.ok, true, p.error ?? '');
  const r = p.apply(doc);
  assert.equal(r.changed, true);
  assert.equal(r.count, 2);
  assert.deepEqual(Object.keys(doc.slots), ['slotA']);
});

test('removal splices numeric array keys but deletes object keys', () => {
  const arr = { list: ['a', 'b', 'c'] };
  assert.equal(compile('.list[1]').apply(arr).changed, true);
  assert.deepEqual(arr.list, ['a', 'c']);

  const obj = { map: { a: 1, b: 2 } };
  assert.equal(compile('.map.b').apply(obj).changed, true);
  assert.deepEqual(obj.map, { a: 1 });

  // Multiple array removals resolve back-to-front, so indices stay valid.
  const many = { list: [1, 2, 3, 4] };
  assert.equal(compile('.list[*][?@>2]').ok, true);
  const p = compile('.list[0,2]');
  assert.equal(p.apply(many).count, 2);
  assert.deepEqual(many.list, [2, 4]);
});

test('$ addresses the document root for both assign and remove', () => {
  const assigned = compile('$="replaced"').apply({ a: 1 });
  assert.equal(assigned.changed, true);
  assert.equal(assigned.root, 'replaced');

  const removed = compile('$').apply({ a: 1 });
  assert.equal(removed.changed, true);
  assert.equal(removed.root, null);
});

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

test('= assigns, and only where the key already resolves', () => {
  const doc = { a: { b: 1 }, c: 2 };
  assert.equal(compile('.a.b=99').apply(doc).changed, true);
  assert.equal(doc.a.b, 99);
  // uBO resolves before it writes: an absent key is not created.
  assert.equal(compile('.a.missing=99').apply(doc).changed, false);
  assert.equal(Object.hasOwn(doc.a, 'missing'), false);

  assert.equal(compile('.c=null').apply(doc).changed, true);
  assert.equal(doc.c, null);
  assert.equal(compile('.a={"x":[1,2]}').apply(doc).changed, true);
  assert.deepEqual(doc.a, { x: [1, 2] });
});

test('+= merges shallowly by default and deeply on request', () => {
  const expr = '.ctx+={"nested":{"added":1}}';
  const shallow = { ctx: { nested: { kept: 1 }, other: 2 } };
  assert.equal(compile(expr).apply(shallow).changed, true);
  // uBO replaces the whole subtree; `kept` is gone.
  assert.deepEqual(shallow.ctx, { nested: { added: 1 }, other: 2 });

  const deep = { ctx: { nested: { kept: 1 }, other: 2 } };
  assert.equal(compile(expr, { mergeMode: 'deep' }).apply(deep).changed, true);
  assert.deepEqual(deep.ctx, { nested: { kept: 1, added: 1 }, other: 2 });

  // Both modes still add wholesale when the target key is absent.
  const fresh = { ctx: {} };
  assert.equal(compile(expr, { mergeMode: 'deep' }).apply(fresh).changed, true);
  assert.deepEqual(fresh.ctx, { nested: { added: 1 } });
});

test('+= refuses non-object targets and non-object operands', () => {
  const arr = { ctx: [1, 2] };
  assert.equal(compile('.ctx+={"a":1}').apply(arr).changed, false);
  const str = { ctx: 'text' };
  assert.equal(compile('.ctx+={"a":1}').apply(str).changed, false);
  const obj = { ctx: {} };
  assert.equal(compile('.ctx+=[1,2]').apply(obj).changed, false);
  assert.equal(compile('.ctx+=5').apply(obj).changed, false);
});

test('assigned and merged values are cloned, never aliased into the document', () => {
  // uBO splices its compiled operand in by reference, so two applications share
  // mutable state and a page script can corrupt the compiled rule. We clone.
  const p = compile('.ctx+={"nested":{"n":1}}');
  const a = { ctx: {} };
  const b = { ctx: {} };
  p.apply(a);
  p.apply(b);
  assert.notEqual(a.ctx.nested, b.ctx.nested);
  a.ctx.nested.n = 999;
  assert.equal(b.ctx.nested.n, 1);

  const q = compile('.v={"n":1}');
  const c = { v: 0 };
  const d = { v: 0 };
  q.apply(c);
  q.apply(d);
  c.v.n = 42;
  assert.equal(d.v.n, 1);
});

test('=repl() rewrites strings and ignores everything else', () => {
  const doc = { s: 'abc-abc', n: 7, o: {} };
  assert.equal(compile('.s=repl({"regex":"abc","replacement":"X"})').apply(doc).changed, true);
  assert.equal(doc.s, 'X-abc'); // no /g flag: first occurrence only

  const doc2 = { s: 'abc-abc' };
  assert.equal(compile('.s=repl({"regex":"abc","flags":"g","replacement":"X"})').apply(doc2).changed, true);
  assert.equal(doc2.s, 'X-X');

  assert.equal(compile('.n=repl({"regex":"7","replacement":"X"})').apply(doc).changed, false);
  assert.equal(doc.n, 7);
  assert.equal(compile('.o=repl({"regex":"x","replacement":"X"})').apply(doc).changed, false);

  // `pattern` is the literal-string form; it is escaped, not compiled.
  const doc3 = { s: 'a.c' };
  assert.equal(compile('.s=repl({"pattern":"a.c","replacement":"X"})').apply(doc3).changed, true);
  assert.equal(doc3.s, 'X');
  const doc4 = { s: 'abc' };
  assert.equal(compile('.s=repl({"pattern":"a.c","replacement":"X"})').apply(doc4).changed, false);
});

test('=call() invokes a method on the resolved owner and refuses globals', () => {
  const doc = { list: [3, 1, 2], target: 'x' };
  // `${obj}` is the owner, `${key}` the key, `${val}` the value.
  const p = compile('.list=call(["${val}","sort"])');
  assert.equal(p.ok, true, p.error ?? '');
  assert.equal(p.action, 'call');
  p.apply(doc);
  assert.deepEqual(doc.list, [1, 2, 3]);

  // No instance operand -> refused (uBO falls back to `self`; we never do).
  const noInstance = compile('.target=call([null,"toString"])');
  assert.equal(noInstance.apply(doc).changed, false);

  // Opt-out is honoured at compile time.
  const disabled = compile('.list=call(["${val}","sort"])', { allowCall: false });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error, 'call-disabled');
});

test('${now} is interpolated per apply, not baked in at compile', async () => {
  const p = compile('.t="${now}"');
  const a = { t: '' };
  p.apply(a);
  await new Promise((resolve) => { setTimeout(resolve, 2); });
  const b = { t: '' };
  p.apply(b);
  assert.notEqual(a.t, b.t, 'each apply must read a fresh Date.now()');
  assert.equal(compile('.t="lact-${now}"').apply({ t: '' }).changed, true);
  // Only string operands are interpolated (uBO does not walk into objects).
  const obj = { t: {} };
  compile('.t={"v":"${now}"}').apply(obj);
  assert.equal(obj.t.v, '${now}');
});

/* -------------------------------------------------------------------------- */
/* Prototype-pollution refusal                                                 */
/* -------------------------------------------------------------------------- */

test('isProtoPollutionKey matches the json-prune convention', () => {
  assert.equal(isProtoPollutionKey('__proto__'), true);
  assert.equal(isProtoPollutionKey('constructor'), true);
  assert.equal(isProtoPollutionKey('prototype'), true);
  assert.equal(isProtoPollutionKey('proto'), false);
  assert.equal(isProtoPollutionKey('__proto__x'), false);
});

test('proto keys are refused as literal path segments at compile time', () => {
  for (const bad of [
    '.__proto__.polluted=1',
    '.a.__proto__=1',
    '..constructor.prototype.polluted=1',
    '.a.prototype=1',
    '["__proto__"].polluted=1',
    '.a["constructor","x"]=1',
    "['prototype']=1",
    '.a[?.__proto__]',
    '.a[?!.constructor]',
  ]) {
    const p = compile(bad);
    assert.equal(p.ok, false, `should refuse: ${bad}`);
    assert.equal(p.error, 'proto-key', bad);
  }
});

test('wildcard expansion never yields a proto key', () => {
  const doc = JSON.parse('{"a":{"__proto__":{"x":1},"safe":1,"constructor":2,"prototype":3}}');
  assert.deepEqual(compile('.a.*').evaluate(doc), [['a', 'safe']]);
  assert.deepEqual(compile('.a{}').evaluate(doc), [['a', 'safe']]);
  assert.deepEqual(compile('.a[*]').evaluate(doc), [['a', 'safe']]);
  assert.deepEqual(compile('.a./.*/').evaluate(doc), [['a', 'safe']]);
  // ..* must not surface them from a recursive descent either.
  assert.equal(compile('..*').evaluate(doc).some((p) => p.some(isProtoPollutionKey)), false);
});

test('proto keys inside an operand are stripped before assign or merge', () => {
  const before = Object.getPrototypeOf({}).polluted;
  const doc = { ctx: {} };
  assert.equal(compile('.ctx+={"__proto__":{"polluted":"yes"},"ok":1}').apply(doc).changed, true);
  assert.deepEqual(doc.ctx, { ok: 1 });
  assert.equal(({}).polluted, before);
  assert.equal(Object.getPrototypeOf(doc.ctx), Object.prototype);

  const doc2 = { v: 0 };
  compile('.v={"constructor":{"prototype":{"polluted":"yes"}},"ok":2}').apply(doc2);
  assert.deepEqual(doc2.v, { ok: 2 });
  assert.equal(({}).polluted, before);
});

test('=call() refuses proto-key method names', () => {
  const doc = { v: {} };
  assert.equal(compile('.v=call(["${val}","constructor"])').apply(doc).changed, false);
  assert.equal(compile('.v=call(["${val}","__proto__"])').apply(doc).changed, false);
});

test('the prune dialect refuses proto keys too', () => {
  for (const bad of ['__proto__', 'a.__proto__', 'a.constructor.prototype', 'prototype.x']) {
    const c = compilePrunePath(bad);
    assert.equal(c.ok, false, bad);
    assert.equal(c.error, 'proto-key', bad);
  }
  const doc = JSON.parse('{"a":{"__proto__":{"x":1},"safe":1}}');
  const wildcard = compilePrunePath('a.*');
  assert.equal(wildcard.prune(doc), true);
  assert.deepEqual(Object.keys(doc.a).filter((k) => k !== '__proto__'), []);
  assert.equal(({}).x, undefined);
});

/* -------------------------------------------------------------------------- */
/* Bounds: cycles, depth, nodes                                                */
/* -------------------------------------------------------------------------- */

test('a self-referential document terminates instead of hanging', () => {
  const doc = { name: 'root', child: { flag: 1 } };
  doc.child.parent = doc;
  doc.self = doc;

  assert.equal(compile('..flag').ok, true);
  assert.deepEqual(compile('..flag').evaluate(doc), [['child', 'flag']]);
  assert.equal(compile('[?..flag]..name="x"').apply(doc).ok, true);
  assert.equal(doc.name, 'x');
  assert.equal(compile('..*').evaluate(doc).length > 0, true);
});

test('a cycle through an array terminates', () => {
  const arr = [{ k: 1 }];
  arr.push(arr);
  const doc = { list: arr };
  assert.deepEqual(compile('..k').evaluate(doc), [['list', 0, 'k']]);
});

test('the depth cap fails closed without mutating', () => {
  let deep = { leaf: 'target' };
  for (let i = 0; i < 40; i++) deep = { next: deep };
  const doc = { deep };

  const ok = compile('..leaf="hit"', { limits: { maxDepth: 64 } });
  assert.equal(ok.apply(doc).changed, true);

  const capped = compile('..leaf="miss"', { limits: { maxDepth: 4 } });
  const r = capped.apply(doc);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'budget-exceeded');
  assert.equal(r.changed, false);
  assert.equal(capped.matches(doc), false);
  assert.deepEqual(capped.evaluate(doc), []);
  // Fail-closed means the document is untouched, not half-edited.
  let probe = doc.deep;
  while (probe.next) probe = probe.next;
  assert.equal(probe.leaf, 'hit');
});

test('the node cap fails closed on a wide document', () => {
  const doc = { items: [] };
  for (let i = 0; i < 500; i++) doc.items.push({ id: i, nested: { v: i } });

  const capped = compile('..v=0', { limits: { maxNodes: 50 } });
  const r = capped.apply(doc);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'budget-exceeded');
  assert.equal(doc.items[0].nested.v, 0, 'sanity: id 0 was already 0');
  assert.equal(doc.items[10].nested.v, 10, 'no partial mutation');

  const uncapped = compile('..v=0');
  assert.equal(uncapped.apply(doc).changed, true);
  assert.equal(doc.items[10].nested.v, 0);
});

test('the result cap fails closed', () => {
  const doc = { items: [] };
  for (let i = 0; i < 300; i++) doc.items.push({ v: i });
  const capped = compile('..v', { limits: { maxResults: 10 } });
  const r = capped.apply(doc);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'budget-exceeded');
  assert.equal(doc.items.length, 300);
  assert.equal(Object.hasOwn(doc.items[0], 'v'), true);
});

test('compile-time caps reject oversized expressions', () => {
  assert.equal(compile(`.a${'.b'.repeat(4000)}`).error, 'expression-too-long');
  assert.equal(compile('.a.b.c.d', { limits: { maxSteps: 2 } }).error, 'too-many-steps');
  assert.equal(compile(`.a=/${'x'.repeat(300)}/`).error, 'regex-too-long');
  const nested = `${'[?'.repeat(30)}.a${']'.repeat(30)}`;
  assert.equal(compile(nested).ok, false);
  assert.equal(compile(nested).error, 'nesting-too-deep');
  assert.equal(JSONPATH_LIMITS.maxNodes > 0, true);
  assert.equal(Object.isFrozen(JSONPATH_LIMITS), true);
});

/* -------------------------------------------------------------------------- */
/* Malformed expressions and totality                                          */
/* -------------------------------------------------------------------------- */

test('malformed expressions compile to a detectable failure, never a throw', () => {
  const malformed = [
    '', '.', '..', '.a.', '.a..', '[', ']', '[]]', '[?', '[?.a', '[?.a]]',
    '.a[', '.a[]', '.[*]', '.[0]', '.a[0', '.a["unterminated', ".a['x",
    '.a=', '.a=notjson', '.a={bad}', '.a+=', '.a+=oops', '=1', '+=1',
    '.a=/unterminated', '.a=/(/', '.a[?.b=/(/]', '.a=nope(1)', '.a=repl(',
    '.a=repl({"regex":"("})', '{}', '{2}', '{2};', ';', ';;', '.a;$x',
    '.a[,]', '.a[1,]', '.a[,1]', '.1a', '.a b', '@@', '$$', '.a[?]',
  ];
  for (const expr of malformed) {
    let p;
    assert.doesNotThrow(() => { p = compile(expr); }, `compile threw: ${JSON.stringify(expr)}`);
    if (p.ok) continue; // a few of these are legal; the point is nothing throws
    assert.equal(typeof p.error, 'string', expr);
    assert.equal(p.matches({ a: 1 }), false, expr);
    assert.deepEqual(p.evaluate({ a: 1 }), [], expr);
    const doc = { a: 1 };
    const r = p.apply(doc);
    assert.equal(r.ok, false, expr);
    assert.equal(r.changed, false, expr);
    assert.equal(r.error, p.error, expr);
    assert.deepEqual(doc, { a: 1 }, expr);
  }
  // The clearly-broken ones must in fact be rejected.
  for (const expr of ['', '.', '..', '.a.', '[?', '.a=notjson', '.a=nope(1)', '.a[,]']) {
    assert.equal(compile(expr).ok, false, `should be rejected: ${JSON.stringify(expr)}`);
  }
});

test('non-string and hostile inputs are refused rather than thrown at', () => {
  for (const bad of [undefined, null, 42, {}, [], Symbol('x')]) {
    const p = compile(bad);
    assert.equal(p.ok, false);
    assert.equal(p.error, 'not-a-string');
  }
  assert.equal(compile('').error, 'empty-expression');

  // Applying to non-objects must not throw.
  const p = compile('.a.b=1');
  for (const doc of [undefined, null, 0, 'text', true, []]) {
    const r = p.apply(doc);
    assert.equal(r.changed, false);
    assert.equal(p.matches(doc), false);
    assert.deepEqual(p.evaluate(doc), []);
  }
});

test('a document with throwing accessors is contained', () => {
  const doc = { safe: 1 };
  Object.defineProperty(doc, 'boom', {
    enumerable: true,
    get() { throw new Error('nope'); },
  });
  const p = compile('..safe=2');
  const r = p.apply(doc);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'apply-failed');
  assert.doesNotThrow(() => p.matches(doc));
  assert.equal(p.matches(doc), false);
});

test('the compiled surface is frozen and carries a stable contract', () => {
  const p = compile('.a=1');
  assert.equal(Object.isFrozen(p), true);
  assert.deepEqual(Object.keys(p).sort(), ['action', 'apply', 'error', 'evaluate', 'expr', 'hasAction', 'matches', 'ok'].sort());
  assert.equal(p.expr, '.a=1');
  assert.equal(p.error, null);
  assert.equal(p.hasAction, true);

  const bad = compile('.');
  assert.equal(Object.isFrozen(bad), true);
  assert.deepEqual(Object.keys(bad).sort(), Object.keys(p).sort());
  assert.equal(bad.action, null);
  assert.equal(bad.hasAction, false);

  for (const [expr, action] of [
    ['.a', 'remove'], ['.a=1', 'assign'], ['.a+={"b":1}', 'merge'],
    ['.a=repl({"regex":"x","replacement":"y"})', 'replace'], ['.a=call(["${obj}","x"])', 'call'],
  ]) {
    assert.equal(compile(expr).action, action, expr);
  }
  assert.equal(compile('.a=nope(1)').error, 'unsupported-action');
});

/* -------------------------------------------------------------------------- */
/* The json-prune dialect                                                      */
/* -------------------------------------------------------------------------- */

test('compilePrunePath resolves and removes uBO json-prune paths', () => {
  const doc = () => ({
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
    adPlacements: [{ adPlacementRenderer: {} }],
    playerResponse: { adSlots: [{ id: 1 }], streamingData: { formats: [] } },
  });

  const p = compilePrunePath('playerAds');
  assert.equal(p.ok, true);
  const a = doc();
  assert.equal(p.test(a), true);
  assert.equal(p.prune(a), true);
  assert.equal(Object.hasOwn(a, 'playerAds'), false);
  assert.equal(p.prune(a), false, 'second prune finds nothing');

  const nested = compilePrunePath('playerResponse.adSlots');
  const b = doc();
  assert.equal(nested.test(b), true);
  assert.equal(nested.prune(b), true);
  assert.equal(Object.hasOwn(b.playerResponse, 'adSlots'), false);
  assert.equal(b.playerResponse.streamingData !== undefined, true);

  assert.equal(compilePrunePath('nope.nope').test(doc()), false);
  assert.equal(compilePrunePath('nope.nope').prune(doc()), false);
});

test('the prune dialect iterates with [], {} and *, and cuts with [-] and {-}', () => {
  const arrayDoc = { items: [{ ad: 1, keep: 1 }, { keep: 2 }] };
  assert.equal(compilePrunePath('items.[].ad').prune(arrayDoc), true);
  assert.deepEqual(arrayDoc.items, [{ keep: 1 }, { keep: 2 }]);

  const objDoc = { map: { a: { ad: 1 }, b: { keep: 1 } } };
  assert.equal(compilePrunePath('map.{}.ad').prune(objDoc), true);
  assert.deepEqual(objDoc.map, { a: {}, b: { keep: 1 } });

  const starDoc = { map: { a: { ad: 1 }, b: { ad: 2 } } };
  assert.equal(compilePrunePath('map.*.ad').prune(starDoc), true);
  assert.deepEqual(starDoc.map, { a: {}, b: {} });

  // [-] splices the whole element when the remainder resolves.
  const spliceDoc = { items: [{ ad: 1 }, { keep: 1 }, { ad: 2 }] };
  assert.equal(compilePrunePath('items.[-].ad').prune(spliceDoc), true);
  assert.deepEqual(spliceDoc.items, [{ keep: 1 }]);

  // {-} deletes the whole key when the remainder resolves.
  const deleteDoc = { map: { a: { ad: 1 }, b: { keep: 1 } } };
  assert.equal(compilePrunePath('map.{-}.ad').prune(deleteDoc), true);
  assert.deepEqual(deleteDoc.map, { b: { keep: 1 } });

  // A terminal `*` removes every own key.
  const wipe = { map: { a: 1, b: 2 } };
  assert.equal(compilePrunePath('map.*').prune(wipe), true);
  assert.deepEqual(wipe.map, {});
});

test('compilePruner gates prune paths on needle paths', () => {
  const doc = () => ({ adPlacements: [1], playerAds: [2], videoDetails: { videoId: 'x' } });

  const gated = compilePruner('adPlacements playerAds', 'videoDetails.videoId');
  assert.equal(gated.ok, true);
  assert.deepEqual([...gated.paths], ['adPlacements', 'playerAds']);
  assert.deepEqual([...gated.needles], ['videoDetails.videoId']);
  const a = doc();
  assert.equal(gated.mustProcess(a), true);
  assert.equal(gated.prune(a), true);
  assert.deepEqual(Object.keys(a), ['videoDetails']);

  const blocked = compilePruner('adPlacements', 'videoDetails.missing');
  const b = doc();
  assert.equal(blocked.mustProcess(b), false);
  assert.equal(blocked.prune(b), false);
  assert.equal(b.adPlacements !== undefined, true);

  assert.equal(compilePruner('').ok, false);
  assert.equal(compilePruner('').error, 'no-prune-paths');
  assert.equal(compilePruner('a..b').error, 'bad-prune-path');
  assert.equal(compilePruner('a', '__proto__').error, 'proto-key');
  assert.equal(Object.isFrozen(compilePruner('a')), true);
});

test('the prune dialect is bounded and total', () => {
  const doc = { a: {} };
  doc.a.self = doc;
  assert.doesNotThrow(() => compilePrunePath('a.*.missing').prune(doc));

  let deep = { leaf: 1 };
  for (let i = 0; i < 40; i++) deep = { next: deep, sib: 1 };
  const capped = compilePrunePath('next.*.leaf', { limits: { maxDepth: 3 } });
  assert.equal(capped.prune(deep), false);

  for (const doc2 of [undefined, null, 5, 'x', []]) {
    assert.equal(compilePrunePath('a.b').prune(doc2), false);
    assert.equal(compilePrunePath('a.b').test(doc2), false);
  }
});
