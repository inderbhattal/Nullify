/**
 * jsonpath.js — uBlock Origin's JSONPath dialect, as a standalone ESM module.
 *
 * Ported from uBO's `src/js/jsonpath.js` (GPLv3, Raymond Hill) so that uBO's
 * shipped `quick-fixes.txt` / `experimental.txt` rules run against our engine
 * verbatim. The *semantics* are uBO's; the surface is ours. Divergences are
 * listed under "DELIBERATE DIVERGENCES" below — each one is either a safety
 * hardening or an additive extension, never a change to how a shipped rule
 * behaves.
 *
 * =============================================================================
 * EXPORT CONTRACT
 * =============================================================================
 *
 * compile(expr, options?) -> CompiledPath
 *
 *   Compiles one uBO JSONPath expression. Never throws. Never touches the DOM,
 *   globals, or chrome APIs.
 *
 *   options = {
 *     v2?:        boolean  // force uBO's `v2:` mode (the `v2:` prefix does too)
 *     mergeMode?: 'shallow' | 'deep'   // `+=` semantics, default 'shallow' (uBO)
 *     allowCall?: boolean  // permit `=call([...])`, default true
 *     limits?:    Partial<typeof JSONPATH_LIMITS>
 *   }
 *
 *   CompiledPath (frozen) = {
 *     ok:        boolean   // false => the expression is malformed
 *     error:     string|null  // machine-readable code, see ERROR CODES
 *     expr:      string    // the expression as given
 *     action:    'remove'|'assign'|'merge'|'replace'|'call'|null
 *     hasAction: boolean   // false => `apply()` removes what the path resolves to
 *
 *     matches(doc) -> boolean
 *       True iff the expression resolves to at least one location in `doc`.
 *       Predicate-only expressions (`[?…]` with no trailing selector) therefore
 *       act as a boolean gate. False on any failure, budget overrun, or throw.
 *
 *     evaluate(doc) -> Array<Array<string|number>>
 *       The resolved locations, each as a key path *relative to the document*
 *       (uBO's leading `$` is stripped, so `[]` means "the document itself").
 *       Empty array on failure. Read-only view: it does not mutate `doc`.
 *
 *     apply(doc) -> { ok, changed, count, root, error }
 *       Mutates `doc` in place and returns:
 *         ok      - the operation ran to completion (no parse/budget/throw)
 *         changed - at least one location was written or removed
 *         count   - number of locations acted on
 *         root    - the resulting document. ALWAYS use this: an expression may
 *                   assign to or delete the root itself, in which case `root`
 *                   is the replacement value (or `null` after a root delete).
 *         error   - null, or an ERROR CODE
 *       With no trailing action the resolved locations are removed: array
 *       elements are spliced, object keys are deleted.
 *   }
 *
 * compilePrunePath(path, options?) -> CompiledPrunePath
 *
 *   The *other* uBO dialect: the dot-separated path language used by
 *   `json-prune` / `object-prune.fn` (uBO's `objectFindOwnerFn`). It is NOT the
 *   JSONPath dialect above — uBO keeps them separate and so do we.
 *
 *   CompiledPrunePath (frozen) = {
 *     ok, error, path,
 *     test(doc)  -> boolean   // does the path resolve? (uBO's needle check)
 *     prune(doc) -> boolean   // remove what it resolves to; true iff modified
 *   }
 *
 * compilePruner(rawPrunePaths, rawNeedlePaths?, options?) -> CompiledPruner
 *
 *   uBO's `objectPruneFn` core: space-separated prune paths, gated on
 *   space-separated needle paths that must ALL resolve first.
 *
 *   CompiledPruner (frozen) = {
 *     ok, error, paths, needles,
 *     mustProcess(doc) -> boolean   // all needles resolve
 *     prune(doc)       -> boolean   // true iff anything was removed
 *   }
 *
 * isProtoPollutionKey(key) -> boolean
 * JSONPATH_LIMITS -> frozen caps object (see BOUNDS)
 *
 * ERROR CODES (stable strings):
 *   'not-a-string' | 'empty-expression' | 'expression-too-long' |
 *   'parse-failed' | 'too-many-steps' | 'nesting-too-deep' |
 *   'proto-key' | 'bad-operand' | 'bad-regex' | 'regex-too-long' |
 *   'unsupported-action' | 'call-disabled' |
 *   'budget-exceeded' | 'apply-failed' | 'bad-prune-path' | 'no-prune-paths'
 *
 * =============================================================================
 * DIALECT (what uBO ships, and what we accept)
 * =============================================================================
 *
 *   Roots / axes
 *     $              document root (implicit when an expression starts with a
 *                    selector; `@` = current node inside a filter)
 *     .key           child
 *     ..key          recursive descent
 *     .*  / [*]      every child (array indices, or object own keys)
 *     ["a","b"]      key list; ['a'] quoted; [2] index; [-1] from the end
 *     ./re/          keys matching a regex
 *     {n};$ / {n,m};$  uBO's result-count quantifier
 *
 *   Iteration extensions (ours, see DIVERGENCES #5)
 *     []             every array element
 *     {}             every own key of a non-array object
 *     [-]            every array element; the *element* is the removal target
 *                    when the rest of the path resolves
 *     {-}            every own key; the *key* is the removal target when the
 *                    rest of the path resolves
 *
 *   Filters
 *     [?…]  [?!…]    predicate / negated predicate. The inner expression is
 *                    relative (`.key`, `..key`) or self (`@`, `@..key`).
 *
 *   Comparison operators (operand must be valid JSON, or 'single quoted')
 *     ==  !=  <  <=  >  >=       ^= (starts-with)  $= (ends-with)  *= (contains)
 *     =/pattern/  =/pattern/i    regex test against the stringified value
 *
 *   Actions (appended to the expression)
 *     (none)                     remove the resolved location
 *     =<json>                    assign
 *     +=<json object>            merge into the resolved object
 *     =repl({"regex":…,"flags":…,"replacement":…})   string replace
 *     =call([instance, method, …args])   `${obj}` `${key}` `${val}` interpolated
 *
 *   `${now}` inside a string operand is replaced with `Date.now()` at apply
 *   time (uBO replaces the first occurrence only — so do we).
 *
 * =============================================================================
 * SAFETY (non-negotiables)
 * =============================================================================
 *
 * Prototype pollution: `__proto__`, `constructor` and `prototype` are refused
 * as literal path segments at compile time ('proto-key'), skipped when a
 * wildcard/regex/`{}`/`[]` expansion produces them, refused during path
 * resolution, stripped from every parsed operand, and skipped by `+=` merge and
 * `=call` method lookup. This is strictly stricter than uBO, which has no guard
 * at all.
 *
 * Bounds: expression length, compiled step count and filter-nesting depth are
 * capped at compile time; traversal depth, visited-node count and result count
 * are capped per evaluation, with a WeakSet ancestor cycle guard (self-
 * referential documents terminate). Exceeding a runtime cap fails *closed* —
 * `apply()` returns `{ ok:false, changed:false, error:'budget-exceeded' }` and
 * mutates nothing — so a hostile payload can never leave a half-applied edit.
 *
 * Totality: nothing here throws. A malformed expression yields `ok:false` with
 * an error code; a throwing document yields `error:'apply-failed'`.
 *
 * =============================================================================
 * DELIBERATE DIVERGENCES FROM uBO
 * =============================================================================
 *
 * 1. Prototype-pollution guards (above). uBO has none.
 * 2. Bounds + cycle guard (above). uBO's descendant walk loops forever on a
 *    cyclic object and has no node budget.
 * 3. Values are deep-cloned on assign/merge. uBO splices its compiled operand
 *    *by reference* into the document, so two applications of one compiled
 *    expression share mutable state and a page can corrupt the compiled rule.
 * 4. `=call` never falls back to `self`/`globalThis` when the instance operand
 *    is absent — this module must not reach globals — and refuses non-object
 *    instances and proto-key method names. uBO does `entries[0] ?? self`.
 * 5. `[]`, `{}`, `[-]`, `{-}` are accepted as JSONPath segments. In uBO these
 *    token shapes are hard parse errors in the JSONPath dialect (they only
 *    exist in the separate `object-prune` dialect), so this is purely additive
 *    and cannot change any shipped rule.
 * 6. An unrecognised `=name(...)` action is a compile error ('unsupported-
 *    action'); uBO compiles it and then silently no-ops at apply time.
 * 7. `apply()` de-duplicates identical resolved locations before mutating. uBO
 *    can splice the same array index twice when a path resolves more than once.
 * 8. `mergeMode: 'deep'` is available as an opt-in. The default is uBO's
 *    shallow top-level key copy, because a deep merge would preserve subkeys
 *    that uBO replaces (e.g. `+={"adPlaybackContext":{…}}` against a body that
 *    already carries an `adPlaybackContext`).
 * 9. "Is it an object?" uses `typeof v === 'object' && v !== null` rather than
 *    uBO's `v instanceof Object`, so null-prototype objects are traversed
 *    instead of silently skipped. Strictly more permissive; JSON never produces
 *    them.
 */

/* eslint no-use-before-define: 0 */

/** Keys that must never be traversed, expanded, assigned, or merged. */
export function isProtoPollutionKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/**
 * Default caps. Every one of these is a hard stop, not a heuristic.
 * Override per-compile with `options.limits`.
 */
export const JSONPATH_LIMITS = Object.freeze({
  /** Longest accepted expression, in characters. */
  maxExprLength: 4096,
  /** Total compiled steps, counting steps inside nested filters. */
  maxSteps: 128,
  /** How deeply `[?…]` filters may nest. */
  maxFilterDepth: 16,
  /** Longest accepted regex source, in characters. */
  maxRegexLength: 256,
  /** Deepest object/array nesting walked during evaluation. */
  maxDepth: 256,
  /** Total nodes visited per `evaluate()`/`apply()`/`prune()` call. */
  maxNodes: 250000,
  /** Most resolved locations one evaluation may produce. */
  maxResults: 10000,
});

/* -------------------------------------------------------------------------- */
/* Step kinds (uBO's #ROOT/#CURRENT/#CHILDREN/#DESCENDANTS/#QUANTIFIER)        */
/* -------------------------------------------------------------------------- */

const MV_UNDEFINED = 0;
const MV_ROOT = 1;
const MV_CURRENT = 2;
const MV_CHILDREN = 3;
const MV_DESCENDANTS = 4;
const MV_QUANTIFIER = 5;

// Wildcard keys are sentinels rather than strings so that a quoted literal key
// (e.g. `["[]"]`) can never be mistaken for an iteration segment.
const ITER_ARRAY = Symbol('[]');
const ITER_OBJECT = Symbol('{}');
const ITER_ARRAY_CUT = Symbol('[-]');
const ITER_OBJECT_CUT = Symbol('{-}');

const RE_UNQUOTED_IDENTIFIER = /^[A-Za-z_][\w]*|^\*/;
const RE_EXPR = /^\s*([!=^$*]=|[<>]=?)\s*(.+?)\]/;
const RE_INDICE = /^-?\d+/;
const RE_RVAL = /^=([a-z]+)\((.+)\)$/;
const RE_QUANTIFIER = /^\{(\d+|\d+,\d+|\d+,|,\d+)\};\$/;
const RE_REGEX_FLAGS = /^[i]/;

const CHAR_QUOTE_D = 0x22;
const CHAR_QUOTE_S = 0x27;
const CHAR_ROOT = 0x24;
const CHAR_AT = 0x40;
const CHAR_BANG = 0x21;
const CHAR_COMMA = 0x2C;
const CHAR_MINUS = 0x2D;
const CHAR_DOT = 0x2E;
const CHAR_SLASH = 0x2F;
const CHAR_ZERO = 0x30;
const CHAR_NINE = 0x39;
const CHAR_SEMI = 0x3B;
const CHAR_LBRACKET = 0x5B;
const CHAR_RBRACKET = 0x5D;
const CHAR_BACKSLASH = 0x5C;
const CHAR_LBRACE = 0x7B;
const CHAR_SPACE = 0x20;

function isObjectLike(v) {
  return v !== null && typeof v === 'object';
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Parser state shared across the recursive descent: budget counters plus the
 * first error code seen, so a failure reports *why* rather than just "invalid".
 */
function newParseContext(query, v2, limits) {
  return { query, v2, limits, steps: 0, depth: 0, error: null };
}

function fail(ctx, code) {
  if (ctx.error === null) ctx.error = code;
  return undefined;
}

function countStep(ctx, n = 1) {
  ctx.steps += n;
  if (ctx.steps > ctx.limits.maxSteps) return fail(ctx, 'too-many-steps') ?? false;
  return true;
}

/**
 * uBO's `#compile`: consume a (sub)expression starting at `i`, returning the
 * step list and the index where parsing stopped. `undefined` on failure.
 */
function parseExpression(ctx, i) {
  const { query } = ctx;
  if (query.length === 0) return fail(ctx, 'empty-expression');
  if (ctx.depth > ctx.limits.maxFilterDepth) return fail(ctx, 'nesting-too-deep');

  const steps = [];
  let c = query.charCodeAt(i);
  if (c === CHAR_ROOT) {
    steps.push({ mv: MV_ROOT });
    i += 1;
  } else if (c === CHAR_AT) {
    steps.push({ mv: MV_CURRENT });
    i += 1;
  } else {
    steps.push({ mv: i === 0 ? MV_ROOT : MV_CURRENT });
  }
  if (countStep(ctx) === false) return undefined;

  let mv = MV_UNDEFINED;
  for (;;) {
    if (i === query.length) break;
    c = query.charCodeAt(i);
    if (c === CHAR_SPACE) { i += 1; continue; }

    // Dot accessor syntax.
    if (c === CHAR_DOT) {
      if (mv !== MV_UNDEFINED) return fail(ctx, 'parse-failed');
      if (query.startsWith('..', i)) {
        mv = MV_DESCENDANTS;
        i += 2;
      } else {
        mv = MV_CHILDREN;
        i += 1;
      }
      continue;
    }

    // `;$` — uBO's shorthand for the `{1,};$` quantifier.
    if (c === CHAR_SEMI) {
      if (query.startsWith(';$', i) === false) return fail(ctx, 'parse-failed');
      steps.push({ mv: MV_QUANTIFIER, min: 1, max: 1e6 }, { mv: MV_ROOT });
      if (countStep(ctx, 2) === false) return undefined;
      i += 2;
      mv = MV_UNDEFINED;
      continue;
    }

    if (c === CHAR_LBRACE) {
      // Our `{}` / `{-}` iteration extension shadows nothing: neither shape is
      // a legal quantifier, so uBO would reject both outright.
      const braced = query.startsWith('{}', i) ? ITER_OBJECT
        : query.startsWith('{-}', i) ? ITER_OBJECT_CUT
          : undefined;
      if (braced !== undefined) {
        if (mv === MV_CHILDREN) return fail(ctx, 'parse-failed');
        steps.push({ mv: mv || MV_CHILDREN, k: braced, cut: braced === ITER_OBJECT_CUT });
        if (countStep(ctx) === false) return undefined;
        i += braced === ITER_OBJECT_CUT ? 3 : 2;
        mv = MV_UNDEFINED;
        continue;
      }
      const match = RE_QUANTIFIER.exec(query.slice(i));
      if (match === null) return fail(ctx, 'parse-failed');
      const comma = match[1].indexOf(',');
      let min;
      let max;
      if (comma === -1) {
        min = parseInt(match[1], 10);
        max = min;
      } else {
        min = parseInt(match[1].slice(0, comma), 10) || 0;
        max = parseInt(match[1].slice(comma + 1), 10) || 1e6;
      }
      steps.push({ mv: MV_QUANTIFIER, min, max }, { mv: MV_ROOT });
      if (countStep(ctx, 2) === false) return undefined;
      i += match[0].length;
      mv = MV_UNDEFINED;
      continue;
    }

    if (c !== CHAR_LBRACKET) {
      if (mv === MV_UNDEFINED) {
        // No axis pending: whatever follows must be a comparison operator
        // attached to the step we just emitted (`.a=="x"`). Anything else ends
        // the path and is handed back to the caller as trailing text.
        const step = steps[steps.length - 1];
        if (step === undefined) return fail(ctx, 'parse-failed');
        const j = parseComparison(ctx, step, i);
        if (j) i = j;
        break;
      }
      const r = consumeUnquotedIdentifier(ctx, i);
      if (r === undefined) return undefined;
      if (typeof r.s === 'string' && isProtoPollutionKey(r.s)) return fail(ctx, 'proto-key');
      steps.push({ mv, k: r.s });
      if (countStep(ctx) === false) return undefined;
      i = r.i;
      mv = MV_UNDEFINED;
      continue;
    }

    // Bracket accessor syntax.
    if (mv === MV_CHILDREN) return fail(ctx, 'parse-failed');

    if (query.startsWith('[?', i)) {
      const not = query.charCodeAt(i + 2) === CHAR_BANG ? 1 : 0;
      ctx.depth += 1;
      const r = parseExpression(ctx, i + 2 + not);
      ctx.depth -= 1;
      if (r === undefined) return undefined;
      if (query.startsWith(']', r.i) === false) return fail(ctx, 'parse-failed');
      if (not) r.steps[r.steps.length - 1].not = true;
      steps.push({ mv: mv || MV_CHILDREN, steps: r.steps });
      if (countStep(ctx) === false) return undefined;
      i = r.i + 1;
      mv = MV_UNDEFINED;
      continue;
    }

    if (query.startsWith('[*]', i)) {
      steps.push({ mv: mv || MV_CHILDREN, k: '*' });
      if (countStep(ctx) === false) return undefined;
      i += 3;
      mv = MV_UNDEFINED;
      continue;
    }

    // `[]` / `[-]` array iteration (extension — both are parse errors in uBO).
    const bracketed = query.startsWith('[]', i) ? ITER_ARRAY
      : query.startsWith('[-]', i) ? ITER_ARRAY_CUT
        : undefined;
    if (bracketed !== undefined) {
      steps.push({ mv: mv || MV_CHILDREN, k: bracketed, cut: bracketed === ITER_ARRAY_CUT });
      if (countStep(ctx) === false) return undefined;
      i += bracketed === ITER_ARRAY_CUT ? 3 : 2;
      mv = MV_UNDEFINED;
      continue;
    }

    const r = consumeIdentifier(ctx, i + 1);
    if (r === undefined) return undefined;
    if (hasProtoKey(r.s)) return fail(ctx, 'proto-key');
    steps.push({ mv: mv || MV_CHILDREN, k: r.s });
    if (countStep(ctx) === false) return undefined;
    i = r.i + 1;
    mv = MV_UNDEFINED;
  }

  if (steps.length === 0) return fail(ctx, 'parse-failed');
  if (mv !== MV_UNDEFINED) return fail(ctx, 'parse-failed');
  return { steps, i };
}

function hasProtoKey(k) {
  if (typeof k === 'string') return isProtoPollutionKey(k);
  if (Array.isArray(k)) return k.some((a) => typeof a === 'string' && isProtoPollutionKey(a));
  return false;
}

/** uBO's `#consumeIdentifier`: the inside of `[...]`. */
function consumeIdentifier(ctx, i) {
  const { query } = ctx;
  const keys = [];
  let needIdentifier = true;
  while (i < query.length) {
    const c0 = query.charCodeAt(i);
    if (c0 === CHAR_RBRACKET) break;
    if (c0 === CHAR_SPACE) { i += 1; continue; }
    if (c0 === CHAR_COMMA) {
      if (needIdentifier) return fail(ctx, 'parse-failed');
      i += 1;
      needIdentifier = true;
      continue;
    }
    if (c0 === CHAR_QUOTE_D || c0 === CHAR_QUOTE_S) {
      const r = untilChar(query, c0, i + 1);
      if (r === undefined) return fail(ctx, 'parse-failed');
      keys.push(r.s);
      i = r.i;
      needIdentifier = false;
      continue;
    }
    if (c0 === CHAR_MINUS || (c0 >= CHAR_ZERO && c0 <= CHAR_NINE)) {
      const match = RE_INDICE.exec(query.slice(i));
      if (match === null) return fail(ctx, 'parse-failed');
      keys.push(parseInt(query.slice(i), 10));
      i += match[0].length;
      needIdentifier = false;
      continue;
    }
    if (ctx.v2) return fail(ctx, 'parse-failed');
    const r = consumeUnquotedIdentifier(ctx, i);
    if (r === undefined) return undefined;
    keys.push(r.s);
    i = r.i;
    needIdentifier = false;
  }
  if (needIdentifier) return fail(ctx, 'parse-failed');
  return { s: keys.length === 1 ? keys[0] : keys, i };
}

/** uBO's `#consumeUnquotedIdentifier`: a bare key, `*`, or a `/regex/`. */
function consumeUnquotedIdentifier(ctx, i) {
  const { query } = ctx;
  if (query.charCodeAt(i) === CHAR_SLASH) {
    const r = untilChar(query, CHAR_SLASH, i + 1);
    if (r === undefined) return fail(ctx, 'parse-failed');
    const re = buildRegex(ctx, r.s, undefined);
    if (re === undefined) return undefined;
    return { s: re, i: r.i };
  }
  const match = RE_UNQUOTED_IDENTIFIER.exec(query.slice(i));
  if (match === null) return fail(ctx, 'parse-failed');
  return { s: match[0], i: i + match[0].length };
}

function buildRegex(ctx, source, flags) {
  if (source.length > ctx.limits.maxRegexLength) return fail(ctx, 'regex-too-long');
  try {
    return new RegExp(source, flags);
  } catch {
    return fail(ctx, 'bad-regex');
  }
}

/** uBO's `#untilChar`: read to the next unescaped `targetCharCode`. */
function untilChar(query, targetCharCode, i) {
  const len = query.length;
  const parts = [];
  let beg = i;
  let end = i;
  for (;;) {
    if (end === len) return undefined;
    const c = query.charCodeAt(end);
    if (c === targetCharCode) {
      parts.push(query.slice(beg, end));
      end += 1;
      break;
    }
    if (c === CHAR_BACKSLASH && (end + 1) < len) {
      if (query.charCodeAt(end + 1) === targetCharCode) {
        parts.push(query.slice(beg, end));
        end += 1;
        beg = end;
      }
    }
    end += 1;
  }
  return { s: parts.join(''), i: end };
}

/**
 * uBO's `#compileExpr`: attach a comparison operator to `step`. Returns the new
 * index, or `undefined` when the text is not a comparison — which is *not* an
 * error: it just means the path ended and the rest is a trailing action.
 */
function parseComparison(ctx, step, i) {
  const { query } = ctx;
  if (query.startsWith('=/', i)) {
    const r = untilChar(query, CHAR_SLASH, i + 2);
    if (r === undefined) return i;
    const match = RE_REGEX_FLAGS.exec(query.slice(r.i));
    const re = buildRegex(ctx, r.s, (match && match[0]) || undefined);
    if (re === undefined) return undefined;
    step.rval = re;
    step.op = 're';
    return match ? r.i + match[0].length : r.i;
  }
  const match = RE_EXPR.exec(query.slice(i));
  if (match === null) return undefined;
  const op = match[1];
  const rval = match[2];
  if (rval.charCodeAt(0) === CHAR_QUOTE_S) {
    const r = untilChar(rval, CHAR_QUOTE_S, 1);
    if (r === undefined) return undefined;
    step.rval = r.s;
    step.op = op;
  } else {
    let parsed;
    try {
      parsed = JSON.parse(rval);
    } catch {
      return undefined;
    }
    step.rval = sanitizeValue(parsed, 0);
    step.op = op;
  }
  return i + match[0].length - 1;
}

/* -------------------------------------------------------------------------- */
/* Operand hygiene                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Strip proto-pollution keys out of a parsed JSON operand, recursively.
 * `JSON.parse('{"__proto__":{…}}')` yields a real own `__proto__` property; if
 * that operand were later merged into a document it would poison the chain.
 */
function sanitizeValue(v, depth) {
  if (depth > 64 || !isObjectLike(v)) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = sanitizeValue(v[i], depth + 1);
    return v;
  }
  for (const k of Object.keys(v)) {
    if (isProtoPollutionKey(k)) {
      delete v[k];
      continue;
    }
    v[k] = sanitizeValue(v[k], depth + 1);
  }
  return v;
}

/** Deep clone a JSON value, so applying a compiled rule never aliases it. */
function cloneValue(v, depth) {
  if (depth > 64 || !isObjectLike(v)) return v;
  if (Array.isArray(v)) return v.map((e) => cloneValue(e, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    if (isProtoPollutionKey(k)) continue;
    out[k] = cloneValue(v[k], depth + 1);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Traversal                                                                  */
/* -------------------------------------------------------------------------- */

function newRunState(limits) {
  return { nodes: 0, overflow: false, limits };
}

/**
 * uBO's `#getDescendants`, as a generator with a node budget, a depth cap and a
 * WeakSet ancestor cycle guard. Yields `{ obj, key, path }` in pre-order; `path`
 * is the live working array and MUST be copied by the consumer before yielding
 * control back.
 */
function* walk(state, value, recursive) {
  yield* walkInner(state, value, recursive, [], new WeakSet(), 0);
}

function* walkInner(state, value, recursive, path, seen, depth) {
  if (!isObjectLike(value)) return;
  if (depth > state.limits.maxDepth) {
    state.overflow = true;
    return;
  }
  if (seen.has(value)) return; // cycle: this node is already an ancestor
  const keys = Array.isArray(value) ? value.keys() : Object.keys(value).values();
  seen.add(value);
  try {
    for (const key of keys) {
      if (typeof key === 'string' && isProtoPollutionKey(key)) continue;
      state.nodes += 1;
      if (state.nodes > state.limits.maxNodes) {
        state.overflow = true;
        return;
      }
      path.push(key);
      yield { obj: value, key, path };
      if (recursive) {
        yield* walkInner(state, value[key], recursive, path, seen, depth + 1);
      }
      path.pop();
    }
  } finally {
    seen.delete(value);
  }
}

/** uBO's `#expandKey`. Returns an iterable of keys, or `undefined`. */
function expandKey(owner, k) {
  if (!isObjectLike(owner)) return undefined;
  if (Array.isArray(k)) {
    const out = [];
    for (const a of k) {
      const iter = expandKey(owner, a);
      if (iter === undefined) continue;
      out.push(...iter);
    }
    return out;
  }
  if (typeof k === 'number') {
    if (Array.isArray(owner) === false) return undefined;
    return [k >= 0 ? k : owner.length + k];
  }
  if (typeof k === 'symbol') {
    if (k === ITER_ARRAY || k === ITER_ARRAY_CUT) {
      return Array.isArray(owner) ? [...owner.keys()] : undefined;
    }
    if (Array.isArray(owner)) return undefined;
    return ownKeys(owner);
  }
  if (k === '*') {
    if (Array.isArray(owner)) return [...owner.keys()];
    return ownKeys(owner);
  }
  if (k instanceof RegExp) {
    const out = [];
    for (const key of ownKeys(owner)) {
      if (k.test(key) === false) continue;
      out.push(key);
    }
    return out;
  }
  if (isProtoPollutionKey(k)) return [];
  return [k];
}

function ownKeys(owner) {
  return Object.keys(owner).filter((k) => isProtoPollutionKey(k) === false);
}

/** uBO's `#resolvePath`, with a proto guard on every hop. */
function resolvePath(root, p) {
  if (p.length === 0) return { value: root };
  const n = p.length - 1;
  let obj = root;
  for (let i = 0; i < n; i++) {
    const seg = p[i];
    if (typeof seg === 'string' && isProtoPollutionKey(seg)) return {};
    obj = obj[seg];
    if (isObjectLike(obj) === false) return {};
  }
  const key = p[n];
  if (typeof key === 'string' && isProtoPollutionKey(key)) return {};
  return { obj, key, value: obj[key] };
}

/** uBO's `#evaluateExpr`: the operator truth table. */
function evaluateExpr(step, owner, k) {
  if (owner === undefined || owner === null) return undefined;
  if (typeof k === 'string' && isProtoPollutionKey(k)) return undefined;
  const hasOwn = owner[k] !== undefined || Object.hasOwn(owner, k);
  if (step.op !== undefined && hasOwn === false) return undefined;
  const target = step.not !== true;
  const v = owner[k];
  switch (step.op) {
    case '==': return (v === step.rval) === target;
    case '!=': return (v !== step.rval) === target;
    case '<': return (v < step.rval) === target;
    case '<=': return (v <= step.rval) === target;
    case '>': return (v > step.rval) === target;
    case '>=': return (v >= step.rval) === target;
    case '^=': return `${v}`.startsWith(step.rval) === target;
    case '$=': return `${v}`.endsWith(step.rval) === target;
    case '*=': return `${v}`.includes(step.rval) === target;
    case 're': return step.rval.test(`${v}`);
    default: break;
  }
  return hasOwn === target;
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

// A resolved location: `p` is the key path (leading '$' for the document root),
// `cut` is the length of the prefix that a `[-]`/`{-}` segment nominated as the
// removal target, or -1 when there is none.
function entry(p, cut) {
  return { p, cut };
}

function evaluateSteps(ctx, steps, pathin) {
  let resultset = [];
  if (Array.isArray(steps) === false) return resultset;
  for (const step of steps) {
    if (ctx.state.overflow) return [];
    switch (step.mv) {
      case MV_ROOT:
        resultset = [entry(['$'], -1)];
        break;
      case MV_CURRENT: {
        if (step.op) {
          const { obj, key } = resolvePath(ctx.root, pathin.p);
          if (obj === undefined) return [];
          if (evaluateExpr(step, obj, key) !== true) break;
        }
        resultset = [pathin];
        break;
      }
      case MV_CHILDREN:
      case MV_DESCENDANTS: {
        if (resultset.length === 0) break;
        resultset = getMatches(ctx, resultset, step);
        break;
      }
      case MV_QUANTIFIER: {
        const { length } = resultset;
        if (length < step.min || length > step.max) return [];
        resultset = [];
        break;
      }
      default:
        break;
    }
  }
  return resultset;
}

function pushResult(ctx, out, pathin, mid, k, step) {
  if (out.length >= ctx.state.limits.maxResults) {
    ctx.state.overflow = true;
    return;
  }
  const p = mid.length !== 0 ? [...pathin.p, ...mid, k] : [...pathin.p, k];
  let cut = pathin.cut;
  if (step.cut === true && cut < 0) cut = p.length;
  out.push(entry(p, cut));
}

/** uBO's `#getMatches`. */
function getMatches(ctx, listin, step) {
  const listout = [];
  for (const pathin of listin) {
    if (ctx.state.overflow) break;
    const { value: owner } = resolvePath(ctx.root, pathin.p);
    if (owner === undefined) continue;
    if (step.steps) {
      getMatchesFromExpr(ctx, pathin, step, owner, listout);
      continue;
    }
    const iter = expandKey(owner, step.k);
    if (iter) {
      for (const k of iter) {
        if (evaluateExpr(step, owner, k) !== true) continue;
        pushResult(ctx, listout, pathin, [], k, step);
      }
    }
    if (step.mv !== MV_DESCENDANTS) continue;
    for (const { obj, key, path } of walk(ctx.state, owner, true)) {
      const child = obj[key];
      const iter2 = expandKey(child, step.k);
      if (iter2 === undefined) continue;
      for (const k of iter2) {
        if (evaluateExpr(step, child, k) !== true) continue;
        pushResult(ctx, listout, pathin, path, k, step);
      }
      if (ctx.state.overflow) break;
    }
  }
  return listout;
}

/** uBO's `#getMatchesFromExpr` — the `[?…]` filter gate. */
function getMatchesFromExpr(ctx, pathin, step, owner, out) {
  const recursive = step.mv === MV_DESCENDANTS;
  const v2 = ctx.v2 || recursive || Array.isArray(owner);
  for (const { path } of walk(ctx.state, owner, recursive)) {
    const q = v2 ? entry([...pathin.p, ...path], pathin.cut) : pathin;
    const r = evaluateSteps(ctx, step.steps, q);
    if (r.length === 0) continue;
    if (out.length >= ctx.state.limits.maxResults) {
      ctx.state.overflow = true;
      return;
    }
    out.push(q);
    if (v2 === false) break;
  }
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

function interpolate(rval) {
  if (typeof rval !== 'string') return rval;
  return rval.replace('${now}', `${Date.now()}`);
}

function mergeInto(lval, rval, deep, depth) {
  for (const k of Object.keys(rval)) {
    if (isProtoPollutionKey(k)) continue;
    const incoming = rval[k];
    if (
      deep && depth < 64 &&
      isObjectLike(incoming) && Array.isArray(incoming) === false &&
      isObjectLike(lval[k]) && Array.isArray(lval[k]) === false
    ) {
      mergeInto(lval[k], incoming, deep, depth + 1);
      continue;
    }
    lval[k] = cloneValue(incoming, 0);
  }
}

/**
 * uBO's `#modifyVal`. Returns true when the document was actually changed —
 * uBO returns nothing, but callers need to know whether to re-serialize.
 */
function modifyVal(compiled, options, obj, key) {
  const { modify } = compiled;
  const rval = interpolate(compiled.rval);
  switch (modify) {
    case undefined:
      obj[key] = cloneValue(rval, 0);
      return true;
    case '+': {
      if (isObjectLike(rval) === false || Array.isArray(rval)) return false;
      const lval = obj[key];
      if (isObjectLike(lval) === false) return false;
      if (Array.isArray(lval)) return false;
      mergeInto(lval, rval, options.mergeMode === 'deep', 0);
      return true;
    }
    case 'call': {
      if (options.allowCall === false) return false;
      if (Array.isArray(rval) === false) return false;
      const args = rval.slice();
      if (args.length < 2) return false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '${obj}') args[i] = obj;
        else if (args[i] === '${key}') args[i] = key;
        else if (args[i] === '${val}') args[i] = obj[key];
      }
      const instance = args[0];
      const method = args[1];
      // Divergence #4: no `?? self` fallback — this module never reaches globals.
      if (isObjectLike(instance) === false && typeof instance !== 'function') return false;
      if (typeof method !== 'string' || isProtoPollutionKey(method)) return false;
      const fn = instance[method];
      if (typeof fn !== 'function') return false;
      fn.apply(instance, args.slice(2));
      return true;
    }
    case 'repl': {
      const lval = obj[key];
      if (typeof lval !== 'string') return false;
      if (compiled.re === undefined) {
        compiled.re = null;
        try {
          compiled.re = rval.regex !== undefined
            ? new RegExp(rval.regex, rval.flags)
            : new RegExp(String(rval.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        } catch { /* leave null: the operand is not a usable pattern */ }
      }
      if (compiled.re === null) return false;
      const next = lval.replace(compiled.re, rval.replacement);
      if (next === lval) return false;
      obj[key] = next;
      return true;
    }
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Public: compile()                                                          */
/* -------------------------------------------------------------------------- */

const ACTION_BY_MODIFY = {
  undefined: 'assign',
  '+': 'merge',
  repl: 'replace',
  call: 'call',
};

function invalid(expr, error) {
  return Object.freeze({
    ok: false,
    error,
    expr: typeof expr === 'string' ? expr : '',
    action: null,
    hasAction: false,
    matches: () => false,
    evaluate: () => [],
    apply: (doc) => ({ ok: false, changed: false, count: 0, root: doc, error }),
  });
}

/**
 * Compile a uBO JSONPath expression. Never throws.
 *
 * @param {string} expr
 * @param {{v2?:boolean, mergeMode?:'shallow'|'deep', allowCall?:boolean,
 *          limits?:object}} [options]
 * @returns {Readonly<object>} CompiledPath — see the module header.
 */
export function compile(expr, options = {}) {
  if (typeof expr !== 'string') return invalid(expr, 'not-a-string');
  const limits = { ...JSONPATH_LIMITS, ...(options.limits || {}) };
  const opts = {
    mergeMode: options.mergeMode === 'deep' ? 'deep' : 'shallow',
    allowCall: options.allowCall !== false,
  };
  if (expr.length === 0) return invalid(expr, 'empty-expression');
  if (expr.length > limits.maxExprLength) return invalid(expr, 'expression-too-long');

  let compiled;
  try {
    compiled = compileQuery(expr, options, limits, opts);
  } catch {
    return invalid(expr, 'parse-failed');
  }
  if (compiled.error !== null) return invalid(expr, compiled.error);

  const run = (doc) => {
    const root = { $: doc };
    const state = newRunState(limits);
    const ctx = { root, state, v2: compiled.v2 };
    const paths = evaluateSteps(ctx, compiled.steps, entry([], -1));
    if (state.overflow) return { overflow: true, paths: [], root };
    return { overflow: false, paths, root };
  };

  const api = {
    ok: true,
    error: null,
    expr,
    action: compiled.rval === undefined ? 'remove' : ACTION_BY_MODIFY[String(compiled.modify)],
    hasAction: compiled.rval !== undefined,

    evaluate(doc) {
      try {
        const { overflow, paths } = run(doc);
        if (overflow) return [];
        // Strip uBO's leading '$' so callers see document-relative paths.
        return paths.map((e) => e.p.slice(1));
      } catch {
        return [];
      }
    },

    matches(doc) {
      try {
        const { overflow, paths } = run(doc);
        return overflow === false && paths.length !== 0;
      } catch {
        return false;
      }
    },

    apply(doc) {
      try {
        const { overflow, paths, root } = run(doc);
        if (overflow) {
          return { ok: false, changed: false, count: 0, root: doc, error: 'budget-exceeded' };
        }
        if (paths.length === 0) {
          return { ok: true, changed: false, count: 0, root: doc, error: null };
        }
        // Divergence #7: collapse duplicate targets so one array index is never
        // spliced twice. Discovery order is preserved and we mutate back-to-
        // front, which keeps sibling indices valid across splices.
        const seen = new Set();
        const targets = [];
        for (const e of paths) {
          const p = (e.cut >= 0 && compiled.rval === undefined) ? e.p.slice(0, e.cut) : e.p;
          if (p.length === 0) continue;
          const id = p.join(' ');
          if (seen.has(id)) continue;
          seen.add(id);
          targets.push(p);
        }
        let changed = false;
        let count = 0;
        let i = targets.length;
        while (i--) {
          const { obj, key } = resolvePath(root, targets[i]);
          if (obj === undefined) continue;
          if (compiled.rval !== undefined) {
            if (modifyVal(compiled, opts, obj, key)) {
              changed = true;
              count += 1;
            }
          } else if (Array.isArray(obj) && typeof key === 'number') {
            if (key >= 0 && key < obj.length) {
              obj.splice(key, 1);
              changed = true;
              count += 1;
            }
          } else if (Object.hasOwn(obj, key)) {
            delete obj[key];
            changed = true;
            count += 1;
          }
        }
        return { ok: true, changed, count, root: root.$ ?? null, error: null };
      } catch {
        return { ok: false, changed: false, count: 0, root: doc, error: 'apply-failed' };
      }
    },
  };
  return Object.freeze(api);
}

/** uBO's `compile()`: parse the path, then the trailing action. */
function compileQuery(expr, options, limits, opts) {
  let query = expr;
  const v2 = options.v2 === true || query.startsWith('v2:');
  if (query.startsWith('v2:')) query = query.slice(3);

  const ctx = newParseContext(query, v2, limits);
  const r = parseExpression(ctx, 0);
  if (r === undefined) return { error: ctx.error || 'parse-failed' };
  // A trailing comparison can fail *softly* (uBO treats "not an operator" as
  // "the path ended here"), but a genuine error recorded along the way — a bad
  // regex, an over-long pattern — must still surface.
  if (ctx.error !== null) return { error: ctx.error };

  const out = { steps: r.steps, v2, modify: undefined, rval: undefined, re: undefined, error: null };
  if (r.i !== query.length) {
    let val;
    if (query.startsWith('=', r.i)) {
      const match = RE_RVAL.exec(query.slice(r.i));
      if (match) {
        out.modify = match[1];
        val = match[2];
      } else {
        val = query.slice(r.i + 1);
      }
    } else if (query.startsWith('+=', r.i)) {
      out.modify = '+';
      val = query.slice(r.i + 2);
    }
    if (val === undefined) return { error: 'parse-failed' };
    if (out.modify !== undefined && Object.hasOwn(ACTION_BY_MODIFY, out.modify) === false) {
      // Divergence #6: uBO compiles unknown `=name(...)` actions and no-ops.
      return { error: 'unsupported-action' };
    }
    if (out.modify === 'call' && opts.allowCall === false) return { error: 'call-disabled' };
    try {
      out.rval = sanitizeValue(JSON.parse(val), 0);
    } catch {
      return { error: 'bad-operand' };
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Public: the json-prune dialect (uBO's objectFindOwnerFn / objectPruneFn)    */
/* -------------------------------------------------------------------------- */

const PRUNE_ITER = new Set(['[]', '{}', '*']);

function validatePrunePath(path, limits) {
  if (typeof path !== 'string') return 'not-a-string';
  if (path.length === 0) return 'bad-prune-path';
  if (path.length > limits.maxExprLength) return 'expression-too-long';
  const segments = path.split('.');
  if (segments.length > limits.maxSteps) return 'too-many-steps';
  for (const seg of segments) {
    if (seg.length === 0) return 'bad-prune-path';
    if (isProtoPollutionKey(seg)) return 'proto-key';
  }
  return null;
}

/**
 * uBO's `objectFindOwnerFn`, bounded and proto-guarded.
 * @returns {boolean} whether the path resolved (or, with `prune`, modified).
 */
function findOwner(state, root, path, prune, depth) {
  let owner = root;
  let chain = path;
  for (;;) {
    if (isObjectLike(owner) === false) return false;
    if (depth > state.limits.maxDepth) {
      state.overflow = true;
      return false;
    }
    state.nodes += 1;
    if (state.nodes > state.limits.maxNodes) {
      state.overflow = true;
      return false;
    }
    const pos = chain.indexOf('.');
    if (pos === -1) {
      if (isProtoPollutionKey(chain)) return false;
      if (prune === false) return Object.hasOwn(owner, chain);
      let modified = false;
      if (chain === '*') {
        for (const key of Object.keys(owner)) {
          if (isProtoPollutionKey(key)) continue;
          delete owner[key];
          modified = true;
        }
      } else if (Object.hasOwn(owner, chain)) {
        delete owner[chain];
        modified = true;
      }
      return modified;
    }
    const prop = chain.slice(0, pos);
    const next = chain.slice(pos + 1);
    if (isProtoPollutionKey(prop)) return false;
    let found = false;
    if (prop === '[-]' && Array.isArray(owner)) {
      let i = owner.length;
      while (i--) {
        if (findOwner(state, owner[i], next, false, depth + 1) === false) continue;
        owner.splice(i, 1);
        found = true;
      }
      return found;
    }
    if (prop === '{-}' && isObjectLike(owner)) {
      for (const key of Object.keys(owner)) {
        if (isProtoPollutionKey(key)) continue;
        if (findOwner(state, owner[key], next, false, depth + 1) === false) continue;
        delete owner[key];
        found = true;
      }
      return found;
    }
    if (
      (prop === '[]' && Array.isArray(owner)) ||
      (prop === '{}' && isObjectLike(owner)) ||
      (prop === '*' && isObjectLike(owner))
    ) {
      for (const key of Object.keys(owner)) {
        if (isProtoPollutionKey(key)) continue;
        if (findOwner(state, owner[key], next, prune, depth + 1) === false) continue;
        found = true;
      }
      return found;
    }
    if (PRUNE_ITER.has(prop) || prop === '[-]' || prop === '{-}') return false;
    if (Object.hasOwn(owner, prop) === false) return false;
    owner = owner[prop];
    chain = next;
    depth += 1;
  }
}

/**
 * Compile one json-prune-dialect path (`a.b.[-].c`, `a.*.b`, `a.{}.b`, …).
 * @returns {Readonly<object>} CompiledPrunePath — see the module header.
 */
export function compilePrunePath(path, options = {}) {
  const limits = { ...JSONPATH_LIMITS, ...(options.limits || {}) };
  const error = validatePrunePath(path, limits);
  if (error !== null) {
    return Object.freeze({
      ok: false, error, path: typeof path === 'string' ? path : '',
      test: () => false, prune: () => false,
    });
  }
  const run = (doc, prune) => {
    try {
      const state = newRunState(limits);
      const found = findOwner(state, doc, path, prune, 0);
      return state.overflow ? false : found;
    } catch {
      return false;
    }
  };
  return Object.freeze({
    ok: true,
    error: null,
    path,
    test: (doc) => run(doc, false),
    prune: (doc) => run(doc, true),
  });
}

/**
 * uBO's `objectPruneFn` core: space-separated prune paths gated on
 * space-separated needle paths.
 *
 * @param {string} rawPrunePaths
 * @param {string} [rawNeedlePaths]
 * @returns {Readonly<object>} CompiledPruner — see the module header.
 */
export function compilePruner(rawPrunePaths, rawNeedlePaths = '', options = {}) {
  const split = (s) => (typeof s === 'string' ? s.trim().split(/\s+/).filter(Boolean) : []);
  const pruneRaw = split(rawPrunePaths);
  const needleRaw = pruneRaw.length !== 0 ? split(rawNeedlePaths) : [];
  const bad = (error) => Object.freeze({
    ok: false, error, paths: [], needles: [], mustProcess: () => false, prune: () => false,
  });
  if (pruneRaw.length === 0) return bad('no-prune-paths');

  const paths = [];
  const needles = [];
  for (const p of pruneRaw) {
    const c = compilePrunePath(p, options);
    if (c.ok === false) return bad(c.error);
    paths.push(c);
  }
  for (const p of needleRaw) {
    const c = compilePrunePath(p, options);
    if (c.ok === false) return bad(c.error);
    needles.push(c);
  }
  const mustProcess = (doc) => {
    if (isObjectLike(doc) === false) return false;
    for (const n of needles) {
      if (n.test(doc) === false) return false;
    }
    return true;
  };
  return Object.freeze({
    ok: true,
    error: null,
    paths: Object.freeze(pruneRaw.slice()),
    needles: Object.freeze(needleRaw.slice()),
    mustProcess,
    prune(doc) {
      if (mustProcess(doc) === false) return false;
      let modified = false;
      for (const p of paths) {
        if (p.prune(doc)) modified = true;
      }
      return modified;
    },
  });
}
