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

  // --- scriptlet argument quoting (§5.17) ---------------------------------
  // Quote characters in an argument's interior are data and must survive;
  // deleting them turns `div[id='ad']` into the different selector
  // `div[id=ad]`. Only one *surrounding* quote pair is stripped, and a quoted
  // comma does not split. The Rust engine mirrors these exact cases in
  // wasm-core/src/lib.rs (`scriptlet_args_preserve_interior_quotes`).
  {
    line: "example.com##+js(set, div[id='ad'], x)",
    expect: {
      kind: 'scriptlet',
      domains: ['example.com'],
      excludedDomains: [],
      name: 'set',
      args: ["div[id='ad']", 'x'],
    },
  },
  {
    line: "example.com##+js(foo, 'a, b', c)",
    expect: {
      kind: 'scriptlet',
      domains: ['example.com'],
      excludedDomains: [],
      name: 'foo',
      args: ['a, b', 'c'],
    },
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

  // --- cosmetic-scope exceptions and their short aliases (§4.7) -----------
  // `@@…$generichide` and friends turn cosmetic filtering off for a domain.
  // uBO accepts a short spelling of each and uAssets uses them heavily —
  // unbreak.txt ships an entire `$ghide` section. The build parser learned the
  // aliases; the runtime parser did not, so every short-form line parsed to
  // null at runtime and the domains uBO excepts from generic hiding kept
  // getting generic cosmetics applied. There was no vector here, which is why
  // the parity suite passed through the whole divergence.
  //
  // `expect` is the shape parser-parity's canonicalizer reduces this rule type
  // to. `scopeException` carries the part that canonicalization drops — the
  // alias must normalise to its canonical name, and to the RIGHT one — and is
  // asserted against both engines in src/shared/filter-parser.test.mjs.
  {
    line: '@@||example.com^$generichide',
    expect: { kind: 'cosmetic-scope-exception' },
    scopeException: { domains: ['example.com'], scopes: ['generichide'] },
  },
  {
    line: '@@||example.com^$ghide',
    expect: { kind: 'cosmetic-scope-exception' },
    scopeException: { domains: ['example.com'], scopes: ['generichide'] },
  },
  {
    line: '@@||example.com^$elemhide',
    expect: { kind: 'cosmetic-scope-exception' },
    scopeException: { domains: ['example.com'], scopes: ['elemhide'] },
  },
  {
    line: '@@||example.com^$ehide',
    expect: { kind: 'cosmetic-scope-exception' },
    scopeException: { domains: ['example.com'], scopes: ['elemhide'] },
  },
  {
    line: '@@||example.com^$specifichide',
    expect: { kind: 'cosmetic-scope-exception' },
    scopeException: { domains: ['example.com'], scopes: ['specifichide'] },
  },
  {
    line: '@@||example.com^$shide',
    expect: { kind: 'cosmetic-scope-exception' },
    scopeException: { domains: ['example.com'], scopes: ['specifichide'] },
  },
  {
    // Real unbreak.txt shape: alias plus a domain= list.
    line: '@@||cdn.example.net^$ghide,domain=example.com|example.org',
    expect: { kind: 'cosmetic-scope-exception' },
    scopeException: {
      domains: ['cdn.example.net', 'example.com', 'example.org'],
      scopes: ['generichide'],
    },
  },

  // --- `+js(...)` must END the line (§5.14a) -------------------------------
  // Both JS parsers match /^([^#]*)#(?:#\+js\(|\+js\()(.+)\)$/ and, when that
  // fails, fall through to the plain `##`/`#@#` branches — so trailing text
  // after the closing paren makes the line an inert cosmetic rule whose
  // "selector" is the literal `+js(...)` text. Rust took `rfind(')')` from
  // anywhere in the line and ran the scriptlet for real, so whether a user got
  // code execution depended on whether WASM initialized. The JS reading is the
  // safer one and is now what all three engines implement.
  {
    line: 'example.com##+js(foo) extra',
    expect: {
      kind: 'cosmetic',
      domains: ['example.com'],
      excludedDomains: [],
      selector: '+js(foo) extra',
      exception: false,
    },
  },
  {
    line: 'example.com#@#+js(foo) extra',
    expect: {
      kind: 'cosmetic',
      domains: ['example.com'],
      excludedDomains: [],
      selector: '+js(foo) extra',
      exception: true,
    },
  },
  {
    // `(.+)` requires at least one argument character.
    line: 'example.com##+js()',
    expect: {
      kind: 'cosmetic',
      domains: ['example.com'],
      excludedDomains: [],
      selector: '+js()',
      exception: false,
    },
  },
  {
    // The guard is "ends with )", not "contains no )": a `)` inside an
    // argument is ordinary data as long as one also terminates the line.
    line: 'example.com##+js(rmnt, script, /foo)bar/)',
    expect: {
      kind: 'scriptlet',
      domains: ['example.com'],
      excludedDomains: [],
      name: 'rmnt',
      args: ['script', '/foo)bar/'],
    },
  },

  // --- domain case (§5.14b) -----------------------------------------------
  // parseLine preserves the domain text as written; the engines diverge one
  // step later, at KEYING. Rust lowercases the key (push_unique_domain_selector),
  // so the rule lands in the bucket the lookup walk — which lowercases the
  // hostname — actually asks for. The JS ingestion path keys the raw token, so
  // the same filter is dead there. Rust's behaviour is the correct one;
  // `splitDomainList` in src/shared/filter-syntax.js needs the same fold, at
  // which point this vector's `domains` becomes ['example.com'].
  // tests/wasm-parity.test.mjs asserts the lowercased key against the real
  // WASM bundle. The selector's own case is data and must survive untouched.
  {
    line: 'EXAMPLE.com##.Ad',
    expect: {
      kind: 'cosmetic',
      domains: ['EXAMPLE.com'],
      excludedDomains: [],
      selector: '.Ad',
      exception: false,
    },
  },

  // --- `;` inside a procedural argument (§5.14c) ---------------------------
  // `;` is CSS-injection material only where the text is CSS. A procedural
  // operator's argument is a regex/XPath/text needle, so a `;` in it is an
  // ordinary character. Both JS engines ingested these; Rust's carve-out named
  // `:style(` alone and dropped the rest, so the WASM path silently lost rules
  // the JS path kept.
  {
    line: 'example.com#?#div:has-text(/ad;box/)',
    expect: {
      kind: 'cosmetic',
      domains: ['example.com'],
      excludedDomains: [],
      selector: 'div:has-text(/ad;box/)',
      exception: false,
    },
  },

  // --- shapes that parse as cosmetic but must never reach CSS (§5.13) ------
  // All three parsers classify these identically; the divergence they guard is
  // one layer down, at the CSS-safety gate. Up to 100 selectors are joined
  // into a single declaration, so one invalid selector invalidates all 100 in
  // the browser — 99 legitimate hide rules failing open. A leading combinator
  // and a prefix-matched pseudo-element (`::before2` is not `::before`) both
  // used to pass that gate.
  {
    line: 'example.com##> .ad',
    expect: {
      kind: 'cosmetic',
      domains: ['example.com'],
      excludedDomains: [],
      selector: '> .ad',
      exception: false,
    },
  },
  {
    line: 'example.com##div::before2',
    expect: {
      kind: 'cosmetic',
      domains: ['example.com'],
      excludedDomains: [],
      selector: 'div::before2',
      exception: false,
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
