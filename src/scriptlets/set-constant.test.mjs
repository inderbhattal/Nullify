import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;

const { setConstant } = await import('./set-constant.js');

let n = 0;
/** Unique property name per assertion — setConstant installs a permanent trap. */
const prop = () => `__sc_${n++}`;

function applied(value) {
  const p = prop();
  setConstant(p, value);
  return globalThis[p];
}

// uBO's canonical spellings are `[]`/`emptyArr` and `{}`/`emptyObj`. Nullify
// implemented neither, so `Number('[]')` -> NaN fell through to `return val`
// and the page received the two-character string "[]" where it expected an
// array. 139 rules in the shipped corpus pass one of these values.

test('resolves uBO empty-array spellings to a real array', () => {
  for (const spelling of ['[]', 'emptyArr', 'emptyArray']) {
    const value = applied(spelling);
    assert.ok(Array.isArray(value), `${spelling} must produce an array`);
    assert.equal(value.length, 0);
  }
});

test('resolves uBO empty-object spellings to a real object', () => {
  for (const spelling of ['{}', 'emptyObj']) {
    const value = applied(spelling);
    assert.equal(typeof value, 'object', `${spelling} must produce an object`);
    assert.ok(value !== null && !Array.isArray(value));
    assert.deepEqual(Object.keys(value), []);
  }
});

test('keeps the existing primitive vocabulary', () => {
  assert.equal(applied('true'), true);
  assert.equal(applied('false'), false);
  assert.equal(applied('null'), null);
  assert.equal(applied('undefined'), undefined);
  assert.equal(applied(''), '');
  assert.equal(applied('1'), 1);
  assert.equal(applied('-42'), -42);
});

test('keeps the noop function vocabulary', () => {
  assert.equal(typeof applied('noopFunc'), 'function');
  assert.equal(applied('trueFunc')(), true);
  assert.equal(applied('falseFunc')(), false);
});

test('rejects out-of-range and non-integer numerics like uBO, rather than coercing', () => {
  // uBO restricts untrusted set-constant to /^-?\d+$/ with |value| <= 0x7FFF.
  // Anything else must abort so the page keeps its own value — silently
  // handing back a string or Infinity is what broke pages.
  assert.equal(applied('99999'), undefined, 'out of range must not be set');
  assert.equal(applied('1e400'), undefined, 'Infinity must not be set');
  assert.equal(applied('0x10'), undefined, 'hex must not coerce to 16');
  assert.equal(applied(' '), undefined, 'whitespace must not coerce to 0');
});

test('unknown value tokens abort instead of becoming their own string', () => {
  assert.equal(applied('someUnknownToken'), undefined);
});

test('refuses prototype-pollution paths', () => {
  setConstant('__proto__.polluted', 'true');
  assert.equal({}.polluted, undefined);

  setConstant('constructor.prototype.polluted2', 'true');
  assert.equal({}.polluted2, undefined);
});
