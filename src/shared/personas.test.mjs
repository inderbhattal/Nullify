/**
 * Pins the shared stealth-persona module (docs/REVIEW-2026-09.md §5.9).
 *
 * The personas lived in two hand-kept literal tables — the service worker's
 * request-header rule and the MAIN-world `persona-spoof` scriptlet — both
 * frozen at one Chrome major. A UA claiming a two-year-old Chrome is a beacon,
 * not camouflage. `personas.js` derives the major from the running browser and
 * is the only place the persona strings are spelled; the checks here are the
 * ones both consumers rely on: detection never throws (the service worker
 * evaluates it at start-up, where a throw kills the worker), the two views
 * describe the same browser, and only the major moved.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CHROME_MAJOR_FALLBACK,
  detectChromeMajor,
  buildPersona,
  buildPersonas,
  buildNavigatorPersona,
} from './personas.js';

const PERSONA_IDS = ['windows', 'mac', 'linux'];

// A major that is neither the fallback nor the old literal, so an assertion
// that expects it cannot be satisfied by either of them by accident.
const RUNNING_MAJOR = 151;

const chromeUA = (major, system = 'X11; Linux x86_64') =>
  `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

const chromeBrands = (major) => [
  { brand: 'Not;A=Brand', version: '8' },
  { brand: 'Chromium', version: String(major) },
  { brand: 'Google Chrome', version: String(major) },
];

// ---------------------------------------------------------------------------
// Source scan — no consumer spells a Chrome major
// ---------------------------------------------------------------------------

// Every way the v4.9.0 sources pinned the major. `personas.js` is the one
// file allowed to spell these shapes, and it does so from a variable.
const PINNED_MAJOR_PATTERNS = [
  { name: 'UA token', re: /Chrome\/\d+/, sample: 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
  { name: 'sec-ch-ua entry', re: /;v=\\?"\d+/, sample: '"Chromium";v="122", "Not(A:Brand";v="24"' },
  { name: 'userAgentData brand entry', re: /\bversion:\s*['"]\d+/, sample: "{ brand: 'Google Chrome', version: '122' }" },
  { name: 'full-version literal', re: /['"]\d+\.0\.0\.0['"]/, sample: "result.uaFullVersion = '122.0.0.0';" },
];

const SCANNED_SOURCES = [
  { path: '../scriptlets/persona-spoof.js', marker: 'export function personaSpoof' },
  { path: '../scriptlets/bot-stealth.js', marker: 'export function botStealth' },
  // TODO(A2e): enable when the service worker's PERSONAS table is built by
  // buildPersonas() from this module. Until then that file still carries the
  // literals and is Track A's to change.
  // { path: '../background/service-worker.js', marker: 'async function applyPersonaRules' },
];

test('5.9: no persona literal pins a Chrome major', () => {
  // The scanner must be able to see what it is looking for: each pattern is
  // checked against the literal it was written to catch.
  for (const { name, re, sample } of PINNED_MAJOR_PATTERNS) {
    assert.match(sample, re, `the ${name} pattern catches the v4.9.0 literal`);
  }

  for (const { path, marker } of SCANNED_SOURCES) {
    const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.ok(source.includes(marker), `${path} is the file this scan means to read`);
    const lines = source.split('\n');
    for (const { name, re } of PINNED_MAJOR_PATTERNS) {
      const hits = lines
        .map((text, i) => ({ line: i + 1, text: text.trim() }))
        .filter(({ text }) => re.test(text))
        .map(({ line, text }) => `${path}:${line}: ${text}`);
      assert.deepEqual(hits, [], `${path} pins a Chrome major (${name})`);
    }
  }
});

// ---------------------------------------------------------------------------
// detectChromeMajor
// ---------------------------------------------------------------------------

test('5.9: detectChromeMajor prefers userAgentData', () => {
  // The brand list wins over the UA string when both are present.
  assert.equal(
    detectChromeMajor({ userAgentData: { brands: chromeBrands(RUNNING_MAJOR) }, userAgent: chromeUA(149) }),
    RUNNING_MAJOR,
  );
  // Position in the list is irrelevant (Chrome permutes it per major).
  assert.equal(
    detectChromeMajor({ userAgentData: { brands: chromeBrands(RUNNING_MAJOR).reverse() }, userAgent: chromeUA(149) }),
    RUNNING_MAJOR,
  );
  // `Google Chrome` is the brand the persona claims, so it is read first.
  assert.equal(
    detectChromeMajor({
      userAgentData: { brands: [{ brand: 'Chromium', version: '150' }, { brand: 'Google Chrome', version: '151' }] },
    }),
    151,
  );
  // A full version (`fullVersionList` shape) still yields the major.
  assert.equal(
    detectChromeMajor({ userAgentData: { brands: [{ brand: 'Chromium', version: '151.0.7204.93' }] } }),
    151,
  );
});

test('5.9: detectChromeMajor reads Chromium, never another vendor\'s version', () => {
  // Opera numbers its own brand independently of the Chromium major.
  const opera = {
    userAgentData: {
      brands: [
        { brand: 'Opera', version: '122' },
        { brand: 'Chromium', version: '138' },
        { brand: 'Not)A;Brand', version: '99' },
      ],
    },
    userAgent: `${chromeUA(138, 'Windows NT 10.0; Win64; x64')} OPR/122.0.0.0`,
  };
  assert.equal(detectChromeMajor(opera), 138);

  const edge = {
    userAgentData: {
      brands: [
        { brand: 'Microsoft Edge', version: '150' },
        { brand: 'Chromium', version: '150' },
        { brand: 'Not=A?Brand', version: '24' },
      ],
    },
  };
  assert.equal(detectChromeMajor(edge), 150);

  // A list with no Chrome brand at all falls through to the UA string, and
  // the GREASE entry's version is never mistaken for a major.
  assert.equal(
    detectChromeMajor({
      userAgentData: { brands: [{ brand: 'Not=A?Brand', version: '24' }, { brand: 'Vivaldi', version: '7' }] },
      userAgent: chromeUA(149),
    }),
    149,
  );
});

test('5.9: detectChromeMajor parses the UA string when userAgentData is absent', () => {
  // `navigator.userAgentData` only exists in secure contexts: an http:// page
  // has the UA string and nothing else.
  assert.equal(detectChromeMajor({ userAgent: chromeUA(RUNNING_MAJOR) }), RUNNING_MAJOR);
  assert.equal(
    detectChromeMajor({ userAgent: `${chromeUA(150, 'Windows NT 10.0; Win64; x64')} Edg/150.0.0.0` }),
    150,
  );
  assert.equal(
    detectChromeMajor({ userAgent: chromeUA(149).replace('Chrome/', 'HeadlessChrome/') }),
    149,
  );
  // Unreduced UA strings carry a real build number.
  assert.equal(
    detectChromeMajor({ userAgent: chromeUA(148).replace('148.0.0.0', '148.0.7103.61') }),
    148,
  );
});

test('5.9: detectChromeMajor falls back to CHROME_MAJOR_FALLBACK', () => {
  assert.ok(Number.isInteger(CHROME_MAJOR_FALLBACK), 'the fallback is an integer major');
  assert.ok(CHROME_MAJOR_FALLBACK >= 140, 'the release checklist only ever raises it');

  assert.equal(detectChromeMajor(null), CHROME_MAJOR_FALLBACK);
  assert.equal(detectChromeMajor({}), CHROME_MAJOR_FALLBACK);
  assert.equal(detectChromeMajor({ userAgent: 'Node.js/24' }), CHROME_MAJOR_FALLBACK);
  assert.equal(
    detectChromeMajor({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' }),
    CHROME_MAJOR_FALLBACK,
  );
  assert.equal(detectChromeMajor({ userAgentData: { brands: [] }, userAgent: '' }), CHROME_MAJOR_FALLBACK);
});

test('5.9: detectChromeMajor never throws on odd input and never returns a non-major', () => {
  const thrower = () => { throw new Error('hostile getter'); };
  const hostileProxy = new Proxy({}, { get: thrower, has: thrower, getOwnPropertyDescriptor: thrower });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();

  // [input, expected] — expected is the UA-derived major when the UA is usable,
  // which shows that a broken brand list does not stop the second source.
  const cases = [
    [undefined, null], // the default parameter: whatever this runtime's navigator says
    ['navigator', CHROME_MAJOR_FALLBACK],
    [42, CHROME_MAJOR_FALLBACK],
    [Symbol('nav'), CHROME_MAJOR_FALLBACK],
    [() => {}, CHROME_MAJOR_FALLBACK],
    [hostileProxy, CHROME_MAJOR_FALLBACK],
    [revoked.proxy, CHROME_MAJOR_FALLBACK],

    // userAgentData / brands of the wrong type.
    [{ userAgentData: null, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: 'brands', userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: null }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: 'Google Chrome 151' }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: { 0: { brand: 'Chromium', version: '151' }, length: 1 } }, userAgent: chromeUA(149) }, 149],

    // Entries of the wrong type, and versions that are not a major.
    [{ userAgentData: { brands: [null, undefined, 7, 'Chromium', [], {}] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ brand: 'Chromium' }] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ brand: 'Chromium', version: '' }] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ brand: 'Chromium', version: 'abc' }] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ brand: 'Chromium', version: '-5' }] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ brand: 'Chromium', version: '0' }] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ brand: 'Chromium', version: '99999999999999999999' }] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ brand: 'Chromium', version: NaN }] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ brand: 'Chromium', version: 151.5 }] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ brand: 'Chromium', version: {} }] }, userAgent: chromeUA(149) }, 149],
    // A garbage `Google Chrome` entry does not hide a usable `Chromium` one.
    [{ userAgentData: { brands: [{ brand: 'Google Chrome', version: 'x' }, { brand: 'Chromium', version: '151' }] } }, 151],
    // A numeric version is unambiguous.
    [{ userAgentData: { brands: [{ brand: 'Chromium', version: 151 }] } }, 151],

    // Throwing getters at every depth: the UA string is still consulted.
    [{ get userAgentData() { return thrower(); }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { get brands() { return thrower(); } }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ get brand() { return thrower(); } }] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: { brands: [{ brand: 'Chromium', get version() { return thrower(); } }] }, userAgent: chromeUA(149) }, 149],
    [{ userAgentData: hostileProxy, userAgent: chromeUA(149) }, 149],
    [{ get userAgent() { return thrower(); } }, CHROME_MAJOR_FALLBACK],
    // ...and a broken UA string does not hide a usable brand list.
    [{ userAgentData: { brands: chromeBrands(151) }, get userAgent() { return thrower(); } }, 151],

    // A UA that is not a string, or not a Chrome UA, or not a version.
    [{ userAgent: 151 }, CHROME_MAJOR_FALLBACK],
    [{ userAgent: { toString: thrower } }, CHROME_MAJOR_FALLBACK],
    [{ userAgent: ['Chrome/151.0.0.0'] }, CHROME_MAJOR_FALLBACK],
    [{ userAgent: 'Chrome/' }, CHROME_MAJOR_FALLBACK],
    [{ userAgent: 'Chrome/x.0.0.0' }, CHROME_MAJOR_FALLBACK],
    [{ userAgent: 'Chrome/0.0.0.0' }, CHROME_MAJOR_FALLBACK],
    [{ userAgent: `Chrome/${'9'.repeat(400)}.0.0.0` }, CHROME_MAJOR_FALLBACK],
  ];

  for (const [i, [input, expected]] of cases.entries()) {
    let major;
    assert.doesNotThrow(() => { major = detectChromeMajor(input); }, `case ${i}`);
    assert.ok(Number.isInteger(major) && major >= 1 && major <= 9999, `case ${i} returned ${String(major)}`);
    if (expected !== null) assert.equal(major, expected, `case ${i}`);
  }

  // A brand list far longer than any real one costs a bounded scan: the
  // usable entry beyond the bound is not reached, the UA string answers.
  const padded = Array.from({ length: 5000 }, () => ({ brand: 'Not=A?Brand', version: '24' }));
  padded.push({ brand: 'Chromium', version: '151' });
  assert.equal(detectChromeMajor({ userAgentData: { brands: padded }, userAgent: chromeUA(149) }), 149);
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

// The v4.9.0 literals, verbatim: `PERSONAS` in service-worker.js, and
// `PERSONAS` / `BRANDS` / the inline `uaFullVersion` in persona-spoof.js.
const V490_MAJOR = 122;
const V490_HEADER_VIEW = {
  windows: {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    chUA: '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    platform: 'Windows',
  },
  mac: {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    chUA: '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    platform: 'macOS',
  },
  linux: {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    chUA: '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    platform: 'Linux',
  },
};
const V490_BRANDS = [
  { brand: 'Chromium', version: '122' },
  { brand: 'Not(A:Brand', version: '24' },
  { brand: 'Google Chrome', version: '122' },
];
const V490_NAVIGATOR_VIEW = {
  windows: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Win32',
    uaPlatform: 'Windows',
    platformVersion: '15.0.0',
    uaFullVersion: '122.0.0.0',
    brands: V490_BRANDS,
  },
  mac: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    uaPlatform: 'macOS',
    platformVersion: '13.0.0',
    uaFullVersion: '122.0.0.0',
    brands: V490_BRANDS,
  },
  linux: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    uaPlatform: 'Linux',
    platformVersion: '6.0.0',
    uaFullVersion: '122.0.0.0',
    brands: V490_BRANDS,
  },
};

test('5.9: buildPersona keeps the v4.9.0 literal shapes — only the major moves', () => {
  // Header view: exactly the table `applyPersonaRules` reads, so the service
  // worker switches over with an import and no other edit.
  assert.deepEqual(buildPersonas(V490_MAJOR), V490_HEADER_VIEW);
  assert.deepEqual(Object.keys(buildPersonas(RUNNING_MAJOR)), PERSONA_IDS);
  for (const id of PERSONA_IDS) {
    assert.deepEqual(buildPersona(id, V490_MAJOR), V490_HEADER_VIEW[id], id);
    assert.deepEqual(buildNavigatorPersona(id, V490_MAJOR), V490_NAVIGATOR_VIEW[id], id);
    assert.deepEqual(buildPersonas(RUNNING_MAJOR)[id], buildPersona(id, RUNNING_MAJOR), id);
  }

  // Nothing but the major differs between two majors, in either view.
  const moved = (value) => JSON.stringify(value).replaceAll(String(V490_MAJOR), String(RUNNING_MAJOR));
  assert.equal(JSON.stringify(buildPersonas(RUNNING_MAJOR)), moved(buildPersonas(V490_MAJOR)));
  for (const id of PERSONA_IDS) {
    assert.equal(
      JSON.stringify(buildNavigatorPersona(id, RUNNING_MAJOR)),
      moved(buildNavigatorPersona(id, V490_MAJOR)),
      id,
    );
    assert.match(buildPersona(id, RUNNING_MAJOR).ua, /Chrome\/151\.0\.0\.0 /, id);
  }
});

test('5.9: the header view and the navigator view describe the same browser', () => {
  for (const major of [V490_MAJOR, CHROME_MAJOR_FALLBACK, RUNNING_MAJOR]) {
    for (const id of PERSONA_IDS) {
      const header = buildPersona(id, major);
      const nav = buildNavigatorPersona(id, major);
      const where = `${id}@${major}`;

      assert.equal(header.ua, nav.userAgent, `${where}: one UA string`);
      assert.equal(header.platform, nav.uaPlatform, `${where}: sec-ch-ua-platform is userAgentData.platform`);
      assert.equal(
        header.chUA,
        nav.brands.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', '),
        `${where}: sec-ch-ua is the serialised brand list`,
      );
      assert.equal(nav.uaFullVersion, `${major}.0.0.0`, where);
      assert.ok(nav.userAgent.includes(`Chrome/${nav.uaFullVersion} `), `${where}: the UA carries uaFullVersion`);
      for (const name of ['Chromium', 'Google Chrome']) {
        assert.equal(nav.brands.find((b) => b.brand === name)?.version, String(major), `${where}: ${name}`);
      }
    }
  }
});

test('5.9: an unknown persona id builds nothing', () => {
  const unknown = [
    'default', '', 'Windows', 'WINDOWS', ' windows', 'solaris',
    'constructor', '__proto__', 'toString', 'hasOwnProperty',
    undefined, null, 0, 1, true, {}, [], ['windows'], Symbol('windows'),
    { toString() { throw new Error('hostile id'); } },
  ];
  for (const [i, id] of unknown.entries()) {
    assert.equal(buildPersona(id, RUNNING_MAJOR), null, `buildPersona, unknown id #${i}`);
    assert.equal(buildNavigatorPersona(id, RUNNING_MAJOR), null, `buildNavigatorPersona, unknown id #${i}`);
  }
  assert.deepEqual(Object.keys(buildPersonas(RUNNING_MAJOR)), PERSONA_IDS, 'the table holds the three personas and nothing else');
  assert.equal(buildPersonas(RUNNING_MAJOR).default, undefined);
});

test('5.9: a major that is not one falls back instead of producing a malformed UA', () => {
  const fallback = buildPersona('windows', CHROME_MAJOR_FALLBACK);
  const fallbackNav = buildNavigatorPersona('windows', CHROME_MAJOR_FALLBACK);
  const garbage = [
    undefined, null, NaN, Infinity, -Infinity, 0, -1, 151.5, 10000, 1e21,
    '', 'abc', '-151', {}, [], [151], true, Symbol('151'),
    { valueOf() { throw new Error('hostile major'); } },
  ];
  for (const [i, major] of garbage.entries()) {
    assert.deepEqual(buildPersona('windows', major), fallback, `buildPersona, garbage major #${i}`);
    assert.deepEqual(buildNavigatorPersona('windows', major), fallbackNav, `buildNavigatorPersona, garbage major #${i}`);
    assert.deepEqual(buildPersonas(major), buildPersonas(CHROME_MAJOR_FALLBACK), `buildPersonas, garbage major #${i}`);
  }
  // What detectChromeMajor returns — and the string spellings of it — is used.
  assert.match(buildPersona('windows', RUNNING_MAJOR).ua, /Chrome\/151\.0\.0\.0 /);
  assert.match(buildPersona('windows', '151').ua, /Chrome\/151\.0\.0\.0 /);
  assert.match(buildPersona('windows', '151.0.7204.93').ua, /Chrome\/151\.0\.0\.0 /);
  assert.notDeepEqual(buildPersona('windows', RUNNING_MAJOR), fallback);
});

test('5.9: every build returns fresh objects', () => {
  // The brand array is handed to the page as navigator.userAgentData.brands;
  // a page that mutates it must not reach the next persona built.
  const first = buildNavigatorPersona('windows', RUNNING_MAJOR);
  first.brands.push({ brand: 'Injected', version: '1' });
  first.brands[0].version = '1';
  first.userAgent = 'mutated';
  const second = buildNavigatorPersona('windows', RUNNING_MAJOR);
  assert.notEqual(second, first);
  assert.notEqual(second.brands, first.brands);
  assert.equal(second.brands.length, 3);
  assert.equal(second.brands[0].version, String(RUNNING_MAJOR));
  assert.match(second.userAgent, /Chrome\/151\.0\.0\.0 /);

  const table = buildPersonas(RUNNING_MAJOR);
  table.windows.ua = 'mutated';
  delete table.mac;
  assert.match(buildPersonas(RUNNING_MAJOR).windows.ua, /Chrome\/151\.0\.0\.0 /);
  assert.ok(buildPersonas(RUNNING_MAJOR).mac);
  assert.match(buildPersona('windows', RUNNING_MAJOR).ua, /Chrome\/151\.0\.0\.0 /);
});

// ---------------------------------------------------------------------------
// The scriptlet consumer, end to end
// ---------------------------------------------------------------------------

/**
 * Stand up the running browser as the page sees it: accessors on
 * `Navigator.prototype`, the way Chrome defines them. `brands: null` models a
 * non-secure context, where `navigator.userAgentData` does not exist.
 */
function installBrowser({ userAgent, brands = null } = {}) {
  class Navigator {}
  const define = (key, value) => Object.defineProperty(Navigator.prototype, key, {
    configurable: true,
    enumerable: true,
    get() { return value; },
  });
  if (userAgent !== undefined) define('userAgent', userAgent);
  define('platform', 'Linux x86_64');
  if (brands) {
    define('userAgentData', {
      brands,
      mobile: false,
      platform: 'Linux',
      async getHighEntropyValues() {
        return {
          brands,
          mobile: false,
          platform: 'Linux',
          architecture: 'arm',
          bitness: '32',
          model: 'Pixel',
          platformVersion: '6.8.0',
          uaFullVersion: '151.0.7204.93',
          fullVersionList: brands.map((b) => ({ ...b, version: `${b.version}.0.7204.93` })),
        };
      },
    });
  }
  globalThis.Navigator = Navigator;
  // Node ships a getter-only `navigator` global; replace it wholesale.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: new Navigator(),
  });
}

// A query string yields a fresh module instance, so every test gets its own
// `appliedPersona` guard instead of depending on the order tests run in.
let instance = 0;
async function freshPersonaSpoof() {
  const mod = await import(`../scriptlets/persona-spoof.js?instance=${++instance}`);
  return mod.personaSpoof;
}

const majorsIn = (brands) => brands
  .filter((b) => b.brand === 'Chromium' || b.brand === 'Google Chrome')
  .map((b) => b.version);

test('5.9: persona-spoof reports the running major on every surface it spoofs', async () => {
  installBrowser({ userAgent: chromeUA(RUNNING_MAJOR), brands: chromeBrands(RUNNING_MAJOR) });
  assert.equal(detectChromeMajor(), RUNNING_MAJOR, 'the default parameter reads globalThis.navigator');

  const personaSpoof = await freshPersonaSpoof();
  personaSpoof('windows');

  assert.equal(navigator.userAgent, chromeUA(RUNNING_MAJOR, 'Windows NT 10.0; Win64; x64'));
  assert.equal(navigator.appVersion, navigator.userAgent.replace('Mozilla/5.0 ', ''));
  assert.equal(navigator.platform, 'Win32');

  const uaData = navigator.userAgentData;
  assert.equal(uaData.platform, 'Windows');
  assert.equal(uaData.mobile, false);
  assert.deepEqual(majorsIn(uaData.brands), ['151', '151']);
  assert.deepEqual(majorsIn(uaData.toJSON().brands), ['151', '151']);
  assert.equal(uaData.toJSON().platform, 'Windows');

  const high = await uaData.getHighEntropyValues([
    'platformVersion', 'architecture', 'bitness', 'model', 'uaFullVersion', 'fullVersionList',
  ]);
  assert.equal(high.uaFullVersion, '151.0.0.0');
  assert.deepEqual(majorsIn(high.fullVersionList), ['151', '151']);
  // Didn't re-break: the persona's non-version hints are what they were.
  assert.equal(high.platformVersion, '15.0.0');
  assert.equal(high.architecture, 'x86');
  assert.equal(high.bitness, '64');
  assert.equal(high.model, '');
  // Hints that were not asked for are passed through from the real browser.
  const partial = await uaData.getHighEntropyValues(['bitness']);
  assert.equal(partial.bitness, '64');
  assert.equal(partial.uaFullVersion, '151.0.7204.93');

  // The header rule and the page agree, because both come from one module.
  const header = buildPersona('windows', RUNNING_MAJOR);
  assert.equal(navigator.userAgent, header.ua);
  assert.equal(uaData.platform, header.platform);

  // A second persona applied over the first detects the major from surfaces
  // the first one already spoofed — and still lands on the running major.
  personaSpoof('mac');
  assert.equal(navigator.userAgent, chromeUA(RUNNING_MAJOR, 'Macintosh; Intel Mac OS X 10_15_7'));
  assert.equal(navigator.platform, 'MacIntel');
  assert.equal(navigator.userAgentData.platform, 'macOS');
  assert.deepEqual(majorsIn(navigator.userAgentData.brands), ['151', '151']);
});

test('5.9: persona-spoof reads the UA string on a page without userAgentData', async () => {
  installBrowser({ userAgent: chromeUA(149) });

  const personaSpoof = await freshPersonaSpoof();
  personaSpoof('mac');

  assert.equal(navigator.userAgent, chromeUA(149, 'Macintosh; Intel Mac OS X 10_15_7'));
  assert.equal(navigator.platform, 'MacIntel');
  // Didn't re-break: the scriptlet does not invent an API the context lacks.
  assert.equal(navigator.userAgentData, undefined);
});

test('5.9: persona-spoof on a browser it cannot identify uses CHROME_MAJOR_FALLBACK', async () => {
  installBrowser({});

  const personaSpoof = await freshPersonaSpoof();
  personaSpoof('linux');

  assert.equal(navigator.userAgent, chromeUA(CHROME_MAJOR_FALLBACK));
  assert.equal(navigator.platform, 'Linux x86_64');
});

test('5.9 (didn\'t re-break): a default or unknown persona leaves the navigator alone', async () => {
  installBrowser({ userAgent: chromeUA(RUNNING_MAJOR), brands: chromeBrands(RUNNING_MAJOR) });
  const realUaData = navigator.userAgentData;

  const personaSpoof = await freshPersonaSpoof();
  personaSpoof();
  personaSpoof('default');
  personaSpoof('solaris');

  assert.equal(navigator.userAgent, chromeUA(RUNNING_MAJOR));
  assert.equal(navigator.platform, 'Linux x86_64');
  assert.equal(navigator.userAgentData, realUaData);
  assert.equal('appVersion' in navigator, false);

  // ...and none of those calls armed the once-per-persona guard.
  personaSpoof('windows');
  assert.equal(navigator.platform, 'Win32');
});
