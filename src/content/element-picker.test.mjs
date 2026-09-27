import test from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_FUNCTIONAL_PSEUDO_CLASSES } from '../shared/proc-ops.js';

// element-picker.js reads DOM globals at call time only (its module top level
// just defines constants), so stubs installed here are in place before any
// exported function runs.

class FakeShadowRoot {
  constructor(host) { this.host = host; }
}

/** Minimal element stub carrying what the picker touches. */
function el(overrides = {}) {
  return {
    tagName: 'DIV',
    id: '',
    classList: [],
    textContent: '',
    parentElement: null,
    getAttribute: () => null,
    getRootNode() { return globalThis.document; },
    querySelectorAll: () => [],
    style: { setProperty: () => {} },
    ...overrides,
  };
}

// Mutable per-test document state: selector -> matches at the document level,
// plus the elements returned by a wildcard scan (used for shadow traversal).
const docState = { byLevel: new Map(), all: [] };

/**
 * Node stub with the two behaviours the picker's DOM writes depend on:
 * assigning `innerHTML` re-parses (and therefore *replaces*) the children —
 * which is how §5.16's listener loss happens — while `appendChild` does not.
 */
function makeNode(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    style: {},
    children: [],
    listeners: new Map(),
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; this.children = []; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); },
    remove() {
      mountedById.delete(this.id);
      const siblings = this.parentNode?.children;
      if (siblings) siblings.splice(siblings.indexOf(this), 1);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
  };
}

// Elements the picker mounted on documentElement, keyed by id.
const mountedById = new Map();
// document-level listeners, keyed by `type` (all of the picker's are capture).
const docListeners = new Map();

globalThis.document = {
  querySelectorAll(sel) {
    if (sel === '*') return docState.all;
    return docState.byLevel.get(sel) || [];
  },
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  getElementById: (id) => mountedById.get(id) || null,
  createElement: (tag) => makeNode(tag),
  documentElement: {
    appendChild(node) { if (node?.id) mountedById.set(node.id, node); return node; },
  },
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
  elementFromPoint: () => null,
};
globalThis.location = { hostname: 'example.test' };
globalThis.CSS = { escape: (s) => s };
globalThis.ShadowRoot = FakeShadowRoot;
globalThis.window = { top: globalThis.window ?? {} };
globalThis.window.top = globalThis.window; // top frame by default

const {
  generateSelectors, isShadowOnlySelector, savePickerRule, activatePicker, deactivatePicker,
  generateNetworkCandidates, urlToNetworkPattern, compilerKeepsSelector, looksHashed, selectorScore,
} = await import('./element-picker.js');

/** Dispatch to whatever the picker registered on `document` for `type`. */
function fireDocEvent(type, event) {
  for (const fn of docListeners.get(type) || []) fn(event);
  return event;
}

/** An event stub that records which suppression calls it received. */
function makeEvent(overrides = {}) {
  const e = {
    type: 'keydown',
    key: 'k',
    target: { closest: () => null },
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    stopImmediatePropagation() { this.propagationStopped = true; },
    ...overrides,
  };
  return e;
}

function resetPickerEnv() {
  deactivatePicker();
  mountedById.clear();
  docListeners.clear();
  docState.byLevel = new Map();
  docState.all = [];
  globalThis.window.top = globalThis.window;
}

function makeDialog() {
  const footer = makeNode('div');
  footer.className = 'adblock-picker-footer';
  // The buttons `updatePickerDialog` wires listeners onto.
  footer.children = [makeNode('button'), makeNode('button')];
  footer._html = '<button id="adblock-picker-cancel2">Cancel</button>';
  return {
    footer,
    footerText: () => footer.children.map((c) => c.textContent).join(' '),
    querySelector: (sel) => (sel === '.adblock-picker-footer' ? footer : null),
  };
}

// §5.30 — the picker must not offer (or save) candidates that document-level
// CSS cannot apply because they only exist inside a shadow root.

test('picker offers only host-level candidates for shadow-DOM elements (§5.30)', () => {
  const host = el({ tagName: 'ASIDE', id: 'widget', classList: ['promo-box'] });
  const shadow = new FakeShadowRoot(host);
  const inner = el({
    tagName: 'SPAN',
    id: 'inner-ad',
    classList: ['ad-box', 'ad-label'],
    getRootNode: () => shadow,
  });
  docState.byLevel = new Map([
    ['#widget', [host]],
    ['.promo-box', [host]],
    ['aside', [host]],
  ]);
  docState.all = [];

  const candidates = generateSelectors(inner);
  assert.ok(candidates.length > 0, 'host-level candidates offered');
  assert.ok(candidates.some((c) => c.selector === '#widget'));
  // Prior code went on to offer #inner-ad / .ad-box — selectors a saved
  // document-level rule could never apply.
  for (const c of candidates) {
    assert.ok(
      !c.selector.includes('inner-ad') && !c.selector.includes('ad-box'),
      `shadow-internal candidate offered: ${c.selector}`
    );
  }
});

test('saving a shadow-only selector is refused with an explanation (§5.30)', async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); } },
  };

  // `.ad-box` matches nothing at the document level, but the shadow-piercing
  // deep query (what the preview shows) finds a hit inside a shadow root.
  const hostEl = el();
  hostEl.shadowRoot = { querySelectorAll: (sel) => (sel === '.ad-box' ? [el()] : []) };
  docState.byLevel = new Map();
  docState.all = [hostEl];
  assert.equal(isShadowOnlySelector('.ad-box'), true);

  const dialog = makeDialog();
  await savePickerRule('example.test##.ad-box', '.ad-box', 'example.test', dialog);

  // Prior code persisted the dead rule and showed "Rule saved".
  assert.equal(sent.length, 0, 'nothing persisted');
  assert.match(dialog.footerText(), /shadow/i);
  assert.ok(!dialog.footer.innerHTML.includes('Rule saved'));
});

// §5.31 — the save path must be a single atomic append, not a
// read-modify-write that races other writers.

test('picker save is a single atomic APPEND_USER_FILTER message (§5.31)', async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); } },
  };

  const target = el();
  docState.byLevel = new Map([['.ad-banner', [target]]]);
  docState.all = [];

  const dialog = makeDialog();
  await savePickerRule('example.test##.ad-banner', '.ad-banner', 'example.test', dialog);

  // Prior code issued GET_USER_FILTERS + SET_USER_FILTERS — two pickers (or a
  // picker plus an options-page edit) silently dropped one rule.
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: 'APPEND_USER_FILTER',
    payload: { line: 'example.test##.ad-banner' },
  });
  assert.match(dialog.footer.innerHTML, /Rule saved/);
});

test('an APPEND_USER_FILTER error response is surfaced, not shown as success (§5.31)', async () => {
  globalThis.chrome = {
    runtime: { sendMessage: () => Promise.resolve({ error: 'storage write failed' }) },
  };
  docState.byLevel = new Map([['.ad-banner', [el()]]]);
  docState.all = [];

  const dialog = makeDialog();
  await savePickerRule('##.ad-banner', '.ad-banner', 'example.test', dialog);

  assert.match(dialog.footerText(), /storage write failed/);
  assert.ok(!dialog.footer.innerHTML.includes('Rule saved'));
});

// §5.16 — the error path re-parsed the footer, replacing Cancel and Create
// with fresh nodes that carried none of the listeners wired in
// `updatePickerDialog`. The §5.30 refusal above goes through this path, so the
// user read "pick the outer element instead", picked it, clicked Create — and
// nothing happened.

test('showing an error keeps the footer buttons and their listeners (§5.16)', async () => {
  globalThis.chrome = {
    runtime: { sendMessage: () => Promise.resolve({ error: 'nope' }) },
  };
  docState.byLevel = new Map([['.ad-banner', [el()]]]);
  docState.all = [];

  const dialog = makeDialog();
  const buttonsBefore = dialog.footer.children.slice();
  await savePickerRule('##.ad-banner', '.ad-banner', 'example.test', dialog);

  // Prior code (`footer.innerHTML += …`) dropped both buttons on the floor.
  for (const button of buttonsBefore) {
    assert.ok(dialog.footer.children.includes(button), 'footer button survived');
  }
  assert.match(dialog.footerText(), /nope/);
});

test('a second error replaces the first instead of stacking (§5.16)', async () => {
  globalThis.chrome = {
    runtime: { sendMessage: () => Promise.resolve({ error: 'first' }) },
  };
  docState.byLevel = new Map([['.ad-banner', [el()]]]);
  docState.all = [];

  const dialog = makeDialog();
  // The stub's querySelector returns the footer for any selector, which is
  // enough for the de-dupe lookup inside showErrorInDialog.
  dialog.footer.querySelector = (sel) =>
    dialog.footer.children.find((c) => c.className && sel.includes(c.className)) || null;

  await savePickerRule('##.ad-banner', '.ad-banner', 'example.test', dialog);
  globalThis.chrome.runtime.sendMessage = () => Promise.resolve({ error: 'second' });
  await savePickerRule('##.ad-banner', '.ad-banner', 'example.test', dialog);

  const errors = dialog.footer.children.filter((c) => c.className.includes('error'));
  assert.equal(errors.length, 1);
  assert.match(errors[0].textContent, /second/);
});

// PICKER-2026-09 PK1 — the append recompiles the whole of My Filters, so the
// reply's `skippedNetwork`/`skippedRules` describe every stored line. The save
// must report its own line's drop, and must not blame a clean save for a line
// the user pasted long ago.

/**
 * Save with `setTimeout` captured, then fire what was queued, so the delayed
 * success toast lands inside the test. Returns the text of every toast
 * mounted; nested timers (the toast's own removal) are captured and dropped.
 */
async function saveAndFlushToasts(rule, selector, dialog) {
  const queued = [];
  const toasts = [];
  const root = globalThis.document.documentElement;
  const realSetTimeout = globalThis.setTimeout;
  const realAppend = root.appendChild;
  globalThis.setTimeout = (fn) => { queued.push(fn); return 0; };
  root.appendChild = function (node) {
    if (node?.className === '__adblock_picker_toast__') toasts.push(node.textContent);
    return realAppend.call(this, node);
  };
  try {
    await savePickerRule(rule, selector, 'example.test', dialog);
    for (const fn of queued.splice(0)) fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    root.appendChild = realAppend;
  }
  return toasts;
}

test('PK1: an unrelated dropped line does NOT block a clean save', async () => {
  const cases = [
    // A `$removeparam` line pasted into My Filters long ago.
    { rule: '##.ad-banner', counts: { network: 0, cosmetic: 1 },
      other: { id: null, line: '||facebook.com^$removeparam=fbclid', reason: 'unsupported option: removeparam' } },
    // A longer line that merely starts with the saved one: a prefix or
    // substring lookup blames the clean save for it.
    { rule: '||ads.example^', counts: { network: 1, cosmetic: 0 },
      other: { id: null, line: '||ads.example^$csp=x', reason: 'unsupported option: csp' } },
  ];
  for (const { rule, counts, other } of cases) {
    globalThis.chrome = {
      runtime: {
        sendMessage: () => Promise.resolve({
          ok: true,
          counts: { ...counts, skippedNetwork: 1, skippedRules: [other] },
        }),
      },
    };
    docState.byLevel = new Map([['.ad-banner', [el()]]]);
    docState.all = [];

    const dialog = makeDialog();
    await savePickerRule(rule, '.ad-banner', 'example.test', dialog);

    // A `skippedNetwork > 0` check reports an error here: the counts cover
    // every stored line, and this drop belongs to a different one.
    assert.match(dialog.footer.innerHTML, /Rule saved/, `${rule} blamed for ${other.line}`);
  }
});

test('PK1: the saved line\'s own drop is reported, not shown as saved', async () => {
  const rule = '||x.example^$redirect=y';
  globalThis.chrome = {
    runtime: {
      sendMessage: () => Promise.resolve({
        ok: true,
        counts: {
          network: 0,
          cosmetic: 0,
          skippedNetwork: 2,
          // An older, unrelated drop listed first: reporting `skippedRules[0]`
          // shows its reason instead of this line's.
          skippedRules: [
            { id: null, line: '||facebook.com^$removeparam=fbclid', reason: 'unsupported option: removeparam' },
            { id: null, line: rule, reason: 'unsupported option: redirect' },
          ],
        },
      }),
    },
  };
  const hidden = [];
  docState.byLevel = new Map([['.ad-banner', [el({ style: { setProperty: (p) => hidden.push(p) } })]]]);
  docState.all = [];

  const dialog = makeDialog();
  const toasts = await saveAndFlushToasts(rule, '.ad-banner', dialog);

  // Prior code checked only `res.ok`, so a line the compiler dropped read as
  // "Rule saved".
  assert.match(dialog.footerText(), /unsupported option: redirect/);
  assert.doesNotMatch(dialog.footerText(), /removeparam/);
  assert.ok(!dialog.footer.innerHTML.includes('Rule saved'));
  // Nor the other two success signals: the element vanishing (a reload will
  // not hide it) and the toast.
  assert.deepEqual(hidden, [], 'nothing hidden for a rule that is not applied');
  assert.ok(!toasts.some((t) => /Rule saved/.test(t)), `success toast shown: ${toasts}`);
});

test('PK1: a drop entry without a reason still reports the line as not applied', async () => {
  const rule = '||x.example^$csp=x';
  globalThis.chrome = {
    runtime: {
      sendMessage: () => Promise.resolve({
        ok: true,
        counts: { network: 0, cosmetic: 0, skippedNetwork: 1, skippedRules: [{ id: null, line: rule }] },
      }),
    },
  };
  docState.byLevel = new Map([['.ad-banner', [el()]]]);
  docState.all = [];

  const dialog = makeDialog();
  await savePickerRule(rule, '.ad-banner', 'example.test', dialog);

  assert.match(dialog.footerText(), /couldn.t be applied/);
  assert.ok(!dialog.footer.innerHTML.includes('Rule saved'));
});

test('PK1: the drop is matched on the line as the SW stores it, trimmed', async () => {
  // `appendUserFilterLine` stores `line.trim()` and the compiler reports that
  // trimmed text, so an untrimmed lookup misses the entry and reports success.
  const rule = '||x.example^$redirect=y';
  globalThis.chrome = {
    runtime: {
      sendMessage: () => Promise.resolve({
        ok: true,
        counts: {
          network: 0,
          cosmetic: 0,
          skippedNetwork: 1,
          skippedRules: [{ id: null, line: rule, reason: 'unsupported option: redirect' }],
        },
      }),
    },
  };
  docState.byLevel = new Map([['.ad-banner', [el()]]]);
  docState.all = [];

  const dialog = makeDialog();
  await savePickerRule(` ${rule}\t`, '.ad-banner', 'example.test', dialog);

  assert.match(dialog.footerText(), /unsupported option: redirect/);
});

test('PK1 (didn\'t re-break): a clean apply with no drops still shows success', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: () => Promise.resolve({
        ok: true,
        counts: { network: 1, skippedNetwork: 0, skippedRules: [] },
      }),
    },
  };
  const hidden = [];
  docState.byLevel = new Map([['.ad-banner', [el({ style: { setProperty: (p) => hidden.push(p) } })]]]);
  docState.all = [];

  const dialog = makeDialog();
  const toasts = await saveAndFlushToasts('example.test##.ad-banner', '.ad-banner', dialog);

  assert.match(dialog.footer.innerHTML, /Rule saved/);
  // The probes the drop test reads as silent do fire on a real save.
  assert.deepEqual(hidden, ['display']);
  assert.ok(toasts.some((t) => /Rule saved/.test(t)), `no success toast: ${toasts}`);
});

// PICKER-2026-09 PK1b — never save a line the pipeline will discard. Two
// independent ways to lose one: the browser cannot parse the selector (joined
// into the site's one CSS declaration, it voids every other hide there —
// REVIEW-2026-09 §3.2's mechanism), or the compiler refuses it, which it does
// without a `droppedLines` entry, so PK1 cannot report the drop.

/**
 * CSSOM `CSS.escape` ("serialize an identifier"). The harness stubs identity,
 * which hides every escape the picker relies on; tests that need the real
 * output install this.
 */
function cssEscape(value) {
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) out += '\uFFFD';
    else if ((c >= 0x1 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 0x30 && c <= 0x39) ||
      (i === 1 && c >= 0x30 && c <= 0x39 && s.charCodeAt(0) === 0x2d)) out += `\\${c.toString(16)} `;
    else if (i === 0 && c === 0x2d && s.length === 1) out += `\\${s[i]}`;
    else if (c >= 0x80 || c === 0x2d || c === 0x5f || /[0-9A-Za-z]/.test(s[i])) out += s[i];
    else out += `\\${s[i]}`;
  }
  return out;
}

/**
 * Run `fn` with the document parsing selectors the way Chrome does for the
 * shapes these tests use. The harness stub never throws, so without this a
 * test cannot tell "refused because the browser can't parse it" from "never
 * checked". Chrome throws a SyntaxError for a functional pseudo-class it does
 * not implement — every procedural operator (`:has-text(`) included — and for
 * a `|`, `^`, `$` or `=` outside an attribute selector (a network filter
 * pasted into the custom field). Escapes and strings are skipped, as the
 * tokenizer does.
 */
async function withBrowserParser(fn) {
  const doc = globalThis.document;
  const { querySelector, querySelectorAll } = doc;
  const parse = (sel) => {
    const bare = sel.replace(/\\[\s\S]/g, '_').replace(/"[^"]*"|'[^']*'/g, '""');
    const unknownFn = [...bare.matchAll(/:([\w-]+)\(/g)]
      .some(([, name]) => !NATIVE_FUNCTIONAL_PSEUDO_CLASSES.has(name.toLowerCase()));
    if (unknownFn || /[|^$=]/.test(bare.replace(/\[[^\]]*\]/g, ''))) {
      throw new SyntaxError(`'${sel}' is not a valid selector`);
    }
  };
  doc.querySelector = function (sel) { parse(sel); return querySelector.call(this, sel); };
  doc.querySelectorAll = function (sel) { parse(sel); return querySelectorAll.call(this, sel); };
  try {
    return await fn();
  } finally {
    doc.querySelector = querySelector;
    doc.querySelectorAll = querySelectorAll;
  }
}

test('PK1b: a custom selector the browser cannot parse is refused, and nothing is sent', async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); } },
  };
  docState.byLevel = new Map();
  docState.all = [];

  await withBrowserParser(async () => {
    // A network filter pasted into the custom field, and a pseudo-class no
    // browser implements (§3.2's shape). Joined into the site's one CSS
    // declaration, either one voids every other hide rule there.
    for (const selector of ['||x.example^$redirect=noopjs', 'div:nope(x)']) {
      const dialog = makeDialog();
      await savePickerRule(`example.test##${selector}`, selector, 'example.test', dialog);
      assert.match(dialog.footerText(), /can.t be saved/, selector);
      assert.ok(!dialog.footer.innerHTML.includes('Rule saved'), selector);
    }
  });
  // Prior code sent both.
  assert.deepEqual(sent, []);
});

test('PK1b: a custom selector the compiler would drop is refused, and nothing is sent', async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); } },
  };
  docState.byLevel = new Map();
  docState.all = [];

  await withBrowserParser(async () => {
    // Every plain one here parses as CSS (the escaped ones are exactly what a
    // real CSS.escape emits for a page's class), so only the compiler mirror
    // can refuse them; `is_valid_selector` drops each without a trace.
    for (const selector of [
      '.a\\{b', '.a\\}b', '[title="{"]', '.a\\;b', // { } ; outside any operator
      '.ad;div:has-text(x)', // `;` before an operator's argument
      'div:has-text(x);.y', // `;` after it
      'div:has-text(a;b', // `;` in an operator that never closes
      '.a\0b', // NUL
      '\u0085', // empty once trimmed the way Rust trims
    ]) {
      const dialog = makeDialog();
      await savePickerRule(`example.test##${selector}`, selector, 'example.test', dialog);
      // Invisible characters spelled out, so a failure names the case.
      const shown = selector.replace(/[^\x20-\x7e]/g, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
      assert.match(dialog.footerText(), /can.t be saved/, shown);
    }
  });
  // Prior code sent every one: dead lines reported as "Rule saved".
  assert.deepEqual(sent, []);
});

test('PK1b: a generated candidate carrying { } or ; is not offered', () => {
  const identity = globalThis.CSS.escape;
  globalThis.CSS.escape = cssEscape;
  try {
    docState.byLevel = new Map();
    docState.all = [];
    // The premise: a real escaper keeps these valid CSS, so only the compiler
    // mirror stands between the page's class and a dead "Rule saved".
    assert.equal(CSS.escape('ad{x'), 'ad\\{x');

    const target = el({
      classList: ['ad{x', 'ad}y', 'ad;z', 'clean'],
      getAttribute: (name) => (name === 'data-ad' ? 'slot;1' : null),
    });
    const offered = generateSelectors(target).map((c) => c.selector);

    assert.ok(offered.includes('.clean'), `clean class still offered: ${offered}`);
    for (const selector of offered) assert.doesNotMatch(selector, /[{};]/, selector);
  } finally {
    globalThis.CSS.escape = identity;
  }
});

test('PK1b (didn\'t re-break): a generated candidate the browser cannot parse is still not offered', async () => {
  docState.byLevel = new Map();
  docState.all = [];
  // The identity CSS.escape leaves this id raw, standing in for any candidate
  // the browser rejects: `add()` refused it before PK1b and still must.
  const target = el({ id: 'ad:nope(1)', classList: ['clean'] });
  const offered = await withBrowserParser(() => generateSelectors(target).map((c) => c.selector));

  assert.ok(offered.includes('.clean'), `clean class still offered: ${offered}`);
  assert.deepEqual(offered.filter((s) => s.includes('#ad:nope(1)')), []);
});

test('PK1b (didn\'t re-break): valid plain, native :has() and procedural selectors still save', async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); } },
  };
  docState.byLevel = new Map([['.ad-banner', [el()]]]);
  docState.all = [];
  const selectors = [
    '.ad-banner',
    'div:has(> img.ad)', // native :has(): plain CSS the browser parses
    'div:has-text(Sponsored)', // procedural: the browser throws on it, the engine plans it
    'div:has-text(a;b)', // a `;` inside an operator's argument is kept by the compiler
    'div:has-text(/a(b);c/)', // ... even past a nested paren, which the depth scan skips
    'div:HAS-TEXT(a;b)', // ... and the operator matches case-insensitively, as in Rust
  ];

  await withBrowserParser(async () => {
    for (const selector of selectors) {
      const dialog = makeDialog();
      await saveAndFlushToasts(`example.test##${selector}`, selector, dialog);
      assert.match(dialog.footer.innerHTML, /Rule saved/, selector);
    }
  });
  assert.deepEqual(sent.map((m) => m.payload.line), selectors.map((s) => `example.test##${s}`));
});

// PICKER-2026-09 PK2a — network-block candidates for the picked element's own
// request, and the picker's site scope as the registrable host. Every line
// must be one SW1's APPEND gate admits, or the user's save is refused; the
// resource URL (host included) is the page's to choose, so nothing from it may
// reach the line but a validated host, a gate-safe path and the fixed tail.

/** SW1's network shape, with the picker's fixed `$type,domain=site` tail. */
const PICKER_NETWORK_LINE =
  /^\|\|(?:[a-z0-9.-]+|\[[0-9a-f:]+\])(?:\^|\/[\w!%&'()+,\-.:;=@[\]~/]*\^?)\$(?:image|subdocument|media|object),domain=[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/** An element stub whose attributes come from `attrs`. */
function tagged(tagName, attrs = {}, overrides = {}) {
  return el({ tagName, getAttribute: (name) => attrs[name] ?? null, ...overrides });
}

/** Run `fn` with the page's `location.hostname` set to `hostname`. */
function onSite(hostname, fn) {
  const saved = globalThis.location.hostname;
  globalThis.location.hostname = hostname;
  try {
    return fn();
  } finally {
    globalThis.location.hostname = saved;
  }
}

const rulesOf = (candidates) => candidates.map((c) => c.rule);

/**
 * Open the picker's dialog on `target` the way a click does, with every
 * control `updatePickerDialog` reads or wires stubbed by selector. Returns the
 * lookup, so a test can read the rule preview and press Create.
 */
function openDialogFor(target) {
  const controls = new Map();
  const control = (sel) => {
    if (!controls.has(sel)) {
      controls.set(sel, {
        value: '',
        checked: sel === '#adblock-scope-site',
        placeholder: '',
        textContent: '',
        innerHTML: '',
        listeners: new Map(),
        addEventListener(type, fn) { this.listeners.set(type, fn); },
      });
    }
    return controls.get(sel);
  };
  const realCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) =>
    Object.assign(makeNode(tag), { querySelector: control, querySelectorAll: () => [] });
  try {
    activatePicker();
    Object.assign(target, {
      closest: () => null,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 10, height: 10 }),
    });
    globalThis.document.elementFromPoint = () => target;
    fireDocEvent('click', makeEvent({ type: 'click', clientX: 1, clientY: 1 }));
  } finally {
    globalThis.document.createElement = realCreate;
  }
  return control;
}

test('PK2a: an ad image offers a domain-scoped path network candidate', () => {
  docState.byLevel = new Map();
  docState.all = [];
  const img = tagged('IMG', { src: 'https://cdn.ads.example/a/banner.png?bust=1' }, { classList: ['banner'] });

  const network = generateNetworkCandidates(img);
  // The query is dropped: a cache-busting parameter must not escape the block.
  assert.deepEqual(rulesOf(network), [
    '||cdn.ads.example/a/banner.png^$image,domain=example.test',
    '||cdn.ads.example^$image,domain=example.test',
  ]);
  const [path, host] = network;
  assert.equal(path.kind, 'network');
  assert.equal(path.scope, 'path');
  assert.equal(host.scope, 'host');
  // Each label states the block's real reach.
  assert.equal(path.label, 'Block request (image)');
  assert.equal(host.label, 'Block host (image)');
  assert.equal(path.domain, 'example.test');
  assert.equal(path.count, 1);
  // The cosmetic stand-in that hides the element until a reload applies it.
  assert.equal(path.previewSelector, '.banner');
});

test('PK2a: a metacharacter in the path truncates to the longest safe prefix (not host-only)', () => {
  // `$` would open an option list; `*` and `|` are pattern syntax. The cut
  // keeps the prefix before the first one, strictly narrower than the host.
  for (const path of ['/a$script/x.png', '/a*b/x.png', '/a|b/x.png']) {
    const [candidate] = generateNetworkCandidates(tagged('IMG', { src: `https://cdn.ads.example${path}` }));
    assert.equal(candidate?.rule, '||cdn.ads.example/a$image,domain=example.test', path);
    assert.equal(candidate.scope, 'prefix', path);
    assert.equal(candidate.label, 'Block path prefix (image)', path);
    assert.ok(!candidate.rule.includes('script'), path);
  }
  // A prefix of just `/` is the whole host: offered once, as the host.
  assert.deepEqual(generateNetworkCandidates(tagged('IMG', { src: 'https://cdn.ads.example/$x/y.png' }))
    .map((c) => [c.rule, c.scope]), [['||cdn.ads.example^$image,domain=example.test', 'host']]);
});

test('PK2a: a path character the gate refuses truncates even where the URL parser keeps it', () => {
  // Node's URL percent-encodes `^ { } \`` in a path, a browser's parser has
  // not always: whatever survives literally, only the gate's class is emitted.
  const RealURL = globalThis.URL;
  globalThis.URL = class extends RealURL {
    get pathname() { return super.pathname.replace(/%(?:5E|7B|7D|60)/gi, decodeURIComponent); }
  };
  try {
    assert.equal(new URL('https://h.example/a{b').pathname, '/a{b'); // the premise
    for (const ch of ['^', '{', '}', '`']) {
      const [candidate] = generateNetworkCandidates(tagged('IMG', { src: `https://cdn.ads.example/a${ch}b/x.png` }));
      assert.equal(candidate?.rule, '||cdn.ads.example/a$image,domain=example.test', ch);
    }
  } finally {
    globalThis.URL = RealURL;
  }
});

test('PK2a: a hostile host rejects the candidate', () => {
  // WHATWG keeps `$ , =` in a hostname, so this whole string is the HOST.
  const img = tagged('IMG', { src: 'https://x$important,domain=bank.example/p.png' });
  assert.deepEqual(generateNetworkCandidates(img), []);
});

test('PK2a: a wildcard host is rejected', () => {
  assert.deepEqual(generateNetworkCandidates(tagged('IMG', { src: 'https://*/x.png' })), []);
});

test('PK2a: a data: URL yields no network candidate', () => {
  for (const src of ['data:image/png;base64,AAAA', 'blob:https://ads.example/1']) {
    assert.deepEqual(generateNetworkCandidates(tagged('IMG', { src })), [], src);
  }
});

test('PK2a: an iframe offers a subdocument network candidate', () => {
  const frame = tagged('IFRAME', { src: 'https://ads.example/f.html' });
  assert.equal(generateNetworkCandidates(frame)[0]?.rule, '||ads.example/f.html^$subdocument,domain=example.test');
});

test('PK2a: each element kind maps to the request it makes, with that request\'s type', () => {
  docState.byLevel = new Map();
  docState.all = [];
  const baseURI = globalThis.document.baseURI;
  globalThis.document.baseURI = 'https://example.test/articles/';
  try {
    const cases = [
      [tagged('IMG', { src: 'https://ads.example/stale.png' }, { currentSrc: 'https://ads.example/live.png' }),
        '||ads.example/live.png^$image'],
      [tagged('IMG', { srcset: 'https://ads.example/a.png 1x, https://ads.example/b.png 2x' }),
        '||ads.example/a.png^$image'],
      // No descriptor: the list's comma is not part of the URL.
      [tagged('IMG', { srcset: 'https://ads.example/c.png, https://ads.example/d.png 2x' }),
        '||ads.example/c.png^$image'],
      [tagged('image', { href: 'https://ads.example/svg.png' }), '||ads.example/svg.png^$image'],
      [tagged('image', { 'xlink:href': 'https://ads.example/svg2.png' }), '||ads.example/svg2.png^$image'],
      [tagged('VIDEO', {}, { currentSrc: 'https://ads.example/v.mp4' }), '||ads.example/v.mp4^$media'],
      [tagged('VIDEO', { src: 'https://ads.example/v2.mp4' }), '||ads.example/v2.mp4^$media'],
      // A stream's blob: is no request; the poster is, and it is an image.
      [tagged('VIDEO', { poster: 'https://ads.example/poster.jpg' }, { currentSrc: 'blob:https://ads.example/1' }),
        '||ads.example/poster.jpg^$image'],
      [tagged('AUDIO', {}, { currentSrc: 'https://ads.example/a.mp3' }), '||ads.example/a.mp3^$media'],
      [tagged('AUDIO', { src: 'https://ads.example/a2.mp3' }), '||ads.example/a2.mp3^$media'],
      [tagged('SOURCE', { src: 'https://ads.example/s.mp4' }), '||ads.example/s.mp4^$media'],
      [tagged('EMBED', { src: 'https://ads.example/x.swf' }), '||ads.example/x.swf^$object'],
      [tagged('OBJECT', { data: 'https://ads.example/o.swf' }), '||ads.example/o.swf^$object'],
      [tagged('FRAME', { src: 'https://ads.example/fr.html' }), '||ads.example/fr.html^$subdocument'],
      // Relative to the document's base URL, as the browser resolves it.
      [tagged('IFRAME', { src: 'ads/f.html' }), '||example.test/articles/ads/f.html^$subdocument'],
      [el({ style: { backgroundImage: 'url("https://ads.example/bg.png")' } }), '||ads.example/bg.png^$image'],
      [el({ style: { backgroundImage: "none, url('https://ads.example/bg2.png')" } }), '||ads.example/bg2.png^$image'],
      // Serialized with `"` escaped: the escape is undone, not read as a path.
      [el({ style: { backgroundImage: 'url("https://ads.example/b\\"g.png")' } }), '||ads.example/b%22g.png^$image'],
    ];
    for (const [target, expected] of cases) {
      assert.equal(generateNetworkCandidates(target)[0]?.rule, `${expected},domain=example.test`, expected);
    }

    // No inline image: the computed style's, where the browser provides one.
    globalThis.getComputedStyle = () => ({ backgroundImage: 'url(https://ads.example/computed.png)' });
    assert.equal(generateNetworkCandidates(el())[0]?.rule, '||ads.example/computed.png^$image,domain=example.test');
  } finally {
    globalThis.document.baseURI = baseURI;
    delete globalThis.getComputedStyle;
  }
});

test('PK2a: a resource on a non-default port is blocked by host, never by a path that cannot match', () => {
  // `||ads.example/x.png^` never matches `ads.example:8443/x.png`; the gate
  // admits no port, and `^` in `||ads.example^` matches the `:`.
  assert.deepEqual(rulesOf(generateNetworkCandidates(tagged('IMG', { src: 'https://ads.example:8443/x.png' }))),
    ['||ads.example^$image,domain=example.test']);
  // The default port is no port.
  assert.equal(generateNetworkCandidates(tagged('IMG', { src: 'https://ads.example:443/x.png' }))[0]?.rule,
    '||ads.example/x.png^$image,domain=example.test');
});

test('PK2a: a public-suffix resource host yields no network candidate', () => {
  for (const src of ['https://co.uk/banner.png', 'https://github.io/ad.png']) {
    assert.deepEqual(generateNetworkCandidates(tagged('IMG', { src })), [], src);
  }
});

test('PK2a: a picked site that is itself a public suffix gets no network candidate', () => {
  onSite('github.io', () => {
    assert.deepEqual(generateNetworkCandidates(tagged('IMG', { src: 'https://cdn.ads.example/a.png' })), []);
  });
});

test('PK2a: urlToNetworkPattern emits nothing the gate would refuse, whatever it is handed', () => {
  const url = 'https://cdn.ads.example/a.png';
  assert.equal(urlToNetworkPattern(url, { type: 'image', domain: 'example.test' }),
    '||cdn.ads.example/a.png^$image,domain=example.test');
  // `domain=` is exactly one plain, registrable hostname: no list, negation,
  // upper case, trailing dot or suffix.
  for (const domain of ['co.uk', 'a.example|b.example', '~a.example', 'a.example,b.example', 'Example.test', 'a.example.']) {
    assert.equal(urlToNetworkPattern(url, { type: 'image', domain }), null, domain);
  }
  // The type comes from a closed set, never from page text.
  for (const type of ['important', 'image,domain=bank.example', 'IMAGE', undefined]) {
    assert.equal(urlToNetworkPattern(url, { type, domain: 'example.test' }), null, String(type));
  }
  // Only a web request: another scheme's host would still anchor `||host`.
  for (const other of ['ftp://ads.example/x.png', 'ws://ads.example/x', 'chrome-extension://abcdef/x.png']) {
    assert.equal(urlToNetworkPattern(other, { type: 'image', domain: 'example.test' }), null, other);
  }
  // PK2c: a scope whose last label is a number must be a whole IPv4 address,
  // as SW1 requires: `domain=1` would reach every x.x.x.1 host.
  for (const domain of ['1', 'a.1', '0x1f', '999.1.1.1']) {
    assert.equal(urlToNetworkPattern(url, { type: 'image', domain }), null, domain);
  }
  assert.equal(urlToNetworkPattern(url, { type: 'image', domain: '192.168.1.1' }),
    '||cdn.ads.example/a.png^$image,domain=192.168.1.1');
});

test('PK2a: with no plain site to scope to, no network candidate is offered', () => {
  // An unscoped block of a shared CDN path would reach every site.
  for (const site of ['', '[::1]']) {
    onSite(site, () => {
      assert.deepEqual(generateNetworkCandidates(tagged('IMG', { src: 'https://cdn.ads.example/a.png' })), [], site);
    });
  }
});

test('PK2a: on www.ck the cosmetic scope is www.ck, never the suffix ck', () => {
  resetPickerEnv();
  const target = tagged('IMG', { src: 'https://cdn.ads.example/a.png' }, { classList: ['ad-slot'] });
  docState.byLevel = new Map([['.ad-slot', [target]]]);
  try {
    onSite('www.ck', () => {
      // `ck` is a suffix (`*.ck`) and `www.ck` the list's exception back out
      // of it: a `ck##` hide would reach every .ck site.
      for (const c of generateSelectors(target)) assert.equal(c.domain, 'www.ck', c.selector);

      const control = openDialogFor(target);
      assert.equal(control('#adblock-rule-preview').textContent, 'www.ck##.ad-slot');
      const sent = [];
      globalThis.chrome = { runtime: { sendMessage: (msg) => { sent.push(msg); return new Promise(() => {}); } } };
      control('#adblock-picker-custom').value = '.ad-slot';
      control('#adblock-picker-create').listeners.get('click')();
      assert.deepEqual(sent.map((m) => m.payload.line), ['www.ck##.ad-slot']);
    });
  } finally {
    resetPickerEnv();
  }
});

test('PK2a: on www.ck a network candidate is scoped domain=www.ck', () => {
  onSite('www.ck', () => {
    const network = generateNetworkCandidates(tagged('IMG', { src: 'https://cdn.ads.example/a.png' }));
    assert.deepEqual(rulesOf(network), [
      '||cdn.ads.example/a.png^$image,domain=www.ck',
      '||cdn.ads.example^$image,domain=www.ck',
    ]);
  });
});

test('PK2a (didn\'t re-break): on www.example.com the scope is still example.com', () => {
  resetPickerEnv();
  const target = tagged('IMG', { src: 'https://cdn.ads.example/a.png' }, { classList: ['ad-slot'] });
  docState.byLevel = new Map([['.ad-slot', [target]]]);
  try {
    onSite('www.example.com', () => {
      for (const c of generateSelectors(target)) assert.equal(c.domain, 'example.com', c.selector);
      assert.equal(openDialogFor(target)('#adblock-rule-preview').textContent, 'example.com##.ad-slot');
      assert.equal(generateNetworkCandidates(target)[0]?.rule, '||cdn.ads.example/a.png^$image,domain=example.com');
    });
  } finally {
    resetPickerEnv();
  }
});

test('PK2a (Rec2): a real CSS.escape over hostile page text emits only gate-shaped lines', () => {
  const identity = globalThis.CSS.escape;
  globalThis.CSS.escape = cssEscape;
  try {
    docState.byLevel = new Map();
    docState.all = [];
    const target = tagged('IMG', {
      src: 'https://cdn.ads.example/a$important,domain=bank.example/x.png',
      'data-ad': 'a"]',
      'aria-label': 'x#@#y',
    }, {
      id: 'ad##x',
      // Single-class candidates come from the first four classes only.
      classList: ['x#@#y', '$image,domain=bank', 'ad{x', 'clean'],
      textContent: '$image,domain=bank',
    });
    const cosmetic = generateSelectors(target);
    const network = generateNetworkCandidates(target, cosmetic);

    assert.ok(cosmetic.some((c) => c.selector === '.clean'), 'cosmetic candidates still offered');
    for (const { selector } of cosmetic) {
      const line = `example.test##${selector}`;
      // `##` stays the line's only marker: `#@#`, `#?#`, `#$#`, `#%#` or
      // `#+js(` anywhere re-routes the line in the compiler.
      assert.equal(line.split('##').length, 2, line);
      assert.doesNotMatch(line, /#[@?$%+]/, line);
      assert.doesNotMatch(selector, /[{};]/, line);
    }
    // The page's `$important,domain=bank.example` never becomes options.
    assert.deepEqual(rulesOf(network), [
      '||cdn.ads.example/a$image,domain=example.test',
      '||cdn.ads.example^$image,domain=example.test',
    ]);
    for (const { rule } of network) assert.match(rule, PICKER_NETWORK_LINE, rule);
  } finally {
    globalThis.CSS.escape = identity;
  }
});

// Invisible characters spelled out, so a failure names the case.
const printable = (s) => s.replace(/[^\x20-\x7e]/g, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
const NEL = String.fromCharCode(0x85); // Rust's trim strips it; JS `trim()` keeps it

test('PK2a (didn\'t re-break): the compiler mirror still refuses NUL and blank selectors on its own', () => {
  // Pinned directly, not only through a save: a stricter check put in front
  // of it would hide these rules from every save-level test.
  for (const selector of [`.a${String.fromCharCode(0)}b`, NEL, ' ']) {
    assert.equal(compilerKeepsSelector(selector), false, printable(selector));
  }
  for (const selector of ['.a', `${NEL}.a${NEL}`, 'div:has-text(a;b)']) {
    assert.equal(compilerKeepsSelector(selector), true, printable(selector));
  }
});

test('PK2a (didn\'t re-break): a plain div offers cosmetic candidates and no network candidate', () => {
  docState.byLevel = new Map();
  docState.all = [];
  const div = el({ tagName: 'DIV', classList: ['ad-slot'] });
  const cosmetic = generateSelectors(div);
  assert.ok(cosmetic.some((c) => c.selector === '.ad-slot'), 'the class candidate is still offered');
  assert.ok(cosmetic.every((c) => c.kind === 'cosmetic'));
  assert.deepEqual(generateNetworkCandidates(div), []);
});

// PICKER-2026-09 PK4 — stronger CSS candidates. A class a build hashed is
// de-ranked, never dropped; an ancestor path pins a structurally anonymous
// element with `:nth-of-type`, and that path ranks below every candidate that
// matches without one.

/**
 * Does `node` match `sel`, for the shapes `simpleSelector` emits (`#id`,
 * `tag`, `tag.a.b`)? Enough of `Element.matches` for the sibling test.
 */
function matchesSimple(node, sel) {
  const m = /^([a-z][a-z0-9-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)$/i.exec(sel);
  if (!m) return false;
  const [, tag, id, classes] = m;
  if (tag && tag.toLowerCase() !== node.tagName.toLowerCase()) return false;
  if (id && id !== node.id) return false;
  return classes.split('.').filter(Boolean).every((c) => node.classList.includes(c));
}

/** An element stub wired into a tree: `children`, `parentElement`, `matches`. */
function tree(tagName, props = {}, kids = []) {
  const node = el({ tagName, children: kids, ...props });
  node.matches = (sel) => matchesSimple(node, sel);
  for (const kid of kids) kid.parentElement = node;
  return node;
}

test('PK4: the ancestor path disambiguates colliding siblings with :nth-of-type', () => {
  docState.byLevel = new Map();
  docState.all = [];
  const link = tree('A');
  // The link's item is the third child but the second `li`: position is
  // counted among same-tag siblings, as `:nth-of-type` counts it.
  tree('UL', { classList: ['list'] }, [tree('SPAN'), tree('LI'), tree('LI', {}, [link]), tree('LI')]);

  const offered = generateSelectors(link).map((c) => c.selector);
  // Only the step that collides is pinned: `a` and `ul.list` are unique.
  assert.ok(offered.includes('ul.list > li:nth-of-type(2) > a'), offered.join(' | '));
});

test('PK4: a step is pinned only when its own selector matches a sibling', () => {
  docState.byLevel = new Map();
  docState.all = [];
  const link = tree('A');
  // A sibling of the same tag but other classes does not match `li.ad`.
  tree('UL', {}, [tree('LI', { classList: ['news'] }), tree('LI', { classList: ['ad'] }, [link])]);

  const offered = generateSelectors(link).map((c) => c.selector);
  assert.ok(offered.includes('ul > li.ad > a'), offered.join(' | '));
  assert.ok(offered.every((s) => !s.includes(':nth-of-type(')), offered.join(' | '));
});

test('PK4: a colliding id step is pinned with its tag written out', () => {
  docState.byLevel = new Map();
  docState.all = [];
  // A duplicate id: the position must be read among `div`s, not every type.
  const target = tree('DIV', { id: 'dup' });
  tree('SECTION', { classList: ['box'] }, [tree('P'), tree('DIV', { id: 'dup' }), target]);

  const offered = generateSelectors(target).map((c) => c.selector);
  assert.ok(offered.includes('section.box > div#dup:nth-of-type(2)'), offered.join(' | '));
});

test('PK4: looksHashed matches every hashed class and no plain class', () => {
  // The plan's eight, every one: the first draft's regex failed its own example.
  for (const name of ['css-1x2y3z', 'jsx-2947163892', 'grid-12ab34']) {
    assert.equal(looksHashed(name), true, name);
  }
  for (const name of ['col-md-6', 'ad-slot-300x250', 'sr-only', 'h1', 'MuiBox-root']) {
    assert.equal(looksHashed(name), false, name);
  }
  // None of those five turns on the two-digit rule, so its edges are pinned
  // here: six characters with two digits is hashed; five characters, one
  // digit or none is not.
  assert.equal(looksHashed('css-1a2bcd'), true);
  for (const name of ['css-1x2y3', 'nav-sidebar1', 'ad-banner']) {
    assert.equal(looksHashed(name), false, name);
  }
  // And its shape: a letters-only prefix, one hyphen, nothing after the run
  // (emotion's labelled `css-1x2y3z-Button` is not a bare hash).
  for (const name of ['h2-a1b2c3', 'css-1x2y3z-Button']) {
    assert.equal(looksHashed(name), false, name);
  }
});

test('PK4: a hashed-looking class is ranked below a stable class of equal count', () => {
  const target = el({ classList: ['css-1x2y3z', 'ad-banner'] });
  docState.byLevel = new Map([['.css-1x2y3z', [target]], ['.ad-banner', [target]]]);
  docState.all = [];

  const offered = generateSelectors(target).map((c) => c.selector);
  // Prior code kept insertion order on a tie: the hashed class came first.
  assert.ok(offered.indexOf('.ad-banner') < offered.indexOf('.css-1x2y3z'), offered.join(' | '));
  assert.ok(selectorScore({ selector: '.ad-banner', count: 1 }) > selectorScore({ selector: '.css-1x2y3z', count: 1 }));
});

test('PK4: only a candidate held by hashed classes alone is de-ranked', () => {
  const score = (selector) => selectorScore({ selector, count: 1 });
  // Something steadier is present: a stable class, an id, or an escape that
  // shows the name is not a bare hash.
  assert.equal(score('.ad-banner.css-1x2y3z'), score('.ad-banner.stable'));
  assert.equal(score('#main > div.css-1x2y3z'), score('#main > div.stable'));
  assert.equal(score('.css-1x2y3z\\:hover'), score('.stable\\:hover'));
  // Hashed classes alone, with or without a tag.
  assert.ok(score('div.css-1x2y3z') < score('div.stable'));
  assert.ok(score('.css-1x2y3z.jsx-2947163892') < score('.stable.other'));
  // No class at all is not "only hashed classes".
  assert.ok(score('li > a') > score('li > a.css-1x2y3z'));
});

test('PK4 (didn\'t re-break): a hashed class is de-ranked, never dropped', () => {
  // It may be all an element has.
  const target = el({ classList: ['css-1x2y3z'] });
  docState.byLevel = new Map([['.css-1x2y3z', [target]]]);
  docState.all = [];
  const offered = generateSelectors(target).map((c) => c.selector);
  assert.ok(offered.includes('.css-1x2y3z') && offered.includes('div.css-1x2y3z'), offered.join(' | '));
});

test('PK4: a positional path ranks below every candidate that matches without one', () => {
  const link = tree('A', { id: 'ad' });
  tree('UL', { classList: ['list'] }, [tree('LI'), tree('LI', {}, [link])]);
  const path = 'ul.list > li:nth-of-type(2) > #ad';
  docState.byLevel = new Map([
    ['#ad', [link]],
    ['[id*="ad"]', [link]],
    ['li > #ad', Array.from({ length: 60 }, () => link)], // broad, but no positional step
    [path, [link]],
  ]);
  docState.all = [];

  const candidates = generateSelectors(link);
  assert.equal(candidates[0].selector, '#ad', 'a clean id still ranks first');
  const at = candidates.findIndex((c) => c.selector === path);
  assert.ok(at > -1, candidates.map((c) => c.selector).join(' | '));
  // Above it: every candidate that matches something without a positional
  // step, even the one matching 60 elements. Below it: only what matches nothing.
  for (const c of candidates.slice(0, at)) assert.ok(c.count > 0, c.selector);
  for (const c of candidates.slice(at + 1)) assert.equal(c.count, 0, c.selector);
  assert.ok(candidates.slice(at + 1).length > 0, 'a candidate matching nothing still ranks lowest');
});

test('PK4 (didn\'t re-break): a clean id still scores highest, and the count bands still decide', () => {
  const target = el({ id: 'ad', classList: ['ad-banner'] });
  docState.byLevel = new Map([['#ad', [target]], ['.ad-banner', [target]]]);
  docState.all = [];
  assert.equal(generateSelectors(target)[0].selector, '#ad');
  assert.ok(selectorScore({ selector: '#ad', count: 1 }) > selectorScore({ selector: '.ad-banner', count: 1 }));

  const band = (count) => selectorScore({ selector: '.ad-banner', count });
  assert.ok(band(2) > band(5) && band(5) > band(20) && band(20) > band(60) && band(60) > band(0));
  // The hashed penalty is less than a band: a precise hashed class still
  // beats a broader stable one.
  assert.ok(selectorScore({ selector: '.css-1x2y3z', count: 2 }) > selectorScore({ selector: '.ad-banner', count: 5 }));
});

// Candidates take only an element's first few classes (four singles, three
// with the tag, three combined; two for a shadow host or a path step). Taken
// in page order, a stable class behind hashed ones was never offered — on
// exactly the sites PK4 is for.

test('PK4: a stable class behind four hashed ones is still offered', () => {
  docState.byLevel = new Map();
  docState.all = [];
  const target = el({ classList: ['css-a1b2c3', 'css-d4e5f6', 'css-g7h8i9', 'css-j0k1l2', 'ad-banner'] });
  const offered = generateSelectors(target).map((c) => c.selector);
  // One per slice: single class, tag + class, all classes combined.
  for (const selector of ['.ad-banner', 'div.ad-banner', '.ad-banner.css-a1b2c3.css-d4e5f6']) {
    assert.ok(offered.includes(selector), `${selector} not in ${offered.join(' | ')}`);
  }
  assert.ok(offered.includes('.css-a1b2c3'), 'the hashed classes are still offered');
});

test('PK4: a shadow host with hashed classes first still offers its stable class', () => {
  docState.byLevel = new Map();
  docState.all = [];
  const host = el({ tagName: 'ASIDE', classList: ['css-a1b2c3', 'css-d4e5f6', 'promo'] });
  const inner = el({ tagName: 'SPAN', getRootNode: () => new FakeShadowRoot(host) });
  const offered = generateSelectors(inner).map((c) => c.selector);
  assert.ok(offered.includes('.promo'), offered.join(' | '));
});

test('PK4: a path step prefers a stable class to hashed ones', () => {
  docState.byLevel = new Map();
  docState.all = [];
  const link = tree('A');
  tree('UL', {}, [tree('LI', { classList: ['css-a1b2c3', 'css-d4e5f6', 'item'] }, [link])]);
  const offered = generateSelectors(link).map((c) => c.selector);
  assert.ok(offered.includes('li.item.css-a1b2c3 > a'), offered.join(' | '));
});

test('PK4 (didn\'t re-break): classes that all look stable keep their page order', () => {
  docState.byLevel = new Map();
  docState.all = [];
  const offered = generateSelectors(el({ classList: ['b', 'a', 'c'] })).map((c) => c.selector);
  assert.deepEqual(offered.filter((s) => /^\.[abc]$/.test(s)), ['.b', '.a', '.c']);
  assert.ok(offered.includes('.b.a.c'), offered.join(' | '));
});

test('PK4: moving stable classes ahead keeps each group in page order', () => {
  docState.byLevel = new Map();
  docState.all = [];
  // Neither group is in alphabetical order, so a sort that reorders within a
  // group, not just between them, shows here.
  const offered = generateSelectors(el({ classList: ['css-g7h8i9', 'q', 'css-a1b2c3', 'p'] })).map((c) => c.selector);
  assert.ok(offered.includes('.q.p.css-g7h8i9'), offered.join(' | '));
});

// PICKER-2026-09 PK2c — the picker offers only lines SW1's gate admits, and
// what it previews is what the gate stores. The gate reads the line both trims
// agree on and stores it trimmed; `CSS.escape` leaves U+0080 and up raw, so a
// page's names can put a character a trim strips at the line's end. (Every
// emitted line is also fed through the real gate by
// tests/picker-gate-crosscheck.test.mjs.)

const NBSP = String.fromCharCode(0xa0); // both trims strip it
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000); // both trims strip it
const LS = String.fromCharCode(0x2028); // a line separator: both trims strip it
const PS = String.fromCharCode(0x2029); // a paragraph separator
const C1 = String.fromCharCode(0x81); // a C1 control that is no whitespace
const LONE = String.fromCharCode(0xd800); // a lone surrogate
const BOM = String.fromCharCode(0xfeff); // JS `trim()` strips it, Rust's keeps it

/** An escaped CSS identifier read back the way the tokenizer reads it. */
const unescapeIdent = (text) => text.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\n\r\f]?|([^\n\r\f]))/g,
  (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));

/** The selector the gate stores for `site##selector`: the line, trimmed. */
const storedSelector = (selector) => `example.test##${selector}`.trim().slice('example.test##'.length);

test('PK2c: a name ending in a character a trim strips is stored as that exact name', () => {
  const identity = globalThis.CSS.escape;
  globalThis.CSS.escape = cssEscape;
  try {
    docState.byLevel = new Map();
    docState.all = [];
    // Prior code offered `.ad` + U+00A0, and the gate stored `.ad`: a broader
    // rule than the one previewed.
    for (const tail of [NBSP, IDEOGRAPHIC_SPACE, LS]) {
      const cls = `ad${tail}`;
      const single = generateSelectors(el({ classList: [cls] })).map((c) => c.selector).find((s) => s.startsWith('.'));
      assert.ok(single, printable(cls));
      assert.equal(unescapeIdent(storedSelector(single).slice(1)), cls, printable(single));
    }
    // An id may end in a plain space, which CSS.escape writes as `\ `.
    const byId = generateSelectors(el({ id: 'ad ' })).map((c) => c.selector).find((s) => s.startsWith('#'));
    assert.equal(unescapeIdent(storedSelector(byId).slice(1)), 'ad ', printable(byId));
    // And the last step of an ancestor path.
    const link = tree('A', { classList: [`ad${NBSP}`] });
    tree('UL', { classList: ['list'] }, [tree('LI', {}, [link])]);
    const path = generateSelectors(link).map((c) => c.selector).find((s) => s.startsWith('ul.list > li > a.'));
    assert.ok(path, 'the ancestor path is offered');
    assert.equal(unescapeIdent(storedSelector(path).split('a.').pop()), `ad${NBSP}`, printable(path));

    // Every candidate, from every builder (single class, tag + class, all
    // classes, id, tag + id, path steps, a shadow host's id and class), loses
    // nothing to the trim but a hex escape's closing space.
    const host = el({ tagName: 'ASIDE', id: `w${IDEOGRAPHIC_SPACE}`, classList: [`p${NBSP}`] });
    const item = tree('LI', { id: `ad${NBSP}` }); // "Parent > Element" ends in its id
    tree('UL', {}, [item]);
    for (const target of [
      el({ id: `ad${NBSP}`, classList: [`a${LS}`, `b${NBSP}`, `c${IDEOGRAPHIC_SPACE}`] }),
      el({ tagName: 'SPAN', getRootNode: () => new FakeShadowRoot(host) }),
      link,
      item,
    ]) {
      for (const { selector } of generateSelectors(target)) {
        const line = `example.test##${selector}`;
        const stored = line.trim();
        assert.ok(stored === line || (line === `${stored} ` && /\\[0-9a-f]{1,6}$/i.test(stored)), printable(line));
      }
    }
  } finally {
    globalThis.CSS.escape = identity;
  }
});

test('PK2c: where the two trims part, a name\'s last character is escaped rather than refused', () => {
  const identity = globalThis.CSS.escape;
  globalThis.CSS.escape = cssEscape;
  try {
    docState.byLevel = new Map();
    docState.all = [];
    // A raw U+0085 or U+FEFF at the end is a line the gate refuses: JS and
    // Rust would store different lines. Hex-escaped, it is plain text. The
    // whole trailing run is escaped: an unescaped U+0085 left inside it would
    // still be a control the gate refuses anywhere.
    for (const tail of [NEL, BOM, `${NEL}${NBSP}`]) {
      const cls = `ad${tail}`;
      const single = generateSelectors(el({ classList: [cls] })).map((c) => c.selector).find((s) => s.startsWith('.'));
      assert.ok(single, `${printable(cls)} is offered`);
      assert.ok(!single.includes(tail), printable(single));
      assert.equal(unescapeIdent(storedSelector(single).slice(1)), cls, printable(single));
    }
  } finally {
    globalThis.CSS.escape = identity;
  }
});

test('PK2c: a candidate carrying a control, separator or lone surrogate is not offered', () => {
  const identity = globalThis.CSS.escape;
  globalThis.CSS.escape = cssEscape;
  try {
    docState.byLevel = new Map();
    docState.all = [];
    // Not at the end, so not a trim's to strip: the gate refuses the line.
    const offered = generateSelectors(el({ classList: [`ad${NEL}x`, `ad${LS}y`, `ad${LONE}z`, 'clean'] }))
      .map((c) => c.selector);
    assert.ok(offered.includes('.clean'), offered.map(printable).join(' | '));
    for (const selector of offered) {
      assert.doesNotMatch(selector, /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u, printable(selector));
    }
  } finally {
    globalThis.CSS.escape = identity;
  }
});

test('PK2c: a custom selector the gate would refuse is refused, and nothing is sent', async () => {
  const sent = [];
  globalThis.chrome = {
    runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ ok: true }); } },
  };
  docState.byLevel = new Map();
  docState.all = [];

  await withBrowserParser(async () => {
    // Each parses and survives the compiler mirror; only the gate refuses it.
    for (const selector of [
      `.a${NEL}b`, `.a${C1}b`, `.a${LS}b`, `.a${PS}b`, `.a${LONE}b`, // anywhere in the line
      `.ad${NEL}`, `.ad${BOM}`, // at the end, where the two trims part
      '.a\\', '.a\\\\\\', // an odd run of backslashes: the last escapes what the trim removed
      'div:has-text(a#@b)', // an extended-syntax marker, which would re-route the line
      '+js(set-constant, a, b)', // ... and one made with the `##` in front: `##+js(`
    ]) {
      const dialog = makeDialog();
      await savePickerRule(`example.test##${selector}`, selector, 'example.test', dialog);
      assert.match(dialog.footerText(), /can.t be saved/, printable(selector));
    }
  });
  assert.deepEqual(sent, []);
});

test('PK2c (didn\'t re-break): a hex escape\'s closing space is admitted, as the gate admits it', async () => {
  const identity = globalThis.CSS.escape;
  globalThis.CSS.escape = cssEscape;
  try {
    docState.byLevel = new Map();
    docState.all = [];
    // `<li id="7">`: SW1's first draft refused `li#\37 `, which HEAD stored as `li#7`.
    const offered = generateSelectors(el({ tagName: 'LI', id: '7' })).map((c) => c.selector);
    assert.ok(offered.includes('li#\\37 '), offered.map(printable).join(' | '));

    const sent = [];
    globalThis.chrome = {
      runtime: { sendMessage: (msg) => { sent.push(msg); return Promise.resolve({ error: 'stop' }); } },
    };
    for (const selector of ['li#\\37 ', '.a\\\\']) { // an even run of backslashes is two escaped ones
      await savePickerRule(`example.test##${selector}`, selector, 'example.test', makeDialog());
    }
    assert.deepEqual(sent.map((m) => m.payload.line), ['example.test##li#\\37 ', 'example.test##.a\\\\']);
  } finally {
    globalThis.CSS.escape = identity;
  }
});

// §4.24 — ACTIVATE_PICKER is broadcast to every frame; a page with 15 iframes
// got 16 pickers, and ESC (which does not cross frame boundaries) could only
// dismiss the focused one.

test('the picker refuses to mount in a subframe (§4.24)', () => {
  resetPickerEnv();
  globalThis.window.top = { differentFrame: true };

  activatePicker();
  // Prior code mounted a full-viewport overlay in every ad frame and embed.
  assert.equal(mountedById.size, 0, 'nothing mounted in the subframe');
  assert.equal(docListeners.size, 0, 'no capture handlers installed');

  resetPickerEnv();
});

test('an explicitly targeted subframe activation is still honoured (§4.24)', () => {
  resetPickerEnv();
  globalThis.window.top = { differentFrame: true };

  activatePicker({ allowInFrame: true });
  assert.ok(mountedById.size > 0, 'overlay mounted when explicitly targeted');

  resetPickerEnv();
});

test('DEACTIVATE_PICKER tears the picker down completely (§4.24)', () => {
  resetPickerEnv();
  activatePicker();
  assert.ok(mountedById.size > 0);
  assert.ok(docListeners.get('keydown')?.size > 0);

  deactivatePicker();
  assert.equal(mountedById.size, 0, 'overlay, highlight, dialog and styles removed');
  for (const [type, fns] of docListeners) {
    assert.equal(fns.size, 0, `no ${type} listener left behind`);
  }

  resetPickerEnv();
});

// §5.17 — only Escape was intercepted and only `click` was suppressed, so
// typing a selector on YouTube fired the page's k/j/space/f shortcuts and
// every press after the first click reached the page's own handlers.

test('page-bound key events are swallowed while the picker is active (§5.17)', () => {
  resetPickerEnv();
  activatePicker();

  for (const type of ['keydown', 'keypress', 'keyup']) {
    const event = fireDocEvent(type, makeEvent({ type, key: 'k' }));
    assert.equal(event.defaultPrevented, true, `${type} prevented`);
    assert.equal(event.propagationStopped, true, `${type} stopped`);
  }

  resetPickerEnv();
});

test('keys aimed at the picker dialog are left alone so typing works (§5.17)', () => {
  resetPickerEnv();
  activatePicker();

  const inDialog = makeEvent({ type: 'keydown', key: 'a', target: { closest: () => ({}) } });
  fireDocEvent('keydown', inDialog);
  assert.equal(inDialog.defaultPrevented, false);
  assert.equal(inDialog.propagationStopped, false);

  resetPickerEnv();
});

test('Escape still cancels the picker (§5.17 didn\'t re-break)', () => {
  resetPickerEnv();
  activatePicker();
  assert.ok(mountedById.size > 0);

  fireDocEvent('keydown', makeEvent({ type: 'keydown', key: 'Escape' }));
  assert.equal(mountedById.has('__adblock_picker_overlay__'), false);

  resetPickerEnv();
});

test('mousedown and pointerdown are suppressed, not just click (§5.17)', () => {
  resetPickerEnv();
  activatePicker();

  for (const type of ['mousedown', 'pointerdown']) {
    const event = fireDocEvent(type, makeEvent({ type }));
    assert.equal(event.defaultPrevented, true, `${type} prevented`);
    assert.equal(event.propagationStopped, true, `${type} stopped`);
  }

  resetPickerEnv();
});

test('the overlay stays mounted once the dialog opens (§5.17)', () => {
  resetPickerEnv();
  const target = el({ tagName: 'DIV' });
  target.closest = () => null;
  target.getRootNode = () => globalThis.document;
  target.getBoundingClientRect = () => ({ top: 0, left: 0, width: 10, height: 10 });
  globalThis.document.elementFromPoint = () => target;
  activatePicker();

  fireDocEvent('click', makeEvent({ type: 'click', clientX: 5, clientY: 5 }));

  const overlay = mountedById.get('__adblock_picker_overlay__');
  // Prior code removed the overlay here, after which every press landed on
  // the page's own handlers.
  assert.ok(overlay, 'overlay still mounted');
  assert.equal(overlay.style.pointerEvents, 'none', 'but no longer eating dialog clicks');

  resetPickerEnv();
});
