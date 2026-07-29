/**
 * Shared filter-syntax vectors.
 *
 * Nullify parses ABP syntax in three independent places — the build script
 * (scripts/build-rules.mjs), the runtime service worker (src/shared/
 * filter-parser.js) and the Rust core (wasm-core/src/lib.rs). They have
 * drifted repeatedly, and every divergence is a silent behaviour change: the
 * same filter line means one thing at build time and another at runtime.
 *
 * These vectors are the single source of truth for what each line means. Any
 * engine that can be driven from Node asserts against them; see
 * tests/parser-parity.test.mjs.
 *
 * `kind` values:
 *   cosmetic | scriptlet | network | skip
 *
 * `domains` are the hostnames a rule applies to. `excludedDomains` are the
 * hostnames it must NOT apply to (the `~` prefix), which is a distinct field
 * precisely because folding them into `domains` inverts their meaning.
 */

export const FILTER_VECTORS = [
  // --- plain cosmetic -----------------------------------------------------
  {
    line: 'example.com##.ad',
    expect: { kind: 'cosmetic', domains: ['example.com'], excludedDomains: [], selector: '.ad', exception: false },
  },
  {
    line: '##.generic-ad',
    expect: { kind: 'cosmetic', domains: [], excludedDomains: [], selector: '.generic-ad', exception: false },
  },
  {
    line: 'example.com#@#.false-positive',
    expect: { kind: 'cosmetic', domains: ['example.com'], excludedDomains: [], selector: '.false-positive', exception: true },
  },
  {
    line: 'example.com#?#div:has(.ad)',
    expect: { kind: 'cosmetic', domains: ['example.com'], excludedDomains: [], selector: 'div:has(.ad)', exception: false },
  },
  {
    line: 'a.com,b.com##.shared-ad',
    expect: { kind: 'cosmetic', domains: ['a.com', 'b.com'], excludedDomains: [], selector: '.shared-ad', exception: false },
  },

  // --- wildcard-TLD scoping ----------------------------------------------
  // These must classify as cosmetic/scriptlet. Treating them as network rules
  // shipped 3,130 garbage block rules whose urlFilter was the whole line.
  {
    line: 'read.amazon.*##.kw-ads-ftue-container',
    expect: { kind: 'cosmetic', domains: ['read.amazon.*'], excludedDomains: [], selector: '.kw-ads-ftue-container', exception: false },
  },
  {
    line: 'costco.*##+js(set, adsEnabled, false)',
    expect: { kind: 'scriptlet', domains: ['costco.*'], excludedDomains: [], name: 'set', args: ['adsEnabled', 'false'] },
  },

  // --- scriptlets ---------------------------------------------------------
  {
    line: 'example.com##+js(aopr, adBlockDetected)',
    expect: { kind: 'scriptlet', domains: ['example.com'], excludedDomains: [], name: 'aopr', args: ['adBlockDetected'] },
  },
  {
    line: '##+js(nowebrtc)',
    expect: { kind: 'scriptlet', domains: [], excludedDomains: [], name: 'nowebrtc', args: [] },
  },

  // --- ~domain exclusions -------------------------------------------------
  // Folding a `~` domain into `domains` inverts its meaning: the rule then
  // applies precisely where the author excluded it. The ancestor walk at
  // lookup makes it worse — a rule keyed `youtube.com` matches
  // music.youtube.com, which is the subdomain the `~` was protecting.
  {
    line: 'example.com,~mail.example.com##.promo',
    expect: {
      kind: 'cosmetic',
      domains: ['example.com'],
      excludedDomains: ['mail.example.com'],
      selector: '.promo',
      exception: false,
    },
  },
  {
    line: 'youtube.com,~music.youtube.com##+js(set, yt.ads, false)',
    expect: {
      kind: 'scriptlet',
      domains: ['youtube.com'],
      excludedDomains: ['music.youtube.com'],
      name: 'set',
      args: ['yt.ads', 'false'],
    },
  },
  {
    // Pure negation is a generic rule with an exclusion — "everywhere except".
    // Keying it under the literal "~example.com" made it apply nowhere.
    line: '~example.com##.ad',
    expect: {
      kind: 'cosmetic',
      domains: [],
      excludedDomains: ['example.com'],
      selector: '.ad',
      exception: false,
    },
  },
  {
    line: '~a.com,~b.com##.ad',
    expect: {
      kind: 'cosmetic',
      domains: [],
      excludedDomains: ['a.com', 'b.com'],
      selector: '.ad',
      exception: false,
    },
  },

  // --- scriptlet exceptions -----------------------------------------------
  // `#@#+js(...)` disables a scriptlet on a site. Every engine misparsed it,
  // each differently: the runtime and build parsers produced a cosmetic
  // exception whose "selector" was `+js(name)` and so matched nothing, while
  // the Rust parser matched the `#+js(` substring inside `#@#+js(` and created
  // an *active* scriptlet under the garbage domain "example.com#@". uAssets
  // ships these to turn off scriptlets that break specific sites.
  {
    line: 'example.com#@#+js(nowebrtc)',
    expect: {
      kind: 'scriptlet-exception',
      domains: ['example.com'],
      excludedDomains: [],
      name: 'nowebrtc',
    },
  },
  {
    line: 'example.com#@#+js(set, adsEnabled, false)',
    expect: {
      kind: 'scriptlet-exception',
      domains: ['example.com'],
      excludedDomains: [],
      name: 'set',
    },
  },
  {
    // Domain-less form disables the scriptlet everywhere.
    line: '#@#+js(nowebrtc)',
    expect: {
      kind: 'scriptlet-exception',
      domains: [],
      excludedDomains: [],
      name: 'nowebrtc',
    },
  },

  // --- comments and blanks ------------------------------------------------
  { line: '! a comment', expect: { kind: 'skip' } },
  { line: '[Adblock Plus 2.0]', expect: { kind: 'skip' } },
  { line: '', expect: { kind: 'skip' } },

  // --- network (build engine only; the runtime parser ignores these) ------
  { line: '||ads.example.com^', expect: { kind: 'network' } },
  { line: '||ads.example.com^$script,third-party', expect: { kind: 'network' } },
  { line: '@@||safe.example.com^', expect: { kind: 'network' } },
];
