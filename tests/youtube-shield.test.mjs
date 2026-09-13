/**
 * Regression suite for the MAIN-world YouTube shield content script
 * (src/content/youtube-shield.js), covering docs/REVIEW-2026-07.md:
 *
 *   §4.30 — the ytcfg.set wrapper ran once synchronously at document_start,
 *           before the page defines window.ytcfg, so the poison branch never
 *           ran on fresh navigations. Fixed with a defineProperty assignment
 *           trap (same technique as the shield() variable traps).
 *   §5.32 — the bounded player poll (~6.15 s) gave up permanently in
 *           background tabs; re-arming depended on yt-navigate events that
 *           tab focus doesn't fire. Fixed by re-arming on visibilitychange.
 *
 * The shield is a document_start IIFE whose module evaluation has global side
 * effects, so each scenario evaluates the source in a fresh `vm` context with
 * stubbed DOM/timer globals instead of importing it through the module cache.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SHIELD_URL = new URL('../src/content/youtube-shield.js', import.meta.url);
const SHARED_UTILS_URL = new URL('../src/scriptlets/shared-utils.js', import.meta.url);

// Sum of PLAYER_POLL_DELAYS (50+100+200+400+800+1600+3000) plus slack — long
// enough that the bounded poll chain is fully exhausted.
const POLL_CHAIN_EXHAUSTED_MS = 7000;

let _shieldBody = null;
async function shieldBody() {
  if (_shieldBody === null) {
    const source = await readFile(SHIELD_URL, 'utf8');
    const start = source.indexOf('(function() {');
    assert.notEqual(start, -1, 'youtube-shield.js IIFE start not found');
    _shieldBody = source.slice(start);
  }
  return _shieldBody;
}

// The shield imports `proxyApply`/`wrapInstanceGetter` (and through them the
// bundle-wide `Function.prototype.toString` mask) from shared-utils.js, which
// webpack inlines into the youtube-shield chunk. The harness evaluates the
// real module source, exports stripped, ahead of the IIFE — so the §4.4
// detectors below run against the genuine masking rather than a stand-in.
// shared-utils.js is import-free and side-effect-free at load, which is what
// makes evaluating it as a script possible.
let _sharedUtilsBody = null;
async function sharedUtilsBody() {
  if (_sharedUtilsBody === null) {
    const source = await readFile(SHARED_UTILS_URL, 'utf8');
    assert.equal(/^import\b/m.test(source), false,
      'shared-utils.js must stay import-free for the shield harness to inline it');
    _sharedUtilsBody = source.replace(/^export\s+/gm, '');
  }
  return _sharedUtilsBody;
}

// Stand-ins for the module's static imports. The WASM path stays cold unless
// a test passes `wasmUrl` (no chrome.runtime, no data-nullify-wasm attribute
// otherwise), so the synchronous poison baseline is what gets exercised —
// exactly the fresh document_start situation §4.30 describes. When a test does
// arm the WASM path, `initWasmFromUrl` stays pending until the test calls
// `releaseWasm()`, so "before ready" and "after ready" are deterministic.
const IMPORT_STUBS = `
  const init = async () => {};
  const process_youtube_player = (text) => text;
  const sanitize_youtube_experiments = (text) => text;
  const initWasmFromUrl = () => new Promise((resolve) => { globalThis.__releaseWasm = resolve; });
`;

// The bundle is evaluated once per injection, and the shield is injected more
// than once per frame in production (document_start registration plus the
// injectIntoOpenTabs late-injection path), so each evaluation gets its own
// block scope — exactly like two separate executeScript calls.
const injectionSource = (body, utils) => `{\n${IMPORT_STUBS}\n${utils}\n${body}\n}`;

// The §4.4 detector table (docs/REVIEW-2026-09.md §4.4): everything a page
// can learn about a wrapped surface without calling it. Evaluated inside the
// vm realm before and after injection; the two readings must be identical.
//
// `Function.prototype.toString.call(fn)` rather than `String(fn)`: the
// harness's stand-in natives (XHR, Document, pageFetch, Response) live in the
// host realm, so `String()` on a wrapper would resolve `toString` through the
// *host* Function.prototype and never reach the vm realm's mask. In a real
// page there is one realm and the two spellings are the same call.
//
// Own keys are recorded for the callable surfaces (a Proxy forwards them to
// its native target) but not for the accessor functions: shared-utils'
// `wrapInstanceGetter` builds those with a function expression, which carries
// an own `prototype` a native getter lacks — a shared-utils concern, tracked
// separately from this file.
const DETECTOR_SNIPPET = `(() => {
  const describe = (fn, withKeys) => (typeof fn === 'function' ? {
    name: fn.name,
    length: fn.length,
    source: Function.prototype.toString.call(fn),
    ...(withKeys ? { ownKeys: Reflect.ownKeys(fn).map(String) } : {}),
  } : null);
  const callable = (fn) => describe(fn, true);
  const getter = (proto, prop) =>
    describe(Object.getOwnPropertyDescriptor(proto, prop)?.get, false);
  const xp = XMLHttpRequest.prototype;
  return JSON.stringify({
    'JSON.parse': callable(JSON.parse),
    'fetch': callable(window.fetch),
    'Response.prototype.json': callable(Response.prototype.json),
    'XMLHttpRequest': callable(XMLHttpRequest),
    'XMLHttpRequest.prototype.open': callable(xp.open),
    'XMLHttpRequest.prototype.send': callable(xp.send),
    'get XMLHttpRequest.prototype.responseText': getter(xp, 'responseText'),
    'get XMLHttpRequest.prototype.response': getter(xp, 'response'),
    'get XMLHttpRequest.prototype.readyState': getter(xp, 'readyState'),
    'get XMLHttpRequest.prototype.status': getter(xp, 'status'),
    'get XMLHttpRequest.prototype.statusText': getter(xp, 'statusText'),
    'get XMLHttpRequest.prototype.responseURL': getter(xp, 'responseURL'),
    'document.requestStorageAccess': callable(document.requestStorageAccess),
    'document.requestStorageAccessFor': callable(document.requestStorageAccessFor),
    'Function.prototype.toString': callable(Function.prototype.toString),
  });
})()`;

// Lets the vm context's pending microtasks (the WASM bootstrap chain) drain.
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

function makeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, delay = 0, ...args) {
      seq += 1;
      pending.set(seq, { fn, args, at: now + Math.max(0, Number(delay) || 0) });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let nextId = null;
        let nextAt = Infinity;
        for (const [id, timer] of pending) {
          if (timer.at <= end && timer.at < nextAt) {
            nextAt = timer.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const timer = pending.get(nextId);
        pending.delete(nextId);
        now = timer.at;
        timer.fn(...timer.args);
      }
      now = end;
    },
    pendingCount: () => pending.size,
  };
}

function makePlayerStub() {
  return {
    id: 'movie_player',
    classList: { contains: () => false },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// The shield patches `Response.prototype.json`. Handing it the host realm's
// global Response would permanently mutate this test process's Response, so
// every harness gets its *own* throwaway subclass: the patch lands as an own
// property on that subclass's prototype and the real prototype is left alone.
// Everything else (clone/text/headers/status) is the genuine platform
// implementation, which is what the fetch body scrubber has to survive.
const makeHarnessResponse = () => class HarnessResponse extends Response {};

async function makeShieldHarness({
  visibilityState = 'visible',
  player = null,
  setup,
  wasmUrl = null,
  fetchImpl = null,
} = {}) {
  const timers = makeTimers();
  const observers = [];
  let currentPlayer = player;

  class MutationObserverStub {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(target, options) {
      this.targets.push({ target, options });
    }
    disconnect() {
      this.disconnected = true;
    }
    takeRecords() {
      return [];
    }
  }

  class XMLHttpRequestStub {
    // The platform rejects a non-instance receiver with its own TypeError;
    // a wrapper must let that error through rather than raise its own.
    open() {
      if (!(this instanceof XMLHttpRequestStub)) {
        throw new TypeError("Failed to execute 'open' on 'XMLHttpRequest': Illegal invocation");
      }
    }
    send() {}
    addEventListener() {}
    dispatchEvent() {
      return true;
    }
    get responseText() { return ''; }
    get response() { return null; }
    get readyState() { return 0; }
    get status() { return 0; }
    get statusText() { return ''; }
    get responseURL() { return ''; }
    get responseType() { return ''; }
  }

  const docListeners = new Map();
  const winListeners = new Map();
  const addListener = (map) => (type, fn) => {
    const list = map.get(type) || [];
    list.push(fn);
    map.set(type, list);
  };
  const emit = (map) => (type) => {
    for (const fn of map.get(type) || []) fn({ type });
  };

  // `document` inherits the storage-access methods from a prototype, as it
  // does on the platform, so an own-property write on `document` is visible
  // as the leak it is (§4.4).
  class DocumentStub {
    requestStorageAccess() { return Promise.reject(new Error('page-owned')); }
    requestStorageAccessFor() { return Promise.reject(new Error('page-owned')); }
  }
  const documentStub = Object.assign(Object.create(DocumentStub.prototype), {
    visibilityState,
    documentElement: {
      getAttribute: (name) => (name === 'data-nullify-wasm' ? wasmUrl : null),
    },
    querySelector: (sel) => (sel === '#movie_player' ? currentPlayer : null),
    addEventListener: addListener(docListeners),
    removeEventListener: () => {},
  });

  const sandbox = {
    console: { info: () => {}, warn: () => {}, error: () => {} },
    document: documentStub,
    Document: DocumentStub,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    requestAnimationFrame: (fn) => timers.setTimeout(fn, 16),
    cancelAnimationFrame: (id) => timers.clearTimeout(id),
    MutationObserver: MutationObserverStub,
    XMLHttpRequest: XMLHttpRequestStub,
    Element: class Element {},
    Event: class Event {
      constructor(type) { this.type = type; }
    },
    ProgressEvent: class ProgressEvent {
      constructor(type) { this.type = type; }
    },
    Response: makeHarnessResponse(),
    Headers,
    // Named so a test can tell the page's own fetch from the shield's wrapper.
    fetch: fetchImpl || async function pageFetch() { return { ok: true }; },
    addEventListener: addListener(winListeners),
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  const run = (code) => vm.runInContext(code, context, { filename: 'youtube-shield.vm.js' });
  const body = await shieldBody();
  const utils = await sharedUtilsBody();
  const inject = () => run(injectionSource(body, utils));
  if (setup) run(setup);
  // What the page had before the shield ran (after any `setup`): the
  // identities the layer probes compare against, and the §4.4 detector
  // reading every wrapper must reproduce.
  const originals = {
    fetch: sandbox.fetch,
    XMLHttpRequest: sandbox.XMLHttpRequest,
    xhrOpen: sandbox.XMLHttpRequest.prototype.open,
    xhrSend: sandbox.XMLHttpRequest.prototype.send,
    responseJson: sandbox.Response.prototype.json,
    requestStorageAccess: sandbox.Document.prototype.requestStorageAccess,
    functionToString: run('Function.prototype.toString'),
  };
  const detect = () => JSON.parse(run(DETECTOR_SNIPPET));
  const before = detect();
  inject();

  return {
    run,
    inject,
    originals,
    detect,
    before,
    releaseWasm: async () => {
      run('__releaseWasm && __releaseWasm()');
      await flushAsync();
    },
    timers,
    observers,
    playerObservers: () =>
      observers.filter(
        (o) => !o.disconnected && o.targets.some((t) => t.target === currentPlayer)
      ),
    setPlayer: (p) => { currentPlayer = p; },
    setVisibility: (state) => { documentStub.visibilityState = state; },
    emitDocument: emit(docListeners),
    emitWindow: emit(winListeners),
  };
}

// ---------------------------------------------------------------------------
// §4.12 — the idempotency guard must not be a page-operable kill switch
// ---------------------------------------------------------------------------

// Every interception layer the old writable-global guard could switch off.
// The fetch/XHR layers are recognised by identity against the pre-injection
// originals: since §4.4 a wrapper is indistinguishable by name or source, so
// "installed" can only mean "not the function the page had before".
const trapProbe = (prop) => (h) =>
  h.run(`typeof Object.getOwnPropertyDescriptor(window, '${prop}')?.set === 'function'`);
const LAYER_PROBES = {
  'JSON.parse hook': (h) => h.run('JSON.parse(\'{"adPlacements":[1]}\').adPlacements === false'),
  'fetch interceptor': (h) => h.run('window.fetch') !== h.originals.fetch,
  'XHR interceptor': (h) =>
    h.run('XMLHttpRequest.prototype.open') !== h.originals.xhrOpen
    && h.run('XMLHttpRequest.prototype.send') !== h.originals.xhrSend,
  'ytcfg trap': trapProbe('ytcfg'),
  'yt trap': trapProbe('yt'),
  'ytInitialPlayerResponse trap': trapProbe('ytInitialPlayerResponse'),
  'playerResponse trap': trapProbe('playerResponse'),
  'ytInitialData trap': trapProbe('ytInitialData'),
  'initialPlayerResponse trap': trapProbe('initialPlayerResponse'),
};

function assertAllLayersInstalled(h, why) {
  for (const [layer, probe] of Object.entries(LAYER_PROBES)) {
    assert.equal(probe(h), true, `${layer} must be installed ${why}`);
  }
}

test('§4.12: a page-planted kill-switch global no longer disables the shield', async () => {
  // One line of page script used to switch off every layer below.
  const h = await makeShieldHarness({
    player: makePlayerStub(),
    setup: `
      window.__nullifyYoutubeShield = {
        loaded: true, version: 2, versions: [0, 1, 2, 3, 4, 5],
      };
      window.__nullifyYoutubeWasm = { status: 'ready', ready: true };
    `,
  });

  assertAllLayersInstalled(h, 'despite the page-planted flag');
  assert.equal(h.playerObservers().length, 1,
    'the DOM ad-skipper must attach despite the page-planted flag');
});

test('§4.12: a forged hook without the pruning behaviour does not disable the shield', async () => {
  // The guard is purely behavioural (§4.4 removed the named brand): a page
  // that wraps JSON.parse in a hook-shaped function — and even plants the
  // symbol an older shield generation used to carry — only counts as
  // "installed" if the wrapper actually neutralizes ad payloads, which a
  // bare forgery does not.
  const h = await makeShieldHarness({
    player: makePlayerStub(),
    setup: `
      const pageParse = JSON.parse;
      JSON.parse = function parse(text, ...rest) { return pageParse.call(this, text, ...rest); };
      Object.defineProperty(JSON.parse, Symbol.for('$$jsonParseHookVersion'), {
        value: 99, writable: false, enumerable: false, configurable: false,
      });
    `,
  });

  assertAllLayersInstalled(h, 'despite the forged hook');
});

test('§4.12: the shield publishes no self-identifying global', async () => {
  const h = await makeShieldHarness();

  assert.equal(h.run("'__nullifyYoutubeShield' in window"), false,
    'the shield must not announce itself by name and version');
  assert.equal(h.run("'__nullifyYoutubeWasm' in window"), false,
    'the WASM bootstrap must not publish its status/source to the page');
  assert.equal(
    h.run('Object.getOwnPropertyNames(window).filter((n) => /nullify/i.test(n)).join(",")'),
    '',
    'no nullify-named global may be reachable from the page',
  );
});

test('§4.12 (didn\'t re-break): a second injection into the same frame is a no-op', async () => {
  // injectIntoOpenTabs re-runs the bundle on install, update, allowlist change
  // and settings change; without a working guard every one of those stacks
  // another copy of every interceptor.
  const h = await makeShieldHarness({ player: makePlayerStub() });
  h.run(`globalThis.__before = {
    parse: JSON.parse, fetch: window.fetch,
    open: XMLHttpRequest.prototype.open, send: XMLHttpRequest.prototype.send,
  };`);

  h.inject();

  assert.equal(h.run('JSON.parse === __before.parse'), true, 'JSON.parse must not be re-wrapped');
  assert.equal(h.run('window.fetch === __before.fetch'), true, 'fetch must not be re-wrapped');
  assert.equal(h.run('XMLHttpRequest.prototype.open === __before.open'), true,
    'XHR open must not be re-wrapped');
  assert.equal(h.run('XMLHttpRequest.prototype.send === __before.send'), true,
    'XHR send must not be re-wrapped');
  assert.equal(h.playerObservers().length, 1, 'the ad-skipper must not attach twice');
});

test('§4.12 (didn\'t re-break): a re-injection still installs when the page unhooked JSON.parse', async () => {
  // The guard reads the shield's own behaviour, so a page that tore the hook
  // out gets the shield reinstalled rather than permanently disabled.
  const h = await makeShieldHarness();
  h.run('JSON.parse = function pageParse() { return { adPlacements: [1] }; };');

  h.inject();

  assert.equal(h.run('JSON.parse(\'{"adPlacements":[1]}\').adPlacements'), false,
    're-injection must re-install the JSON.parse hook');
});

// ---------------------------------------------------------------------------
// §4.4 (REVIEW-2026-09) — every wrapper must be indistinguishable from the
// platform original, and the shield must carry no readable brand.
//
// The shield exists to beat YouTube's anti-adblock detection, and until this
// section it could be identified by name and version in one expression:
// `JSON.parse.name === ""`, `String(fetch)` printing our source, an
// `XMLHttpRequest` subclass with `_nUrl/_nCached/_nBlocked` on every
// instance, `document.requestStorageAccess` reading as an arrow function,
// and `JSON.parse[Symbol.for('$$jsonParseHookVersion')]` yielding the
// shield version.
// ---------------------------------------------------------------------------

const PLAYER_XHR_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const BLOCKED_XHR_URL = 'https://www.youtube.com/api/stats/ad_break';

// A page-realm XHR stand-in that records what the shield does to it. The
// readyState getter counts its reads: the shield's text path consults
// readyState once per interceptor layer, so the count is a wrapper-depth
// probe that a stacked second installation doubles.
const RECORDING_XHR_SETUP = `
  globalThis.__xhr = { readyStateReads: 0, nativeReadyState: 4, sent: [], events: [] };
  window.XMLHttpRequest = class XMLHttpRequest {
    open() {}
    send(body) { __xhr.sent.push(body); }
    addEventListener() {}
    dispatchEvent(event) { __xhr.events.push(event.type); return true; }
    get responseText() { return '{"adPlacements":[1],"streamingData":{}}'; }
    get response() { return '{"adPlacements":[1],"streamingData":{}}'; }
    get readyState() { __xhr.readyStateReads += 1; return __xhr.nativeReadyState; }
    get status() { return 200; }
    get statusText() { return 'OK'; }
    get responseURL() { return 'native'; }
    get responseType() { return ''; }
  };
`;

test('4.4: every wrapper reports native name, length and source', async () => {
  const h = await makeShieldHarness({ player: makePlayerStub() });
  assertAllLayersInstalled(h, 'before the detector runs');

  const after = h.detect();
  for (const [surface, before] of Object.entries(h.before)) {
    assert.notEqual(before, null, `${surface} must exist in the harness for the detector to cover it`);
    assert.deepEqual(after[surface], before,
      `${surface} must read exactly as the platform original did before injection`);
  }
  // The surfaces that are genuine natives in the vm realm must still print as
  // such through the wrapper. (The stand-ins print their own source, and so
  // does Node's Response.prototype.json, which undici implements in JS — the
  // equality above is what covers those.)
  for (const surface of ['JSON.parse', 'Function.prototype.toString']) {
    assert.match(after[surface].source, /\[native code\]/, `${surface} must print as native code`);
  }
});

test('4.4: XMLHttpRequest is the platform constructor and instances have no own properties', async () => {
  const h = await makeShieldHarness();
  assertAllLayersInstalled(h, 'before the instance probe');

  assert.equal(h.run('window.XMLHttpRequest'), h.originals.XMLHttpRequest,
    'the constructor the page sees must be the platform one, not a subclass');
  assert.equal(h.run('Reflect.ownKeys(new XMLHttpRequest()).length'), 0,
    'a fresh instance must carry no own properties');

  // Per-request state must live off the instance across the whole request
  // lifecycle, on both the scrub path and the pre-flight block path.
  const ownKeysAfter = (url) => h.run(`(() => {
    const x = new XMLHttpRequest();
    x.open('GET', ${JSON.stringify(url)});
    x.send();
    void x.readyState; void x.status; void x.statusText; void x.responseURL;
    void x.responseText; void x.response;
    return Reflect.ownKeys(x).length;
  })()`);
  assert.equal(ownKeysAfter(PLAYER_XHR_URL), 0, 'no own state after a player request');
  assert.equal(ownKeysAfter(BLOCKED_XHR_URL), 0, 'no own state after a pre-flight-blocked request');

  // An illegal receiver must surface the platform's own error, not the
  // WeakMap's "Invalid value used as weak map key".
  const openError = (receiver) => h.run(`(() => {
    try { XMLHttpRequest.prototype.open.call(${receiver}, 'GET', '/'); return null; }
    catch (err) { return err.name + ': ' + err.message; }
  })()`);
  const platformError = "TypeError: Failed to execute 'open' on 'XMLHttpRequest': Illegal invocation";
  assert.equal(openError('null'), platformError, 'open.call(null) must throw the native error');
  assert.equal(openError('1'), platformError, 'open.call(<primitive>) must throw the native error');

  // The same class of leak on `document`: the storage-access defuser must be
  // inherited from Document.prototype, never written onto the instance.
  assert.equal(h.run("Object.prototype.hasOwnProperty.call(document, 'requestStorageAccess')"), false,
    'requestStorageAccess must not become an own property of document');
  assert.equal(h.run("Object.prototype.hasOwnProperty.call(document, 'requestStorageAccessFor')"), false,
    'requestStorageAccessFor must not become an own property of document');
  assert.notEqual(h.run('Document.prototype.requestStorageAccess'), h.originals.requestStorageAccess,
    'the defuser must be installed on Document.prototype');
  const granted = await h.run('document.requestStorageAccess()');
  assert.equal(granted.state, 'granted', 'the defuser must still resolve as granted');
});

test('4.4: no readable brand', async () => {
  const h = await makeShieldHarness();
  assert.equal(h.run('JSON.parse(\'{"adPlacements":[1]}\').adPlacements'), false,
    'the JSON.parse hook must be installed for the brand probe to mean anything');

  assert.equal(h.run('Object.getOwnPropertySymbols(JSON.parse).length'), 0,
    'the wrapper must expose no own symbols');
  assert.equal(h.run("JSON.parse[Symbol.for('$$jsonParseHookVersion')]"), undefined,
    'the global-registry version brand must be gone');
  assert.equal(h.run('Object.getOwnPropertyNames(JSON.parse).join(",")'), 'length,name',
    'the wrapper must expose exactly the own names of the native');

  const source = await readFile(SHIELD_URL, 'utf8');
  assert.equal(source.includes('jsonParseHookVersion'), false, 'the brand name must not come back');
  assert.equal(source.includes('Symbol.for('), false,
    'no global-registry symbol — any page can look those up by name');
});

test('4.4: a second injection is still a no-op', async () => {
  // Didn't re-break for §4.12: the idempotency guard is now the behavioural
  // probe alone, and it must still stop injectIntoOpenTabs from stacking a
  // second copy of every interceptor.
  const h = await makeShieldHarness({ player: makePlayerStub(), setup: RECORDING_XHR_SETUP });

  const readPlayerText = () => h.run(`(() => {
    __xhr.readyStateReads = 0;
    const x = new XMLHttpRequest();
    x.open('GET', ${JSON.stringify(PLAYER_XHR_URL)});
    const text = x.responseText;
    return { text, depth: __xhr.readyStateReads };
  })()`);

  const first = readPlayerText();
  assert.ok(first.text.includes('"adPlacements":false'), 'the XHR text path must be scrubbing');
  assert.ok(first.depth >= 1, 'the depth probe must see at least one interceptor layer');

  const SURFACES = {
    parse: 'JSON.parse',
    fetch: 'window.fetch',
    json: 'Response.prototype.json',
    open: 'XMLHttpRequest.prototype.open',
    send: 'XMLHttpRequest.prototype.send',
    responseText: "Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText').get",
    requestStorageAccess: 'Document.prototype.requestStorageAccess',
    toString: 'Function.prototype.toString',
  };
  const entries = Object.entries(SURFACES);
  h.run(`globalThis.__before = { ${entries.map(([key, expr]) => `${key}: ${expr}`).join(', ')} };`);

  h.inject();

  const second = readPlayerText();
  assert.equal(second.depth, first.depth,
    'a second injection must not add another interceptor layer (the probe count would double)');
  assert.ok(second.text.includes('"adPlacements":false'));
  for (const [key, expr] of entries) {
    assert.equal(h.run(`${expr} === __before.${key}`), true,
      `${expr} must keep its identity across a second injection`);
  }
  assert.equal(h.playerObservers().length, 1, 'the ad-skipper must not attach twice');
});

test('4.4: blocked XHR still synthesises a completed empty response', async () => {
  // Didn't re-break for the pre-flight path: an ad-only endpoint never
  // reaches the network, and the page still sees a finished 200 with an
  // empty JSON body, exactly as the subclass used to synthesise.
  const h = await makeShieldHarness({ setup: RECORDING_XHR_SETUP });
  h.run('__xhr.nativeReadyState = 1;');

  h.run(`
    globalThis.__blocked = new XMLHttpRequest();
    __blocked.open('POST', ${JSON.stringify(BLOCKED_XHR_URL)});
    __blocked.send('{"context":{}}');
  `);
  assert.equal(h.run('__xhr.sent.length'), 0, 'the request must never reach send()');
  assert.equal(h.run('__xhr.events.join(",")'), '', 'completion events are asynchronous');

  h.timers.advance(1);

  assert.equal(h.run('__xhr.events.join(",")'), 'readystatechange,load,loadend');
  assert.equal(h.run('__blocked.readyState'), 4);
  assert.equal(h.run('__blocked.status'), 200);
  assert.equal(h.run('__blocked.statusText'), 'OK');
  assert.equal(h.run('__blocked.responseURL'), BLOCKED_XHR_URL);
  assert.equal(h.run('__blocked.responseText'), '{}');
  assert.equal(h.run('__blocked.response'), '{}');
  // responseType 'json' consumers get the parsed empty object.
  h.run("Object.defineProperty(__blocked, 'responseType', { value: 'json' });");
  assert.equal(h.run('JSON.stringify(__blocked.response)'), '{}');

  // And an ordinary request on the same prototype is still sent.
  h.run(`
    const ordinary = new XMLHttpRequest();
    ordinary.open('GET', 'https://www.youtube.com/api/stats/qoe');
    ordinary.send('q');
  `);
  assert.equal(h.run('__xhr.sent.join(",")'), 'q', 'unrelated traffic must still reach send()');
});

// ---------------------------------------------------------------------------
// §4.30 — ytcfg poisoning must work on fresh navigations
// ---------------------------------------------------------------------------

test('§4.30: ytcfg assigned after document_start gets its .set wrapped — EXPERIMENT_FLAGS are poisoned', async () => {
  // Fresh navigation: window.ytcfg does NOT exist when the shield runs.
  const h = await makeShieldHarness();
  assert.equal(h.run('window.ytcfg'), undefined);

  // YouTube's inline script defines ytcfg and pushes experiment flags via
  // ytcfg.set({...}) — an object literal the JSON.parse hook never sees.
  h.run(`
    window.ytcfg = (function() {
      const data = {};
      return {
        data_: data,
        set(a, b) {
          if (typeof a === 'string') { data[a] = b; } else { Object.assign(data, a); }
        },
        get(k) { return data[k]; },
      };
    })();
    ytcfg.set({ EXPERIMENT_FLAGS: {
      web_player_api_v2_server_side_ad_injection: true,
      web_disable_midroll_ads: false,
      web_enable_ad_signals: true,
    } });
  `);

  const flags = h.run('ytcfg.get("EXPERIMENT_FLAGS")');
  assert.equal(flags.web_player_api_v2_server_side_ad_injection, false,
    'SSAI flag must be poisoned to false on a fresh navigation');
  assert.equal(flags.web_disable_midroll_ads, true);
  assert.equal(flags.web_enable_ad_signals, false);

  // String-form set('KEY', value) calls must still pass through unharmed.
  h.run('ytcfg.set("INNERTUBE_CONTEXT_CLIENT_VERSION", "2.2026")');
  assert.equal(h.run('ytcfg.get("INNERTUBE_CONTEXT_CLIENT_VERSION")'), '2.2026');
});

test('§4.30: config carried on the ytcfg assignment itself is poisoned immediately', async () => {
  const h = await makeShieldHarness();

  h.run(`
    window.ytcfg = {
      config_: { EXPERIMENT_FLAGS: {
        web_enable_ad_signals: true,
        web_disable_midroll_ads: false,
      } },
    };
  `);

  assert.equal(h.run('window.ytcfg.config_.EXPERIMENT_FLAGS.web_enable_ad_signals'), false,
    'flags already present at assignment time must be poisoned by the trap');
  assert.equal(h.run('window.ytcfg.config_.EXPERIMENT_FLAGS.web_disable_midroll_ads'), true);
});

test('§4.30: the assignment trap is transparent — the page reads back its own object', async () => {
  const h = await makeShieldHarness();
  h.run('window.ytcfg = { data_: {}, marker: 42, set() {} };');
  assert.equal(h.run('window.ytcfg.marker'), 42);
  assert.equal(h.run('window.ytcfg === ytcfg'), true);
  assert.equal(h.run('typeof window.ytcfg.set'), 'function');
});

test('§4.30 (didn\'t re-break): late injection with ytcfg already present still poisons directly', async () => {
  // Already-loaded tab (the injectIntoOpenTabs path): ytcfg exists before the
  // shield runs. This was the only path the prior code handled — it must keep
  // working unchanged.
  const h = await makeShieldHarness({
    setup: `
      window.ytcfg = {
        config_: { EXPERIMENT_FLAGS: {
          web_enable_ad_signals: true,
          web_disable_midroll_ads: false,
        } },
        set(a, b) {
          if (typeof a === 'string') { this.config_[a] = b; }
          else { Object.assign(this.config_, a); }
        },
      };
    `,
  });

  // Existing config poisoned at install time.
  assert.equal(h.run('window.ytcfg.config_.EXPERIMENT_FLAGS.web_enable_ad_signals'), false);
  assert.equal(h.run('window.ytcfg.config_.EXPERIMENT_FLAGS.web_disable_midroll_ads'), true);

  // And .set is wrapped for subsequent calls.
  h.run('window.ytcfg.set({ EXPERIMENT_FLAGS: { web_player_api_v2_server_side_ad_injection: true } })');
  assert.equal(
    h.run('window.ytcfg.config_.EXPERIMENT_FLAGS.web_player_api_v2_server_side_ad_injection'),
    false
  );
});

// ---------------------------------------------------------------------------
// §4.25 — the belt layer must poison the store YouTube actually reads
//
// The `config_` cases above are the harness's own invention (kept because they
// are harmless). Real YouTube backs ytcfg with `ytcfg.data_` or, via
// `ytcfg.d()`, with `window.yt.config_` — neither of which the old
// `if (cfg.config_)` check ever touched.
// ---------------------------------------------------------------------------

const DIRTY_FLAGS = `{
  web_enable_ad_signals: true,
  web_disable_midroll_ads: false,
  web_player_api_v2_server_side_ad_injection: true,
}`;

function assertFlagsPoisoned(h, expr) {
  assert.equal(h.run(`${expr}.web_enable_ad_signals`), false, `${expr}: ad signals must be off`);
  assert.equal(h.run(`${expr}.web_disable_midroll_ads`), true, `${expr}: midrolls must be disabled`);
  assert.equal(h.run(`${expr}.web_player_api_v2_server_side_ad_injection`), false,
    `${expr}: SSAI must be off`);
}

test('§4.25: a data_-backed ytcfg store is poisoned at assignment', async () => {
  const h = await makeShieldHarness();

  h.run(`
    window.ytcfg = {
      data_: { EXPERIMENT_FLAGS: ${DIRTY_FLAGS} },
      get(k) { return this.data_[k]; },
    };
  `);

  assertFlagsPoisoned(h, 'window.ytcfg.data_.EXPERIMENT_FLAGS');
});

test('§4.25: a yt.config_-backed store is poisoned when window.yt is assigned', async () => {
  // The real shape: ytcfg carries no store of its own, `ytcfg.d()` reaches
  // through to window.yt.config_.
  const h = await makeShieldHarness();

  h.run(`
    window.yt = { config_: { EXPERIMENT_FLAGS: ${DIRTY_FLAGS} } };
    window.ytcfg = {
      d() { return window.yt.config_; },
      get(k) { return this.d()[k]; },
      set() {},
    };
  `);

  assertFlagsPoisoned(h, 'window.yt.config_.EXPERIMENT_FLAGS');
  assertFlagsPoisoned(h, 'window.ytcfg.d().EXPERIMENT_FLAGS');
});

test('§4.25: yt.config_ seeded by direct assignment (never through ytcfg.set) is poisoned', async () => {
  // YouTube's `window.yt = window.yt || {}` idiom: the config store lands on an
  // already-assigned yt object, so only a nested trap can catch it.
  const h = await makeShieldHarness();

  h.run(`
    window.yt = window.yt || {};
    window.yt.config_ = { EXPERIMENT_FLAGS: ${DIRTY_FLAGS} };
  `);

  assertFlagsPoisoned(h, 'window.yt.config_.EXPERIMENT_FLAGS');
});

test('§4.25: late injection with yt.config_ already populated poisons it at install', async () => {
  // injectIntoOpenTabs path: the page is fully loaded before the shield runs.
  const h = await makeShieldHarness({
    setup: `
      window.yt = { config_: { EXPERIMENT_FLAGS: ${DIRTY_FLAGS} } };
      window.ytcfg = { d() { return window.yt.config_; }, set() {} };
    `,
  });

  assertFlagsPoisoned(h, 'window.yt.config_.EXPERIMENT_FLAGS');
});

test('§4.25: the window.yt trap is transparent to the page', async () => {
  const h = await makeShieldHarness();

  h.run('window.yt = { marker: 7 };');
  assert.equal(h.run('window.yt.marker'), 7);
  assert.equal(h.run('window.yt === yt'), true);

  h.run(`window.yt.config_ = { EXPERIMENT_FLAGS: ${DIRTY_FLAGS} };`);
  assert.equal(h.run("Object.keys(window.yt).includes('config_')"), true,
    'config_ must read back as an ordinary enumerable property');
  assert.equal(h.run('window.yt.config_.EXPERIMENT_FLAGS.web_enable_ad_signals'), false);
});

test('§4.25: the WASM-ready re-poison reaches a data_-backed store', async () => {
  // The re-poison exists so the extra flags WASM covers land on the live
  // config. It resolved `window.ytcfg?.config_`, so on a real page it had
  // nothing to poison and the wasmReady callback was dead code.
  const h = await makeShieldHarness({ wasmUrl: 'chrome-extension://stub/nullify_core_bg.wasm' });

  h.run(`
    window.ytcfg = {
      data_: { EXPERIMENT_FLAGS: ${DIRTY_FLAGS} },
      get(k) { return this.data_[k]; },
    };
  `);
  assertFlagsPoisoned(h, 'window.ytcfg.data_.EXPERIMENT_FLAGS');

  // The page re-dirties the flags after the synchronous belt has run.
  h.run('window.ytcfg.data_.EXPERIMENT_FLAGS.web_enable_ad_signals = true;');

  await h.releaseWasm();

  assertFlagsPoisoned(h, 'window.ytcfg.data_.EXPERIMENT_FLAGS');
});

test('§4.25: the WASM-ready re-poison reaches a yt.config_-backed store', async () => {
  const h = await makeShieldHarness({ wasmUrl: 'chrome-extension://stub/nullify_core_bg.wasm' });

  h.run(`window.yt = { config_: { EXPERIMENT_FLAGS: ${DIRTY_FLAGS} } };`);
  assertFlagsPoisoned(h, 'window.yt.config_.EXPERIMENT_FLAGS');

  h.run('window.yt.config_.EXPERIMENT_FLAGS.web_disable_midroll_ads = false;');

  await h.releaseWasm();

  assertFlagsPoisoned(h, 'window.yt.config_.EXPERIMENT_FLAGS');
});

// ---------------------------------------------------------------------------
// §5.32 — player poll must recover when a background tab becomes visible
// ---------------------------------------------------------------------------

test('§5.32: exhausted poll re-arms on visibilitychange and hooks the player', async () => {
  // Background tab: the player element does not exist while hidden.
  const h = await makeShieldHarness({ visibilityState: 'hidden' });

  h.timers.advance(POLL_CHAIN_EXHAUSTED_MS);
  assert.equal(h.playerObservers().length, 0, 'no player to hook while hidden');
  assert.equal(h.timers.pendingCount(), 0, 'bounded poll chain must be exhausted');

  // User focuses the tab; YouTube constructs #movie_player. No yt-navigate
  // event fires for a plain tab focus.
  h.setPlayer(makePlayerStub());
  h.setVisibility('visible');
  h.emitDocument('visibilitychange');

  assert.equal(h.playerObservers().length, 1,
    'becoming visible must re-arm the poll and attach the ad observer');
});

test('§5.32: visibilitychange while still hidden does not attach', async () => {
  const h = await makeShieldHarness({ visibilityState: 'hidden' });
  h.timers.advance(POLL_CHAIN_EXHAUSTED_MS);

  h.setPlayer(makePlayerStub());
  h.emitDocument('visibilitychange'); // still hidden

  assert.equal(h.playerObservers().length, 0,
    'a hidden tab must not restart polling');
});

test('§5.32: visibilitychange with a player already hooked does not restart polling', async () => {
  const h = await makeShieldHarness({ player: makePlayerStub() });
  assert.equal(h.playerObservers().length, 1, 'player present at start attaches immediately');

  h.emitDocument('visibilitychange');

  assert.equal(h.playerObservers().length, 1, 'no duplicate observer');
  assert.equal(h.timers.pendingCount(), 0, 'no poll timer re-armed');
});

test('§5.32 (didn\'t re-break): player appearing mid-chain is found by the backoff poll', async () => {
  const h = await makeShieldHarness();
  assert.equal(h.playerObservers().length, 0);

  h.timers.advance(60); // past the 50 ms step, before the 100 ms step fires
  h.setPlayer(makePlayerStub());
  h.timers.advance(100); // the 100 ms step polls and finds it

  assert.equal(h.playerObservers().length, 1);
});

test('§5.32 (didn\'t re-break): yt-navigate-finish still re-arms an exhausted poll', async () => {
  const h = await makeShieldHarness();
  h.timers.advance(POLL_CHAIN_EXHAUSTED_MS);
  assert.equal(h.playerObservers().length, 0);

  h.setPlayer(makePlayerStub());
  h.emitWindow('yt-navigate-finish');

  assert.equal(h.playerObservers().length, 1);
});

// ---------------------------------------------------------------------------
// Gap 1 — path-targeted pruning (uBO parity)
//
// The JSON.parse hook ran a *shallow* key prune, which only ever looks at the
// parsed root and its `playerResponse`. Whole ad surfaces sit deeper than that
// and carry no AD_KEYS name at a visited level, so they passed through intact.
// uBO prunes them by explicit path; these pin the paths it actually ships.
// ---------------------------------------------------------------------------

/**
 * Runs a value through the shield's hooked JSON.parse inside the vm realm and
 * brings the result back as plain host-realm data. The round trip matters:
 * objects built in the vm carry that realm's prototypes, which deepStrictEqual
 * refuses to match. `JSON.stringify` is not one of the hooked surfaces.
 */
function parseInShield(h, value) {
  const literal = JSON.stringify(JSON.stringify(value));
  return JSON.parse(h.run(`JSON.stringify(JSON.parse(${literal}))`));
}

const shortsEntry = (videoId, isAd) => ({
  command: {
    reelWatchEndpoint: {
      videoId,
      adClientParams: isAd ? { isAd: true } : {},
    },
  },
});

test('Gap 1: a Shorts ad reel is spliced out of entries[] (uBO: entries.[-]...adClientParams.isAd)', async () => {
  const h = await makeShieldHarness();

  const parsed = parseInShield(h, {
    entries: [shortsEntry('real1', false), shortsEntry('ad1', true), shortsEntry('real2', false)],
  });

  assert.deepEqual(
    parsed.entries.map((e) => e.command.reelWatchEndpoint.videoId),
    ['real1', 'real2'],
    'the flagged reel must be removed, not left as a neutered husk (uBO `[-]` semantics)',
  );
});

test('Gap 1: reelWatchSequenceResponse-wrapped Shorts entries are pruned the same way', async () => {
  const h = await makeShieldHarness();

  const parsed = parseInShield(h, {
    reelWatchSequenceResponse: {
      entries: [shortsEntry('ad1', true), shortsEntry('real1', false)],
    },
  });

  assert.deepEqual(
    parsed.reelWatchSequenceResponse.entries.map((e) => e.command.reelWatchEndpoint.videoId),
    ['real1'],
  );
});

test('Gap 1: a homepage rich-grid adSlotRenderer item is removed from the feed', async () => {
  const h = await makeShieldHarness();

  const gridItem = (content) => ({ richItemRenderer: { content } });
  const parsed = parseInShield(h, {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                richGridRenderer: {
                  contents: [
                    gridItem({ videoRenderer: { videoId: 'v1' } }),
                    gridItem({ adSlotRenderer: { adSlotMetadata: {} } }),
                    gridItem({ videoRenderer: { videoId: 'v2' } }),
                  ],
                },
              },
            },
          },
        ],
      },
    },
  });

  const items =
    parsed.contents.twoColumnBrowseResultsRenderer.tabs[0]
      .tabRenderer.content.richGridRenderer.contents;
  assert.equal(items.length, 2, 'the ad slot item must be spliced out of the grid');
  assert.deepEqual(items.map((i) => i.richItemRenderer.content.videoRenderer.videoId), ['v1', 'v2']);
});

test('Gap 1: the Premium upsellDialogRenderer nag is neutralized', async () => {
  const h = await makeShieldHarness();

  const parsed = parseInShield(h, {
    auxiliaryUi: {
      messageRenderers: {
        upsellDialogRenderer: { title: 'Try Premium' },
        someOtherRenderer: { keep: true },
      },
    },
  });

  assert.equal(parsed.auxiliaryUi.messageRenderers.upsellDialogRenderer, false);
  assert.deepEqual(parsed.auxiliaryUi.messageRenderers.someOtherRenderer, { keep: true },
    'sibling renderers must survive');
});

test('Gap 1: array-wrapped playerResponse ad payloads are neutralized', async () => {
  // A root array cannot match the `result.playerResponse` shape gate at all, so
  // uBO covers it with `[].playerResponse.adPlacements` / `.adSlots`.
  const h = await makeShieldHarness();

  const parsed = parseInShield(h, [
    { playerResponse: { streamingData: {}, adPlacements: [1], adSlots: [2] } },
    { playerResponse: { streamingData: {} } },
  ]);

  assert.equal(parsed[0].playerResponse.adPlacements, false);
  assert.equal(parsed[0].playerResponse.adSlots, false);
});

test('Gap 1: an ad payload nested under a recognised player envelope is reached', async () => {
  // The shape gate matched on `playerResponse.streamingData` and then ran the
  // shallow prune, which steps straight past sibling containers.
  const h = await makeShieldHarness();

  const parsed = parseInShield(h, {
    playerResponse: { streamingData: {}, x: { adPlacements: [1] } },
  });

  assert.equal(parsed.playerResponse.x.adPlacements, false);
});

test('Gap 1 (no over-reach): arbitrary page JSON is not deep-walked', async () => {
  // The JSON.parse hook is page-global. Deep pruning is only licensed once a
  // payload has been positively identified as a YouTube player envelope.
  const h = await makeShieldHarness();

  const parsed = parseInShield(h, { foo: { bar: { adPlacements: [1] } } });

  assert.deepEqual(parsed.foo.bar.adPlacements, [1],
    'an unrelated object must not be traversed by the page-global hook');
});

test('Gap 1: path pruning stays inside the node budget on a pathological payload', async () => {
  const h = await makeShieldHarness();

  const entries = [];
  for (let i = 0; i < 60000; i++) entries.push(shortsEntry(`v${i}`, true));
  const literal = JSON.stringify(JSON.stringify({ entries }));

  const started = Date.now();
  const remaining = h.run(`JSON.parse(${literal}).entries.length`);
  const elapsed = Date.now() - started;

  assert.ok(remaining < entries.length, 'some ad reels must have been spliced');
  assert.ok(remaining > 0,
    'PRUNE_NODE_LIMIT must stop the walk rather than chewing through the whole array');
  assert.ok(elapsed < 5000, `path pruning must stay bounded (took ${elapsed}ms)`);
});

// ---------------------------------------------------------------------------
// Gap 2 — /reel_watch_sequence must be a player-like URL
// ---------------------------------------------------------------------------

test('Gap 2: a /reel_watch_sequence response takes the deep player path', async () => {
  const h = await makeShieldHarness();

  const body = JSON.stringify({ contents: { nested: { adPlacements: [1] } } });
  h.run(`
    globalThis.__res = new Response(${JSON.stringify(body)}, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(globalThis.__res, 'url', {
      value: 'https://www.youtube.com/youtubei/v1/reel_watch_sequence?prettyPrint=false',
    });
  `);

  const parsed = await h.run('globalThis.__res.json()');

  assert.equal(parsed.contents.nested.adPlacements, false,
    'Shorts sequence responses must be recognised as player-like and deep-pruned');
});

test('Gap 2: the retired /get_video_info endpoint is no longer probed', async () => {
  // YouTube removed /get_video_info in 2020; the check could never match.
  const source = await readFile(SHIELD_URL, 'utf8');
  assert.equal(/includes\(\s*'\/get_video_info'\s*\)/.test(source), false,
    'the dead /get_video_info check must not come back');
  assert.equal(/includes\(\s*'\/reel_watch_sequence'\s*\)/.test(source), true,
    '/reel_watch_sequence must be part of the player-like URL set');
});

// ---------------------------------------------------------------------------
// Gap 3 — fetch bodies must actually reach the scrubber
//
// scrub() had exactly one call site (the XHR responseText path) while modern
// YouTube fetches /youtubei/v1/player, so the string neutralizer was near-dead
// in production. Player fetches now come back with a scrubbed body.
// ---------------------------------------------------------------------------

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

const AD_PLAYER_BODY = JSON.stringify({
  responseContext: {},
  streamingData: { formats: [{ itag: 18 }] },
  adPlacements: [{ adPlacementRenderer: { config: {} } }],
});

const CLEAN_PLAYER_BODY = JSON.stringify({
  responseContext: {},
  streamingData: { formats: [{ itag: 18 }] },
});

/** A page fetch that records its calls and answers with a real Response. */
function makeRecordingFetch(body) {
  const calls = [];
  let last = null;
  const impl = async function pageFetch(input) {
    const url = typeof input === 'string' ? input : input?.url || '';
    calls.push(url);
    last = new Response(body, {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(body.length),
      },
    });
    Object.defineProperty(last, 'url', { value: url });
    return last;
  };
  return { impl, calls, lastResponse: () => last };
}

test('Gap 3: a player fetch comes back with a scrubbed body', async () => {
  const recorder = makeRecordingFetch(AD_PLAYER_BODY);
  const h = await makeShieldHarness({ fetchImpl: recorder.impl });

  const response = await h.run(`window.fetch(${JSON.stringify(PLAYER_URL)})`);
  const text = await response.text();

  assert.ok(text.includes('"adPlacements":false'),
    'the fetch body must reach scrub() — it never did before');
  assert.notEqual(response, recorder.lastResponse(),
    'a changed body means a rebuilt Response');
});

test('Gap 3: the rebuilt Response preserves ok/status/redirected/type/url', async () => {
  const recorder = makeRecordingFetch(AD_PLAYER_BODY);
  const h = await makeShieldHarness({ fetchImpl: recorder.impl });

  const response = await h.run(`window.fetch(${JSON.stringify(PLAYER_URL)})`);
  const original = recorder.lastResponse();

  assert.equal(response.ok, original.ok);
  assert.equal(response.status, original.status);
  assert.equal(response.statusText, original.statusText);
  assert.equal(response.redirected, original.redirected);
  assert.equal(response.type, original.type);
  assert.equal(response.url, PLAYER_URL);
  assert.equal(response.headers.get('content-type'), 'application/json');
  // The rebuilt payload is raw text, so byte-level headers of the original
  // (compressed) stream must not survive onto it.
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('content-length'), null);
});

test('Gap 3: .json() on the rebuilt Response still deep-prunes', async () => {
  const recorder = makeRecordingFetch(AD_PLAYER_BODY);
  const h = await makeShieldHarness({ fetchImpl: recorder.impl });

  const response = await h.run(`window.fetch(${JSON.stringify(PLAYER_URL)})`);
  const parsed = await response.json();

  assert.equal(parsed.adPlacements, false);
  assert.deepEqual(parsed.streamingData.formats, [{ itag: 18 }],
    'playback data must survive the rewrite untouched');
});

test('Gap 3: a clean player body is returned as the original, stream unread', async () => {
  const recorder = makeRecordingFetch(CLEAN_PLAYER_BODY);
  const h = await makeShieldHarness({ fetchImpl: recorder.impl });

  const response = await h.run(`window.fetch(${JSON.stringify(PLAYER_URL)})`);

  assert.equal(response, recorder.lastResponse(),
    'nothing to change means the untouched original Response');
  assert.equal(response.bodyUsed, false, 'the original body stream must still be readable');
  assert.equal(await response.text(), CLEAN_PLAYER_BODY);
});

test('Gap 3: a non-player fetch is passed through untouched', async () => {
  const recorder = makeRecordingFetch(AD_PLAYER_BODY);
  const h = await makeShieldHarness({ fetchImpl: recorder.impl });

  const response = await h.run("window.fetch('https://www.youtube.com/api/stats/qoe')");

  assert.equal(response, recorder.lastResponse(), 'unrelated traffic must not be reconstructed');
  assert.equal(response.bodyUsed, false);
});

test('Gap 3 (didn\'t re-break): the pre-flight block still short-circuits the network', async () => {
  const recorder = makeRecordingFetch(AD_PLAYER_BODY);
  const h = await makeShieldHarness({ fetchImpl: recorder.impl });

  const response = await h.run("window.fetch('https://www.youtube.com/api/stats/ad_break')");

  assert.deepEqual(recorder.calls, [], 'ad-only endpoints must never reach the network');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{}');
});

// ---------------------------------------------------------------------------
// Gap 4 — #player-ads is bait, and must never be hidden
//
// uBO ships `youtube.com#@##player-ads`: an exception that deliberately
// UN-hides the element, because YouTube checks whether it got hidden and reads
// a hidden one as adblock detection. Nothing we ship may hide it.
// ---------------------------------------------------------------------------

const BAIT_ID = 'player-ads';

/**
 * Whether a raw CSS selector can match an element carrying `id`. Covers the
 * forms the seed list actually uses: `#id` (optionally qualified) and
 * `[id<op>=value]` attribute selectors. Class selectors such as EasyList's
 * `.player-ads` deliberately do NOT count — a class never matches an id.
 */
function selectorTargetsId(selector, id) {
  if (new RegExp(`#${id}(?![\\w-])`).test(selector)) return true;
  const attrRe = /\[\s*id\s*([~^$*|]?=)\s*(['"]?)([^\]'"]*)\2\s*[isIS]?\s*\]/g;
  for (const match of selector.matchAll(attrRe)) {
    const [, op, , value] = match;
    if (value === '') continue;
    if (op === '=' && value === id) return true;
    if (op === '*=' && id.includes(value)) return true;
    if (op === '^=' && id.startsWith(value)) return true;
    if (op === '$=' && id.endsWith(value)) return true;
    if (op === '~=' && id.split(/\s+/).includes(value)) return true;
    if (op === '|=' && (id === value || id.startsWith(`${value}-`))) return true;
  }
  return false;
}

test('Gap 4: no seed cosmetic selector hides the #player-ads bait element', async () => {
  const { CORE_FILTER_SOURCE } = await import('../src/shared/core-filter-source.js');
  const { generic, domainSpecific } = CORE_FILTER_SOURCE.cosmetic;

  const candidates = [...generic];
  for (const [domain, selectors] of Object.entries(domainSpecific)) {
    if (domain.includes('youtube')) candidates.push(...selectors);
  }

  const offenders = candidates.filter((selector) => selectorTargetsId(selector, BAIT_ID));
  assert.deepEqual(offenders, [],
    'hiding #player-ads is how YouTube detects adblockers — uBO un-hides it on purpose',
  );
});

test('Gap 4: the sanity check itself catches an id-targeting selector', () => {
  // Guards the pin above against silently degrading into a tautology.
  assert.equal(selectorTargetsId('#player-ads', BAIT_ID), true);
  assert.equal(selectorTargetsId('div#player-ads', BAIT_ID), true);
  assert.equal(selectorTargetsId('[id*="player-ad"]', BAIT_ID), true);
  assert.equal(selectorTargetsId('[id^="player"]', BAIT_ID), true);
  assert.equal(selectorTargetsId('.player-ads', BAIT_ID), false, 'a class is not an id');
  assert.equal(selectorTargetsId('#player-ads-container', BAIT_ID), false);
});

test('Gap 4: the shield itself never touches #player-ads', async () => {
  const source = await readFile(SHIELD_URL, 'utf8');
  assert.equal(source.includes('player-ads'), false,
    'the shield must not query, hide or remove the bait element',
  );
});
