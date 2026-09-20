/**
 * Detector suite for every wrapper `src/scriptlets/shared-utils.js` installs
 * (docs/REMEDIATION-2026-09.md §7.8).
 *
 * A page that wants to know whether an API is hooked does not have to call it:
 * it reads the replacement's own properties. §4.4 closed that for the shield's
 * callables — a `proxyApply` Proxy forwards `ownKeys` to the native it wraps
 * and `maskNative` copies `name`/`length` from it — but `wrapInstanceGetter`
 * built its replacement accessor from a *function expression*, which has
 * [[Construct]] and therefore an own `prototype`. A native getter has neither,
 * so
 *
 *   Object.getOwnPropertyNames(Object.getOwnPropertyDescriptor(
 *     XMLHttpRequest.prototype, 'responseText').get)
 *
 * read `length,name,prototype` through the shield and `length,name` on an
 * untouched browser. The same function-expression shape reached `maskNative`
 * directly from bot-stealth.js (the WebGL `getParameter` spoof) and
 * spoof-css.js (the `getComputedStyle` wrapper).
 *
 * The assertions are deliberately generic — every wrapper is compared key for
 * key against the function it replaced, and the function it replaced is itself
 * checked against a platform function's shape first, so neither side can pass
 * by being equally leaky. A test that named only `responseText` would stay
 * green while the next wrapper leaked. The shield's own fourteen surfaces are
 * covered by the same comparison in `tests/youtube-shield.test.mjs`
 * (`DETECTOR_SNIPPET`).
 *
 * Out of scope (recorded in the plan, not fixed here): the local `defineGetter`
 * helpers in bot-stealth.js and persona-spoof.js install arrow-function
 * getters. Arrows carry no `prototype`, so §7.8's leak is not there, but they
 * are not masked (`name` is `''` and the source is the arrow's) and they land
 * non-enumerable where a WebIDL attribute is enumerable — the same class of
 * leak, a different fix, and persona-spoof.js is a different file's concern.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// --- Page-realm stand-ins, installed before the scriptlets are imported -----

globalThis.window = globalThis;

class WebGLRenderingContextStub {
  // Declared as a class method, like the platform's: `length` and `name` are
  // its only own properties, so it is a faithful baseline to compare against.
  getParameter(parameter) { return `real:${parameter}`; }
}
globalThis.WebGLRenderingContext = WebGLRenderingContextStub;

globalThis.Navigator = class Navigator {};
// Node ships a getter-only `navigator` global; replace it wholesale.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: new globalThis.Navigator(),
});

class HTMLElementStub {
  constructor(selector) { this.selector = selector; }
  matches(sel) { return sel === this.selector; }
  get offsetHeight() { return 0; }
  get offsetWidth() { return 0; }
  get offsetParent() { return null; }
}
// A WebIDL attribute is an *enumerable* configurable accessor; a class getter
// is not enumerable. Match the platform so "the descriptor shape does not
// change" is actually being tested.
for (const prop of ['offsetHeight', 'offsetWidth', 'offsetParent']) {
  const desc = Object.getOwnPropertyDescriptor(HTMLElementStub.prototype, prop);
  Object.defineProperty(HTMLElementStub.prototype, prop, { ...desc, enumerable: true });
}
globalThis.HTMLElement = HTMLElementStub;
globalThis.document = { body: { tagName: 'BODY' } };

// The platform's `getComputedStyle` is a native method: no own `prototype`.
globalThis.getComputedStyle = ({
  getComputedStyle(_el, _pseudo) {
    return { display: 'none', getPropertyValue: () => 'none' };
  },
}).getComputedStyle;

const { maskNative, proxyApply, wrapInstanceGetter } =
  await import('../src/scriptlets/shared-utils.js');
const { botStealth } = await import('../src/scriptlets/bot-stealth.js');
const { spoofCss } = await import('../src/scriptlets/spoof-css.js');

// --- Generic shape assertions ----------------------------------------------

const ownKeys = (fn) => Reflect.ownKeys(fn).map(String);

/** Everything a page can learn about `wrapper` without ever calling it. */
function assertIndistinguishable(wrapper, native, label) {
  assert.deepEqual(
    ownKeys(native), ['length', 'name'],
    `${label}: the function being replaced must itself have a platform function's own keys`,
  );
  assert.deepEqual(
    ownKeys(wrapper), ownKeys(native),
    `${label}: own property names must match the native's exactly`,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(wrapper, 'prototype'), false,
    `${label}: a native method or getter has no own 'prototype' (§7.8)`,
  );
  assert.equal(Object.getOwnPropertySymbols(wrapper).length, 0,
    `${label}: no own symbol may be readable on the wrapper`);
  assert.equal(wrapper.name, native.name, `${label}: name must be the native's`);
  assert.equal(wrapper.length, native.length, `${label}: length must be the native's`);
  assert.equal(String(wrapper), String(native), `${label}: source must read as the native's`);
  assert.throws(
    () => new wrapper(),
    TypeError,
    `${label}: a native method or getter is not constructible`,
  );
}

/** The accessor's slot on the prototype must keep the platform's shape. */
function assertAccessorDescriptor(proto, prop, nativeDesc, label) {
  const desc = Object.getOwnPropertyDescriptor(proto, prop);
  assert.equal(typeof desc.get, 'function', `${label}: must still be an accessor`);
  assert.equal('value' in desc, false, `${label}: must not become a data property`);
  assert.equal(desc.set, nativeDesc.set, `${label}: the native setter must be left in place`);
  assert.equal(desc.enumerable, nativeDesc.enumerable, `${label}: enumerability must not change`);
  assert.equal(desc.configurable, nativeDesc.configurable,
    `${label}: configurability must not change`);
}

// --- shared-utils helpers, against real built-ins --------------------------

test('7.8: a wrapInstanceGetter accessor is shaped like the native getter it replaces', () => {
  // `Map.prototype.size` is a genuine built-in accessor: `[native code]`,
  // non-enumerable, no setter.
  const nativeDesc = Object.getOwnPropertyDescriptor(Map.prototype, 'size');
  try {
    assert.equal(wrapInstanceGetter(Map.prototype, 'size', (value) => value + 100), true,
      'the wrap must report that it installed');
    const wrapped = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
    assert.notEqual(wrapped, nativeDesc.get, 'the accessor must actually have been replaced');

    assertIndistinguishable(wrapped, nativeDesc.get, 'get Map.prototype.size');
    assert.match(String(wrapped), /\[native code\]/, 'the wrapper must print as native code');
    assertAccessorDescriptor(Map.prototype, 'size', nativeDesc, 'get Map.prototype.size');

    assert.equal(new Map([['a', 1]]).size, 101, 'the transform must still post-process the read');
  } finally {
    Object.defineProperty(Map.prototype, 'size', nativeDesc);
  }
});

test('7.8: wrapInstanceGetter keeps an enumerable accessor enumerable and its setter in place', () => {
  // `URL.prototype.search` has the shape every DOM IDL attribute has, and the
  // one spoof-css wraps on `HTMLElement.prototype`: enumerable, configurable,
  // getter *and* setter.
  const nativeDesc = Object.getOwnPropertyDescriptor(URL.prototype, 'search');
  assert.equal(nativeDesc.enumerable, true, 'the baseline accessor must be enumerable');
  assert.equal(typeof nativeDesc.set, 'function', 'the baseline accessor must have a setter');
  try {
    assert.equal(wrapInstanceGetter(URL.prototype, 'search', (value) => `${value}&spoofed`), true);
    const wrapped = Object.getOwnPropertyDescriptor(URL.prototype, 'search').get;

    assertIndistinguishable(wrapped, nativeDesc.get, 'get URL.prototype.search');
    assertAccessorDescriptor(URL.prototype, 'search', nativeDesc, 'get URL.prototype.search');

    const url = new URL('https://example.com/?a=1');
    assert.equal(url.search, '?a=1&spoofed', 'the transform must still post-process the read');
    url.search = '?b=2';
    assert.equal(url.href, 'https://example.com/?b=2', 'the native setter must still write');
  } finally {
    Object.defineProperty(URL.prototype, 'search', nativeDesc);
  }
});

test('7.8 (pin): a proxyApply wrapper is shaped like the native method it replaces', () => {
  // The plan calls the Proxy paths clean; this is what makes that checkable.
  const nativeDesc = Object.getOwnPropertyDescriptor(JSON, 'parse');
  const native = nativeDesc.value;
  try {
    assert.equal(
      proxyApply(JSON, 'parse', ({ reflect }) => ({ seen: reflect() })), native,
      'proxyApply must hand back the function it replaced',
    );
    assert.notEqual(JSON.parse, native, 'the wrap must actually be installed');

    assertIndistinguishable(JSON.parse, native, 'JSON.parse');
    assert.match(String(JSON.parse), /\[native code\]/, 'the wrapper must print as native code');

    // `maskNative` redefines `name`/`length` on the Proxy, and a Proxy forwards
    // defineProperty to its target: the native must come out unchanged.
    assert.equal(native.name, 'parse', 'the native name must not have been rewritten');
    assert.equal(native.length, 2, 'the native length must not have been rewritten');

    const desc = Object.getOwnPropertyDescriptor(JSON, 'parse');
    assert.equal(desc.writable, nativeDesc.writable, 'writability must not change');
    assert.equal(desc.enumerable, nativeDesc.enumerable, 'enumerability must not change');
    assert.equal(desc.configurable, nativeDesc.configurable, 'configurability must not change');

    assert.deepEqual(JSON.parse('{"a":1}'), { seen: { a: 1 } }, 'the handler must still run');
  } finally {
    Object.defineProperty(JSON, 'parse', nativeDesc);
  }
});

test('7.8 (pin): maskNative leaves a method-syntax wrapper indistinguishable', () => {
  const native = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
  const wrapper = ({ get() { return 0; } }).get;

  assert.equal(maskNative(wrapper, native), wrapper, 'maskNative must return its wrapper');
  assertIndistinguishable(wrapper, native, 'maskNative(method syntax)');
});

// --- the two scriptlet call sites ------------------------------------------

test('7.8: bot-stealth\'s WebGL wrapper is shaped like the native getParameter', () => {
  const native = WebGLRenderingContextStub.prototype.getParameter;

  botStealth('windows');

  const wrapped = WebGLRenderingContextStub.prototype.getParameter;
  assert.notEqual(wrapped, native, 'the GPU spoof must be installed');
  assertIndistinguishable(wrapped, native, 'WebGLRenderingContext.prototype.getParameter');

  const ctx = new WebGLRenderingContextStub();
  assert.equal(wrapped.call(ctx, 37445), 'Google Inc. (Intel)', 'the vendor spoof must still answer');
  assert.equal(wrapped.call(ctx, 1), 'real:1', 'an unspoofed parameter must still reach the original');
});

test('7.8: spoof-css\'s wrappers are shaped like the natives they replace', () => {
  const nativeGCS = window.getComputedStyle;
  const nativeHeight = Object.getOwnPropertyDescriptor(HTMLElementStub.prototype, 'offsetHeight');

  spoofCss('.ad-slot', 'display', 'block', 'offsetHeight', '7');

  const wrappedGCS = window.getComputedStyle;
  assert.notEqual(wrappedGCS, nativeGCS, 'the getComputedStyle wrapper must be installed');
  assertIndistinguishable(wrappedGCS, nativeGCS, 'window.getComputedStyle');

  const wrappedHeight = Object.getOwnPropertyDescriptor(HTMLElementStub.prototype, 'offsetHeight');
  assert.notEqual(wrappedHeight.get, nativeHeight.get, 'the offsetHeight wrap must be installed');
  assertIndistinguishable(
    wrappedHeight.get, nativeHeight.get, 'get HTMLElement.prototype.offsetHeight',
  );
  assertAccessorDescriptor(
    HTMLElementStub.prototype, 'offsetHeight', nativeHeight,
    'get HTMLElement.prototype.offsetHeight',
  );

  const match = new HTMLElementStub('.ad-slot');
  assert.equal(match.offsetHeight, 7, 'a matching element must still report the spoofed height');
  assert.equal(new HTMLElementStub('.other').offsetHeight, 0,
    'a non-matching element must still read the real height');
  assert.equal(wrappedGCS(match).display, 'block', 'the computed-style pair must still be spoofed');
});
