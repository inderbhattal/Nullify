import { ABORT_MESSAGE, initPattern, testPattern } from './shared-utils.js';

/**
 * abort-on-stack-trace.js — Abort when a property is touched from a call stack
 * matching a needle. uBO: `abort-on-stack-trace` / `aost`.
 *
 * @param {string} chain  - Property path to trap.
 * @param {string} needle - Matched against the **normalised** stack. A leading
 *                          `!` inverts the match.
 */
export function abortOnStackTrace(chain, needle) {
  if (typeof chain !== 'string' || chain === '') return;
  if (!needle) return;
  const needleDetails = initPattern(needle, { canNegate: true });
  makeProxy(window, chain, needleDetails);
}

/**
 * Normalise `Error().stack` into uBO's token stream:
 *
 *   `stackDepth:N\tfn url:row:1\tfn url:row:1…`
 *
 * §5.26: the raw stack was matched before, so the 35 corpus rules written
 * against uBO's synthesized frame names — `inlineScript` for a frame whose URL
 * is the document itself, `injectedScript` for `<anonymous>` — plus the
 * `stackDepth:N` prefix could never match: nothing in a V8 stack string spells
 * either token.
 */
export function normalizeStack(rawStack) {
  const reLine = /(.*?@)?(\S+)(:\d+):\d+\)?$/;
  let docHref = '';
  try {
    const docURL = new URL(globalThis.location.href);
    docURL.hash = '';
    docHref = docURL.href;
  } catch { /* no location (worker or test harness) */ }

  const lines = [];
  for (let line of String(rawStack || '').split(/[\n\r]+/)) {
    if (line.includes(ABORT_MESSAGE)) continue;
    line = line.trim();
    const match = reLine.exec(line);
    if (match === null) continue;
    let url = match[2];
    if (url.startsWith('(')) url = url.slice(1);
    if (docHref !== '' && url === docHref) {
      url = 'inlineScript';
    } else if (url.startsWith('<anonymous>')) {
      url = 'injectedScript';
    }
    let fn = match[1] !== undefined ? match[1].slice(0, -1) : line.slice(0, match.index).trim();
    if (fn.startsWith('at')) fn = fn.slice(2).trim();
    lines.push(` ${`${fn} ${url}${match[3]}:1`.trim()}`);
  }
  lines[0] = `stackDepth:${lines.length - 1}`;
  return lines.join('\t');
}

function matchesStack(needleDetails) {
  const stack = normalizeStack(new Error(ABORT_MESSAGE).stack);
  return needleDetails.matchAll !== true && testPattern(needleDetails, stack);
}

/**
 * Trap `chain` on `owner` through an accessor pair.
 *
 * §5.26: the old implementation replaced the property with a wrapper function
 * and bailed out on `typeof original !== 'function'`, so the 17 rules aimed at
 * a non-function property did nothing at all. A getter/setter pair traps every
 * property kind, including one that does not exist yet. It also *returned*
 * `undefined` on a match instead of throwing, which is not an abort: the
 * calling script carried on with a bad value.
 */
function makeProxy(owner, chain, needleDetails) {
  const pos = chain.indexOf('.');
  if (pos === -1) {
    let v = owner[chain];
    try {
      Object.defineProperty(owner, chain, {
        configurable: true,
        get() {
          if (matchesStack(needleDetails)) throw new ReferenceError(ABORT_MESSAGE);
          return v;
        },
        set(a) {
          if (matchesStack(needleDetails)) throw new ReferenceError(ABORT_MESSAGE);
          v = a;
        },
      });
    } catch { /* non-configurable — nothing we can do */ }
    return;
  }

  const prop = chain.slice(0, pos);
  const rest = chain.slice(pos + 1);
  let v = owner[prop];
  if (v) {
    makeProxy(v, rest, needleDetails);
    return;
  }
  // Parent not loaded yet: install a setter that re-arms once it appears.
  const desc = Object.getOwnPropertyDescriptor(owner, prop);
  if (desc && desc.set !== undefined) return;
  try {
    Object.defineProperty(owner, prop, {
      configurable: true,
      get() { return v; },
      set(a) {
        v = a;
        if (a instanceof Object) makeProxy(a, rest, needleDetails);
      },
    });
  } catch { /* non-configurable */ }
}
