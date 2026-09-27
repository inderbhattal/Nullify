/**
 * PICKER-2026-09 SW1 — the renderer-facing trust gate on APPEND_USER_FILTER.
 *
 * APPEND_USER_FILTER is SENDER_ANY: any renderer running our content script
 * can send it, and the element picker is its only legitimate sender. Before
 * this gate the handler checked only "non-empty, one line, under the byte
 * cap", so a compromised renderer could write an allow rule, an `$important`
 * override, a scriptlet or a page-blanking hide into My Filters. A denylist
 * was tried on paper and failed twice: `"\u0085@@||bank.example^"` passes a
 * JS `startsWith('@@')` test (JS `trim()` keeps U+0085, Rust's `str::trim`
 * strips it and compiles a live allow rule), and the list of privileged
 * shapes is open-ended. The gate is therefore an ALLOWLIST of the two shapes
 * the picker emits — a cosmetic hide and a `||host` block — checked on the
 * line exactly as the compiler will read it.
 *
 * Every refusal case is sent from a content-script sender through the real
 * `compile_user_filters` when the WASM artifact is built (the harness cuts the
 * network, so the worker's own WASM init fails; the artifact is loaded from
 * disk as `wasm-parity.test.mjs` does). The refusal assertions do not depend
 * on it: the gate answers before anything is stored or compiled.
 *
 * The "didn't re-break" lists are the exact strings the picker emits today
 * and the ones PICKER-2026-09 pins for PK2a (network candidates), PK3
 * (`:has-text()`/`:has()`/`:upward()`) and PK4 (`:nth-of-type()`), so a
 * change to either side's vocabulary that is not mirrored fails here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeChromeStub } from './chrome-stub.mjs';
import { loadServiceWorker, samplePackagedSources } from './sw-loader.mjs';

const DNR_USER_RULES_START = 900_000;
const DNR_ALLOWLIST_START = 990_000;
const REFUSAL = 'This rule type cannot be added from the page picker; add it in the options page instead.';

// ---------------------------------------------------------------------------
// The real compiler (a build product — src/shared/wasm/ is gitignored).
// ---------------------------------------------------------------------------

const WASM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shared/wasm');
const GLUE_PATH = path.join(WASM_DIR, 'nullify_core.js');
const BYTES_PATH = path.join(WASM_DIR, 'nullify_core_bg.wasm');
const NO_WASM = 'WASM artifact not built (run `npm run build:wasm`)';

let wasm = null;
if (fs.existsSync(GLUE_PATH) && fs.existsSync(BYTES_PATH)) {
  wasm = await import(pathToFileURL(GLUE_PATH).href);
  await wasm.default({ module_or_path: fs.readFileSync(BYTES_PATH) });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sender shape of our content script running in an arbitrary web page. */
function contentScriptSender(url = 'https://evil.example/page') {
  return { url, tab: { id: 7, url }, frameId: 0 };
}

/**
 * Run `body` against a fresh worker, always retiring it. The real compiler is
 * installed when built, unless `fallback` asks for the WASM-down path.
 */
async function withWorker(body, { seed = {}, fallback = false } = {}) {
  const env = await loadServiceWorker({ awaitReady: true, seed });
  if (wasm && !fallback) {
    env.hooks.setCompileUserFiltersOverrideForTest(
      (text, startId) => wasm.compile_user_filters(text, startId));
  }
  try {
    return await body(env);
  } finally {
    env.teardown();
  }
}

function userRules(chrome) {
  return [...chrome.declarativeNetRequest._dynamic.values()]
    .filter((r) => r.id >= DNR_USER_RULES_START && r.id < DNR_ALLOWLIST_START);
}

/** Everything an APPEND could change: the stored text and what it compiled to. */
function userFilterState(chrome) {
  const data = chrome.storage.local._data();
  return JSON.parse(JSON.stringify({
    userFilters: data.userFilters,
    userFiltersApplied: data.userFiltersApplied,
    userCosmeticRules: data.userCosmeticRules,
    userScriptletRules: data.userScriptletRules,
    dnr: userRules(chrome),
  }));
}

function append(chrome, line) {
  return chrome.runtime.sendMessage(
    { type: 'APPEND_USER_FILTER', payload: { line } }, contentScriptSender());
}

/** Printable form of a test line, so a failure names invisible characters. */
function show(line) {
  return JSON.stringify(line).replace(/[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Every line must be refused with the gate's error, and none may leave a
 * trace: not in the stored text, not in DNR, not in the cosmetic or scriptlet
 * stores.
 */
async function assertRefused(lines) {
  await withWorker(async ({ chrome }) => {
    const before = userFilterState(chrome);
    for (const line of lines) {
      const res = await append(chrome, line);
      assert.deepEqual(res, { error: REFUSAL },
        `${show(line)} must be refused by the picker gate, got ${JSON.stringify(res)}`);
    }
    assert.deepEqual(userFilterState(chrome), before,
      'a refused line must not be stored, compiled or applied');
  });
}

// ---------------------------------------------------------------------------
// What the picker emits. Hostnames are the page's own host as the picker
// scopes it (less `www.`).
// ---------------------------------------------------------------------------

/** Cosmetic lines the picker at HEAD builds (`buildCosmeticRule`) from its candidates. */
const PICKER_COSMETIC_TODAY = [
  'example.test###ad',                                   // 1. ID
  'example.test##div#ad',                                // 2. Tag + ID
  'example.test##div#\\31 23',                           //    CSS.escape of id "123"
  'example.test##.ad-slot',                              // 3. class
  'example.test##div.ad-slot',
  'example.test##.ad-slot.banner.top',                   //    all classes
  'example.test##div.ad-slot.banner.top',
  'example.test##.a\\:b',                                //    CSS.escape of class "a:b"
  'example.test##.x\\#\\@\\#y',                          //    CSS.escape of class "x#@#y" (PK2a Rec2)
  'example.test##[data-ad="slot-1"]',                    // 4. attribute
  'example.test##div[data-ad="slot-1"]',
  'example.test##[aria-label="Sponsored content"]',
  'example.test##[id*="ad-top"]',                        // 5. partial id
  'example.test##div.wrapper > div.ad-slot',             // 6. parent > element
  'example.test###main > div.content > div.ad-slot',     // 7. ancestor path
  'example.test##my-ad-widget',                          //    shadow host tag
  '##.ad-slot',                                          //    "apply only to this site" unchecked
  'localhost##.ad',
  '192.168.1.10##.ad',
  'xn--bcher-kva.example##.ad',
  'news.bbc.co.uk##.ad',
  // The strings existing suites already append through this handler.
  'evil.example##.ad',
  'site.example##.picked',
];

/** PICKER-2026-09 PK3 and PK4 cosmetic candidates. */
const PICKER_COSMETIC_PLANNED = [
  'example.test##div:has-text(Sponsored)',               // PK3 :has-text
  'example.test##div:has(> img.ad)',                     // PK3 native :has
  'example.test##div.ad-slot:upward(1)',                 // PK3 "block the container"
  'example.com##.x:upward(2)',                           // plan SW1 didn't-re-break
  'example.com##.ad',
  'example.com##div:has-text(Sponsored)',
  'example.com##div:has(> img.ad)',
  'example.test##div.content > div:nth-of-type(2) > img', // PK4 positional path
];

/** Network lines: PICKER-2026-09 PK2a's pinned strings, plus the shapes its escaping contract allows. */
const PICKER_NETWORK = [
  '||cdn.ads.example/a/banner.png^$image,domain=example.test', // path (query dropped)
  '||cdn.ads.example/a$image,domain=example.test',            // metachar in path → prefix, no ^
  '||cdn.ads.example^$image,domain=example.test',             // host-only
  '||cdn.ads.example/a/banner.png^$image',                    // site scope unchecked
  '||ads.example/f.html^$subdocument,domain=example.test',    // iframe
  '||ads.example/v.mp4^$media,domain=example.test',           // video/audio
  '||ads.example/x.swf^$object,domain=example.test',          // embed/object
  '||203.0.113.7/ad.png^$image,domain=example.test',          // IPv4 host
  '||[2001:db8::1]/ad.png^$image,domain=example.test',        // bracketed IPv6 host
  // Every character a WHATWG pathname keeps literally, minus the metacharacters PK2a truncates at.
  "||res.cloudinary.example/image/upload/w_300,h_250,c_fill/v1/a(b)!~'+@:;=&[x]%20_Z.jpg^$image,domain=example.test",
  '||ads.example/b.png^$image,domain=example.com',            // plan SW1 didn't-re-break
  // A path or host that merely CONTAINS an option name is not that option.
  '||ads.example/important/popup/banner.png^$image,domain=example.com',
  '||important.example^$image',
  '||ads.example/b.png^$image,domain=important.example',
  // The rest of the closed option set.
  '||ads.example/x.js^$script,3p',
  '||ads.example/x.css^$stylesheet,1p',
  '||ads.example/f.woff^$font,third-party',
  '||ads.example/api^$xmlhttprequest,first-party',
  '||ads.example/p^$ping,match-case',
  '||ads.example/ws^$websocket',
  '||ads.example/o^$other',
  // The strings existing suites already append through this handler.
  '||second.example^',
  '||overflow.example^',
];

/**
 * Registrable names at the Public Suffix List's edges, so still admitted.
 * `www.ck` is the list's exception back out of `*.ck`: a naive suffix check
 * (table-only, or "anything under a wildcard") gets it wrong. A wildcard is
 * one label deep, so `deep.foo.ck` sits below the suffix `foo.ck`.
 */
const SUFFIX_EDGES_COSMETIC = ['www.ck##.ad', 'deep.foo.ck##.ad'];
const SUFFIX_EDGES_NETWORK = ['||www.ck/x.png^$image,domain=www.ck', '||deep.foo.ck^$image,domain=deep.foo.ck'];

/**
 * CSS.escape ends every hex escape with a space, so an id or class that is or
 * starts with a digit gives a picker line with a trailing U+0020. Both trims
 * drop it, and a hex escape may end where the selector does, so the stored
 * `li#\37` still means `li#7`. An even run of trailing backslashes is an
 * escaped backslash (CSS.escape of a class ending in one).
 */
const TRAILING_ESCAPES = [
  'example.test##li#\\37 ',
  'example.test##section.wrap > #\\37 ',
  'example.test##.a\\\\',
];

/** Edge whitespace both trims strip: admitted, stored and compiled trimmed. */
const AGREED_TRIMS = [
  ' example.test##.ad',
  'example.test##.ad\u00a0',
  'example.test##.ad\t',
  'example.test##.ad\u2028',
  '\u3000example.test##.ad',
];

/** Numeric scopes that are a whole IPv4 address, and names that merely hold a digit. */
const NUMERIC_SCOPES_COSMETIC = ['192.168.1.10##.ad', 'cdn1.example##.ad'];
const NUMERIC_SCOPES_NETWORK = ['||203.0.113.7/x.png^', '||ads.example^$image,domain=192.168.1.10'];

/** Commas inside parentheses, brackets or quotes do not separate selectors. */
const NESTED_COMMAS = [
  'example.test##div:has-text(Mind, Body, Spirit)',     // PK3 text with commas
  'example.test##[aria-label="Close\\,\\ body"]',      // CSS.escape of an attribute value
  'example.test##[title="a, body"]',
];

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('SW1: the NEL-prefixed exception bypass is refused', async () => {
  // The plan's headline exploit, kept as its regression pin. Every line here
  // is also refused by shape, so this test does not by itself pin the trim
  // check: the next test and the code-point sweep below do.
  await assertRefused([
    '\u0085@@||bank.example^',             // Rust trims U+0085; JS trim keeps it
    '||x.example^$image,\u0085important',  // …inside the option list too
    '\u0085||bank.example^$important',
    ' @@||bank.example^',                  // edge characters both trims strip
    '\u00a0@@||bank.example^',
    '\u2028@@||bank.example^',
    '\u3000@@||bank.example^',
    '\ufeff@@||bank.example^',             // JS trim strips U+FEFF; Rust keeps it
    '\t@@||bank.example^',
  ]);
});

test('SW1: a line the two trims read differently, or with a control inside, is refused', async () => {
  // Each line is a valid picker hide but for one character, so only this
  // check can refuse it. JS `trim()` and Rust's `str::trim` disagree on
  // exactly U+0085 (Rust strips it) and U+FEFF (JS strips it).
  await assertRefused([
    'example.com##.ad\u0085',
    '\u0085example.com##.ad',
    'example.com##.ad\ufeff',
    '\ufeffexample.com##.ad',
    'example.com##.ad\u001f',                // a control neither trim strips stays in the line
    'example.com##.a\u0085b',
    'example.com##.a\u2028b',
    'example.com##.a\u2029b',
    'example.com##.a\u0000b',
    'example.com##.a\u007fb',
    'example.com##.a\u009fb',
    'example.com##.a\ud800b',              // lone surrogate: wasm-bindgen would hand Rust U+FFFD
  ]);
});

test('SW1: a line ending in an escaping backslash is refused', async () => {
  await assertRefused([
    'example.test###ad\\ ',                  // `#ad\ ` escapes its space; trimming leaves `#ad\`
    'example.test##.a\\',                    // joined into a list, `\,` fuses it with the next selector
    '##.a\\',
    'example.test##.a\\\\\\',                // `\\` then `\`: still odd
  ]);
});

test('SW1: APPEND refuses a network exception', async () => {
  await assertRefused([
    '@@||bank.example^',
    '@@*$document',
    '@@*',
    '@@/^https?:/$document',
    '@@||example.com^$document,domain=example.com',
  ]);
});

test('SW1: APPEND refuses $important / $all / $popup / $doc', async () => {
  await assertRefused([
    '||bank.example^$important',
    '||x.example/a.png^$image,important',
    '||bank.example^$all',
    '||bank.example^$popup',
    '||bank.example^$doc',
    '||bank.example^$document',
  ]);
});

test('SW1: APPEND refuses the elemhide family and cosmetic exceptions', async () => {
  await assertRefused([
    'example.com#@#.ad',
    '#@#.ad',
    'example.com##div:has-text(x#@#y)',     // compiles as an EXCEPTION: #@# outranks ##
    '##.x,bank.example#@#.warning',         // …for bank.example, from a line that starts ##
    '@@||x.example^$ghide',
    '@@||x.example^$elemhide',
    '||x.example^$elemhide',
    '||x.example^$ehide',
    '||x.example^$generichide',
    '||x.example^$ghide',
    '||x.example^$specifichide',
    '||x.example^$shide',
    '||x.example^$genericblock',
  ]);
});

test('SW1: a line is classified by the compiler\'s marker precedence, not by its first ##', async () => {
  await assertRefused([
    'example.com##.x#?#y',
    '##.x,bank.example#?#body',             // compiles to a body hide ON bank.example
    'example.com#?#div:has-text(x)',
    'example.com#$#body{display:none}',
    'example.com##.x#$#body{display:none}',
    'example.com#%#//scriptlet("abort-on-property-read", "x")',
    'example.com##.a#%#x',
    'example.com#@?#.x',
  ]);
});

test('SW1: APPEND refuses scriptlets and uBO HTML filters', async () => {
  await assertRefused([
    '##+js(set-constant, adsEnabled, false)',
    'bank.example##+js(remove-cookie, session)',
    'bank.example#+js(remove-cookie, session)',
    'bank.example#@#+js(nowebrtc)',
    'example.com##.a#+js(noeval)',
    'example.com## +js(set-constant, x, 1)',
    'example.com##^script:has-text(ad)',
    'example.com## ^script',
    'example.com##^responseheader(set-cookie)',
  ]);
});

test('SW1: APPEND refuses a page-blanking generic', async () => {
  await assertRefused([
    '##body',
    '##html',
    '##*',
    '##:root',
    '##head',
    'example.com##body',
    '##BODY',
    '##:ROOT',
    '## body',
    '##\u00a0body',                          // both compilers trim the selector
    '##html, body',
    '##.ad,body',
    '##\\62 ody',                            // CSS escape for "b"
    '##bod\\y',
    '##*|body',
    '##*|*',
    '##/**/body',
    '##:scope',                              // the root element at the top level
    '##:SCOPE',
    '##&',                                   // CSS Nesting: a top-level `&` is `:scope`
    'example.com##&',
  ]);
});

test('SW1: the root check splits a selector list only at top-level commas', async () => {
  await assertRefused([
    '##div:has-text(x), body',               // the comma after the operator is top-level
    '##[title="a(b"],body',                  // a parenthesis inside quotes opens nothing
    '##.a\\(,body',                          // nor does an escaped one
    '##[title="a\\"b"],body',                // an escaped quote does not close its string
    "##[title='a\\'b'],html",
  ]);
});

test('SW1: APPEND refuses procedural operators other than :has-text and :upward', async () => {
  await assertRefused([
    'bank.example##input[type=password]:style(background-image: url(https://evil.example/x))',
    'example.com##div:Style(color: red)',
    'example.com##div:STYLE(color: red)',
    '##iframe:remove-attr(sandbox)',
    'example.com##.ad:remove()',
    'example.com##div:xpath(//body)',
    'example.com##div:matches-css(display: block)',
    'example.com##div:-abp-has(.ad)',
    'example.com##div:-abp-contains(ad)',
    'example.com##div:others()',
    'example.com##div:nth-ancestor(2)',
    'example.com##div:min-text-length(1)',
    'example.com##div:has(span:style(color: red))',  // nested inside native :has()
    'example.com##div:upward(:remove())',
  ]);
});

test('SW1: APPEND refuses a has-text regex form', async () => {
  await assertRefused([
    'example.com##div:has-text(/.*/)',
    'example.com##div:HAS-TEXT(/.*/)',
    'example.com##div:has(span:has-text(/x/))',      // nested inside native :has()
    'example.com##div:has-text( /.*/)',
    'example.com##div:has-text(ok):has-text(/(a+)+b/)',
  ]);
});

test('SW1: APPEND refuses an unlisted network option', async () => {
  await assertRefused([
    "||x.example^$csp=script-src 'none'",
    '||x.example^$removeparam=utm',
    '||x.example^$redirect=noopjs',
    '||x.example^$redirect-rule=noopjs',
    '||x.example^$header=via',
    '||x.example^$replace=/a/b/',
    '||x.example^$permissions=camera=()',
    '||x.example^$badfilter',
    '||x.example^$urltransform=/a/b/',
    '||x.example^$to=bank.example',
    '||x.example^$from=example.com',
    '||x.example^$denyallow=bank.example',
    '||x.example^$method=post',
    '||x.example^$xhr',                     // an alias PK2a never emits
    '*$script',
    '$script',
    '|http',
    '/./',
  ]);
});

test('SW1: option names match as exact tokens, never substrings or case-folded', async () => {
  await assertRefused([
    '||x.example^$IMAGE',
    '||x.example^$Image',
    '||x.example^$image,IMPORTANT',
    '||x.example^$image, important',
    '||x.example^$image,\uff49mportant',     // fullwidth "i"
    '||x.example^$~image',
    '||x.example^$image,~3p',
    '||x.example^$image,image',
    '||x.example^$image,',
    '||x.example^$image,,media',
    '||x.example^$',
  ]);
});

test('SW1: domain= takes exactly one plain hostname', async () => {
  await assertRefused([
    '||x.example^$image,domain=a.example|b.example',
    '||x.example^$image,domain=~a.example',
    '||x.example^$image,domain=a.example|~b.example',
    '||x.example^$image,domain=a.example,domain=b.example',
    // A second domain= carrying the word "important" switches off the
    // compiler's critical-path guard (`opts.contains("important")`) and
    // blocks YouTube playback from youtube.com.
    '||googlevideo.com/videoplayback$media,domain=youtube.com,domain=important.example',
    '||x.example^$image,domain=',
    '||x.example^$image,domain=A.example',
    '||x.example^$image,domain=*.example',
    '||x.example^$image,domain=example.*',
    '||x.example^$image,~domain=a.example',
  ]);
});

test('SW1: a cosmetic hide is scoped to one plain hostname or none, and hides something', async () => {
  await assertRefused([
    '~example.com##.ad',
    'a.example,bank.example##.ad',
    'example.*##.ad',
    'Example.com##.ad',
    'example.com ##.ad',
    'x$important##.ad',
    'x|y##.ad',
    'example.com##',
    '##',
  ]);
});

// A public suffix is never a scope. User cosmetic rules are looked up by
// walking every parent domain with no suffix stop, so `com##div` hides divs
// on every .com site; `||com^` blocks every .com subresource.

test('SW1: a cosmetic hide is never scoped to a public suffix', async () => {
  await assertRefused([
    'com##div',
    'co.uk##.ad',
    'foo.ck##.ad',                          // `*.ck`: a wildcard child is a suffix
    'ck##.ad',                              // what stripping `www.` makes of the site www.ck
    'github.io##.ad',                       // the list's curated private block
  ]);
});

test('SW1: a network block\'s host is never a public suffix', async () => {
  await assertRefused([
    '||com^$image',
    '||co.uk/x.png^',
    '||foo.ck/x.png^$image',
    '||com.^$image',                        // the fully-qualified spelling
  ]);
});

test('SW1: domain= is never a public suffix', async () => {
  await assertRefused([
    '||ads.example^$image,domain=com',
    '||ads.example^$image,domain=co.uk',
    '||ads.example^$image,domain=foo.ck',
  ]);
});

test('SW1: a scope that ends in a number is a whole IPv4 address, or refused', async () => {
  // The suffix list has no numeric entries, yet `1` reaches every x.x.x.1
  // host: the user cosmetic walk has no suffix stop and DNR's `||` is textual.
  await assertRefused([
    '1##.ad',
    '0.1##.ad',
    '10.0.0##.ad',
    '||1^$image',
    '||0.1^$subdocument',
    '||1.2.3.4.^$image',                     // the URL parser drops an IPv4 host's trailing dot
    '||0x1^$image',                          // WHATWG reads a 0x label as a number too
    '||ads.example^$image,domain=10',
    '||ads.example^$image,domain=0.0.1',
  ]);
});

test('SW1: a network line must be ||host followed by ^ or a path, with no smuggled metacharacter', async () => {
  await assertRefused([
    '||[x,bank.example##body]^',            // `##` in a bracketed host: the compiler reads a hide on bank.example
    '||[x,bank.example]^$image',            // a bracket holds an IPv6 literal and nothing else
    '||*||ads.example^$image',              // only a match anchored at the start counts
    '||x$important,domain=bank.example^',   // the WHATWG parser keeps `$ , =` in a hostname
    '||x$image,domain=bank.example',        // host with neither ^ nor a path
    '||ads.example',
    '||ads.example$image',
    '||*^$image',
    '||*/x.png^$image',
    '||^$image',
    '||ADS.example^',
    '|https://ads.example/',
    'ads.example/b.png',
    '||ads.example^^$image',
    '||ads.example^|',
    '||ads.example/a|b^',
    '||ads.example/a*b^',
    '||ads.example/a^b^$image',
    '||ads.example/a b^',
    '||ads.example/a#b^',
    '||ads.example/a$script/x.png^$image',
    '||ads.example/a\\b^',
    '||ads.example/\u0441^$image',          // Cyrillic, unencoded
    '||x.example^\uff04important',           // fullwidth $
  ]);
});

// ---------------------------------------------------------------------------
// The gate and the compiler read the same line
// ---------------------------------------------------------------------------

test('SW1: the gate refuses exactly the edge code points the two trims disagree on', async (t) => {
  if (!wasm) { t.skip(NO_WASM); return; }
  await withWorker(async ({ hooks }) => {
    const isSafe = hooks.isPickerSafeUserFilterLine;
    assert.equal(typeof isSafe, 'function', 'the gate must be a pure predicate the harness can call');
    const base = 'example.com##.ad';
    assert.equal(isSafe(base), true);

    // Oracle for Rust: compile one hide per BMP code point, suffixed with it,
    // and read back whether `str::trim` removed it. Oracle for JS: `trim()`.
    // Line breaks are refused before the gate; lone surrogates below.
    const cps = [];
    for (let cp = 0; cp <= 0xffff; cp++) {
      if (cp === 0x0a || cp === 0x0d || (cp >= 0xd800 && cp <= 0xdfff)) continue;
      cps.push(cp);
    }
    const host = (cp) => `h${cp.toString(16)}.example`;
    const hex = (cp) => cp.toString(16).padStart(4, '0');
    const compiled = wasm.compile_user_filters(
      cps.map((cp) => `${host(cp)}##.ad${String.fromCharCode(cp)}`).join('\n'), DNR_USER_RULES_START);
    const kept = compiled.cosmeticRules.domainSpecific;

    const disagree = [];
    let agreed = 0;
    for (const cp of cps) {
      const ch = String.fromCharCode(cp);
      const rustStrips = JSON.stringify(kept[host(cp)]) === '[".ad"]';
      const jsStrips = `.ad${ch}`.trim() === '.ad';
      if (rustStrips === jsStrips) {
        if (!rustStrips) continue;
        // Both strip it: the line means `base` to both, and `base` is stored.
        agreed++;
        assert.equal(isSafe(`${base}${ch}`), true, `U+${hex(cp)} at the end is stripped by both trims`);
        assert.equal(isSafe(`${ch}${base}`), true, `U+${hex(cp)} at the start is stripped by both trims`);
        continue;
      }
      disagree.push(cp);
      const only = rustStrips ? 'Rust' : 'JS';
      assert.equal(isSafe(`${base}${ch}`), false, `U+${hex(cp)} at the end: only ${only} trim strips it`);
      assert.equal(isSafe(`${ch}${base}`), false, `U+${hex(cp)} at the start: only ${only} trim strips it`);
    }
    // The oracles must actually have run.
    assert.deepEqual(disagree, [0x85, 0xfeff], 'the trims disagree on exactly U+0085 and U+FEFF');
    assert.ok(agreed >= 22, `expected the rest of White_Space, found ${agreed}`);
  });
});

test('SW1: the gate refuses every control, line separator and lone surrogate inside a line', async () => {
  await withWorker(async ({ hooks }) => {
    const isSafe = hooks.isPickerSafeUserFilterLine;
    assert.equal(typeof isSafe, 'function', 'the gate must be a pure predicate the harness can call');
    const refused = [0x2028, 0x2029, 0xd800, 0xdbff, 0xdc00, 0xdfff];
    for (let cp = 0; cp <= 0x9f; cp++) if (cp < 0x20 || cp >= 0x7f) refused.push(cp);
    for (const cp of refused) {
      assert.equal(isSafe(`example.com##.a${String.fromCharCode(cp)}b`), false,
        `interior U+${cp.toString(16).padStart(4, '0')} must be refused`);
    }
    // Didn't over-reach: interior spaces are selector syntax, and non-ASCII is
    // what CSS.escape leaves in a class name.
    for (const line of ['example.com##div > .a', 'example.com##.a\u00a0b', 'example.com##.caf\u00e9',
      'example.com##.a\u{1f600}b', 'example.com##[title="a b"]']) {
      assert.equal(isSafe(line), true, `${show(line)} must still be admitted`);
    }
    // Anything that is not a non-empty string is refused, never thrown on.
    for (const value of [undefined, null, 42, '', ['##.ad'], { line: '##.ad' }]) {
      assert.equal(isSafe(value), false, `${JSON.stringify(value)} must be refused`);
    }
  });
});

// ---------------------------------------------------------------------------
// Didn't re-break
// ---------------------------------------------------------------------------

test('SW1 (didn\'t re-break): every picker-legitimate shape is admitted and stored as both trims read it', async () => {
  for (const line of [...PICKER_COSMETIC_TODAY, ...PICKER_COSMETIC_PLANNED, ...PICKER_NETWORK,
    ...SUFFIX_EDGES_COSMETIC, ...SUFFIX_EDGES_NETWORK, ...TRAILING_ESCAPES, ...AGREED_TRIMS,
    ...NUMERIC_SCOPES_COSMETIC, ...NUMERIC_SCOPES_NETWORK, ...NESTED_COMMAS]) {
    await withWorker(async ({ chrome }) => {
      const res = await append(chrome, line);
      assert.equal(res.ok, true, `${show(line)} must be admitted, got ${JSON.stringify(res)}`);
      assert.equal(chrome.storage.local._data().userFilters, line.trim());
    });
  }
});

test('SW1 (didn\'t re-break): every picker-legitimate shape applies on the WASM path', async (t) => {
  if (!wasm) { t.skip(NO_WASM); return; }
  for (const line of [...PICKER_COSMETIC_TODAY, ...PICKER_COSMETIC_PLANNED, ...SUFFIX_EDGES_COSMETIC,
    ...TRAILING_ESCAPES, ...AGREED_TRIMS, ...NUMERIC_SCOPES_COSMETIC, ...NESTED_COMMAS]) {
    await withWorker(async ({ chrome }) => {
      const res = await append(chrome, line);
      assert.equal(res.ok, true, `${show(line)}: ${JSON.stringify(res)}`);
      assert.equal(res.counts.cosmetic, 1, `${show(line)} must compile to one hide`);
      const stored = line.trim();
      const sep = stored.indexOf('##');
      const [domain, selector] = [stored.slice(0, sep), stored.slice(sep + 2)];
      const cosmetic = chrome.storage.local._data().userCosmeticRules;
      assert.deepEqual([cosmetic.generic, cosmetic.domainSpecific],
        domain ? [[], { [domain]: [selector] }] : [[selector], {}],
        `${show(line)} must be a plain hide of exactly that selector, on exactly that scope`);
      assert.deepEqual([cosmetic.genericExceptions, cosmetic.domainExceptions], [[], {}]);
      assert.deepEqual(chrome.storage.local._data().userScriptletRules, []);
      assert.deepEqual(userRules(chrome), []);
    });
  }
  for (const line of [...PICKER_NETWORK, ...SUFFIX_EDGES_NETWORK, ...NUMERIC_SCOPES_NETWORK]) {
    await withWorker(async ({ chrome }) => {
      const res = await append(chrome, line);
      assert.equal(res.ok, true, `${show(line)}: ${JSON.stringify(res)}`);
      assert.deepEqual([res.counts.network, res.counts.skippedNetwork], [1, 0],
        `${show(line)} must compile to one live rule: ${JSON.stringify(res.counts)}`);
      const [rule] = userRules(chrome);
      assert.deepEqual([rule.action.type, rule.priority], ['block', 1],
        `${show(line)} must be a plain block, never an allow or an $important override`);
    });
  }
});

test('SW1 (didn\'t re-break): Unicode lookalikes of # are not markers to the compiler either', async (t) => {
  if (!wasm) { t.skip(NO_WASM); return; }
  // Fullwidth #, @ and ? are ordinary characters to both compilers, so the
  // gate may admit them: the line stays a plain hide.
  const line = 'example.com##.x\uff03@\uff03y\uff03?\uff03z';
  await withWorker(async ({ chrome }) => {
    const res = await append(chrome, line);
    assert.equal(res.ok, true, JSON.stringify(res));
    const cosmetic = chrome.storage.local._data().userCosmeticRules;
    assert.deepEqual(cosmetic.domainSpecific, { 'example.com': ['.x\uff03@\uff03y\uff03?\uff03z'] });
    assert.deepEqual([cosmetic.genericExceptions, cosmetic.domainExceptions], [[], {}]);
  });
});

test('SW1 (didn\'t re-break): the existing APPEND validations still answer first, with their own errors', async () => {
  await withWorker(async ({ chrome }) => {
    assert.match((await append(chrome, '   ')).error, /non-empty filter line/);
    assert.match((await append(chrome, '@@||a.example^\n||b.example^')).error, /single line/);
    assert.match((await append(chrome, 'a\rb')).error, /single line/);
    assert.match((await append(chrome, `example.com##.${'\u0444'.repeat(1_100_000)}`)).error, /byte limit/);
    // The cap answers before the gate even for a shape the gate refuses.
    assert.match((await append(chrome, `@@||bank.example^$${'\u0444'.repeat(1_100_000)}`)).error, /byte limit/);
  });
});

test('SW1 (didn\'t re-break): the options page keeps full syntax through SET_USER_FILTERS', async () => {
  await withWorker(async ({ chrome }) => {
    const filters = '@@||bank.example^\nexample.com#@#.ad\n||x.example^$important\n##body';
    const res = await chrome.runtime.sendMessage({ type: 'SET_USER_FILTERS', payload: { filters } });
    assert.equal(res.error, undefined, JSON.stringify(res));
    assert.equal(chrome.storage.local._data().userFilters, filters);
  });
});

// ---------------------------------------------------------------------------
// PICKER-2026-09 SW2 — honest drop reporting. The picker decides whether its
// line applied by finding that line's own entry in `counts.skippedRules`
// (PK1: `skippedRules.find((s) => s.line === rule.trim())`). APPEND is
// SENDER_ANY, so its reply reaches a renderer: it may carry that entry and
// nothing else from My Filters.
// ---------------------------------------------------------------------------

const FALLBACK_REASON = 'unsupported by the fallback compiler (WASM unavailable)';
// Admitted by the gate, dropped by the compiler's critical-path guard.
const CRITICAL = '||googlevideo.com/videoplayback$media,domain=youtube.com';
const STORED_DROPS = Array.from({ length: 25 }, (_, i) => `||old${i}.example^$redirect=noopjs`);

test('SW2: a network line the fallback compiler refuses is reported, not dropped in silence', async () => {
  // WASM down. The gate admits each line; the fallback parser cannot express
  // `$domain=`, `$object`, `$3p` or `$match-case`.
  for (const line of [
    '||cdn.ads.example/b.png^$image,domain=example.com',
    '||ads.example/x.swf^$object',
    '||ads.example/b.png^$image,3p',
    '||ads.example/b.png^$image,match-case',
  ]) {
    await withWorker(async ({ chrome }) => {
      const res = await append(chrome, line);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.deepEqual([res.counts.network, res.counts.skippedNetwork, res.counts.skippedRules],
        [0, 1, [{ id: null, reason: FALLBACK_REASON, line }]], `${show(line)} must be reported as dropped`);
    }, { fallback: true });
  }
  // The options page's full-text apply takes the same path; the entry holds
  // the trimmed line, as a compiler drop does.
  await withWorker(async ({ chrome }) => {
    const res = await chrome.runtime.sendMessage({ type: 'SET_USER_FILTERS',
      payload: { filters: '  ||a.example^$image,domain=b.example \n||ok.example^' } });
    assert.deepEqual([res.network, res.skippedNetwork, res.skippedRules],
      [1, 1, [{ id: null, reason: FALLBACK_REASON, line: '||a.example^$image,domain=b.example' }]]);
  }, { fallback: true });
});

test('SW2: an APPEND reply carries the appended line\'s own drop entry, however many lines dropped before it', async (t) => {
  if (!wasm) { t.skip(NO_WASM); return; }
  // A decoy first: a longer dropped line that starts with the appended one, so
  // only an exact match finds the right entry.
  const stored = [`${CRITICAL}.decoy`, ...STORED_DROPS].join('\n');
  await withWorker(async ({ chrome }) => {
    const res = await append(chrome, CRITICAL);
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.counts.skippedNetwork, 27, 'the count stays the true total');
    const list = res.counts.skippedRules;
    const own = list.find((s) => s.line === CRITICAL.trim());   // PK1's lookup, verbatim
    assert.ok(own, `the appended line's entry must be in the reply: ${JSON.stringify(list.map((s) => s.line))}`);
    assert.match(own.reason, /critical path/);
    assert.deepEqual(list, [{ id: null, reason: own.reason, line: CRITICAL }], 'and nothing else from My Filters');
  }, { seed: { userFilters: stored, userFiltersApplied: stored } });
});

test('SW2: on the fallback too, the APPEND reply carries the appended line\'s own drop entry', async () => {
  const stored = Array.from({ length: 25 }, (_, i) => `||old${i}.example/a.png^$image,domain=example.com`).join('\n');
  // Sent with a trailing space the gate admits (both trims drop it): the entry
  // holds the line as stored, which is what PK1 looks up.
  const rule = '||cdn.ads.example/b.png^$image,domain=example.com ';
  await withWorker(async ({ chrome }) => {
    const res = await append(chrome, rule);
    assert.equal(res.counts.skippedNetwork, 26);
    assert.deepEqual(res.counts.skippedRules, [{ id: null, reason: FALLBACK_REASON, line: rule.trim() }]);
  }, { fallback: true, seed: { userFilters: stored, userFiltersApplied: stored } });
});

// Private lines the compilers drop. REVIEW-2026-08 §4.19 is why no renderer
// can read My Filters; an APPEND reply goes to one.
const PRIVATE_FALLBACK_DROPS = [
  '||tracker.example^$domain=mybank.example|payroll.myemployer.corp',
  '||cdn.example/x.js^$script,domain=private-forum.example',
  '||metrics.example^$3p,domain=health-portal.example',
];
const PRIVATE_COMPILER_DROPS = [
  '||facebook.com^$removeparam=fbclid',
  '||tracker.example^$redirect=noopjs,domain=mybank.example',
  "||cdn.example/x.js^$csp=script-src 'none',domain=private-forum.example",
];
const PRIVATE_NAMES = ['mybank', 'payroll', 'private-forum', 'health-portal', 'facebook', 'fbclid'];

/** No stored line, nor any private name in one, may appear anywhere in the reply. */
function assertReplyLeaksNothing(res, storedLines) {
  const text = JSON.stringify(res);
  for (const needle of [...storedLines, ...PRIVATE_NAMES]) {
    assert.ok(!text.includes(needle), `the APPEND reply leaks ${JSON.stringify(needle)}: ${text}`);
  }
}

test('SW2: an APPEND reply lists no other line of My Filters (WASM down)', async () => {
  const stored = PRIVATE_FALLBACK_DROPS.join('\n');
  for (const line of ['example.com##.ad', '||ads.example/b.png^']) {
    await withWorker(async ({ chrome }) => {
      const res = await append(chrome, line);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.counts.skippedNetwork, PRIVATE_FALLBACK_DROPS.length);
      assert.deepEqual(res.counts.skippedRules, []);
      assertReplyLeaksNothing(res, PRIVATE_FALLBACK_DROPS);
    }, { fallback: true, seed: { userFilters: stored, userFiltersApplied: stored } });
  }
});

test('SW2: an APPEND reply lists no other line of My Filters (WASM)', async (t) => {
  if (!wasm) { t.skip(NO_WASM); return; }
  const storedLines = [...PRIVATE_COMPILER_DROPS, ...STORED_DROPS];
  const stored = storedLines.join('\n');
  for (const line of ['example.com##.ad', '||ads.example/b.png^']) {
    await withWorker(async ({ chrome }) => {
      const res = await append(chrome, line);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.counts.skippedNetwork, storedLines.length);
      assert.deepEqual(res.counts.skippedRules, []);
      assertReplyLeaksNothing(res, storedLines);
    }, { seed: { userFilters: stored, userFiltersApplied: stored } });
  }
});

test('SW2 (didn\'t re-break): the options page\'s reply still lists the first 20 drops, in order', async (t) => {
  if (!wasm) { t.skip(NO_WASM); return; }
  // SET_USER_FILTERS is extension-page only and appends no line, so none is
  // singled out: not the last drop, and not the RE2 rejection (an id-only
  // entry, no line).
  await withWorker(async ({ chrome }) => {
    const res = await chrome.runtime.sendMessage({ type: 'SET_USER_FILTERS',
      payload: { filters: `${STORED_DROPS.join('\n')}\n/a(?=b)/\n${CRITICAL}` } });
    assert.equal(res.skippedNetwork, 27);
    assert.deepEqual(res.skippedRules.map((s) => s.line), STORED_DROPS.slice(0, 20));
  });
});

test('SW2: on the fallback, only a line the compiler reads as a network rule is reported as dropped', async () => {
  // The compiler never reads these as network rules: `should_skip_filter_line`
  // skips a line starting `[`, `%` or `@@#`, and a `#+js(` line goes to its
  // scriptlet branch. The fallback parser refuses each, and none may be
  // reported. The last two are real network lines it cannot express, one with
  // a `%` inside (the prefixes count only at the start): both reported.
  const reported = ['||ads.example^$domain=a.example', '||ads.example/a%20b.png^$domain=a.example'];
  await withWorker(async ({ chrome }) => {
    const res = await chrome.runtime.sendMessage({ type: 'SET_USER_FILTERS', payload: { filters: [
      '[$domain=x]',
      '%3C?php%20echo$doc',
      '@@#x',
      'example.com#+js(set-constant, $ads, false)',
      ...reported,
    ].join('\n') } });
    assert.deepEqual([res.skippedNetwork, res.skippedRules],
      [2, reported.map((line) => ({ id: null, reason: FALLBACK_REASON, line }))]);
  }, { fallback: true });
});

test('SW2 (didn\'t re-break): on the fallback, a cosmetic line is never reported as a dropped network rule', async () => {
  await withWorker(async ({ chrome }) => {
    const res = await append(chrome, 'example.com##.ad');
    assert.deepEqual([res.counts.cosmetic, res.counts.skippedNetwork, res.counts.skippedRules], [1, 0, []]);
    // One line per marker the compiler tests, each refused by the fallback
    // network parser (options page: the gate refuses all but the first).
    const set = await chrome.runtime.sendMessage({ type: 'SET_USER_FILTERS', payload: { filters: [
      'example.com##.ad',
      'example.com#@#.ad',
      'example.com##+js(noeval)',
      'example.com#?#.ad$important',
    ].join('\n') } });
    assert.deepEqual([set.skippedNetwork, set.skippedRules], [0, []]);
  }, { fallback: true });
});

test('SW2 (didn\'t re-break): a plain block still applies on the fallback', async () => {
  await withWorker(async ({ chrome }) => {
    const res = await append(chrome, '||ads.example/b.png^');
    assert.deepEqual([res.counts.network, res.counts.skippedNetwork, res.counts.skippedRules], [1, 0, []]);
  }, { fallback: true });
});

// ---------------------------------------------------------------------------
// PICKER-2026-09 SW3 — a user selector is never comma-joined with list
// selectors. `build_page_bundle` joins up to 150 CSS selectors per rule, and a
// browser discards a whole rule for one selector it cannot parse, so one bad
// user selector (`a:bogus`, which no gate can refuse: the worker has no CSS
// parser) voided the lists' hides on every page, and a bad list selector voided
// the user's. The harness's sample index gives example.com the list hide
// `.site-ad`.
// ---------------------------------------------------------------------------

const NO_EXCEPTIONS = { genericExceptions: [], domainExceptions: {} };

async function withIndexedWorker(body, { userCosmeticRules, realBundler = true, stub, idb } = {}) {
  const env = await loadServiceWorker({
    awaitReady: true, packagedSources: samplePackagedSources(), stub, idb,
    seed: userCosmeticRules ? { userCosmeticRules } : {},
  });
  if (realBundler && wasm) env.hooks.setPageBundleBuilderForTest((...args) => wasm.build_page_bundle(...args));
  try {
    return await body(env);
  } finally {
    env.teardown();
  }
}

/** The selector list of every rule in a stylesheet, as arrays. */
function ruleSelectors(cssText) {
  return (cssText || '').split('}').map((rule) => rule.split('{')[0].trim()).filter(Boolean)
    .map((list) => list.split(',').map((sel) => sel.trim()));
}

test('SW3: an unparseable user selector never shares a CSS rule with a list selector', async (t) => {
  if (!wasm) { t.skip(NO_WASM); return; }
  const user = ['a:bogus', 'div:bogus', '.user-ad'];
  await withIndexedWorker(async ({ hooks }) => {
    const rules = ruleSelectors((await hooks.getCosmeticBundleForPage('example.com')).cssText);
    const listRule = rules.find((list) => list.includes('.site-ad'));
    assert.ok(listRule, `the list hide must be emitted: ${JSON.stringify(rules)}`);
    assert.deepEqual(listRule.filter((sel) => user.includes(sel)), [],
      `a list rule must hold no user selector: ${JSON.stringify(listRule)}`);
    for (const sel of user) {
      assert.deepEqual(rules.filter((list) => list.includes(sel)), [[sel]], `${sel} must be a rule of its own`);
    }
  }, { userCosmeticRules: { generic: ['a:bogus'], domainSpecific: { 'example.com': ['div:bogus', '.user-ad'] }, ...NO_EXCEPTIONS } });
});

test('SW3: when build_page_bundle throws, the WASM CSS fallback still builds user CSS one selector per rule', async (t) => {
  if (!wasm) { t.skip(NO_WASM); return; }
  const user = ['a:bogus', 'div:bogus', '.user-ad'];
  await withIndexedWorker(async ({ hooks }) => {
    hooks.setPageBundleBuilderForTest(() => { throw new Error('bundle build failed'); });
    hooks.setCssBuilderForTest((...args) => wasm.build_css_from_selectors(...args));
    const rules = ruleSelectors((await hooks.getCosmeticBundleForPage('example.com')).cssText);
    const listRule = rules.find((list) => list.includes('.site-ad'));
    assert.ok(listRule, `the list hide must be emitted: ${JSON.stringify(rules)}`);
    assert.deepEqual(listRule.filter((sel) => user.includes(sel)), [], `a list rule must hold no user selector: ${JSON.stringify(listRule)}`);
    for (const sel of user) {
      assert.deepEqual(rules.filter((list) => list.includes(sel)), [[sel]], `${sel} must be a rule of its own`);
    }
  }, { realBundler: false, userCosmeticRules: { generic: ['a:bogus'], domainSpecific: { 'example.com': ['div:bogus', '.user-ad'] }, ...NO_EXCEPTIONS } });
});

test('SW3: a page bundle stored before the split is not served', async () => {
  await withIndexedWorker(async ({ hooks }) => {
    await hooks.db.putPageBundle('example.com', {
      rules: { generic: [], domainSpecific: [], exceptions: [] },
      cssText: 'a:bogus,.site-ad { display: none !important; }', exceptionCss: '', cosmeticRulesBinary: null,
    }, hooks.getActiveRuleDataVersion());
    const bundle = await hooks.getCosmeticBundleForPage('example.com');
    assert.ok(!bundle.cssText.includes('a:bogus,.site-ad'), `a joined bundle from before must be rebuilt: ${bundle.cssText}`);
  }, { realBundler: false });
});

test('SW3 (didn\'t re-break): user and list hides, user procedural rules and exceptions all still apply', async (t) => {
  if (!wasm) { t.skip(NO_WASM); return; }
  for (const realBundler of [true, false]) {
    const tag = realBundler ? 'WASM' : 'JS fallback';
    await withIndexedWorker(async ({ hooks }) => {
      const bundle = await hooks.getCosmeticBundleForPage('example.com');
      const sels = ruleSelectors(bundle.cssText).flat();
      assert.ok(sels.includes('.site-ad') && sels.includes('.user-ad') && sels.includes('.user-generic'),
        `${tag}: list and user hides: ${bundle.cssText}`);
      assert.deepEqual(bundle.rules.domainSpecific.map((r) => r.selector), ['div:has-text(Sponsored)'],
        `${tag}: the user's procedural rule is planned`);
    }, { realBundler, userCosmeticRules: {
      generic: ['.user-generic'], domainSpecific: { 'example.com': ['.user-ad', 'div:has-text(Sponsored)'] }, ...NO_EXCEPTIONS } });
    // A user exception still cancels a list hide and a user hide.
    await withIndexedWorker(async ({ hooks }) => {
      const bundle = await hooks.getCosmeticBundleForPage('example.com');
      const sels = ruleSelectors(bundle.cssText).flat();
      assert.ok(!sels.includes('.site-ad') && !sels.includes('.user-ad'), `${tag}: excepted hides must go: ${bundle.cssText}`);
      assert.match(bundle.exceptionCss, /\.site-ad/);
    }, { realBundler, userCosmeticRules: {
      generic: ['.user-ad'], domainSpecific: {}, genericExceptions: ['.site-ad', '.user-ad'], domainExceptions: {} } });
  }
});

test('SW3 (didn\'t re-break): a bundle stored after the split is served again on the next worker', async () => {
  let rereads = 0;
  const first = await loadServiceWorker({ awaitReady: true, packagedSources: samplePackagedSources() });
  await first.hooks.getCosmeticBundleForPage('example.com');
  first.teardown();
  await withIndexedWorker(async ({ hooks }) => {
    const original = hooks.db.getCosmeticRules.bind(hooks.db);
    hooks.db.getCosmeticRules = async (...args) => { rereads++; return original(...args); };
    const bundle = await hooks.getCosmeticBundleForPage('example.com');
    assert.match(bundle.cssText, /\.site-ad/);
    assert.equal(rereads, 0, 'the stored bundle must be served, not rebuilt');
  }, { realBundler: false, stub: first.chrome, idb: first.idb });
});

// ---------------------------------------------------------------------------
// PICKER-2026-09 SW4 — MV3 opens `chrome.storage.local` to content scripts by
// default, and the worker trusts `userFilters`, `userCosmeticRules`,
// `userScriptletRules` and `allowlist` from it: a compromised renderer could
// write them directly and never meet the APPEND gate. No content-side bundle
// uses chrome.storage, so the worker restricts the area to trusted contexts.
// The stub has no access levels; these tests pin the call, not its effect,
// which only a real browser enforces.
// ---------------------------------------------------------------------------

/** Boot a worker whose storage.local.setAccessLevel is `impl` (omitted: the API is absent). */
async function bootWithAccessLevel(impl) {
  const stub = makeChromeStub();
  const seen = [];
  if (impl) {
    stub.storage.local.setAccessLevel = (opts) => {
      seen.push({ opts, readsBefore: stub.calls.filter((c) => c.api === 'storage.get').length });
      return impl(opts);
    };
  }
  const env = await loadServiceWorker({ stub, awaitReady: true });
  return { ...env, seen };
}

/** The worker still answers a renderer's APPEND end to end. */
async function assertWorkerServes(chrome) {
  const res = await append(chrome, 'example.com##.ad');
  assert.equal(res.ok, true, JSON.stringify(res));
}

test('SW4: startup restricts storage.local to trusted contexts, once, before reading storage', async () => {
  const env = await bootWithAccessLevel(async () => {});
  try {
    assert.deepEqual(env.seen.map((s) => s.opts), [{ accessLevel: 'TRUSTED_CONTEXTS' }]);
    assert.equal(env.seen[0].readsBefore, 0, 'no storage read may run before the restriction is requested');
    assert.ok(env.chrome.calls.entries.some((c) => c.api === 'storage.get'), 'the worker did read storage afterwards');
    env.chrome.runtime.onStartup._fire();
    await env.hooks.whenCriticalReady();
    assert.equal(env.seen.length, 1, 'once per worker life, even when onStartup fires');
    await assertWorkerServes(env.chrome);
  } finally {
    env.teardown();
  }
});

test('SW4: a rejected or throwing setAccessLevel is reported and startup goes on', async () => {
  for (const impl of [async () => { throw new Error('access level refused'); }, () => { throw new Error('access level refused'); }]) {
    const env = await bootWithAccessLevel(impl);
    try {
      assert.equal(env.seen.length, 1);
      await env.hooks.whenBackgroundSetupDone();
      const report = env.hooks.errorReport;
      assert.ok([...report.critical, ...report.warnings].some((e) => e.context === 'storage:setAccessLevel'),
        `the failure must reach the error report: ${JSON.stringify(report.warnings.map((e) => e.context))}`);
      assert.ok(!report.critical.some((e) => e.context === 'Critical startup'), 'startup must not fail');
      await assertWorkerServes(env.chrome);
    } finally {
      env.teardown();
    }
  }
});

test('SW4 (didn\'t re-break): a Chrome without setAccessLevel starts as before', async () => {
  const env = await bootWithAccessLevel(undefined);
  try {
    const report = env.hooks.errorReport;
    assert.ok(![...report.critical, ...report.warnings].some((e) => e.context === 'storage:setAccessLevel'));
    assert.ok(!report.critical.some((e) => e.context === 'Critical startup'));
    await assertWorkerServes(env.chrome);
  } finally {
    env.teardown();
  }
});

// ---------------------------------------------------------------------------
// Code review R2 — a `/*` in a selector opens a CSS comment that swallows every
// rule after it in the sheet: the next user rule, and the exception CSS. SW1
// refuses comments on APPEND; the options page reaches the bundler directly.
// The WASM half needs the artifact rebuilt from wasm-core (is_css_safe_selector).
// ---------------------------------------------------------------------------

test('R2: a selector holding a CSS comment start never reaches the page CSS', async (t) => {
  for (const realBundler of [false, true]) {
    if (realBundler && !wasm) { t.skip(NO_WASM); return; }
    const tag = realBundler ? 'WASM' : 'JS fallback';
    await withIndexedWorker(async ({ hooks }) => {
      const bundle = await hooks.getCosmeticBundleForPage('example.com');
      for (const [name, css] of [['cssText', bundle.cssText], ['exceptionCss', bundle.exceptionCss]]) {
        assert.ok(!css.includes('/*'), `${tag}: ${name} must hold no comment start: ${css}`);
      }
      const sels = ruleSelectors(bundle.cssText).flat();
      assert.ok(sels.includes('.next') && sels.includes('.site-ad'), `${tag}: the rules after it still apply: ${bundle.cssText}`);
      assert.match(bundle.exceptionCss, /\.keep/, `${tag}: the exceptions after it still apply`);
    }, { realBundler, userCosmeticRules: {
      generic: ['/*.stale', '.ad /* old', '.next', '.keep'], domainSpecific: {},
      genericExceptions: ['/* x */.gone', '.keep'], domainExceptions: {} } });
  }
});
