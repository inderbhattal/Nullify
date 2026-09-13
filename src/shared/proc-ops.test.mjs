/**
 * Pins the shape of the shared procedural-operator list (docs/REVIEW-2026-09.md
 * §3.2). Three JS copies and two Rust copies drifted apart; the cost was 191
 * cosmetic rules on 289 domains silently invalidating every hide on those
 * sites. The SW (A1b) and the WASM parity test (B1) consume this module; the
 * checks here are the ones every consumer relies on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROC_OPS,
  PROC_OP_REGEX,
  PROC_OP_ALIASES,
  NATIVE_FUNCTIONAL_PSEUDO_CLASSES,
  isProceduralSelector,
} from './proc-ops.js';

test('PROC_OPS has no duplicates, every name is lowercase kebab (optionally -prefixed), every alias target is in PROC_OPS', () => {
  assert.equal(PROC_OPS.length, 25, 'one list, the same 25 names as the Rust PROC_OP_NAMES');
  assert.equal(new Set(PROC_OPS).size, PROC_OPS.length, 'no duplicates');
  for (const op of PROC_OPS) {
    assert.match(op, /^-?[a-z]+(?:-[a-z]+)*$/, `${op} is lowercase kebab`);
  }
  // Longest-first within a shared prefix: a name must never precede a longer
  // name it is a prefix of (`remove` after `remove-attr`, `if` after `if-not`).
  for (let i = 0; i < PROC_OPS.length; i++) {
    for (let j = i + 1; j < PROC_OPS.length; j++) {
      assert.ok(!PROC_OPS[j].startsWith(PROC_OPS[i]),
        `${PROC_OPS[i]} (index ${i}) must come after ${PROC_OPS[j]} (index ${j})`);
    }
  }
  for (const [alias, target] of Object.entries(PROC_OP_ALIASES)) {
    assert.ok(PROC_OPS.includes(alias), `alias ${alias} is itself tokenised`);
    // `-abp-has` maps to `has`, which is a native pseudo-class the engine
    // implements (`case 'has'`), not one of the 25 tokenised operators.
    assert.ok(PROC_OPS.includes(target) || NATIVE_FUNCTIONAL_PSEUDO_CLASSES.has(target),
      `alias target ${target} is a known operator`);
    assert.notEqual(alias, target);
  }
});

test('isProceduralSelector matches :name( case-insensitively', () => {
  assert.equal(isProceduralSelector('div:has-text(x)'), true);
  assert.equal(isProceduralSelector('DIV:Has-Text(x)'), true);
  assert.equal(isProceduralSelector('div:-ABP-HAS(.x)'), true);
  assert.equal(isProceduralSelector('div:others(.x)'), true);
  assert.equal(isProceduralSelector('div:remove-attr(data-x)'), true);
  assert.equal(isProceduralSelector('div:matches-media((min-width: 800px))'), true);
  // Every listed operator, in either case, with and without a subject.
  for (const op of PROC_OPS) {
    assert.equal(isProceduralSelector(`div:${op}(x)`), true, op);
    assert.equal(isProceduralSelector(`:${op.toUpperCase()}(x)`), true, op);
  }
  // Native pseudo-classes and plain CSS are not procedural.
  assert.equal(isProceduralSelector('div:has(.x)'), false);
  assert.equal(isProceduralSelector('li:nth-child(2n+1)'), false);
  assert.equal(isProceduralSelector('div:not(:is(.a, .b))'), false);
  assert.equal(isProceduralSelector('.plain-ad'), false);
  // The name must be followed by `(` — `:has-text` alone is not an operator
  // call, and a longer name must not be matched by its prefix.
  assert.equal(isProceduralSelector('div:has-text'), false);
  assert.equal(isProceduralSelector('div:removed(x)'), false);
  assert.equal(isProceduralSelector(''), false);
});

test('PROC_OP_REGEX is derived from PROC_OPS and is case-insensitive', () => {
  assert.ok(PROC_OP_REGEX.flags.includes('i'));
  for (const op of PROC_OPS) {
    assert.ok(PROC_OP_REGEX.test(`:${op}(`), op);
    assert.ok(PROC_OP_REGEX.test(`:${op.toUpperCase()}(`), op);
  }
  assert.equal(PROC_OP_REGEX.test(':bogus('), false);
  assert.equal(PROC_OP_REGEX.test(':has('), false);
});

test('NATIVE_FUNCTIONAL_PSEUDO_CLASSES lists the 15 native names and none of them is an operator', () => {
  assert.equal(NATIVE_FUNCTIONAL_PSEUDO_CLASSES.size, 15);
  for (const name of ['not', 'is', 'where', 'has', 'nth-child', 'nth-last-child', 'nth-of-type',
    'nth-last-of-type', 'nth-col', 'nth-last-col', 'lang', 'dir', 'host', 'host-context', 'state']) {
    assert.ok(NATIVE_FUNCTIONAL_PSEUDO_CLASSES.has(name), name);
    assert.ok(!PROC_OPS.includes(name), `${name} is native, not procedural`);
  }
});
