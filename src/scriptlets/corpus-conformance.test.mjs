/**
 * corpus-conformance.test.mjs
 *
 * Every case below is driven by the **literal argument list of a real rule**
 * taken verbatim from the shipped filter corpus (13,765 scriptlet rules across
 * EasyList, EasyPrivacy, uBO filters, uBO unbreak and uBO annoyances), fed
 * through the registry by name exactly as the service worker dispatches it.
 *
 * The point is not that the code runs — it is that the scriptlet *observably
 * acts* on the arguments the lists actually ship, which is where the
 * argument-semantics divergences in REVIEW-2026-08 §4.9–§4.27 and §5.21–§5.26
 * all hid: each of these rules parsed fine and then did nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis;

// --- DOM scaffolding --------------------------------------------------------

class FakeMutationObserver {
  static instances = [];
  constructor(cb) {
    this.cb = cb;
    this.disconnected = false;
    FakeMutationObserver.instances.push(this);
  }

  observe(target, options) { this.options = options; }
  disconnect() { this.disconnected = true; }
  takeRecords() { return []; }
}
globalThis.MutationObserver = FakeMutationObserver;
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
globalThis.Event = class { constructor(type) { this.type = type; } };

let cookieJar = [];
const documentListeners = [];
globalThis.document = {
  documentElement: {},
  currentScript: null,
  readyState: 'complete',
  baseURI: 'https://example.com/page',
  domain: 'example.com',
  addEventListener(type, fn) { documentListeners.push({ type, fn }); },
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  createTreeWalker: () => ({ nextNode: () => null }),
};
Object.defineProperty(globalThis.document, 'cookie', {
  configurable: true,
  get() { return cookieJar.join('; '); },
  set(v) { cookieJar.push(v); },
});
globalThis.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4 };
globalThis.location = { href: 'https://example.com/page', protocol: 'https:', reload() {} };
globalThis.addEventListener = () => {};

const localStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
  setItem: (k, v) => localStore.set(k, String(v)),
  removeItem: (k) => localStore.delete(k),
  get length() { return localStore.size; },
  key: (i) => [...localStore.keys()][i] ?? null,
};

class FakeXHR {
  static UNSENT = 0;
  static DONE = 4;

  open(method, url) { this._method = method; this._url = url; this._opened = true; }
  setRequestHeader(k, v) {
    // The real IDL throws InvalidStateError when readyState is UNSENT.
    if (!this._opened) throw new Error('InvalidStateError');
    (this._headers ??= {})[k] = v;
  }

  send() { this._sent = true; }
  dispatchEvent(e) { this[`on${e.type}`]?.call(this, e); return true; }
  get readyState() { return this._opened ? 1 : 0; }
  get responseText() { return this._responseText ?? ''; }
  get response() { return this._responseText ?? ''; }
}

let instance = 0;
/** Fresh registry instance — `run` holds a module-level dedupe Set. */
async function freshRun() {
  const mod = await import(`./index.js?corpus=${instance++}`);
  return mod;
}

/** Snapshot the globals scriptlets patch, run `fn`, then restore. */
async function withEnv(fn) {
  const saved = {
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    XMLHttpRequest: globalThis.XMLHttpRequest,
    open: globalThis.open,
    parse: JSON.parse,
    ael: globalThis.EventTarget?.prototype?.addEventListener,
    toString: Function.prototype.toString,
    getComputedStyle: globalThis.getComputedStyle,
  };
  cookieJar = [];
  localStore.clear();
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.setInterval = saved.setInterval;
    globalThis.XMLHttpRequest = saved.XMLHttpRequest;
    globalThis.open = saved.open;
    JSON.parse = saved.parse;
    if (saved.ael) EventTarget.prototype.addEventListener = saved.ael;
    Function.prototype.toString = saved.toString;
    globalThis.getComputedStyle = saved.getComputedStyle;
  }
}

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// §4.9 — abort-current-inline-script built its needle with raw `new RegExp`
// ===========================================================================

test('§4.9 corpus [acs, document.createElement, l.parentNode.insertBefore(s]: the trap is installed', async () => {
  const { run } = await freshRun();
  const target = { createElement: () => 'real' };
  globalThis.__acsHost = target;

  // 28 corpus rules carry a needle that is not a valid regex. `new RegExp`
  // threw, run()'s catch swallowed it, and the property was never trapped.
  run('acs', ['__acsHost.createElement', 'l.parentNode.insertBefore(s']);

  const desc = Object.getOwnPropertyDescriptor(target, 'createElement');
  assert.ok(desc?.get, 'a needle that is not valid regex syntax must not kill the rule');
  delete globalThis.__acsHost;
});

test('§4.9 corpus needle metacharacters are literal, not regex wildcards', async () => {
  const { run } = await freshRun();
  // `acs, document.getElementById, .ab_detected` — as a regex, `.` is any
  // char, so it aborted page scripts containing e.g. "Xab_detected".
  globalThis.__acsMeta = { probe: () => 'ok' };
  run('acs', ['__acsMeta.probe', '.ab_detected']);

  document.currentScript = { textContent: 'if (window.Xab_detected) {}' };
  assert.equal(globalThis.__acsMeta.probe(), 'ok', 'a literal needle must not match Xab_detected');

  document.currentScript = { textContent: 'if (window.ab_detected) {}' };
  assert.throws(() => globalThis.__acsMeta.probe(), ReferenceError, 'the literal must still match');
  document.currentScript = null;
  delete globalThis.__acsMeta;
});

test('§4.9 a dotted chain on a late-loading library arms once the parent appears', async () => {
  const { run } = await freshRun();
  delete globalThis.Swal;
  run('acs', ['Swal.fire', 'zzz']);

  // Prior code: `if (!obj) return` — 31 corpus rules aimed at a library that
  // had not loaded yet were permanent no-ops.
  globalThis.Swal = { fire: () => 'real' };
  const desc = Object.getOwnPropertyDescriptor(globalThis.Swal, 'fire');
  assert.ok(desc?.get, 'the trap must be armed once the page assigns the parent');
  delete globalThis.Swal;
});

// ===========================================================================
// §4.10 — adjust-set-timeout / adjust-set-interval delay semantics
// ===========================================================================

test('§4.10 corpus [nano-stb, _0x, *]: `*` means any delay', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const seen = [];
    globalThis.setTimeout = (fn, ms) => { seen.push(ms); return 1; };

    run('nano-stb', ['_0x', '*']);
    window.setTimeout(function _0xdeadbeef() {}, 3000);

    // Prior code: Number('*') is NaN and `NaN === ms` is never true, so all
    // 79 corpus rules using `*` adjusted nothing.
    assert.equal(seen[0], 150, '3000 * 0.05 — the default boost, applied at any delay');
  });
});

test('§4.10 corpus [nano-stb, count]: a missing delay argument means 1000, not "any"', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const seen = [];
    globalThis.setTimeout = (fn, ms) => { seen.push(ms); return 1; };

    run('nano-stb', ['count']);
    window.setTimeout(function count() {}, 250); // a page's own 250 ms debounce
    window.setTimeout(function count() {}, 1000); // the ad timer the rule targets

    // Prior code: absent delay meant "every delay" and the multiplier was
    // 0.001 unclamped, so the page's 250 ms debounce became `0` — a next-tick
    // hot loop. 188 corpus rules ship with no delay argument.
    assert.equal(seen[0], 250, 'a sub-1000 ms page timer must be left alone');
    assert.equal(seen[1], 50, 'the 1000 ms default needle must still be boosted');
  });
});

test('§4.10 corpus [nano-stb, ez, *, 0.02]: the shipped boost is honoured and clamped', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const seen = [];
    globalThis.setInterval = (fn, ms) => { seen.push(ms); return 1; };

    run('nano-sib', ['ez', '*', '0.02']);
    window.setInterval(function ez() {}, 5000);
    assert.equal(seen[0], 100, '5000 * 0.02');
  });
});

// ===========================================================================
// §4.17 — prevent-addEventListener compared the event type by string equality
// ===========================================================================

test('§4.17 corpus [aeld, /^(contextmenu|copy)$/]: a regex event type matches', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const attached = [];
    EventTarget.prototype.addEventListener = function (type) { attached.push(type); };

    run('aeld', ['/^(contextmenu|copy)$/']);
    const target = new EventTarget();
    target.addEventListener('contextmenu', () => {});
    target.addEventListener('copy', () => {});
    target.addEventListener('click', () => {});

    // 103 corpus rules pass a regex literal here. Under `type === eventType`
    // every one of them was inert — these are the anti-copy-protection rules.
    assert.deepEqual(attached, ['click'], 'both regex alternatives must be blocked');
  });
});

test('§4.17 corpus [aeld, dragstart, "", elements, .all-lyrics]: varargs are honoured', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const attached = [];
    EventTarget.prototype.addEventListener = function (type) { attached.push(type); };
    const lyrics = { matches: (s) => s === '.all-lyrics' };
    const other = { matches: () => false };
    document.querySelectorAll = () => [];

    run('aeld', ['dragstart', '', 'elements', '.all-lyrics']);
    EventTarget.prototype.addEventListener.call(lyrics, 'dragstart', () => {});
    EventTarget.prototype.addEventListener.call(other, 'dragstart', () => {});

    // 21 corpus rules pass these; they used to be dropped, so the block
    // applied to every element instead of the named ones.
    assert.deepEqual(attached, ['dragstart'], 'only the matching element is blocked');
  });
});

// ===========================================================================
// §4.18 — no-window-open-if dropped uBO's `!` negation
// ===========================================================================

test('§4.18 corpus [nowoif, !bergblock, 10]: `!` inverts the match', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const opened = [];
    globalThis.open = (url) => { opened.push(url); return { closed: false }; };

    run('nowoif', ['!bergblock', '10']);
    const allowed = window.open('https://bergblock.example/download');
    const blocked = window.open('https://popunder.example/ad');

    // 46 corpus rules use this form; escaping the `!` into the literal made
    // them block only URLs containing the characters "!bergblock" — nothing.
    assert.ok(allowed, 'the site\'s own popup must still open');
    assert.deepEqual(opened, ['https://bergblock.example/download']);
    assert.equal(blocked, null, 'everything else must be blocked');
  });
});

test('§4.18 the haystack is url + name + features, as uBO tests it', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const opened = [];
    globalThis.open = (url) => { opened.push(url); return {}; };

    run('nowoif', ['popunder']);
    const blocked = window.open('https://example.com/x', 'popunder-win', 'width=1');
    assert.equal(blocked, null, 'a marker in the window name must count');
    assert.deepEqual(opened, []);
  });
});

// ===========================================================================
// §4.20 — prevent-fetch had uBO's arguments 2 and 3 swapped
// ===========================================================================

test('§4.20 corpus [no-fetch-if, doubleclick, length:10, {"type":"cors"}]', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.fetch = async () => new Response('real');

    run('no-fetch-if', ['doubleclick', 'length:10', '{"type":"cors"}']);
    const res = await window.fetch('https://ad.doubleclick.net/probe');
    const text = await res.text();

    // Prior code returned the literal body `{"type":"cors"}` under a
    // `Content-Type: text/length:10` header. An anti-adblock script reading
    // `response.type` or `text.length` concluded a blocker was present —
    // exactly what the rule exists to prevent.
    assert.equal(text.length, 10, 'length:N must generate N random characters');
    assert.notEqual(text, '{"type":"cors"}', 'argument 3 is not the body');
    assert.equal(res.type, 'cors', 'the {…} argument sets response.type');
  });
});

test('§4.20 corpus [no-fetch-if, aud.springserve.com, war:noop-vast3.xml]: empty body, not the token', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.fetch = async () => new Response('real');

    run('no-fetch-if', ['aud.springserve.com', 'war:noop-vast3.xml']);
    const res = await window.fetch('https://aud.springserve.com/vast');
    assert.equal(await res.text(), '', 'war: needs the redirect-resource library; emit nothing');
  });
});

test('§4.20 corpus [no-fetch-if, -load.com/script/, length:101]', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.fetch = async () => new Response('real');
    run('no-fetch-if', ['-load.com/script/', 'length:101']);
    const res = await window.fetch('https://x-load.com/script/a.js');
    assert.equal((await res.text()).length, 101);
  });
});

// ===========================================================================
// §4.21 — json-prune ignored propsToMatch, so URL-scoped rules pruned globally
// ===========================================================================

test('§4.21 corpus [json-prune-fetch-response, ads, "", propsToMatch, /runtime-config]', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const body = () => new Response(JSON.stringify({ ads: [1], keep: 2 }), {
      headers: { 'content-type': 'application/json' },
    });
    globalThis.fetch = async () => body();

    run('json-prune-fetch-response', ['ads', '', 'propsToMatch', '/runtime-config']);

    const scoped = await (await window.fetch('https://site.example/runtime-config')).json();
    assert.deepEqual(scoped, { keep: 2 }, 'the scoped endpoint must be pruned');

    const other = await (await window.fetch('https://site.example/unrelated')).json();
    assert.deepEqual(other, { ads: [1], keep: 2 }, 'other endpoints must be untouched');

    // The fetch flavour must not touch JSON.parse: the alias used to hook
    // both surfaces, so a URL-scoped rule pruned every parse on the page.
    assert.deepEqual(
      JSON.parse('{"ads":[1],"keep":2}'), { ads: [1], keep: 2 },
      'json-prune-fetch-response must not hook JSON.parse',
    );
  });
});

test('§4.21 corpus [json-prune-xhr-response, …, propsToMatch, /api/graphql]', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.XMLHttpRequest = FakeXHR;

    run('json-prune-xhr-response', [
      'data.viewer.instream_video_ads data.scrubber', '', 'propsToMatch', '/api/graphql',
    ]);

    const xhr = new window.XMLHttpRequest();
    xhr.open('POST', 'https://site.example/api/graphql');
    xhr._responseText = JSON.stringify({ data: { viewer: { instream_video_ads: [1] }, scrubber: 1, keep: 2 } });
    assert.deepEqual(JSON.parse(xhr.responseText), { data: { viewer: {}, keep: 2 } });

    const other = new window.XMLHttpRequest();
    other.open('POST', 'https://site.example/other');
    other._responseText = JSON.stringify({ data: { scrubber: 1 } });
    assert.deepEqual(JSON.parse(other.responseText), { data: { scrubber: 1 } }, 'URL-gated');
  });
});

test('§4.21 plain json-prune still hooks JSON.parse and nothing else', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    run('json-prune', ['ads']);
    assert.deepEqual(JSON.parse('{"ads":1,"keep":2}'), { keep: 2 });
  });
});

// ===========================================================================
// §4.22 / §4.27 — prevent-xhr: own properties, newTarget, readyState, props
// ===========================================================================

test('§4.27 corpus [no-xhr-if, method:HEAD]: propsToMatch is parsed', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.XMLHttpRequest = FakeXHR;
    run('no-xhr-if', ['method:HEAD']);

    const head = new window.XMLHttpRequest();
    head.open('HEAD', 'https://example.com/probe');
    head.send();
    assert.equal(head._sent, undefined, 'the HEAD request must be stubbed');

    const get = new window.XMLHttpRequest();
    get.open('GET', 'https://example.com/probe');
    get.send();
    // Prior code treated the whole argument as a URL pattern, so this matched
    // only URLs containing the literal substring "method:HEAD" — never.
    assert.equal(get._sent, true, 'other methods must reach the network');
  });
});

test('§4.27 corpus [no-xhr-if, googlesyndication, length:10]: the directive is applied', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.XMLHttpRequest = FakeXHR;
    run('no-xhr-if', ['googlesyndication', 'length:10']);

    const xhr = new window.XMLHttpRequest();
    xhr.open('GET', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js');
    xhr.send();
    await settle();
    // 11 corpus rules pass a directive that had no parameter to land in, so
    // every blocked request returned ''.
    assert.equal(xhr.responseText.length, 10);
    assert.equal(xhr.status, 200);
    assert.equal(xhr.readyState, 4);
  });
});

test('§4.22 no own properties land on an intercepted XHR instance', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.XMLHttpRequest = FakeXHR;
    run('no-xhr-if', ['googlesyndication']);

    const xhr = new window.XMLHttpRequest();
    // `Object.getOwnPropertyNames(new XMLHttpRequest())` is `[]` on a real
    // browser; the previous wrapper assigned `open` and `send` to every
    // instance, which is a one-line detector.
    assert.deepEqual(Object.getOwnPropertyNames(xhr), [], 'no own props before open()');
    assert.equal(
      String(xhr.open).includes('googlesyndication'), false,
      'String(xhr.open) must not dump the compiled pattern',
    );
  });
});

test('§4.22 setRequestHeader() after open() does not throw on a stubbed request', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.XMLHttpRequest = FakeXHR;
    run('no-xhr-if', ['googlesyndication']);

    const xhr = new window.XMLHttpRequest();
    xhr.open('GET', 'https://pagead2.googlesyndication.com/x');
    // The fake `open` used to skip the native call, leaving readyState at 0,
    // so the spec required this to throw InvalidStateError inside page code.
    assert.doesNotThrow(() => xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest'));
    xhr.send();
  });
});

test('§4.22 subclassing survives interception (newTarget is preserved)', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.XMLHttpRequest = FakeXHR;
    run('no-xhr-if', ['googlesyndication']);

    class PageXHR extends window.XMLHttpRequest {
      customMethod() { return 'page'; }
    }
    const x = new PageXHR();
    assert.ok(x instanceof PageXHR, 'a construct trap that drops newTarget breaks this');
    assert.equal(x.customMethod(), 'page');
  });
});

// ===========================================================================
// §4.26 — trusted-click-element step grammar
// ===========================================================================

test('§4.26 corpus [tce, "1000, #continue-btn", 2000]: the delay step is split off', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const queried = [];
    let clicks = 0;
    document.querySelectorAll = (sel) => {
      queried.push(sel);
      return sel === '#continue-btn' ? [{ click() { clicks++; } }] : [];
    };

    run('trusted-click-element', ['1000, #continue-btn', '2000']);
    await settle(1200); // the rule's own 1000 ms first step

    // Prior code: `querySelector('1000, #continue-btn')` throws — dead rule.
    assert.equal(
      queried.includes('1000, #continue-btn'), false,
      'the delay step must be split off, not handed to the selector engine',
    );
    assert.equal(clicks, 1, 'the selector step must run after the delay step');
  });
});

test('§4.26 corpus [tce, #usercentrics-root >>> button[data-testid="uc-deny-all-button"]]', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    let clicks = 0;
    const denyButton = { click() { clicks++; } };
    const host = {
      shadowRoot: {
        querySelectorAll: (s) => (s === 'button[data-testid="uc-deny-all-button"]' ? [denyButton] : []),
      },
    };
    document.querySelectorAll = (s) => (s === '#usercentrics-root' ? [host] : []);

    run('trusted-click-element', ['#usercentrics-root >>> button[data-testid="uc-deny-all-button"]']);
    await settle(10);

    // The `>>>` rules are the Usercentrics/CMP consent dialogs — the
    // highest-value cookie-banner rules in the corpus.
    assert.equal(clicks, 1, 'shadow-piercing must resolve');
  });
});

test('§4.26 corpus [tce, button#cookie-dismiss, !cookie:cookie-consent, 1000]', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    let clicks = 0;
    document.querySelectorAll = (s) => (s === 'button#cookie-dismiss' ? [{ click() { clicks++; } }] : []);

    cookieJar = ['cookie-consent=yes'];
    run('trusted-click-element', ['button#cookie-dismiss', '!cookie:cookie-consent', '1000']);
    await settle(10);
    assert.equal(clicks, 0, 'the negated assertion must fail when the cookie is present');
  });
});

// ===========================================================================
// §5.21 — detectability of wrapped native functions
// ===========================================================================

test('§5.21 a wrapped native leaves no own property and reports native source', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    class FakeWebGL {
      getParameter(p) { return `real:${p}`; }
    }
    globalThis.WebGLRenderingContext = FakeWebGL;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { languages: ['en'] },
    });
    globalThis.Navigator = class {};

    const original = FakeWebGL.prototype.getParameter;
    run('bot-stealth', ['windows']);
    const fn = FakeWebGL.prototype.getParameter;
    assert.notEqual(fn, original, 'the method must have been wrapped');

    assert.equal(fn.call({}, 37445), 'Google Inc. (Intel)', 'the spoof must apply');
    // Prior code assigned an own `toString`: `Object.keys(fn)` returned
    // ["toString"], the same one-line detector as the old marker property.
    assert.deepEqual(Object.keys(fn), [], 'no own properties on the wrapper');
    assert.equal(fn.name, 'getParameter', 'the wrapper must not be named "wrapped"');
    assert.equal(
      String(fn), String(original),
      'the wrapper must report the wrapped function\'s source (native, on a real browser)',
    );
    assert.equal(
      String(fn).includes('gpu.renderer'), false,
      'the wrapper\'s own body must not be observable',
    );
    assert.match(
      String(Function.prototype.toString), /\[native code\]/,
      'fn.toString.toString() must not leak the masking proxy or arrow-function source',
    );
    delete globalThis.WebGLRenderingContext;
  });
});

// ===========================================================================
// §5.22 — registry coverage for the recoverable names
// ===========================================================================

test('§5.22 the 1,155 alias-recoverable corpus rules now resolve', async () => {
  const { REGISTRY } = await freshRun();
  for (const name of [
    'trusted-set-cookie', 'trusted-set-local-storage-item',
    'json-prune-xhr-response', 'trusted-set-session-storage-item',
    'trusted-set-cookie-reload',
    'remove-node-text', 'rmnt', 'replace-node-text', 'rpnt',
    'trusted-replace-node-text', 'trusted-rpnt',
  ]) {
    assert.ok(REGISTRY.has(name), `${name} must be registered`);
  }
});

test('§5.22 corpus [trusted-set-cookie, intro_popup_last_hidden_at, $currentDate$]', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    run('trusted-set-cookie', ['intro_popup_last_hidden_at', '$currentDate$']);

    const written = cookieJar.join('; ');
    assert.match(written, /^intro_popup_last_hidden_at=/, 'the cookie must be written');
    assert.equal(written.includes('$currentDate$'), false, 'the placeholder must be expanded');
    // Not an alias of set-cookie: that one would refuse this value outright.
    assert.ok(written.includes('Secure'), 'the trusted writer marks the cookie Secure');
  });
});

test('§5.22 corpus [trusted-set-local-storage-item, adBlockerAlert_lastShown, $now$]', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    run('trusted-set-local-storage-item', ['adBlockerAlert_lastShown', '$now$']);
    const v = localStorage.getItem('adBlockerAlert_lastShown');
    assert.match(v, /^\d{10,}$/, '$now$ must expand to a timestamp');
    // The untrusted flavour must refuse the same value.
    run('set-local-storage-item', ['__untrusted_probe', '$now$']);
    assert.equal(localStorage.getItem('__untrusted_probe'), null, 'the value gate is the boundary');
  });
});

test('§5.22 corpus [rmnt, script, "data-adm-url"] blanks a matching node', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const node = { nodeName: 'SCRIPT', textContent: 'var x = {"data-adm-url": "https://ad"};' };
    let walked = false;
    document.createTreeWalker = () => ({
      nextNode: () => { if (walked) return null; walked = true; return node; },
    });

    run('rmnt', ['script', '"data-adm-url"']);
    assert.equal(node.textContent, '', 'a matching script node must be blanked');
  });
});

test('§5.22 corpus [rpnt, script, copyRProtection":true, copyRProtection":false]', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const node = { nodeName: 'SCRIPT', textContent: 'cfg={"copyRProtection":true};' };
    let walked = false;
    document.createTreeWalker = () => ({
      nextNode: () => { if (walked) return null; walked = true; return node; },
    });

    run('rpnt', ['script', 'copyRProtection":true', 'copyRProtection":false']);
    assert.equal(node.textContent, 'cfg={"copyRProtection":false};');
  });
});

// ===========================================================================
// §5.23 / §5.24 — cookies
// ===========================================================================

test('§5.23 corpus [set-cookie, __consent, %5B%22required%22%5D] is refused', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    run('set-cookie', ['__consent', '%5B%22required%22%5D']);
    // uBO's untrusted set-cookie refuses any value outside its safe list —
    // that restriction IS the trust boundary vs trusted-set-cookie.
    assert.deepEqual(cookieJar, [], 'an unsafe value must not be written');
  });
});

test('§5.23 corpus [set-cookie, ezgwcc, 1] writes without double-encoding', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    run('set-cookie', ['ezgwcc', '1']);
    assert.match(cookieJar.join('; '), /^ezgwcc=1/, 'a safe value must still be written');
  });
});

test('§5.23 a pre-encoded safe value is not encoded a second time', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    // `%` is inside the permitted cookie-value range, so uBO leaves it alone.
    run('trusted-set-cookie', ['pref', '%5B%22required%22%5D']);
    assert.match(cookieJar.join('; '), /pref=%5B%22required%22%5D/, 'no double encoding');
  });
});

test('§5.24 remove-cookie issues uBO\'s domain/path delete variants', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    cookieJar = ['euconsent-v2=abc'];
    run('remove-cookie', ['euconsent-v2']);

    const deletes = cookieJar.filter((c) => c.includes('expires=Thu, 01 Jan 1970'));
    // Prior code issued exactly one host-only `path=/` delete, which cannot
    // remove a cookie set at the registrable domain — where consent and
    // tracking cookies overwhelmingly live.
    assert.ok(deletes.length >= 6, `expected >= 6 delete variants, got ${deletes.length}`);
    assert.ok(deletes.some((c) => c.includes('domain=.example.com')), 'dot-prefixed domain variant');
    assert.ok(deletes.some((c) => c.includes('domain=example.com')), 'host domain variant');
    assert.ok(deletes.some((c) => c.includes('path=/')), 'path variant');
  });
});

// ===========================================================================
// §5.25 — trust metadata
// ===========================================================================

test('§5.25 the registry exposes uBO\'s requiresTrust flag', async () => {
  const { getScriptletTrustRequirement, TRUSTED_SCRIPTLETS, REGISTRY } = await freshRun();

  for (const name of [
    'trusted-set-constant', 'tsc', 'trusted-click-element', 'tce',
    'trusted-replace-fetch-response', 'trusted-replace-xhr-response',
    'trusted-set-cookie', 'trusted-set-local-storage-item',
    'replace-node-text', 'rpnt', // uBO aliases these to the trusted scriptlet
  ]) {
    assert.equal(getScriptletTrustRequirement(name), true, `${name} must require trust`);
  }
  for (const name of ['set-constant', 'sc', 'acs', 'aeld', 'set-cookie', 'rmnt', 'json-prune']) {
    assert.equal(getScriptletTrustRequirement(name), false, `${name} must NOT require trust`);
  }
  for (const name of TRUSTED_SCRIPTLETS) {
    assert.ok(REGISTRY.has(name), `${name} is flagged but not registered — the SW would over-block`);
  }
});

// ===========================================================================
// §5.26 — assorted uBO semantic gaps
// ===========================================================================

test('§5.26 corpus [rc, cnx-ad-container|cnx-ad-bid-slot]: default selector joins all tokens', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const queried = [];
    document.querySelectorAll = (sel) => { queried.push(sel); return []; };

    run('rc', ['cnx-ad-container|cnx-ad-bid-slot']);
    assert.deepEqual(
      queried, ['.cnx-ad-container,.cnx-ad-bid-slot'],
      'the default selector used only the first token',
    );
  });
});

test('§5.26 corpus [set, document.body.oncopy, null, 3]: the third argument defers, not aborts', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.__scHost = { oncopy: 'original' };
    run('set', ['__scHost.oncopy', 'null', '3']);
    // readyState is 'complete' in this harness, so `3` applies immediately.
    assert.equal(globalThis.__scHost.oncopy, null, '10 corpus rules pass this argument');
    delete globalThis.__scHost;
  });
});

test('§5.26 corpus [nostif, "", 2000-5000]: uBO delay ranges parse', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const scheduled = [];
    globalThis.setTimeout = (fn, ms) => { scheduled.push(ms); return 1; };

    run('nostif', ['', '2000-5000']);
    window.setTimeout(() => {}, 3000); // inside the range -> suppressed
    window.setTimeout(() => {}, 9000); // outside -> scheduled

    // `Number('2000-5000')` is NaN, so the range form never matched.
    assert.deepEqual(scheduled, [9000]);
  });
});

test('§5.26 corpus [nosiif, !display]: `!needle` inverts the match', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const scheduled = [];
    globalThis.setInterval = (fn, ms) => { scheduled.push(ms); return 1; };

    run('nosiif', ['!display']);
    window.setInterval(function withDisplay() { return 'display'; }, 100);
    window.setInterval(function without() { return 1; }, 200);

    assert.deepEqual(scheduled, [100], 'only the handler NOT containing "display" is suppressed');
  });
});

test('§5.26 corpus [aost, encodeURIComponent, inlineScript]: frames are normalised', async () => {
  await withEnv(async () => {
    const { normalizeStack } = await import('./abort-on-stack-trace.js');
    // uBO replaces the first captured frame — always the scriptlet's own —
    // with the depth marker, so the fixture carries one too.
    const stack = normalizeStack([
      'Error: token',
      '    at matchesStack (file:///nullify/abort-on-stack-trace.js:60:20)',
      '    at doThing (https://example.com/page:12:5)',
      '    at <anonymous>:3:9',
    ].join('\n'));

    // uBO writes needles against these synthesized names; the raw
    // Error().stack contains neither token, so 35 corpus rules were dead.
    assert.match(stack, /^stackDepth:\d+/, 'the depth prefix must be present');
    assert.match(stack, /inlineScript/, 'a document-URL frame becomes inlineScript');
    assert.match(stack, /injectedScript/, 'an <anonymous> frame becomes injectedScript');
  });
});

test('§5.26 aost traps a non-function property', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    globalThis.__aostData = { flag: 1 };
    run('aost', ['__aostData.flag', 'corpus-conformance']);
    // Prior code bailed out on `typeof original !== 'function'`, so the 17
    // corpus rules aimed at a data property did nothing.
    assert.throws(() => globalThis.__aostData.flag, ReferenceError);
    delete globalThis.__aostData;
  });
});

test('§5.26 corpus [spoof-css, .banner_ad_wrapper, display, block] stays variadic', async () => {
  await withEnv(async () => {
    const { run } = await freshRun();
    const el = { matches: (s) => s === '.banner_ad_wrapper' };
    globalThis.getComputedStyle = () => ({
      display: 'none', visibility: 'hidden', getPropertyValue: () => 'none',
    });

    run('spoof-css', ['.banner_ad_wrapper', 'display', 'block', 'visibility', 'visible']);
    const style = window.getComputedStyle(el);
    assert.equal(style.display, 'block');
    // 2 of the 4 shipped rules pass more than one pair; the extra pair used
    // to be dropped on the floor.
    assert.equal(style.visibility, 'visible', 'the second property pair must apply too');
  });
});
