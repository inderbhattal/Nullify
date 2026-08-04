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
const injectionSource = (body) => `{\n${IMPORT_STUBS}\n${body}\n}`;

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

async function makeShieldHarness({
  visibilityState = 'visible',
  player = null,
  setup,
  wasmUrl = null,
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
    open() {}
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

  const documentStub = {
    visibilityState,
    documentElement: {
      getAttribute: (name) => (name === 'data-nullify-wasm' ? wasmUrl : null),
    },
    querySelector: (sel) => (sel === '#movie_player' ? currentPlayer : null),
    addEventListener: addListener(docListeners),
    removeEventListener: () => {},
  };

  const sandbox = {
    console: { info: () => {}, warn: () => {}, error: () => {} },
    document: documentStub,
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
    Response: class Response {
      constructor(body) { this.body = body; }
      async json() { return {}; }
    },
    // Named so a test can tell the page's own fetch from the shield's wrapper.
    fetch: async function pageFetch() { return { ok: true }; },
    addEventListener: addListener(winListeners),
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  const run = (code) => vm.runInContext(code, context, { filename: 'youtube-shield.vm.js' });
  const body = await shieldBody();
  const inject = () => run(injectionSource(body));
  if (setup) run(setup);
  inject();

  return {
    run,
    inject,
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
const LAYER_PROBES = {
  'JSON.parse hook': 'JSON.parse(\'{"adPlacements":[1]}\').adPlacements === false',
  'fetch interceptor': 'window.fetch.name !== "pageFetch"',
  'XHR subclass': 'window.XMLHttpRequest.name !== "XMLHttpRequestStub"',
  'ytcfg trap': "typeof Object.getOwnPropertyDescriptor(window, 'ytcfg')?.set === 'function'",
  'yt trap': "typeof Object.getOwnPropertyDescriptor(window, 'yt')?.set === 'function'",
  'ytInitialPlayerResponse trap':
    "typeof Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse')?.set === 'function'",
  'playerResponse trap':
    "typeof Object.getOwnPropertyDescriptor(window, 'playerResponse')?.set === 'function'",
  'ytInitialData trap':
    "typeof Object.getOwnPropertyDescriptor(window, 'ytInitialData')?.set === 'function'",
  'initialPlayerResponse trap':
    "typeof Object.getOwnPropertyDescriptor(window, 'initialPlayerResponse')?.set === 'function'",
};

function assertAllLayersInstalled(h, why) {
  for (const [layer, probe] of Object.entries(LAYER_PROBES)) {
    assert.equal(h.run(probe), true, `${layer} must be installed ${why}`);
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

test('§4.12: a forged install brand without the pruning behaviour does not disable the shield', async () => {
  // The marker moved onto the shield's own JSON.parse wrapper, so a page that
  // knows the key can still plant it — but it is only honoured when JSON.parse
  // actually neutralizes ad payloads, which a bare forgery does not.
  const h = await makeShieldHarness({
    player: makePlayerStub(),
    setup: `
      Object.defineProperty(JSON.parse, Symbol.for('$$jsonParseHookVersion'), {
        value: 99, writable: false, enumerable: false, configurable: false,
      });
    `,
  });

  assertAllLayersInstalled(h, 'despite the forged install brand');
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
  h.run('globalThis.__before = { parse: JSON.parse, fetch: window.fetch, xhr: window.XMLHttpRequest };');

  h.inject();

  assert.equal(h.run('JSON.parse === __before.parse'), true, 'JSON.parse must not be re-wrapped');
  assert.equal(h.run('window.fetch === __before.fetch'), true, 'fetch must not be re-wrapped');
  assert.equal(h.run('window.XMLHttpRequest === __before.xhr'), true, 'XHR must not be re-subclassed');
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
