import { escapeRegex, getAllCookies, getAllLocalStorage, lookupElements } from './shared-utils.js';

/**
 * trusted-click-element.js
 *
 * Clicks elements matching a list of steps, in order. Used to auto-dismiss
 * cookie banners and consent dialogs.
 *
 * Args (uBO order):
 *   1. selectors  - Steps separated by `,`. When the argument starts with `;`
 *                   or `|`, that character is the separator instead (so a
 *                   selector may itself contain a comma). An all-digits step
 *                   is a delay in milliseconds. A step may be a CSS selector,
 *                   `xpath:…` or `when-visible:…`, and may pierce shadow roots
 *                   with ` >>> `.
 *   2. extraMatch - Comma-separated `[!]cookie:key=value` /
 *                   `[!]localStorage:key=value` assertions; all must hold.
 *   3. delay      - Milliseconds to wait before each click step. Default 1.
 *
 * §4.26: the previous implementation invented a `!!` separator uBO does not
 * use — it appears twice in 13,765 corpus rules, neither time as a separator —
 * so every multi-step rule was handed to `querySelector` whole and threw. It
 * also gated every click on `el.offsetParent !== null`, which is null for any
 * `position: fixed` element per spec: fixed consent buttons were never
 * clicked and the scriptlet just waited out its deadline.
 */

// uBO's default: give up on a step after 11 s unless the rule ends in a delay.
const DEFAULT_TIMEOUT_MS = 11000;

/**
 * Parse uBO's `extraMatch` assertions.
 * @returns {Array<{not: boolean, type: string, re: RegExp}>}
 */
function parseAssertions(extraMatch) {
  const out = [];
  for (const s of String(extraMatch).split(',')) {
    const pos1 = s.indexOf(':');
    const s1 = (pos1 !== -1 ? s.slice(0, pos1) : s).trim();
    const not = s1.startsWith('!');
    const type = not ? s1.slice(1).trim() : s1;
    const s2 = pos1 !== -1 ? s.slice(pos1 + 1).trim() : '';
    if (s2 === '') continue;
    const match = /^\/(.+)\/(i?)$/.exec(s2);
    if (match !== null) {
      try {
        out.push({ not, type, re: new RegExp(match[1], match[2] || undefined) });
        continue;
      } catch { /* malformed — fall through to the literal form */ }
    }
    // uBO anchors `key=value` at the start of each enumerated `key=value`
    // entry. The old code substring-matched the raw `document.cookie` string
    // for `cookie:`, and looked up a literal key named `"key=value"` for
    // `localStorage:` — neither is what filter authors write.
    const pos2 = s2.indexOf('=');
    const key = pos2 !== -1 ? s2.slice(0, pos2).trim() : s2;
    const value = pos2 !== -1 ? s2.slice(pos2 + 1).trim() : '';
    out.push({ not, type, re: new RegExp(`^${escapeRegex(key)}=${escapeRegex(value)}`) });
  }
  return out;
}

function extraMatchPasses(extraMatch) {
  const assertions = parseAssertions(extraMatch);
  if (assertions.length === 0) return true;
  const allCookies = assertions.some((o) => o.type === 'cookie') ? getAllCookies() : [];
  const allStorage = assertions.some((o) => o.type === 'localStorage')
    ? getAllLocalStorage('localStorage')
    : [];
  const hasNeedle = (haystack, needle) => haystack.some(
    ({ key, value }) => needle.test(`${key}=${value}`),
  );
  for (const { not, type, re } of assertions) {
    if (type === 'cookie') {
      if (hasNeedle(allCookies, re) === not) return false;
    } else if (type === 'localStorage') {
      if (hasNeedle(allStorage, re) === not) return false;
    }
    // Any other assertion type is ignored, exactly as upstream ignores it.
  }
  return true;
}

/** Split the selector argument into uBO's step list. */
function parseSteps(selectors) {
  const raw = /^[;|]/.test(selectors)
    ? selectors.slice(1).split(selectors.charAt(0))
    : selectors.split(',');
  return raw
    .map((a) => a.trim())
    .filter((a) => a !== '')
    .map((a) => (/^\d+$/.test(a) ? parseInt(a, 10) : a));
}

export function trustedClickElement(selectors, extraMatch = '', delay = '') {
  if (!selectors) return;
  if (extraMatch !== '' && extraMatchPasses(extraMatch) === false) return;

  const steps = parseSteps(String(selectors));
  if (steps.length === 0) return;

  // uBO interleaves the click delay between consecutive selector steps, then
  // pops a trailing number as the per-step lookup timeout.
  const clickDelay = parseInt(delay, 10) || 1;
  for (let i = steps.length - 1; i > 0; i--) {
    if (typeof steps[i] !== 'string') continue;
    if (typeof steps[i - 1] !== 'string') continue;
    steps.splice(i, 0, clickDelay);
  }
  if (steps.length === 1 && delay !== '') steps.unshift(clickDelay);
  if (typeof steps[steps.length - 1] !== 'number') steps.push(DEFAULT_TIMEOUT_MS);
  const timeout = steps.pop();

  const waitForTime = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  /**
   * Resolve a selector directive, retrying on DOM mutation until `until`.
   * §4.26: no unconditional visibility gate — uBO clicks whatever it finds,
   * and visibility is opt-in through the `when-visible:` prefix.
   */
  const waitForElement = (directive, until) => new Promise((resolve) => {
    let observer = null;
    let timer = null;
    const finish = (elems) => {
      if (observer) { observer.disconnect(); observer = null; }
      if (timer !== null) { clearTimeout(timer); timer = null; }
      resolve(elems);
    };
    const attempt = () => {
      const elems = lookupElements(directive);
      if (elems.length !== 0 || Date.now() >= until) return finish(elems);
      if (observer === null) {
        observer = new MutationObserver(attempt);
        observer.observe(document, { attributes: true, childList: true, subtree: true });
        timer = setTimeout(attempt, Math.max(until - Date.now(), 0));
      }
      return undefined;
    };
    attempt();
  });

  const process = async () => {
    while (steps.length !== 0) {
      const step = steps.shift();
      if (step === undefined) break;
      if (typeof step === 'number') {
        await waitForTime(step);
        continue;
      }
      // A `!`-prefixed step is a documented uBO no-op placeholder.
      if (step.startsWith('!')) continue;
      const elems = await waitForElement(step, Date.now() + timeout);
      if (elems.length === 0) break; // timed out — later steps cannot apply
      try { elems[0].click(); } catch { /* detached or disabled */ }
    }
  };

  if (document.documentElement) {
    process();
    return;
  }
  const observer = new MutationObserver(() => {
    observer.disconnect();
    process();
  });
  observer.observe(document, { childList: true });
}
