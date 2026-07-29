import test from 'node:test';
import assert from 'node:assert/strict';

import { CosmeticEngine } from './cosmetic-engine.js';

/**
 * Minimal stand-in for an Element. `_applyOp` only needs the query methods and
 * identity, so this avoids pulling in a full DOM just to pin operator
 * semantics.
 */
function makeEl({ matchesSelectors = [], descendants = [] } = {}) {
  const el = {
    tagName: 'DIV',
    textContent: '',
    matches: (sel) => matchesSelectors.includes(sel),
    querySelector: (sel) => descendants.find((d) => d.matches(sel)) || null,
    querySelectorAll: (sel) =>
      sel === '*' ? descendants : descendants.filter((d) => d.matches(sel)),
    closest: () => null,
    contains: () => false,
  };
  return el;
}

const engine = () => new CosmeticEngine();

// `:if()` and `:if-not()` are tokenized by PROC_OPS but had no case in
// `_applyOp`, so they fell through to `default: return el` — i.e. they reported
// "matched" unconditionally. `div:if-not(.keep)` then hid every div on the
// page instead of only those lacking `.keep`.

test(':if() matches only when a descendant matches — it is an alias of :has()', () => {
  const e = engine();
  const withSponsor = makeEl({ descendants: [makeEl({ matchesSelectors: ['.sponsor'] })] });
  const without = makeEl({ descendants: [makeEl({ matchesSelectors: ['.content'] })] });

  assert.equal(e._applyOp(withSponsor, 'if', '.sponsor', 'div:if(.sponsor)'), withSponsor);
  assert.equal(e._applyOp(without, 'if', '.sponsor', 'div:if(.sponsor)'), null);
});

test(':if-not() matches only when no descendant matches', () => {
  const e = engine();
  const withKeep = makeEl({ descendants: [makeEl({ matchesSelectors: ['.keep'] })] });
  const without = makeEl({ descendants: [makeEl({ matchesSelectors: ['.other'] })] });

  assert.equal(e._applyOp(withKeep, 'if-not', '.keep', 'div:if-not(.keep)'), null);
  assert.equal(e._applyOp(without, 'if-not', '.keep', 'div:if-not(.keep)'), without);
});

test(':if() and :has() agree on the same input', () => {
  const e = engine();
  const hit = makeEl({ descendants: [makeEl({ matchesSelectors: ['.ad'] })] });
  const miss = makeEl({ descendants: [] });

  assert.equal(!!e._applyOp(hit, 'if', '.ad', 's'), !!e._applyOp(hit, 'has', '.ad', 's'));
  assert.equal(!!e._applyOp(miss, 'if', '.ad', 's'), !!e._applyOp(miss, 'has', '.ad', 's'));
});

test('an unimplemented operator fails closed rather than hiding the element', () => {
  const e = engine();
  const el = makeEl({ descendants: [] });

  // Under-blocking is recoverable; blanking a page is not. Any planner/executor
  // drift must land on the safe side.
  assert.equal(e._applyOp(el, 'not-a-real-operator', 'x', 's'), null);
});

test('mid-chain :xpath() is not silently treated as a match', () => {
  const e = engine();
  const el = makeEl({ descendants: [] });

  // Only a leading :xpath() is supported; mid-chain must not pass through.
  assert.equal(e._applyOp(el, 'xpath', './/div', 'a:has-text(x):xpath(.//div)'), null);
});

test('implemented operators still behave (regression guard)', () => {
  const e = engine();

  const textEl = { ...makeEl(), textContent: 'Sponsored content' };
  assert.equal(e._applyOp(textEl, 'has-text', 'Sponsored', 's'), textEl);

  const otherEl = { ...makeEl(), textContent: 'Real article' };
  assert.equal(e._applyOp(otherEl, 'has-text', 'Sponsored', 's'), null);

  const hit = makeEl({ descendants: [makeEl({ matchesSelectors: ['.ad'] })] });
  assert.equal(e._applyOp(hit, 'has', '.ad', 's'), hit);
});
