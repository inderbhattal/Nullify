import { setConstantFn } from './set-constant.js';

/**
 * trusted-set-constant.js
 * Like set-constant but allows setting complex values (objects, functions).
 * "Trusted" scriptlets can only be injected via trusted filter lists.
 *
 * uBO implements `trusted-set-constant` / `trusted-set` as `set-constant` with
 * the trust flag raised, so both share one trap implementation here. That is
 * what gives this scriptlet uBO's `json:<JSON text>` spelling — the shipped
 * `m.youtube.com##+js(trusted-set, document.visibilityState, json:"visible")`
 * previously pinned the literal string `json:"visible"` — and the composing
 * deferred-parent traps (several rules may defer on the same missing parent).
 */
export function trustedSetConstant(prop, value, ...args) {
  setConstantFn(true, prop, value, ...args);
}
