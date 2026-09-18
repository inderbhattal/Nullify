/**
 * personas.js — the one definition of the stealth personas.
 *
 * A persona claims a different *operating system* while staying the browser
 * the user really runs. It is applied on two surfaces, which must tell the
 * same story:
 *
 *   - request headers — the service worker's persona DNR rule sets
 *     `user-agent`, `sec-ch-ua` and `sec-ch-ua-platform`;
 *   - the page — the MAIN-world `persona-spoof` scriptlet redefines
 *     `navigator.userAgent`, `.appVersion`, `.platform` and `.userAgentData`.
 *
 * Why one module (docs/REVIEW-2026-09.md §5.9): each surface kept its own
 * literal table, and both were frozen at Chrome 122. A UA and `sec-ch-ua`
 * claiming a two-year-old Chrome is a beacon, not camouflage, and some sites
 * gate on the major. The major is now read from the running browser and the
 * persona strings are spelled here and nowhere else.
 *
 * Exports
 *   CHROME_MAJOR_FALLBACK            major used when the browser cannot be read
 *   detectChromeMajor(nav?)          → integer major; never throws
 *   buildPersona(id, major)          → { ua, chUA, platform } | null
 *   buildPersonas(major)             → { windows, mac, linux } of the above
 *   buildNavigatorPersona(id, major) → { userAgent, platform, uaPlatform,
 *                                        platformVersion, uaFullVersion,
 *                                        brands } | null
 *
 * Two views, because the two consumers already used the key `platform` for
 * different things and neither should have to change meaning: in the header
 * view it is the `sec-ch-ua-platform` value (`Windows`), in the navigator view
 * it is `navigator.platform` (`Win32`) and the client-hint value is
 * `uaPlatform`. Both views are built from the same table and the same brand
 * list, so they cannot drift (pinned by `personas.test.mjs`).
 *
 * Service worker (A2e) — `buildPersonas()` returns the table `applyPersonaRules`
 * already reads, key for key, so the switch is an import and one line:
 *
 *   import { buildPersonas, detectChromeMajor } from '../shared/personas.js';
 *   const PERSONAS = buildPersonas(detectChromeMajor());
 *
 * Plain ESM, no DOM, no side effects and no state at import: it loads in the
 * service worker, in the MAIN-world scriptlet bundle and in Node alike. Every
 * export is total — garbage in yields the fallback major or `null`, never a
 * throw — because the worker evaluates this at start-up, where a throw is an
 * extension-wide outage. Builders return fresh objects on every call; the
 * brand array ends up in the page's hands.
 */

/**
 * Major claimed when neither `userAgentData` nor the UA string yields one —
 * which no real Chrome does. Raised by the release checklist.
 */
export const CHROME_MAJOR_FALLBACK = 140;

const MAX_MAJOR = 9999;

// A real brand list carries three entries. The bound only keeps a page that
// hands us a million-entry array from costing anything.
const MAX_BRANDS_SCANNED = 16;

// `Google Chrome` first: it is the brand the persona claims. `Chromium` covers
// every other Chromium browser — Edge, Brave and Opera list their own brand
// under their own version number, which is not the Chromium major.
const CHROME_BRANDS = ['Google Chrome', 'Chromium'];

/** A major as an integer in [1, MAX_MAJOR], or 0 for anything that is not one. */
function toMajor(value) {
  let major = NaN;
  if (typeof value === 'number') {
    major = value;
  } else if (typeof value === 'string') {
    // `151`, and the `151.0.7204.93` of a full version list.
    const match = /^\s*(\d+)/.exec(value);
    if (match) major = Number(match[1]);
  }
  return Number.isInteger(major) && major >= 1 && major <= MAX_MAJOR ? major : 0;
}

function majorFromBrands(nav) {
  const brands = nav?.userAgentData?.brands;
  if (!Array.isArray(brands)) return 0;
  const count = Math.min(brands.length, MAX_BRANDS_SCANNED);
  for (const wanted of CHROME_BRANDS) {
    for (let i = 0; i < count; i++) {
      const entry = brands[i];
      if (entry?.brand !== wanted) continue;
      const major = toMajor(entry.version);
      if (major) return major;
    }
  }
  return 0;
}

function majorFromUserAgent(nav) {
  const ua = nav?.userAgent;
  if (typeof ua !== 'string') return 0;
  const match = /Chrome\/(\d+)/.exec(ua);
  return match ? toMajor(match[1]) : 0;
}

/**
 * The running browser's Chrome major: from `userAgentData.brands` where the
 * brand is `Google Chrome` or `Chromium`, else from the UA string (the only
 * source on a non-secure page, where `userAgentData` does not exist), else
 * `CHROME_MAJOR_FALLBACK`.
 *
 * In the MAIN world `nav` is page-controlled, so every read is guarded: a
 * throwing getter or a revoked proxy moves on to the next source. A page that
 * lies about its own major only deceives itself.
 */
export function detectChromeMajor(nav = globalThis.navigator) {
  for (const read of [majorFromBrands, majorFromUserAgent]) {
    try {
      const major = read(nav);
      if (major) return major;
    } catch {
      // Hostile or broken navigator — try the next source.
    }
  }
  return CHROME_MAJOR_FALLBACK;
}

// What differs between personas. Everything that carries the major is built
// from these by the functions below.
const SYSTEMS = {
  windows: {
    uaSystem: 'Windows NT 10.0; Win64; x64',
    navigatorPlatform: 'Win32',
    uaPlatform: 'Windows',
    platformVersion: '15.0.0',
  },
  mac: {
    uaSystem: 'Macintosh; Intel Mac OS X 10_15_7',
    navigatorPlatform: 'MacIntel',
    uaPlatform: 'macOS',
    platformVersion: '13.0.0',
  },
  linux: {
    uaSystem: 'X11; Linux x86_64',
    navigatorPlatform: 'Linux x86_64',
    uaPlatform: 'Linux',
    platformVersion: '6.0.0',
  },
};

// Own keys only, strings only: `constructor` is not a persona, and a
// non-string id is never coerced (a hostile `toString` would throw).
function systemFor(id) {
  return typeof id === 'string' && Object.hasOwn(SYSTEMS, id) ? SYSTEMS[id] : null;
}

function normalizeMajor(major) {
  return toMajor(major) || CHROME_MAJOR_FALLBACK;
}

// Reduced-UA form: Chrome itself reports `<major>.0.0.0` in the UA string.
function fullVersionFor(major) {
  return `${major}.0.0.0`;
}

function userAgentFor(system, major) {
  return `Mozilla/5.0 (${system.uaSystem}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersionFor(major)} Safari/537.36`;
}

// The one brand list. `sec-ch-ua` is its serialisation and
// `navigator.userAgentData.brands` is the list itself.
function brandsFor(major) {
  return [
    { brand: 'Chromium', version: String(major) },
    { brand: 'Not(A:Brand', version: '24' },
    { brand: 'Google Chrome', version: String(major) },
  ];
}

function serializeBrands(brands) {
  return brands.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', ');
}

/**
 * Header view of one persona — the keys the service worker's
 * `applyPersonaRules` reads: `ua` (`user-agent`), `chUA` (`sec-ch-ua`) and
 * `platform` (`sec-ch-ua-platform`, unquoted). `null` for an unknown id,
 * `default` included. A `major` that is not one yields the fallback major.
 */
export function buildPersona(id, major) {
  const system = systemFor(id);
  if (!system) return null;
  const chromeMajor = normalizeMajor(major);
  return {
    ua: userAgentFor(system, chromeMajor),
    chUA: serializeBrands(brandsFor(chromeMajor)),
    platform: system.uaPlatform,
  };
}

/** The header view of every persona, keyed by id — the service worker's table. */
export function buildPersonas(major) {
  const personas = {};
  for (const id of Object.keys(SYSTEMS)) {
    personas[id] = buildPersona(id, major);
  }
  return personas;
}

/**
 * Navigator view of one persona — the keys the `persona-spoof` scriptlet
 * reads. Here `platform` is `navigator.platform` and `uaPlatform` is
 * `userAgentData.platform`. `null` for an unknown id, `default` included.
 */
export function buildNavigatorPersona(id, major) {
  const system = systemFor(id);
  if (!system) return null;
  const chromeMajor = normalizeMajor(major);
  return {
    userAgent: userAgentFor(system, chromeMajor),
    platform: system.navigatorPlatform,
    uaPlatform: system.uaPlatform,
    platformVersion: system.platformVersion,
    uaFullVersion: fullVersionFor(chromeMajor),
    brands: brandsFor(chromeMajor),
  };
}
