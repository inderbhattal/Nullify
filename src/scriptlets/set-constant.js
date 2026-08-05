import { getExtraArgs } from './shared-utils.js';

/**
 * set-constant.js
 *
 * Forces a property to always return a specific constant value.
 * Prevents ad scripts from reading or changing detection flags.
 *
 * uBlock Origin equivalent: set-constant / sc
 *
 * @param {string} prop  - Property path (e.g. "adblock.detected")
 * @param {string} value - String representation of the value to set
 *   Special values: "true", "false", "null", "undefined", "noopFunc",
 *                   "trueFunc", "falseFunc", "emptyArray", "emptyObj", ""
 */
function isProtoPollutionKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/** Returned by `resolveValue` for values uBO refuses to set. Distinct from a
 *  resolved `undefined`, which is a legitimate value (`set, foo, undefined`). */
const ABORT = Symbol('nullify:set-constant:abort');

export function setConstant(prop, value, ...args) {
  setConstantFn(false, prop, value, ...args);
}

/**
 * Shared core for `set-constant` and `trusted-set-constant`, mirroring uBO's
 * `setConstantFn(trusted, chain, rawValue, ...)`. `trusted` only widens which
 * raw values are accepted (`json:<JSON>`, `{"value":...}`); the trap semantics
 * are identical.
 */
export function setConstantFn(trusted, prop, value, ...args) {
  if (!prop) return;

  const parts = prop.split('.');
  if (parts.some(isProtoPollutionKey)) return;

  const resolvedValue = resolveValue(value, trusted);
  if (resolvedValue === ABORT) return;

  // §5.26: 10 corpus rules pass a third argument that used to be dropped.
  // uBO reads it as varargs; the shipped values are `runAt, <state>` (defer
  // installing the trap until the document reaches that readyState) and a bare
  // `3`, which is uBO's numeric spelling of readyState `complete`.
  // A recursive re-arm (deferred parent, below) never passes varargs, so this
  // branch is evaluated exactly once per rule.
  const extraArgs = getExtraArgs(args, 0);
  const runAtWhen = extraArgs.runAt !== undefined ? extraArgs.runAt : args[0];
  const target = readyStateRank(runAtWhen);
  if (target !== 0 && readyStateRank(document.readyState) < target) {
    const onStateChange = () => {
      if (readyStateRank(document.readyState) < target) return;
      document.removeEventListener('readystatechange', onStateChange, true);
      applyChain(window, parts, resolvedValue);
    };
    document.addEventListener('readystatechange', onStateChange, true);
    return;
  }

  applyChain(window, parts, resolvedValue);
}

/** True for values a property chain can be walked through. */
function isWalkable(v) {
  return v !== null && v !== undefined && (typeof v === 'object' || typeof v === 'function');
}

/**
 * uBO's `trapChain`: walk `parts` from `owner`, trapping the first link that
 * does not exist yet and re-entering when the page finally assigns it.
 */
function applyChain(owner, parts, resolvedValue) {
  const head = parts[0];
  if (parts.length === 1) {
    defineConstant(owner, head, resolvedValue);
    return;
  }

  let existing;
  try { existing = owner[head]; } catch { existing = undefined; }
  if (isWalkable(existing)) {
    applyChain(existing, parts.slice(1), resolvedValue);
    return;
  }

  const rest = parts.slice(1);
  trapDeferredParent(owner, head, (assigned) => {
    if (!isWalkable(assigned)) return;
    applyChain(assigned, rest, resolvedValue);
  });
}

/**
 * Trap a not-yet-existing intermediate link. uBO's `trapProp` keeps whatever
 * accessor is already installed and calls it from the new one — that chaining
 * is what lets several rules defer on the *same* parent.
 *
 * §5.38: this used to install a placeholder whose setter replaced the property
 * with a plain data property, so the four shipped YouTube rules
 * (`set, ytInitialPlayerResponse.{playerAds,adPlacements,adSlots,…}`) each
 * clobbered the previous rule's trap: only the last one registered survived,
 * and the page kept every other ad payload.
 */
function trapDeferredParent(owner, prop, onAssigned) {
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(owner, prop); } catch { return; }
  if (descriptor !== undefined && descriptor.configurable === false) return;

  const prevGetter = typeof descriptor?.get === 'function' ? descriptor.get : undefined;
  const prevSetter = typeof descriptor?.set === 'function' ? descriptor.set : undefined;
  let stored;
  try { stored = owner[prop]; } catch { stored = undefined; }

  try {
    Object.defineProperty(owner, prop, {
      configurable: true,
      enumerable: descriptor === undefined ? true : descriptor.enumerable !== false,
      get() {
        // Preserve any side effect the page's own getter had, but answer with
        // the newest value the chain has seen (uBO does the same).
        if (prevGetter !== undefined) {
          try { return prevGetter.call(this); } catch { /* fall through */ }
        }
        return stored;
      },
      set(v) {
        stored = v;
        if (prevSetter !== undefined) {
          try { prevSetter.call(this, v); } catch { /* keep going: our rule still applies */ }
        }
        onAssigned(v);
      },
    });
  } catch {
    // Existing non-configurable descriptor — best effort, skip.
  }
}

/**
 * Match uBO semantics: getter returns constant, setter is a no-op. Keep the
 * property configurable so a later call (or page script redefining with
 * defineProperty) can replace the trap without throwing. The getter pins
 * the value regardless of what page code assigns.
 */
function defineConstant(owner, prop, resolvedValue) {
  if (prop === '') return;
  try {
    Object.defineProperty(owner, prop, {
      configurable: true,
      enumerable: true,
      get() { return resolvedValue; },
      set() { /* ignore writes */ },
    });
  } catch {
    // Existing non-configurable descriptor — best effort, skip.
  }
}

/** uBO's `intFromReadyState`: 0 means "no deferral requested". */
function readyStateRank(state) {
  switch (`${state}`) {
    case 'loading': case 'asap': case '1': return 1;
    case 'interactive': case 'end': case '2': return 2;
    case 'complete': case 'idle': case '3': return 3;
    default: return 0;
  }
}

function resolveValue(val, trusted = false) {
  switch (val) {
    case 'true': return true;
    case 'false': return false;
    case 'null': return null;
    case 'undefined': return undefined;
    case '':
    // uBO accepts the two-character spelling `''` as the empty string; the
    // parsers only strip a *surrounding* quote pair, so it arrives verbatim.
    case "''": return '';
    case 'noopFunc': return () => {};
    case 'trueFunc': return () => true;
    case 'falseFunc': return () => false;
    // uBO spells these `[]`/`emptyArr` and `{}`/`emptyObj`; the shipped lists
    // use the bracket forms. `emptyArray` is kept for backward compatibility
    // with rules already written against this implementation.
    case '[]':
    case 'emptyArr':
    case 'emptyArray': return [];
    case '{}':
    case 'emptyObj': return {};
    case 'throwFunc': return () => { throw new Error(''); };
    case 'noopPromiseResolve': return () => Promise.resolve();
    case 'noopPromiseReject': return () => Promise.reject();
    default: {
      // §5.38: trusted callers get uBO's two extra spellings. Without `json:`,
      // the shipped `trusted-set, document.visibilityState, json:"visible"`
      // pinned the literal 11-character string `json:"visible"`, which is
      // truthy-but-wrong: page code comparing it to 'visible' still saw the
      // tab as hidden.
      if (trusted && typeof val === 'string') {
        if (val.startsWith('json:')) {
          try { return JSON.parse(val.slice(5)); } catch { return ABORT; }
        }
        if (val.startsWith('{') && val.endsWith('}')) {
          try { return JSON.parse(val).value; } catch { return ABORT; }
        }
      }
      // uBO accepts only plain integers within ±0x7FFF for untrusted
      // set-constant, and rejects everything else. The old `Number()` fallback
      // both over-accepted (' ' -> 0, '0x10' -> 16, '1e400' -> Infinity) and,
      // on NaN, returned the raw string — so `set, foo, []` pinned the page's
      // property to the two-character string "[]" and broke any caller doing
      // `foo.forEach(...)`. Aborting leaves the page's own value intact, which
      // is always the safer failure.
      if (/^-?\d+$/.test(val)) {
        const num = parseInt(val, 10);
        if (trusted || Math.abs(num) <= 0x7FFF) return num;
        return ABORT;
      }
      // Trusted lists may carry any JSON literal without the `json:` marker
      // (that is what this implementation has always accepted); an unparsable
      // value stays the raw string rather than aborting.
      if (trusted && typeof val === 'string') {
        try { return JSON.parse(val); } catch { return val; }
      }
      return ABORT;
    }
  }
}
