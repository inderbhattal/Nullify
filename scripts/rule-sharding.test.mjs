import assert from 'node:assert/strict';
import test from 'node:test';

import { orderRulesForSharding } from './build-rules.mjs';

/**
 * Filter lists put their `@@` exceptions after the blocks those exceptions
 * carve out of. Chunking sliced in source order, so every EasyList exception
 * landed in easylist_3.json — which the manifest ships `"enabled": false`.
 * The result was 50,000 live block rules with none of their false-positive
 * escapes whenever the tail shards were not enabled.
 */

const rule = (type, id) => ({ id, priority: 1, condition: { urlFilter: `||h${id}.example^` }, action: { type } });

test('exceptions are ordered ahead of blocks so any enabled prefix is consistent', () => {
  const ordered = orderRulesForSharding([
    rule('block', 1),
    rule('block', 2),
    rule('allow', 3),
    rule('block', 4),
    rule('allow', 5),
  ]);

  assert.deepEqual(
    ordered.map((r) => r.action.type),
    ['allow', 'allow', 'block', 'block', 'block'],
  );
});

test('allowAllRequests counts as an exception too', () => {
  const ordered = orderRulesForSharding([rule('block', 1), rule('allowAllRequests', 2)]);
  assert.equal(ordered[0].action.type, 'allowAllRequests');
});

test('ordering is stable within each group, so builds stay deterministic', () => {
  const ordered = orderRulesForSharding([
    rule('block', 1), rule('allow', 2), rule('block', 3), rule('allow', 4), rule('block', 5),
  ]);

  assert.deepEqual(ordered.map((r) => r.id), [2, 4, 1, 3, 5]);
});

test('no rules are lost or duplicated', () => {
  const input = Array.from({ length: 50 }, (_, i) => rule(i % 7 === 0 ? 'allow' : 'block', i));
  const ordered = orderRulesForSharding(input);

  assert.equal(ordered.length, input.length);
  assert.deepEqual(
    ordered.map((r) => r.id).sort((a, b) => a - b),
    input.map((r) => r.id),
  );
});

test('the first shard carries the exceptions even when they are far past the boundary', () => {
  // The real shape: 25k blocks, then the exceptions, sliced at 25k.
  const MAX_PER_FILE = 25000;
  const input = [
    ...Array.from({ length: 30000 }, (_, i) => rule('block', i)),
    ...Array.from({ length: 578 }, (_, i) => rule('allow', 100000 + i)),
  ];

  const firstShard = orderRulesForSharding(input).slice(0, MAX_PER_FILE);
  const allowsInFirstShard = firstShard.filter((r) => r.action.type === 'allow').length;

  assert.equal(allowsInFirstShard, 578, 'every exception must be in the enabled-by-default shard');
});

test('redirect and other action types are treated as non-exceptions', () => {
  const ordered = orderRulesForSharding([rule('redirect', 1), rule('allow', 2), rule('block', 3)]);
  assert.deepEqual(ordered.map((r) => r.action.type), ['allow', 'redirect', 'block']);
});
