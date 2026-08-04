/**
 * Regression suite for the content-script entry point
 * (src/content/content-main.js), covering docs/REVIEW-2026-08.md:
 *
 *   §3.3  — the DOMContentLoaded re-run went straight at `_applyAllProcedural`,
 *           evaluating against a stale (empty) dirty-roots snapshot instead of
 *           swapping it first.
 *   §4.11 — the message bus resolves with `{error: …}` rather than rejecting,
 *           so a failed GET_INIT_DATA looked like a healthy "nothing to do"
 *           reply and the REPORT_CONTENT_ERROR reporter never fired.
 *   §4.13 — `data-nullify-wasm` published the extension ID into every YouTube
 *           page, allowlisted ones included, and was never removed.
 *   §4.24 — ACTIVATE_PICKER is broadcast to every frame.
 *   §5.19 — the engine was a local of `main()`, so `stopObserver()` had no
 *           production caller and the observer plus its 5-minute interval
 *           outlived the document.
 *   §5.20 — `PROC_TOKEN_REGEX` omitted `semantic`, so a string-form
 *           `div:semantic(x)` rule never constructed the engine.
 *
 * The module's top level has side effects (it registers a message listener and
 * kicks off `main()`), so each scenario evaluates the source in a fresh `vm`
 * context with its imports stubbed, rather than sharing one module instance.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SOURCE_URL = new URL('./content-main.js', import.meta.url);

let _body = null;
async function moduleBody() {
  if (_body === null) {
    const source = await readFile(SOURCE_URL, 'utf8');
    // Strip the ESM import statements; the bindings are injected as context
    // globals below so each scenario can substitute its own doubles.
    _body = source.replace(/^import\s.*?;$/gm, '');
    assert.ok(!/^import\s/m.test(_body), 'all imports stripped');
  }
  return _body;
}

/** Records every call the engine receives, so ordering can be asserted. */
class FakeEngine {
  static instances = [];
  constructor() {
    this.calls = [];
    this.rules = null;
    FakeEngine.instances.push(this);
  }
  init(rules) { this.rules = rules; this.calls.push('init'); }
  _applyAllProcedural() { this.calls.push('_applyAllProcedural'); }
  _scheduleProceduralRun() { this.calls.push('_scheduleProceduralRun'); }
  stopObserver() { this.calls.push('stopObserver'); }
}

function makeEnv({
  hostname = 'www.youtube.com',
  initRes = {},
  sendMessage,
  readyState = 'complete',
  getURL = (path) => `chrome-extension://abcdefghijklmnop/${path}`,
} = {}) {
  FakeEngine.instances = [];

  const state = {
    sent: [],
    attrs: new Map(),
    styles: [],
    docListeners: new Map(),
    winListeners: new Map(),
    messageListeners: [],
    pickerCalls: [],
    timeouts: [],
  };

  const documentElement = {
    setAttribute: (name, value) => state.attrs.set(name, value),
    removeAttribute: (name) => state.attrs.delete(name),
    getAttribute: (name) => state.attrs.get(name) ?? null,
    prepend: (node) => state.styles.push(node),
    appendChild: (node) => state.styles.push(node),
  };

  const context = {
    console,
    Set,
    Promise,
    Error,
    String,
    setTimeout: (fn, ms) => { state.timeouts.push({ fn, ms }); return state.timeouts.length; },
    document: {
      documentElement,
      head: null,
      readyState,
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      addEventListener(type, fn) {
        if (!state.docListeners.has(type)) state.docListeners.set(type, []);
        state.docListeners.get(type).push(fn);
      },
    },
    location: { hostname },
    window: {
      addEventListener(type, fn) {
        if (!state.winListeners.has(type)) state.winListeners.set(type, []);
        state.winListeners.get(type).push(fn);
      },
    },
    chrome: {
      runtime: {
        getURL,
        sendMessage: sendMessage || ((msg) => {
          state.sent.push(msg);
          return msg.type === 'GET_INIT_DATA' ? Promise.resolve(initRes) : Promise.resolve({});
        }),
        onMessage: { addListener: (fn) => state.messageListeners.push(fn) },
      },
    },
    // Injected stand-ins for the stripped imports.
    CosmeticEngine: FakeEngine,
    activatePicker: (options) => state.pickerCalls.push(['activate', options]),
    deactivatePicker: () => state.pickerCalls.push(['deactivate']),
    normalizeHostname: (h) => h,
    resolvePageRules: (res) => res?.rules ?? { generic: [], domainSpecific: [], exceptions: [] },
  };
  context.globalThis = context;
  vm.createContext(context);
  return { context, state };
}

async function run(env) {
  vm.runInContext(await moduleBody(), env.context);
  // Let `main()`'s awaited sendMessage and the catch handler settle.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/** Fire whatever the module registered for a document/window event. */
function fire(map, type, event) {
  for (const fn of map.get(type) || []) fn(event);
}

// ---------------------------------------------------------------------------
// §3.3 — the DOMContentLoaded re-run must swap the dirty snapshot first.
// ---------------------------------------------------------------------------

test('the DOMContentLoaded re-run goes through the scheduler (§3.3)', async () => {
  const env = makeEnv({
    hostname: 'example.test',
    readyState: 'loading',
    initRes: { isAllowed: false, rules: { generic: ['div:has-text(Ad)'], domainSpecific: [], exceptions: [] } },
  });
  await run(env);

  const engine = FakeEngine.instances[0];
  assert.ok(engine, 'engine constructed');
  fire(env.state.docListeners, 'DOMContentLoaded', {});

  // Prior code called `_applyAllProcedural()` directly, so the re-run
  // evaluated against the snapshot from the *previous* run and cached those
  // verdicts for everything the parser had added since.
  assert.deepEqual(engine.calls, ['init', '_scheduleProceduralRun']);
});

// ---------------------------------------------------------------------------
// §4.11 — `{error: …}` resolves; it does not reject.
// ---------------------------------------------------------------------------

test('an {error} init response is reported, not treated as "no rules" (§4.11)', async () => {
  const env = makeEnv({ hostname: 'example.test', initRes: { error: 'getCosmeticBundleForPage failed' } });
  await run(env);

  // Prior code destructured `{isAllowed, cssText}` off the error envelope,
  // applied nothing, threw nothing, and reported a healthy extension.
  const report = env.state.sent.find((m) => m.type === 'REPORT_CONTENT_ERROR');
  assert.ok(report, 'REPORT_CONTENT_ERROR sent');
  assert.match(report.payload.message, /getCosmeticBundleForPage failed/);
  assert.equal(FakeEngine.instances.length, 0, 'no engine built on a failed init');
});

test('a healthy init response is not mistaken for an error (§4.11 didn\'t re-break)', async () => {
  const env = makeEnv({
    hostname: 'example.test',
    initRes: { isAllowed: false, cssText: '.ad{display:none}', rules: { generic: ['div:has-text(Ad)'], domainSpecific: [] } },
  });
  await run(env);

  assert.equal(env.state.sent.some((m) => m.type === 'REPORT_CONTENT_ERROR'), false);
  assert.equal(FakeEngine.instances.length, 1);
});

// ---------------------------------------------------------------------------
// §4.13 — the WASM URL attribute publishes the extension ID.
// ---------------------------------------------------------------------------

test('the WASM URL is not published on an allowlisted YouTube page (§4.13)', async () => {
  const env = makeEnv({ hostname: 'www.youtube.com', initRes: { isAllowed: true } });
  await run(env);

  // Prior code ran at module top level, before `isAllowed` was known, so a tab
  // the user had explicitly allowlisted still announced the extension ID.
  assert.equal(env.state.attrs.has('data-nullify-wasm'), false);
});

test('the WASM URL is published then withdrawn on a filtered YouTube page (§4.13)', async () => {
  const env = makeEnv({ hostname: 'www.youtube.com', initRes: { isAllowed: false } });
  await run(env);

  assert.equal(
    env.state.attrs.get('data-nullify-wasm'),
    'chrome-extension://abcdefghijklmnop/dist/nullify_core_bg.wasm',
    'the MAIN-world shield can still read it'
  );

  // Prior code left it on <html> for the life of the document.
  const pending = env.state.timeouts.filter((t) => t.ms === 0);
  assert.ok(pending.length > 0, 'withdrawal scheduled');
  for (const timer of pending) timer.fn();
  assert.equal(env.state.attrs.has('data-nullify-wasm'), false);
});

test('the WASM URL is never published off YouTube (§4.13 didn\'t re-break)', async () => {
  const env = makeEnv({ hostname: 'example.test', initRes: { isAllowed: false } });
  await run(env);
  assert.equal(env.state.attrs.has('data-nullify-wasm'), false);
});

// ---------------------------------------------------------------------------
// §4.24 — the picker must not mount in every frame.
// ---------------------------------------------------------------------------

test('ACTIVATE_PICKER is forwarded with the frame opt-in flag (§4.24)', async () => {
  const env = makeEnv({ hostname: 'example.test', initRes: { isAllowed: true } });
  await run(env);

  const listener = env.state.messageListeners[0];
  assert.ok(listener, 'message listener registered');

  // (Objects built inside the vm realm, so compare fields not identity.)
  listener({ type: 'ACTIVATE_PICKER' });
  assert.equal(env.state.pickerCalls.length, 1);
  assert.equal(env.state.pickerCalls[0][0], 'activate');
  assert.equal(env.state.pickerCalls[0][1].allowInFrame, false);

  listener({ type: 'ACTIVATE_PICKER', allowInFrame: true });
  assert.equal(env.state.pickerCalls[1][1].allowInFrame, true);

  listener({ type: 'DEACTIVATE_PICKER' });
  assert.equal(env.state.pickerCalls[2][0], 'deactivate');
});

// ---------------------------------------------------------------------------
// §5.19 — `stopObserver()` had no production caller.
// ---------------------------------------------------------------------------

test('the engine observer is stopped when the document goes away (§5.19)', async () => {
  const env = makeEnv({
    hostname: 'example.test',
    initRes: { isAllowed: false, rules: { generic: ['div:has-text(Ad)'], domainSpecific: [] } },
  });
  await run(env);
  const engine = FakeEngine.instances[0];

  // Prior code kept the engine in a `const` local of `main()`, so nothing
  // could ever reach `stopObserver()` — the MutationObserver and the 5-minute
  // cache-sweep interval outlived the page.
  fire(env.state.winListeners, 'pagehide', { persisted: false });
  assert.ok(engine.calls.includes('stopObserver'));
});

test('a bfcache-persisted pagehide leaves the observer running (§5.19)', async () => {
  const env = makeEnv({
    hostname: 'example.test',
    initRes: { isAllowed: false, rules: { generic: ['div:has-text(Ad)'], domainSpecific: [] } },
  });
  await run(env);
  const engine = FakeEngine.instances[0];

  // The document can come back; tearing down here would leave the restored
  // page with no procedural filtering at all.
  fire(env.state.winListeners, 'pagehide', { persisted: true });
  assert.equal(engine.calls.includes('stopObserver'), false);
});

// ---------------------------------------------------------------------------
// §5.20 — planner parity: `semantic` was missing from the token regex.
// ---------------------------------------------------------------------------

test('a string-form :semantic() rule constructs the engine (§5.20)', async () => {
  const env = makeEnv({
    hostname: 'example.test',
    initRes: { isAllowed: false, rules: { generic: ['div:semantic(ad)'], domainSpecific: [], exceptions: [] } },
  });
  await run(env);

  // Prior code's PROC_TOKEN_REGEX omitted `semantic`, so the rule was
  // classified as non-procedural, `hasProcedural` stayed false and `main()`
  // returned before building the engine.
  assert.equal(FakeEngine.instances.length, 1);
  assert.deepEqual(FakeEngine.instances[0].rules.generic, ['div:semantic(ad)']);
});

test('a page with no procedural rules still short-circuits (§5.20 didn\'t re-break)', async () => {
  const env = makeEnv({
    hostname: 'example.test',
    initRes: { isAllowed: false, rules: { generic: ['.plain-ad'], domainSpecific: [], exceptions: [] } },
  });
  await run(env);
  assert.equal(FakeEngine.instances.length, 0);
});
