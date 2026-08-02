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
