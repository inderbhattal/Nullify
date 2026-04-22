import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLine, networkFilterToDNR } from './build-rules.mjs';

test('drops legacy global fragment image redirects that overmatch DNR sprite URLs', () => {
  const parsed = parseLine('*.svg#$image,redirect-rule=1x1.gif');
  assert.equal(parsed?.type, 'network');
  assert.equal(networkFilterToDNR(parsed), null);
});

test('keeps narrower fragment image redirects that are scoped to a specific host path', () => {
  const parsed = parseLine('||example.com/assets/*.svg#$image,redirect-rule=1x1.gif');
  assert.equal(parsed?.type, 'network');

  const dnr = networkFilterToDNR(parsed);
  assert.ok(dnr);
  assert.equal(dnr.action.type, 'redirect');
  assert.equal(dnr.condition.urlFilter, '||example.com/assets/*.svg#');
  assert.deepEqual(dnr.condition.resourceTypes, ['image']);
});
