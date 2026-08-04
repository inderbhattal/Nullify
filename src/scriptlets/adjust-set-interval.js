import {
  functionToString, parseTimerBoost, parseTimerDelay, patternToRegex, proxyApply,
} from './shared-utils.js';

/**
 * adjust-set-interval.js — Speed up (or slow down) matching setInterval calls.
 * uBO: `adjust-setInterval` / `nano-setInterval-booster` / `nano-sib` / `asi`.
 *
 * Argument semantics are identical to adjust-set-timeout: `*` is "any delay",
 * an absent delay means 1000, and the boost is clamped to [0.001, 50] with a
 * 0.05 default.
 */
export function adjustSetInterval(needle, delay, boost) {
  const re = patternToRegex(needle === undefined ? '' : needle);
  if (re === null) return;
  const targetDelay = parseTimerDelay(delay);
  const mult = parseTimerBoost(boost);

  proxyApply(window, 'setInterval', (context) => {
    const { callArgs } = context;
    const ms = callArgs[1];
    if ((targetDelay === -1 || ms === targetDelay) && re.test(functionToString(callArgs[0]))) {
      callArgs[1] = ms * mult;
    }
    return context.reflect();
  });
}
