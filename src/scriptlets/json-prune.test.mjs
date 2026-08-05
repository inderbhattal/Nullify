import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;

const { jsonPrune } = await import('./json-prune.js');

// §4.33 — json-prune walked literal dot segments only, so uBO's wildcard
// segments matched nothing: `[]` looked up the literal key "[]" (21 of 111
// shipped rules), and `*` the literal key "*".

test('[] wildcard iterates array elements (Facebook-style rule shape)', () => {
  jsonPrune('define.[].2.click_ids');
  const result = JSON.parse(
    '{"define":[[0,0,{"click_ids":[1],"keep":1}],[0,0,{"click_ids":[2],"keep":2}]]}',
  );
  assert.equal('click_ids' in result.define[0][2], false, 'pruned in element 0');
  assert.equal('click_ids' in result.define[1][2], false, 'pruned in element 1');
  assert.equal(result.define[0][2].keep, 1, 'siblings must survive');
});

test('* wildcard iterates own keys', () => {
  jsonPrune('adSlots.*.tracking');
  const result = JSON.parse(
    '{"adSlots":{"top":{"tracking":"t","size":1},"side":{"tracking":"t","size":2}}}',
  );
  assert.equal('tracking' in result.adSlots.top, false);
  assert.equal('tracking' in result.adSlots.side, false);
  assert.equal(result.adSlots.top.size, 1);
});

test('terminal [] empties the array', () => {
  jsonPrune('midRolls.[]');
  const result = JSON.parse('{"midRolls":[{"ad":1},{"ad":2}],"content":"x"}');
  assert.deepEqual(result.midRolls, [], 'elements dropped, array collapsed');
  assert.equal(result.content, 'x');
});

// §5.38 — `[-]` was an alias of `[]`: the leaf key was deleted but the array
// element stayed, so the ad reel kept its slot in the Shorts sequence with its
// `isAd` label stripped. uBO splices the element out.

test('[-] splices the matching array element out (shipped Shorts rule)', () => {
  // Verbatim argument string from scripts/filter-lists/ubo-filters.txt.
  jsonPrune('entries.[-].command.reelWatchEndpoint.adClientParams.isAd');
  const result = JSON.parse(JSON.stringify({
    entries: [
      { command: { reelWatchEndpoint: { videoId: 'real1' } } },
      { command: { reelWatchEndpoint: { videoId: 'ad', adClientParams: { isAd: true } } } },
      { command: { reelWatchEndpoint: { videoId: 'real2' } } },
    ],
  }));

  assert.equal(result.entries.length, 2, 'the ad entry must be removed, not just relabelled');
  assert.deepEqual(
    result.entries.map((e) => e.command.reelWatchEndpoint.videoId),
    ['real1', 'real2'],
    'the surviving reels keep their order',
  );
});

test('{-} deletes the matching object key, not just the leaf', () => {
  jsonPrune('slots.{-}.sponsored');
  const result = JSON.parse(
    '{"slots":{"a":{"sponsored":1,"x":1},"b":{"x":2}},"keep":true}',
  );

  assert.deepEqual(Object.keys(result.slots), ['b'], 'the sponsored slot key must be gone');
  assert.equal(result.slots.b.x, 2, 'the untouched sibling survives intact');
  assert.equal(result.keep, true);
});

test('[] and * still iterate without removing the container entry', () => {
  jsonPrune('list.[].ad map.*.ad');
  const result = JSON.parse(
    '{"list":[{"ad":1,"id":"a"},{"id":"b"}],"map":{"k":{"ad":1,"id":"c"}}}',
  );

  assert.equal(result.list.length, 2, '[] must not drop elements');
  assert.equal('ad' in result.list[0], false);
  assert.deepEqual(Object.keys(result.map), ['k'], '* must not drop keys');
  assert.equal('ad' in result.map.k, false);
});

test('a trailing * deletes every own key of the container', () => {
  jsonPrune('adSlots.*');
  const result = JSON.parse('{"adSlots":{"top":1,"side":2},"content":"x"}');

  assert.deepEqual(Object.keys(result.adSlots), []);
  assert.equal(result.content, 'x');
});

test('[-] leaves entries whose remaining path does not resolve', () => {
  jsonPrune('items.[-].promo.id');
  const result = JSON.parse('{"items":[{"promo":{"other":1}},{"promo":{"id":9}},{}]}');

  assert.equal(result.items.length, 2, 'only the resolving entry is spliced');
  assert.deepEqual(result.items[0], { promo: { other: 1 } });
});

test('wildcard segments still refuse prototype pollution', () => {
  jsonPrune('polluter.[].__proto__ polluter2.*.constructor');
  JSON.parse('{"polluter":[{}],"polluter2":{"a":{}}}');
  assert.equal({}.polluted, undefined);
  assert.equal(typeof {}.constructor, 'function', 'constructor must be untouched');
});

test('required paths understand wildcards too', () => {
  jsonPrune('wantedGone', 'entries.[].isAd');
  const hit = JSON.parse('{"wantedGone":1,"entries":[{"isAd":true}]}');
  assert.equal('wantedGone' in hit, false, 'required wildcard path present -> prune');
  const miss = JSON.parse('{"wantedGone":1,"entries":[{"other":true}]}');
  assert.equal(miss.wantedGone, 1, 'required path absent -> untouched');
});

test('plain dotted paths keep working', () => {
  jsonPrune('playerAds.url');
  const result = JSON.parse('{"playerAds":{"url":"x","id":1}}');
  assert.equal('url' in result.playerAds, false);
  assert.equal(result.playerAds.id, 1);
});
