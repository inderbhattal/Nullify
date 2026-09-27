/**
 * PICKER-2026-09 PK2c — the picker and SW1's APPEND gate must agree.
 *
 * The element picker builds every line it offers out of page text (class
 * names, ids, attribute values, resource URLs), and the service worker's
 * `isPickerSafeUserFilterLine` refuses anything outside the two shapes the
 * picker emits. The two are kept in step by hand, so this test feeds every
 * line the picker can produce, over a spread of sites, hostile and plain
 * URLs, element kinds and a seeded fuzz of names, through the committed gate
 * and asserts that none is refused. A widening on one side that is not
 * mirrored on the other fails here, not in a user's save.
 *
 * It also checks that what the picker previews is what the gate stores: the
 * gate stores a line trimmed, so a cosmetic line may differ from its trimmed
 * form only by the space that closes a trailing hex escape, which the escape
 * reads the same without.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadServiceWorker } from './sw-harness/sw-loader.mjs';

// The committed gate, taken from a worker loaded the way every SW test loads
// one; the predicate is pure, so the worker can be retired straight away.
const env = await loadServiceWorker({ awaitReady: true });
const gate = env.hooks.isPickerSafeUserFilterLine;
env.teardown();

/** CSSOM `CSS.escape` ("serialize an identifier"), as Chrome implements it. */
function cssEscape(value) {
  const s = String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) out += String.fromCharCode(0xfffd);
    else if ((c >= 0x1 && c <= 0x1f) || c === 0x7f || (i === 0 && c >= 0x30 && c <= 0x39) ||
      (i === 1 && c >= 0x30 && c <= 0x39 && s.charCodeAt(0) === 0x2d)) out += `\\${c.toString(16)} `;
    else if (i === 0 && c === 0x2d && s.length === 1) out += `\\${s[i]}`;
    else if (c >= 0x80 || c === 0x2d || c === 0x5f || /[0-9A-Za-z]/.test(s[i])) out += s[i];
    else out += `\\${s[i]}`;
  }
  return out;
}

// The picker reads these at call time only. The document never throws, so
// every candidate the picker builds reaches the gate, and every query matches
// the element being picked, so each candidate has something to count (a
// procedural `:upward()` is offered only off a base that matches).
let picking = null;
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: (sel) => (picking && sel !== '*' ? [picking] : []),
  getElementById: () => null,
  createElement: () => ({ style: {} }),
  documentElement: { appendChild() {} },
  baseURI: 'https://example.test/articles/',
};
globalThis.location = { hostname: 'example.test' };
globalThis.CSS = { escape: cssEscape };
globalThis.window = {};
globalThis.window.top = globalThis.window;

const { generateSelectors, generateNetworkCandidates, urlToNetworkPattern, candidateLine } =
  await import('../src/content/element-picker.js');

/** An element stub carrying what the picker reads. */
function element(tagName, attrs = {}, extra = {}) {
  return {
    tagName,
    id: '',
    classList: [],
    textContent: '',
    parentElement: null,
    children: [],
    style: {},
    getAttribute: (name) => attrs[name] ?? null,
    getRootNode() { return globalThis.document; },
    matches: () => false,
    ...extra,
  };
}

/** `el` as the second of three same-tag siblings its selector also matches. */
function amongTwins(el, parentExtra) {
  const twin = () => element(el.tagName, {}, { matches: () => true });
  const parent = element('SECTION', {}, parentExtra);
  parent.children = [twin(), el, twin()];
  for (const child of parent.children) child.parentElement = parent;
  return el;
}

const printable = (s) => s.replace(/[^\x20-\x7e]/g, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);

// A hex escape that is itself unescaped (an even run of backslashes before it).
const ENDS_IN_HEX_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\[0-9a-fA-F]{1,6}$/;

const SITES = ['example.test', 'www.ck', 'www.example.com', 'localhost', '192.168.1.1', 'www.github.io',
  'sub.shop.example.co.uk'];
const URLS = [
  'https://cdn.ads.example/a/banner.png?bust=1', 'https://cdn.ads.example/a$script/x.png',
  'https://x$important,domain=bank.example/p.png', 'https://*/x.png', 'https://ads.example:8443/x.png',
  'https://[::1]/x.png', 'https://ads.example./x.png', 'https://co.uk/b.png', 'https://ads.example/a^b|c*d/x.png',
  'https://ads.example/%24x.png', "https://ads.example/!&'()+,;=@[]~:/x.png", 'https://ADS.Example/X.PNG',
  'https://1.2.3.4/x.png', 'https://xn--bcher-kva.example/x.png', 'ads/rel.png', '/root.png',
  'https://ads.example/', 'https://ads.example/$', 'https://a..b/x.png', 'https://-a-.example/x.png',
  'data:image/png;base64,AAAA', 'blob:https://ads.example/1',
];
const KINDS = [['IMG', 'src'], ['IFRAME', 'src'], ['EMBED', 'src'], ['OBJECT', 'data'], ['VIDEO', 'poster'],
  ['AUDIO', 'src']];
// `domain=` values a caller might hand `urlToNetworkPattern`, gate-safe or not.
const DOMAINS = [undefined, 'example.test', '192.168.1.1', 'co.uk', '1', 'a.1', '0x1f', '999.1.1.1',
  'a.example|b.example', '~a.example', 'Example.test', 'a.example.'];

// Seeded, so a failure reproduces: printable ASCII plus the characters a page
// name can carry that the gate or the stored trim treat specially.
const SPECIALS = [0x09, 0x0b, 0x0c, 0x80, 0x85, 0x9f, 0xa0, 0x1680, 0x2000, 0x2028, 0x2029, 0x202f, 0x3000,
  0xfeff, 0xd800, 0xdc00, 0xe9].map((c) => String.fromCharCode(c));
const ALPHABET = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)), ...SPECIALS,
  ...SPECIALS, '\\', '\\', '"', "'"];
// mulberry32. Not a bare LCG taken `% n`: its low bits cycle in lockstep
// (`% 2` just alternates), so choices drawn in turn never combine freely.
let seed = 0x5eed;
const rand = (n) => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const randText = (max) => Array.from({ length: 1 + rand(max) }, () => ALPHABET[rand(ALPHABET.length)]).join('');
// A class token never holds ASCII whitespace: `classList` splits on it.
const randClass = () => randText(8).replace(/[\t\n\f\r ]/g, '') || 'x';
const HASHED = ['css-1x2y3z', 'jsx-2947163892', 'grid-12ab34'];

/** Every line the picker emits for this corpus, by kind. */
function emittedLines() {
  const cosmetic = [];
  const network = [];
  const pick = (el) => {
    picking = el;
    const candidates = generateSelectors(el);
    // Exactly what the dialog sends, with "Apply only to <site>" checked and not.
    for (const c of candidates) cosmetic.push(candidateLine(c, c.domain), candidateLine(c, null));
    for (const n of generateNetworkCandidates(el, candidates)) {
      for (const line of [candidateLine(n, n.domain), candidateLine(n, null)]) {
        assert.ok(line, `no line for ${n.rule}`);
        network.push(line);
      }
    }
  };

  for (const site of SITES) {
    globalThis.location.hostname = site;
    for (const url of URLS) {
      for (const [tag, attr] of KINDS) pick(element(tag, { [attr]: url }, { classList: ['ad-slot'] }));
      pick(element('DIV', {}, { style: { backgroundImage: `url("${url}")` } }));
      for (const scope of ['path', 'host']) {
        for (const type of ['image', 'subdocument', 'media', 'object']) {
          for (const domain of DOMAINS) {
            const line = urlToNetworkPattern(url, { scope, type, domain });
            if (line !== null) network.push(line);
          }
        }
      }
    }
  }

  globalThis.location.hostname = 'example.test';
  for (let k = 0; k < 1500; k++) {
    // Raw, as a page writes it: the picker's own URL parsing encodes it.
    const url = `https://${['cdn.ads.example', 'ads.example', '1.2.3.4'][rand(3)]}/${randText(10)}`;
    const classes = [randClass(), randClass(), rand(4) === 0 ? HASHED[rand(3)] : randClass()];
    // Text for `:has-text()`, and a child making an ad request for `:has()`.
    const kids = rand(2) === 0 ? [element('IMG', { src: url }, { classList: [randClass()] })] : [];
    const el = element(['IMG', 'IFRAME', 'OBJECT', 'DIV'][rand(4)], {
      src: url, data: url, 'data-ad': randText(6), 'aria-label': randText(6),
    }, {
      id: rand(3) === 0 ? randText(6) : '',
      classList: rand(3) === 0 ? [HASHED[rand(3)]] : classes,
      textContent: randText(24),
      children: kids,
    });
    for (const kid of kids) kid.parentElement = el;
    // Half in a tree whose siblings collide, so positional paths are emitted.
    pick(rand(2) === 0 ? el : amongTwins(el, { classList: [randClass()], id: rand(2) === 0 ? randText(4) : '' }));
  }
  return { cosmetic, network };
}

test('PK2c: the gate hook is the real one', () => {
  assert.equal(typeof gate, 'function');
  assert.equal(gate('example.test##.ad'), true);
  for (const line of ['example.test##body', '@@||bank.example^', '||x.example^$important', 'co.uk##.ad']) {
    assert.equal(gate(line), false, line);
  }
});

test('PK2c: SW1\'s gate admits every line the picker emits', () => {
  const { cosmetic, network } = emittedLines();

  // The corpus must actually reach every kind of line, or "none refused"
  // proves nothing.
  assert.ok(cosmetic.length > 10000, `cosmetic lines: ${cosmetic.length}`);
  assert.ok(network.length > 1000, `network lines: ${network.length}`);
  assert.ok(cosmetic.some((l) => l.includes(':nth-of-type(')), 'a positional path');
  assert.ok(cosmetic.some((l) => l.includes(':has-text(')), 'a :has-text() candidate');
  assert.ok(cosmetic.some((l) => l.includes(':has(> ')), 'a native :has() candidate');
  assert.ok(cosmetic.some((l) => l.endsWith(':upward(1)')), 'an :upward() candidate');
  assert.ok(cosmetic.some((l) => l !== l.trim()), 'a line ending in a hex escape\'s closing space');
  assert.ok(network.some((l) => !l.slice(0, l.indexOf('$')).endsWith('^')), 'a path-prefix block');
  assert.ok(network.some((l) => !l.includes('domain=')), 'an unscoped block');

  const refused = [...cosmetic, ...network].filter((line) => !gate(line));
  assert.deepEqual(refused.slice(0, 10).map(printable), [], `${refused.length} line(s) refused`);
});

test('PK2c: what the picker previews is what the gate stores', () => {
  const { cosmetic, network } = emittedLines();
  // The gate stores `line.trim()`. A cosmetic line may lose only the space
  // that closes a trailing hex escape; a network line nothing at all.
  const altered = cosmetic.filter((line) => {
    const stored = line.trim();
    return stored !== line && !(line === `${stored} ` && ENDS_IN_HEX_ESCAPE.test(stored));
  });
  assert.deepEqual(altered.slice(0, 10).map(printable), [], `${altered.length} cosmetic line(s) altered by the trim`);
  assert.deepEqual(network.filter((line) => line.trim() !== line).map(printable), []);
});
