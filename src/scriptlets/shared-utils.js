/**
 * shared-utils.js
 *
 * Common utilities used across scriptlets running in the MAIN world.
 * Keeps logic DRY and prevents subtle divergence in regex construction,
 * escaping, and matching behavior.
 */

/**
 * A pattern is a regex literal only when it both starts AND ends with `/` and
 * anything after the closing slash is a valid flag. Checking only "contains a
 * second slash" made every path-like argument (`/gampad/ads?`) parse as
 * /regex/flags — usually a SyntaxError that silently killed the rule, or worse
 * a valid-flag suffix that silently broadened it.
 */
const REGEX_LITERAL = /^\/(.*)\/([dgimsuvy]*)$/;

/**
 * One random token per page load, used as the message of every abort thrown by
 * a scriptlet. A literal brand string ("AdBlock", "Nullify") in the message is
 * a one-line detector for anti-adblock code; a random token carries no
 * signature and changes on every load — the same reason uBO throws its magic.
 */
export const ABORT_MESSAGE = Math.random().toString(36).slice(2);

/**
 * Convert a pattern string to a RegExp.
 * Supports /regex/flags syntax and plain-string escaping.
 * Returns null only for non-string input; a malformed author regex falls back
 * to matching the raw text literally — an over-broad literal match beats
 * silently disabling the rule.
 *
 * @param {string} pattern
 * @param {string} [flags]    Flags applied to an escaped plain string, and used
 *                            as the default for a `/re/` literal with none.
 * @param {boolean} [verbatim] Anchor an escaped plain string as `^…$` — uBO's
 *                            third `patternToRegex` argument. Used where the
 *                            haystack is an exact token (an event type) rather
 *                            than a body of text to search.
 */
export function patternToRegex(pattern, flags = undefined, verbatim = false) {
  if (typeof pattern !== 'string') return null;
  // uBO short-circuits the empty pattern to a match-everything regex *before*
  // considering `verbatim`; `^$` would otherwise make an omitted argument mean
  // "matches only the empty string" instead of "matches anything".
  if (pattern === '') return new RegExp('');
  const literal = REGEX_LITERAL.exec(pattern);
  if (literal) {
    try {
      // Author-supplied flags lose `g`/`y` (see stripStatefulFlags); flags the
      // *caller* asked for are kept, because a caller passing `g` wants
      // String.replace semantics and resets lastIndex itself.
      const effective = literal[2] !== '' ? stripStatefulFlags(literal[2]) : (flags || '');
      return new RegExp(literal[1], effective);
    } catch { /* fall through to literal matching */ }
  }
  const escaped = escapeRegex(pattern);
  return new RegExp(verbatim ? `^${escaped}$` : escaped, flags || '');
}

/**
 * uBO's `safe.initPattern` — compile a pattern that may carry a leading `!`
 * meaning "match when this does NOT match".
 *
 * Four scriptlets take patterns in this form (no-window-open-if,
 * no-set-timeout-if, no-set-interval-if, abort-on-stack-trace). Escaping the
 * `!` into the literal, as every one of them used to, inverts the rule into a
 * no-op: `!bergblock` then blocks only URLs containing the three characters
 * `!be…`, i.e. nothing.
 *
 * @returns {{matchAll?: boolean, re?: RegExp, pattern?: string, expect: boolean}}
 */
// Unlike `patternToRegex`, flags are stripped of `g`/`y` even when the caller
// asked for them: the result is consumed by `testPattern`, which calls
// `.test()` repeatedly on a long-lived regex without rewinding lastIndex.
export function initPattern(pattern, options = {}) {
  if (typeof pattern !== 'string' || pattern === '') {
    return { matchAll: true, expect: true };
  }
  const expect = options.canNegate !== true || pattern.startsWith('!') === false;
  if (expect === false) pattern = pattern.slice(1);
  const literal = REGEX_LITERAL.exec(pattern);
  if (literal) {
    try {
      return { re: new RegExp(literal[1], stripStatefulFlags(literal[2] || options.flags || '')), expect };
    } catch { /* fall through */ }
  }
  if (options.flags !== undefined) {
    return { re: new RegExp(escapeRegex(pattern), stripStatefulFlags(options.flags)), expect };
  }
  return { pattern, expect };
}

/** Companion to `initPattern`: test a haystack, honouring the `!` inversion. */
export function testPattern(details, haystack) {
  if (!details || details.matchAll) return true;
  const s = String(haystack ?? '');
  if (details.re) return details.re.test(s) === details.expect;
  return s.includes(details.pattern) === details.expect;
}

/**
 * Build a URL/string matcher from a pattern.
 * Supports /regex/flags syntax and plain-string inclusion.
 * Returns a function that accepts a string and returns boolean.
 */
export function toMatcher(pattern) {
  if (typeof pattern === 'string') {
    const literal = REGEX_LITERAL.exec(pattern);
    if (literal) {
      try {
        const re = new RegExp(literal[1], stripStatefulFlags(literal[2]));
        return (url) => re.test(url);
      } catch { /* fall through to substring matching */ }
    }
  }
  return (url) => url.includes(pattern);
}

/**
 * Convert a pattern string to a RegExp for find/replace operations.
 * Supports /regex/flags syntax and plain-string escaping (global by default).
 */
export function toRegex(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern === 'string') {
    const literal = REGEX_LITERAL.exec(pattern);
    if (literal) {
      try {
        return new RegExp(literal[1], literal[2]);
      } catch { /* fall through to literal matching */ }
    }
  }
  return new RegExp(escapeRegex(pattern), 'g');
}

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// uBO varargs — `..., 'key', 'value', 'key2', 'value2'` after the fixed args
// ---------------------------------------------------------------------------

/**
 * uBO's `safe.getExtraArgs`. Numeric-looking values are converted to integers,
 * matching upstream, because every consumer (`throttle`, `sedCount`,
 * `quitAfter`, `reload`) expects a number.
 */
export function getExtraArgs(args, offset = 0) {
  const out = Object.create(null);
  const rest = Array.prototype.slice.call(args, offset);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (typeof key !== 'string' || key === '') continue;
    const raw = rest[i + 1];
    out[key] = /^\d+$/.test(raw) ? parseInt(raw, 10) : raw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// propsToMatch — shared by prevent-fetch, prevent-xhr, json-prune-*-response
// ---------------------------------------------------------------------------

/**
 * uBO's `parsePropertiesToMatchFn`: whitespace-separated `key:pattern` tokens,
 * with a bare token falling back to `implicit` (always `url` in practice).
 *
 * The `/[^$\w -]/` re-join reproduces uBO exactly: it is what keeps a bare
 * `https://example.com/ads` a URL pattern instead of being split into
 * prop `https` / pattern `//example.com/ads`.
 *
 * @returns {Map<string, ReturnType<typeof initPattern>>}
 */
export function parsePropsToMatch(propsToMatch, implicit = '') {
  const needles = new Map();
  if (typeof propsToMatch !== 'string' || propsToMatch === '') return needles;
  const options = { canNegate: true };
  for (const needle of propsToMatch.split(/\s+/)) {
    if (needle === '') continue;
    const parts = needle.split(':');
    let prop = parts[0];
    let pattern = parts.length > 1 ? parts.slice(1).join(':') : undefined;
    if (prop === '') continue;
    if (pattern !== undefined && /[^$\w -]/.test(prop)) {
      prop = `${prop}:${pattern}`;
      pattern = undefined;
    }
    if (pattern !== undefined) {
      needles.set(prop, initPattern(pattern, options));
    } else if (implicit !== '') {
      needles.set(implicit, initPattern(prop, options));
    }
  }
  return needles;
}

/**
 * uBO's `matchObjectPropertiesFn`. Returns `undefined` when any needle fails,
 * otherwise the list of matched `prop: value` strings (possibly empty when no
 * needle addressed a property the objects carry).
 */
export function matchObjectProperties(propNeedles, ...objs) {
  const matched = [];
  for (const obj of objs) {
    if (!obj || typeof obj !== 'object') continue;
    for (const [prop, details] of propNeedles) {
      let value = obj[prop];
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        try { value = JSON.stringify(value); } catch { /* not serialisable */ }
        if (typeof value !== 'string') continue;
      }
      if (testPattern(details, value) === false) return undefined;
      matched.push(`${prop}: ${value}`);
    }
  }
  return matched;
}

/** uBO's `collateFetchArgumentsFn` — flatten `fetch(resource, options)`. */
const FETCH_PROPS = [
  'body', 'cache', 'credentials', 'duplex', 'headers', 'integrity', 'keepalive',
  'method', 'mode', 'priority', 'redirect', 'referrer', 'referrerPolicy', 'url',
];

export function collateFetchArguments(resource, options) {
  const out = {};
  const collate = (src) => {
    for (const prop of FETCH_PROPS) {
      if (src[prop] === undefined) continue;
      out[prop] = src[prop];
    }
  };
  if (typeof resource !== 'object' || resource === null ||
      Object.prototype.toString.call(resource) !== '[object Request]') {
    out.url = `${resource}`;
  } else {
    let clone;
    try { clone = resource.clone(); } catch { /* body already consumed */ }
    collate(clone || resource);
  }
  if (typeof options === 'object' && options !== null) collate(options);
  // Deviation from uBO: upstream leaves `method` undefined when the caller
  // omitted it, and its matcher skips undefined properties — so `method:POST`
  // matches a plain `fetch(url)`, which is a GET. Per the Fetch spec the
  // request's method *is* GET in that case, so we say so and the condition
  // means what the filter author wrote.
  if (out.method === undefined) out.method = 'GET';
  return out;
}

// ---------------------------------------------------------------------------
// Response-body directives (uBO `generateContentFn`, untrusted flavour)
// ---------------------------------------------------------------------------

function randomText(len) {
  const chunks = [];
  let size = 0;
  do {
    const s = Math.random().toString(36).slice(2);
    chunks.push(s);
    size += s.length;
  } while (size < len);
  return chunks.join(' ').slice(0, len);
}

/**
 * uBO's untrusted response-body vocabulary. Anything not in it yields `''`,
 * which is also what `war:` yields here: serving a redirect resource needs the
 * web-accessible-resource library the extension does not ship yet, and an
 * empty body is far closer to the intent than echoing the literal `war:…`
 * token into the page.
 */
export function generateContent(directive) {
  if (typeof directive !== 'string' || directive === '') return '';
  if (directive === 'true') return randomText(10);
  if (directive === 'emptyObj') return '{}';
  if (directive === 'emptyArr') return '[]';
  if (directive === 'emptyStr') return '';
  if (directive.startsWith('length:')) {
    const match = /^length:(\d+)(?:-(\d+))?$/.exec(directive);
    if (match === null) return '';
    const min = parseInt(match[1], 10);
    const extent = Math.max(parseInt(match[2], 10) || 0, min) - min;
    const len = Math.min(min + extent * Math.random(), 500000);
    return randomText(len | 0);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Timer-delay arguments (uBO adjust-setTimeout / adjust-setInterval)
// ---------------------------------------------------------------------------

/**
 * uBO's delay argument: `*` is the -1 "any delay" sentinel, and anything that
 * does not parse — including the argument being absent — defaults to **1000**.
 *
 * Both halves used to be inverted here: `Number('*')` is NaN and `NaN === ms`
 * is never true, so the 79 rules using `*` adjusted nothing; and a missing
 * argument meant "every delay", so the 188 rules that ship without one turned
 * every sub-second page timer into a next-tick hot loop.
 */
export function parseTimerDelay(delayArg) {
  const delay = delayArg !== '*' ? parseInt(delayArg, 10) : -1;
  return Number.isNaN(delay) || Number.isFinite(delay) === false ? 1000 : delay;
}

/** uBO's boost argument: clamped to [0.001, 50], defaulting to 0.05. */
export function parseTimerBoost(boostArg) {
  const boost = parseFloat(boostArg);
  return Number.isNaN(boost) === false && Number.isFinite(boost)
    ? Math.min(Math.max(boost, 0.001), 50)
    : 0.05;
}

// ---------------------------------------------------------------------------
// Delay ranges — uBO's RangeParser (`2000-5000`, `3200-`, `-500`, `!1000`)
// ---------------------------------------------------------------------------

export class RangeParser {
  constructor(s) {
    s = typeof s === 'string' ? s : '';
    this.not = s.charAt(0) === '!';
    if (this.not) s = s.slice(1);
    if (s === '') return;
    const pos = s.indexOf('-');
    if (pos !== 0) this.min = this.max = parseInt(s, 10) || 0;
    if (pos !== -1) this.max = parseInt(s.slice(pos + 1), 10) || Number.MAX_SAFE_INTEGER;
  }

  unbound() {
    return this.min === undefined && this.max === undefined;
  }

  test(v) {
    const n = Math.min(Math.max(Number(v) || 0, 0), Number.MAX_SAFE_INTEGER);
    if (this.min === this.max) {
      return (this.min === undefined || n === this.min) !== this.not;
    }
    if (this.min === undefined) return (n <= this.max) !== this.not;
    if (this.max === undefined) return (n >= this.min) !== this.not;
    return (n >= this.min && n <= this.max) !== this.not;
  }
}

// ---------------------------------------------------------------------------
// Native-function masking
// ---------------------------------------------------------------------------

// Captured before any masking is installed, and never re-read from the global:
// page script can replace `Function.prototype.toString`, and every scriptlet
// that stringifies a callback to match a needle would then see whatever the
// page wants it to see.
const nativeFunctionToString = Function.prototype.toString;

/** Stringify a callback for needle matching, immune to page tampering. */
export function functionToString(fn) {
  if (typeof fn !== 'function') return String(fn);
  try {
    return nativeFunctionToString.call(fn);
  } catch {
    return String(fn);
  }
}

// wrapper -> the function whose source it should report. Chains are followed,
// so wrapping a wrapper still reports the innermost native source.
const nativeSources = new WeakMap();
let installedToString = null;

/**
 * Install one `Function.prototype.toString` proxy for the whole bundle.
 *
 * The alternative — an own `toString` on each wrapper, which is what
 * bot-stealth.js used to do — is a one-line detector: `Object.keys(fn)` on a
 * genuine native function is `[]`, and returned `["toString"]` on ours. It also
 * leaked the wrapper's own source through `fn.toString.toString()`. One proxy
 * keyed by a WeakMap leaves zero own properties behind, and is uBO's approach
 * (`proxyApplyFn`).
 */
function installToStringMask() {
  // Re-arm if page script (or a test harness) restored the pristine
  // `Function.prototype.toString` after we installed ours.
  if (installedToString !== null && Function.prototype.toString === installedToString) return;
  const nativeToString = nativeFunctionToString;
  const proxiedToString = new Proxy(nativeToString, {
    apply(target, thisArg, args) {
      let fn = thisArg;
      for (;;) {
        const inner = nativeSources.get(fn);
        if (inner === undefined) break;
        fn = inner;
      }
      return Reflect.apply(target, fn, args);
    },
  });
  // …including for `Function.prototype.toString` itself, so
  // `fn.toString.toString()` reports native source rather than this proxy.
  nativeSources.set(proxiedToString, nativeToString);
  try {
    Function.prototype.toString = proxiedToString;
    installedToString = proxiedToString;
  } catch { /* frozen prototype — wrappers keep their own source */ }
}

/**
 * Make `wrapper` report `native`'s source, name and arity.
 * Returns `wrapper` so it can be used inline.
 */
export function maskNative(wrapper, native) {
  if (typeof wrapper !== 'function' || typeof native !== 'function') return wrapper;
  installToStringMask();
  nativeSources.set(wrapper, native);
  for (const key of ['name', 'length']) {
    const desc = Object.getOwnPropertyDescriptor(native, key);
    if (desc === undefined) continue;
    try { Object.defineProperty(wrapper, key, desc); } catch { /* frozen */ }
  }
  return wrapper;
}

/**
 * Replace `owner[prop]` with an `apply`-trapping Proxy.
 *
 * The handler receives `{ thisArg, callArgs, reflect() }` — uBO's shape. This
 * is the only way to intercept a method without leaving an own property on
 * every instance: assigning `xhr.open = …` per instance made
 * `Object.getOwnPropertyNames(new XMLHttpRequest())` non-empty, which it never
 * is on a real browser.
 *
 * @returns {Function|null} the original function, or null when not installable.
 */
export function proxyApply(owner, prop, handler) {
  const fn = owner?.[prop];
  if (typeof fn !== 'function') return null;
  const proxied = new Proxy(fn, {
    apply(target, thisArg, callArgs) {
      return handler({
        thisArg,
        callArgs,
        reflect: () => Reflect.apply(target, thisArg, callArgs),
      });
    },
  });
  maskNative(proxied, fn);
  try {
    owner[prop] = proxied;
  } catch {
    return null;
  }
  return fn;
}

/**
 * Wrap a prototype accessor so `transform(value, instance)` post-processes
 * every read, leaving no own property on any instance.
 *
 * The instance-level alternative (`Object.defineProperty(xhr, 'responseText',
 * …)` inside a `construct` trap) is detectable: `Object.getOwnPropertyNames`
 * on a real XHR returns `[]`.
 *
 * @returns {boolean} whether the wrap was installed.
 */
export function wrapInstanceGetter(proto, prop, transform) {
  const desc = Object.getOwnPropertyDescriptor(proto, prop);
  if (desc?.get === undefined) return false;
  const nativeGetter = desc.get;
  const getter = function () {
    return transform(nativeGetter.call(this), this);
  };
  maskNative(getter, nativeGetter);
  try {
    Object.defineProperty(proto, prop, { ...desc, get: getter, configurable: true });
  } catch {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cookie / storage enumeration (uBO getAllCookiesFn / getAllLocalStorageFn)
// ---------------------------------------------------------------------------

/** `[{ key, value }]` for every cookie readable from this document. */
export function getAllCookies() {
  let raw = '';
  try { raw = document.cookie; } catch { return []; }
  return raw.split(/\s*;\s*/).map((s) => {
    const pos = s.indexOf('=');
    if (pos === 0) return undefined;
    if (pos === -1) return { key: s.trim(), value: '' };
    return { key: s.slice(0, pos).trim(), value: s.slice(pos + 1).trim() };
  }).filter((s) => s !== undefined);
}

/**
 * `[{ key, value }]` for every entry of `localStorage`/`sessionStorage`.
 *
 * Deviation from uBO: upstream's `getAllLocalStorageFn` `return`s inside its
 * loop, so it yields a single `{key, value}` object (not an array) whenever
 * storage is non-empty, and `[]` otherwise — its sole caller then iterates it
 * as an array and matches nothing. We collect every entry, which is what the
 * caller (`trusted-click-element`'s `localStorage:` assertion) needs.
 */
export function getAllLocalStorage(which = 'localStorage') {
  const out = [];
  try {
    const storage = globalThis[which];
    if (!storage) return out;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      out.push({ key, value: storage.getItem(key) });
    }
  } catch { /* storage blocked by policy */ }
  return out;
}

// ---------------------------------------------------------------------------
// Element lookup — uBO's `lookupElementsFn` selector dialect
// ---------------------------------------------------------------------------

function getShadowRoot(elem) {
  if (elem.openOrClosedShadowRoot) return elem.openOrClosedShadowRoot; // Firefox
  const dom = globalThis.chrome?.dom;
  if (dom?.openOrClosedShadowRoot) return dom.openOrClosedShadowRoot(elem);
  return elem.shadowRoot;
}

function queryOrEvaluate(selector, context) {
  if (selector.startsWith('xpath:') === false) {
    return Array.from(context.querySelectorAll(selector));
  }
  const result = document.evaluate(selector.slice(6), context, null, 7, null);
  const out = [];
  if (result.resultType === 7) {
    for (let i = 0; i < result.snapshotLength; i++) out[i] = result.snapshotItem(i);
  }
  return out;
}

function querySelectorEx(selector, context) {
  const pos = selector.indexOf(' >>> ');
  if (pos === -1) return queryOrEvaluate(selector, context);
  const outside = selector.slice(0, pos).trim();
  const inside = selector.slice(pos + 5).trim();
  const out = [];
  for (const elem of queryOrEvaluate(outside, context)) {
    const shadowRoot = getShadowRoot(elem);
    if (!shadowRoot) continue;
    for (const found of querySelectorEx(inside, shadowRoot)) out.push(found);
  }
  return out;
}

/**
 * Resolve one uBO selector directive to elements.
 *
 * Supports plain CSS, `xpath:…`, ` >>> ` shadow-root piercing and a
 * `when-visible:` prefix. A malformed selector yields `[]` rather than
 * throwing — the caller retries on the next mutation.
 */
export function lookupElements(directive) {
  try {
    const beVisible = directive.startsWith('when-visible:');
    const selector = beVisible ? directive.slice(13) : directive;
    const elems = querySelectorEx(selector, document);
    if (beVisible !== true) return elems;
    return elems.filter((el) => (
      typeof el.checkVisibility === 'function'
        ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        : el.getBoundingClientRect().width > 0
    ));
  } catch {
    return [];
  }
}

/**
 * Drop `g`/`y` from a flag string.
 *
 * `RegExp.prototype.test` advances `lastIndex` on a stateful regex. Matchers
 * built here are held for the lifetime of the page and reused across every
 * request, so a stateful flag makes every second matching call return false.
 * `toRegex` deliberately does NOT use this — it feeds `String.replace`, which
 * needs `g` to replace more than the first occurrence.
 */
function stripStatefulFlags(flags) {
  return flags.replace(/[gy]/g, '');
}
