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

  // --- native functional pseudo-classes (§3.2 must-not-change) -----------
  // These are CSS, not procedural operators. They must classify as cosmetic
  // in every parser and survive the CSS-safety gate in the Rust joiners; the
  // gate now refuses unknown functional pseudo-classes and must not take
  // these with it.
  {
    line: 'example.com##div:not(.x)',
    expect: { kind: 'cosmetic', domains: ['example.com'], excludedDomains: [], selector: 'div:not(.x)', exception: false },
  },
  {
    line: 'example.com##div:is(.a, .b)',
    expect: { kind: 'cosmetic', domains: ['example.com'], excludedDomains: [], selector: 'div:is(.a, .b)', exception: false },
  },
  {
    line: 'example.com##div:where(.a)',
    expect: { kind: 'cosmetic', domains: ['example.com'], excludedDomains: [], selector: 'div:where(.a)', exception: false },
  },
  {
    line: 'example.com##li:nth-child(2n+1)',
    expect: { kind: 'cosmetic', domains: ['example.com'], excludedDomains: [], selector: 'li:nth-child(2n+1)', exception: false },
  },
  {
    line: 'example.com##p:nth-of-type(2)',
    expect: { kind: 'cosmetic', domains: ['example.com'], excludedDomains: [], selector: 'p:nth-of-type(2)', exception: false },
  },
  {
    line: '##:lang(en) .ad',
    expect: { kind: 'cosmetic', domains: [], excludedDomains: [], selector: ':lang(en) .ad', exception: false },
  },
  {
    line: 'example.com##div:has(a[href*="/ads/"]):not(.keep)',
    expect: { kind: 'cosmetic', domains: ['example.com'], excludedDomains: [], selector: 'div:has(a[href*="/ads/"]):not(.keep)', exception: false },
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
  // All three engines case-fold the domain key, because the lookup walk folds
  // the hostname. Rust always did (push_unique_domain_selector); the JS engines
  // kept the author's case and so keyed `EXAMPLE.com##.Ad` under a bucket no
  // hostname can equal — dead in JS, live in Rust, from one line.
  // tests/wasm-parity.test.mjs asserts the same key against the real WASM
  // bundle. The selector's own case is data and must survive untouched.
  {
    line: 'EXAMPLE.com##.Ad',
    expect: {
      kind: 'cosmetic',
      domains: ['example.com'],
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

  // --- scriptlet argument splitting (§5.38) --------------------------------
  // Both live uBO YouTube rules, verbatim. Each broke a different way before
  // the three splitters were reconciled: the first shredded into five
  // arguments under Rust (leaving propsToMatch as `/`, matching every YouTube
  // XHR) and collapsed into one under both JS parsers; the second lost its
  // trailing quote to an unpaired-quote strip, so `json:"visible` failed to
  // parse and the value fell back to the raw string.
  {
    line: String.raw`www.youtube.com##+js(trusted-replace-xhr-response, /"adPlacements.*?([A-Z]"\}|"\}{2\,4})\}\]\,/, , /playlist\?list=|\/player(?:\?.+)?$|watch\?[tv]=/)`,
    expect: {
      kind: 'scriptlet',
      domains: ['www.youtube.com'],
      excludedDomains: [],
      name: 'trusted-replace-xhr-response',
      args: [
        String.raw`/"adPlacements.*?([A-Z]"\}|"\}{2,4})\}\],/`,
        '',
        String.raw`/playlist\?list=|\/player(?:\?.+)?$|watch\?[tv]=/`,
      ],
    },
  },
  {
    line: 'm.youtube.com##+js(trusted-set, document.visibilityState, json:"visible")',
    expect: {
      kind: 'scriptlet',
      domains: ['m.youtube.com'],
      excludedDomains: [],
      name: 'trusted-set',
      args: ['document.visibilityState', 'json:"visible"'],
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

/**
 * Network-option vectors (§3.3).
 *
 * A separate class from `FILTER_VECTORS`: those pin *classification* across
 * the parsers; these pin what a network line COMPILES to — drop or emit, and
 * for the mapped modifiers the DNR condition — across the three compilers
 * that turn a user's line into a DNR rule: the build's `networkFilterToDNR`,
 * the Rust core's `compile_user_filters`, and the SW's WASM-down fallback
 * `parseSimpleNetworkRule`.
 *
 * `expect.emit` is the specification (REMEDIATION-2026-09 §3.3 table).
 * `expect.condition`, when present, is the DNR condition the Rust compiler
 * must produce (`isUrlFilterCaseSensitive` omitted unless `$match-case`).
 *
 * `expect.build`, when present, pins the build engine's CURRENT answer where
 * it is known to differ from the specification, with the reason — `emit`,
 * and `condition` where the build emits both before and after the fix so
 * the flag alone could not go stale. Two kinds:
 *  - dated: the build catches up later. None remain after D1 (release 2):
 *    `$all` (D1a §4.1), `$to=`/`$from=`/`$denyallow=`/`$method=`/scoped `*`
 *    (D1b §4.2), digit-first option lists, `~domain=`, `~` entries and
 *    contradictory type lists (D1c §7.1/§7.7). A dated pin's answer stops
 *    matching when the build catches up and the parity test fails until
 *    the pin is removed.
 *  - permanent: user filters have no resource library and no punycoder
 *    (`$redirect=`, literal `$removeparam=`, non-ASCII `$domain=`).
 * The runtime fallback is allowed to be stricter than the build (drop where
 * it emits) but never looser.
 */
const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
];

export const NETWORK_VECTORS = [
  // --- the review's nine lines ---------------------------------------------
  {
    line: '||facebook.com^$removeparam=fbclid',
    expect: {
      kind: 'network', emit: false,
      build: { emit: true, why: 'the static compiler ships a queryTransform redirect for a literal $removeparam=; user filters refuse every form (§3.3 table)' },
    },
  },
  { line: "||example.com^$csp=script-src 'self'", expect: { kind: 'network', emit: false } },
  {
    line: '||example.com^$to=cdn.example',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||example.com^', requestDomains: ['cdn.example'] },
    },
  },
  {
    line: '||example.com^$from=site.example',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||example.com^', initiatorDomains: ['site.example'] },
    },
  },
  {
    line: '||example.com^$method=post',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||example.com^', requestMethods: ['post'] },
    },
  },
  { line: '||example.com^$header=content-type:image', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$popunder', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$strict3p', expect: { kind: 'network', emit: false } },
  { line: '@@||example.com^$genericblock', expect: { kind: 'network', emit: false } },
  {
    line: '/ads\\.js$/$script',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { regexFilter: 'ads\\.js$', resourceTypes: ['script'] },
    },
  },

  // --- more refused options --------------------------------------------------
  { line: '@@||example.com^$ghide', expect: { kind: 'network', emit: false } },
  { line: '@@||example.com^$ehide', expect: { kind: 'network', emit: false } },
  { line: '@@||example.com^$shide', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$redirect-rule=noop.js', expect: { kind: 'network', emit: false } },
  {
    line: '||example.com^$redirect=noop.js',
    expect: {
      kind: 'network', emit: false,
      build: { emit: true, why: 'the static compiler ships a redirect-to-stub; user filters have no resource library and refuse $redirect=' },
    },
  },
  { line: '||example.com^$badfilter', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$method=brew', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$script,bogus-option', expect: { kind: 'network', emit: false } },
  {
    line: '||example.com^$domain=münchen.de',
    expect: {
      kind: 'network', emit: false,
      build: { emit: true, why: 'the build punycodes $domain= entries; the Rust compiler does not attempt it and drops the line (§3.3 table)' },
    },
  },

  // --- mapped modifiers --------------------------------------------------------
  {
    line: '||example.com^$method=~get',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||example.com^', excludedRequestMethods: ['get'] },
    },
  },
  {
    line: '||example.com^$to=cdn.example|~static.example',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: {
        urlFilter: '||example.com^',
        requestDomains: ['cdn.example'],
        excludedRequestDomains: ['static.example'],
      },
    },
  },
  {
    line: '||example.com^$denyallow=cdn.example',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||example.com^', excludedRequestDomains: ['cdn.example'] },
    },
  },
  {
    line: '||ads.example^$xhr',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||ads.example^', resourceTypes: ['xmlhttprequest'] },
    },
  },
  {
    line: '||ads.example^$css,frame,doc,beacon,object-subrequest',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: {
        urlFilter: '||ads.example^',
        resourceTypes: ['stylesheet', 'sub_frame', 'main_frame', 'ping', 'object'],
      },
    },
  },
  {
    line: '||ads.example^$~script,3p',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||ads.example^', excludedResourceTypes: ['script'], domainType: 'thirdParty' },
    },
  },
  {
    line: '||ads.example^$domain=a.com|~b.com,1p',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: {
        urlFilter: '||ads.example^',
        domainType: 'firstParty',
        initiatorDomains: ['a.com'],
        excludedInitiatorDomains: ['b.com'],
      },
    },
  },
  {
    line: '||bad.example^$all',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||bad.example^', resourceTypes: ALL_RESOURCE_TYPES },
    },
  },
  {
    line: '||bad.example^$all,~image',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||bad.example^', resourceTypes: ALL_RESOURCE_TYPES.filter((t) => t !== 'image') },
    },
  },
  {
    line: '||pop.example^$popup',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||pop.example^', resourceTypes: ['main_frame'] },
    },
  },
  { line: '/r.php?u=$popup', expect: { kind: 'network', emit: false } },
  {
    line: '@@/r.php?u=$popup',
    expect: {
      kind: 'network', emit: true, action: 'allow',
      condition: { urlFilter: '/r.php?u=', resourceTypes: ['main_frame'] },
    },
  },
  {
    line: '||example.com^$match-case',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||example.com^', isUrlFilterCaseSensitive: true },
    },
  },
  {
    line: '||example.com^$inline-script,script',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||example.com^', resourceTypes: ['script'] },
    },
  },
  {
    line: '*$script,3p,domain=x.com',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { resourceTypes: ['script'], domainType: 'thirdParty', initiatorDomains: ['x.com'] },
    },
  },
  { line: '*', expect: { kind: 'network', emit: false } },

  // --- scoping options that resolve to nothing never ship the rule unscoped --
  { line: '||example.com^$domain=', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$domain=|', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$from=', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$to=', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$to=~', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$denyallow=', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$denyallow=~x.com', expect: { kind: 'network', emit: false } },
  { line: '||example.com^$method=', expect: { kind: 'network', emit: false } },
  {
    line: '||example.com^$domain=~',
    expect: { kind: 'network', emit: false },
  },
  {
    line: '||example.com^$~domain=a.com',
    expect: { kind: 'network', emit: false },
  },
  {
    line: '||example.com^$script,~script',
    expect: { kind: 'network', emit: false },
  },

  // --- `$3p`/`$1p` as the FIRST option ------------------------------------
  // The build's OPTION_LIST_HEAD used to want a letter first, so it never
  // split `$3p…` and shipped a dead urlFilter carrying the literal text: 415
  // corpus lines, 56 of them exceptions (§7.1, fixed by D1c). Every engine
  // now compiles the scoped rule the line asks for.
  {
    line: '||example.com^$3p',
    expect: {
      kind: 'network', emit: true, action: 'block',
      condition: { urlFilter: '||example.com^', domainType: 'thirdParty' },
    },
  },
  {
    line: '@@||example.com^$~3p,script',
    expect: {
      kind: 'network', emit: true, action: 'allow',
      condition: { urlFilter: '||example.com^', domainType: 'firstParty', resourceTypes: ['script'] },
    },
  },
  {
    line: '@@||safe.example^$important',
    expect: {
      kind: 'network', emit: true, action: 'allow',
      condition: { urlFilter: '||safe.example^' },
    },
  },
];
