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

// Stand-ins for the module's static imports. The WASM path stays cold in
// these tests (no chrome.runtime, no data-nullify-wasm attribute), so the
// synchronous poison baseline is what gets exercised — exactly the fresh
// document_start situation §4.30 describes.
const IMPORT_STUBS = `
  const init = async () => {};
  const process_youtube_player = (text) => text;
  const sanitize_youtube_experiments = (text) => text;
  const initWasmFromUrl = async () => {};
`;

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

async function makeShieldHarness({ visibilityState = 'visible', player = null, setup } = {}) {
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
    documentElement: { getAttribute: () => null },
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
    fetch: async () => ({ ok: true }),
    addEventListener: addListener(winListeners),
    removeEventListener: () => {},
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  const run = (code) => vm.runInContext(code, context, { filename: 'youtube-shield.vm.js' });
  if (setup) run(setup);
  run(`${IMPORT_STUBS}\n${await shieldBody()}`);

  return {
    run,
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
