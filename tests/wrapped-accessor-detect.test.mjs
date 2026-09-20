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
 * §9.6 adds the navigator spoofs to the same treatment. bot-stealth.js and
 * persona-spoof.js each carried a byte-identical local `defineGetter` that
 * installed an *arrow* getter: no own `prototype`, so §7.8's leak was genuinely
 * absent, but an empty `name` and the arrow's own source where a native getter
 * reports `get <prop>` and `[native code]`. Both now go through one shared
 * `defineNativeGetter`, which is exercised below both end to end (every surface
 * the two scriptlets spoof) and directly (the cases the end-to-end sweep cannot
 * reach: a property the platform does not have, and the prototype-chain lookup
 * the locked-prototype fallback depends on).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

// --- Page-realm stand-ins, installed before the scriptlets are imported -----

globalThis.window = globalThis;

class WebGLRenderingContextStub {
  // Declared as a class method, like the platform's: `length` and `name` are
  // its only own properties, so it is a faithful baseline to compare against.
  getParameter(parameter) { return `real:${parameter}`; }
}
globalThis.WebGLRenderingContext = WebGLRenderingContextStub;

// A WebIDL attribute is an *enumerable* configurable accessor; a class getter
// is not enumerable. Match the platform so "the descriptor shape does not
// change" is actually being tested.
function asIdlAttributes(proto, props) {
  for (const prop of props) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    Object.defineProperty(proto, prop, { ...desc, enumerable: true });
  }
}

// `Navigator.prototype` as the platform builds it. The empty `class Navigator
// {}` the older scriptlet suites use cannot show any of this: with no native
// accessor there is nothing for a spoofed one to be told apart from, and
// `Object.defineProperty` has no existing attributes to preserve.
class NavigatorStub {
  get userAgent() { return 'Mozilla/5.0 (X11; Linux x86_64) RealBrowser/1.0'; }
  get appVersion() { return '5.0 (X11; Linux x86_64) RealBrowser/1.0'; }
  get platform() { return 'Linux x86_64'; }
  get webdriver() { return true; }
  get languages() { return []; }
  get userAgentData() { return { brands: [], mobile: false, platform: 'Linux' }; }
}
asIdlAttributes(NavigatorStub.prototype, [
  'userAgent', 'appVersion', 'platform', 'webdriver', 'languages', 'userAgentData',
]);
globalThis.Navigator = NavigatorStub;
// Node ships a getter-only `navigator` global; replace it wholesale.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: new NavigatorStub(),
});

class HTMLElementStub {
  constructor(selector) { this.selector = selector; }
  matches(sel) { return sel === this.selector; }
  get offsetHeight() { return 0; }
  get offsetWidth() { return 0; }
  get offsetParent() { return null; }
}
asIdlAttributes(HTMLElementStub.prototype, ['offsetHeight', 'offsetWidth', 'offsetParent']);
globalThis.HTMLElement = HTMLElementStub;
globalThis.document = { body: { tagName: 'BODY' } };

// The platform's `getComputedStyle` is a native method: no own `prototype`.
globalThis.getComputedStyle = ({
  getComputedStyle(_el, _pseudo) {
    return { display: 'none', getPropertyValue: () => 'none' };
  },
}).getComputedStyle;

const { defineNativeGetter, maskNative, proxyApply, wrapInstanceGetter } =
  await import('../src/scriptlets/shared-utils.js');

// The same module source, evaluated as a classic script in a throwaway realm.
// `shared-utils.js` is import-free and side-effect-free at load, which is what
// makes this possible — the shield harness relies on the same property.
const SHARED_UTILS_SCRIPT = (await readFile(
  new URL('../src/scriptlets/shared-utils.js', import.meta.url), 'utf8',
)).replace(/^export\s+/gm, '');
const { botStealth } = await import('../src/scriptlets/bot-stealth.js');
const { spoofCss } = await import('../src/scriptlets/spoof-css.js');
const { personaSpoof } = await import('../src/scriptlets/persona-spoof.js');

// Both navigator scriptlets carry a module-level "already applied" guard, so
// they are applied once here rather than inside a test — otherwise every later
// test would silently depend on which test ran first. The natives they replace
// are captured before they run.
const NATIVE_GET_PARAMETER = WebGLRenderingContextStub.prototype.getParameter;
const NATIVE_NAVIGATOR = new Map(
  Object.getOwnPropertyNames(NavigatorStub.prototype)
    .filter((prop) => prop !== 'constructor')
    .map((prop) => [prop, Object.getOwnPropertyDescriptor(NavigatorStub.prototype, prop)]),
);
botStealth('windows');
personaSpoof('windows');

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
  const native = NATIVE_GET_PARAMETER;
  const wrapped = WebGLRenderingContextStub.prototype.getParameter;
  assert.notEqual(wrapped, native, 'the GPU spoof must be installed');
  assertIndistinguishable(wrapped, native, 'WebGLRenderingContext.prototype.getParameter');

  const ctx = new WebGLRenderingContextStub();
  assert.equal(wrapped.call(ctx, 37445), 'Google Inc. (Intel)', 'the vendor spoof must still answer');
  assert.equal(wrapped.call(ctx, 1), 'real:1', 'an unspoofed parameter must still reach the original');
});

// --- §9.6: the navigator spoofs ------------------------------------------
//
// bot-stealth.js and persona-spoof.js each carried a byte-identical local
// `defineGetter` that installed an *arrow* getter with a partial descriptor.
// Arrows have no `prototype`, so §7.8's leak is genuinely absent — but the
// accessor still reported an empty `name` and its own source where a native
// reports `get <prop>` and `[native code]`, on `navigator.userAgent`,
// `.webdriver` and the four other surfaces an anti-automation check reads
// first. Everything is derived from the before/after descriptors rather than
// a hard-coded list, so a surface added to either scriptlet is covered here
// the day it is added.

test('9.6: every navigator surface the scriptlets spoof stays shaped like the native', () => {
  // Non-vacuity: if the spoofs stopped applying, the loop below would have
  // nothing to check and would pass.
  for (const prop of ['userAgent', 'platform', 'webdriver']) {
    assert.notEqual(
      Object.getOwnPropertyDescriptor(NavigatorStub.prototype, prop).get,
      NATIVE_NAVIGATOR.get(prop).get,
      `${prop} must actually be spoofed for this test to mean anything`,
    );
  }

  let checked = 0;
  for (const [prop, native] of NATIVE_NAVIGATOR) {
    const after = Object.getOwnPropertyDescriptor(NavigatorStub.prototype, prop);
    if (after.get === native.get) continue; // this surface is not spoofed
    checked += 1;
    assertIndistinguishable(after.get, native.get, `get Navigator.prototype.${prop}`);
    assertAccessorDescriptor(
      NavigatorStub.prototype, prop, native, `get Navigator.prototype.${prop}`,
    );
  }
  assert.ok(checked >= 6, `expected every spoofed surface to be checked; saw ${checked}`);

  // The spoofs must land on the prototype: a real browser's `navigator` has no
  // own properties at all, so one appearing there is the §4.4 instance leak.
  assert.deepEqual(Object.getOwnPropertyNames(navigator), [],
    'nothing may land as an own property of the navigator instance');
});

test('9.6: defineNativeGetter takes the descriptor from the prototype chain, not the own slot', () => {
  // The locked-prototype fallback defines on the instance, whose own
  // descriptor list is empty — the native to copy lives on the prototype. Read
  // only the own slot and `enumerable` silently defaults to false.
  const proto = {};
  const writes = [];
  Object.defineProperty(proto, 'thing', {
    get() { return 'native'; },
    set(v) { writes.push(v); },
    enumerable: true,
    configurable: true,
  });
  const native = Object.getOwnPropertyDescriptor(proto, 'thing');
  const instance = Object.create(proto);

  assert.equal(defineNativeGetter(instance, 'thing', () => 'spoofed'), true);

  const desc = Object.getOwnPropertyDescriptor(instance, 'thing');
  assert.equal(instance.thing, 'spoofed', 'the spoof must answer');
  assert.equal(desc.enumerable, true,
    'enumerability must come from the prototype, not default to false');
  assert.equal(desc.configurable, true);
  assert.equal(desc.set, native.set, 'the native setter must be carried over, not dropped');
  instance.thing = 'written';
  assert.deepEqual(writes, ['written'], 'and must still receive writes');
  assertIndistinguishable(desc.get, native.get, 'get instance.thing');
});

test('9.6: defineNativeGetter gives a property the platform lacks the shape one would have', () => {
  const target = {};

  assert.equal(defineNativeGetter(target, 'invented', () => 7), true);

  const desc = Object.getOwnPropertyDescriptor(target, 'invented');
  assert.equal(target.invented, 7, 'the spoof must answer');
  assert.equal(desc.enumerable, true, 'a WebIDL attribute is enumerable');
  assert.equal(desc.configurable, true, 'and configurable');
  assert.equal(desc.get.name, 'get invented', 'named the way the platform names a getter');
  assert.equal(desc.get.length, 0);
  assert.equal(Object.prototype.hasOwnProperty.call(desc.get, 'prototype'), false,
    'still method syntax — no own prototype (§7.8)');
  assert.throws(() => new desc.get(), TypeError, 'and not constructible');
});

test('9.6: defineNativeGetter reports failure rather than throwing on a locked target', () => {
  const target = Object.freeze({});
  assert.equal(defineNativeGetter(target, 'nope', () => 1), false,
    'a frozen target must yield false, which is what drives the instance fallback');
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

// --- §9.19: masking that fails must say so ---------------------------------
//
// `maskNative` used to swallow a failed `Object.defineProperty` and hand the
// wrapper back regardless, so a caller could install a function that still
// reports its own `name` and believe it was hidden. That is the one failure in
// this module that is a correctness problem rather than a detectability one: a
// leak of exactly the class closed three times over would ship green.
//
// No caller can do anything useful with the failure — an unmasked wrapper
// still intercepts, it is merely detectable, which beats not intercepting at
// all — so every one of them deliberately ignores the result. The signal
// exists so a future caller, and these tests, can see it.

test('9.19: a wrapper that could not be masked is reported, not handed back', () => {
  const native = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
  const wrapper = Object.freeze(({ get() { return 0; } }).get);

  assert.equal(maskNative(wrapper, native), null,
    'a frozen wrapper cannot take the native name, and that must be reported');
  assert.notEqual(wrapper.name, native.name,
    'and the wrapper really is unmasked — the report is not spurious');
});

test('9.19: maskNative reports non-function arguments rather than returning them', () => {
  const native = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
  assert.equal(maskNative(null, native), null);
  assert.equal(maskNative(({ get() {} }).get, undefined), null);
});

test('9.19: proxyApply reports an assignment the owner silently ignored', () => {
  // An assignment to a non-writable property throws only in strict mode; a
  // sloppy-mode realm — which is how the shield harness evaluates this module
  // — drops it silently, and an owner that traps `set` can drop it in any
  // mode. Either way the wrapper is not installed, so saying so is the only
  // honest answer.
  const target = { m() { return 'native'; } };
  const owner = new Proxy(target, { set: () => true });

  assert.equal(proxyApply(owner, 'm', ({ reflect }) => reflect()), null,
    'nothing was installed, so the caller must not be told it was');
  assert.equal(owner.m, target.m, 'and the original is still in place');
});

test('9.19: maskNative reports failure when the page has frozen Function.prototype', () => {
  // The whole-bundle `Function.prototype.toString` proxy is what makes a
  // wrapper print as native code. A page that freezes `Function.prototype`
  // — a known anti-adblock move — defeats it for every wrapper at once, and
  // the assignment that installs it fails *silently* in a sloppy-mode realm,
  // which is how the shield harness evaluates this module. A fresh realm is
  // the only way to test it: the mask is process-wide and one-way.
  const context = vm.createContext({});
  vm.runInContext('Object.freeze(Function.prototype);', context);
  vm.runInContext(SHARED_UTILS_SCRIPT, context);

  const result = JSON.parse(vm.runInContext(`(() => {
    const native = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
    const wrapper = ({ get() { return 0; } }).get;
    const returned = maskNative(wrapper, native);
    return JSON.stringify({
      reported: returned === null,
      source: String(wrapper),
    });
  })()`, context));

  assert.equal(result.reported, true,
    'masking that could not be installed must be reported, not assumed');
  assert.match(result.source, /return 0/,
    'and the wrapper really does still print its own source');
});
