import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;

// --- Minimal browser scaffolding -------------------------------------------

class FakeCanvasContext {
  getImageData() { return { data: new Uint8Array(256) }; }
}
class FakeCanvas {
  getContext() { return new FakeCanvasContext(); }
  toDataURL() { return 'data:image/png;base64,'; }
}
globalThis.CanvasRenderingContext2D = FakeCanvasContext;
globalThis.HTMLCanvasElement = FakeCanvas;

globalThis.Navigator = class Navigator {};
// Node ships a getter-only `navigator` global; replace it wholesale.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: new globalThis.Navigator(),
});

class FakeWebGL {
  getParameter() { return 'real-gpu'; }
}
globalThis.WebGLRenderingContext = FakeWebGL;

let cookieJar = [];
let cookieWritable = true;
globalThis.document = { createElement: () => new FakeCanvas() };
Object.defineProperty(globalThis.document, 'cookie', {
  configurable: true,
  get() { return cookieJar.join('; '); },
  set(v) { if (cookieWritable) cookieJar.push(v.split(';')[0].trim()); },
});

const sessionStore = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
  setItem: (k, v) => sessionStore.set(k, String(v)),
};

const localStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
  setItem: (k, v) => localStore.set(k, String(v)),
  removeItem: (k) => localStore.delete(k),
  // uBO's `$remove$` enumerates the store to find every key matching the
  // (verbatim) pattern, so the stub needs the index API.
  get length() { return localStore.size; },
  key: (i) => [...localStore.keys()][i] ?? null,
};

let reloads = 0;
globalThis.location = { protocol: 'https:', reload: () => { reloads++; } };

const { fingerprintNoise } = await import('./fingerprint-noise.js');
const { botStealth } = await import('./bot-stealth.js');
const { personaSpoof } = await import('./persona-spoof.js');
const { setCookiePath } = await import('./set-cookie-reload.js');
const { setLocalStorageItem } = await import('./set-local-storage-item.js');
const { trustedSetConstant } = await import('./trusted-set-constant.js');
const { noSetTimeout } = await import('./no-set-timeout-if.js');

// §4.28 — the "already applied" guards were fixed-name globals: one inline
// page script setting all three flags disabled every anti-fingerprinting
// scriptlet. The guards now live in module scope, unreachable from the page.

test('fingerprint-noise: page-set kill-switch flag is ignored', () => {
  const original = FakeCanvasContext.prototype.getImageData;
  globalThis.__nullifyFingerprintNoiseApplied = true; // hostile inline script

  fingerprintNoise();

  assert.notEqual(
    FakeCanvasContext.prototype.getImageData, original,
    'canvas patch must apply despite the page-set flag',
  );
});

test('bot-stealth: page-set kill-switch flag is ignored; no own marker property', () => {
  globalThis.__nullifyBotStealthApplied = true; // hostile inline script

  botStealth('windows');

  assert.equal(navigator.webdriver, false, 'webdriver spoof must apply despite the flag');
  const getParameter = FakeWebGL.prototype.getParameter;
  assert.equal(getParameter.call({}, 37445), 'Google Inc. (Intel)', 'GPU vendor spoofed');
  // §5.34 — the wrapper was marked with an own enumerable `__nullifyPatched`
  // property, visible to Object.keys. Marking now lives in a WeakSet.
  assert.equal(
    Object.prototype.hasOwnProperty.call(getParameter, '__nullifyPatched'), false,
    'no page-visible marker on the patched function',
  );
});

test('persona-spoof: page-set kill-switch flag is ignored', () => {
  globalThis.__nullifyPersonaSpoof = 'windows'; // hostile inline script

  personaSpoof('windows');

  assert.match(navigator.userAgent, /Windows NT 10\.0/, 'persona must apply despite the flag');
});

// §5.35 — one global reload-guard key, checked before the write: the first
// set-cookie-reload rule on an origin starved every other one in the tab, and
// a failed cookie write still armed the guard permanently.

test('set-cookie-reload: guard is scoped per cookie, so a second rule still works', () => {
  cookieJar = [];
  reloads = 0;

  setCookiePath('cookieA', '1');
  assert.match(document.cookie, /cookieA=1/);
  assert.equal(reloads, 1);

  setCookiePath('cookieB', '2'); // prior code: global guard already set -> silently dropped
  assert.match(document.cookie, /cookieB=2/, 'second rule must not be starved by the first');
  assert.equal(reloads, 2);
});

test('set-cookie-reload: a rejected write neither arms the guard nor reloads', () => {
  cookieJar = [];
  reloads = 0;
  cookieWritable = false;

  setCookiePath('cookieC', '3');
  assert.equal(reloads, 0, 'must not reload without a persisted cookie');
  assert.equal(sessionStorage.getItem('__nullify_reload_guard__cookieC=3'), null);

  cookieWritable = true;
  setCookiePath('cookieC', '3'); // retry once writes work again
  assert.equal(reloads, 1, 'the guard must not have been armed by the failure');
});

// §5.37 — uBO's `$remove$` sentinel deletes the item; 51 shipped rules were
// writing the literal string "$remove$" instead.

test('set-local-storage-item: $remove$ deletes the key and keeps it deleted', () => {
  localStore.set('adFreeUntil', '0');

  setLocalStorageItem('adFreeUntil', '$remove$');
  assert.equal(localStorage.getItem('adFreeUntil'), null, 'item must be removed, not written');

  localStorage.setItem('adFreeUntil', '12345'); // page re-sets it
  assert.equal(localStorage.getItem('adFreeUntil'), null, 'the removal must stick');

  localStorage.setItem('unrelated', 'x');
  assert.equal(localStorage.getItem('unrelated'), 'x', 'other keys pass through');
});

test('set-local-storage-item: normal values still resolve and pin', () => {
  setLocalStorageItem('cmpConsent', 'emptyArr');
  assert.equal(localStorage.getItem('cmpConsent'), '[]');
  localStorage.setItem('cmpConsent', '{"ads":true}');
  assert.equal(localStorage.getItem('cmpConsent'), '[]', 'writes to the key stay pinned');
});

// §5.37 — trusted-set-constant defined the property configurable: false,
// permanently locking the path; any later rule on it threw into a swallow.

test('trusted-set-constant: stays configurable so a later rule can redefine', () => {
  trustedSetConstant('__tscProp', 'true');
  assert.equal(globalThis.__tscProp, true);
  assert.equal(
    Object.getOwnPropertyDescriptor(globalThis, '__tscProp').configurable, true,
    'the property must not be permanently locked',
  );

  trustedSetConstant('__tscProp', '42');
  assert.equal(globalThis.__tscProp, 42, 'a later rule on the same path must win');
});

// §5.36 — the noopTokens Set was written on every suppressed call and never
// read: unbounded growth on polling pages. This pins the observable contract
// the Set was (not) serving: suppression and clearTimeout passthrough.

test('no-set-timeout-if: suppression and clearTimeout routing survive the Set removal', () => {
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  const cleared = [];
  try {
    globalThis.setTimeout = (fn, ms) => { scheduled.push(ms); return 111; };
    globalThis.clearTimeout = (id) => { cleared.push(id); };

    noSetTimeout('showAds');

    const token = window.setTimeout('showAds();', 50);
    assert.equal(typeof token, 'string', 'suppressed call returns a fake token');
    assert.deepEqual(scheduled, [], 'nothing must be scheduled');

    window.clearTimeout(token);
    assert.deepEqual(cleared, [], 'fake tokens are swallowed');

    window.setTimeout(() => {}, 60);
    assert.deepEqual(scheduled, [60], 'non-matching calls pass through');
    window.clearTimeout(111);
    assert.deepEqual(cleared, [111], 'real ids pass through');
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }
});
