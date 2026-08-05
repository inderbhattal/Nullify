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

// §5.38 — uBO ships four `set` rules that all defer on the same missing
// parent (`ytInitialPlayerResponse`). Each deferral used to install its own
// placeholder over the previous one, so only the rule registered last ever
// fired: the page kept `playerAds`, `adPlacements` and `adSlots`.

test('several deferrals on one missing parent all apply (shipped YouTube rules)', () => {
  // Verbatim argument strings from scripts/filter-lists/ubo-filters.txt:26-28
  // and annoyances.txt:1531.
  setConstant('ytInitialPlayerResponse.playerAds', 'undefined');
  setConstant('ytInitialPlayerResponse.adPlacements', 'undefined');
  setConstant('ytInitialPlayerResponse.adSlots', 'undefined');
  setConstant('ytInitialPlayerResponse.auxiliaryUi.messageRenderers.upsellDialogRenderer', 'undefined');

  window.ytInitialPlayerResponse = {
    playerAds: [{ ad: 1 }],
    adPlacements: [{ ad: 2 }],
    adSlots: [{ ad: 3 }],
    auxiliaryUi: { messageRenderers: { upsellDialogRenderer: { nag: 1 } } },
    videoDetails: { videoId: 'abc' },
  };

  const r = window.ytInitialPlayerResponse;
  assert.equal(r.playerAds, undefined, 'playerAds must be neutralised');
  assert.equal(r.adPlacements, undefined, 'adPlacements must be neutralised');
  assert.equal(r.adSlots, undefined, 'adSlots must be neutralised');
  assert.equal(
    r.auxiliaryUi.messageRenderers.upsellDialogRenderer, undefined,
    'the deep upsell path must be neutralised too',
  );
  assert.equal(r.videoDetails.videoId, 'abc', 'unrelated payload survives');
});

test('a re-assigned parent is re-trapped, so SPA navigation stays covered', () => {
  setConstant('__navRoot.playerAds', 'undefined');
  setConstant('__navRoot.adSlots', 'undefined');

  window.__navRoot = { playerAds: [1], adSlots: [1] };
  window.__navRoot = { playerAds: [2], adSlots: [2], ok: true };

  assert.equal(window.__navRoot.playerAds, undefined);
  assert.equal(window.__navRoot.adSlots, undefined);
  assert.equal(window.__navRoot.ok, true);
});

test('deferral composes with a property the page already defined', () => {
  let backing;
  Object.defineProperty(window, '__pageOwned', {
    configurable: true,
    enumerable: true,
    get() { return backing; },
    set(v) { backing = v; },
  });

  setConstant('__pageOwned.adSlots', 'undefined');
  window.__pageOwned = { adSlots: [1], keep: 2 };

  assert.equal(backing?.keep, 2, "the page's own setter must still run");
  assert.equal(window.__pageOwned.adSlots, undefined);
});

test('refuses prototype-pollution paths', () => {
  setConstant('__proto__.polluted', 'true');
  assert.equal({}.polluted, undefined);

  setConstant('constructor.prototype.polluted2', 'true');
  assert.equal({}.polluted2, undefined);
});
