import {
  functionToString, parseTimerBoost, parseTimerDelay, patternToRegex, proxyApply,
} from './shared-utils.js';

/**
 * adjust-set-timeout.js — Speed up (or slow down) matching setTimeout calls.
 * uBO: `adjust-setTimeout` / `nano-setTimeout-booster` / `nano-stb` / `ast`.
 *
 * @param {string} needle - Matched against the stringified callback.
 * @param {string} delay  - Delay to match. `*` means any delay; an absent or
 *                          unparseable argument means **1000**, not "any".
 * @param {string} boost  - Delay multiplier, clamped to [0.001, 50]. Default
 *                          0.05 (20x faster).
 */
export function adjustSetTimeout(needle, delay, boost) {
  const re = patternToRegex(needle === undefined ? '' : needle);
  if (re === null) return;
  const targetDelay = parseTimerDelay(delay);
  const mult = parseTimerBoost(boost);

  proxyApply(window, 'setTimeout', (context) => {
    const { callArgs } = context;
    const ms = callArgs[1];
    if ((targetDelay === -1 || ms === targetDelay) && re.test(functionToString(callArgs[0]))) {
      callArgs[1] = ms * mult;
    }
    return context.reflect();
  });
}
