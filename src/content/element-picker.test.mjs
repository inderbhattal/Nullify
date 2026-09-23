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

const { generateSelectors, isShadowOnlySelector, savePickerRule, activatePicker, deactivatePicker } =
  await import('./element-picker.js');

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
